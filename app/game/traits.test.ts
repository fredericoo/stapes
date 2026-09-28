import { describe, expect, it } from "vitest";
import type { Selector } from "../lib/brain";
import { emptyMap, replaceStack } from "../lib/mapData";
import { FRAME, tile } from "../lib/testTile";
import {
  checkBrain,
  checkTrait,
  expandBrain,
  traitsById,
  type AuthoredBrain,
  type TraitCatalogue,
} from "../lib/traits";
import { initialMemory, stepBrain, type BrainMemory } from "./brainRuntime";
import { BRAIN_TICK_MS, TICK_MS } from "./constants";
import { GameSession } from "./GameSession";
import { brainContext } from "./testBrainContext";

const slot = (name: string): Selector => ({ type: "slot", data: { name } });

const NIGHT = { cond: "time_of_day", fromHour: 19, toHour: 6 } as const;
const MIDNIGHT = 0;
const NOON = 12 * 60;

const CATALOGUE: TraitCatalogue = traitsById([
  {
    id: "fights-back",
    name: "Fights back",
    params: {
      fight: { kind: "state", band: "fight" },
      target: { kind: "slot", holds: "body" },
      calm: { kind: "cells", default: 12 },
    },
    triggers: [
      {
        band: "danger",
        retarget: true,
        if: { cond: "attacked" },
        bind: { target: { type: "attacker" } },
        to: "fight",
      },
    ],
    transitions: [
      {
        from: "fight",
        if: { cond: "out_of_range", of: slot("target"), cells: { arg: "calm" } },
        to: "rest",
      },
    ],
  },
  {
    id: "sleeps",
    name: "Sleeps",
    params: { while: { kind: "condition" } },
    states: { sleeping: { band: "rest", do: [{ action: "hold" }] } },
    triggers: [{ if: { arg: "while" }, to: "sleeping" }],
    transitions: [
      {
        from: "sleeping",
        if: { combinator: "and", not: true, rules: [{ arg: "while" }] },
        to: "rest",
      },
    ],
  },
  {
    id: "returns-home",
    name: "Returns home",
    params: { leash: { kind: "cells" } },
    states: {
      homing: { band: "roam", do: [{ action: "step_toward", of: { type: "home" } }] },
    },
    triggers: [
      {
        band: "errand",
        if: { cond: "out_of_range", of: { type: "home" }, cells: { arg: "leash" } },
        to: "homing",
      },
    ],
    transitions: [
      { from: "homing", if: { cond: "in_range", of: { type: "home" }, cells: 1 }, to: "rest" },
    ],
  },
  {
    id: "investigates-noises",
    name: "Investigates noises",
    params: { within: { kind: "cells" }, cry: { kind: "text", optional: true } },
    slots: { source: "body" },
    states: {
      investigating: {
        band: "errand",
        onEnter: [{ effect: "noise", text: { arg: "cry" } }],
        do: [{ action: "step_toward", of: slot("source") }],
      },
    },
    triggers: [
      {
        if: { cond: "heard_noise", cells: { arg: "within" } },
        bind: { source: { type: "speaker" } },
        to: "investigating",
      },
    ],
    transitions: [{ from: "investigating", if: { cond: "after", ms: 5000 }, to: "rest" }],
  },
  {
    id: "eats",
    name: "Eats",
    params: { food: { kind: "things" }, urge: { kind: "band", default: "need" } },
    slots: { meal: "thing" },
    states: { feeding: { band: "need", do: [{ action: "consume", of: slot("meal") }] } },
    triggers: [
      {
        band: { arg: "urge" },
        retarget: true,
        if: { cond: "in_los", of: { type: "thing", data: { tileIds: { arg: "food" } } }, cells: 9 },
        bind: { meal: { type: "thing", data: { tileIds: { arg: "food" } } } },
        to: "feeding",
      },
    ],
  },
  {
    id: "stalks",
    name: "Stalks",
    params: { prey: { kind: "bodies" } },
    slots: { quarry: "body" },
    states: { stalking: { band: "errand", do: [{ action: "step_toward", of: slot("quarry") }] } },
    triggers: [
      {
        if: {
          cond: "in_los",
          of: { type: "nearest", data: { tileIds: { arg: "prey" } } },
          cells: 9,
        },
        bind: { quarry: { type: "nearest", data: { tileIds: { arg: "prey" } } } },
        to: "stalking",
      },
    ],
  },
  {
    id: "dives",
    name: "Dives",
    params: { prey: { kind: "bodies" } },
    slots: { quarry: "body" },
    states: {
      diving: { band: "fight", do: [{ action: "hold" }] },
      veering: { band: "need", do: [{ action: "hold" }] },
    },
    triggers: [
      {
        retarget: true,
        if: {
          cond: "in_los",
          of: { type: "nearest", data: { tileIds: { arg: "prey" } } },
          cells: 8,
        },
        bind: { quarry: { type: "nearest", data: { tileIds: { arg: "prey" } } } },
        to: "diving",
      },
    ],
    transitions: [{ from: "diving", if: { cond: "after", ms: 0 }, to: "veering" }],
  },
  {
    id: "flee",
    name: "Flee",
    params: { from: { kind: "slot", holds: "body" } },
    states: { fleeing: { band: "danger", do: [{ action: "step_away_from", of: slot("from") }] } },
    transitions: [
      { from: "fleeing", if: { cond: "out_of_range", of: slot("from"), cells: 8 }, to: "rest" },
    ],
    returns: "fleeing",
  },
  {
    id: "predator",
    name: "Predator",
    params: {
      fight: { kind: "state", band: "fight" },
      target: { kind: "slot", holds: "body" },
      leash: { kind: "cells" },
    },
    traits: [
      { trait: "fights-back", with: { fight: "fight", target: "target" } },
      { trait: "returns-home", with: { leash: { arg: "leash" } } },
    ],
  },
]);

function wolf(traits: AuthoredBrain["traits"]): AuthoredBrain {
  return {
    initial: "prowling",
    states: {
      prowling: { do: [{ action: "hold" }] },
      hunting: { do: [{ action: "attack", of: slot("prey") }, { action: "hold" }] },
    },
    transitions: [],
    traits,
  };
}

function expanded(authored: AuthoredBrain) {
  const { brain, issues } = expandBrain(authored, CATALOGUE, "wolf");
  expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
  return brain!;
}

function stateOf(state: string): (name: string) => boolean {
  return (name) => name === state || name.endsWith(`/${state}`);
}

function startIn(brain: ReturnType<typeof expanded>, state: string): BrainMemory {
  const name = Object.keys(brain.states).find(stateOf(state));
  expect(name, `a state called ${state}`).toBeDefined();
  return { ...initialMemory(brain), state: name!, started: true };
}

function isIn(memory: BrainMemory, state: string): boolean {
  return stateOf(state)(memory.state);
}

const PREDATOR_AND_SLEEPER = wolf([
  { trait: "predator", with: { fight: "hunting", target: "prey", leash: 10 } },
  { trait: "sleeps", with: { while: NIGHT } },
]);

describe("a brain built from traits", () => {
  it("turns on whoever hits it, even asleep", () => {
    const brain = expanded(PREDATOR_AND_SLEEPER);
    const memory = startIn(brain, "sleeping");
    const c = brainContext({ minutesOfDay: MIDNIGHT, hurtBy: () => ["alice"] });

    stepBrain(brain, memory, BRAIN_TICK_MS, c);

    expect(memory.state).toBe("hunting");
    expect(c.attack).toHaveBeenCalledWith("alice");
  });

  it("does not fall asleep in the middle of a fight", () => {
    const brain = expanded(PREDATOR_AND_SLEEPER);
    const memory = startIn(brain, "hunting");
    memory.blackboard.prey = { kind: "body", id: "alice" };
    const c = brainContext({ minutesOfDay: MIDNIGHT, positionOf: () => ({ x: 1, y: 0, z: 0 }) });

    stepBrain(brain, memory, BRAIN_TICK_MS, c);

    expect(memory.state).toBe("hunting");
  });

  it("goes to sleep on its way home, from the same bundle as the fight it will not leave", () => {
    const brain = expanded(PREDATOR_AND_SLEEPER);
    const memory = startIn(brain, "homing");
    const c = brainContext({ minutesOfDay: MIDNIGHT, home: { x: 20, y: 0, z: 0 } });

    stepBrain(brain, memory, BRAIN_TICK_MS, c);

    expect(isIn(memory, "sleeping")).toBe(true);
  });

  it("goes back to the state it started in once the fight is over", () => {
    const brain = expanded(PREDATOR_AND_SLEEPER);
    const memory = startIn(brain, "hunting");
    memory.blackboard.prey = { kind: "body", id: "alice" };
    const c = brainContext({ minutesOfDay: NOON, positionOf: () => ({ x: 30, y: 0, z: 0 }) });

    stepBrain(brain, memory, BRAIN_TICK_MS, c);

    expect(memory.state).toBe("prowling");
  });

  it("turns on a second attacker in the middle of a fight with the first", () => {
    const brain = expanded(PREDATOR_AND_SLEEPER);
    const memory = startIn(brain, "hunting");
    memory.blackboard.prey = { kind: "body", id: "alice" };
    const c = brainContext({
      hurtBy: () => ["bob"],
      positionOf: () => ({ x: 1, y: 0, z: 0 }),
    });

    stepBrain(brain, memory, BRAIN_TICK_MS, c);

    expect(c.attack).toHaveBeenCalledWith("bob");
  });

  it("keeps re-pointing a state it is in ahead of that state's own way out", () => {
    const brain = expanded(wolf([{ trait: "dives", with: { prey: ["player"] } }]));
    const inView = brainContext({
      nearestOnTile: () => "alice",
      positionOf: () => ({ x: 3, y: 0, z: 0 }),
    });
    const diving = startIn(brain, "diving");
    const lostSight = startIn(brain, "diving");

    stepBrain(brain, diving, BRAIN_TICK_MS, inView);
    stepBrain(brain, lostSight, BRAIN_TICK_MS, brainContext());

    expect(isIn(diving, "diving")).toBe(true);
    expect(isIn(lostSight, "veering")).toBe(true);
  });

  describe("errands and the walk home", () => {
    const troll = wolf([
      { trait: "returns-home", with: { leash: 8 } },
      { trait: "investigates-noises", with: { within: 20 } },
    ]);
    const farFromHome = { home: { x: 30, y: 0, z: 0 } };
    const noise = () => [{ sourceId: "alice", text: "clang" }];

    it("leaves the walk home to go and look at a sound", () => {
      const brain = expanded(troll);
      const memory = startIn(brain, "homing");
      const c = brainContext({
        ...farFromHome,
        heardNoise: noise,
        positionOf: () => ({ x: 3, y: 0, z: 0 }),
      });

      stepBrain(brain, memory, BRAIN_TICK_MS, c);

      expect(isIn(memory, "investigating")).toBe(true);
    });

    it("does not give up on a sound to go home", () => {
      const brain = expanded(troll);
      const memory = startIn(brain, "investigating");
      const c = brainContext(farFromHome);

      stepBrain(brain, memory, BRAIN_TICK_MS, c);

      expect(isIn(memory, "investigating")).toBe(true);
    });

    it("goes home first when both call at once from its idle state", () => {
      const brain = expanded(troll);
      const memory = startIn(brain, "prowling");
      const c = brainContext({
        ...farFromHome,
        heardNoise: noise,
        positionOf: () => ({ x: 3, y: 0, z: 0 }),
      });

      stepBrain(brain, memory, BRAIN_TICK_MS, c);

      expect(isIn(memory, "homing")).toBe(true);
    });
  });

  describe("an urge stronger than its state", () => {
    const hungry = wolf([
      { trait: "fights-back", with: { fight: "hunting", target: "prey" } },
      { trait: "eats", with: { food: ["raw-meat"], urge: "danger" } },
    ]);
    const meat = { at: { x: 3, y: 0, z: 0 }, tileId: "raw-meat" };

    it("drops a fight for food it can see", () => {
      const brain = expanded(hungry);
      const memory = startIn(brain, "hunting");
      memory.blackboard.prey = { kind: "body", id: "alice" };
      const c = brainContext({
        nearestThing: () => meat,
        thingStillThere: () => true,
        positionOf: () => ({ x: 1, y: 0, z: 0 }),
      });

      stepBrain(brain, memory, BRAIN_TICK_MS, c);

      expect(isIn(memory, "feeding")).toBe(true);
    });

    it("still turns on a fresh blow while it eats", () => {
      const brain = expanded(hungry);
      const memory = startIn(brain, "feeding");
      const c = brainContext({
        nearestThing: () => meat,
        thingStillThere: () => true,
        hurtBy: () => ["alice"],
      });

      stepBrain(brain, memory, BRAIN_TICK_MS, c);

      expect(memory.state).toBe("hunting");
    });

    it("keeps to its fight when the urge is only a need", () => {
      const brain = expanded(
        wolf([
          { trait: "fights-back", with: { fight: "hunting", target: "prey" } },
          { trait: "eats", with: { food: ["raw-meat"] } },
        ]),
      );
      const memory = startIn(brain, "hunting");
      memory.blackboard.prey = { kind: "body", id: "alice" };
      const c = brainContext({
        nearestThing: () => meat,
        thingStillThere: () => true,
        positionOf: () => ({ x: 1, y: 0, z: 0 }),
      });

      stepBrain(brain, memory, BRAIN_TICK_MS, c);

      expect(memory.state).toBe("hunting");
    });
  });

  it("runs from whoever hits it when handed a routine to run with", () => {
    const brain = expanded(
      wolf([
        {
          trait: "fights-back",
          with: { fight: { trait: "flee", with: { from: "prey" } }, target: "prey" },
        },
      ]),
    );
    const memory = initialMemory(brain);
    const threat = { x: -1, y: 0, z: 0 };
    const fled: unknown[] = [];
    const c = brainContext({
      hurtBy: () => ["alice"],
      positionOf: () => threat,
      fleeFrom: (from) => {
        fled.push(from);
        return "walking";
      },
    });

    stepBrain(brain, memory, BRAIN_TICK_MS, c);

    expect(isIn(memory, "fleeing")).toBe(true);
    expect(fled).toEqual([threat]);
  });

  it("calls the same trait twice without the two sharing a state or a slot", () => {
    const brain = expanded(
      wolf([
        { trait: "stalks", with: { prey: ["deer"] } },
        { trait: "stalks", with: { prey: ["rabbit"] } },
      ]),
    );
    const memory = initialMemory(brain);
    const walkedTo: unknown[] = [];
    const c = brainContext({
      nearestOnTile: (tileIds) => (tileIds.includes("rabbit") ? "thumper" : null),
      positionOf: () => ({ x: 4, y: 0, z: 0 }),
      walkTo: (goal) => {
        walkedTo.push(goal);
        return "walking";
      },
    });

    stepBrain(brain, memory, BRAIN_TICK_MS, c);

    expect(Object.keys(brain.states).filter(stateOf("stalking"))).toHaveLength(2);
    expect(isIn(memory, "stalking")).toBe(true);
    expect(walkedTo).toEqual([{ of: "body", id: "thumper" }]);
  });

  it("reads a let in the brain's own rows, not only in its calls", () => {
    const brain = expanded({
      initial: "prowling",
      states: { prowling: { do: [{ action: "hold" }] }, resting: { do: [{ action: "hold" }] } },
      transitions: [{ from: "prowling", if: { arg: "night" }, to: "resting" }],
      let: { night: { kind: "condition", value: NIGHT } },
    });
    const atMidnight = initialMemory(brain);
    const atNoon = initialMemory(brain);

    stepBrain(brain, atMidnight, BRAIN_TICK_MS, brainContext({ minutesOfDay: MIDNIGHT }));
    stepBrain(brain, atNoon, BRAIN_TICK_MS, brainContext({ minutesOfDay: NOON }));

    expect(atMidnight.state).toBe("resting");
    expect(atNoon.state).toBe("prowling");
  });

  it("leaves out a line whose optional argument was not given", () => {
    const quiet = expanded(wolf([{ trait: "investigates-noises", with: { within: 20 } }]));
    const loud = expanded(
      wolf([{ trait: "investigates-noises", with: { within: 20, cry: "sniff" } }]),
    );
    const noisesFrom = (brain: typeof quiet) => {
      const heard: string[] = [];
      const c = brainContext({
        heardNoise: () => [{ sourceId: "alice", text: "clang" }],
        positionOf: () => ({ x: 3, y: 0, z: 0 }),
        noise: (text) => heard.push(text),
      });
      stepBrain(brain, initialMemory(brain), BRAIN_TICK_MS, c);
      return heard;
    };

    expect(noisesFrom(quiet)).toEqual([]);
    expect(noisesFrom(loud)).toEqual(["sniff"]);
  });

  it("leaves out every row into an optional state that was not handed one", () => {
    const catalogue = traitsById([
      {
        id: "answers",
        name: "Answers",
        params: { talk: { kind: "state", optional: true } },
        states: { startled: { band: "need", do: [{ action: "hold" }] } },
        triggers: [
          { if: { cond: "attacked" }, to: "startled" },
          { band: "roam", if: { cond: "talking" }, to: "talk" },
        ],
        transitions: [
          { from: "startled", if: { cond: "after", ms: 1000 }, to: "rest" },
          { from: "startled", if: { cond: "talking" }, to: "talk" },
        ],
      },
    ]);
    const answering = (call: AuthoredBrain["traits"]) => {
      const { brain, issues } = expandBrain(wolf(call), catalogue);
      expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
      const talking = brain!.transitions.filter(
        (row) => "cond" in row.if && row.if.cond === "talking",
      );
      return talking.map((row) => row.to);
    };

    expect(answering([{ trait: "answers" }])).toEqual([]);
    expect(answering([{ trait: "answers", with: { talk: "hunting" } }])).toEqual([
      "hunting",
      "hunting",
    ]);
  });

  it("waits a fixed time when the far end of a ranged wait is left out", () => {
    const catalogue = traitsById([
      {
        id: "dawdles",
        name: "Dawdles",
        params: { upTo: { kind: "ms", optional: true } },
        states: { dawdling: { band: "roam", do: [{ action: "hold" }] } },
        triggers: [{ if: { cond: "stuck" }, to: "dawdling" }],
        transitions: [
          { from: "dawdling", if: { cond: "after", ms: 1000, toMs: { arg: "upTo" } }, to: "rest" },
        ],
      },
    ]);
    const waitIn = (call: AuthoredBrain["traits"]) =>
      expandBrain(wolf(call), catalogue).brain?.transitions.find((row) => row.to === "prowling")
        ?.if;

    expect(waitIn([{ trait: "dawdles" }])).toEqual({ cond: "after", ms: 1000 });
    expect(waitIn([{ trait: "dawdles", with: { upTo: 4000 } }])).toEqual({
      cond: "after",
      ms: 1000,
      toMs: 4000,
    });
  });
});

describe("a world given the trait catalogue", () => {
  const yelper = tile({
    id: "yelper",
    height: 2,
    actor: true,
    walkable: false,
    interactions: {
      brain: {
        initial: "idle",
        states: { idle: { do: [{ action: "hold" }] } },
        transitions: [],
        traits: [{ trait: "yelps" }],
      },
    },
  });
  const yelps = traitsById([
    {
      id: "yelps",
      name: "Yelps",
      states: {
        yelping: {
          band: "errand",
          onEnter: [{ effect: "noise", text: "yip" }],
          do: [{ action: "hold" }],
        },
      },
      triggers: [{ if: { cond: "after", ms: 0 }, to: "yelping" }],
    },
  ]);

  function noisesIn(session: GameSession): string[] {
    const heard: string[] = [];
    for (let elapsed = 0; elapsed < BRAIN_TICK_MS * 2; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      for (const noise of session.drainNoise()) heard.push(noise.text);
    }
    return heard;
  }

  function world(catalogue?: TraitCatalogue): GameSession {
    let map = emptyMap();
    for (let x = -3; x <= 3; x++) {
      for (let y = -3; y <= 3; y++) map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
    map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "yelper" }]);
    map = replaceStack(map, 2, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "w", owner: "alice" },
    ]);
    const tiles = [
      tile({ id: "grass", height: 0 }),
      tile({
        id: "player",
        height: 4,
        directional: true,
        walkable: false,
        variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
      }),
      yelper,
    ];
    return new GameSession(map, tiles, {
      actorIds: ["alice"],
      spawnAt: { x: 3, y: 3, z: 0, stackIndex: 1 },
      ...(catalogue ? { traits: catalogue } : {}),
    });
  }

  it("runs a creature whose brain is built from traits", () => {
    expect(noisesIn(world(yelps))).toEqual(["yip"]);
  });

  it("leaves a creature inert when a trait it calls is missing", () => {
    expect(noisesIn(world())).toEqual([]);
  });
});

describe("checking traits", () => {
  function traitWith(overrides: Record<string, unknown>) {
    return traitsById([{ id: "under-test", name: "Under test", ...overrides }]);
  }

  it("refuses an argument used where a different kind of value goes", () => {
    const catalogue = traitWith({
      params: { patience: { kind: "ms" } },
      triggers: [
        { if: { cond: "in_range", of: { type: "home" }, cells: { arg: "patience" } }, to: "rest" },
      ],
    });

    expect(checkTrait(catalogue["under-test"]!, catalogue)).toContainEqual({
      severity: "error",
      message:
        "under-test › trigger 1 › if › cells: wants a distance in cells, and patience is a time in ms",
    });
  });

  it("refuses a trait that ends up calling itself", () => {
    const catalogue = traitsById([
      { id: "a", name: "A", traits: [{ trait: "b" }] },
      { id: "b", name: "B", traits: [{ trait: "a" }] },
    ]);

    expect(checkTrait(catalogue.a!, catalogue)).toContainEqual({
      severity: "error",
      message: "a: calls itself through a › b › a",
    });
  });

  it("refuses an attack on a slot that holds a thing", () => {
    const catalogue = traitWith({
      slots: { meal: "thing" },
      states: { biting: { do: [{ action: "attack", of: slot("meal") }] } },
    });

    expect(checkTrait(catalogue["under-test"]!, catalogue)).toContainEqual({
      severity: "error",
      message: "under-test › state biting › do › 1 › of: wants a body, and this names a thing",
    });
  });

  it("refuses a switch on a slot that holds a body", () => {
    const catalogue = traitWith({
      slots: { lamp: "body" },
      states: { lighting: { do: [{ action: "switch", of: slot("lamp") }] } },
    });

    expect(checkTrait(catalogue["under-test"]!, catalogue)).toContainEqual({
      severity: "error",
      message: "under-test › state lighting › do › 1 › of: wants a thing, and this names a body",
    });
  });

  it("names the call and the parameter a brain left out", () => {
    const issues = checkBrain(
      wolf([{ trait: "predator", with: { fight: "hunting" } }]),
      CATALOGUE,
      {},
      "wolf",
    );

    expect(issues).toEqual([
      { severity: "error", message: "wolf › call 1 › predator leash: needs a distance in cells" },
    ]);
  });

  it("refuses a body list naming a tile nothing can be", () => {
    const issues = checkBrain(
      wolf([{ trait: "stalks", with: { prey: ["deer", "bush"] } }]),
      CATALOGUE,
      { bodies: new Set(["player", "deer"]) },
      "wolf",
    );

    expect(issues).toEqual([
      { severity: "error", message: "wolf › call 1 › stalks prey: bush cannot be a body" },
    ]);
  });
});
