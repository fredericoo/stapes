import { describe, expect, it, vi } from "vitest";
import tilesJson from "../../data/tiles.json";
import {
  ANY_STATE,
  SPEAKER_SELECTOR,
  brainReach,
  nearest,
  resolveBrain,
  slot,
  slotTiles,
  thing,
  type BrainActionDef,
  type BrainCondition,
  type BrainConditionDef,
  type BrainDef,
  type Selector,
} from "../lib/brain";
import { group } from "../lib/conditions";
import { displayNameFor } from "./displayName";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { Coord, Direction, FlatMapFile, MapFile, TileDef } from "../lib/types";
import { normalizeTileDef, normalizeTiles } from "../lib/types";
import {
  initialMemory,
  stepBrain,
  type WalkGoal,
  type WalkOrderState,
} from "./brainRuntime";
import { fightingStats, resolveBattler } from "../lib/battler";
import { attackIntervalMs } from "./combat";
import {
  BRAIN_ATTENTION_FLOOR_CELLS,
  BRAIN_DOZE_BUDGET,
  BRAIN_TICK_MS,
  TICK_MS,
  WALK_DURATION_MS,
} from "./constants";
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
  tile({ id: "wall", height: 4, walkable: false }),
  tile({
    id: "player",
    height: 4,
    directional: true,
    affectedByGravity: true,
    walkable: false,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
  }),
  tile({
    id: "deer",
    height: 2,
    actor: true,
    affectedByGravity: true,
    walkable: false,
    interactions: { brain: wanderingBrain() },
  }),
  // Same creature, with the priority list the other way round.
  tile({
    id: "deer-holding",
    height: 2,
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

/**
 * What a route looks like on an empty board: straight at them.
 *
 * What {@link standingOrder} routes with in every hand-built context here.
 * These cases are
 * about the *machine* — which line runs, what a failure falls through to — so
 * the board they run against is deliberately the one with nothing in it, and
 * the searching itself is pinned in `pathfinding.test.ts` instead.
 */
function openRoute(self: Coord, at: Coord): Direction | "arrived" | null {
  const dx = at.x - self.x;
  const dy = at.y - self.y;
  if (at.z === self.z && Math.abs(dx) + Math.abs(dy) <= 1) return "arrived";
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "e" : "w";
  return dy > 0 ? "s" : "n";
}

/**
 * The stand-in for the session's standing walk order.
 *
 * `GameSession.setWalkOrder` in miniature, and it has to be one: these cases are
 * about which line of a priority list runs, and that now turns on what an order
 * answers rather than on what a direction was. So it answers on the same terms —
 * a body already in motion is walking where it was told to and is not asked
 * again, and everything else resolves the goal, routes across the open board and
 * presses one leg.
 */
function standingOrder(
  ctx: Parameters<typeof stepBrain>[3],
  goal: WalkGoal,
): WalkOrderState {
  if (ctx.busy) return "walking";
  const at = goal.of === "cell" ? goal.at : ctx.positionOf(goal.id);
  if (!at) return "blocked";
  const direction = openRoute(ctx.self, at);
  if (direction === null) return "blocked";
  if (direction === "arrived") return "arrived";
  return ctx.step(direction) ? "walking" : "blocked";
}

/**
 * The stand-in for the session's standing flee order.
 *
 * The open board's answer to `findRefuge`, which on an empty field is the same
 * answer: the cell one step directly away is the furthest thing within reach,
 * and there is nothing to hide behind. What these cases need from it is the
 * shape — two outcomes, and a step requested through the same `step` every
 * other action goes through — rather than the search, which is pinned against
 * real geometry in `pathfinding.test.ts`.
 */
function runningOrder(
  ctx: Parameters<typeof stepBrain>[3],
  threat: Coord,
): WalkOrderState {
  if (ctx.busy) return "walking";
  const away = openRoute(threat, ctx.self);
  // Standing on the threat: there is no direction that is away from here.
  if (away === null || away === "arrived") return "blocked";
  return ctx.step(away) ? "walking" : "blocked";
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
    const def = tile({ id: "ok", height: 2, interactions: { brain: wanderingBrain() } });
    expect(resolveBrain(def)?.initial).toBe("idle");
  });

  it("is absent on a tile that authored none", () => {
    expect(resolveBrain(tile({ id: "rock", height: 2 }))).toBeNull();
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
      height: 2,
      interactions: { brain } as never,
    });
    expect(resolveBrain(def)).toBeNull();
  });
});

describe("deciding", () => {
  function ctx(overrides: Partial<Parameters<typeof stepBrain>[3]> = {}) {
    const self = overrides.self ?? { x: 0, y: 0, z: 0 };
    const built = {
      busy: false,
      rng: new Rng(1),
      self,
      home: null,
      nearestOnTile: () => null,
      nearestThing: () => null,
      thingStillThere: () => false,
      positionOf: () => null,
      wouldDrop: () => false,
      walkTo: (goal: WalkGoal): WalkOrderState => standingOrder(built, goal),
      fleeFrom: (threat: Coord): WalkOrderState => runningOrder(built, threat),
      step: vi.fn(() => true),
      say: vi.fn(),
      noise: vi.fn(),
      // Nothing in the way and nothing said, unless a test says otherwise: the
      // defaults are the empty room these cases are written about.
      canSee: () => true,
      sight: { up: 0, down: 0 },
      heard: () => [],
      heardNoise: () => [],
      talking: () => false,
      hurtBy: () => [],
      attack: vi.fn(() => false),
      extract: vi.fn(() => false),
      consume: vi.fn(() => false),
      consumeOn: vi.fn(() => false),
      carrying: () => false,
      hasStatus: () => false,
      nameOf: (id: string) => id,
      ...overrides,
    } satisfies Parameters<typeof stepBrain>[3];
    return built;
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
    height: 2,
    actor: true,
    affectedByGravity: true,
    walkable: false,
    interactions: { brain: followBrain() },
  }),
  tile({
    id: "shy",
    height: 2,
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
 * Finding a way round, which is the difference between a chase and a shove
 * against a wall.
 *
 * The report this exists for: a rat, a crate, and somebody standing behind it.
 * Closing the distance used to be judged one step at a time, so every direction
 * that got the rat any nearer was the one the crate was in — and a creature
 * that could plainly see you was defeated by a single box. `step_toward` now
 * asks the board for a route (`./pathfinding`), and these are the two answers
 * that route can come back with, seen from the outside.
 */
describe("chasing round an obstacle", () => {
  /** Notice at a distance, then commit — with room to detour before giving up. */
  const HUNT_CELLS = 8;
  const GIVE_UP_CELLS = 20;

  function huntBrain(): BrainDef {
    return {
      initial: "idle",
      states: {
        idle: { do: [{ action: "hold" }] },
        // No `hold` under it, deliberately: a state that ends in the action
        // which can fail is the only kind `stuck` can ever read.
        hunt: { do: [{ action: "step_toward", of: slot("prey") }] },
        giving_up: { onEnter: [{ effect: "noise", text: "tsk" }], do: [] },
      },
      transitions: [
        {
          from: "idle",
          if: { cond: "in_range", of: nearest("player"), cells: HUNT_CELLS },
          bind: { prey: nearest("player") },
          to: "hunt",
        },
        { from: "hunt", if: { cond: "stuck" }, to: "giving_up" },
        {
          from: "hunt",
          if: { cond: "out_of_range", of: slot("prey"), cells: GIVE_UP_CELLS },
          to: "idle",
        },
      ],
    };
  }

  const hunters: TileDef[] = [
    ...tiles,
    tile({
      id: "hunter",
      height: 2,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: { brain: huntBrain() },
    }),
  ];

  /** A hunter at the origin, somebody three cells east, and a wall between. */
  function penned(wall: readonly (readonly [number, number])[]): GameSession {
    let map = field(9);
    map = replaceStack(map, -9, -9, 0, [{ tileId: "grass" }]);
    map = withDeer(map, 0, 0, "hunter");
    map = withPlayerAt(map, 3, 0);
    for (const [x, y] of wall) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }, { tileId: "wall" }]);
    }
    return new GameSession(map, hunters, {
      actorIds: ["alice"],
      spawnAt: { x: -9, y: -9, z: 0, stackIndex: 1 },
    });
  }

  /** Steps between the hunter and the player, on the plan. */
  function between(session: GameSession): number {
    const actors = session.actorSnapshots();
    const hunter = actors.find((a) => a.tileId === "hunter")!;
    const player = actors.find((a) => a.tileId === "player")!;
    return Math.abs(hunter.x - player.x) + Math.abs(hunter.y - player.y);
  }

  it("walks round the box it used to stand behind", () => {
    // A three-cell screen: every step that shortens the gap is into it.
    const session = penned([[1, -1], [1, 0], [1, 1]]);
    expect(between(session)).toBe(3);

    advance(session, BRAIN_TICK_MS * 10);

    // Round the end of the screen and back, ending within reach.
    expect(between(session)).toBe(1);
  });

  /**
   * The other half, and the reason a failed route is not a step towards the
   * wall. A creature that cannot get to you at all now says so — which is a
   * `stuck` its author can transition on — rather than spending forever making
   * visible progress in the direction of somewhere it will never arrive.
   */
  it("gives up on somebody it has no way of reaching", () => {
    const session = penned([[2, -1], [2, 0], [2, 1], [3, -1], [3, 1], [4, 0]]);

    const heard: string[] = [];
    for (let elapsed = 0; elapsed < BRAIN_TICK_MS * 6; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      for (const noise of session.drainNoise()) heard.push(noise.text);
    }

    expect(heard).toContain("tsk");
    expect(between(session)).toBe(3);
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
      height: 2,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: { brain: flockBrain("rat") },
    }),
    tile({
      id: "mouse",
      height: 2,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: { brain: flockBrain("mouse") },
    }),
    // Follows rats without being one — the leader case, and the thing a
    // same-tile-only rule could not express at all.
    tile({
      id: "ratcatcher",
      height: 2,
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
      height: 2,
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
      home: null,
      nearestOnTile: () => null,
      nearestThing: () => null,
      thingStillThere: () => false,
      positionOf: () => null,
      wouldDrop: () => false,
      walkTo: (): WalkOrderState => "blocked",
      fleeFrom: (): WalkOrderState => "blocked",
      step: () => false,
      say: () => {},
      noise: () => {},
      canSee: () => true,
      sight: { up: 0, down: 0 },
      heard: () => [],
      heardNoise: () => [],
      talking: () => false,
      hurtBy: () => [],
      attack: () => false,
      extract: () => false,
      consume: () => false,
      consumeOn: () => false,
      carrying: () => false,
      hasStatus: () => false,
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
      height: 2,
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
      height: 2,
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
    // The same pair again, closing on somebody rather than stepping at random:
    // the flag has to mean the same thing to a routed action as to a local one.
    ...(
      [
        ["stalker", false],
        ["pouncer", true],
      ] as const
    ).map(([id, allowDrops]) =>
      tile({
        id,
        height: 2,
        actor: true,
        affectedByGravity: true,
        walkable: false,
        interactions: {
          brain: {
            initial: "hunt",
            states: {
              hunt: {
                do: [
                  { action: "step_toward", of: nearest("player"), allowDrops },
                  { action: "hold" },
                ],
              },
            },
            transitions: [],
          },
        },
      }),
    ),
  ];

  /** A one-cell plinth a level up, with open floor all around below. */
  function plinth(creature: string): GameSession {
    let map = field(4);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "grass" }, { tileId: creature }]);
    return new GameSession(map, ledgeDwellers, { actorIds: ["alice"] });
  }

  /**
   * The same plinth, with somebody on the floor below and three cells off it —
   * far enough that the fall lands nowhere near them, so getting there means
   * routing *through* the drop rather than onto the cell it ends at.
   */
  function overlooked(creature: string): GameSession {
    let map = field(4);
    // The authored spawn marker cleared, so the one player body on this board
    // is the one the creature is looking down at.
    map = replaceStack(map, -4, -4, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "grass" }, { tileId: creature }]);
    map = withPlayerAt(map, 3, 0);
    return new GameSession(map, ledgeDwellers, {
      actorIds: ["alice"],
      spawnAt: { x: -4, y: -4, z: 0, stackIndex: 1 },
    });
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

  /**
   * And a routed action reads the flag the same way a random step does: a drop
   * is an edge of the route wherever it lands, not only where the route ends.
   *
   * Worth pinning apart from the two above because the route is where the
   * question got a third answer — a player's click may fall only onto the cell
   * it was aimed at, and a creature is deliberately not held to that. A brain
   * told it may take drops is one an author wants coming down off things.
   * @see ../game/pathfinding's `PathOptions.drops`
   */
  it("routes off the plinth after somebody it was told it could drop for", () => {
    const session = overlooked("pouncer");

    advance(session, BRAIN_TICK_MS * 8);

    // Off the plinth and standing beside them, which is the whole of arriving.
    expect(levelOf(session, "pouncer")).toBe(0);
  });

  it("keeps a routing one up there when it was not", () => {
    const session = overlooked("stalker");

    advance(session, BRAIN_TICK_MS * 8);

    // No way down that is a walk, so no route at all — and a creature with no
    // route stands still rather than pressing itself against the edge.
    expect(levelOf(session, "stalker")).toBe(1);
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
    const self = overrides.self ?? { x: 0, y: 0, z: 0 };
    const built = {
      busy: false,
      rng: new Rng(1),
      self,
      home: null,
      nearestOnTile: () => null,
      nearestThing: () => null,
      thingStillThere: () => false,
      positionOf: () => null,
      wouldDrop: () => false,
      walkTo: (goal: WalkGoal): WalkOrderState => standingOrder(built, goal),
      fleeFrom: (threat: Coord): WalkOrderState => runningOrder(built, threat),
      step: vi.fn(() => true),
      say: vi.fn(),
      noise: vi.fn(),
      // Nothing in the way and nothing said, unless a test says otherwise: the
      // defaults are the empty room these cases are written about.
      canSee: () => true,
      sight: { up: 0, down: 0 },
      heard: () => [],
      heardNoise: () => [],
      talking: () => false,
      hurtBy: () => [],
      attack: vi.fn(() => false),
      extract: vi.fn(() => false),
      consume: vi.fn(() => false),
      consumeOn: vi.fn(() => false),
      carrying: () => false,
      hasStatus: () => false,
      nameOf: (id: string) => id,
      ...overrides,
    } satisfies Parameters<typeof stepBrain>[3];
    return built;
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
    memory.blackboard.friend = { kind: "body", id: "alice" };

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
      height: 2,
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
      height: 2,
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
      height: 2,
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
      height: 2,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: { brain: alarmedBrain() },
    }),
    // Startle it and it drives the "gate" channel on.
    tile({
      id: "alarm-deer",
      height: 2,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: { brain: alarmedBrain("gate") },
    }),
    // The canonical receiver pair, wired to that channel.
    tile({
      id: "gate",
      height: 4,
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
      home: null,
      nearestOnTile: () => null,
      nearestThing: () => null,
      thingStillThere: () => false,
      positionOf: () => null,
      wouldDrop: () => false,
      walkTo: (): WalkOrderState => "blocked",
      fleeFrom: (): WalkOrderState => "blocked",
      step: () => true,
      say,
      noise: vi.fn(),
      canSee: () => true,
      sight: { up: 0, down: 0 },
      heard: () => [],
      heardNoise: () => [],
      talking: () => false,
      hurtBy: () => [],
      attack: () => false,
      extract: () => false,
      consume: () => false,
      consumeOn: () => false,
      carrying: () => false,
      hasStatus: () => false,
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
      home: null,
      nearestOnTile: () => null,
      nearestThing: () => null,
      thingStillThere: () => false,
      positionOf: () => null,
      wouldDrop: () => false,
      walkTo: (): WalkOrderState => "blocked",
      fleeFrom: (): WalkOrderState => "blocked",
      step: () => false,
      say: vi.fn(),
      noise: vi.fn(),
      canSee: () => true,
      sight: { up: 0, down: 0 },
      heard: () => [],
      heardNoise: () => [],
      talking: () => false,
      hurtBy: () => [],
      attack: () => false,
      extract: () => false,
      consume: () => false,
      consumeOn: () => false,
      carrying: () => false,
      hasStatus: () => false,
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
      height: 2,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: { brain: listeningBrain(false) },
    }),
    tile({
      id: "watcher",
      height: 2,
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
 * Hearing something that nobody said.
 *
 * The other channel, and the tests are written against the three things that
 * make it a different question from being called. A sound needs no word to react
 * to, it goes round corners because sound does, and a creature never sets itself
 * off with its own. Everything else — once per event, everybody at once, the
 * world staying awake to deliver it — it shares with speech, and is asserted
 * here rather than assumed because the two run on separate lists.
 */
describe("hearing a sound", () => {
  const EARSHOT = 6;

  /** Yaps the once, on its very first turn, and then stands there. */
  function yappingBrain() {
    return {
      initial: "barking",
      states: {
        barking: {
          onEnter: [{ effect: "noise", text: "woof" }],
          do: [{ action: "hold" }],
        },
      },
      transitions: [],
    } satisfies BrainDef;
  }

  /** Goes to look at whatever it heard, saying so, so a test can read it. */
  function nosyBrain(text?: string): BrainDef {
    return {
      initial: "idle",
      states: {
        idle: { do: [{ action: "hold" }] },
        looking: {
          onEnter: [{ effect: "say", text: "?" }],
          do: [{ action: "step_toward", of: slot("source") }, { action: "hold" }],
        },
      },
      transitions: [
        {
          from: "idle",
          if: { cond: "heard_noise", cells: EARSHOT, ...(text ? { text } : {}) },
          bind: { source: SPEAKER_SELECTOR },
          to: "looking",
        },
      ],
    };
  }

  /** A nosy creature that also yaps on its way into the state it listens from. */
  function yappingWhileNosy(): BrainDef {
    const brain = nosyBrain();
    return {
      ...brain,
      states: {
        ...brain.states,
        idle: {
          onEnter: [{ effect: "noise", text: "woof" }],
          do: [{ action: "hold" }],
        },
      },
    };
  }

  const creatures: TileDef[] = [
    ...tiles,
    tile({
      id: "yapper",
      height: 2,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: { brain: yappingBrain() },
    }),
    tile({
      id: "nosy",
      height: 2,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: { brain: nosyBrain() },
    }),
    /** The same yap, with a different word in it. */
    tile({
      id: "meower",
      height: 2,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: {
        brain: {
          ...yappingBrain(),
          states: {
            barking: {
              onEnter: [{ effect: "noise", text: "meow" }],
              do: [{ action: "hold" }],
            },
          },
        },
      },
    }),
    /** Listening for one word rather than for any sound at all. */
    tile({
      id: "picky",
      height: 2,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: { brain: nosyBrain("meow") },
    }),
    /**
     * Both at once: it yaps on entry and listens for anything. The whole of
     * whether a creature can set itself off.
     */
    tile({
      id: "yapping-nosy",
      height: 2,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: { brain: yappingWhileNosy() },
    }),
  ];

  /**
   * A listener at the origin, a `maker` `apart` cells east, alice parked in the
   * corner because a world with nobody connected freezes every brain in it.
   */
  function room(listener: string, maker: string | null, apart = 3): GameSession {
    let map = field(9);
    map = replaceStack(map, -9, -9, 0, [{ tileId: "grass" }]);
    map = withDeer(map, 0, 0, listener);
    if (maker) map = withDeer(map, apart, 0, maker);
    map = withPlayerAt(map, -9, 9);
    return new GameSession(map, creatures, {
      actorIds: ["alice"],
      spawnAt: { x: -9, y: -9, z: 0, stackIndex: 1 },
    });
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

  function bodyAt(session: GameSession, tileId: string) {
    return session.actorSnapshots().find((actor) => actor.tileId === tileId)!;
  }

  /**
   * The batch is handed over at the top of a pass, so a sound made *during* one
   * is heard on the next — which is why every window here is three brain ticks
   * rather than two. That delay is the price of the whole room hearing the same
   * thing whatever order the creatures happen to tick in.
   */
  const AUDIBLE_MS = BRAIN_TICK_MS * 3;

  it("notices a sound with no word in it at all", () => {
    const session = room("nosy", "yapper");

    expect(saidDuring(session, AUDIBLE_MS)).toEqual(["?"]);
  });

  it("goes to look at whatever made it", () => {
    const session = room("nosy", "yapper", 5);
    advance(session, BRAIN_TICK_MS * 6);

    expect(bodyAt(session, "nosy").x).toBeGreaterThan(0);
  });

  /**
   * The one asymmetry with being called. `heard` can be told to insist on
   * seeing whoever spoke, because a summons through a closed door is wrong;
   * there is no such flag here, because a sound through a closed door is the
   * whole of what a sound is.
   */
  it("hears it through a wall", () => {
    let map = field(9);
    map = replaceStack(map, -9, -9, 0, [{ tileId: "grass" }]);
    map = withDeer(map, 0, 0, "nosy");
    map = replaceStack(map, 2, 0, 0, [{ tileId: "grass" }, { tileId: "wall" }]);
    map = withDeer(map, 4, 0, "yapper");
    map = withPlayerAt(map, -9, 9);
    const session = new GameSession(map, creatures, {
      actorIds: ["alice"],
      spawnAt: { x: -9, y: -9, z: 0, stackIndex: 1 },
    });

    expect(saidDuring(session, AUDIBLE_MS)).toEqual(["?"]);
  });

  it("ignores one made further off than it can hear", () => {
    const session = room("nosy", "yapper", EARSHOT + 1);

    expect(saidDuring(session, AUDIBLE_MS)).toEqual([]);
  });

  /**
   * Otherwise a creature that barks on the way into a state barks its way
   * straight back into it, for ever.
   */
  it("never hears itself", () => {
    const session = room("yapping-nosy", null);

    expect(saidDuring(session, BRAIN_TICK_MS * 8)).toEqual([]);
  });

  it("matches a word in the sound when it is given one", () => {
    expect(saidDuring(room("picky", "meower"), AUDIBLE_MS)).toEqual(["?"]);
    // Same distance, same channel, a sound it was not listening for.
    expect(saidDuring(room("picky", "yapper"), AUDIBLE_MS)).toEqual([]);
  });

  it("is heard by every creature in earshot at once", () => {
    let map = field(9);
    map = replaceStack(map, -9, -9, 0, [{ tileId: "grass" }]);
    map = withDeer(map, 0, 0, "nosy");
    map = withDeer(map, 0, 1, "nosy");
    map = withDeer(map, 3, 0, "yapper");
    map = withPlayerAt(map, -9, 9);
    const session = new GameSession(map, creatures, {
      actorIds: ["alice"],
      spawnAt: { x: -9, y: -9, z: 0, stackIndex: 1 },
    });

    expect(saidDuring(session, AUDIBLE_MS)).toEqual(["?", "?"]);
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
    const built = {
      busy: false,
      rng: new Rng(1),
      self: { x: 0, y: 0, z: 0 },
      home: null,
      nearestOnTile: () => null,
      nearestThing: () => null,
      thingStillThere: () => false,
      positionOf: () => ({ x: 0, y: 0, z: 0 }),
      wouldDrop: () => false,
      walkTo: (): WalkOrderState => "arrived",
      fleeFrom: (threat: Coord): WalkOrderState => runningOrder(built, threat),
      step: vi.fn(() => true),
      say: vi.fn(),
      noise: vi.fn(),
      canSee: () => true,
      sight: { up: 0, down: 0 },
      heard: () => [],
      heardNoise: () => [],
      talking: () => false,
      hurtBy: () => [],
      attack: vi.fn(() => false),
      extract: vi.fn(() => false),
      consume: vi.fn(() => false),
      consumeOn: vi.fn(() => false),
      carrying: () => false,
      hasStatus: () => false,
      nameOf: (id: string) => id,
      ...overrides,
    } satisfies Parameters<typeof stepBrain>[3];
    return built;
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
    expect(resolveBrain(tile({ id: "empty-group", height: 2, interactions: { brain } as never }))).toBeNull();
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
      height: 2,
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
        height: 2,
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
 * The wolf we ship, and the one sense it has that nothing else does.
 *
 * Here for the reason the cat and the vermin are: the machinery being right and
 * the content being right are separate ways to end up with a wolf that ignores
 * a scream twelve cells away. Written against the two numbers a player can feel
 * — the twenty cells it hears from, and the nine at which being seen becomes
 * being hunted.
 */
describe("the wolf we ship", () => {
  const authored = normalizeTiles(tilesJson as unknown[]);

  /** What the brain in `data/tiles.json` is authored to hear from. */
  const EARSHOT_CELLS = 20;

  /**
   * Open dirt, the wolf at the origin, a cat `apart` cells east, and alice
   * standing beside the cat.
   *
   * The cat is the noise: it meows on the noise channel when called, which is a
   * sound made by a body somewhere in the world rather than a fixture reaching
   * into the session. Alice is next to it because that is the only way to make
   * it meow — and far enough from the wolf that being seen is not what moves it.
   */
  function moor(apart: number, wallAtX?: number): GameSession {
    let map = emptyMap();
    for (let x = -4; x <= 30; x++) {
      for (let y = -6; y <= 6; y++) {
        map = replaceStack(map, x, y, 0, [{ tileId: "dirt" }]);
      }
    }
    // A wall with a way round it. Sealing the moor off end to end would test
    // something else entirely now that `step_toward` routes: with no path at
    // all the action fails outright, so a wolf standing still would prove that
    // the wall is solid rather than that it heard anything.
    if (wallAtX !== undefined) {
      for (let y = -6; y <= 4; y++) {
        map = replaceStack(map, wallAtX, y, 0, [
          { tileId: "dirt" },
          { tileId: "stone-wall" },
        ]);
      }
    }
    map = replaceStack(map, 0, 0, 0, [{ tileId: "dirt" }, { tileId: "wolf" }]);
    map = replaceStack(map, apart, 0, 0, [{ tileId: "dirt" }, { tileId: "cat" }]);
    map = replaceStack(map, apart, 2, 0, [
      { tileId: "dirt" },
      { tileId: "player", direction: "e", owner: "alice" },
    ]);
    return new GameSession(map, authored, {
      actorIds: ["alice"],
      spawnAt: { x: 30, y: 6, z: 0, stackIndex: 1 },
      seed: 20260822,
    });
  }

  /** Steps between the wolf and the thing it heard. */
  function gapToCat(session: GameSession): number {
    const actors = session.actorSnapshots();
    const wolf = actors.find((a) => a.tileId === "wolf")!;
    const cat = actors.find((a) => a.tileId === "cat")!;
    return Math.abs(wolf.x - cat.x) + Math.abs(wolf.y - cat.y);
  }

  it("has a brain that holds together", () => {
    const wolf = authored.find((def) => def.id === "wolf")!;
    expect(resolveBrain(wolf)?.initial).toBe("prowling");
  });

  /**
   * Twelve cells is well outside the nine it hunts on sight from, so nothing
   * about this is the wolf noticing anybody. It heard a cat.
   */
  it("comes to look at a sound from twelve cells off", () => {
    const session = moor(12);
    session.hear("alice", "psps");

    advance(session, BRAIN_TICK_MS * 12);

    expect(gapToCat(session)).toBeLessThanOrEqual(7);
  });

  /**
   * The same call, from one cell beyond earshot. A prowling wolf wanders, so
   * this is read against a pinned stream: what is asserted is that it did not
   * *set off*, which on these dice means it did not close the gap.
   */
  it("ignores one from further off than it can hear", () => {
    const session = moor(EARSHOT_CELLS + 1);
    session.hear("alice", "psps");

    advance(session, BRAIN_TICK_MS * 12);

    expect(gapToCat(session)).toBeGreaterThanOrEqual(EARSHOT_CELLS);
  });

  /**
   * Sound goes round corners, so a wall between the two of them changes nothing
   * about being heard — and the wolf then walks round the wall to get there.
   * This is the whole difference between the ears it has just grown and the eyes
   * it already had: a wolf with only `in_los` never leaves the spot it is
   * standing on, because there is nothing to see from it.
   */
  /**
   * What the sniff on the way into `investigating` buys, and it is the reason
   * that effect is authored at all: a wolf going to look is itself something to
   * be heard, so word travels through a pack in twenty-cell hops.
   *
   * Read off the noise channel rather than off positions, because the count is
   * the whole claim. The second sniff can only have come from the wolf that
   * never heard the cat.
   */
  it("passes word to a wolf that heard nothing itself", () => {
    let map = emptyMap();
    for (let x = -4; x <= 40; x++) {
      for (let y = -6; y <= 6; y++) {
        map = replaceStack(map, x, y, 0, [{ tileId: "dirt" }]);
      }
    }
    // Twelve apart: past the eight cells at which they fall in with a packmate
    // they can see, inside the twenty at which they hear one.
    map = replaceStack(map, 0, 0, 0, [{ tileId: "dirt" }, { tileId: "wolf" }]);
    map = replaceStack(map, 12, 0, 0, [{ tileId: "dirt" }, { tileId: "wolf" }]);
    // Thirty cells from the far wolf, which is ten beyond its hearing.
    map = replaceStack(map, 30, 0, 0, [{ tileId: "dirt" }, { tileId: "cat" }]);
    map = replaceStack(map, 30, 3, 0, [
      { tileId: "dirt" },
      { tileId: "player", direction: "e", owner: "alice" },
    ]);
    const session = new GameSession(map, authored, {
      actorIds: ["alice"],
      spawnAt: { x: 40, y: 6, z: 0, stackIndex: 1 },
      seed: 20260822,
    });

    session.hear("alice", "psps");
    const heard: string[] = [];
    for (let elapsed = 0; elapsed < BRAIN_TICK_MS * 5; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      for (const noise of session.drainNoise()) heard.push(noise.text);
    }

    expect(heard).toEqual(["meow", "sniff", "sniff"]);
  });

  it("hears it through a wall it cannot see over", () => {
    const session = moor(12, 6);
    session.hear("alice", "psps");

    advance(session, BRAIN_TICK_MS * 20);

    // Round the end of the wall and out the other side, having never once had
    // the cat in view.
    const wolf = session.actorSnapshots().find((a) => a.tileId === "wolf")!;
    expect(wolf.x).toBeGreaterThan(6);
    expect(gapToCat(session)).toBeLessThan(12);
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
/**
 * The one selector that names a place.
 *
 * Everything in these cases turns on the same distinction: `home` is answered
 * without asking the world who is standing anywhere, so the verbs that want a
 * *body* get nobody from it and the verbs that want a *cell* get one. Both
 * halves are the point — a leash is worthless if `step_toward home` works and
 * `out_of_range of home` does not, and it is worse than worthless if
 * `attack home` throws rather than falling through.
 */
describe("knowing where it belongs", () => {
  const HOME: Selector = { type: "home" };
  const BURROW = { x: 4, y: 0, z: 0 };

  function ctx(overrides: Partial<Parameters<typeof stepBrain>[3]> = {}) {
    const self = overrides.self ?? { x: 0, y: 0, z: 0 };
    const built = {
      busy: false,
      rng: new Rng(1),
      self,
      home: BURROW,
      nearestOnTile: () => null,
      nearestThing: () => null,
      thingStillThere: () => false,
      positionOf: () => null,
      wouldDrop: () => false,
      walkTo: (goal: WalkGoal): WalkOrderState => standingOrder(built, goal),
      fleeFrom: (threat: Coord): WalkOrderState => runningOrder(built, threat),
      step: vi.fn(() => true),
      say: vi.fn(),
      noise: vi.fn(),
      canSee: () => true,
      // The floor-bound reckoning every creature we ship has. Home is measured
      // past it, which is the case below.
      sight: { up: 0, down: 0 },
      heard: () => [],
      heardNoise: () => [],
      talking: () => false,
      hurtBy: () => [],
      attack: vi.fn(() => false),
      extract: vi.fn(() => false),
      consume: vi.fn(() => false),
      consumeOn: vi.fn(() => false),
      carrying: () => false,
      hasStatus: () => false,
      nameOf: (id: string) => id,
      ...overrides,
    } satisfies Parameters<typeof stepBrain>[3];
    return built;
  }

  /** Wander until home is more than `cells` away, then walk back to it. */
  function leashed(cells: number): BrainDef {
    return {
      initial: "roaming",
      states: {
        roaming: { do: [{ action: "step_random" }] },
        homing: { do: [{ action: "step_toward", of: HOME }, { action: "hold" }] },
      },
      transitions: [
        {
          from: "roaming",
          if: { cond: "out_of_range", of: HOME, cells },
          to: "homing",
        },
        {
          from: "homing",
          if: { cond: "in_range", of: HOME, cells: 0 },
          to: "roaming",
        },
      ],
    };
  }

  it("stays where it is while home is near enough", () => {
    const brain = leashed(4);
    const memory = initialMemory(brain);

    stepBrain(brain, memory, BRAIN_TICK_MS, ctx());

    expect(memory.state).toBe("roaming");
  });

  it("turns for home once it has gone too far", () => {
    const brain = leashed(3);
    const memory = initialMemory(brain);

    stepBrain(brain, memory, BRAIN_TICK_MS, ctx());

    expect(memory.state).toBe("homing");
  });

  /**
   * The step itself, and only the ones that close the distance: `step_toward`
   * filters to directions that genuinely improve matters, so a creature four
   * cells east of nothing walks east.
   */
  it("steps the way home rather than any way at all", () => {
    const brain = leashed(3);
    const memory = initialMemory(brain);
    const c = ctx();

    stepBrain(brain, memory, BRAIN_TICK_MS, c);

    expect(c.step).toHaveBeenCalledWith("e");
  });

  /**
   * A creature the world did not author has nowhere to be — and `out_of_range`
   * of nowhere holds, on exactly the terms it holds for a target that has left
   * the board. That is what makes a `home` authored onto something with no
   * authored cell inert rather than a body pinned to the origin.
   */
  it("is always far from a home it does not have", () => {
    const brain = leashed(99);
    const memory = initialMemory(brain);
    const c = ctx({ home: null });

    stepBrain(brain, memory, BRAIN_TICK_MS, c);

    expect(memory.state).toBe("homing");
    // And nothing to walk towards, so the priority list falls through to hold.
    expect(c.step).not.toHaveBeenCalled();
  });

  /**
   * Home is measured on the same terms a body is, sight levels and all, so a
   * creature that minds its own storey reads a home one floor up as away.
   *
   * That is only the right answer because `step_toward` routes: standing under
   * your own burrow was somewhere to settle for as long as nothing could climb,
   * and a staircase is now a thing a creature walks. Making home the one
   * distance that ignored elevation would stop it at the bottom of the stairs.
   */
  it("counts a home on another floor as one to walk back to", () => {
    const brain = leashed(4);
    const memory = initialMemory(brain);
    const c = ctx({ home: { ...BURROW, z: 1 } });

    stepBrain(brain, memory, BRAIN_TICK_MS, c);

    expect(memory.state).toBe("homing");
    expect(c.step).toHaveBeenCalled();
  });

  it("cannot be swung at, and falls through rather than failing loudly", () => {
    const brain: BrainDef = {
      initial: "striking",
      states: {
        striking: {
          do: [{ action: "attack", of: HOME }, { action: "step_random" }],
        },
      },
      transitions: [],
    };
    const memory = initialMemory(brain);
    const c = ctx();

    stepBrain(brain, memory, BRAIN_TICK_MS, c);

    expect(c.attack).not.toHaveBeenCalled();
    expect(c.step).toHaveBeenCalled();
  });

  /** A bind naming nobody clears its slot, which is what home names. */
  it("writes nobody down when bound to a slot", () => {
    const brain: BrainDef = {
      initial: "idle",
      states: { idle: { do: [] }, next: { do: [] } },
      transitions: [
        {
          from: "idle",
          if: { cond: "after", ms: 0 },
          bind: { target: HOME },
          to: "next",
        },
      ],
    };
    const memory = initialMemory(brain);
    memory.blackboard.target = { kind: "body", id: "someone-else" };

    stepBrain(brain, memory, BRAIN_TICK_MS, ctx());

    expect(memory.blackboard.target).toBeUndefined();
  });
});

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
   * rather than for a brain. A pin is not a fix for that, only a place to stand:
   * it holds the *stream*, and a kit authored onto anything at all — the player's
   * armour, most recently — changes how many draws are taken before the rat
   * wanders, so re-pinning is the maintenance this constant exists to make
   * cheap. Any seed where neither animal drifts inward will do.
   *
   * The rule itself is proved by the neighbouring test: from seven both of them
   * close, on any dice at all.
   */
  const YARD_SEED = 20260821;

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
   * How long it takes to close a chase, which is the measurement the standing
   * walk order exists to move. @see GameSession.driveWalkOrder
   *
   * Counted in ticks rather than rounds, because the whole point is that a leg
   * no longer waits for a round. The gap is seven, which is the furthest either
   * of these notices you from, and arriving is standing beside somebody — so
   * what is being timed is six legs plus the round spent noticing.
   */
  function msToArrive(id: string): number {
    const session = yard([[id, 0, 0]], { x: SIGHT_CELLS, y: 0 });
    for (let elapsed = TICK_MS; elapsed < 5_000; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      if (gapToPlayer(session, id) <= 1) return elapsed;
    }
    return Infinity;
  }

  /**
   * A creature walks at the pace it was authored at, not at the brain's.
   *
   * The bat is the case worth pinning because it is the extreme one: authored
   * at 90ms a cell, it used to take a step and then stand still for the rest of
   * the round, so it crossed ground at 200ms — and the stutter was visible
   * before the arithmetic was.
   *
   * Bounded on both sides on purpose. The upper bound is the claim; the lower
   * one is what stops this passing for the wrong reason, because a creature
   * cannot beat six legs at its own quantised pace however the order is
   * pressed, and a number under that would mean somebody had made a step cost
   * less than a step.
   */
  it("closes at the pace it was authored at, not the brain's", () => {
    // Six legs at 200ms plus the round spent noticing: what every creature in
    // the world used to cost, whatever its tile said.
    const perRound = BRAIN_TICK_MS * 7;
    expect(msToArrive("bat")).toBeGreaterThan(BRAIN_TICK_MS * 3);
    expect(msToArrive("bat")).toBeLessThan(perRound * 0.7);
  });

  /**
   * And the same for a creature *slower* than a round, which is the half of
   * this that is easy to miss.
   *
   * A step waiting on a decision does not merely cap a fast body — it rounds
   * every body up to a whole number of rounds. The snake is authored at 320ms
   * and walked at 400, a quarter slower than anybody reading its tile would
   * believe, and nothing about that reads as a stutter to look at.
   */
  it("does not round a slow creature up to a whole round either", () => {
    const snake = msToArrive("snake");
    expect(snake).toBeLessThan(msToArrive("rat") * 2);
    // Two rounds a cell is what the rounding used to cost it.
    expect(snake).toBeLessThan(BRAIN_TICK_MS * 2 * 6);
  });

  /**
   * A pocket with walls on three sides and you in the mouth of it.
   *
   * The complaint this answers: rabbits and deer were easily cornered and gave
   * up. `step_away_from` scored the four neighbouring cells and took whichever
   * opened the distance most, so in here nothing qualified — the only way out
   * runs past you before it leads anywhere — and the animal stood still for as
   * long as you cared to look at it. Fourteen rounds of it, in this exact
   * board, without moving a cell.
   *
   * It now floods outward and runs to the best cell it can reach, which is
   * somewhere round the outside of the wall. @see ./pathfinding's `findRefuge`
   */
  it("leaves a pocket instead of giving up in it", () => {
    let map = emptyMap();
    for (let x = -14; x <= 14; x++) {
      for (let y = -14; y <= 14; y++) {
        map = replaceStack(map, x, y, 0, [{ tileId: "dirt" }]);
      }
    }
    for (const [x, y] of [[1, 0], [0, -1], [0, 1]] as const) {
      map = replaceStack(map, x, y, 0, [{ tileId: "dirt" }, { tileId: "stone-wall" }]);
    }
    map = replaceStack(map, 0, 0, 0, [{ tileId: "dirt" }, { tileId: "rabbit" }]);
    map = replaceStack(map, -3, 0, 0, [
      { tileId: "dirt" },
      { tileId: "player", direction: "e", owner: "alice" },
    ]);
    const session = new GameSession(map, authored, {
      actorIds: ["alice"],
      spawnAt: { x: 14, y: 14, z: 0, stackIndex: 1 },
      seed: YARD_SEED,
    });

    advance(session, BRAIN_TICK_MS * 8);

    const rabbit = bodies(session, "rabbit")[0]!;
    // Out of the pocket, and further from the person in its mouth than the
    // pocket could ever have put it.
    expect(rabbit.x).toBeGreaterThan(1);
    expect(Math.abs(rabbit.x - -3) + Math.abs(rabbit.y - 0)).toBeGreaterThan(3);
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
    //
    // **Loosened from 0.55 when a standing walk order let a rat take more than
    // one leg per round.** The release is a transition, so it is read once a
    // round; a rat that closes two cells in that round overshoots it by one and
    // the pack settles a little tighter — 0.47 of beats adjacent before, 0.57
    // after, against the 0.70 this whole state exists to have moved. Retuning
    // the release did not recover it: at three cells the pack got *worse*
    // (0.68), because releasing earlier only means re-acquiring sooner. The
    // bound below is the one doing the discriminating anyway, and it improved.
    expect(crowdedBeats / beats).toBeLessThan(0.62);
    // …and not locked in the diagonal chain that releasing at one cell left.
    // Three beats in four when the release was wrong, one in six before walk
    // orders and one in twelve since: a rat walking at its own pace spends less
    // of its life shuffling on the spot, which is the same fact as the line
    // above read from the other side.
    expect(lockedBeats / beats).toBeLessThan(0.4);
  });

  /**
   * The leash, and the one case it exists for.
   *
   * A creature is placed eleven cells from the cell its *name* says it was
   * authored on — which is exactly the shape a resumed world has, since the
   * checkpoint stores where a snake wandered to and its owner id is the only
   * thing left that remembers where it started. Adopting it here is the same
   * path a reload takes.
   *
   * Without a home the snake carries on diffusing from wherever it woke up,
   * which is the whole complaint: a random walk has no restoring force, so given
   * a long enough afternoon it is anywhere. With one it turns round.
   */
  it("walks back to the cell it was authored on, not the one it woke in", () => {
    const STRAYED_TO = 11;
    let map = emptyMap();
    for (let x = -12; x <= 12; x++) {
      for (let y = -12; y <= 12; y++) {
        map = replaceStack(map, x, y, 0, [{ tileId: "dirt" }]);
      }
    }
    // The name a first load would have minted from the authored cell, on a body
    // standing a long way from it. @see residentOwnerId
    map = replaceStack(map, STRAYED_TO, 0, 0, [
      { tileId: "dirt" },
      { tileId: "snake", owner: "npc:0,0,0,1" },
    ]);
    map = replaceStack(map, OFF_IN_THE_CORNER.x, OFF_IN_THE_CORNER.y, 0, [
      { tileId: "dirt" },
      { tileId: "player", direction: "e", owner: "alice" },
    ]);
    const session = new GameSession(map, authored, {
      actorIds: ["alice"],
      spawnAt: { x: 12, y: 12, z: 0, stackIndex: 1 },
      seed: YARD_SEED,
    });

    advance(session, BRAIN_TICK_MS * 8);

    expect(bodies(session, "snake")[0]!.x).toBeLessThan(STRAYED_TO);
  });

  /**
   * The walk home is a *route*, and this is what that buys.
   *
   * A wall stands between the snake and its burrow with one gap in it, several
   * cells off the straight line. The greedy step this used to be would have
   * pressed the snake flat against the near side of the wall and held it there
   * — closing the plan distance is exactly what walking into a wall does — so
   * the leash would have worked only in the open. @see ./pathfinding
   */
  it("walks round a wall to get home", () => {
    const STRAYED_TO = 11;
    const WALL_X = 5;
    const GAP_Y = 4;
    let map = emptyMap();
    for (let x = -12; x <= 12; x++) {
      for (let y = -12; y <= 12; y++) {
        map = replaceStack(map, x, y, 0, [{ tileId: "dirt" }]);
      }
    }
    for (let y = -12; y <= 12; y++) {
      if (y === GAP_Y) continue;
      map = replaceStack(map, WALL_X, y, 0, [
        { tileId: "dirt" },
        { tileId: "stone-wall" },
      ]);
    }
    map = replaceStack(map, STRAYED_TO, 0, 0, [
      { tileId: "dirt" },
      { tileId: "snake", owner: "npc:0,0,0,1" },
    ]);
    map = replaceStack(map, OFF_IN_THE_CORNER.x, OFF_IN_THE_CORNER.y, 0, [
      { tileId: "dirt" },
      { tileId: "player", direction: "e", owner: "alice" },
    ]);
    const session = new GameSession(map, authored, {
      actorIds: ["alice"],
      spawnAt: { x: 12, y: 12, z: 0, stackIndex: 1 },
      seed: YARD_SEED,
    });

    advance(session, BRAIN_TICK_MS * 24);

    // Through the gap and out the far side, rather than stalled against the
    // wall at x = 6 with the plan distance dutifully closed.
    expect(bodies(session, "snake")[0]!.x).toBeLessThan(WALL_X);
  });

  /**
   * And it stops, rather than homing forever: the band between the ten cells
   * that pull it back and the two that let it go is what keeps a settled
   * creature wandering instead of twitching on its own doorstep.
   */
  it("goes back to wandering once it is home again", () => {
    const session = yard([["snake", 0, 0]]);

    advance(session, BRAIN_TICK_MS * 20);

    const snake = bodies(session, "snake")[0]!;
    expect(Math.abs(snake.x) + Math.abs(snake.y)).toBeLessThanOrEqual(10);
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
 * Who gets a turn each round.
 *
 * A creature somebody could notice thinks every round; everybody else shares
 * {@link BRAIN_DOZE_BUDGET} turns between them. The creatures here make a
 * noise every time they are given a turn, so the noise log is the turn log —
 * a noise is the one thing a brain does that no other creature's step can
 * interfere with, which a count of cells walked cannot say.
 */
const TURN_NOISE = "tick";

/** A brain that makes a noise on every turn it is given. */
function tickerBrain(afterMs = 1): BrainDef {
  return {
    initial: "start",
    states: {
      start: { do: [{ action: "hold" }] },
      a: { onEnter: [{ effect: "noise", text: TURN_NOISE }], do: [{ action: "hold" }] },
      b: { onEnter: [{ effect: "noise", text: TURN_NOISE }], do: [{ action: "hold" }] },
    },
    transitions: [
      { from: "start", if: { cond: "after", ms: afterMs }, to: "a" },
      { from: "a", if: { cond: "after", ms: 1 }, to: "b" },
      { from: "b", if: { cond: "after", ms: 1 }, to: "a" },
    ],
  };
}

/** How far the far-sighted ticker's brain looks — well past the floor. */
const FAR_SIGHT_CELLS = 60;

/** How long the slow ticker waits before its first turn counts. */
const SLOW_START_MS = 1000;

const attention: TileDef[] = [
  ...tiles,
  tile({
    id: "ticker",
    height: 2,
    actor: true,
    affectedByGravity: true,
    walkable: false,
    interactions: { brain: tickerBrain() },
  }),
  tile({
    id: "ticker-far-sighted",
    height: 2,
    actor: true,
    affectedByGravity: true,
    walkable: false,
    interactions: {
      brain: {
        ...tickerBrain(),
        transitions: [
          // Reaches further than anything else here, and never holds: the
          // creature is only ever placed nearer than this.
          {
            from: "a",
            if: { cond: "out_of_range", of: nearest("player"), cells: FAR_SIGHT_CELLS },
            to: "a",
          },
          ...tickerBrain().transitions,
        ],
      },
    },
  }),
  tile({
    id: "ticker-walker",
    height: 2,
    actor: true,
    affectedByGravity: true,
    walkable: false,
    // Faster than a round on purpose: a body that walks slower than it decides
    // cannot show the difference a standing order makes, because its next leg
    // was never the thing it was waiting on.
    walkDurationMs: 100,
    interactions: {
      brain: {
        initial: "homing",
        states: {
          homing: { do: [{ action: "step_toward", of: { type: "home" } }] },
        },
        transitions: [],
      },
    },
  }),
  tile({
    id: "ticker-quitter",
    height: 2,
    actor: true,
    affectedByGravity: true,
    walkable: false,
    walkDurationMs: 100,
    interactions: {
      brain: {
        initial: "homing",
        states: {
          homing: { do: [{ action: "step_toward", of: { type: "home" } }] },
          parked: { do: [{ action: "hold" }] },
        },
        // A round of walking before it gives up — transitions are read at the
        // top of a turn, so a single round would park it before any action of
        // its had run — and the rest of the run is aftermath.
        transitions: [
          {
            from: "homing",
            if: { cond: "after", ms: BRAIN_TICK_MS * 2 },
            to: "parked",
          },
        ],
      },
    },
  }),
  tile({
    id: "ticker-slow",
    height: 2,
    actor: true,
    affectedByGravity: true,
    walkable: false,
    interactions: { brain: tickerBrain(SLOW_START_MS) },
  }),
];

/** Half-width of the field the attention tests stand on. */
const ATTENTION_FIELD = 45;

/** A row of creatures along `y`, one every cell from `x0`. */
function withRow(map: MapFile, tileId: string, y: number, x0: number, count: number): MapFile {
  for (let i = 0; i < count; i++) {
    map = withDeer(map, x0 + i, y, tileId);
  }
  return map;
}

/** Noises this round, as turns per creature cell. */
function turnsByCell(session: GameSession, into: Map<string, number>) {
  for (const noise of session.drainNoise()) {
    if (noise.text !== TURN_NOISE) continue;
    const key = `${noise.x},${noise.y}`;
    into.set(key, (into.get(key) ?? 0) + 1);
  }
}

/** Run `rounds` brain rounds, counting turns per creature. */
function turnsOver(session: GameSession, rounds: number): Map<string, number> {
  const turns = new Map<string, number>();
  for (let round = 0; round < rounds; round++) {
    advance(session, BRAIN_TICK_MS);
    turnsByCell(session, turns);
  }
  return turns;
}

describe("who gets a turn", () => {
  const ROUNDS = 6;
  /** Far from the player at the field's corner, whichever way it is measured. */
  const FAR_ROW_Y = 10;
  const FAR_ROW_X0 = -30;

  it("shares the budget between creatures nobody is near", () => {
    const count = BRAIN_DOZE_BUDGET * 3;
    const session = new GameSession(
      withRow(field(ATTENTION_FIELD), "ticker", FAR_ROW_Y, FAR_ROW_X0, count),
      attention,
      { actorIds: ["alice"] },
    );

    const turns = turnsOver(session, ROUNDS);

    expect(turns.size).toBe(count);
    for (const [, taken] of turns) expect(taken).toBe(ROUNDS / 3);
  });

  it("spends exactly the budget on them each round", () => {
    const session = new GameSession(
      withRow(field(ATTENTION_FIELD), "ticker", FAR_ROW_Y, FAR_ROW_X0, BRAIN_DOZE_BUDGET * 3),
      attention,
      { actorIds: ["alice"] },
    );

    for (let round = 0; round < ROUNDS; round++) {
      const turns = new Map<string, number>();
      advance(session, BRAIN_TICK_MS);
      turnsByCell(session, turns);
      expect([...turns.values()].reduce((sum, n) => sum + n, 0)).toBe(BRAIN_DOZE_BUDGET);
    }
  });

  it("gives every turn to a creature within a screen of somebody", () => {
    let map = withRow(field(ATTENTION_FIELD), "ticker", FAR_ROW_Y, FAR_ROW_X0, BRAIN_DOZE_BUDGET * 3);
    const near = { x: -ATTENTION_FIELD + BRAIN_ATTENTION_FLOOR_CELLS, y: -ATTENTION_FIELD };
    map = withDeer(map, near.x, near.y, "ticker");
    const session = new GameSession(map, attention, { actorIds: ["alice"] });

    const turns = turnsOver(session, ROUNDS);

    expect(turns.get(`${near.x},${near.y}`)).toBe(ROUNDS);
  });

  it("reaches as far as the creature's own brain looks", () => {
    const apart = FAR_SIGHT_CELLS - 10;
    let map = withRow(field(ATTENTION_FIELD), "ticker", FAR_ROW_Y, FAR_ROW_X0, BRAIN_DOZE_BUDGET * 3);
    const farSighted = { x: -ATTENTION_FIELD + apart, y: -ATTENTION_FIELD };
    const shortSighted = { x: -ATTENTION_FIELD + apart, y: -ATTENTION_FIELD + 2 };
    map = withDeer(map, farSighted.x, farSighted.y, "ticker-far-sighted");
    map = withDeer(map, shortSighted.x, shortSighted.y, "ticker");
    const session = new GameSession(map, attention, { actorIds: ["alice"] });

    const turns = turnsOver(session, ROUNDS);

    expect(turns.get(`${farSighted.x},${farSighted.y}`)).toBe(ROUNDS);
    expect(turns.get(`${shortSighted.x},${shortSighted.y}`)).toBeLessThan(ROUNDS);
  });

  /**
   * An order stops when the state that gave it does.
   *
   * The one thing a decision that outlives its round has to promise. A standing
   * order is pressed by the motion loop and nothing in that loop knows what the
   * creature is thinking, so an order left behind by a state the creature has
   * transitioned out of would be walked out in full — a body carrying on to
   * somewhere it decided against, at its own pace, with no way to notice.
   *
   * Which is why the order is dropped at the top of every turn rather than
   * cleared by whoever is done with it: it lives one round, and a state that
   * still wants it asks again. This creature walks home until a transition
   * takes it somewhere that does not, and everything after that is aftermath.
   * @see GameSession.tickOneBrain
   */
  it("stops when the state that gave the order does", () => {
    // Near enough the player to be attentive, so its order really is being
    // pressed at the tick rate — the case where a leak would show — and far
    // enough from home that giving up leaves most of the route unwalked.
    const START = { x: -ATTENTION_FIELD + 5, y: -ATTENTION_FIELD };
    const HOME = { x: START.x, y: START.y + 8 };
    let map = field(ATTENTION_FIELD);
    map = replaceStack(map, START.x, START.y, 0, [
      { tileId: "grass" },
      { tileId: "ticker-quitter", owner: `npc:${HOME.x},${HOME.y},0,1` },
    ]);
    const session = new GameSession(map, attention, { actorIds: ["alice"] });

    const cell = () => {
      const quitter = session
        .actorSnapshots()
        .find((actor) => actor.tileId === "ticker-quitter")!;
      return `${quitter.x},${quitter.y}`;
    };

    const started = cell();
    // A round past the transition, not at it: a leg already in flight lands
    // wherever it was going, here as everywhere else in the simulation. What
    // must not happen is a *further* leg being pressed after it.
    advance(session, BRAIN_TICK_MS * 3);
    const whenItGaveUp = cell();
    advance(session, BRAIN_TICK_MS * 6);

    // It did set off…
    expect(whenItGaveUp).not.toBe(started);
    // …and it has not taken a step since the transition, though its own pace
    // would have walked the rest of the way home twice over.
    expect(cell()).toBe(whenItGaveUp);
  });

  /**
   * A dozing creature walks at the budget's pace, not at its own.
   *
   * The companion decision to `BRAIN_TICK_MS`'s, and the one a standing walk
   * order could quietly undo. An order is pressed every tick the body comes
   * free — that is the whole point of it — so a creature nobody is near, given
   * somewhere to be and left to press its own legs, would walk at its authored
   * pace between the turns the budget hands it. That puts the size of the map
   * straight back into what a round costs, which is what
   * {@link BRAIN_DOZE_BUDGET} exists to keep out of it.
   *
   * One creature rather than a crowd, and that is enough: what is being tested
   * is the gate, not the sharing. It is far enough from the only person here to
   * doze, and being the only one dozing it is handed a turn every round — so
   * one step per round is the budget's pace, and anything above it is the order
   * pressing legs nobody gave it. @see ActorRuntime.brainAttentive
   */
  it("walks a dozing creature at the budget's pace, not its own", () => {
    const HOME = { x: 0, y: FAR_ROW_Y - 20 };
    let map = field(ATTENTION_FIELD);
    // The name a first load would have minted from the cell it wants to get
    // back to, on a body standing twenty cells from it. @see residentOwnerId
    map = replaceStack(map, 0, FAR_ROW_Y, 0, [
      { tileId: "grass" },
      { tileId: "ticker-walker", owner: `npc:${HOME.x},${HOME.y},0,1` },
    ]);
    const session = new GameSession(map, attention, { actorIds: ["alice"] });

    const walkerCell = () => {
      const walker = session
        .actorSnapshots()
        .find((actor) => actor.tileId === "ticker-walker")!;
      return `${walker.x},${walker.y}`;
    };

    let steps = 0;
    let before = walkerCell();
    for (let round = 0; round < ROUNDS; round++) {
      for (let elapsed = 0; elapsed < BRAIN_TICK_MS; elapsed += TICK_MS) {
        session.tick(TICK_MS);
        const now = walkerCell();
        if (now !== before) steps++;
        before = now;
      }
    }

    // It is walking — the route home is twenty cells and it is taking it…
    expect(steps).toBeGreaterThan(0);
    // …and never faster than the turns it was given, though its own tile says
    // it could walk twice that.
    expect(steps).toBeLessThanOrEqual(ROUNDS);
  });

  it("hands a dozing creature the time it slept through", () => {
    // Two creatures per turn, so each is passed over every other round. A
    // wait of a second is five rounds of wall time; counted only on the
    // rounds it was given, it would be ten.
    const count = BRAIN_DOZE_BUDGET * 2;
    const session = new GameSession(
      withRow(field(ATTENTION_FIELD), "ticker-slow", FAR_ROW_Y, FAR_ROW_X0, count),
      attention,
      { actorIds: ["alice"] },
    );
    const rounds = SLOW_START_MS / BRAIN_TICK_MS + 2;

    const turns = turnsOver(session, rounds);

    expect(turns.size).toBe(count);
  });
});

describe("how far a brain looks", () => {
  it("is the furthest cells any of its conditions asks about", () => {
    expect(brainReach(followBrain())).toBe(NOTICE_CELLS);
  });

  it("is nothing for a brain that never measures", () => {
    expect(brainReach(wanderingBrain())).toBe(0);
  });

  it("looks inside grouped conditions", () => {
    const brain: BrainDef = {
      ...wanderingBrain(),
      transitions: [
        {
          from: "idle",
          if: group<BrainConditionDef>("and", [
            { cond: "after", ms: 1 },
            group("or", [{ cond: "in_range", of: nearest("player"), cells: 40 }]),
          ]),
          to: "wander",
        },
      ],
    };
    expect(brainReach(brain)).toBe(40);
  });
});

/**
 * A creature that works the world rather than only reacting to it.
 *
 * Three new pieces meeting, and the whole point is that they are the *same*
 * pieces a player uses: a selector that names a placement, the pull a player
 * makes out of it, and the eating a player does afterwards. What is under test
 * here is the joining, so the fixtures are as small as a bush and a berry get.
 */
describe("browsing a bush", () => {
  const BUSH_CELLS = 6;
  /** Short, so a pull lands in a few brain ticks rather than a minute. */
  const PULL_MS = BRAIN_TICK_MS * 8;

  /**
   * Walk to the bush, pick it, eat what came out.
   *
   * Read as three priority lines rather than three states on purpose: `extract`
   * fails until the creature is standing beside the thing, which is exactly what
   * lets the line under it do the walking.
   */
  function browserBrain(): BrainDef {
    return {
      initial: "graze",
      states: {
        graze: { do: [{ action: "step_random" }, { action: "hold" }] },
        browsing: {
          do: [
            { action: "extract", of: slot("bush") },
            { action: "step_toward", of: slot("bush") },
            { action: "hold" },
          ],
        },
        chewing: {
          do: [{ action: "consume", tileId: "berry" }, { action: "hold" }],
        },
      },
      transitions: [
        {
          from: "browsing",
          if: { cond: "carrying", tileId: "berry" },
          to: "chewing",
        },
        {
          from: "chewing",
          if: group<BrainConditionDef>("and", [
            { cond: "carrying", tileId: "berry" },
          ], true),
          to: "graze",
        },
        {
          from: "graze",
          if: { cond: "in_los", of: thing("bush"), cells: BUSH_CELLS },
          bind: { bush: thing("bush") },
          to: "browsing",
        },
        {
          from: "browsing",
          if: { cond: "out_of_los", of: slot("bush"), cells: BUSH_CELLS },
          to: "graze",
        },
      ],
    };
  }

  const browsers: TileDef[] = [
    ...tiles,
    tile({
      id: "berry",
      height: 0,
      kind: "item",
      intangible: true,
      interactions: { item: { type: "consumable", label: "Eat", hp: 1 } },
    }),
    tile({
      id: "pouch",
      height: 0,
      kind: "item",
      intangible: true,
      interactions: { item: { type: "container", size: 4, equippable: true } },
    }),
    tile({ id: "picked-bush", height: 2, walkable: false }),
    tile({
      id: "bush",
      height: 2,
      walkable: false,
      interactions: {
        extract: {
          actionName: "Pick",
          durability: 1,
          tileId: "picked-bush",
          durationMs: PULL_MS,
          slots: [{ tileId: "berry", chance: 100 }],
        },
      },
    }),
    tile({
      id: "browser",
      height: 2,
      kind: "battler",
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: {
        brain: browserBrain(),
        battler: {
          baseHp: 8,
          masteries: { toughness: 8 },
          naturalWeapon: {
            type: "weapon",
            damage: 0,
            def: 0,
            accuracy: 50,
            variance: 50,
            spd: 20,
            mastery: "fist",
          },
          kit: [{ slot: "bag", tileId: "pouch", chance: 100 }],
        },
      },
    }),
  ];

  /** A browser at the origin, a bush three cells east, a player far away. */
  function hedge(bodyTileId = "browser"): GameSession {
    let map = field(6);
    map = replaceStack(map, -6, -6, 0, [{ tileId: "grass" }]);
    map = withDeer(map, 0, 0, bodyTileId);
    map = replaceStack(map, 3, 0, 0, [{ tileId: "grass" }, { tileId: "bush" }]);
    // Close enough to keep the creature awake — brains only think while
    // somebody could notice them — and far enough to be no part of the story.
    map = withPlayerAt(map, 0, 6);
    return new GameSession(map, browsers, {
      actorIds: ["alice"],
      spawnAt: { x: -6, y: -6, z: 0, stackIndex: 1 },
    });
  }

  function tilesAt(session: GameSession, x: number, y: number): string[] {
    return getStack(session.getMap(), x, y, 0).map((placed) => placed.tileId);
  }

  it("walks to a bush it can see, picks it, and eats what came out", () => {
    const session = hedge();

    advance(session, BRAIN_TICK_MS * 20);

    // The bush is spent and has become what its author named.
    expect(tilesAt(session, 3, 0)).toEqual(["grass", "picked-bush"]);
    // And the berry is neither in the bag nor on the floor, because it was
    // eaten — which is the whole of what `consume` was for.
    expect(tilesAt(session, 2, 0)).toEqual(["grass"]);
  });

  it("holds the line it is picking on rather than wandering off mid-pull", () => {
    const session = hedge();

    // Long enough to arrive and start the pull, well short of finishing it.
    advance(session, BRAIN_TICK_MS * 4);
    const standing = deerCell(session);
    expect(standing).toBe("2,0");

    advance(session, PULL_MS / 2);

    // Still there — and it is the pull holding it, since the line under
    // `extract` is one that would have walked it away.
    expect(deerCell(session)).toBe(standing);
  });
});

/**
 * The two ways a selector can name a place, and what expires them.
 *
 * A `thing` is the one selector that answers about the board rather than about
 * the actor list, so the cases worth pinning are the edges where it and a body
 * differ: what a verb wanting a pulse does with it, and what happens when the
 * tile it named stops being that tile.
 */
describe("naming a thing", () => {
  const BUSH_AT = { x: 2, y: 0, z: 0 };

  function ctx(overrides: Partial<Parameters<typeof stepBrain>[3]> = {}) {
    const built = {
      busy: false,
      rng: new Rng(1),
      self: { x: 0, y: 0, z: 0 },
      home: null,
      nearestOnTile: () => null,
      nearestThing: (tileIds: readonly string[]) =>
        tileIds.includes("bush") ? { at: BUSH_AT, tileId: "bush" } : null,
      thingStillThere: () => true,
      positionOf: () => null,
      wouldDrop: () => false,
      walkTo: (): WalkOrderState => "walking",
      fleeFrom: (): WalkOrderState => "walking",
      step: () => true,
      say: vi.fn(),
      noise: vi.fn(),
      canSee: () => true,
      sight: { up: 0, down: 0 },
      heard: () => [],
      heardNoise: () => [],
      talking: () => false,
      hurtBy: () => [],
      attack: vi.fn(() => false),
      extract: vi.fn(() => true),
      consume: vi.fn(() => false),
      consumeOn: vi.fn(() => false),
      carrying: () => false,
      hasStatus: () => false,
      nameOf: (id: string) => id,
      ...overrides,
    } satisfies Parameters<typeof stepBrain>[3];
    return built;
  }

  /** Bind the bush on the way in, then run one action against the slot. */
  function bindingBrain(action: BrainActionDef): BrainDef {
    return {
      initial: "idle",
      states: { idle: { do: [] }, working: { do: [action] } },
      transitions: [
        {
          from: "idle",
          if: { cond: "in_range", of: thing("bush"), cells: 4 },
          bind: { bush: thing("bush") },
          to: "working",
        },
      ],
    };
  }

  it("writes a cell and a tile into the slot, not an actor id", () => {
    const brain = bindingBrain({ action: "hold" });
    const memory = initialMemory(brain);

    stepBrain(brain, memory, BRAIN_TICK_MS, ctx());

    expect(memory.blackboard.bush).toEqual({
      kind: "thing",
      at: BUSH_AT,
      tileId: "bush",
    });
  });

  it("works the thing in the slot", () => {
    const brain = bindingBrain({ action: "extract", of: slot("bush") });
    const memory = initialMemory(brain);
    const c = ctx();

    stepBrain(brain, memory, BRAIN_TICK_MS, c);

    expect(c.extract).toHaveBeenCalledWith(BUSH_AT, "bush");
  });

  // The mirror of `attack` refusing a thing: neither verb quietly does the
  // other's job when the selector is the wrong kind.
  it("refuses to work a body, and to swing at a thing", () => {
    const swinging = bindingBrain({ action: "attack", of: slot("bush") });
    const swung = initialMemory(swinging);
    const swingCtx = ctx();
    stepBrain(swinging, swung, BRAIN_TICK_MS, swingCtx);
    expect(swingCtx.attack).not.toHaveBeenCalled();

    const working = bindingBrain({ action: "extract", of: nearest("player") });
    const worked = initialMemory(working);
    const workCtx = ctx({ nearestOnTile: () => "alice" });
    stepBrain(working, worked, BRAIN_TICK_MS, workCtx);
    expect(workCtx.extract).not.toHaveBeenCalled();
  });

  /**
   * The whole reason a bound thing is a cell *and* a tile. A bush that has been
   * picked bare is a different tile in the same cell, and the commitment to it
   * has to end by itself — with nothing authored to notice.
   */
  it("loses a thing whose tile has changed under it", () => {
    const brain: BrainDef = {
      ...bindingBrain({ action: "hold" }),
      transitions: [
        ...bindingBrain({ action: "hold" }).transitions,
        {
          from: "working",
          if: { cond: "out_of_range", of: slot("bush"), cells: 8 },
          to: "idle",
        },
      ],
    };
    const memory = initialMemory(brain);

    stepBrain(brain, memory, BRAIN_TICK_MS, ctx());
    expect(memory.state).toBe("working");

    // Picked: the cell still exists, and what is standing in it does not.
    stepBrain(brain, memory, BRAIN_TICK_MS, ctx({ thingStillThere: () => false }));
    expect(memory.state).toBe("idle");
  });

  it("is bounded by how far the brain looks", () => {
    expect(brainReach(bindingBrain({ action: "hold" }))).toBe(4);
  });
});

describe("what a slot turns out to hold", () => {
  function bindingFrom(...sources: Selector[]): BrainDef {
    return {
      initial: "idle",
      states: { idle: { do: [] } },
      transitions: sources.map((of) => ({
        from: "idle",
        if: { cond: "stuck" } as BrainCondition,
        bind: { quarry: of },
        to: "idle",
      })),
    };
  }

  it("is the tiles every transition binding it agrees on", () => {
    expect(slotTiles(bindingFrom(thing("bush")), "quarry")).toEqual(["bush"]);
    expect(
      slotTiles(bindingFrom(nearest("deer", "rabbit"), nearest("deer", "rabbit")), "quarry"),
    ).toEqual(["deer", "rabbit"]);
  });

  // Agreement is about the *set*: the order inside a list means nothing, so two
  // rows naming the same prey either way round are one answer rather than none.
  it("ignores the order inside a list", () => {
    expect(
      slotTiles(bindingFrom(nearest("deer", "rabbit"), nearest("rabbit", "deer")), "quarry"),
    ).toHaveLength(2);
    expect(
      slotTiles(bindingFrom(nearest("deer", "rabbit"), nearest("rabbit", "wolf")), "quarry"),
    ).toEqual([]);
  });

  it("is nothing when they disagree, or when one names no tile", () => {
    expect(slotTiles(bindingFrom(thing("bush"), nearest("wolf")), "quarry"))
      .toEqual([]);
    expect(slotTiles(bindingFrom(SPEAKER_SELECTOR), "quarry")).toEqual([]);
  });

  it("is nothing for a name no transition binds", () => {
    expect(slotTiles(bindingFrom(thing("bush")), "nobody")).toEqual([]);
  });
});

/**
 * Hunger, and eating what is lying there.
 *
 * Two additions that only make sense together: a wolf goes for a carcass because
 * it is hungry, and "hungry" is not a status anything grants — it is the absence
 * of enough `fed`. So the condition is a floor and the `not` of it is what an
 * author writes.
 */
describe("asking what a body is under", () => {
  function ctx(overrides: Partial<Parameters<typeof stepBrain>[3]> = {}) {
    const built = {
      busy: false,
      rng: new Rng(1),
      self: { x: 0, y: 0, z: 0 },
      home: null,
      nearestOnTile: () => null,
      nearestThing: () => null,
      thingStillThere: () => true,
      positionOf: () => null,
      wouldDrop: () => false,
      walkTo: (): WalkOrderState => "walking",
      fleeFrom: (): WalkOrderState => "walking",
      step: () => true,
      say: vi.fn(),
      noise: vi.fn(),
      canSee: () => true,
      sight: { up: 0, down: 0 },
      heard: () => [],
      heardNoise: () => [],
      talking: () => false,
      hurtBy: () => [],
      attack: vi.fn(() => false),
      extract: vi.fn(() => false),
      consume: vi.fn(() => false),
      consumeOn: vi.fn(() => true),
      carrying: () => false,
      hasStatus: vi.fn(() => false),
      nameOf: (id: string) => id,
      ...overrides,
    } satisfies Parameters<typeof stepBrain>[3];
    return built;
  }

  /** Goes to `alert` when `condition` holds. */
  function watching(condition: BrainCondition): BrainDef {
    return {
      initial: "idle",
      states: { idle: { do: [] }, alert: { do: [] } },
      transitions: [{ from: "idle", if: condition, to: "alert" }],
    };
  }

  function ran(brain: BrainDef, c: Parameters<typeof stepBrain>[3]): string {
    const memory = initialMemory(brain);
    stepBrain(brain, memory, BRAIN_TICK_MS, c);
    return memory.state;
  }

  const SATED_MS = 120_000;

  it("asks the body, passing the id and the floor through", () => {
    const c = ctx();
    ran(watching({ cond: "status", id: "fed", atLeastMs: SATED_MS }), c);
    expect(c.hasStatus).toHaveBeenCalledWith("fed", SATED_MS);
  });

  it("asks only whether it is running when no floor is given", () => {
    const c = ctx();
    ran(watching({ cond: "status", id: "poison" }), c);
    expect(c.hasStatus).toHaveBeenCalledWith("poison", undefined);
  });

  /**
   * The three cases hunger has to read correctly, and the reason the condition
   * is a floor with a `not` over it rather than a ceiling: a body that has never
   * eaten is the one a ceiling gets wrong.
   */
  it("reads hunger as the absence of enough fed", () => {
    const hungry = watching(
      group<BrainConditionDef>(
        "and",
        [{ cond: "status", id: "fed", atLeastMs: SATED_MS }],
        true,
      ),
    );

    // Never eaten, and a meal that has nearly worn off: both hungry.
    expect(ran(hungry, ctx({ hasStatus: () => false }))).toBe("alert");
    // Just eaten: not.
    expect(ran(hungry, ctx({ hasStatus: () => true }))).toBe("idle");
  });

  it("eats what is lying there when the line names a thing", () => {
    const brain: BrainDef = {
      initial: "eating",
      states: { eating: { do: [{ action: "consume", of: thing("raw-meat") }] } },
      transitions: [],
    };
    const c = ctx({
      nearestThing: () => ({ at: { x: 1, y: 0, z: 0 }, tileId: "raw-meat" }),
    });

    stepBrain(brain, initialMemory(brain), BRAIN_TICK_MS, c);

    expect(c.consumeOn).toHaveBeenCalledWith({ x: 1, y: 0, z: 0 }, "raw-meat");
    // And not out of the bag, which is the other thing this verb does.
    expect(c.consume).not.toHaveBeenCalled();
  });

  it("goes to the bag when the line names nothing", () => {
    const brain: BrainDef = {
      initial: "eating",
      states: { eating: { do: [{ action: "consume", tileId: "berry" }] } },
      transitions: [],
    };
    const c = ctx();

    stepBrain(brain, initialMemory(brain), BRAIN_TICK_MS, c);

    expect(c.consume).toHaveBeenCalledWith("berry");
    expect(c.consumeOn).not.toHaveBeenCalled();
  });

  // A body is not a meal, on the terms it is not a resource.
  it("refuses to eat somebody", () => {
    const brain: BrainDef = {
      initial: "eating",
      states: {
        eating: { do: [{ action: "consume", of: nearest("player") }] },
      },
      transitions: [],
    };
    const c = ctx({ nearestOnTile: () => "alice" });

    stepBrain(brain, initialMemory(brain), BRAIN_TICK_MS, c);

    expect(c.consumeOn).not.toHaveBeenCalled();
    expect(c.consume).not.toHaveBeenCalled();
  });
});
