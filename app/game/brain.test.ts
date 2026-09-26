import { describe, expect, it, vi } from "vitest";
import statusesJson from "../../data/statuses.json";
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
import { constantFormula } from "../lib/formula";
import { DEFAULT_STATUS_SOURCE, type StatusDef, statusesById } from "../lib/status";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { Coord, Direction, MapFile, TileDef } from "../lib/types";
import { normalizeTiles } from "../lib/types";
import { initialMemory, stepBrain, type WalkGoal, type WalkOrderState } from "./brainRuntime";
import { fightingStats, resolveBattler } from "../lib/battler";
import { attackIntervalMs } from "./combat";
import {
  BRAIN_ATTENTION_FLOOR_CELLS,
  BRAIN_DOZE_BUDGET,
  BRAIN_TURNS_PER_TICK_MIN,
  BRAIN_TICK_MS,
  TICK_MS,
  WALK_DURATION_MS,
} from "./constants";
import { GameSession } from "./GameSession";
import { Rng } from "./rng";
import { FRAME, tile } from "../lib/testTile";

const IDLE_MS = 400;

function wanderingBrain(): BrainDef {
  return {
    initial: "idle",
    states: {
      idle: { do: [{ action: "hold" }] },
      wander: { do: [{ action: "step_random" }, { action: "hold" }] },
    },
    transitions: [{ from: "idle", if: { cond: "after", ms: IDLE_MS }, to: "wander" }],
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
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
  }),
  tile({
    id: "deer",
    height: 2,
    actor: true,
    affectedByGravity: true,
    walkable: false,
    interactions: { brain: wanderingBrain() },
  }),
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

function openRoute(self: Coord, at: Coord): Direction | "arrived" | null {
  const dx = at.x - self.x;
  const dy = at.y - self.y;
  if (at.z === self.z && Math.abs(dx) + Math.abs(dy) <= 1) return "arrived";
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "e" : "w";
  return dy > 0 ? "s" : "n";
}

function standingOrder(ctx: Parameters<typeof stepBrain>[3], goal: WalkGoal): WalkOrderState {
  if (ctx.busy) return "walking";
  const at = goal.of === "cell" ? goal.at : ctx.positionOf(goal.id);
  if (!at) return "blocked";
  const direction = openRoute(ctx.self, at);
  if (direction === null) return "blocked";
  if (direction === "arrived") return "arrived";
  return ctx.step(direction) ? "walking" : "blocked";
}

function runningOrder(ctx: Parameters<typeof stepBrain>[3], threat: Coord): WalkOrderState {
  if (ctx.busy) return "walking";
  const away = openRoute(threat, ctx.self);
  if (away === null || away === "arrived") return "blocked";
  return ctx.step(away) ? "walking" : "blocked";
}

function deerCell(session: GameSession): string {
  const deer = session.actorSnapshots().find((actor) => actor.tileId !== "player");
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

  it.each([
    [
      "an action nobody implements",
      { ...wanderingBrain(), states: { idle: { do: [{ action: "sing" }] } } },
    ],
    ["a starting state that does not exist", { ...wanderingBrain(), initial: "dozing" }],
    [
      "a transition to a state that does not exist",
      {
        ...wanderingBrain(),
        transitions: [{ from: "idle", if: { cond: "after", ms: 1 }, to: "sprinting" }],
      },
    ],
    [
      "a transition from a state that does not exist",
      {
        ...wanderingBrain(),
        transitions: [{ from: "dreaming", if: { cond: "after", ms: 1 }, to: "idle" }],
      },
    ],
    [
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
      wouldStepIntoHazard: () => false,
      walkTo: (goal: WalkGoal): WalkOrderState => standingOrder(built, goal),
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
      cast: vi.fn((): "cast" | "casting" | "no" => "no"),
      extract: vi.fn(() => false),
      consume: vi.fn(() => false),
      consumeOn: vi.fn(() => false),
      carrying: () => false,
      hasStatus: () => false,
      standOff: () => null,
      health: () => 1,
      minutesOfDay: 12 * 60,
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

    expect(c.step).toHaveBeenCalledTimes(4);
  });

  it("leaves out a direction that lands in something, drops allowed or not", () => {
    const brain: BrainDef = {
      initial: "wander",
      states: {
        wander: { do: [{ action: "step_random", allowDrops: true }] },
      },
      transitions: [],
    };
    const memory = initialMemory(brain);
    const c = ctx({
      wouldStepIntoHazard: (direction: Direction) => direction === "n",
      step: vi.fn(() => false),
    });

    stepBrain(brain, memory, BRAIN_TICK_MS, c);

    expect(c.step).toHaveBeenCalledTimes(3);
    expect(c.step).not.toHaveBeenCalledWith("n");
  });

  it("reads a creature hemmed in by hazards as blocked, not as standing still", () => {
    const hemmed: BrainDef = {
      initial: "wander",
      states: { wander: { do: [{ action: "step_random" }] } },
      transitions: [{ from: "wander", if: { cond: "stuck" }, to: "resigned" }],
    };
    const memory = initialMemory(hemmed);
    const c = ctx({ wouldStepIntoHazard: () => true });

    stepBrain(hemmed, memory, BRAIN_TICK_MS, c);
    stepBrain(hemmed, memory, BRAIN_TICK_MS, c);

    expect(c.step).not.toHaveBeenCalled();
    expect(memory.state).toBe("resigned");
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

  it("decides on its own slower clock", () => {
    const session = new GameSession(withDeer(field(4), 0, 0), tiles, { actorIds: ["alice"] });

    advance(session, IDLE_MS - BRAIN_TICK_MS);

    expect(deerCell(session)).toBe("0,0");
  });

  it("walks the same path twice from the same seed", () => {
    const path = (seed: number) => {
      const session = new GameSession(withDeer(field(4), 0, 0), tiles, {
        actorIds: ["alice"],
        seed: seed,
      });
      const seen: string[] = [];
      for (let i = 0; i < 40; i++) {
        advance(session, BRAIN_TICK_MS);
        seen.push(deerCell(session));
      }
      return seen;
    };

    expect(path(7)).toEqual(path(7));
    expect(path(7)).not.toEqual(path(99));
  });

  it("runs the first action that does not fail, and no further", () => {
    const session = new GameSession(withDeer(field(4), 0, 0, "deer-holding"), tiles, {
      actorIds: ["alice"],
    });

    advance(session, IDLE_MS * 6);

    expect(deerCell(session)).toBe("0,0");
  });

  it("falls through to a later action when the first one fails", () => {
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
            do: [{ action: "step_away_from", of: slot("friend") }, { action: "hold" }],
          },
        },
      },
    },
  }),
];

function withPlayerAt(map: MapFile, x: number, y: number): MapFile {
  return replaceStack(map, x, y, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "e", owner: "alice" },
  ]);
}

function gap(session: GameSession): number {
  const actors = session.actorSnapshots();
  const creature = actors.find((a) => a.tileId === "cat" || a.tileId === "shy")!;
  const player = actors.find((a) => a.tileId === "player")!;
  return Math.abs(creature.x - player.x) + Math.abs(creature.y - player.y);
}

describe("noticing you", () => {
  function facing(creature: string, apart: number): GameSession {
    let map = field(9);
    map = replaceStack(map, -9, -9, 0, [{ tileId: "grass" }]);
    map = withDeer(map, 0, 0, creature);
    map = withPlayerAt(map, apart, 0);
    return new GameSession(map, noticing, {
      actorIds: ["alice"],
      spawnAt: {
        x: -9,
        y: -9,
        z: 0,
        stackIndex: 1,
      },
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

  it("settles on one mind about somebody standing exactly at its limit", () => {
    const session = facing("cat", NOTICE_CELLS);
    const seen = new Set<number>();
    for (let i = 0; i < 12; i++) {
      advance(session, BRAIN_TICK_MS);
      seen.add(gap(session));
    }

    expect(seen.size).toBeLessThanOrEqual(NOTICE_CELLS);
  });

  it("notices somebody who joins after it has already looked", () => {
    let map = field(9);
    map = replaceStack(map, -9, -9, 0, [{ tileId: "grass" }]);
    map = withDeer(map, 0, 0, "cat");
    map = withPlayerAt(map, 9, 0);
    const session = new GameSession(map, noticing, {
      actorIds: ["alice"],
      spawnAt: {
        x: -9,
        y: -9,
        z: 0,
        stackIndex: 1,
      },
    });
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
    const session = new GameSession(map, noticing, {
      actorIds: ["alice"],
      spawnAt: {
        x: -9,
        y: -9,
        z: 0,
        stackIndex: 1,
      },
    });

    advance(session, BRAIN_TICK_MS);
    session.spawn("bob", { at: { x: 0, y: 1, z: 0 } });
    advance(session, BRAIN_TICK_MS * 3);

    const cat = session.actorSnapshots().find((a) => a.tileId === "cat")!;
    const alice = session.actorSnapshots().find((a) => a.id === "alice")!;
    expect(Math.abs(cat.x - alice.x) + Math.abs(cat.y - alice.y)).toBeLessThan(NOTICE_CELLS);
  });

  it("settles when the one it was watching leaves the world", () => {
    const session = facing("cat", NOTICE_CELLS);
    advance(session, BRAIN_TICK_MS * 2);

    session.despawn("alice");

    expect(() => advance(session, BRAIN_TICK_MS * 4)).not.toThrow();
    expect(session.isAtRest()).toBe(true);
  });
});

describe("chasing round an obstacle", () => {
  const HUNT_CELLS = 8;
  const GIVE_UP_CELLS = 20;

  function huntBrain(): BrainDef {
    return {
      initial: "idle",
      states: {
        idle: { do: [{ action: "hold" }] },
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
    tile({
      id: "swimming-hunter",
      height: 2,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      swims: true,
      interactions: { brain: huntBrain() },
    }),
    tile({ id: "water", height: 0, walkSpeedPercent: -50, wade: true }),
  ];

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

  function between(session: GameSession): number {
    const actors = session.actorSnapshots();
    const hunter = actors.find((a) => a.tileId !== "player")!;
    const player = actors.find((a) => a.tileId === "player")!;
    return Math.abs(hunter.x - player.x) + Math.abs(hunter.y - player.y);
  }

  it("walks round the box it used to stand behind", () => {
    const session = penned([
      [1, -1],
      [1, 0],
      [1, 1],
    ]);
    expect(between(session)).toBe(3);

    advance(session, BRAIN_TICK_MS * 10);

    expect(between(session)).toBe(1);
  });

  it("gives up on somebody it has no way of reaching", () => {
    const session = penned([
      [2, -1],
      [2, 0],
      [2, 1],
      [3, -1],
      [3, 1],
      [4, 0],
    ]);

    const heard: string[] = [];
    for (let elapsed = 0; elapsed < BRAIN_TICK_MS * 6; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      for (const noise of session.drainNoise()) heard.push(noise.text);
    }

    expect(heard).toContain("tsk");
    expect(between(session)).toBe(3);
  });

  function acrossRiver(hunterId: string): GameSession {
    let map = field(9);
    map = replaceStack(map, -9, -9, 0, [{ tileId: "grass" }]);
    for (let y = -9; y <= 9; y++) map = replaceStack(map, 1, y, 0, [{ tileId: "water" }]);
    map = withDeer(map, 0, 0, hunterId);
    map = withPlayerAt(map, 3, 0);
    return new GameSession(map, hunters, {
      actorIds: ["alice"],
      spawnAt: { x: -9, y: -9, z: 0, stackIndex: 1 },
    });
  }

  it("gives up on somebody across water it cannot swim", () => {
    const session = acrossRiver("hunter");

    const heard: string[] = [];
    for (let elapsed = 0; elapsed < BRAIN_TICK_MS * 6; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      for (const noise of session.drainNoise()) heard.push(noise.text);
    }

    expect(heard).toContain("tsk");
    expect(between(session)).toBe(3);
  });

  it("wades across to them when it swims", () => {
    const session = acrossRiver("swimming-hunter");

    advance(session, BRAIN_TICK_MS * 10);

    expect(between(session)).toBe(1);
  });
});

describe("picking out a tile to follow", () => {
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
    tile({
      id: "ratcatcher",
      height: 2,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: { brain: flockBrain("rat") },
    }),
    tile({
      id: "stalker",
      height: 2,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: { brain: flockBrain("player") },
    }),
  ];

  function warren(...bodies: [string, number, number][]): GameSession {
    let map = field(9);
    map = replaceStack(map, -9, -9, 0, [{ tileId: "grass" }]);
    for (const [tileId, x, y] of bodies) map = withDeer(map, x, y, tileId);
    return new GameSession(map, flocking, {
      actorIds: ["alice"],
      spawnAt: {
        x: -9,
        y: -9,
        z: 0,
        stackIndex: 1,
      },
    });
  }

  function cellOf(session: GameSession, tileId: string, nth = 0) {
    const found = session.actorSnapshots().filter((actor) => actor.tileId === tileId);
    return found[nth]!;
  }

  function kindOf(session: GameSession, tileId: string) {
    return session.actorSnapshots().filter((actor) => actor.tileId === tileId);
  }

  it("closes on another of the same tile", () => {
    const session = warren(["rat", 0, 0], ["rat", NOTICE_CELLS, 0]);

    advance(session, BRAIN_TICK_MS * 4);

    const [a, b] = kindOf(session, "rat");
    expect(Math.abs(a!.x - b!.x) + Math.abs(a!.y - b!.y)).toBeLessThan(NOTICE_CELLS);
  });

  it("walks past an animal that is not the tile it named", () => {
    const session = warren(["mouse", 0, 0], ["rat", 2, 0]);
    const before = cellOf(session, "mouse");

    advance(session, BRAIN_TICK_MS * 6);

    const after = cellOf(session, "mouse");
    expect(`${after.x},${after.y}`).toBe(`${before.x},${before.y}`);
  });

  it("follows a tile it is not itself", () => {
    const session = warren(["ratcatcher", 0, 0], ["rat", NOTICE_CELLS, 0]);
    const rat = cellOf(session, "rat");

    advance(session, BRAIN_TICK_MS * 4);

    const chaser = cellOf(session, "ratcatcher");
    expect(Math.abs(chaser.x - rat.x) + Math.abs(chaser.y - rat.y)).toBeLessThan(NOTICE_CELLS);
  });

  it("goes to a person in sight", () => {
    const session = warren(["stalker", 0, 0]);
    session.spawn("bob", { at: { x: NOTICE_CELLS, y: 0, z: 0 } });

    advance(session, BRAIN_TICK_MS * 4);

    expect(cellOf(session, "stalker").x).toBeGreaterThan(0);
  });

  it("does not notice a hidden person", () => {
    const session = warren(["stalker", 0, 0]);
    session.spawn("bob", { at: { x: NOTICE_CELLS, y: 0, z: 0 }, hidden: true });

    advance(session, BRAIN_TICK_MS * 6);

    expect(cellOf(session, "stalker").x).toBe(0);
  });

  it("gives up on a person who hides partway through the chase", () => {
    const session = warren(["stalker", 0, 0]);
    session.spawn("bob", { at: { x: NOTICE_CELLS, y: 0, z: 0 } });
    advance(session, BRAIN_TICK_MS);

    session.setHidden(true, "bob");
    advance(session, BRAIN_TICK_MS);
    const whereItStopped = cellOf(session, "stalker").x;
    advance(session, BRAIN_TICK_MS * 6);

    expect(cellOf(session, "stalker").x).toBe(whereItStopped);
  });

  it("is nobody at all when it is the last of its kind", () => {
    const session = warren(["rat", 0, 0]);
    const before = cellOf(session, "rat");

    advance(session, BRAIN_TICK_MS * 6);

    const after = cellOf(session, "rat");
    expect(`${after.x},${after.y}`).toBe(`${before.x},${before.y}`);
  });

  it("takes the nearest of several, and leaves the rest alone", () => {
    const session = warren(["rat", 0, 0], ["rat", 2, 0], ["rat", 9, 0]);

    advance(session, BRAIN_TICK_MS * 4);

    const xs = kindOf(session, "rat")
      .map((rat) => rat.x)
      .sort((a, b) => a - b);
    expect(xs[1]! - xs[0]!).toBe(1);
    expect(xs[2]).toBe(9);
  });
});

describe("giving up", () => {
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
            wander: { do: [{ action: "step_random" }] },
            resigned: { do: [{ action: "hold" }] },
          },
          transitions: [{ from: "wander", if: { cond: "stuck" }, to: "resigned" }],
        },
      },
    }),
  ];

  function penned(): GameSession {
    let map = field(4);
    for (const [x, y] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      map = replaceStack(map, x!, y!, 0, [{ tileId: "grass" }, { tileId: "wall" }]);
    }
    return new GameSession(withDeer(map, 0, 0, "trapped"), cornerable, { actorIds: ["alice"] });
  }

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
      wouldStepIntoHazard: () => false,
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
      cast: (): "cast" | "casting" | "no" => "no",
      extract: () => false,
      consume: () => false,
      consumeOn: () => false,
      carrying: () => false,
      hasStatus: () => false,
      standOff: () => null,
      health: () => 1,
      minutesOfDay: 12 * 60,
      nameOf: (id: string) => id,
    };

    stepBrain(brain, memory, BRAIN_TICK_MS, blocked);
    expect(memory.stuck).toBe(true);
    expect(memory.state).toBe("wander");

    stepBrain(brain, memory, BRAIN_TICK_MS, blocked);
    expect(memory.state).toBe("resigned");
    expect(memory.stuck).toBe(false);
  });

  it("leaves a penned creature standing quietly where it was", () => {
    const session = penned();

    expect(() => advance(session, BRAIN_TICK_MS * 4)).not.toThrow();
    expect(deerCell(session)).toBe("0,0");
  });

  it("is not stuck merely because it chose to stand still", () => {
    const session = new GameSession(withDeer(field(4), 0, 0, "deer"), cornerable, {
      actorIds: ["alice"],
    });

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

  function plinth(creature: string): GameSession {
    let map = field(4);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "grass" }, { tileId: creature }]);
    return new GameSession(map, ledgeDwellers, { actorIds: ["alice"] });
  }

  function overlooked(creature: string): GameSession {
    let map = field(4);
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

  it("lets one that was told it could, and lands it safely", () => {
    const session = plinth("reckless");

    advance(session, BRAIN_TICK_MS * 8);

    expect(levelOf(session, "reckless")).toBe(0);
    const landed = session.actorSnapshots().find((a) => a.tileId === "reckless")!;
    expect(landed.fall).toBeNull();
  });

  it("routes off the plinth after somebody it was told it could drop for", () => {
    const session = overlooked("pouncer");

    advance(session, BRAIN_TICK_MS * 8);

    expect(levelOf(session, "pouncer")).toBe(0);
  });

  it("keeps a routing one up there when it was not", () => {
    const session = overlooked("stalker");

    advance(session, BRAIN_TICK_MS * 8);

    expect(levelOf(session, "stalker")).toBe(1);
  });
});

describe("watching where it puts its feet", () => {
  const hazardTiles: TileDef[] = [
    ...tiles,
    tile({
      id: "flame",
      height: 2,
      intangible: true,
      interactions: { addStatus: { trigger: "step", statusId: "burned" } },
    }),
    tile({
      id: "shrine",
      height: 2,
      intangible: true,
      interactions: { addStatus: { trigger: "step", statusId: "blessed" } },
    }),
    tile({
      id: "pad",
      height: 2,
      intangible: true,
      interactions: {
        teleport: {
          trigger: "step",
          destination: { kind: "relative", delta: { x: 0, y: 0, z: 0 } },
        },
      },
    }),
  ];

  const statuses: Record<string, StatusDef> = {
    burned: {
      ...DEFAULT_STATUS_SOURCE,
      everyMs: constantFormula(0),
      id: "burned",
      name: "burned",
      tone: "bad",
    },
    blessed: {
      ...DEFAULT_STATUS_SOURCE,
      everyMs: constantFormula(0),
      id: "blessed",
      name: "blessed",
      tone: "good",
    },
  };

  const CORRIDOR_END = 2;

  const WATCHER_Y = 5;

  function corridor(tileId: string): GameSession {
    let map = emptyMap();
    map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "deer" }]);
    map = replaceStack(map, CORRIDOR_END, 0, 0, [{ tileId: "grass" }, { tileId }]);
    for (let x = 1; x < CORRIDOR_END; x++) {
      map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
    }
    map = withPlayerAt(map, 0, WATCHER_Y);
    return new GameSession(map, hazardTiles, {
      actorIds: ["alice"],
      statuses,
    });
  }

  function wanderedThrough(session: GameSession, ms: number): Set<string> {
    const seen = new Set<string>([deerCell(session)]);
    for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      seen.add(deerCell(session));
    }
    return seen;
  }

  const WANDER_MS = BRAIN_TICK_MS * 40;

  it("never wanders onto a flame", () => {
    const visited = wanderedThrough(corridor("flame"), WANDER_MS);

    expect(visited.has(`${CORRIDOR_END},0`)).toBe(false);
    expect(visited.has("1,0")).toBe(true);
  });

  it("never wanders onto a teleport", () => {
    const visited = wanderedThrough(corridor("pad"), WANDER_MS);

    expect(visited.has(`${CORRIDOR_END},0`)).toBe(false);
    expect(visited.has("1,0")).toBe(true);
  });

  it("wanders over a shrine like any other ground", () => {
    const visited = wanderedThrough(corridor("shrine"), WANDER_MS);

    expect(visited.has(`${CORRIDOR_END},0`)).toBe(true);
  });

  function wadingCorridor(deerId: string): GameSession {
    let map = emptyMap();
    map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: deerId }]);
    for (let x = 1; x < CORRIDOR_END; x++) {
      map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
    }
    map = replaceStack(map, CORRIDOR_END, 0, 0, [{ tileId: "water" }]);
    map = withPlayerAt(map, 0, WATCHER_Y);
    return new GameSession(
      map,
      [
        ...hazardTiles,
        tile({ id: "water", height: 0, walkSpeedPercent: -50, wade: true }),
        { ...hazardTiles.find((def) => def.id === "deer")!, id: "otter", swims: true },
      ],
      { actorIds: ["alice"], statuses },
    );
  }

  it("never wanders into water when it cannot swim", () => {
    const visited = wanderedThrough(wadingCorridor("deer"), WANDER_MS);

    expect(visited.has(`${CORRIDOR_END},0`)).toBe(false);
    expect(visited.has("1,0")).toBe(true);
  });

  it("wanders into water when it swims", () => {
    const visited = wanderedThrough(wadingCorridor("otter"), WANDER_MS);

    expect(visited.has(`${CORRIDOR_END},0`)).toBe(true);
  });
});

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
      wouldStepIntoHazard: () => false,
      walkTo: (goal: WalkGoal): WalkOrderState => standingOrder(built, goal),
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
      cast: vi.fn((): "cast" | "casting" | "no" => "no"),
      extract: vi.fn(() => false),
      consume: vi.fn(() => false),
      consumeOn: vi.fn(() => false),
      carrying: () => false,
      hasStatus: () => false,
      standOff: () => null,
      health: () => 1,
      minutesOfDay: 12 * 60,
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
    expect(c.step).not.toHaveBeenCalled();

    stepBrain(brain, memory, BRAIN_TICK_MS, c);

    expect(c.step).toHaveBeenCalledTimes(1);
  });

  it("takes the steps it was asked for and no more", () => {
    const brain: BrainDef = {
      initial: "stroll",
      states: {
        stroll: {
          do: [{ action: "walk_n_steps", steps: STROLL_STEPS }, { action: "hold" }],
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
    expect(memory.scratch).toEqual({});
  });

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
      transitions: [{ from: "graze", if: { cond: "after", ms: BRAIN_TICK_MS }, to: "bolt" }],
    };
    const memory = initialMemory(brain);

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

    advance(session, BRAIN_TICK_MS * 20);
    expect(deerCell(session)).toBe(settled);
  });

  it("keeps its counting out of the saved world", () => {
    const session = grazing();
    advance(session, GRAZE_MS + BRAIN_TICK_MS * 4);

    expect(JSON.stringify(session.getMap())).not.toContain("scratch");

    const resumed = new GameSession(session.getMap(), timed, {
      actorIds: ["alice"],
      spawnAt: session.getSpawnPoint(),
      seed: session.getSeed(),
    });
    const where = deerCell(resumed);

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

  function cellsCovered(creature: string): number {
    const session = new GameSession(withDeer(field(9), 0, 0, creature), paced, {
      actorIds: ["alice"],
      seed: 11,
    });
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
    const session = new GameSession(withDeer(field(9), 0, 0, "plodder"), paced, {
      actorIds: ["alice"],
    });
    advance(session, BRAIN_TICK_MS);

    const walk = session.actorSnapshots().find((a) => a.tileId === "plodder")!.walk;
    expect(walk?.durationMs).toBe(WALK_DURATION_MS * 2);
  });

  it("leaves a body that authored no pace walking like a player", () => {
    const session = new GameSession(withDeer(field(9), 0, 0, "deer"), paced, {
      actorIds: ["alice"],
    });
    advance(session, IDLE_MS + BRAIN_TICK_MS);

    const walk = session.actorSnapshots().find((a) => a.tileId === "deer")!.walk;
    expect(walk?.durationMs).toBe(WALK_DURATION_MS);
  });
});

describe("a deer that yelps", () => {
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
    tile({
      id: "alarm-deer",
      height: 2,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: { brain: alarmedBrain("gate") },
    }),
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

  function startled(creature: string): MapFile {
    let map = field(9);
    map = replaceStack(map, -9, -9, 0, [{ tileId: "grass" }]);
    map = withDeer(map, 0, 0, creature);
    return withPlayerAt(map, 3, 0);
  }

  function session(creature: string): GameSession {
    return new GameSession(startled(creature), yelpers, {
      actorIds: ["alice"],
      spawnAt: {
        x: -9,
        y: -9,
        z: 0,
        stackIndex: 1,
      },
    });
  }

  it("says its word on entry, pinned to the cell it stood in", () => {
    const s = session("yelper");
    advance(s, BRAIN_TICK_MS);

    const said = s.drainSpeech();
    expect(said).toHaveLength(1);
    expect(said[0]!.text).toBe("!");
    expect(said[0]!.actorId).not.toBe("alice");
    expect({ x: said[0]!.x, y: said[0]!.y }).toEqual({ x: 0, y: 0 });
    expect(said[0]!.tileId).toBe("yelper");
  });

  it("says it once per entry, not once per tick it stays alarmed", () => {
    const s = session("yelper");
    advance(s, BRAIN_TICK_MS);
    expect(s.drainSpeech()).toHaveLength(1);

    advance(s, BRAIN_TICK_MS * 4);
    expect(s.drainSpeech()).toHaveLength(0);
  });

  it("treats a self-matching transition as staying, not re-entering", () => {
    const brain: BrainDef = {
      initial: "ringing",
      states: {
        ringing: { onEnter: [{ effect: "say", text: "!" }], do: [{ action: "hold" }] },
      },
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
      wouldStepIntoHazard: () => false,
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
      cast: (): "cast" | "casting" | "no" => "no",
      extract: () => false,
      consume: () => false,
      consumeOn: () => false,
      carrying: () => false,
      hasStatus: () => false,
      standOff: () => null,
      health: () => 1,
      minutesOfDay: 12 * 60,
      nameOf: (id: string) => id,
    };

    for (let tick = 0; tick < 5; tick++) stepBrain(brain, memory, BRAIN_TICK_MS, c);

    expect(say).toHaveBeenCalledTimes(1);
  });

  it("holds a channel open while alarmed, and lets it close on settling", () => {
    let map = startled("alarm-deer");
    map = replaceStack(map, 5, 0, 0, [{ tileId: "grass" }, { tileId: "gate", channel: "gate" }]);
    const s = new GameSession(map, yelpers, {
      actorIds: ["alice"],
      spawnAt: {
        x: -9,
        y: -9,
        z: 0,
        stackIndex: 1,
      },
    });

    const gateAt = () => getStack(s.getMap(), 5, 0, 0).some((p) => p.tileId === "gate-open");

    expect(gateAt()).toBe(false);
    advance(s, BRAIN_TICK_MS * 2);
    expect(gateAt()).toBe(true);

    s.spawn("bob", { at: { x: 9, y: 9, z: 0 } });
    s.despawn("alice");
    advance(s, BRAIN_TICK_MS * 2);
    expect(gateAt()).toBe(false);
  });

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
      wouldStepIntoHazard: () => false,
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
      cast: (): "cast" | "casting" | "no" => "no",
      extract: () => false,
      consume: () => false,
      consumeOn: () => false,
      carrying: () => false,
      hasStatus: () => false,
      standOff: () => null,
      health: () => 1,
      minutesOfDay: 12 * 60,
      nameOf: (id: string) => id,
    };

    stepBrain(brain, memory, BRAIN_TICK_MS, c);

    expect(c.say).toHaveBeenCalledTimes(1);
    expect(memory.stuck).toBe(true);
  });

  it("puts nothing said into the saved world", () => {
    const s = session("yelper");
    advance(s, BRAIN_TICK_MS * 3);

    expect(JSON.stringify(s.getMap())).not.toContain("!");
  });
});

describe("a creature that wakes at night", () => {
  const owls: TileDef[] = [
    ...tiles,
    tile({
      id: "owl",
      height: 2,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: {
        brain: {
          initial: "asleep",
          states: {
            asleep: { do: [{ action: "hold" }] },
            awake: { onEnter: [{ effect: "say", text: "hoo" }], do: [{ action: "hold" }] },
          },
          transitions: [
            {
              from: "asleep",
              if: { cond: "time_of_day", fromHour: 19, toHour: 5 },
              to: "awake",
            },
          ],
        },
      },
    }),
  ];

  function owlAt(clock: () => number): GameSession {
    return new GameSession(withDeer(field(4), 0, 0, "owl"), owls, { actorIds: ["alice"], clock });
  }

  function saidOver(session: GameSession, ms: number): string[] {
    const said: string[] = [];
    for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      said.push(...session.drainSpeech().map((line) => line.text));
    }
    return said;
  }

  it("stays asleep by day and wakes once the clock reaches the night", () => {
    let minutes = 12 * 60;
    const session = owlAt(() => minutes);

    expect(saidOver(session, BRAIN_TICK_MS * 2)).toEqual([]);

    minutes = 20 * 60;
    expect(saidOver(session, BRAIN_TICK_MS * 2)).toEqual(["hoo"]);
  });
});

describe("resuming a world", () => {
  it("starts a resumed creature over from its initial state", () => {
    const first = new GameSession(withDeer(field(4), 0, 0), tiles, { actorIds: ["alice"] });
    advance(first, IDLE_MS * 2);
    const wandered = deerCell(first);
    expect(wandered).not.toBe("0,0");

    const resumed = new GameSession(first.getMap(), tiles, {
      actorIds: ["alice"],
      spawnAt: first.getSpawnPoint(),
      seed: first.getSeed(),
    });

    expect(deerCell(resumed)).toBe(wandered);
    advance(resumed, IDLE_MS - BRAIN_TICK_MS);
    expect(deerCell(resumed)).toBe(wandered);
  });

  it("carries the dice on, rather than replaying the same wander", () => {
    const first = new GameSession(withDeer(field(4), 0, 0), tiles, {
      actorIds: ["alice"],
      seed: 5,
    });
    advance(first, IDLE_MS * 3);

    expect(first.getSeed()).not.toBe(5);
  });
});

describe("staying awake to think", () => {
  it("is not at rest while a watched creature is counting down", () => {
    const session = new GameSession(withDeer(field(4), 0, 0), tiles, { actorIds: ["alice"] });

    advance(session, BRAIN_TICK_MS);

    expect(deerCell(session)).toBe("0,0");
    expect(session.isAtRest()).toBe(false);
  });

  it("rests once the only creature left has no brain to run", () => {
    const inert = tiles.map((t) => (t.id === "deer" ? tile({ ...t, interactions: {} }) : t));
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

  it("lets a step already under way finish after the last player leaves", () => {
    const session = new GameSession(withDeer(field(4), 0, 0), tiles, { actorIds: ["alice"] });
    advance(session, IDLE_MS);

    const midStride = session.actorSnapshots().find((actor) => actor.tileId === "deer");
    expect(midStride?.walk).not.toBeNull();

    session.despawn("alice");
    advance(session, IDLE_MS * 4);

    const after = session.actorSnapshots().find((actor) => actor.tileId === "deer");
    expect(after?.walk).toBeNull();
    expect(deerCell(session)).not.toBe("0,0");
    expect(session.isAtRest()).toBe(true);
  });
});

describe("hearing", () => {
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

  function room(creature: string, apart: number): GameSession {
    let map = field(9);
    map = replaceStack(map, -9, -9, 0, [{ tileId: "grass" }]);
    map = withDeer(map, 0, 0, creature);
    map = withPlayerAt(map, apart, 0);
    return new GameSession(map, listeners, {
      actorIds: ["alice"],
      spawnAt: {
        x: -9,
        y: -9,
        z: 0,
        stackIndex: 1,
      },
    });
  }

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

    const creature = session.actorSnapshots().find((actor) => actor.tileId === "listener")!;
    expect(creature.x).toBeGreaterThan(0);
  });

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
      const session = new GameSession(map, listeners, {
        actorIds: ["alice"],
        spawnAt: {
          x: -9,
          y: -9,
          z: 0,
          stackIndex: 1,
        },
      });

      session.hear("alice", "psps");
      expect(saidDuring(session, BRAIN_TICK_MS * 2), creature).toEqual(answered);
    }
  });

  it("turns to the one who called, over the one standing closer", () => {
    const session = room("listener", 5);
    session.spawn("bob", { at: { x: 0, y: 2, z: 0 } });
    advance(session, BRAIN_TICK_MS);

    session.hear("alice", "psps");
    advance(session, BRAIN_TICK_MS * 4);

    const creature = session.actorSnapshots().find((actor) => actor.tileId === "listener")!;
    expect(creature.x).toBeGreaterThan(0);
    expect(creature.y).toBe(0);
  });

  it("changes its mind when somebody else calls it", () => {
    let map = field(9);
    map = replaceStack(map, -9, -9, 0, [{ tileId: "grass" }]);
    map = withDeer(map, 0, 0, "listener");
    map = withPlayerAt(map, 3, 0);
    const session = new GameSession(map, listeners, {
      actorIds: ["alice"],
      spawnAt: {
        x: -9,
        y: -9,
        z: 0,
        stackIndex: 1,
      },
    });
    session.spawn("bob", { at: { x: 0, y: 3, z: 0 } });

    session.hear("alice", "psps");
    advance(session, BRAIN_TICK_MS * 2);
    const towardsAlice = session.actorSnapshots().find((actor) => actor.tileId === "listener")!;
    expect(towardsAlice.x).toBeGreaterThan(0);

    session.hear("bob", "psps");
    expect(saidDuring(session, BRAIN_TICK_MS * 4)).toEqual(["meow"]);
    const towardsBob = session.actorSnapshots().find((actor) => actor.tileId === "listener")!;
    expect(towardsBob.y).toBeGreaterThan(0);
  });

  it("is heard by every creature in earshot at once", () => {
    let map = field(9);
    map = replaceStack(map, -9, -9, 0, [{ tileId: "grass" }]);
    map = withDeer(map, 0, 0, "listener");
    map = withDeer(map, 0, 1, "listener");
    map = withPlayerAt(map, 3, 0);
    const session = new GameSession(map, listeners, {
      actorIds: ["alice"],
      spawnAt: {
        x: -9,
        y: -9,
        z: 0,
        stackIndex: 1,
      },
    });

    session.hear("alice", "psps");
    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual(["meow", "meow"]);
  });

  it("keeps the world awake until the word has been heard", () => {
    const session = room("listener", 3);
    advance(session, BRAIN_TICK_MS * 8);

    session.hear("alice", "psps");
    expect(session.isAtRest()).toBe(false);
  });

  it("drops what was said with nobody left to hear it", () => {
    const session = room("listener", 3);
    session.despawn("alice");
    session.hear("alice", "psps");
    advance(session, TICK_MS);

    expect(session.isAtRest()).toBe(true);
  });
});

describe("hearing a sound", () => {
  const EARSHOT = 6;

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
    tile({
      id: "picky",
      height: 2,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: { brain: nosyBrain("meow") },
    }),
    tile({
      id: "yapping-nosy",
      height: 2,
      actor: true,
      affectedByGravity: true,
      walkable: false,
      interactions: { brain: yappingWhileNosy() },
    }),
  ];

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

  it("never hears itself", () => {
    const session = room("yapping-nosy", null);

    expect(saidDuring(session, BRAIN_TICK_MS * 8)).toEqual([]);
  });

  it("matches a word in the sound when it is given one", () => {
    expect(saidDuring(room("picky", "meower"), AUDIBLE_MS)).toEqual(["?"]);
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
      wouldStepIntoHazard: () => false,
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
      cast: vi.fn((): "cast" | "casting" | "no" => "no"),
      extract: vi.fn(() => false),
      consume: vi.fn(() => false),
      consumeOn: vi.fn(() => false),
      carrying: () => false,
      hasStatus: () => false,
      standOff: () => null,
      health: () => 1,
      minutesOfDay: 12 * 60,
      nameOf: (id: string) => id,
      ...overrides,
    } satisfies Parameters<typeof stepBrain>[3];
    return built;
  }

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
    expect(
      stateAfterOneTick(both, {
        positionOf: () => ({ x: 1, y: 0, z: 0 }),
        nearestOnTile: () => "alice",
      }),
    ).toBe("alert");
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
        group<BrainConditionDef>("or", [
          { cond: "after", ms: NEVER_MS },
          { cond: "after", ms: 0 },
        ]),
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
    expect(memory.blackboard.caller).toBeUndefined();
  });

  it("refuses a group with nothing in it, and the brain with it", () => {
    const brain = {
      initial: "idle",
      states: { idle: { do: [] } },
      transitions: [{ from: "idle", if: { combinator: "and", rules: [] }, to: "idle" }],
    };
    expect(
      resolveBrain(tile({ id: "empty-group", height: 2, interactions: { brain } as never })),
    ).toBeNull();
  });
});

describe("holding a conversation", () => {
  const EARSHOT = 4;
  const GREETING_MS = BRAIN_TICK_MS;
  const CHAT_TIMEOUT_MS = BRAIN_TICK_MS * 8;

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
        {
          from: "idle",
          if: { cond: "heard", text: "hi", cells: EARSHOT, los: true },
          bind: { partner: SPEAKER_SELECTOR },
          to: "greeting",
        },
        { from: "greeting", if: { cond: "after", ms: GREETING_MS }, to: "talking" },
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

  function shop(): GameSession {
    let map = field(9);
    map = replaceStack(map, -9, -9, 0, [{ tileId: "grass" }]);
    map = withDeer(map, 0, 0, "shopkeeper");
    map = withPlayerAt(map, 2, 0);
    const session = new GameSession(map, shopkeepers, {
      actorIds: ["alice"],
      names: { alice: ALICE, bob: BOB },
      spawnAt: { x: -9, y: -9, z: 0, stackIndex: 1 },
    });
    session.spawn("bob", { name: BOB, at: { x: 0, y: 2, z: 0 } });
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

  const ALICE = "Alice";
  const BOB = "Bob";

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

  it("turns away a second greeting, naming who it is busy with", () => {
    const session = shop();
    session.hear("alice", "hi");
    advance(session, GREETING_MS + BRAIN_TICK_MS * 2);

    session.hear("bob", "hi");
    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual([`I'm busy with ${ALICE} now.`]);
  });

  it("keeps the partner it had after turning somebody away", () => {
    const session = shop();
    session.hear("alice", "hi");
    advance(session, GREETING_MS + BRAIN_TICK_MS * 2);
    session.hear("bob", "hi");
    advance(session, BRAIN_TICK_MS * 3);

    session.hear("alice", "bye");
    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual(["See you later."]);
  });

  it("does not tell the person it is talking to that it is busy", () => {
    const session = shop();
    session.hear("alice", "hi");
    advance(session, GREETING_MS + BRAIN_TICK_MS * 2);

    session.hear("alice", "hi again");
    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual([]);
  });

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
    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual([`Hello, ${BOB}.`]);
  });

  it("gives up on somebody who stopped talking", () => {
    const session = shop();
    session.hear("alice", "hi");
    advance(session, GREETING_MS + CHAT_TIMEOUT_MS + BRAIN_TICK_MS * 2);

    session.hear("bob", "hi");
    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual([`Hello, ${BOB}.`]);
  });

  it("gives up on somebody who walked off", () => {
    const session = shop();
    session.hear("alice", "hi");
    advance(session, GREETING_MS + BRAIN_TICK_MS * 2);

    session.despawn("alice");
    session.spawn("alice", { name: ALICE, at: { x: EARSHOT + 3, y: 0, z: 0 } });
    advance(session, BRAIN_TICK_MS * 2);

    session.hear("bob", "hi");
    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual([`Hello, ${BOB}.`]);
  });

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
      transitions: [{ from: "idle", if: { cond: "after", ms: 0 }, to: "muttering" }],
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

    expect(saidDuring(session, BRAIN_TICK_MS * 2)).toEqual(["Where has someone got to?"]);
  });
});

describe("the cat we ship", () => {
  const authored = normalizeTiles(tilesJson as unknown[]);

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
    return new GameSession(map, authored, {
      actorIds: ["alice"],
      spawnAt: {
        x: -9,
        y: -9,
        z: 0,
        stackIndex: 1,
      },
    });
  }

  function catAt(session: GameSession) {
    return session.actorSnapshots().find((actor) => actor.tileId === "cat")!;
  }

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

  it("takes itself for a walk while nobody is talking to it", () => {
    const session = yard(9);
    const before = `${catAt(session).x},${catAt(session).y}`;

    advance(session, 6000);

    expect(`${catAt(session).x},${catAt(session).y}`).not.toBe(before);
  });
});

describe("the wolf we ship", () => {
  const authored = normalizeTiles(tilesJson as unknown[]);

  const EARSHOT_CELLS = 20;

  function moor(apart: number, wallAtX?: number): GameSession {
    let map = emptyMap();
    for (let x = -4; x <= 30; x++) {
      for (let y = -6; y <= 6; y++) {
        map = replaceStack(map, x, y, 0, [{ tileId: "dirt" }]);
      }
    }
    if (wallAtX !== undefined) {
      for (let y = -6; y <= 4; y++) {
        map = replaceStack(map, wallAtX, y, 0, [{ tileId: "dirt" }, { tileId: "stone-wall" }]);
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

  it("comes to look at a sound from twelve cells off", () => {
    const session = moor(12);
    session.hear("alice", "psps");

    advance(session, BRAIN_TICK_MS * 12);

    expect(gapToCat(session)).toBeLessThanOrEqual(7);
  });

  it("ignores one from further off than it can hear", () => {
    const session = moor(EARSHOT_CELLS + 1);
    session.hear("alice", "psps");

    advance(session, BRAIN_TICK_MS * 12);

    expect(gapToCat(session)).toBeGreaterThanOrEqual(EARSHOT_CELLS);
  });

  it("passes word to a wolf that heard nothing itself", () => {
    let map = emptyMap();
    for (let x = -4; x <= 40; x++) {
      for (let y = -6; y <= 6; y++) {
        map = replaceStack(map, x, y, 0, [{ tileId: "dirt" }]);
      }
    }
    map = replaceStack(map, 0, 0, 0, [{ tileId: "dirt" }, { tileId: "wolf" }]);
    map = replaceStack(map, 12, 0, 0, [{ tileId: "dirt" }, { tileId: "wolf" }]);
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

    const wolf = session.actorSnapshots().find((a) => a.tileId === "wolf")!;
    expect(wolf.x).toBeGreaterThan(6);
    expect(gapToCat(session)).toBeLessThan(12);
  });

  describe("by the clock", () => {
    const NOON = 12 * 60;
    const MIDNIGHT = 0;

    function den(z: number, minutes: number, aliceX = 4): GameSession {
      let map = emptyMap();
      for (let x = -6; x <= 6; x++) {
        for (let y = -6; y <= 6; y++) {
          map = replaceStack(map, x, y, z, [{ tileId: "dirt" }]);
        }
      }
      map = replaceStack(map, 0, 0, z, [{ tileId: "dirt" }, { tileId: "wolf" }]);
      map = replaceStack(map, aliceX, 0, z, [
        { tileId: "dirt" },
        { tileId: "player", direction: "w", owner: "alice" },
      ]);
      return new GameSession(map, authored, {
        actorIds: ["alice"],
        spawnAt: { x: 6, y: 6, z, stackIndex: 1 },
        seed: 20260822,
        clock: () => minutes,
      });
    }

    function noisesOver(session: GameSession, ms: number): string[] {
      const heard: string[] = [];
      for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
        session.tick(TICK_MS);
        for (const noise of session.drainNoise()) heard.push(noise.text);
      }
      return heard;
    }

    function wolfCell(session: GameSession): string {
      const wolf = session.actorSnapshots().find((a) => a.tileId === "wolf")!;
      return `${wolf.x},${wolf.y}`;
    }

    it("stays where it lies by day on the surface, and does not even wander", () => {
      const session = den(0, NOON);

      expect(noisesOver(session, BRAIN_TICK_MS * 20)).toEqual([]);
      expect(wolfCell(session)).toBe("0,0");
    });

    it("hunts somebody it can see at night on the surface", () => {
      expect(noisesOver(den(0, MIDNIGHT), BRAIN_TICK_MS * 2)).toContain("*howl*");
    });

    it("hunts underground at any hour", () => {
      expect(noisesOver(den(-1, NOON), BRAIN_TICK_MS * 2)).toContain("*howl*");
    });

    it("turns on somebody who hits it by day", () => {
      const session = den(0, NOON, 1);
      expect(noisesOver(session, BRAIN_TICK_MS * 2)).toEqual([]);

      const wolf = session.actorSnapshots().find((a) => a.tileId === "wolf")!;
      session.setTarget(wolf.id, "alice");
      session.setAttackMode(true, "alice");

      expect(noisesOver(session, BRAIN_TICK_MS * 20)).toContain("*howl*");
    });
  });
});

describe("keeping to its weapon's range", () => {
  const authored = normalizeTiles(tilesJson as unknown[]);
  const imp = authored.find((def) => def.id === "bog-imp")!;

  function keeper(weapon: string): TileDef {
    const battler = imp.interactions!.battler!;
    return {
      ...imp,
      id: "keeper",
      interactions: {
        battler: { ...battler, kit: [{ slot: "weapon" as const, tileId: weapon, chance: 100 }] },
        brain: {
          initial: "keeping",
          states: {
            keeping: {
              do: [
                { action: "attack_range", of: { type: "nearest", data: { tileIds: ["player"] } } },
                { action: "hold" },
              ],
            },
          },
          transitions: [],
        },
      },
    };
  }

  function yard(weapon: string, aliceX: number): GameSession {
    let map = emptyMap();
    for (let x = -12; x <= 12; x++) {
      for (let y = -12; y <= 12; y++) {
        map = replaceStack(map, x, y, 0, [{ tileId: "dirt" }]);
      }
    }
    map = replaceStack(map, 0, 0, 0, [{ tileId: "dirt" }, { tileId: "keeper" }]);
    map = replaceStack(map, aliceX, 0, 0, [
      { tileId: "dirt" },
      { tileId: "player", direction: "w", owner: "alice" },
    ]);
    return new GameSession(map, [...authored, keeper(weapon)], {
      actorIds: ["alice"],
      spawnAt: { x: 12, y: 12, z: 0, stackIndex: 1 },
      seed: 20260925,
    });
  }

  function apartSqAfter(session: GameSession, ms: number): number {
    for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) session.tick(TICK_MS);
    const actors = session.actorSnapshots();
    const a = actors.find((actor) => actor.tileId === "keeper")!;
    const b = actors.find((actor) => actor.tileId === "player")!;
    return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  }

  const BOW_MIN = 2;
  const BOW_REACH = 8;

  it("walks a bow up until the target is in reach, and no closer", () => {
    const apartSq = apartSqAfter(yard("hunting-bow", 12), 4000);
    expect(apartSq).toBeLessThanOrEqual(BOW_REACH ** 2);
    expect(apartSq).toBeGreaterThanOrEqual((BOW_REACH - 1) ** 2);
  });

  it("backs a bow off somebody standing inside its minimum range", () => {
    const apartSq = apartSqAfter(yard("hunting-bow", 1), 4000);
    expect(apartSq).toBeGreaterThanOrEqual(BOW_MIN ** 2);
    expect(apartSq).toBeLessThanOrEqual(BOW_REACH ** 2);
  });

  it("walks a melee weapon up beside the target", () => {
    expect(apartSqAfter(yard("iron-mace", 6), 4000)).toBeLessThanOrEqual(2);
  });
});

describe("the bog imp and the cyclops we ship", () => {
  const authored = normalizeTiles(tilesJson as unknown[]);
  const statuses = statusesById(statusesJson as unknown[]);
  const NOON = 12 * 60;
  const MIDNIGHT = 0;

  function field(
    creature: string,
    minutes: number,
    extras: { flameX?: number; aliceX?: number } = {},
  ): GameSession {
    let map = emptyMap();
    for (let x = -20; x <= 20; x++) {
      for (let y = -20; y <= 20; y++) {
        map = replaceStack(map, x, y, 0, [{ tileId: "dirt" }]);
      }
    }
    map = replaceStack(map, 0, 0, 0, [{ tileId: "dirt" }, { tileId: creature }]);
    if (extras.flameX !== undefined) {
      map = replaceStack(map, extras.flameX, 0, 0, [{ tileId: "dirt" }, { tileId: "flame" }]);
    }
    if (extras.aliceX !== undefined) {
      map = replaceStack(map, extras.aliceX, 0, 0, [
        { tileId: "dirt" },
        { tileId: "player", direction: "w", owner: "alice" },
      ]);
    }
    return new GameSession(map, authored, {
      actorIds: ["alice"],
      spawnAt: { x: 20, y: 20, z: 0, stackIndex: 1 },
      seed: 20260925,
      clock: () => minutes,
      statuses,
    });
  }

  function body(session: GameSession, tileId: string) {
    return session.actorSnapshots().find((a) => a.tileId === tileId)!;
  }

  function asleep(session: GameSession, tileId: string): boolean {
    const statusList = session.statusesOf(body(session, tileId).id) ?? [];
    return statusList.some((status) => status.defId === "sleep");
  }

  function noisesOver(session: GameSession, ms: number): string[] {
    const heard: string[] = [];
    for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      for (const noise of session.drainNoise()) heard.push(noise.text);
    }
    return heard;
  }

  it("walks the imp to the nearest flame at night and puts it to sleep beside it", () => {
    const session = field("bog-imp", MIDNIGHT, { flameX: 8 });
    noisesOver(session, 6000);

    const imp = body(session, "bog-imp");
    expect(Math.abs(imp.x - 8) + Math.abs(imp.y)).toBeLessThanOrEqual(2);
    expect(asleep(session, "bog-imp")).toBe(true);
  });

  it("lights a campfire when no flame is near and puts the imp to sleep beside it", () => {
    const session = field("bog-imp", MIDNIGHT);
    noisesOver(session, 6000);

    const imp = body(session, "bog-imp");
    let campfire: { x: number; y: number } | null = null;
    for (let x = imp.x - 2; x <= imp.x + 2; x++) {
      for (let y = imp.y - 2; y <= imp.y + 2; y++) {
        if (getStack(session.getMap(), x, y, 0).some((p) => p.tileId === "campfire")) {
          campfire = { x, y };
        }
      }
    }
    expect(campfire).not.toBeNull();
    expect(asleep(session, "bog-imp")).toBe(true);
  });

  it("opens a hunt by day by throwing a stone at somebody it can see", () => {
    const session = field("bog-imp", NOON, { aliceX: 6 });
    let thrown = false;
    for (let elapsed = 0; elapsed < 3000 && !thrown; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      thrown = session.getSnapshot("alice").projectiles.some((f) => f.tileId === "thrown-stone");
    }

    expect(thrown).toBe(true);
    expect(asleep(session, "bog-imp")).toBe(false);
  });

  it("puts the cyclops to sleep at night with somebody standing in front of it", () => {
    const session = field("cyclops", MIDNIGHT, { aliceX: 3 });

    expect(noisesOver(session, BRAIN_TICK_MS * 10)).toEqual([]);
    expect(asleep(session, "cyclops")).toBe(true);
  });

  it("sends the cyclops after somebody it can see by day", () => {
    expect(noisesOver(field("cyclops", NOON, { aliceX: 3 }), BRAIN_TICK_MS * 2)).toContain(
      "*BELLOW*",
    );
  });
});

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
      wouldStepIntoHazard: () => false,
      walkTo: (goal: WalkGoal): WalkOrderState => standingOrder(built, goal),
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
      cast: vi.fn((): "cast" | "casting" | "no" => "no"),
      extract: vi.fn(() => false),
      consume: vi.fn(() => false),
      consumeOn: vi.fn(() => false),
      carrying: () => false,
      hasStatus: () => false,
      standOff: () => null,
      health: () => 1,
      minutesOfDay: 12 * 60,
      nameOf: (id: string) => id,
      ...overrides,
    } satisfies Parameters<typeof stepBrain>[3];
    return built;
  }

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

  it("steps the way home rather than any way at all", () => {
    const brain = leashed(3);
    const memory = initialMemory(brain);
    const c = ctx();

    stepBrain(brain, memory, BRAIN_TICK_MS, c);

    expect(c.step).toHaveBeenCalledWith("e");
  });

  it("is always far from a home it does not have", () => {
    const brain = leashed(99);
    const memory = initialMemory(brain);
    const c = ctx({ home: null });

    stepBrain(brain, memory, BRAIN_TICK_MS, c);

    expect(memory.state).toBe("homing");
    expect(c.step).not.toHaveBeenCalled();
  });

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

  const SIGHT_CELLS = 7;

  const YARD_SEED = 20260821;

  const OFF_IN_THE_CORNER = { x: -12, y: -12 };

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
        map = replaceStack(map, wallAtX, y, 0, [{ tileId: "dirt" }, { tileId: "stone-wall" }]);
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

  function msToArrive(id: string): number {
    const session = yard([[id, 0, 0]], { x: SIGHT_CELLS, y: 0 });
    for (let elapsed = TICK_MS; elapsed < 5_000; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      if (gapToPlayer(session, id) <= 1) return elapsed;
    }
    return Infinity;
  }

  it("closes at the pace it was authored at, not the brain's", () => {
    const perRound = BRAIN_TICK_MS * 7;
    expect(msToArrive("bat")).toBeGreaterThan(BRAIN_TICK_MS * 3);
    expect(msToArrive("bat")).toBeLessThan(perRound * 0.7);
  });

  it("does not round a slow creature up to a whole round either", () => {
    const snake = msToArrive("snake");
    expect(snake).toBeLessThan(msToArrive("rat") * 2);
    expect(snake).toBeLessThan(BRAIN_TICK_MS * 2 * 6);
  });

  it("leaves a pocket instead of giving up in it", () => {
    let map = emptyMap();
    for (let x = -14; x <= 14; x++) {
      for (let y = -14; y <= 14; y++) {
        map = replaceStack(map, x, y, 0, [{ tileId: "dirt" }]);
      }
    }
    for (const [x, y] of [
      [1, 0],
      [0, -1],
      [0, 1],
    ] as const) {
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
    expect(rabbit.x).toBeGreaterThan(1);
    expect(Math.abs(rabbit.x - -3) + Math.abs(rabbit.y - 0)).toBeGreaterThan(3);
  });

  it.each(["rat", "snake"])("does not see you through a wall: %s", (id) => {
    const session = yard([[id, 0, 0]], { x: 4, y: 0 }, 2);
    const before = gapToPlayer(session, id);

    advance(session, BRAIN_TICK_MS * 3);

    expect(gapToPlayer(session, id)).toBeGreaterThanOrEqual(before);
  });

  it("hisses when it strikes, once", () => {
    const session = yard([["snake", 0, 0]], { x: SIGHT_CELLS, y: 0 });
    const heard: string[] = [];
    for (let elapsed = 0; elapsed < BRAIN_TICK_MS * 4; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      for (const noise of session.drainNoise()) heard.push(noise.text);
    }
    expect(heard).toEqual(["sss"]);
    expect(session.drainSpeech()).toEqual([]);
  });

  it("is weaker than the snake, and quicker off the mark", () => {
    const rat = authored.find((tile) => tile.id === "rat")!;
    const snake = authored.find((tile) => tile.id === "snake")!;
    const stats = (def: typeof rat) => {
      const battler = resolveBattler(def)!;
      return fightingStats(battler, battler.naturalWeapon);
    };

    expect(stats(rat).maxHp).toBeLessThan(stats(snake).maxHp);
    expect(stats(rat).damage).toBeLessThan(stats(snake).damage);
    expect(attackIntervalMs(stats(rat).spd)).toBeLessThan(attackIntervalMs(stats(snake).spd));
  });

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

    expect(closest).toBeLessThan(spread);
  });

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
      if (rats.every((a) => rats.some((b) => a !== b && stepsApart(a, b) === 2))) {
        lockedBeats++;
      }
    }

    const xs = bodies(session, "rat").map((rat) => rat.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(9);
    expect(crowdedBeats / beats).toBeLessThan(0.62);
    expect(lockedBeats / beats).toBeLessThan(0.4);
  });

  it("walks back to the cell it was authored on, not the one it woke in", () => {
    const STRAYED_TO = 11;
    let map = emptyMap();
    for (let x = -12; x <= 12; x++) {
      for (let y = -12; y <= 12; y++) {
        map = replaceStack(map, x, y, 0, [{ tileId: "dirt" }]);
      }
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

    advance(session, BRAIN_TICK_MS * 8);

    expect(bodies(session, "snake")[0]!.x).toBeLessThan(STRAYED_TO);
  });

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
      map = replaceStack(map, WALL_X, y, 0, [{ tileId: "dirt" }, { tileId: "stone-wall" }]);
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

    expect(bodies(session, "snake")[0]!.x).toBeLessThan(WALL_X);
  });

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

const TURN_NOISE = "tick";

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

const FAR_SIGHT_CELLS = 60;

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

const ATTENTION_FIELD = 45;

function withRow(map: MapFile, tileId: string, y: number, x0: number, count: number): MapFile {
  for (let i = 0; i < count; i++) {
    map = withDeer(map, x0 + i, y, tileId);
  }
  return map;
}

function turnsByCell(session: GameSession, into: Map<string, number>) {
  for (const noise of session.drainNoise()) {
    if (noise.text !== TURN_NOISE) continue;
    const key = `${noise.x},${noise.y}`;
    into.set(key, (into.get(key) ?? 0) + 1);
  }
}

function alignToRounds(session: GameSession) {
  advance(session, BRAIN_TICK_MS - TICK_MS);
}

function roundOfTurns(session: GameSession, into: Map<string, number>) {
  for (let elapsed = 0; elapsed < BRAIN_TICK_MS; elapsed += TICK_MS) {
    session.tick(TICK_MS);
    turnsByCell(session, into);
  }
}

function turnsOver(session: GameSession, rounds: number): Map<string, number> {
  alignToRounds(session);
  const turns = new Map<string, number>();
  for (let round = 0; round < rounds; round++) roundOfTurns(session, turns);
  return turns;
}

describe("who gets a turn", () => {
  const ROUNDS = 6;
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

  it("spreads a crowded round over its ticks and takes a small one whole", () => {
    const perTick = (count: number) => {
      const session = new GameSession(
        withRow(field(ATTENTION_FIELD), "ticker", FAR_ROW_Y, FAR_ROW_X0, count),
        attention,
        { actorIds: ["alice"] },
      );
      alignToRounds(session);
      const counts: number[] = [];
      for (let elapsed = 0; elapsed < BRAIN_TICK_MS; elapsed += TICK_MS) {
        const turns = new Map<string, number>();
        session.tick(TICK_MS);
        turnsByCell(session, turns);
        counts.push([...turns.values()].reduce((sum, n) => sum + n, 0));
      }
      return counts;
    };

    const crowded = perTick(BRAIN_DOZE_BUDGET * 3);
    expect(crowded.reduce((sum, n) => sum + n, 0)).toBe(BRAIN_DOZE_BUDGET);
    expect(crowded[0]).toBe(BRAIN_TURNS_PER_TICK_MIN);
    expect(Math.max(...crowded)).toBeLessThanOrEqual(BRAIN_TURNS_PER_TICK_MIN);

    const small = perTick(3);
    expect(small[0]).toBe(3);
    expect(small.slice(1).every((n) => n === 0)).toBe(true);
  });

  it("spends exactly the budget on them each round", () => {
    const session = new GameSession(
      withRow(field(ATTENTION_FIELD), "ticker", FAR_ROW_Y, FAR_ROW_X0, BRAIN_DOZE_BUDGET * 3),
      attention,
      { actorIds: ["alice"] },
    );

    alignToRounds(session);
    for (let round = 0; round < ROUNDS; round++) {
      const turns = new Map<string, number>();
      roundOfTurns(session, turns);
      expect([...turns.values()].reduce((sum, n) => sum + n, 0)).toBe(BRAIN_DOZE_BUDGET);
    }
  });

  it("gives every turn to a creature within a screen of somebody", () => {
    let map = withRow(
      field(ATTENTION_FIELD),
      "ticker",
      FAR_ROW_Y,
      FAR_ROW_X0,
      BRAIN_DOZE_BUDGET * 3,
    );
    const near = { x: -ATTENTION_FIELD + BRAIN_ATTENTION_FLOOR_CELLS, y: -ATTENTION_FIELD };
    map = withDeer(map, near.x, near.y, "ticker");
    const session = new GameSession(map, attention, { actorIds: ["alice"] });

    const turns = turnsOver(session, ROUNDS);

    expect(turns.get(`${near.x},${near.y}`)).toBe(ROUNDS);
  });

  it("reaches as far as the creature's own brain looks", () => {
    const apart = FAR_SIGHT_CELLS - 10;
    let map = withRow(
      field(ATTENTION_FIELD),
      "ticker",
      FAR_ROW_Y,
      FAR_ROW_X0,
      BRAIN_DOZE_BUDGET * 3,
    );
    const farSighted = { x: -ATTENTION_FIELD + apart, y: -ATTENTION_FIELD };
    const shortSighted = { x: -ATTENTION_FIELD + apart, y: -ATTENTION_FIELD + 2 };
    map = withDeer(map, farSighted.x, farSighted.y, "ticker-far-sighted");
    map = withDeer(map, shortSighted.x, shortSighted.y, "ticker");
    const session = new GameSession(map, attention, { actorIds: ["alice"] });

    const turns = turnsOver(session, ROUNDS);

    expect(turns.get(`${farSighted.x},${farSighted.y}`)).toBe(ROUNDS);
    expect(turns.get(`${shortSighted.x},${shortSighted.y}`)).toBeLessThan(ROUNDS);
  });

  it("stops when the state that gave the order does", () => {
    const START = { x: -ATTENTION_FIELD + 5, y: -ATTENTION_FIELD };
    const HOME = { x: START.x, y: START.y + 8 };
    let map = field(ATTENTION_FIELD);
    map = replaceStack(map, START.x, START.y, 0, [
      { tileId: "grass" },
      { tileId: "ticker-quitter", owner: `npc:${HOME.x},${HOME.y},0,1` },
    ]);
    const session = new GameSession(map, attention, { actorIds: ["alice"] });

    const cell = () => {
      const quitter = session.actorSnapshots().find((actor) => actor.tileId === "ticker-quitter")!;
      return `${quitter.x},${quitter.y}`;
    };

    const started = cell();
    advance(session, BRAIN_TICK_MS * 3);
    const whenItGaveUp = cell();
    advance(session, BRAIN_TICK_MS * 6);

    expect(whenItGaveUp).not.toBe(started);
    expect(cell()).toBe(whenItGaveUp);
  });

  it("walks a dozing creature at the budget's pace, not its own", () => {
    const HOME = { x: 0, y: FAR_ROW_Y - 20 };
    let map = field(ATTENTION_FIELD);
    map = replaceStack(map, 0, FAR_ROW_Y, 0, [
      { tileId: "grass" },
      { tileId: "ticker-walker", owner: `npc:${HOME.x},${HOME.y},0,1` },
    ]);
    const session = new GameSession(map, attention, { actorIds: ["alice"] });

    const walkerCell = () => {
      const walker = session.actorSnapshots().find((actor) => actor.tileId === "ticker-walker")!;
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

    expect(steps).toBeGreaterThan(0);
    expect(steps).toBeLessThanOrEqual(ROUNDS);
  });

  it("hands a dozing creature the time it slept through", () => {
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

describe("browsing a bush", () => {
  const BUSH_CELLS = 6;
  const PULL_MS = BRAIN_TICK_MS * 8;

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
          if: group<BrainConditionDef>("and", [{ cond: "carrying", tileId: "berry" }], true),
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

  function hedge(bodyTileId = "browser"): GameSession {
    let map = field(6);
    map = replaceStack(map, -6, -6, 0, [{ tileId: "grass" }]);
    map = withDeer(map, 0, 0, bodyTileId);
    map = replaceStack(map, 3, 0, 0, [{ tileId: "grass" }, { tileId: "bush" }]);
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

    expect(tilesAt(session, 3, 0)).toEqual(["grass", "picked-bush"]);
    expect(tilesAt(session, 2, 0)).toEqual(["grass"]);
  });

  it("holds the line it is picking on rather than wandering off mid-pull", () => {
    const session = hedge();

    advance(session, BRAIN_TICK_MS * 4);
    const standing = deerCell(session);
    expect(standing).toBe("2,0");

    advance(session, PULL_MS / 2);

    expect(deerCell(session)).toBe(standing);
  });
});

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
      wouldStepIntoHazard: () => false,
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
      cast: vi.fn((): "cast" | "casting" | "no" => "no"),
      extract: vi.fn(() => true),
      consume: vi.fn(() => false),
      consumeOn: vi.fn(() => false),
      carrying: () => false,
      hasStatus: () => false,
      standOff: () => null,
      health: () => 1,
      minutesOfDay: 12 * 60,
      nameOf: (id: string) => id,
      ...overrides,
    } satisfies Parameters<typeof stepBrain>[3];
    return built;
  }

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

  it("ignores the order inside a list", () => {
    expect(
      slotTiles(bindingFrom(nearest("deer", "rabbit"), nearest("rabbit", "deer")), "quarry"),
    ).toHaveLength(2);
    expect(
      slotTiles(bindingFrom(nearest("deer", "rabbit"), nearest("rabbit", "wolf")), "quarry"),
    ).toEqual([]);
  });

  it("is nothing when they disagree, or when one names no tile", () => {
    expect(slotTiles(bindingFrom(thing("bush"), nearest("wolf")), "quarry")).toEqual([]);
    expect(slotTiles(bindingFrom(SPEAKER_SELECTOR), "quarry")).toEqual([]);
  });

  it("is nothing for a name no transition binds", () => {
    expect(slotTiles(bindingFrom(thing("bush")), "nobody")).toEqual([]);
  });
});

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
      wouldStepIntoHazard: () => false,
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
      cast: vi.fn((): "cast" | "casting" | "no" => "no"),
      extract: vi.fn(() => false),
      consume: vi.fn(() => false),
      consumeOn: vi.fn(() => true),
      carrying: () => false,
      hasStatus: vi.fn(() => false),
      standOff: () => null,
      health: vi.fn((): number | null => 1),
      minutesOfDay: 12 * 60,
      nameOf: (id: string) => id,
      ...overrides,
    } satisfies Parameters<typeof stepBrain>[3];
    return built;
  }

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

  it("reads hunger as the absence of enough fed", () => {
    const hungry = watching(
      group<BrainConditionDef>("and", [{ cond: "status", id: "fed", atLeastMs: SATED_MS }], true),
    );

    expect(ran(hungry, ctx({ hasStatus: () => false }))).toBe("alert");
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

  describe("asking how hurt it is", () => {
    const wounded = watching({ cond: "health", atMostPercent: 30 });

    it("holds below the threshold and not above it", () => {
      expect(ran(wounded, ctx({ health: () => 0.2 }))).toBe("alert");
      expect(ran(wounded, ctx({ health: () => 0.5 }))).toBe("idle");
    });

    it("holds at exactly the threshold", () => {
      expect(ran(wounded, ctx({ health: () => 0.3 }))).toBe("alert");
    });

    it("never holds for a body with no hit points", () => {
      expect(
        ran(watching({ cond: "health", atMostPercent: 100 }), ctx({ health: () => null })),
      ).toBe("idle");
    });

    it("reads its `not` as unhurt", () => {
      const fresh = watching(
        group<BrainConditionDef>("and", [{ cond: "health", atMostPercent: 30 }], true),
      );
      expect(ran(fresh, ctx({ health: () => 1 }))).toBe("alert");
      expect(ran(fresh, ctx({ health: () => 0.1 }))).toBe("idle");
    });
  });

  describe("asking the time", () => {
    const night = watching({ cond: "time_of_day", fromHour: 19, toHour: 5 });
    const at = (hour: number, minute = 0) => ctx({ minutesOfDay: hour * 60 + minute });

    it("holds through midnight and not by day", () => {
      expect(ran(night, at(22))).toBe("alert");
      expect(ran(night, at(2))).toBe("alert");
      expect(ran(night, at(12))).toBe("idle");
    });

    it("holds from its first hour and stops at its last", () => {
      expect(ran(night, at(18, 59))).toBe("idle");
      expect(ran(night, at(19))).toBe("alert");
      expect(ran(night, at(4, 59))).toBe("alert");
      expect(ran(night, at(5))).toBe("idle");
    });

    it("reads a window that does not wrap", () => {
      const day = watching({ cond: "time_of_day", fromHour: 6, toHour: 18 });
      expect(ran(day, at(6))).toBe("alert");
      expect(ran(day, at(17, 59))).toBe("alert");
      expect(ran(day, at(18))).toBe("idle");
      expect(ran(day, at(3))).toBe("idle");
    });

    it("never holds when both ends are the same hour", () => {
      const empty = watching({ cond: "time_of_day", fromHour: 7, toHour: 7 });
      expect(ran(empty, at(7))).toBe("idle");
      expect(ran(empty, at(20))).toBe("idle");
    });
  });

  describe("asking how deep it is", () => {
    const underground = watching({ cond: "below_level", level: 0 });
    const onLevel = (z: number) => ctx({ self: { x: 0, y: 0, z } });

    it("holds below the level and not on or above it", () => {
      expect(ran(underground, onLevel(-1))).toBe("alert");
      expect(ran(underground, onLevel(0))).toBe("idle");
      expect(ran(underground, onLevel(2))).toBe("idle");
    });
  });
});

describe("casting a spell of its own", () => {
  function ctx(overrides: Partial<Parameters<typeof stepBrain>[3]> = {}) {
    const built = {
      busy: false,
      rng: new Rng(1),
      self: { x: 0, y: 0, z: 0 },
      home: null,
      nearestOnTile: () => "player",
      nearestThing: () => null,
      thingStillThere: () => true,
      positionOf: () => ({ x: 2, y: 0, z: 0 }),
      wouldDrop: () => false,
      wouldStepIntoHazard: () => false,
      walkTo: vi.fn((): WalkOrderState => "walking"),
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
      cast: vi.fn((): "cast" | "casting" | "no" => "cast"),
      extract: vi.fn(() => false),
      consume: vi.fn(() => false),
      consumeOn: vi.fn(() => false),
      carrying: () => false,
      hasStatus: () => false,
      standOff: () => null,
      health: () => 1,
      minutesOfDay: 12 * 60,
      nameOf: (id: string) => id,
      ...overrides,
    } satisfies Parameters<typeof stepBrain>[3];
    return built;
  }

  const casting: BrainDef = {
    initial: "hunting",
    states: {
      hunting: {
        do: [
          { action: "cast", spell: 2, of: nearest("player") },
          { action: "step_toward", of: nearest("player") },
        ],
      },
    },
    transitions: [],
  };

  it("names the spell's position and whom it is aimed at", () => {
    const c = ctx();
    stepBrain(casting, initialMemory(casting), BRAIN_TICK_MS, c);
    expect(c.cast).toHaveBeenCalledWith(2, "player");
  });

  it("stops the list where it lands", () => {
    const c = ctx();
    stepBrain(casting, initialMemory(casting), BRAIN_TICK_MS, c);
    expect(c.walkTo).not.toHaveBeenCalled();
  });

  it("falls through to the next line when it is refused", () => {
    const c = ctx({ cast: vi.fn((): "cast" | "casting" | "no" => "no") });
    stepBrain(casting, initialMemory(casting), BRAIN_TICK_MS, c);
    expect(c.walkTo).toHaveBeenCalled();
  });

  it("holds the line while a bar is running", () => {
    const c = ctx({ cast: vi.fn((): "cast" | "casting" | "no" => "casting") });
    stepBrain(casting, initialMemory(casting), BRAIN_TICK_MS, c);
    expect(c.walkTo).not.toHaveBeenCalled();
  });

  it("casts at nobody rather than failing", () => {
    const c = ctx({ nearestOnTile: () => null });
    stepBrain(casting, initialMemory(casting), BRAIN_TICK_MS, c);
    expect(c.cast).toHaveBeenCalledWith(2, null);
  });
});
