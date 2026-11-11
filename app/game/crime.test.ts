import { describe, expect, it } from "vitest";
import { ATTACKER_SELECTOR, WANTED_SELECTOR, nearest, slot, type BrainDef } from "../lib/brain";
import { emptyMap, replaceStack } from "../lib/mapData";
import { FRAME, tile } from "../lib/testTile";
import type { MapFile, TileDef } from "../lib/types";
import { initialMemory, stepBrain } from "./brainRuntime";
import { BRAIN_TICK_MS, TICK_MS, WANTED_MS } from "./constants";
import { COMBAT_DURATION_MS } from "../lib/status";
import { GameSession, LOCAL_ACTOR_ID } from "./GameSession";
import { brainContext } from "./testBrainContext";

const witnessBrain: BrainDef = {
  initial: "idle",
  states: {
    idle: { do: [{ action: "hold" }] },
    saw: { do: [{ action: "hold" }] },
  },
  transitions: [
    {
      from: "idle",
      if: { cond: "witnessed", of: nearest("townsfolk"), cells: 6 },
      bind: { culprit: ATTACKER_SELECTOR },
      to: "saw",
    },
  ],
};

describe("witnessed", () => {
  const at = { x: 3, y: 0, z: 0 };

  it("counts a blow on any body on the named tiles, not only the nearest", () => {
    const memory = initialMemory(witnessBrain);
    stepBrain(
      witnessBrain,
      memory,
      BRAIN_TICK_MS,
      brainContext({
        struck: () => [{ victimId: "far", attackerId: "villain" }],
        tileOf: (id) => (id === "far" ? "townsfolk" : null),
        positionOf: (id) => (id === "far" ? at : null),
        nearestOnTile: () => "near",
      }),
    );
    expect(memory.state).toBe("saw");
    expect(memory.blackboard.culprit).toEqual({ kind: "body", id: "villain" });
  });

  it("does not see a blow behind a wall", () => {
    const memory = initialMemory(witnessBrain);
    stepBrain(
      witnessBrain,
      memory,
      BRAIN_TICK_MS,
      brainContext({
        struck: () => [{ victimId: "far", attackerId: "villain" }],
        tileOf: () => "townsfolk",
        positionOf: () => at,
        canSee: () => false,
      }),
    );
    expect(memory.state).toBe("idle");
  });

  it("does not count a blow on a body of another tile", () => {
    const memory = initialMemory(witnessBrain);
    stepBrain(
      witnessBrain,
      memory,
      BRAIN_TICK_MS,
      brainContext({
        struck: () => [{ victimId: "dummy", attackerId: "villain" }],
        tileOf: () => "training-dummy",
        positionOf: () => at,
      }),
    );
    expect(memory.state).toBe("idle");
  });
});

const CERTAIN = { accuracy: 100, spd: 100, variance: 0 };

function body(id: string, brain?: BrainDef): TileDef {
  return tile({
    id,
    name: id,
    height: 2,
    kind: "battler",
    actor: true,
    walkable: false,
    interactions: {
      battler: {
        baseHp: 999,
        masteries: {},
        naturalWeapon: { type: "weapon", damage: 1, def: 0, mastery: "blunt", ...CERTAIN },
        pvp: true,
      },
      ...(brain ? { brain } : {}),
    },
  });
}

const townsfolkBrain: BrainDef = {
  initial: "idle",
  states: {
    idle: { do: [{ action: "hold" }] },
    reporting: {
      do: [{ action: "report", of: slot("culprit"), cells: 4 }, { action: "hold" }],
    },
  },
  transitions: [
    {
      from: "idle",
      if: { cond: "witnessed", of: nearest("townsfolk"), cells: 6 },
      bind: { culprit: ATTACKER_SELECTOR },
      to: "reporting",
    },
  ],
};

const guardBrain: BrainDef = {
  initial: "watching",
  states: {
    watching: { do: [{ action: "hold" }] },
    told: { onEnter: [{ effect: "say", text: "told of {culprit}" }], do: [{ action: "hold" }] },
    spotted: {
      onEnter: [{ effect: "say", text: "spotted {culprit}" }],
      do: [{ action: "hold" }],
    },
  },
  transitions: [
    {
      from: "watching",
      if: { cond: "alerted" },
      bind: { culprit: ATTACKER_SELECTOR },
      to: "told",
    },
    {
      from: "watching",
      if: { cond: "in_range", of: WANTED_SELECTOR, cells: 50 },
      bind: { culprit: WANTED_SELECTOR },
      to: "spotted",
    },
  ],
};

const tiles: TileDef[] = [
  tile({ id: "grass" }),
  tile({
    id: "player",
    name: "Player",
    height: 4,
    kind: "battler",
    directional: true,
    walkable: false,
    lightPassing: true,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
    interactions: {
      battler: {
        baseHp: 999,
        masteries: {},
        naturalWeapon: { type: "weapon", damage: 1, def: 0, mastery: "fist", ...CERTAIN },
      },
    },
  }),
  body("townsfolk", townsfolkBrain),
  body("guard", guardBrain),
];

function street(bodies: [number, string][]): MapFile {
  let map = emptyMap();
  for (let x = -2; x <= 30; x++) {
    for (let y = -2; y <= 2; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "e" }]);
  for (const [x, tileId] of bodies) {
    map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }, { tileId }]);
  }
  return map;
}

function idOn(session: GameSession, x: number): string {
  return session.actorSnapshots().find((a) => a.x === x && a.y === 0)!.id;
}

function run(session: GameSession, ms: number): string[] {
  const said: string[] = [];
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
    session.tick(TICK_MS);
    for (const bubble of session.drainSpeech()) said.push(`${bubble.actorId}: ${bubble.text}`);
  }
  return said;
}

function strike(session: GameSession, victimX: number) {
  session.setPvp(true);
  session.setTarget(idOn(session, victimX));
  session.setAttackMode(true);
  const said = run(session, 1_000);
  session.setAttackMode(false);
  return said;
}

describe("a report", () => {
  it("alerts the bodies near the one who makes it, and only those", () => {
    const session = new GameSession(
      street([
        [1, "townsfolk"],
        [3, "townsfolk"],
        [6, "guard"],
        [20, "guard"],
      ]),
      tiles,
      { actorIds: [LOCAL_ACTOR_ID], names: { [LOCAL_ACTOR_ID]: "Mallory" } },
    );
    const near = idOn(session, 6);
    const far = idOn(session, 20);

    const said = [...strike(session, 1), ...run(session, 1_000)];

    expect(session.isWanted(LOCAL_ACTOR_ID)).toBe(true);
    expect(said).toContain(`${near}: told of Mallory`);
    expect(said).toContain(`${far}: spotted Mallory`);
    expect(said).not.toContain(`${far}: told of Mallory`);
  });

  it("is forgotten once the time on the wanted list runs out", () => {
    const session = new GameSession(street([[1, "townsfolk"]]), tiles, {
      actorIds: [LOCAL_ACTOR_ID],
    });
    strike(session, 1);
    run(session, 1_000);
    expect(session.isWanted(LOCAL_ACTOR_ID)).toBe(true);

    session.passTimeAsleep(WANTED_MS);
    expect(session.isWanted(LOCAL_ACTOR_ID)).toBe(false);
  });

  it("is cleared by turning PvP off, which waits until the fighting is over", () => {
    const session = new GameSession(street([[1, "townsfolk"]]), tiles, {
      actorIds: [LOCAL_ACTOR_ID],
    });
    strike(session, 1);
    run(session, 1_000);

    expect(session.setPvp(false)).toBe(false);
    expect(session.isWanted(LOCAL_ACTOR_ID)).toBe(true);

    run(session, COMBAT_DURATION_MS);
    expect(session.setPvp(false)).toBe(true);
    expect(session.isWanted(LOCAL_ACTOR_ID)).toBe(false);
  });
});
