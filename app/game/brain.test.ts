import { describe, expect, it, vi } from "vitest";
import { resolveBrain, type BrainDef } from "../lib/brain";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { initialMemory, stepBrain } from "./brainRuntime";
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
      nearestPlayerId: () => null,
      positionOf: () => null,
      wouldDrop: () => false,
      step: vi.fn(() => true),
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
    const session = new GameSession(withDeer(field(4), 0, 0), tiles, ["alice"]);
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
    const session = new GameSession(withDeer(field(4), 0, 0), tiles, ["alice"]);

    // One brain tick short of the transition, however many sim ticks that is.
    advance(session, IDLE_MS - BRAIN_TICK_MS);

    expect(deerCell(session)).toBe("0,0");
  });

  it("walks the same path twice from the same seed", () => {
    const path = (seed: number) => {
      const session = new GameSession(
        withDeer(field(4), 0, 0),
        tiles,
        ["alice"],
        undefined,
        seed,
      );
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
    const session = new GameSession(
      withDeer(field(4), 0, 0, "deer-holding"),
      tiles,
      ["alice"],
    );

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
    const session = new GameSession(withDeer(map, 0, 0), tiles, ["alice"]);

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
        do: [{ action: "step_toward", of: "$friend" }, { action: "hold" }],
      },
    },
    transitions: [
      {
        from: "idle",
        if: { cond: "in_range", of: "nearest_player", cells: NOTICE_CELLS },
        bind: { friend: "nearest_player" },
        to: "follow",
      },
      {
        from: "follow",
        if: { cond: "out_of_range", of: "$friend", cells: NOTICE_CELLS },
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
              { action: "step_away_from", of: "$friend" },
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
    return new GameSession(map, noticing, ["alice"], {
      x: -9,
      y: -9,
      z: 0,
      stackIndex: 1,
    });
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

  it("keeps chasing the one that set it off, not whoever is nearest now", () => {
    let map = field(9);
    map = replaceStack(map, -9, -9, 0, [{ tileId: "grass" }]);
    map = withDeer(map, 0, 0, "cat");
    map = withPlayerAt(map, NOTICE_CELLS, 0);
    const session = new GameSession(map, noticing, ["alice"], {
      x: -9,
      y: -9,
      z: 0,
      stackIndex: 1,
    });

    advance(session, BRAIN_TICK_MS);
    // A second person arrives, closer than the first.
    session.spawn("bob", { x: 0, y: 1, z: 0 });
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
    return new GameSession(withDeer(map, 0, 0, "trapped"), cornerable, [
      "alice",
    ]);
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
      nearestPlayerId: () => null,
      positionOf: () => null,
      wouldDrop: () => false,
      step: () => false,
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
    const session = new GameSession(
      withDeer(field(4), 0, 0, "deer"),
      cornerable,
      ["alice"],
    );

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
    return new GameSession(map, ledgeDwellers, ["alice"]);
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
    const session = new GameSession(
      withDeer(field(9), 0, 0, creature),
      paced,
      ["alice"],
      undefined,
      11,
    );
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
    const session = new GameSession(
      withDeer(field(9), 0, 0, "plodder"),
      paced,
      ["alice"],
    );
    advance(session, BRAIN_TICK_MS);

    const walk = session
      .actorSnapshots()
      .find((a) => a.tileId === "plodder")!.walk;
    expect(walk?.durationMs).toBe(WALK_DURATION_MS * 2);
  });

  it("leaves a body that authored no pace walking like a player", () => {
    const session = new GameSession(
      withDeer(field(9), 0, 0, "deer"),
      paced,
      ["alice"],
    );
    advance(session, IDLE_MS + BRAIN_TICK_MS);

    const walk = session.actorSnapshots().find((a) => a.tileId === "deer")!.walk;
    expect(walk?.durationMs).toBe(WALK_DURATION_MS);
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
    const first = new GameSession(withDeer(field(4), 0, 0), tiles, ["alice"]);
    advance(first, IDLE_MS * 2);
    const wandered = deerCell(first);
    expect(wandered).not.toBe("0,0");

    const resumed = new GameSession(
      first.getMap(),
      tiles,
      ["alice"],
      first.getSpawnPoint(),
      first.getSeed(),
    );

    // Where it left off, but back at the top of its machine — so it waits out a
    // fresh idle rather than carrying on mid-wander.
    expect(deerCell(resumed)).toBe(wandered);
    advance(resumed, IDLE_MS - BRAIN_TICK_MS);
    expect(deerCell(resumed)).toBe(wandered);
  });

  it("carries the dice on, rather than replaying the same wander", () => {
    const first = new GameSession(withDeer(field(4), 0, 0), tiles, ["alice"], undefined, 5);
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
    const session = new GameSession(withDeer(field(4), 0, 0), tiles, ["alice"]);

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
    const session = new GameSession(withDeer(field(4), 0, 0), inert, ["alice"]);

    advance(session, BRAIN_TICK_MS * 4);

    expect(session.isAtRest()).toBe(true);
  });
});

describe("a world nobody is watching", () => {
  it("does not think while nobody is connected", () => {
    const session = new GameSession(withDeer(field(4), 0, 0), tiles, []);

    advance(session, IDLE_MS * 10);

    expect(deerCell(session)).toBe("0,0");
    expect(session.isAtRest()).toBe(true);
  });

  it("picks up thinking when somebody arrives", () => {
    const session = new GameSession(withDeer(field(4), 0, 0), tiles, []);
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
    const session = new GameSession(withDeer(field(4), 0, 0), tiles, ["alice"]);
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
