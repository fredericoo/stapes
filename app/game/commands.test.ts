import { describe, expect, it } from "vitest";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import { MASTERIES, xpForLevel } from "../lib/mastery";
import type { MapFile, TileDef } from "../lib/types";
import { COMMAND_USAGE, MAX_COMMAND_HP, isCommand, parseCommand } from "./commands";
import { constantFormula } from "../lib/formula";
import { NO_VFX } from "../lib/statusVfx";
import type { StatusDef } from "../lib/status";
import { GameSession } from "./GameSession";
import { FRAME, tile as baseTile } from "../lib/testTile";

describe("reading a typed line", () => {
  it("tells an instruction from something said", () => {
    expect(isCommand("/mastery sharp 10")).toBe(true);
    expect(isCommand("hello")).toBe(false);
    expect(isCommand("and/or")).toBe(false);
  });

  it("reads a mastery, a level, and nobody in particular", () => {
    expect(parseCommand("/mastery sharp 10")).toEqual({
      ok: true,
      command: { name: "mastery", mastery: "sharp", level: 10, target: null },
    });
  });

  it("reads self as the same nobody in particular", () => {
    expect(parseCommand("/mastery sharp 10 self")).toEqual(parseCommand("/mastery sharp 10"));
  });

  it("carries a player id through untouched", () => {
    const id = "8f1d4c2e-0000-4000-8000-000000000001";
    expect(parseCommand(`/mastery arcane 42 ${id}`)).toEqual({
      ok: true,
      command: { name: "mastery", mastery: "arcane", level: 42, target: id },
    });
  });

  it("forgives capitals and doubled spaces", () => {
    expect(parseCommand("  /Mastery   Toughness  7  ")).toEqual({
      ok: true,
      command: {
        name: "mastery",
        mastery: "toughness",
        level: 7,
        target: null,
      },
    });
  });

  it("names the command it has never heard of", () => {
    expect(parseCommand("/fly")).toEqual({
      ok: false,
      refusal: { kind: "unknownCommand", typed: "/fly" },
    });
    expect(parseCommand("/")).toEqual({
      ok: false,
      refusal: { kind: "unknownCommand", typed: "/" },
    });
  });

  it("asks for the arguments it is short of, and the ones it is over", () => {
    expect(parseCommand("/mastery")).toEqual({
      ok: false,
      refusal: { kind: "badArguments", command: "mastery" },
    });
    expect(parseCommand("/mastery sharp")).toEqual({
      ok: false,
      refusal: { kind: "badArguments", command: "mastery" },
    });
    expect(parseCommand("/mastery sharp 10 self please")).toEqual({
      ok: false,
      refusal: { kind: "badArguments", command: "mastery" },
    });
  });

  it("reads a status by the id it was written with", () => {
    expect(parseCommand("/status Poison")).toEqual({
      ok: true,
      command: { name: "status", statusId: "Poison", target: null },
    });
    expect(parseCommand("/status burned somebody")).toEqual({
      ok: true,
      command: { name: "status", statusId: "burned", target: "somebody" },
    });
    expect(parseCommand("/status burned self")).toEqual({
      ok: true,
      command: { name: "status", statusId: "burned", target: null },
    });
  });

  it("reads clear as taking everything off, whatever its case", () => {
    for (const line of ["/status clear", "/status CLEAR"]) {
      expect(parseCommand(line)).toEqual({
        ok: true,
        command: { name: "status", statusId: null, target: null },
      });
    }
  });

  it("hands back the status grammar for a status line, not the mastery one", () => {
    expect(parseCommand("/status")).toEqual({
      ok: false,
      refusal: { kind: "badArguments", command: "status" },
    });
    expect(parseCommand("/status burned me please")).toEqual({
      ok: false,
      refusal: { kind: "badArguments", command: "status" },
    });
  });

  it("names the mastery it does not have", () => {
    expect(parseCommand("/mastery blad 10")).toEqual({
      ok: false,
      refusal: { kind: "unknownMastery", typed: "blad" },
    });
  });

  it("accepts every mastery there is", () => {
    for (const mastery of MASTERIES) {
      expect(parseCommand(`/mastery ${mastery} 1`)).toMatchObject({
        ok: true,
        command: { mastery },
      });
    }
  });

  it("refuses anything that is not a whole level on the scale", () => {
    for (const typed of ["ten", "10.5", "-1", "101", "10abc", ""]) {
      expect(parseCommand(`/mastery sharp ${typed}`)).toMatchObject({
        ok: false,
        refusal: { kind: expect.stringMatching(/badLevel|badArguments/) },
      });
    }
    expect(parseCommand("/mastery sharp 0")).toMatchObject({ ok: true });
    expect(parseCommand("/mastery sharp 100")).toMatchObject({ ok: true });
  });

  it("reads a tile named with nowhere in particular as here", () => {
    expect(parseCommand("/tile apple")).toEqual({
      ok: true,
      command: {
        name: "tile",
        tileId: "apple",
        count: 1,
        at: {
          x: { kind: "relative", offset: 0 },
          y: { kind: "relative", offset: 0 },
          z: { kind: "relative", offset: 0 },
        },
      },
    });
  });

  it("reads a sign as a step from where you stand", () => {
    expect(parseCommand("/tile apple +1")).toMatchObject({
      ok: true,
      command: { at: { x: { kind: "relative", offset: 1 } } },
    });
    expect(parseCommand("/tile apple -1")).toMatchObject({
      ok: true,
      command: { at: { x: { kind: "relative", offset: -1 } } },
    });
  });

  it("reads a bare number as a cell of the map", () => {
    expect(parseCommand("/tile apple 0 0 0")).toMatchObject({
      ok: true,
      command: {
        at: {
          x: { kind: "absolute", value: 0 },
          y: { kind: "absolute", value: 0 },
          z: { kind: "absolute", value: 0 },
        },
      },
    });
  });

  it("lets the axes disagree about which kind they are", () => {
    expect(parseCommand("/tile apple +0 -2 3")).toMatchObject({
      ok: true,
      command: {
        at: {
          x: { kind: "relative", offset: 0 },
          y: { kind: "relative", offset: -2 },
          z: { kind: "absolute", value: 3 },
        },
      },
    });
  });

  it("names the word that is not a coordinate", () => {
    for (const typed of ["east", "1.5", "1e3", "12px", "++1"]) {
      expect(parseCommand(`/tile apple ${typed}`)).toEqual({
        ok: false,
        refusal: { kind: "badCoordinate", typed },
      });
    }
  });

  it("asks for the arguments the tile command is short of, and over", () => {
    expect(parseCommand("/tile")).toEqual({
      ok: false,
      refusal: { kind: "badArguments", command: "tile" },
    });
    expect(parseCommand("/tile apple 1 2 3 4")).toEqual({
      ok: false,
      refusal: { kind: "badArguments", command: "tile" },
    });
  });

  it("reads a count written in front of the coordinates", () => {
    expect(parseCommand("/tile apple x12 +1 -2 3")).toMatchObject({
      ok: true,
      command: {
        tileId: "apple",
        count: 12,
        at: {
          x: { kind: "relative", offset: 1 },
          y: { kind: "relative", offset: -2 },
          z: { kind: "absolute", value: 3 },
        },
      },
    });
    expect(parseCommand("/tile apple X3")).toMatchObject({
      ok: true,
      command: { count: 3, at: { x: { kind: "relative", offset: 0 } } },
    });
  });

  it("counts one when no count was typed", () => {
    expect(parseCommand("/tile apple +1")).toMatchObject({
      ok: true,
      command: { count: 1 },
    });
  });

  it("names a count that is zero or past the ceiling", () => {
    for (const typed of ["x0", "x1000"]) {
      expect(parseCommand(`/tile apple ${typed}`)).toEqual({
        ok: false,
        refusal: { kind: "badCount", typed },
      });
    }
  });

  it("refuses a count anywhere but first", () => {
    expect(parseCommand("/tile apple +1 x5")).toEqual({
      ok: false,
      refusal: { kind: "badCoordinate", typed: "x5" },
    });
  });

  it("still allows only three axes behind a count", () => {
    expect(parseCommand("/tile apple x2 1 2 3 4")).toEqual({
      ok: false,
      refusal: { kind: "badArguments", command: "tile" },
    });
  });

  it("forgives capitals in a tile key too", () => {
    expect(parseCommand("/Tile Apple")).toMatchObject({
      ok: true,
      command: { tileId: "apple" },
    });
  });
});

function tile(partial: Record<string, unknown> & Pick<TileDef, "id" | "height">): TileDef {
  const interactions = partial.interactions as { battler?: unknown } | undefined;
  return baseTile({
    kind: interactions?.battler ? "battler" : "prop",
    ...partial,
  });
}

const claws = {
  type: "weapon" as const,
  damage: 3,
  def: 0,
  accuracy: 90,
  variance: 20,
  spd: 90,
  mastery: "fist" as const,
};

const AUTHORED = { fist: 5, toughness: 5, agility: 5 };

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({
    id: "apple",
    name: "Apple",
    height: 0,
    kind: "item",
    interactions: { item: { type: "consumable", label: "Eat", hp: 1 } },
  }),
  tile({
    id: "player",
    height: 4,
    directional: true,
    walkable: false,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
    interactions: { battler: { baseHp: 8, masteries: AUTHORED, naturalWeapon: claws } },
  }),
  tile({
    id: "deer",
    name: "Deer",
    height: 2,
    actor: true,
    walkable: false,
    interactions: { battler: { baseHp: 8, masteries: AUTHORED, naturalWeapon: claws } },
  }),
  tile({
    id: "rune",
    height: 0,
    transitions: {
      appear: {
        durationMs: 300,
        dissolve: { pattern: "noise", edgeColor: "#8ce6ff", edgeWidth: 0.1 },
      },
    },
  }),
];

function field(): MapFile {
  let map = emptyMap();
  for (let x = -2; x <= 2; x++) {
    for (let y = -2; y <= 2; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "e" }]);
  return replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "deer" }]);
}

function ratingOf(session: GameSession, id: string): number | null {
  return session.actorSnapshots().find((a) => a.id === id)?.rating ?? null;
}

function world(actorIds: string[] = ["me"]) {
  return new GameSession(field(), tiles, {
    actorIds,
    names: { me: "Mira", you: "Yorick" },
    seed: 1,
  });
}

const BURN: StatusDef = {
  id: "burned",
  name: "Burned",
  description: "Searing.",
  tone: "bad",
  fromMs: 10_000,
  toMs: 10_000,
  stacks: false,
  maxMs: 10_000,
  everyMs: constantFormula(0),
  effects: {},
  modifiers: {},
  walkSpeedPercent: 0,
  incapacitates: false,
  endsOnDamage: false,
  vfx: NO_VFX,
};

function statusWorld() {
  return new GameSession(field(), tiles, {
    actorIds: ["me"],
    seed: 1,
    statuses: { burned: BURN },
  });
}

describe("what a command does to a body", () => {
  it("puts a mastery exactly where it was asked for", () => {
    const session = world();
    session.runCommand("/mastery sharp 10", "me");

    expect(session.getSnapshot("me").masteryXp.sharp).toBe(xpForLevel(10));
    expect(session.drainNotices("me")).toEqual(["Your sharp mastery is now 10"]);
  });

  it("leaves every other mastery where the tile put it", () => {
    const session = world();
    session.runCommand("/mastery sharp 10", "me");

    expect(session.getSnapshot("me").masteryXp.toughness).toBe(xpForLevel(5));
  });

  it("counts for something in the body that fights", () => {
    const session = world();
    const before = ratingOf(session, "me");
    session.runCommand("/mastery sharp 60", "me");

    expect(ratingOf(session, "me")).toBeGreaterThan(before ?? 0);
  });

  it("queues the change for whoever has to be told", () => {
    const session = world();
    session.runCommand("/mastery sharp 10", "me");
    expect(session.drainMasteryChanges()).toContain("me");
  });

  it("says nothing out loud", () => {
    const session = world();
    session.runCommand("/mastery sharp 10", "me");
    expect(session.drainSpeech()).toEqual([]);
  });

  it("reaches somebody else by their id, and tells them both", () => {
    const session = world(["me", "you"]);
    session.runCommand("/mastery arcane 12 you", "me");

    expect(session.getSnapshot("you").masteryXp.arcane).toBe(xpForLevel(12));
    expect(session.getSnapshot("me").masteryXp.arcane).toBeUndefined();

    expect(session.drainNotices("you")).toEqual(["Your arcane mastery is now 12"]);
    expect(session.drainNotices("me")).toEqual(["Yorick's arcane mastery is now 12"]);
  });

  it("says it once when the somebody else is you", () => {
    const session = world();
    session.runCommand("/mastery sharp 10 self", "me");
    expect(session.drainNotices("me")).toHaveLength(1);
  });

  it("names the body that does not learn", () => {
    const session = world();
    const deer = session.actorIds().find((id) => id !== "me")!;
    session.runCommand(`/mastery sharp 10 ${deer}`, "me");

    expect(session.drainNotices("me")).toEqual(["Deer does not learn"]);
    expect(session.drainMasteryChanges()).toEqual([]);
  });

  it("names the id nobody answers to", () => {
    const session = world();
    session.runCommand("/mastery sharp 10 nobody", "me");
    expect(session.drainNotices("me")).toEqual(['Nobody here answers to "nobody"']);
  });

  it("hands back the grammar when the line was not one", () => {
    const session = world();
    session.runCommand("/mastery sharp", "me");
    expect(session.drainNotices("me")).toEqual([`Say ${COMMAND_USAGE.mastery}`]);
  });

  it("says which word it did not understand", () => {
    const session = world();
    session.runCommand("/mastery blad 10", "me");
    expect(session.drainNotices("me")[0]).toContain('"blad"');
  });
});

function stackAt(session: GameSession, x: number, y: number, z: number) {
  return getStack(session.getMap(), x, y, z);
}

describe("what a command does to the board", () => {
  it("puts a thing at your feet when you name nowhere", () => {
    const session = world();
    session.runCommand("/tile apple", "me");

    expect(stackAt(session, 0, 0, 0).map((placed) => placed.tileId)).toEqual([
      "grass",
      "apple",
      "player",
    ]);
  });

  it("reads your own cell as your feet however it was named", () => {
    const session = world();
    session.runCommand("/tile apple +0 +0 +0", "me");
    expect(stackAt(session, 0, 0, 0).map((placed) => placed.tileId)).toEqual([
      "grass",
      "apple",
      "player",
    ]);
  });

  it("gives a summoned item an identity", () => {
    const session = world();
    session.runCommand("/tile apple", "me");

    expect(stackAt(session, 0, 0, 0)[1]?.itemId).toMatch(/^itm_/);
  });

  it("steps east and west from where you stand", () => {
    const session = world();
    session.runCommand("/tile apple +1", "me");
    session.runCommand("/tile apple -1", "me");

    expect(stackAt(session, 1, 0, 0).map((placed) => placed.tileId)).toEqual([
      "grass",
      "deer",
      "apple",
    ]);
    expect(stackAt(session, -1, 0, 0).map((placed) => placed.tileId)).toEqual(["grass", "apple"]);
  });

  it("takes a cell of the map when the sign is left off", () => {
    const session = world();
    session.runCommand("/tile apple 2 -2 0", "me");
    expect(stackAt(session, 2, -2, 0).map((placed) => placed.tileId)).toEqual(["grass", "apple"]);
  });

  it("gives a summoned body somebody to drive it", () => {
    const session = world();
    const before = session.actorIds();
    session.runCommand("/tile deer 0 1 0", "me");

    const summoned = session.actorIds().filter((id) => !before.includes(id));
    expect(summoned).toEqual(["npc:0,1,0,1"]);
    expect(session.isResident("npc:0,1,0,1")).toBe(true);
    expect(stackAt(session, 0, 1, 0)[1]?.owner).toBe("npc:0,1,0,1");
  });

  it("never names two bodies the same thing", () => {
    const session = world();
    session.spawn("npc:0,1,0,1");
    session.runCommand("/tile deer 0 1 0", "me");

    const owner = stackAt(session, 0, 1, 0)[1]?.owner;
    expect(owner).not.toBe("npc:0,1,0,1");
    expect(session.isResident(owner!)).toBe(true);
  });

  it("says what appeared and where", () => {
    const session = world();
    session.runCommand("/tile apple 2 -2 0", "me");

    expect(session.drainNotices("me")).toEqual(["Apple appears at 2, -2, 0"]);
  });

  it("runs the placement once per count, pouring as it goes", () => {
    const session = world();
    session.runCommand("/tile apple x10 2 -2 0", "me");

    expect(
      stackAt(session, 2, -2, 0).map((placed) => `${placed.tileId}x${placed.count ?? 1}`),
    ).toEqual(["grassx1", "applex8", "applex2"]);
  });

  it("names every summoned body separately", () => {
    const session = world();
    session.runCommand("/tile deer x2 0 1 0", "me");

    const owners = stackAt(session, 0, 1, 0)
      .map((placed) => placed.owner)
      .filter((owner) => owner != null);
    expect(owners).toHaveLength(2);
    expect(new Set(owners).size).toBe(2);
    for (const owner of owners) expect(session.isResident(owner)).toBe(true);
  });

  it("places all of a count or none of it", () => {
    const session = world();
    session.runCommand("/tile deer x9 0 1 0", "me");

    expect(session.drainNotices("me")).toEqual(["Nothing will fit at 0, 1, 0"]);
    expect(stackAt(session, 0, 1, 0).map((placed) => placed.tileId)).toEqual(["grass"]);
  });

  it("says how many appeared, and only when it was more than one", () => {
    const session = world();
    session.runCommand("/tile apple x3 2 -2 0", "me");
    expect(session.drainNotices("me")).toEqual(["Apple ×3 appears at 2, -2, 0"]);

    session.runCommand("/tile apple 2 -2 0", "me");
    expect(session.drainNotices("me")).toEqual(["Apple appears at 2, -2, 0"]);
  });

  it("names the tile the catalogue does not have", () => {
    const session = world();
    session.runCommand("/tile aple", "me");
    expect(session.drainNotices("me")).toEqual(['No tile called "aple"']);
  });

  it("refuses the tile that marks where the world starts", () => {
    const session = world();
    session.runCommand("/tile player", "me");

    expect(session.drainNotices("me")[0]).toContain("where the world starts");
    expect(stackAt(session, 0, 0, 0)).toHaveLength(2);
  });

  it("says where nothing will fit", () => {
    const session = world();
    session.runCommand("/tile deer", "me");

    expect(session.drainNotices("me")).toEqual(["Nothing will fit at 0, 0, 0"]);
    expect(stackAt(session, 0, 0, 0)).toHaveLength(2);
  });

  it("hands back the grammar when the line was not one", () => {
    const session = world();
    session.runCommand("/tile", "me");
    expect(session.drainNotices("me")).toEqual([`Say ${COMMAND_USAGE.tile}`]);
  });
});

describe("putting a status on by hand", () => {
  it("puts it on, with a real rolled duration", () => {
    const session = statusWorld();
    session.runCommand("/status burned", "me");

    const [running] = session.getSnapshot("me").self.statuses;
    expect(running?.defId).toBe("burned");
    expect(running?.durationMs).toBe(BURN.fromMs);
    expect(session.drainNotices("me")).toEqual(["You are burned"]);
  });

  it("says it again on a second helping, having nothing else to report", () => {
    const session = statusWorld();
    session.runCommand("/status burned", "me");
    session.drainNotices("me");

    session.runCommand("/status burned", "me");
    expect(session.drainNotices("me")).toEqual(["You are burned"]);
  });

  it("names the body when the condition landed on somebody else", () => {
    const session = new GameSession(field(), tiles, {
      actorIds: ["me"],
      seed: 1,
      statuses: { burned: BURN },
    });
    const deer = session.actorIds().find((id) => id !== "me")!;
    session.runCommand(`/status burned ${deer}`, "me");

    expect(session.drainNotices("me")).toEqual(["Deer is burned"]);
    expect(session.drainNotices(deer)).toEqual([]);
  });

  it("takes everything off again", () => {
    const session = statusWorld();
    session.runCommand("/status burned", "me");
    session.drainNotices("me");

    session.runCommand("/status clear", "me");
    expect(session.getSnapshot("me").self.statuses).toEqual([]);
    expect(session.drainNotices("me")).toEqual(["Nothing is on you now."]);
  });

  it("names the ids it does have when it does not have that one", () => {
    const session = statusWorld();
    session.runCommand("/status frozen", "me");
    const [notice = ""] = session.drainNotices("me");
    expect(notice).toContain('"frozen"');
    expect(notice).toContain("burned");
  });

  it("says so rather than nothing when the world authored no statuses", () => {
    const session = world();
    session.runCommand("/status burned", "me");
    expect(session.drainNotices("me")).toHaveLength(1);
  });

  it("names the id nobody answers to, before looking at the status", () => {
    const session = statusWorld();
    session.runCommand("/status burned nobody", "me");
    expect(session.drainNotices("me")).toEqual(['Nobody here answers to "nobody"']);
  });

  it("hands back the status grammar when the line was not one", () => {
    const session = statusWorld();
    session.runCommand("/status", "me");
    expect(session.drainNotices("me")).toEqual([`Say ${COMMAND_USAGE.status}`]);
  });

  it("reaches somebody else by their id", () => {
    const session = new GameSession(field(), tiles, {
      actorIds: ["me", "you"],
      seed: 1,
      statuses: { burned: BURN },
    });
    session.runCommand("/status burned you", "me");

    expect(session.getSnapshot("you").self.statuses[0]?.defId).toBe("burned");
    expect(session.getSnapshot("me").self.statuses).toEqual([]);
  });
});

describe("moving health by hand", () => {
  it("reads a bare figure as a place to put somebody", () => {
    expect(parseCommand("/health 12")).toEqual({
      ok: true,
      command: { name: "health", health: { kind: "set", hp: 12 }, target: null },
    });
  });

  it("reads a sign as a thing to do to them", () => {
    expect(parseCommand("/health +10")).toEqual({
      ok: true,
      command: { name: "health", health: { kind: "shift", by: 10 }, target: null },
    });
    expect(parseCommand("/health -10")).toEqual({
      ok: true,
      command: { name: "health", health: { kind: "shift", by: -10 }, target: null },
    });
  });

  it("carries a target the way every other command does", () => {
    expect(parseCommand("/health +5 somebody")).toEqual({
      ok: true,
      command: { name: "health", health: { kind: "shift", by: 5 }, target: "somebody" },
    });
    expect(parseCommand("/health +5 self")).toEqual(parseCommand("/health +5"));
  });

  it("refuses anything that is not plainly a number", () => {
    for (const typed of ["1e3", "0x10", "ten", "", "1.5"]) {
      expect(parseCommand(`/health ${typed}`).ok).toBe(false);
    }
  });

  it("refuses a figure past the sanity bound", () => {
    expect(parseCommand(`/health ${MAX_COMMAND_HP + 1}`)).toEqual({
      ok: false,
      refusal: { kind: "badHealth", typed: String(MAX_COMMAND_HP + 1) },
    });
  });

  it("puts a body exactly where it was asked for", () => {
    const session = world();
    const max = session.getSnapshot("me").self.maxHp!;
    session.runCommand("/health 3", "me");

    expect(session.getSnapshot("me").self.hp).toBe(3);
    expect(session.drainNotices("me")).toEqual([`3/${max} health.`]);
  });

  it("caps a set at the most that body can have", () => {
    const session = world();
    const max = session.getSnapshot("me").self.maxHp!;
    session.runCommand("/health 9999", "me");
    expect(session.getSnapshot("me").self.hp).toBe(max);
  });

  it("heals up to the ceiling and no further", () => {
    const session = world();
    const max = session.getSnapshot("me").self.maxHp!;
    session.runCommand("/health 1", "me");
    session.drainNotices("me");

    session.runCommand("/health +2", "me");
    expect(session.getSnapshot("me").self.hp).toBe(3);

    session.runCommand(`/health +${max}`, "me");
    expect(session.getSnapshot("me").self.hp).toBe(max);
  });

  it("takes hit points off through the same door a blow uses", () => {
    const session = world();
    const before = session.getSnapshot("me").self.hp!;
    session.runCommand("/health -2", "me");
    expect(session.getSnapshot("me").self.hp).toBe(before - 2);
  });

  it("kills a body taken to nothing", () => {
    const session = world();
    expect(session.actorSnapshots().some((a) => a.id === "me")).toBe(true);

    session.runCommand("/health 0", "me");
    expect(session.actorSnapshots().some((a) => a.id === "me")).toBe(false);
  });

  it("reaches somebody else by their id", () => {
    const session = world(["me", "you"]);
    session.runCommand("/health 4 you", "me");
    expect(session.getSnapshot("you").self.hp).toBe(4);
    expect(session.getSnapshot("me").self.hp).not.toBe(4);
  });

  it("names the id nobody answers to", () => {
    const session = world();
    session.runCommand("/health 4 nobody", "me");
    expect(session.drainNotices("me")).toEqual(['Nobody here answers to "nobody"']);
  });

  it("hands back the health grammar when the line was not one", () => {
    const session = world();
    session.runCommand("/health", "me");
    expect(session.drainNotices("me")).toEqual([`Say ${COMMAND_USAGE.health}`]);
  });
});

describe("going somewhere", () => {
  it("reads /goto as a cell of the map, minus sign and all", () => {
    expect(parseCommand("/goto -11 -55")).toMatchObject({
      ok: true,
      command: { name: "goto", at: { x: -11, y: -55, z: null } },
    });
  });

  it("reads /move as a distance from where you stand", () => {
    expect(parseCommand("/move -11 -55")).toMatchObject({
      ok: true,
      command: { name: "move", by: { x: -11, y: -55, z: 0 } },
    });
  });

  it("takes a third number as the level, either way", () => {
    expect(parseCommand("/goto 4 9 2")).toMatchObject({
      ok: true,
      command: { at: { x: 4, y: 9, z: 2 } },
    });
    expect(parseCommand("/move 0 0 -1")).toMatchObject({
      ok: true,
      command: { by: { x: 0, y: 0, z: -1 } },
    });
  });

  it("forgives a plus nobody needed to type", () => {
    expect(parseCommand("/move +0 +3")).toMatchObject({
      ok: true,
      command: { by: { x: 0, y: 3, z: 0 } },
    });
  });

  it("goes to an absolute cell", () => {
    const session = world();
    session.runCommand("/goto 2 2", "me");
    const me = session.actorSnapshots().find((a) => a.id === "me")!;
    expect({ x: me.x, y: me.y, z: me.z }).toEqual({ x: 2, y: 2, z: 0 });
    expect(session.drainNotices("me")).toEqual([]);
  });

  it("keeps the level it was standing on when none is given", () => {
    const session = world();
    session.runCommand("/goto 2 2", "me");
    expect(session.actorSnapshots().find((a) => a.id === "me")!.z).toBe(0);
  });

  it("counts a move from wherever the body now stands", () => {
    const session = world();
    session.runCommand("/move 0 1", "me");
    session.runCommand("/move 0 1", "me");
    const me = session.actorSnapshots().find((a) => a.id === "me")!;
    expect({ x: me.x, y: me.y }).toEqual({ x: 0, y: 2 });
  });

  it("refuses a cell another body is standing in, and says which", () => {
    const session = world();
    session.runCommand("/goto 1 0", "me");
    expect(session.drainNotices("me")).toEqual(["Nothing will fit at 1, 0, 0"]);
    const me = session.actorSnapshots().find((a) => a.id === "me")!;
    expect({ x: me.x, y: me.y }).toEqual({ x: 0, y: 0 });
  });

  it("refuses a cell off the edge of the board", () => {
    const session = world();
    session.runCommand("/goto 40 40", "me");
    expect(session.drainNotices("me")).toEqual(["Nothing will fit at 40, 40, 0"]);
  });

  it("refuses a move onto nothing on the same terms", () => {
    const session = world();
    session.runCommand("/move 40 40", "me");
    expect(session.drainNotices("me")).toEqual(["Nothing will fit at 40, 40, 0"]);
  });

  it("says nothing when you are already there", () => {
    const session = world();
    session.runCommand("/move 0 0", "me");
    expect(session.drainNotices("me")).toEqual([]);
    const me = session.actorSnapshots().find((a) => a.id === "me")!;
    expect({ x: me.x, y: me.y }).toEqual({ x: 0, y: 0 });
  });

  it("hands back the grammar of the verb that was typed", () => {
    const session = world();
    session.runCommand("/goto 1", "me");
    expect(session.drainNotices("me")).toEqual([`Say ${COMMAND_USAGE.goto}`]);
    session.runCommand("/move 1 2 3 4", "me");
    expect(session.drainNotices("me")).toEqual([`Say ${COMMAND_USAGE.move}`]);
  });

  it("names the word that is not a number, under either verb", () => {
    for (const line of ["/goto north 2", "/move north 2"]) {
      expect(parseCommand(line)).toEqual({
        ok: false,
        refusal: { kind: "badCoordinate", typed: "north" },
      });
    }
  });
});

const MINUTES_PER_HOUR = 60;
const SIX_PM_MINUTES = 18 * MINUTES_PER_HOUR;
const HALF_SIX_AM_MINUTES = 6 * MINUTES_PER_HOUR + 30;

describe("setting the time", () => {
  it("reads a 24-hour time as minutes past midnight", () => {
    expect(parseCommand("/time 18:00")).toEqual({
      ok: true,
      command: { name: "time", minutes: SIX_PM_MINUTES },
    });
    expect(parseCommand("/time 00:00")).toEqual({
      ok: true,
      command: { name: "time", minutes: 0 },
    });
  });

  it("forgives a leading zero nobody typed", () => {
    expect(parseCommand("/time 6:30")).toMatchObject({
      ok: true,
      command: { minutes: HALF_SIX_AM_MINUTES },
    });
  });

  it("names the word that is not a time, whichever way it is wrong", () => {
    for (const typed of ["24:00", "18:60", "noon", "18", "6pm", "-1:00"]) {
      expect(parseCommand(`/time ${typed}`)).toEqual({
        ok: false,
        refusal: { kind: "badTime", typed },
      });
    }
  });

  it("hands back the grammar when the count of words is wrong", () => {
    const session = world();
    session.runCommand("/time", "me");
    expect(session.drainNotices("me")).toEqual([`Say ${COMMAND_USAGE.time}`]);
    session.runCommand("/time 18:00 19:00", "me");
    expect(session.drainNotices("me")).toEqual([`Say ${COMMAND_USAGE.time}`]);
    expect(session.drainClockSet()).toBeNull();
  });

  it("queues the hour for the server once, and says what it is now", () => {
    const session = world();
    session.runCommand("/time 18:00", "me");
    expect(session.drainNotices("me")).toEqual(["It is now 18:00"]);
    expect(session.drainClockSet()).toBe(SIX_PM_MINUTES);
    expect(session.drainClockSet()).toBeNull();
  });

  it("keeps the last hour typed when two land between flushes", () => {
    const session = world();
    session.runCommand("/time 06:30", "me");
    session.runCommand("/time 18:00", "me");
    expect(session.drainClockSet()).toBe(SIX_PM_MINUTES);
  });
});

describe("what a summons announces", () => {
  it("plays a summoned tile's way in, at the slot it went into", () => {
    const session = world();
    session.runCommand("/tile rune", "me");

    expect(session.drainTransitions()).toEqual([
      {
        id: expect.any(String),
        side: "appear",
        tileId: "rune",
        x: 0,
        y: 0,
        z: 0,
        stackIndex: 1,
      },
    ]);
  });

  it("names the slot each copy of a count ends in", () => {
    const session = world();
    session.runCommand("/tile rune x2", "me");

    const slots = session.drainTransitions().map((note) => note.stackIndex);
    const stack = stackAt(session, 0, 0, 0);
    expect(slots.sort()).toEqual([1, 2]);
    expect(slots.map((slot) => stack[slot]?.tileId)).toEqual(["rune", "rune"]);
  });

  it("says nothing for a tile with no way in authored", () => {
    const session = world();
    session.runCommand("/tile apple", "me");

    expect(session.drainTransitions()).toEqual([]);
  });
});
