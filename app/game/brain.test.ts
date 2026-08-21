import { describe, expect, it, vi } from "vitest";
import mapJson from "../../data/map.json";
import tilesJson from "../../data/tiles.json";
import {
  ANY_STATE,
  SPEAKER_SELECTOR,
  nearest,
  resolveBrain,
  slot,
  type BrainCondition,
  type BrainConditionDef,
  type BrainDef,
} from "../lib/brain";
import { group } from "../lib/conditions";
import { displayNameFor } from "./displayName";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { FlatMapFile, MapFile, TileDef } from "../lib/types";
import { normalizeTileDef, normalizeTiles } from "../lib/types";
import { initialMemory, stepBrain } from "./brainRuntime";
import { fightingStats, resolveBattler } from "../lib/battler";
import { attackIntervalMs } from "./combat";
import { BRAIN_TICK_MS, TICK_MS, WALK_DURATION_MS } from "./constants";
import { GameSession } from "./GameSession";
import { Rng } from "./rng";

/**
 * What drives a body when nobody is holding the keys.
 *
 * Three layers, tested where each actually lives: the authored shape and
 * whether it holds together, the machine's own rules against a stub, and the
 * whole thing wandering a board.
 */

const frame = {
  sprite: {
    tilesetId: "basic",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  durationMs: 200,
};

function tile(
  partial: Record<string, unknown> & Pick<TileDef, "id" | "height">,
): TileDef {
  return normalizeTileDef({
    name: partial.id,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    ...partial,
  });
}

/** Idle briefly, then wander for good. Short, so a test is a few ticks. */
const IDLE_MS = 400;

function wanderingBrain(): BrainDef {
  return {
    initial: "idle",
    states: {
      idle: { do: [{ action: "hold" }] },
      wander: { do: [{ action: "step_random" }, { action: "hold" }] },
    },
    transitions: [
      { from: "idle", if: { cond: "after", ms: IDLE_MS }, to: "wander" },
    ],
  };
}

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "wall", height: 2, walkable: false }),
  tile({
    id: "player",
    height: 2,
    directional: true,
    affectedByGravity: true,
    walkable: false,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
  }),
  tile({
    id: "deer",
    height: 1,
    actor: true,
    affectedByGravity: true,
    walkable: false,
    interactions: { brain: wanderingBrain() },
  }),
  // Same creature, with the priority list the other way round.
  tile({
    id: "deer-holding",
    height: 1,
    actor: true,
    affectedByGravity: true,
    walkable: false,
    interactions: {
      brain: {
        ...wanderingBrain(),
        states: {
          idle: { do: [{ action: "hold" }] },
          wander: { do: [{ action: "hold" }, { action: "step_random" }] },
        },
      },
    },
  }),
];

/** An open field of grass, with the authored spawn marker at the origin. */
function field(half: number): MapFile {
  let map = emptyMap();
  for (let x = -half; x <= half; x++) {
    for (let y = -half; y <= half; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  map = replaceStack(map, -half, -half, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "e" },
  ]);
  return map;
}

function withDeer(map: MapFile, x: number, y: number, tileId = "deer"): MapFile {
  return replaceStack(map, x, y, 0, [{ tileId: "grass" }, { tileId }]);
}

function advance(session: GameSession, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
    session.tick(TICK_MS);
  }
}

/** Where the one creature is, as a string worth comparing. */
function deerCell(session: GameSession): string {
  const deer = session
    .actorSnapshots()
    .find((actor) => actor.tileId !== "player");
  return deer ? `${deer.x},${deer.y}` : "gone";
}

describe("authoring a brain", () => {
  it("takes a machine that holds together", () => {
    const def = tile({ id: "ok", height: 1, interactions: { brain: wanderingBrain() } });
    expect(resolveBrain(def)?.initial).toBe("idle");
  });

  it("is absent on a tile that authored none", () => {
    expect(resolveBrain(tile({ id: "rock", height: 1 }))).toBeNull();
  });

  /**
   * Every refusal here is the same promise the other interaction blocks make: a
   * malformed brain is an inert creature, never an exception mid-tick. Refused
   * whole rather than repaired, because a machine quietly missing the half that
   * did not parse is far harder to notice than one plainly doing nothing.
   */
  it.each([
    [
      "an action nobody implements",
      { ...wanderingBrain(), states: { idle: { do: [{ action: "sing" }] } } },
    ],
    [
      "a starting state that does not exist",
      { ...wanderingBrain(), initial: "dozing" },
    ],
    [
      "a transition to a state that does not exist",
      {
        ...wanderingBrain(),
        transitions: [
          { from: "idle", if: { cond: "after", ms: 1 }, to: "sprinting" },
        ],
      },
    ],
    [
      "a transition from a state that does not exist",
      {
        ...wanderingBrain(),
        transitions: [
          { from: "dreaming", if: { cond: "after", ms: 1 }, to: "idle" },
        ],
      },
    ],
    [
      // The wildcard would shadow it, so it could never match as a source.
      "a state called any",
      {
        ...wanderingBrain(),
        states: { idle: { do: [] }, any: { do: [] } },
      },
    ],
    ["nothing resembling a machine", { nonsense: true }],
  ])("refuses %s", (_label, brain) => {
    const def = tile({
      id: `bad-${_label}`,
      height: 1,
      interactions: { brain } as never,
    });
    expect(resolveBrain(def)).toBeNull();
  });
});

describe("deciding", () => {
  function ctx(overrides: Partial<Parameters<typeof stepBrain>[3]> = {}) {
    return {
      busy: false,
      rng: new Rng(1),
      self: { x: 0, y: 0, z: 0 },
      nearestOnTile: () => null,
      positionOf: () => null,
      wouldDrop: () => false,
      step: vi.fn(() => true),
      say: vi.fn(),
      noise: vi.fn(),
      // Nothing in the way and nothing said, unless a test says otherwise: the
      // defaults are the empty room these cases are written about.
      canSee: () => true,
      sight: { up: 0, down: 0 },
      heard: () => [],
      hurtBy: () => [],
      attack: vi.fn(() => false),
      nameOf: (id: string) => id,
      ...overrides,
    } satisfies Parameters<typeof stepBrain>[3];
  }

  it("stays put until its condition holds", () => {
    const brain = wanderingBrain();
    const memory = initialMemory(brain);
    const c = ctx();

    stepBrain(brain, memory, BRAIN_TICK_MS, c);

    expect(memory.state).toBe("idle");
    expect(c.step).not.toHaveBeenCalled();
  });

  it("acts on the tick it changes its mind, not the one after", () => {
    const brain = wanderingBrain();
    const memory = initialMemory(brain);
    const c = ctx();

    for (let elapsed = 0; elapsed < IDLE_MS; elapsed += BRAIN_TICK_MS) {
      stepBrain(brain, memory, BRAIN_TICK_MS, c);
    }

    expect(memory.state).toBe("wander");
    // A beat of hesitation on entering every state would be visible.
    expect(c.step).toHaveBeenCalledTimes(1);
  });

  it("resets the clock on the way into a state", () => {
    const brain = wanderingBrain();
    const memory = initialMemory(brain);
    for (let elapsed = 0; elapsed < IDLE_MS; elapsed += BRAIN_TICK_MS) {
      stepBrain(brain, memory, BRAIN_TICK_MS, ctx());
    }
    expect(memory.msInState).toBe(0);
  });

  /**
   * `any` is what keeps a flat machine from needing an edge out of every state,
   * and being first in the list is what makes it win.
   */
  it("takes a wildcard transition from whatever state it is in", () => {
    const brain: BrainDef = {
      initial: "idle",
      states: { idle: { do: [] }, bolt: { do: [] } },
      transitions: [{ from: "any", if: { cond: "after", ms: 0 }, to: "bolt" }],
    };
    const memory = initialMemory(brain);

    stepBrain(brain, memory, BRAIN_TICK_MS, ctx());

    expect(memory.state).toBe("bolt");
  });

  it("takes the first matching transition, not the best one", () => {
    const brain: BrainDef = {
      initial: "idle",
      states: { idle: { do: [] }, first: { do: [] }, second: { do: [] } },
      transitions: [
        { from: "idle", if: { cond: "after", ms: 0 }, to: "first" },
        { from: "idle", if: { cond: "after", ms: 0 }, to: "second" },
      ],
    };
    const memory = initialMemory(brain);

    stepBrain(brain, memory, BRAIN_TICK_MS, ctx());

    expect(memory.state).toBe("first");
  });

  it("tries every direction before giving a step up as blocked", () => {
    const brain = wanderingBrain();
    const memory = initialMemory(brain);
    const c = ctx({ step: vi.fn(() => false) });

    for (let elapsed = 0; elapsed < IDLE_MS; elapsed += BRAIN_TICK_MS) {
      stepBrain(brain, memory, BRAIN_TICK_MS, c);
    }

    // Standing still because one arbitrary direction was blocked would leave a
    // creature in a corridor motionless three times out of four.
    expect(c.step).toHaveBeenCalledTimes(4);
  });

  it("does not start a second step while one is in flight", () => {
    const brain = wanderingBrain();
    const memory = initialMemory(brain);
    const c = ctx({ busy: true });

    for (let elapsed = 0; elapsed <= IDLE_MS * 2; elapsed += BRAIN_TICK_MS) {
      stepBrain(brain, memory, BRAIN_TICK_MS, c);
    }

    expect(c.step).not.toHaveBeenCalled();
  });
});

describe("a wandering deer", () => {
  it("holds still through its idle, then moves", () => {
    const session = new GameSession(withDeer(field(4), 0, 0), tiles, { actorIds: ["alice"] });
    const start = deerCell(session);

    advance(session, IDLE_MS - BRAIN_TICK_MS);
    expect(deerCell(session)).toBe(start);

    advance(session, IDLE_MS * 4);
    expect(deerCell(session)).not.toBe(start);
  });

  /**
   * Bodies move at tick rate; only *deciding* is slow. A brain running every
   * simulation tick would reconsider six times per step it cannot retake.
   */
  it("decides on its own slower clock", () => {
    const session = new GameSession(withDeer(field(4), 0, 0), tiles, { actorIds: ["alice"] });

    // One brain tick short of the transition, however many sim ticks that is.
    advance(session, IDLE_MS - BRAIN_TICK_MS);

    expect(deerCell(session)).toBe("0,0");
  });

  it("walks the same path twice from the same seed", () => {
    const path = (seed: number) => {
      const session = new GameSession(withDeer(field(4), 0, 0), tiles, { actorIds: ["alice"], seed: seed });
      const seen: string[] = [];
      for (let i = 0; i < 40; i++) {
        advance(session, BRAIN_TICK_MS);
        seen.push(deerCell(session));
      }
      return seen;
    };

    expect(path(7)).toEqual(path(7));
    // And the seed is genuinely reaching the dice, rather than being ignored.
    expect(path(7)).not.toEqual(path(99));
  });

  it("runs the first action that does not fail, and no further", () => {
    // `hold` sits above `step_random` on this one, and always succeeds.
    const session = new GameSession(withDeer(field(4), 0, 0, "deer-holding"), tiles, { actorIds: ["alice"] });

    advance(session, IDLE_MS * 6);

    expect(deerCell(session)).toBe("0,0");
  });

  it("falls through to a later action when the first one fails", () => {
    // Hemmed in on all four sides: `step_random` cannot succeed, and reaching
    // `hold` is what keeps the tick uneventful rather than an exception.
    let map = field(4);
    for (const [x, y] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      map = replaceStack(map, x!, y!, 0, [{ tileId: "grass" }, { tileId: "wall" }]);
    }
    const session = new GameSession(withDeer(map, 0, 0), tiles, { actorIds: ["alice"] });

    expect(() => advance(session, IDLE_MS * 6)).not.toThrow();
    expect(deerCell(session)).toBe("0,0");
  });
});

/**
 * The blackboard, and the two creatures that prove it is a vocabulary rather
 * than a deer with settings: `step_toward` is `step_away_from` with the
 * comparison flipped, and a cat is a deer with two states renamed.
 */
const NOTICE_CELLS = 3;

function followBrain(): BrainDef {
  return {
    initial: "idle",
    states: {
      idle: { do: [{ action: "hold" }] },
      follow: {
        do: [{ action: "step_toward", of: slot("friend") }, { action: "hold" }],
      },
    },
    transitions: [
      {
        from: "idle",
        if: { cond: "in_range", of: nearest("player"), cells: NOTICE_CELLS },
        bind: { friend: nearest("player") },
        to: "follow",
      },
      {
        from: "follow",
        if: { cond: "out_of_range", of: slot("friend"), cells: NOTICE_CELLS },
        to: "idle",
      },
    ],
  };
}

const noticing: TileDef[] = [
  ...tiles,
  tile({
    id: "cat",
    height: 1,
    actor: true,
    affectedByGravity: true,
    walkable: false,
    interactions: { brain: followBrain() },
  }),
  tile({
    id: "shy",
    height: 1,
    actor: true,
    affectedByGravity: true,
    walkable: false,
    interactions: {
      brain: {
        ...followBrain(),
        states: {
          idle: { do: [{ action: "hold" }] },
          follow: {
            do: [
              { action: "step_away_from", of: slot("friend") },
              { action: "hold" },
            ],
          },
        },
      },
    },
  }),
];

/** Put a player's body at a cell, driven by nobody in particular. */
function withPlayerAt(map: MapFile, x: number, y: number): MapFile {
  return replaceStack(map, x, y, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "e", owner: "alice" },
  ]);
}

/** Steps between the one creature and the player, on the plan. */
function gap(session: GameSession): number {
  const actors = session.actorSnapshots();
  const creature = actors.find((a) => a.tileId === "cat" || a.tileId === "shy")!;
  const player = actors.find((a) => a.tileId === "player")!;
  return Math.abs(creature.x - player.x) + Math.abs(creature.y - player.y);
}

describe("noticing you", () => {
  /**
   * A map with the marker already consumed, so the player's body can be placed
   * exactly where the test wants it rather than at spawn.
   */
  function facing(creature: string, apart: number): GameSession {
    let map = field(9);
    map = replaceStack(map, -9, -9, 0, [{ tileId: "grass" }]);
    map = withDeer(map, 0, 0, creature);
    map = withPlayerAt(map, apart, 0);
    return new GameSession(map, noticing, { actorIds: ["alice"], spawnAt: {
      x: -9,
      y: -9,
      z: 0,
      stackIndex: 1,
    } });
  }

  it("closes on somebody who comes near", () => {
    const session = facing("cat", NOTICE_CELLS);
    expect(gap(session)).toBe(NOTICE_CELLS);

    advance(session, BRAIN_TICK_MS * 4);

    expect(gap(session)).toBeLessThan(NOTICE_CELLS);
  });

  it("ignores somebody standing further off than it looks", () => {
    const session = facing("cat", NOTICE_CELLS + 1);

    advance(session, BRAIN_TICK_MS * 6);

    expect(gap(session)).toBe(NOTICE_CELLS + 1);
  });

  it("runs from them instead, given the mirrored action", () => {
    const session = facing("shy", NOTICE_CELLS);

    advance(session, BRAIN_TICK_MS * 4);

    expect(gap(session)).toBeGreaterThan(NOTICE_CELLS);
  });

  /**
   * Regression shape: the plan flagged that a creature authored with the same
   * threshold going in and coming out would flip state every brain tick with
   * somebody sitting exactly on the boundary. Defining the two conditions as
   * exact complements is what dissolves it — at any distance precisely one of
   * them holds.
   */
  it("settles on one mind about somebody standing exactly at its limit", () => {
    const session = facing("cat", NOTICE_CELLS);
    // Boxed in, so it cannot close the distance and the standoff persists.
    const seen = new Set<number>();
    for (let i = 0; i < 12; i++) {
      advance(session, BRAIN_TICK_MS);
      seen.add(gap(session));
    }

    // A flip-flopping creature would step in, out, in, out forever.
    expect(seen.size).toBeLessThanOrEqual(NOTICE_CELLS);
  });

  /**
   * Regression shape: `nearest` is answered from an index of who is standing on
   * which tile, built the first time anything asks and kept until the cast
   * changes. A creature that had already looked once before somebody joined
   * would go on answering from the world as it was — so a deer would never
   * notice anybody who arrived after it, for as long as the object lived, which
   * on a server is until the next eviction.
   */
  it("notices somebody who joins after it has already looked", () => {
    let map = field(9);
    map = replaceStack(map, -9, -9, 0, [{ tileId: "grass" }]);
    map = withDeer(map, 0, 0, "cat");
    // Driven, and standing well outside what the cat looks at. Somebody has to
    // actually be here for a brain to run at all, and this one is far enough
    // away that the cat looks, finds them, ignores them — and has built the
    // index by the time bob arrives.
    map = withPlayerAt(map, 9, 0);
    const session = new GameSession(map, noticing, { actorIds: ["alice"], spawnAt: {
      x: -9,
      y: -9,
      z: 0,
      stackIndex: 1,
    } });
    advance(session, BRAIN_TICK_MS * 2);
    expect(deerCell(session)).toBe("0,0");

    session.spawn("bob", { at: { x: NOTICE_CELLS, y: 0, z: 0 } });
    advance(session, BRAIN_TICK_MS * 4);

    expect(deerCell(session)).not.toBe("0,0");
  });

  it("keeps chasing the one that set it off, not whoever is nearest now", () => {
    let map = field(9);
    map = replaceStack(map, -9, -9, 0, [{ tileId: "grass" }]);
    map = withDeer(map, 0, 0, "cat");
    map = withPlayerAt(map, NOTICE_CELLS, 0);
    const session = new GameSession(map, noticing, { actorIds: ["alice"], spawnAt: {
      x: -9,
      y: -9,
      z: 0,
      stackIndex: 1,
    } });

    advance(session, BRAIN_TICK_MS);
    // A second person arrives, closer than the first.
    session.spawn("bob", { at: { x: 0, y: 1, z: 0 } });
    advance(session, BRAIN_TICK_MS * 3);

    const cat = session.actorSnapshots().find((a) => a.tileId === "cat")!;
    const alice = session.actorSnapshots().find((a) => a.id === "alice")!;
    // Committed to Alice: re-asking "who is nearest" every tick is what makes a
    // creature between two people jitter on the spot.
    expect(Math.abs(cat.x - alice.x) + Math.abs(cat.y - alice.y)).toBeLessThan(
      NOTICE_CELLS,
    );
  });

  it("settles when the one it was watching leaves the world", () => {
    const session = facing("cat", NOTICE_CELLS);
    advance(session, BRAIN_TICK_MS * 2);

    session.despawn("alice");

    // A target that is gone reads as out of range rather than as an exception,
    // so the creature goes back to minding its own business.
    expect(() => advance(session, BRAIN_TICK_MS * 4)).not.toThrow();
    expect(session.isAtRest()).toBe(true);
  });
});

/**
 * Flocking, which is a creature named as somebody else's `nearest:`.
 *
 * Tested through the session rather than a stub, because the whole of a
 * `nearest:` is a question about the board — who is standing on that tile — and a
 * stub that answered it would be testing the answer it was handed.
 */
describe("picking out a tile to follow", () => {
  /** Follow whichever body on `of` is nearest, and keep following that one. */
  function flockBrain(of: string): BrainDef {
    return {
      initial: "idle",
      states: {
        idle: { do: [{ action: "hold" }] },
        follow: {
          do: [{ action: "step_toward", of: slot("pack") }, { action: "hold" }],
        },
      },
      transitions: [
        {
          from: "idle",
          if: { cond: "in_los", of: nearest(of), cells: NOTICE_CELLS },
          bind: { pack: nearest(of) },
          to: "follow",
        },
      ],
    };
  }

  const flocking: TileDef[] = [
    ...tiles,
    // Each looks for its own kind, which is the flock. Two species rather than
    // one because the selector naming a tile — rather than meaning "same as me"
    // — is the thing worth pinning down: a mouse hunting for mice must walk past
    // a rat standing closer.
    tile({
      id: "rat",
      height: 1,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: { brain: flockBrain("rat") },
    }),
    tile({
      id: "mouse",
      height: 1,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: { brain: flockBrain("mouse") },
    }),
    // Follows rats without being one — the leader case, and the thing a
    // same-tile-only rule could not express at all.
    tile({
      id: "ratcatcher",
      height: 1,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: { brain: flockBrain("rat") },
    }),
  ];

  /** An open field with a creature at each of the given cells. */
  function warren(...bodies: [string, number, number][]): GameSession {
    let map = field(9);
    map = replaceStack(map, -9, -9, 0, [{ tileId: "grass" }]);
    for (const [tileId, x, y] of bodies) map = withDeer(map, x, y, tileId);
    return new GameSession(map, flocking, { actorIds: ["alice"], spawnAt: {
      x: -9,
      y: -9,
      z: 0,
      stackIndex: 1,
    } });
  }

  function cellOf(session: GameSession, tileId: string, nth = 0) {
    const found = session
      .actorSnapshots()
      .filter((actor) => actor.tileId === tileId);
    return found[nth]!;
  }

  /** Every body of one kind, so the player standing off in the corner is not one. */
  function kindOf(session: GameSession, tileId: string) {
    return session.actorSnapshots().filter((actor) => actor.tileId === tileId);
  }

  it("closes on another of the same tile", () => {
    const session = warren(["rat", 0, 0], ["rat", NOTICE_CELLS, 0]);

    advance(session, BRAIN_TICK_MS * 4);

    const [a, b] = kindOf(session, "rat");
    expect(Math.abs(a!.x - b!.x) + Math.abs(a!.y - b!.y)).toBeLessThan(
      NOTICE_CELLS,
    );
  });

  it("walks past an animal that is not the tile it named", () => {
    const session = warren(["mouse", 0, 0], ["rat", 2, 0]);
    const before = cellOf(session, "mouse");

    advance(session, BRAIN_TICK_MS * 6);

    const after = cellOf(session, "mouse");
    expect(`${after.x},${after.y}`).toBe(`${before.x},${before.y}`);
  });

  /**
   * The whole reason this names a tile rather than meaning "one of me": a
   * follower need not be the thing it follows, which is a pack with a leader.
   */
  it("follows a tile it is not itself", () => {
    const session = warren(["ratcatcher", 0, 0], ["rat", NOTICE_CELLS, 0]);
    const rat = cellOf(session, "rat");

    advance(session, BRAIN_TICK_MS * 4);

    const chaser = cellOf(session, "ratcatcher");
    expect(Math.abs(chaser.x - rat.x) + Math.abs(chaser.y - rat.y)).toBeLessThan(
      NOTICE_CELLS,
    );
  });

  /** The one that would make a lone creature chase itself around the board. */
  it("is nobody at all when it is the last of its kind", () => {
    const session = warren(["rat", 0, 0]);
    const before = cellOf(session, "rat");

    advance(session, BRAIN_TICK_MS * 6);

    const after = cellOf(session, "rat");
    expect(`${after.x},${after.y}`).toBe(`${before.x},${before.y}`);
  });

  /**
   * Three in a row, the far one out of everybody's sight. A creature that took
   * whichever body the board listed first rather than the nearest would drag the
   * middle of the row apart instead of closing it up.
   */
  it("takes the nearest of several, and leaves the rest alone", () => {
    const session = warren(["rat", 0, 0], ["rat", 2, 0], ["rat", 9, 0]);

    advance(session, BRAIN_TICK_MS * 4);

    const xs = kindOf(session, "rat")
      .map((rat) => rat.x)
      .sort((a, b) => a - b);
    // The near two have closed up on each other…
    expect(xs[1]! - xs[0]!).toBe(1);
    // …and the far one, with nobody inside its three cells, never moved.
    expect(xs[2]).toBe(9);
  });
});

describe("giving up", () => {
  /**
   * "Cornered" without a branch inside an action: blocked, nowhere to run and
   * nobody to run from all arrive at the same place, because they are all a
   * priority list with nothing left in it.
   */
  const cornerable: TileDef[] = [
    ...tiles,
    tile({
      id: "trapped",
      height: 1,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: {
        brain: {
          initial: "wander",
          states: {
            // No `hold` underneath, or the state could never be stuck.
            wander: { do: [{ action: "step_random" }] },
            resigned: { do: [{ action: "hold" }] },
          },
          transitions: [
            { from: "wander", if: { cond: "stuck" }, to: "resigned" },
          ],
        },
      },
    }),
  ];

  /** A creature walled in on all four sides. */
  function penned(): GameSession {
    let map = field(4);
    for (const [x, y] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      map = replaceStack(map, x!, y!, 0, [
        { tileId: "grass" },
        { tileId: "wall" },
      ]);
    }
    return new GameSession(withDeer(map, 0, 0, "trapped"), cornerable, { actorIds: [
      "alice",
    ] });
  }

  /**
   * Observed on the memory rather than on the board, because from outside the
   * two look identical: a creature retrying a blocked step and one that has
   * given up are both standing still.
   */
  it("reaches a state of its own rather than retrying forever", () => {
    const brain: BrainDef = {
      initial: "wander",
      states: {
        wander: { do: [{ action: "step_random" }] },
        resigned: { do: [{ action: "hold" }] },
      },
      transitions: [{ from: "wander", if: { cond: "stuck" }, to: "resigned" }],
    };
    const memory = initialMemory(brain);
    const blocked = {
      busy: false,
      rng: new Rng(1),
      self: { x: 0, y: 0, z: 0 },
      nearestOnTile: () => null,
      positionOf: () => null,
      wouldDrop: () => false,
      step: () => false,
      say: () => {},
      noise: () => {},
      canSee: () => true,
      sight: { up: 0, down: 0 },
      heard: () => [],
      hurtBy: () => [],
      attack: () => false,
      nameOf: (id: string) => id,
    };

    // One tick to try everything and fail; the verdict is read on the next.
    stepBrain(brain, memory, BRAIN_TICK_MS, blocked);
    expect(memory.stuck).toBe(true);
    expect(memory.state).toBe("wander");

    stepBrain(brain, memory, BRAIN_TICK_MS, blocked);
    expect(memory.state).toBe("resigned");
    // And the dead end belongs to the state it happened in.
    expect(memory.stuck).toBe(false);
  });

  it("leaves a penned creature standing quietly where it was", () => {
    const session = penned();

    expect(() => advance(session, BRAIN_TICK_MS * 4)).not.toThrow();
    expect(deerCell(session)).toBe("0,0");
  });

  it("is not stuck merely because it chose to stand still", () => {
    // `hold` succeeds, so a state resting on it can never report stuck — the
    // authoring gotcha worth having a test pinned to.
    const session = new GameSession(withDeer(field(4), 0, 0, "deer"), cornerable, { actorIds: ["alice"] });

    advance(session, BRAIN_TICK_MS * 2);

    expect(deerCell(session)).toBe("0,0");
  });
});

describe("watching its footing", () => {
  const ledgeDwellers: TileDef[] = [
    ...tiles,
    tile({
      id: "careful",
      height: 1,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: {
        brain: {
          initial: "wander",
          states: { wander: { do: [{ action: "step_random" }] } },
          transitions: [],
        },
      },
    }),
    tile({
      id: "reckless",
      height: 1,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: {
        brain: {
          initial: "wander",
          states: {
            wander: { do: [{ action: "step_random", allowDrops: true }] },
          },
          transitions: [],
        },
      },
    }),
  ];

  /** A one-cell plinth a level up, with open floor all around below. */
  function plinth(creature: string): GameSession {
    let map = field(4);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "grass" }, { tileId: creature }]);
    return new GameSession(map, ledgeDwellers, { actorIds: ["alice"] });
  }

  function levelOf(session: GameSession, tileId: string): number {
    return session.actorSnapshots().find((a) => a.tileId === tileId)!.z;
  }

  it("keeps a creature off a ledge it was not told it could take", () => {
    const session = plinth("careful");

    advance(session, BRAIN_TICK_MS * 8);

    expect(levelOf(session, "careful")).toBe(1);
  });

  /**
   * And the drop itself needs no brain-specific handling: the step commits, the
   * creature is unsupported, and the same gravity that catches a player catches
   * it.
   */
  it("lets one that was told it could, and lands it safely", () => {
    const session = plinth("reckless");

    advance(session, BRAIN_TICK_MS * 8);

    expect(levelOf(session, "reckless")).toBe(0);
    const landed = session
      .actorSnapshots()
      .find((a) => a.tileId === "reckless")!;
    expect(landed.fall).toBeNull();
  });
});

/**
 * Actions that hold a count across turns, and the one rule that keeps them from
 * being a scripting language: **a counter or a timer, never a decision.**
 *
 * Finishing reports failure, on the same terms as being blocked — done is one
 * more way of having nothing left to offer — which is what lets a state read
 * top to bottom as a sequence without anything branching inside it.
 */
describe("actions that take time", () => {
  function ctx(overrides: Partial<Parameters<typeof stepBrain>[3]> = {}) {
    return {
      busy: false,
      rng: new Rng(1),
      self: { x: 0, y: 0, z: 0 },
      nearestOnTile: () => null,
      positionOf: () => null,
      wouldDrop: () => false,
      step: vi.fn(() => true),
      say: vi.fn(),
      noise: vi.fn(),
      // Nothing in the way and nothing said, unless a test says otherwise: the
      // defaults are the empty room these cases are written about.
      canSee: () => true,
      sight: { up: 0, down: 0 },
      heard: () => [],
      hurtBy: () => [],
      attack: vi.fn(() => false),
      nameOf: (id: string) => id,
      ...overrides,
    } satisfies Parameters<typeof stepBrain>[3];
  }

  const GRAZE_MS = BRAIN_TICK_MS * 3;
  const STROLL_STEPS = 4;

  it("holds its line until the clock runs out, then hands it over", () => {
    const brain: BrainDef = {
      initial: "graze",
      states: {
        graze: {
          do: [{ action: "wait", ms: GRAZE_MS }, { action: "step_random" }],
        },
      },
      transitions: [],
    };
    const memory = initialMemory(brain);
    const c = ctx();

    stepBrain(brain, memory, BRAIN_TICK_MS, c);
    stepBrain(brain, memory, BRAIN_TICK_MS, c);
    // Two ticks in and still counting — the clock survived the rescan.
    expect(c.step).not.toHaveBeenCalled();

    stepBrain(brain, memory, BRAIN_TICK_MS, c);

    expect(c.step).toHaveBeenCalledTimes(1);
  });

  it("takes the steps it was asked for and no more", () => {
    const brain: BrainDef = {
      initial: "stroll",
      states: {
        stroll: {
          do: [
            { action: "walk_n_steps", steps: STROLL_STEPS },
            { action: "hold" },
          ],
        },
      },
      transitions: [],
    };
    const memory = initialMemory(brain);
    const c = ctx();

    for (let tick = 0; tick < STROLL_STEPS * 3; tick++) {
      stepBrain(brain, memory, BRAIN_TICK_MS, c);
    }

    expect(c.step).toHaveBeenCalledTimes(STROLL_STEPS);
  });

  it("forgets a half-finished count on the way into another state", () => {
    const brain: BrainDef = {
      initial: "stroll",
      states: {
        stroll: { do: [{ action: "walk_n_steps", steps: STROLL_STEPS }] },
        alert: { do: [{ action: "hold" }] },
      },
      transitions: [
        {
          from: "stroll",
          if: { cond: "after", ms: BRAIN_TICK_MS * 2 },
          to: "alert",
        },
      ],
    };
    const memory = initialMemory(brain);

    stepBrain(brain, memory, BRAIN_TICK_MS, ctx());
    expect(memory.scratch).not.toEqual({});

    stepBrain(brain, memory, BRAIN_TICK_MS, ctx());

    expect(memory.state).toBe("alert");
    // Positions mean nothing across states, so a creature that comes back here
    // starts its sequence over rather than one step from the end of it.
    expect(memory.scratch).toEqual({});
  });

  /**
   * The subtle half. The list is rescanned from the top every tick, so a
   * counting action can be shoved aside by something above it — and when its
   * turn comes round again it begins again, which is what an author reading the
   * table expects. A mind changed halfway through a walk does not later
   * remember it had one step left.
   */
  it("restarts a count that a higher line took over from", () => {
    const brain: BrainDef = {
      initial: "stroll",
      states: {
        stroll: {
          do: [
            { action: "step_toward", of: slot("friend") },
            { action: "walk_n_steps", steps: STROLL_STEPS },
          ],
        },
      },
      transitions: [],
    };
    const memory = initialMemory(brain);
    memory.blackboard.friend = "alice";

    // Somebody to walk towards, or nobody — which is the whole of whether the
    // line above the count gets to run.
    let arrived = false;
    const c = ctx({ positionOf: () => (arrived ? { x: 4, y: 0, z: 0 } : null) });

    stepBrain(brain, memory, BRAIN_TICK_MS, c);
    stepBrain(brain, memory, BRAIN_TICK_MS, c);
    expect(memory.scratch[1]).toBe(2);

    arrived = true;
    stepBrain(brain, memory, BRAIN_TICK_MS, c);
    expect(memory.scratch[1]).toBeUndefined();

    arrived = false;
    stepBrain(brain, memory, BRAIN_TICK_MS, c);

    expect(memory.scratch[1]).toBe(1);
  });

  it("lets a transition cut a long action short", () => {
    const brain: BrainDef = {
      initial: "graze",
      states: {
        graze: { do: [{ action: "wait", ms: BRAIN_TICK_MS * 100 }] },
        bolt: { do: [{ action: "hold" }] },
      },
      transitions: [
        { from: "graze", if: { cond: "after", ms: BRAIN_TICK_MS }, to: "bolt" },
      ],
    };
    const memory = initialMemory(brain);

    // Transitions are consulted before the actions run, so an action still
    // counting never gets a veto over the creature changing its mind.
    stepBrain(brain, memory, BRAIN_TICK_MS, ctx());

    expect(memory.state).toBe("bolt");
  });

  const timed: TileDef[] = [
    ...tiles,
    tile({
      id: "grazer",
      height: 1,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: {
        brain: {
          initial: "graze",
          // The whole sequence in one state: each line gets out of the way of
          // the next once it is done, and `hold` catches the end of it.
          states: {
            graze: {
              do: [
                { action: "wait", ms: GRAZE_MS },
                { action: "walk_n_steps", steps: STROLL_STEPS },
                { action: "hold" },
              ],
            },
          },
          transitions: [],
        },
      },
    }),
  ];

  function grazing(): GameSession {
    return new GameSession(withDeer(field(9), 0, 0, "grazer"), timed, { actorIds: ["alice"] });
  }

  it("grazes where it stands, strolls a bounded way, then settles", () => {
    const session = grazing();

    advance(session, GRAZE_MS - BRAIN_TICK_MS);
    expect(deerCell(session)).toBe("0,0");

    advance(session, BRAIN_TICK_MS * 20);
    const settled = deerCell(session);
    expect(settled).not.toBe("0,0");

    // The count is spent, so it stays put — a bounded stroll rather than an
    // endless one.
    advance(session, BRAIN_TICK_MS * 20);
    expect(deerCell(session)).toBe(settled);
  });

  /**
   * Scratch is brain state, and brain state already resets on load — so this
   * costs nothing to honour and would be a migration problem to break: a saved
   * count belongs to a position in a list a since-edited brain may not have.
   */
  it("keeps its counting out of the saved world", () => {
    const session = grazing();
    advance(session, GRAZE_MS + BRAIN_TICK_MS * 4);

    expect(JSON.stringify(session.getMap())).not.toContain("scratch");

    const resumed = new GameSession(session.getMap(), timed, { actorIds: ["alice"], spawnAt: session.getSpawnPoint(), seed: session.getSeed() });
    const where = deerCell(resumed);

    // Back at the top of its sequence: a fresh graze before it strolls again.
    advance(resumed, GRAZE_MS - BRAIN_TICK_MS);
    expect(deerCell(resumed)).toBe(where);
  });
});

describe("walking at its own pace", () => {
  const paced: TileDef[] = [
    ...tiles,
    tile({
      id: "plodder",
      height: 1,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      // Twice a player's, so a follower can be walked away from.
      walkDurationMs: WALK_DURATION_MS * 2,
      interactions: {
        brain: {
          initial: "wander",
          states: { wander: { do: [{ action: "step_random" }] } },
          transitions: [],
        },
      },
    }),
    tile({
      id: "sprinter",
      height: 1,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      walkDurationMs: WALK_DURATION_MS / 2,
      interactions: {
        brain: {
          initial: "wander",
          states: { wander: { do: [{ action: "step_random" }] } },
          transitions: [],
        },
      },
    }),
  ];

  /** How many cells a creature covers in a fixed stretch of time. */
  function cellsCovered(creature: string): number {
    const session = new GameSession(withDeer(field(9), 0, 0, creature), paced, { actorIds: ["alice"], seed: 11 });
    let moves = 0;
    let last = deerCell(session);
    for (let i = 0; i < 40; i++) {
      advance(session, TICK_MS);
      const now = deerCell(session);
      if (now !== last) moves += 1;
      last = now;
    }
    return moves;
  }

  it("takes a slow creature longer to cross a cell", () => {
    expect(cellsCovered("plodder")).toBeLessThan(cellsCovered("sprinter"));
  });

  it("times a step by the walker's own tile, not a shared constant", () => {
    const session = new GameSession(withDeer(field(9), 0, 0, "plodder"), paced, { actorIds: ["alice"] });
    advance(session, BRAIN_TICK_MS);

    const walk = session
      .actorSnapshots()
      .find((a) => a.tileId === "plodder")!.walk;
    expect(walk?.durationMs).toBe(WALK_DURATION_MS * 2);
  });

  it("leaves a body that authored no pace walking like a player", () => {
    const session = new GameSession(withDeer(field(9), 0, 0, "deer"), paced, { actorIds: ["alice"] });
    advance(session, IDLE_MS + BRAIN_TICK_MS);

    const walk = session.actorSnapshots().find((a) => a.tileId === "deer")!.walk;
    expect(walk?.durationMs).toBe(WALK_DURATION_MS);
  });
});

/**
 * Effects, the third thing a state can carry beside its transitions and its
 * actions: something it does the once, on the way in. Both kinds lean on
 * machinery that already exists — a chat bubble, a signal channel — so an NPC
 * joins the vocabulary the map already speaks rather than a parallel one.
 */
describe("a deer that yelps", () => {
  /** A startled creature that both cries out and throws a switch. */
  function alarmedBrain(emitTo?: string): BrainDef {
    return {
      initial: "calm",
      states: {
        calm: { do: [{ action: "hold" }] },
        alarm: {
          onEnter: [{ effect: "say", text: "!" }],
          ...(emitTo ? { emit: { channel: emitTo, value: "on" as const } } : {}),
          do: [{ action: "hold" }],
        },
      },
      transitions: [
        {
          from: "calm",
          if: { cond: "in_range", of: nearest("player"), cells: 3 },
          bind: { who: nearest("player") },
          to: "alarm",
        },
        {
          from: "alarm",
          if: { cond: "out_of_range", of: slot("who"), cells: 3 },
          to: "calm",
        },
      ],
    };
  }

  const yelpers: TileDef[] = [
    ...tiles,
    tile({
      id: "yelper",
      height: 1,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: { brain: alarmedBrain() },
    }),
    // Startle it and it drives the "gate" channel on.
    tile({
      id: "alarm-deer",
      height: 1,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: { brain: alarmedBrain("gate") },
    }),
    // The canonical receiver pair, wired to that channel.
    tile({
      id: "gate",
      height: 2,
      walkable: false,
      interactions: { receive: { tileId: "gate-open", when: "on", mode: "any" } },
    }),
    tile({
      id: "gate-open",
      height: 0,
      interactions: { receive: { tileId: "gate", when: "off", mode: "any" } },
    }),
  ];

  /** Deer at the origin, a player three cells off, and room to place a gate. */
  function startled(creature: string): MapFile {
    let map = field(9);
    map = replaceStack(map, -9, -9, 0, [{ tileId: "grass" }]);
    map = withDeer(map, 0, 0, creature);
    return withPlayerAt(map, 3, 0);
  }

  function session(creature: string): GameSession {
    return new GameSession(startled(creature), yelpers, { actorIds: ["alice"], spawnAt: {
      x: -9,
      y: -9,
      z: 0,
      stackIndex: 1,
    } });
  }

  it("says its word on entry, pinned to the cell it stood in", () => {
    const s = session("yelper");
    advance(s, BRAIN_TICK_MS);

    const said = s.drainSpeech();
    expect(said).toHaveLength(1);
    expect(said[0]!.text).toBe("!");
    expect(said[0]!.actorId).not.toBe("alice");
    expect({ x: said[0]!.x, y: said[0]!.y }).toEqual({ x: 0, y: 0 });
    // The body it said it in travels with the words, because that is what the
    // bubble is attributed to — and the creature is free to bolt before anybody
    // reads it.
    expect(said[0]!.tileId).toBe("yelper");
  });

  it("says it once per entry, not once per tick it stays alarmed", () => {
    const s = session("yelper");
    advance(s, BRAIN_TICK_MS);
    expect(s.drainSpeech()).toHaveLength(1);

    // Still alarmed several ticks on, and silent throughout — the effect fired
    // on entry, not for as long as the state was held.
    advance(s, BRAIN_TICK_MS * 4);
    expect(s.drainSpeech()).toHaveLength(0);
  });

  /**
   * The guard the once-per-entry rule actually rests on: a transition whose
   * target is the state already occupied is not an entry. A wildcard that keeps
   * matching would otherwise re-fire the effect every tick.
   */
  it("treats a self-matching transition as staying, not re-entering", () => {
    const brain: BrainDef = {
      initial: "ringing",
      states: {
        ringing: { onEnter: [{ effect: "say", text: "!" }], do: [{ action: "hold" }] },
      },
      // Always true, always pointing back at the current state.
      transitions: [{ from: "any", if: { cond: "after", ms: 0 }, to: "ringing" }],
    };
    const memory = initialMemory(brain);
    const say = vi.fn();
    const c = {
      busy: false,
      rng: new Rng(1),
      self: { x: 0, y: 0, z: 0 },
      nearestOnTile: () => null,
      positionOf: () => null,
      wouldDrop: () => false,
      step: () => true,
      say,
      noise: vi.fn(),
      canSee: () => true,
      sight: { up: 0, down: 0 },
      heard: () => [],
      hurtBy: () => [],
      attack: () => false,
      nameOf: (id: string) => id,
    };

    for (let tick = 0; tick < 5; tick++) stepBrain(brain, memory, BRAIN_TICK_MS, c);

    // Once for entering the initial state, and never again for staying in it.
    expect(say).toHaveBeenCalledTimes(1);
  });

  it("holds a channel open while alarmed, and lets it close on settling", () => {
    let map = startled("alarm-deer");
    map = replaceStack(map, 5, 0, 0, [
      { tileId: "grass" },
      { tileId: "gate", channel: "gate" },
    ]);
    const s = new GameSession(map, yelpers, { actorIds: ["alice"], spawnAt: {
      x: -9,
      y: -9,
      z: 0,
      stackIndex: 1,
    } });

    const gateAt = () =>
      getStack(s.getMap(), 5, 0, 0).some((p) => p.tileId === "gate-open");

    expect(gateAt()).toBe(false);
    advance(s, BRAIN_TICK_MS * 2);
    // The mind driving the wire opened the gate, with no plate and no tap.
    expect(gateAt()).toBe(true);

    // Somebody far off arrives, then the one it was watching leaves — so the
    // world stays awake to think, but the deer is now out of range of anyone
    // and settles back to calm. Stopping driving is all it takes: the existing
    // settle pass closes the gate for free.
    s.spawn("bob", { at: { x: 9, y: 9, z: 0 } });
    s.despawn("alice");
    advance(s, BRAIN_TICK_MS * 2);
    expect(gateAt()).toBe(false);
  });

  /**
   * "Effects never contribute to the priority list's success or failure." A
   * successful `say` on entry must not rescue a state whose every action fails —
   * cornered is still cornered, however loudly it complains about it.
   */
  it("does not let an entry effect stand in for a failing action", () => {
    const brain: BrainDef = {
      initial: "penned",
      states: {
        penned: {
          onEnter: [{ effect: "say", text: "help" }],
          do: [{ action: "step_random" }],
        },
      },
      transitions: [],
    };
    const memory = initialMemory(brain);
    const c = {
      busy: false,
      rng: new Rng(1),
      self: { x: 0, y: 0, z: 0 },
      nearestOnTile: () => null,
      positionOf: () => null,
      wouldDrop: () => false,
      step: () => false,
      say: vi.fn(),
      noise: vi.fn(),
      canSee: () => true,
      sight: { up: 0, down: 0 },
      heard: () => [],
      hurtBy: () => [],
      attack: () => false,
      nameOf: (id: string) => id,
    };

    stepBrain(brain, memory, BRAIN_TICK_MS, c);

    expect(c.say).toHaveBeenCalledTimes(1);
    // The say landed, and the state is stuck all the same.
    expect(memory.stuck).toBe(true);
  });

  it("puts nothing said into the saved world", () => {
    const s = session("yelper");
    advance(s, BRAIN_TICK_MS * 3);

    expect(JSON.stringify(s.getMap())).not.toContain("!");
  });
});

describe("resuming a world", () => {
  /**
   * Position persists, the mind does not. Brain state is deliberately absent
   * from the checkpoint — a world nobody is looking at owes no continuity — and
   * this is what that buys: no saved state naming a state an edited brain no
   * longer has.
   */
  it("starts a resumed creature over from its initial state", () => {
    const first = new GameSession(withDeer(field(4), 0, 0), tiles, { actorIds: ["alice"] });
    advance(first, IDLE_MS * 2);
    const wandered = deerCell(first);
    expect(wandered).not.toBe("0,0");

    const resumed = new GameSession(first.getMap(), tiles, { actorIds: ["alice"], spawnAt: first.getSpawnPoint(), seed: first.getSeed() });

    // Where it left off, but back at the top of its machine — so it waits out a
    // fresh idle rather than carrying on mid-wander.
    expect(deerCell(resumed)).toBe(wandered);
    advance(resumed, IDLE_MS - BRAIN_TICK_MS);
    expect(deerCell(resumed)).toBe(wandered);
  });

  it("carries the dice on, rather than replaying the same wander", () => {
    const first = new GameSession(withDeer(field(4), 0, 0), tiles, { actorIds: ["alice"], seed: 5 });
    advance(first, IDLE_MS * 3);

    // Resumed mid-stream, so the draws that follow are new ones.
    expect(first.getSeed()).not.toBe(5);
  });
});

describe("staying awake to think", () => {
  /**
   * Regression: the tick loop stops when the session says it has settled, and a
   * creature counting down to its next move looks exactly like a settled world
   * — nothing is moving. So standing still stopped the loop, which froze the
   * very timer that would have started the next wander. Stand still, and the
   * wildlife stopped existing.
   */
  it("is not at rest while a watched creature is counting down", () => {
    const session = new GameSession(withDeer(field(4), 0, 0), tiles, { actorIds: ["alice"] });

    // Mid-idle: nobody is moving, and there is still something to wait for.
    advance(session, BRAIN_TICK_MS);

    expect(deerCell(session)).toBe("0,0");
    expect(session.isAtRest()).toBe(false);
  });

  it("rests once the only creature left has no brain to run", () => {
    // A body with no brain has nothing to wait for, so it is not a reason to
    // hold the loop open.
    const inert = tiles.map((t) =>
      t.id === "deer" ? tile({ ...t, interactions: {} }) : t,
    );
    const session = new GameSession(withDeer(field(4), 0, 0), inert, { actorIds: ["alice"] });

    advance(session, BRAIN_TICK_MS * 4);

    expect(session.isAtRest()).toBe(true);
  });
});

describe("a world nobody is watching", () => {
  it("does not think while nobody is connected", () => {
    const session = new GameSession(withDeer(field(4), 0, 0), tiles, { actorIds: [] });

    advance(session, IDLE_MS * 10);

    expect(deerCell(session)).toBe("0,0");
    expect(session.isAtRest()).toBe(true);
  });

  it("picks up thinking when somebody arrives", () => {
    const session = new GameSession(withDeer(field(4), 0, 0), tiles, { actorIds: [] });
    advance(session, IDLE_MS * 10);

    session.spawn("alice");
    advance(session, IDLE_MS * 4);

    expect(deerCell(session)).not.toBe("0,0");
  });

  /**
   * Freezing means "stop deciding", not "stop moving". A step abandoned halfway
   * would checkpoint a creature between two cells, which the rest of the
   * simulation is written to make impossible.
   */
  it("lets a step already under way finish after the last player leaves", () => {
    const session = new GameSession(withDeer(field(4), 0, 0), tiles, { actorIds: ["alice"] });
    advance(session, IDLE_MS);

    // Mid-stride: the brain has just committed to a walk.
    const midStride = session
      .actorSnapshots()
      .find((actor) => actor.tileId === "deer");
    expect(midStride?.walk).not.toBeNull();

    session.despawn("alice");
    advance(session, IDLE_MS * 4);

    const after = session
      .actorSnapshots()
      .find((actor) => actor.tileId === "deer");
    expect(after?.walk).toBeNull();
    // One cell travelled, and then nothing further.
    expect(deerCell(session)).not.toBe("0,0");
    expect(session.isAtRest()).toBe(true);
  });
});

/**
 * Being called, and answering.
 *
 * The one condition that is edge triggered rather than a standing question
 * about the board, so what is worth pinning down is *when* it fires: once per
 * thing said, to everybody in earshot at once, and never again on the tick
 * after.
 */
describe("hearing", () => {
  /** Answers to "ps" from anyone it can see within five cells. */
  function listeningBrain(los: boolean): BrainDef {
    return {
      initial: "idle",
      states: {
        idle: { do: [{ action: "hold" }] },
        answering: {
          onEnter: [{ effect: "say", text: "meow" }],
          do: [{ action: "step_toward", of: slot("caller") }, { action: "hold" }],
        },
        following: {
          do: [{ action: "step_toward", of: slot("caller") }, { action: "hold" }],
        },
      },
      transitions: [
        {
          from: ANY_STATE,
          if: { cond: "heard", text: "ps", cells: 5, los },
          bind: { caller: SPEAKER_SELECTOR },
          to: "answering",
        },
        { from: "answering", if: { cond: "after", ms: BRAIN_TICK_MS }, to: "following" },
      ],
    };
  }

  const listeners: TileDef[] = [
    ...tiles,
    tile({
      id: "listener",
      height: 1,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: { brain: listeningBrain(false) },
    }),
    tile({
      id: "watcher",
      height: 1,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: { brain: listeningBrain(true) },
    }),
  ];

  /** A creature at the origin, alice `apart` cells east, spawn out of the way. */
  function room(creature: string, apart: number): GameSession {
    let map = field(9);
    map = replaceStack(map, -9, -9, 0, [{ tileId: "grass" }]);
    map = withDeer(map, 0, 0, creature);
    map = withPlayerAt(map, apart, 0);
    return new GameSession(map, listeners, { actorIds: ["alice"], spawnAt: {
      x: -9,
      y: -9,
      z: 0,
      stackIndex: 1,
    } });
  }

  /** Everything said out loud over one stretch of ticks. */
  function saidDuring(session: GameSession, ms: number): string[] {
    const heard: string[] = [];
    for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      for (const bubble of session.drainSpeech()) heard.push(bubble.text);
    }
    return heard;
  }

  it("answers somebody who calls it", () => {
    const session = room("listener", 3);
    session.hear("alice", "psps");

    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual(["meow"]);
  });

  it("matches the word anywhere in the line, whatever the case", () => {
    const session = room("listener", 3);
    session.hear("alice", "come here PSPS!");

    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual(["meow"]);
  });

  it("ignores a line that does not contain the word", () => {
    const session = room("listener", 3);
    session.hear("alice", "hello there");

    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual([]);
  });

  it("ignores somebody calling from further off than it can hear", () => {
    const session = room("listener", 6);
    session.hear("alice", "psps");

    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual([]);
  });

  /**
   * The whole reason an utterance is cleared after the brain pass. A word left
   * lying about would be heard again by every later tick, and the cat would
   * meow forever over one call.
   */
  it("answers once per thing said, not once per tick after it", () => {
    const session = room("listener", 3);
    session.hear("alice", "psps");

    expect(saidDuring(session, BRAIN_TICK_MS * 10)).toEqual(["meow"]);
  });

  it("answers again when called again", () => {
    const session = room("listener", 3);
    session.hear("alice", "psps");
    advance(session, BRAIN_TICK_MS * 2);
    session.hear("alice", "psps");

    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual(["meow"]);
  });

  it("comes towards whoever called it", () => {
    const session = room("listener", 4);
    session.hear("alice", "psps");
    advance(session, BRAIN_TICK_MS * 4);

    const creature = session
      .actorSnapshots()
      .find((actor) => actor.tileId === "listener")!;
    expect(creature.x).toBeGreaterThan(0);
  });

  /**
   * Sound goes round a corner and a look does not, which is the difference the
   * `los` flag exists to express — same call, same distance, two answers.
   */
  it("hears through a wall, but only answers a caller it can see", () => {
    for (const [creature, answered] of [
      ["listener", ["meow"]],
      ["watcher", []],
    ] as const) {
      let map = field(9);
      map = replaceStack(map, -9, -9, 0, [{ tileId: "grass" }]);
      map = withDeer(map, 0, 0, creature);
      map = replaceStack(map, 2, 0, 0, [{ tileId: "grass" }, { tileId: "wall" }]);
      map = withPlayerAt(map, 4, 0);
      const session = new GameSession(map, listeners, { actorIds: ["alice"], spawnAt: {
        x: -9,
        y: -9,
        z: 0,
        stackIndex: 1,
      } });

      session.hear("alice", "psps");
      expect(saidDuring(session, BRAIN_TICK_MS * 2), creature).toEqual(answered);
    }
  });

  /**
   * `nearest:player` would answer "whoever is closest", which is exactly the
   * wrong answer in a room with two people in it: the one who called is not
   * necessarily the one standing nearest.
   */
  it("turns to the one who called, over the one standing closer", () => {
    const session = room("listener", 5);
    // Off the line to alice, so this is a question about who it picks rather
    // than about a body in the way.
    session.spawn("bob", { at: { x: 0, y: 2, z: 0 } });
    advance(session, BRAIN_TICK_MS);

    session.hear("alice", "psps");
    advance(session, BRAIN_TICK_MS * 4);

    // Alice called from five cells east. Bob is two cells north and silent —
    // and is who `nearest:player` would have named.
    const creature = session
      .actorSnapshots()
      .find((actor) => actor.tileId === "listener")!;
    expect(creature.x).toBeGreaterThan(0);
    expect(creature.y).toBe(0);
  });

  it("changes its mind when somebody else calls it", () => {
    let map = field(9);
    map = replaceStack(map, -9, -9, 0, [{ tileId: "grass" }]);
    map = withDeer(map, 0, 0, "listener");
    map = withPlayerAt(map, 3, 0);
    const session = new GameSession(map, listeners, { actorIds: ["alice"], spawnAt: {
      x: -9,
      y: -9,
      z: 0,
      stackIndex: 1,
    } });
    session.spawn("bob", { at: { x: 0, y: 3, z: 0 } });

    session.hear("alice", "psps");
    advance(session, BRAIN_TICK_MS * 2);
    const towardsAlice = session
      .actorSnapshots()
      .find((actor) => actor.tileId === "listener")!;
    expect(towardsAlice.x).toBeGreaterThan(0);

    // Bob calls from the other direction, and the second answer is the tell:
    // re-entering the state is what fires the greeting again.
    session.hear("bob", "psps");
    expect(saidDuring(session, BRAIN_TICK_MS * 4)).toEqual(["meow"]);
    const towardsBob = session
      .actorSnapshots()
      .find((actor) => actor.tileId === "listener")!;
    expect(towardsBob.y).toBeGreaterThan(0);
  });

  /** One word, every ear: the page is cleared after the whole pass, not per creature. */
  it("is heard by every creature in earshot at once", () => {
    let map = field(9);
    map = replaceStack(map, -9, -9, 0, [{ tileId: "grass" }]);
    map = withDeer(map, 0, 0, "listener");
    map = withDeer(map, 0, 1, "listener");
    map = withPlayerAt(map, 3, 0);
    const session = new GameSession(map, listeners, { actorIds: ["alice"], spawnAt: {
      x: -9,
      y: -9,
      z: 0,
      stackIndex: 1,
    } });

    session.hear("alice", "psps");
    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual(["meow", "meow"]);
  });

  /**
   * A brain gets exactly one turn at an utterance, so a world that stopped
   * ticking before that turn would swallow the call outright — not delay it.
   */
  it("keeps the world awake until the word has been heard", () => {
    const session = room("listener", 3);
    advance(session, BRAIN_TICK_MS * 8);

    session.hear("alice", "psps");
    expect(session.isAtRest()).toBe(false);
  });

  /** Said on the way out of the door, to an empty room, and gone. */
  it("drops what was said with nobody left to hear it", () => {
    const session = room("listener", 3);
    session.despawn("alice");
    session.hear("alice", "psps");
    advance(session, TICK_MS);

    expect(session.isAtRest()).toBe(true);
  });
});

/**
 * Asking more than one question on a transition.
 *
 * The flat machine took exactly one condition per row for a long time, so what
 * is worth pinning down is that nothing about the old shape moved: a bare
 * condition is still a condition, and a group is layered over the same
 * vocabulary rather than replacing it. @see ../lib/conditions
 */
describe("composing conditions", () => {
  function ctx(overrides: Partial<Parameters<typeof stepBrain>[3]> = {}) {
    return {
      busy: false,
      rng: new Rng(1),
      self: { x: 0, y: 0, z: 0 },
      nearestOnTile: () => null,
      positionOf: () => ({ x: 0, y: 0, z: 0 }),
      wouldDrop: () => false,
      step: vi.fn(() => true),
      say: vi.fn(),
      noise: vi.fn(),
      canSee: () => true,
      sight: { up: 0, down: 0 },
      heard: () => [],
      hurtBy: () => [],
      attack: vi.fn(() => false),
      nameOf: (id: string) => id,
      ...overrides,
    } satisfies Parameters<typeof stepBrain>[3];
  }

  /** Goes to `alert` when `condition` holds, and nowhere otherwise. */
  function watching(condition: BrainCondition): BrainDef {
    return {
      initial: "idle",
      states: {
        idle: { do: [{ action: "hold" }] },
        alert: { do: [{ action: "hold" }] },
      },
      transitions: [{ from: "idle", if: condition, to: "alert" }],
    };
  }

  function stateAfterOneTick(
    condition: BrainCondition,
    overrides: Partial<Parameters<typeof stepBrain>[3]> = {},
  ): string {
    const brain = watching(condition);
    const memory = initialMemory(brain);
    stepBrain(brain, memory, BRAIN_TICK_MS, ctx(overrides));
    return memory.state;
  }

  const NEVER_MS = BRAIN_TICK_MS * 100;

  it("wants every rule of an and", () => {
    const both = group<BrainConditionDef>("and", [
      { cond: "after", ms: 0 },
      { cond: "in_range", of: nearest("player"), cells: 3 },
    ]);
    expect(stateAfterOneTick(both, { positionOf: () => ({ x: 1, y: 0, z: 0 }), nearestOnTile: () => "alice" })).toBe("alert");
    // Same tree, nobody to be in range of.
    expect(stateAfterOneTick(both, { nearestOnTile: () => null })).toBe("idle");
  });

  it("wants any one rule of an or", () => {
    const either = group<BrainConditionDef>("or", [
      { cond: "after", ms: NEVER_MS },
      { cond: "stuck" },
    ]);
    expect(stateAfterOneTick(either)).toBe("idle");
    expect(
      stateAfterOneTick(
        group<BrainConditionDef>("or", [{ cond: "after", ms: NEVER_MS }, { cond: "after", ms: 0 }]),
      ),
    ).toBe("alert");
  });

  it("inverts a group with not", () => {
    const notYet = group<BrainConditionDef>("and", [{ cond: "after", ms: NEVER_MS }], true);
    expect(stateAfterOneTick(notYet)).toBe("alert");
  });

  it("nests as deep as it is authored", () => {
    const tree = group<BrainConditionDef>("and", [
      { cond: "after", ms: 0 },
      group<BrainConditionDef>("or", [
        { cond: "stuck" },
        group<BrainConditionDef>("and", [{ cond: "after", ms: NEVER_MS }], true),
      ]),
    ]);
    expect(stateAfterOneTick(tree)).toBe("alert");
  });

  /**
   * The one thing a tree could quietly break. `heard` records *who* spoke as it
   * answers, and that record is what `bind: { caller: speaker }` writes down —
   * so a branch asking whether somebody did **not** say something must leave no
   * fingerprint, or a transition that fired for an entirely different reason
   * writes down whoever the negated half happened to hear.
   */
  it("names nobody for a branch that asked whether something did not happen", () => {
    const brain: BrainDef = {
      initial: "idle",
      states: {
        idle: { do: [{ action: "hold" }] },
        alert: { do: [{ action: "hold" }] },
      },
      transitions: [
        {
          from: "idle",
          // Fires on the clock, whatever anyone said.
          if: group<BrainConditionDef>("or", [
            group<BrainConditionDef>("and", [{ cond: "heard", text: "bye", cells: 5 }], true),
            { cond: "after", ms: 0 },
          ]),
          bind: { caller: SPEAKER_SELECTOR },
          to: "alert",
        },
      ],
    };
    const memory = initialMemory(brain);

    stepBrain(
      brain,
      memory,
      BRAIN_TICK_MS,
      ctx({ heard: () => [{ speakerId: "bob", text: "bye" }] }),
    );

    expect(memory.state).toBe("alert");
    // Bob was heard by the negated branch and is nobody's caller for it.
    expect(memory.blackboard.caller).toBeUndefined();
  });

  it("refuses a group with nothing in it, and the brain with it", () => {
    const brain = {
      initial: "idle",
      states: { idle: { do: [] } },
      transitions: [{ from: "idle", if: { combinator: "and", rules: [] }, to: "idle" }],
    };
    expect(resolveBrain(tile({ id: "empty-group", height: 1, interactions: { brain } as never }))).toBeNull();
  });
});

/**
 * Talking to one person at a time.
 *
 * Everything here is authored rather than built in: engagement is a bound slot,
 * exclusivity is a `from` on the word that would otherwise start a second
 * conversation, and both ways out are the conditions the machine already had.
 * The runtime learned two things and no more — whose voice a `heard` counts, and
 * how a line names somebody — and this is the test that those two are enough.
 */
describe("holding a conversation", () => {
  const EARSHOT = 4;
  const GREETING_MS = BRAIN_TICK_MS;
  const CHAT_TIMEOUT_MS = BRAIN_TICK_MS * 8;

  /** Whoever the brain is currently engaged with, by the slot it binds. */
  const PARTNER = slot("partner");

  function shopkeeperBrain(): BrainDef {
    return {
      initial: "idle",
      states: {
        idle: { do: [{ action: "hold" }] },
        greeting: {
          onEnter: [{ effect: "say", text: "Hello, {partner}." }],
          do: [{ action: "hold" }],
        },
        talking: { do: [{ action: "hold" }] },
        // A dead end by design: the only way out is straight back to the
        // conversation it interrupted, so nothing about the engagement moves.
        busy: {
          onEnter: [{ effect: "say", text: "I'm busy with {partner} now." }],
          do: [{ action: "hold" }],
        },
        farewell: {
          onEnter: [{ effect: "say", text: "See you later." }],
          do: [{ action: "hold" }],
        },
      },
      transitions: [
        // Nobody to be busy with, so anybody's greeting is taken.
        {
          from: "idle",
          if: { cond: "heard", text: "hi", cells: EARSHOT, los: true },
          bind: { partner: SPEAKER_SELECTOR },
          to: "greeting",
        },
        { from: "greeting", if: { cond: "after", ms: GREETING_MS }, to: "talking" },
        // Above the interruption, so the person being talked to is answered
        // first when two people speak between one tick and the next.
        {
          from: "talking",
          if: {
            cond: "heard",
            text: "bye",
            cells: EARSHOT,
            los: true,
            from: { match: "is", of: PARTNER },
          },
          to: "farewell",
        },
        {
          from: "talking",
          if: {
            cond: "heard",
            text: "hi",
            cells: EARSHOT,
            los: true,
            from: { match: "not", of: PARTNER },
          },
          to: "busy",
        },
        { from: "busy", if: { cond: "after", ms: BRAIN_TICK_MS }, to: "talking" },
        // Two ways for a conversation to lapse, and one row, because they lead
        // to the same place: there is no priority between them to bury.
        {
          from: "talking",
          if: group<BrainConditionDef>("or", [
            { cond: "out_of_los", of: PARTNER, cells: EARSHOT },
            { cond: "after", ms: CHAT_TIMEOUT_MS },
          ]),
          to: "idle",
        },
        { from: "farewell", if: { cond: "after", ms: BRAIN_TICK_MS }, to: "idle" },
      ],
    };
  }

  const shopkeepers: TileDef[] = [
    ...tiles,
    tile({
      id: "shopkeeper",
      height: 1,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: { brain: shopkeeperBrain() },
    }),
  ];

  /** The shopkeeper at the origin, alice beside it, bob a step further round. */
  function shop(): GameSession {
    let map = field(9);
    map = replaceStack(map, -9, -9, 0, [{ tileId: "grass" }]);
    map = withDeer(map, 0, 0, "shopkeeper");
    map = withPlayerAt(map, 2, 0);
    const session = new GameSession(map, shopkeepers, {
      actorIds: ["alice"],
      spawnAt: { x: -9, y: -9, z: 0, stackIndex: 1 },
    });
    session.spawn("bob", { at: { x: 0, y: 2, z: 0 } });
    return session;
  }

  /** Everything said out loud over one stretch of ticks. */
  function saidDuring(session: GameSession, ms: number): string[] {
    const said: string[] = [];
    for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      for (const bubble of session.drainSpeech()) said.push(bubble.text);
    }
    return said;
  }

  const ALICE = displayNameFor("alice");

  it("greets whoever says hi, by name", () => {
    const session = shop();
    session.hear("alice", "hi there");

    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual([`Hello, ${ALICE}.`]);
  });

  it("stays out of it for a word it is not listening for", () => {
    const session = shop();
    session.hear("alice", "good morning");

    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual([]);
  });

  it("does not hear a greeting shouted from beyond its earshot", () => {
    const session = shop();
    session.despawn("alice");
    session.spawn("alice", { at: { x: EARSHOT + 2, y: 0, z: 0 } });
    session.hear("alice", "hi");

    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual([]);
  });

  /**
   * The whole point of engaging one person: the second greeting is turned away
   * *and names who it is turned away for*, which is the difference between an
   * NPC that is busy and one that is broken.
   */
  it("turns away a second greeting, naming who it is busy with", () => {
    const session = shop();
    session.hear("alice", "hi");
    advance(session, GREETING_MS + BRAIN_TICK_MS * 2);

    session.hear("bob", "hi");
    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual([
      `I'm busy with ${ALICE} now.`,
    ]);
  });

  it("keeps the partner it had after turning somebody away", () => {
    const session = shop();
    session.hear("alice", "hi");
    advance(session, GREETING_MS + BRAIN_TICK_MS * 2);
    session.hear("bob", "hi");
    advance(session, BRAIN_TICK_MS * 3);

    // Still alice's conversation to end, which is the test: bob interrupting
    // must not have quietly rebound the slot.
    session.hear("alice", "bye");
    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual(["See you later."]);
  });

  /**
   * `from: not` earning its keep. Without it this row fires for the partner's
   * own second greeting, and the shopkeeper tells you it is busy with you.
   */
  it("does not tell the person it is talking to that it is busy", () => {
    const session = shop();
    session.hear("alice", "hi");
    advance(session, GREETING_MS + BRAIN_TICK_MS * 2);

    session.hear("alice", "hi again");
    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual([]);
  });

  /** And the mirror: a passer-by cannot end a conversation they are not in. */
  it("is not dismissed by a stranger saying goodbye", () => {
    const session = shop();
    session.hear("alice", "hi");
    advance(session, GREETING_MS + BRAIN_TICK_MS * 2);

    session.hear("bob", "bye");
    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual([]);
  });

  it("says goodbye when its partner does, and takes the next person after", () => {
    const session = shop();
    session.hear("alice", "hi");
    advance(session, GREETING_MS + BRAIN_TICK_MS * 2);

    session.hear("alice", "bye");
    expect(saidDuring(session, BRAIN_TICK_MS * 3)).toEqual(["See you later."]);

    session.hear("bob", "hi");
    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual([
      `Hello, ${displayNameFor("bob")}.`,
    ]);
  });

  it("gives up on somebody who stopped talking", () => {
    const session = shop();
    session.hear("alice", "hi");
    advance(session, GREETING_MS + CHAT_TIMEOUT_MS + BRAIN_TICK_MS * 2);

    // The clock ran out, so alice no longer has the floor and bob does.
    session.hear("bob", "hi");
    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual([
      `Hello, ${displayNameFor("bob")}.`,
    ]);
  });

  it("gives up on somebody who walked off", () => {
    const session = shop();
    session.hear("alice", "hi");
    advance(session, GREETING_MS + BRAIN_TICK_MS * 2);

    session.despawn("alice");
    session.spawn("alice", { at: { x: EARSHOT + 3, y: 0, z: 0 } });
    advance(session, BRAIN_TICK_MS * 2);

    session.hear("bob", "hi");
    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual([
      `Hello, ${displayNameFor("bob")}.`,
    ]);
  });

  /**
   * A sentence has to survive its subject going missing. An unbound slot and a
   * misspelt one are the same thing at the moment the words are spoken, so both
   * land on the same vaguer word rather than leaking a brace onto the screen.
   */
  it("says someone when the slot it names is empty", () => {
    const brain: BrainDef = {
      initial: "idle",
      states: {
        idle: { do: [{ action: "hold" }] },
        muttering: {
          onEnter: [{ effect: "say", text: "Where has {partner} got to?" }],
          do: [{ action: "hold" }],
        },
      },
      transitions: [
        { from: "idle", if: { cond: "after", ms: 0 }, to: "muttering" },
      ],
    };
    const forgetful: TileDef[] = [
      ...tiles,
      tile({
        id: "forgetful",
        height: 1,
        actor: true,
        affectedByGravity: true,
        walkable: false,
        interactions: { brain },
      }),
    ];
    let map = field(9);
    map = replaceStack(map, -9, -9, 0, [{ tileId: "grass" }]);
    map = withDeer(map, 0, 0, "forgetful");
    map = withPlayerAt(map, 2, 0);
    const session = new GameSession(map, forgetful, {
      actorIds: ["alice"],
      spawnAt: { x: -9, y: -9, z: 0, stackIndex: 1 },
    });

    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual([
      "Where has someone got to?",
    ]);
  });
});

/**
 * The cat as authored, not as a fixture.
 *
 * Everything above tests the machinery against brains written for the test. This
 * one runs the brain that ships in `data/tiles.json`, because the machinery
 * being right and the content being right are separate ways to end up with a cat
 * that ignores you — a mistyped selector parses as a slot nobody binds, and the
 * only place that shows up is here.
 */
describe("the cat we ship", () => {
  const authored = normalizeTiles(tilesJson as unknown[]);

  /** Grass under everybody, the cat at the origin, alice `apart` cells east. */
  function yard(apart: number): GameSession {
    let map = emptyMap();
    for (let x = -9; x <= 9; x++) {
      for (let y = -9; y <= 9; y++) {
        map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
      }
    }
    map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "cat" }]);
    map = replaceStack(map, apart, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "e", owner: "alice" },
    ]);
    return new GameSession(map, authored, { actorIds: ["alice"], spawnAt: {
      x: -9,
      y: -9,
      z: 0,
      stackIndex: 1,
    } });
  }

  function catAt(session: GameSession) {
    return session.actorSnapshots().find((actor) => actor.tileId === "cat")!;
  }

  /**
   * Everything *heard* over a stretch of ticks — noise, not speech.
   *
   * A meow is a sound a cat makes, not a word it says, so the shipped cat emits
   * on the noise channel and this reads that one. The test-local cats elsewhere
   * in this file still `say`, which is what keeps both effects covered.
   */
  function noisesDuring(session: GameSession, ms: number): string[] {
    const heard: string[] = [];
    for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      for (const noise of session.drainNoise()) heard.push(noise.text);
    }
    return heard;
  }

  it("has a brain that holds together", () => {
    const cat = authored.find((def) => def.id === "cat")!;
    expect(resolveBrain(cat)?.initial).toBe("idle");
  });

  it("meows when called, and comes over", () => {
    const session = yard(4);
    session.hear("alice", "psps");

    expect(noisesDuring(session, BRAIN_TICK_MS * 2)).toEqual(["meow"]);
    advance(session, BRAIN_TICK_MS * 6);
    expect(catAt(session).x).toBeGreaterThan(0);
  });

  it("ignores somebody calling from outside its five cells", () => {
    const session = yard(7);
    session.hear("alice", "psps");

    expect(noisesDuring(session, BRAIN_TICK_MS * 4)).toEqual([]);
  });

  /** Its own wandering, which the call has to be able to interrupt. */
  it("takes itself for a walk while nobody is talking to it", () => {
    const session = yard(9);
    const before = `${catAt(session).x},${catAt(session).y}`;

    advance(session, 6000);

    expect(`${catAt(session).x},${catAt(session).y}`).not.toBe(before);
  });
});

/**
 * The two things in the world that want to hurt you, as authored.
 *
 * Here for the same reason the cat is: the machinery being right and the content
 * being right are separate ways to end up with a snake that watches you walk
 * past. Both are written against the one number a player can feel — the seven
 * cells at which being seen becomes being attacked.
 */
describe("the vermin we ship", () => {
  const authored = normalizeTiles(tilesJson as unknown[]);

  /** The sight range both of them are authored to notice you at. */
  const SIGHT_CELLS = 7;

  /**
   * The dice these yards are read against, pinned rather than left to the
   * world's default.
   *
   * **A creature that is ignoring you is still wandering**, so "it did not come
   * closer" is only ever true of a particular roll: a rat standing eight cells
   * off can scurry a cell inward for reasons that have nothing to do with
   * noticing anybody, and from seven it then hunts for reasons that do. Pinning
   * the stream is what makes that assertion mean the rule rather than the
   * weather. It has to be pinned *here* rather than inherited, because the
   * default stream shifts whenever anything else in the world draws from it —
   * authoring a kit onto the rat moved it, and this file went red for a wander
   * rather than for a brain.
   *
   * The rule itself is proved by the neighbouring test: from seven both of them
   * close, on any dice at all.
   */
  const YARD_SEED = 20260820;

  /**
   * Somewhere for a creature nobody is meant to notice to stand: far enough that
   * no brain here can see it, and *present*, because a world with nobody
   * connected freezes every brain in it. @see GameSession.tickBrains
   */
  const OFF_IN_THE_CORNER = { x: -12, y: -12 };

  /**
   * A walled yard: open dirt inside, with the option of a full-height wall
   * standing between the creature at the origin and whoever is east of it.
   */
  function yard(
    creatures: [string, number, number][],
    player: { x: number; y: number } = OFF_IN_THE_CORNER,
    wallAtX?: number,
  ): GameSession {
    let map = emptyMap();
    for (let x = -12; x <= 12; x++) {
      for (let y = -12; y <= 12; y++) {
        map = replaceStack(map, x, y, 0, [{ tileId: "dirt" }]);
      }
    }
    for (const [tileId, x, y] of creatures) {
      map = replaceStack(map, x, y, 0, [{ tileId: "dirt" }, { tileId }]);
    }
    if (wallAtX !== undefined) {
      for (let y = -12; y <= 12; y++) {
        map = replaceStack(map, wallAtX, y, 0, [
          { tileId: "dirt" },
          { tileId: "stone-wall" },
        ]);
      }
    }
    map = replaceStack(map, player.x, player.y, 0, [
      { tileId: "dirt" },
      { tileId: "player", direction: "e", owner: "alice" },
    ]);
    return new GameSession(map, authored, {
      actorIds: ["alice"],
      spawnAt: { x: 12, y: 12, z: 0, stackIndex: 1 },
      seed: YARD_SEED,
    });
  }

  function bodies(session: GameSession, tileId: string) {
    return session.actorSnapshots().filter((actor) => actor.tileId === tileId);
  }

  function gapToPlayer(session: GameSession, tileId: string): number {
    const creature = bodies(session, tileId)[0]!;
    const player = session.actorSnapshots().find((a) => a.tileId === "player")!;
    return Math.abs(creature.x - player.x) + Math.abs(creature.y - player.y);
  }

  it.each(["rat", "snake"])("has a brain that holds together: %s", (id) => {
    const def = authored.find((tile) => tile.id === id)!;
    expect(resolveBrain(def)).not.toBeNull();
  });

  it.each(["rat", "snake"])("closes on you from seven cells: %s", (id) => {
    const session = yard([[id, 0, 0]], { x: SIGHT_CELLS, y: 0 });

    advance(session, BRAIN_TICK_MS * 6);

    expect(gapToPlayer(session, id)).toBeLessThan(SIGHT_CELLS);
  });

  it.each(["rat", "snake"])("ignores you from eight: %s", (id) => {
    const session = yard([[id, 0, 0]], { x: SIGHT_CELLS + 1, y: 0 });

    advance(session, BRAIN_TICK_MS * 2);

    expect(gapToPlayer(session, id)).toBeGreaterThanOrEqual(SIGHT_CELLS + 1);
  });

  /**
   * Line of sight, not proximity: the whole difference between an animal that
   * notices you and a trigger you tripped through a wall.
   */
  it.each(["rat", "snake"])("does not see you through a wall: %s", (id) => {
    const session = yard([[id, 0, 0]], { x: 4, y: 0 }, 2);
    const before = gapToPlayer(session, id);

    advance(session, BRAIN_TICK_MS * 3);

    expect(gapToPlayer(session, id)).toBeGreaterThanOrEqual(before);
  });

  // A hiss on the noise channel, not the speech one: it is a sound, not a
  // sentence, so nothing anywhere writes "Snake says: sss".
  it("hisses when it strikes, once", () => {
    const session = yard([["snake", 0, 0]], { x: SIGHT_CELLS, y: 0 });
    const heard: string[] = [];
    for (let elapsed = 0; elapsed < BRAIN_TICK_MS * 4; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      for (const noise of session.drainNoise()) heard.push(noise.text);
    }
    expect(heard).toEqual(["sss"]);
    // And nothing at all on the channel that would have named a speaker.
    expect(session.drainSpeech()).toEqual([]);
  });

  it("is weaker than the snake, and quicker off the mark", () => {
    const rat = authored.find((tile) => tile.id === "rat")!;
    const snake = authored.find((tile) => tile.id === "snake")!;
    // Through the real derivation rather than off the authored block: none of
    // these three is a number anybody types any more, and comparing masteries
    // directly would assert the inputs while the fight reads the outputs.
    const stats = (def: typeof rat) => {
      const battler = resolveBattler(def)!;
      return fightingStats(battler, battler.naturalWeapon);
    };

    expect(stats(rat).maxHp).toBeLessThan(stats(snake).maxHp);
    expect(stats(rat).damage).toBeLessThan(stats(snake).damage);
    // Higher spd is a shorter wait between blows — see `./combat`.
    expect(attackIntervalMs(stats(rat).spd)).toBeLessThan(
      attackIntervalMs(stats(snake).spd),
    );
  });

  /**
   * The flock, which is the one thing about a rat that is not about you: with
   * nobody around to hunt, they should end up together rather than scattered.
   */
  /**
   * Asked of the whole stretch rather than of one moment, because a settled
   * flock breathes: a rat lets go of its mate once it is near and does not take
   * hold again until it has drifted several cells off, so the gap between two of
   * them is a range rather than a resting value. Sampling a single beat would be
   * asking where in that cycle the clock happened to stop.
   */
  it("gathers with the nearest rat while nothing else is going on", () => {
    const spread = 5;
    const session = yard([
      ["rat", 0, 0],
      ["rat", spread, 0],
    ]);

    let closest = Infinity;
    for (let beat = 0; beat < 20; beat++) {
      advance(session, BRAIN_TICK_MS);
      const [a, b] = bodies(session, "rat");
      closest = Math.min(closest, Math.abs(a!.x - b!.x) + Math.abs(a!.y - b!.y));
    }

    // They found each other, rather than each keeping its own corner.
    expect(closest).toBeLessThan(spread);
  });

  /**
   * A flock is not a heap.
   *
   * `step_toward` already gives up once nothing gets a rat any nearer, so a rat
   * never walks *into* its pack-mate — but that alone left four of them packed
   * against each other on 70% of beats in this very yard, because each was still
   * being pulled in by a bond it had no way to let go of. `loitering` is that
   * release: once a mate is near the attraction is dropped entirely and the rat
   * just potters, and it is not picked up again until the mate has drifted five
   * cells off.
   *
   * **Two cells, not one, and that is the whole rule.** Distance here is counted
   * in steps, so a rat standing diagonally touching another is two away, not one
   * — and releasing at one left every diagonal pair still bound, still shuffling
   * at each other, locked in a chain that jittered on the spot without ever
   * going anywhere. Four rats spent 76% of their life in that formation.
   * Releasing at two takes it to 4%.
   *
   * The gap between those two thresholds is doing real work. Releasing and
   * re-acquiring at the same distance would put a rat on the boundary into a
   * chase it abandons every other tick, which reads as a twitch rather than as
   * an animal.
   *
   * Measured once the pack has formed: two rats closing from opposite ends of a
   * row do brush past on the way in, and holding a settled flock to a standard
   * the act of gathering cannot meet would be a test about the first second of a
   * rat's life.
   */
  it("gathers without piling up", () => {
    const session = yard([
      ["rat", 0, 0],
      ["rat", 3, 0],
      ["rat", 6, 0],
      ["rat", 9, 0],
    ]);
    advance(session, BRAIN_TICK_MS * 30);

    let crowdedBeats = 0;
    let lockedBeats = 0;
    const beats = 60;
    const stepsApart = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

    for (let beat = 0; beat < beats; beat++) {
      advance(session, BRAIN_TICK_MS);
      const rats = bodies(session, "rat");
      if (rats.some((a) => rats.some((b) => a !== b && stepsApart(a, b) <= 1))) {
        crowdedBeats++;
      }
      // The zigzag: every rat diagonally glued to another, the whole chain
      // shuffling in place. Rare now; it used to be three beats in four.
      if (rats.every((a) => rats.some((b) => a !== b && stepsApart(a, b) === 2))) {
        lockedBeats++;
      }
    }

    // Still a flock — nobody was left behind at the far end of the row…
    const xs = bodies(session, "rat").map((rat) => rat.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(9);
    // …much less of a pile. Pitched between the two measurements rather than
    // against the current one, so this fails if the release stops working and
    // does not fail on a rat that wandered slightly differently.
    expect(crowdedBeats / beats).toBeLessThan(0.55);
    // …and not locked in the diagonal chain that releasing at one cell left.
    expect(lockedBeats / beats).toBeLessThan(0.4);
  });

  it("wanders on its own when there is no other rat to join", () => {
    const session = yard([["rat", 0, 0]]);
    const before = `${bodies(session, "rat")[0]!.x},${bodies(session, "rat")[0]!.y}`;

    advance(session, BRAIN_TICK_MS * 8);

    const after = bodies(session, "rat")[0]!;
    expect(`${after.x},${after.y}`).not.toBe(before);
  });
});

/**
 * The shopkeeper as authored, not as a fixture.
 *
 * The same guard `the cat we ship` exists for, and it bites harder here: this
 * brain leans on a slot in three separate places — the two voice filters, the
 * lapse condition, and the names in what it says — and every one of them fails
 * *silently* if the slot is misspelt. An unbound slot answers nobody, which is
 * a shopkeeper that greets you and then treats you as a stranger, with nothing
 * anywhere to say why.
 */
describe("the shopkeeper we ship", () => {
  const authored = normalizeTiles(tilesJson as unknown[]);

  /** Authored on the tile; the test would rather fail than drift from them. */
  const EARSHOT = 4;
  const GREETING_MS = 400;
  const BEAT_MS = 600;
  const CHAT_TIMEOUT_MS = 30000;

  /** Grass, the shopkeeper at the origin, alice beside it and bob behind. */
  function counter(between: string[] = []): GameSession {
    let map = emptyMap();
    for (let x = -9; x <= 9; x++) {
      for (let y = -9; y <= 9; y++) {
        map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
      }
    }
    map = replaceStack(map, 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "shopkeeper", direction: "w" },
    ]);
    // Whatever the shopkeeper has to look over, one cell short of alice.
    if (between.length > 0) {
      map = replaceStack(map, 2, 0, 0, [
        { tileId: "grass" },
        ...between.map((tileId) => ({ tileId })),
      ]);
    }
    map = replaceStack(map, 3, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "e", owner: "alice" },
    ]);
    const session = new GameSession(map, authored, {
      actorIds: ["alice"],
      spawnAt: { x: -9, y: -9, z: 0, stackIndex: 1 },
    });
    session.spawn("bob", { at: { x: 0, y: 1, z: 0 } });
    return session;
  }

  function saidDuring(session: GameSession, ms: number): string[] {
    const said: string[] = [];
    for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      for (const bubble of session.drainSpeech()) said.push(bubble.text);
    }
    return said;
  }

  /** Long enough for the greeting to settle into the talking state. */
  const ENGAGED_MS = GREETING_MS + BRAIN_TICK_MS * 2;

  const ALICE = displayNameFor("alice");
  const BOB = displayNameFor("bob");

  it("greets by name, and tells you how to leave", () => {
    const session = counter();
    session.hear("alice", "hi");

    expect(saidDuring(session, ENGAGED_MS)).toEqual([
      `Hello, ${ALICE}! Say bye when you're done.`,
    ]);
  });

  it("holds one conversation at a time, and says whose", () => {
    const session = counter();
    session.hear("alice", "hi");
    advance(session, ENGAGED_MS);

    session.hear("bob", "hi");
    expect(saidDuring(session, BEAT_MS + BRAIN_TICK_MS)).toEqual([
      `I'm busy with ${ALICE} now.`,
    ]);

    // And it is still alice's conversation afterwards, not bob's.
    session.hear("alice", "bye");
    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual(["See you later."]);
  });

  it("is not sent away by a stranger", () => {
    const session = counter();
    session.hear("alice", "hi");
    advance(session, ENGAGED_MS);

    session.hear("bob", "bye");
    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual([]);
  });

  it("takes the next person once the first has gone", () => {
    const session = counter();
    session.hear("alice", "hi");
    advance(session, ENGAGED_MS);
    session.hear("alice", "bye");
    advance(session, BEAT_MS + BRAIN_TICK_MS * 2);

    session.hear("bob", "hi");
    expect(saidDuring(session, ENGAGED_MS)).toEqual([
      `Hello, ${BOB}! Say bye when you're done.`,
    ]);
  });

  it("lets go of somebody who walked out of earshot", () => {
    const session = counter();
    session.hear("alice", "hi");
    advance(session, ENGAGED_MS);

    session.despawn("alice");
    session.spawn("alice", { at: { x: EARSHOT + 3, y: 0, z: 0 } });
    advance(session, BRAIN_TICK_MS * 2);

    session.hear("bob", "hi");
    expect(saidDuring(session, ENGAGED_MS)).toEqual([
      `Hello, ${BOB}! Say bye when you're done.`,
    ]);
  });

  it("lets go of somebody who stopped talking", () => {
    const session = counter();
    session.hear("alice", "hi");
    advance(session, ENGAGED_MS + CHAT_TIMEOUT_MS + BRAIN_TICK_MS * 2);

    session.hear("bob", "hi");
    expect(saidDuring(session, ENGAGED_MS)).toEqual([
      `Hello, ${BOB}! Say bye when you're done.`,
    ]);
  });

  it("does not answer a greeting shouted from too far off", () => {
    const session = counter();
    session.despawn("alice");
    session.spawn("alice", { at: { x: EARSHOT + 2, y: 0, z: 0 } });
    session.hear("alice", "hi");

    expect(saidDuring(session, ENGAGED_MS)).toEqual([]);
  });

  /**
   * The reason `heard` takes a sight test at all, met by the thing a player
   * actually does: put the furniture down and carry on talking.
   *
   * A box is half a level and the shopkeeper is a whole one, so it clears them —
   * and it has to, because a counter with anything on it is the ordinary case
   * for a shopkeeper rather than an edge one.
   */
  it("hears you over the boxes somebody stacked on the counter", () => {
    const session = counter(["wooden-box"]);
    session.hear("alice", "hi");

    expect(saidDuring(session, ENGAGED_MS)).toEqual([
      `Hello, ${ALICE}! Say bye when you're done.`,
    ]);
  });

  /** Two of them is a full level, and nobody sees over that. */
  it("is deaf behind a stack it cannot see over", () => {
    const session = counter(["wooden-box", "wooden-box"]);
    session.hear("alice", "hi");

    expect(saidDuring(session, ENGAGED_MS)).toEqual([]);
  });

  it("is deaf behind a wall", () => {
    const session = counter(["stone-wall"]);
    session.hear("alice", "hi");

    expect(saidDuring(session, ENGAGED_MS)).toEqual([]);
  });

  /**
   * Standing *somewhere*, which is the half a brain cannot say.
   *
   * Deliberately not which cell. Where an NPC stands is an authoring decision
   * and the map editor is how it gets made, so a test pinning the coordinate
   * turns moving the shopkeeper across the square into a failing build — which
   * is what happened the first time somebody did. What is still worth catching
   * is the tile existing in the library and being placed nowhere, since that
   * reads in game as a feature that silently is not there.
   */
  it("is placed on the shipped map", () => {
    const map = mapJson as unknown as FlatMapFile;
    const cells = Object.values(map.levels).flatMap((level) =>
      Object.values(level),
    );
    const placed = cells.some((stack) =>
      stack.some((tile) => tile.tileId === "shopkeeper"),
    );
    expect(placed).toBe(true);
  });
});
