import { describe, expect, it, vi } from "vitest";
import { resolveBrain, type BrainDef } from "../lib/brain";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { initialMemory, stepBrain } from "./brainRuntime";
import { BRAIN_TICK_MS, TICK_MS } from "./constants";
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

/** Where the one resident is, as a string worth comparing. */
function deerCell(session: GameSession): string {
  const deer = session
    .actorSnapshots()
    .find((actor) => actor.tileId.startsWith("deer"));
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
      step: vi.fn(() => true),
      ...overrides,
    };
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
