import { describe, expect, it } from "vitest";
import statusesJson from "../../data/statuses.json";
import tilesJson from "../../data/tiles.json";
import { maxHpFrom } from "../lib/battler";
import { type StatusGrant, DEFAULT_CONTAINER } from "../lib/item";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTiles } from "../lib/types";
import { BRAIN_TICK_MS, NOISE_LIFETIME_MS, TICK_MS } from "./constants";
import { GameSession } from "./GameSession";
import { COMBAT_STATUS_ID, type StatusDef, statusesById } from "../lib/status";
import { snapToTick } from "./statuses";
import { FRAME, tile } from "../lib/testTile";

const BAG_TILE_ID = "basic-bag";

const PLAYER_BASE_HP = 8;
const PLAYER_TOUGHNESS = 92;
const PLAYER_MAX_HP = maxHpFrom(PLAYER_BASE_HP, PLAYER_TOUGHNESS);

function granter(id: string, statuses: StatusGrant[]): TileDef {
  return tile({
    id,
    kind: "item",
    intangible: true,
    interactions: {
      item: { type: "consumable", label: "Eat", hp: 0, statuses },
    },
  });
}

function consumable(id: string, hp: number, sound?: string): TileDef {
  return tile({
    id,
    kind: "item",
    intangible: true,
    interactions: {
      item: { type: "consumable", label: "Eat", hp, ...(sound ? { sound } : {}) },
    },
  });
}

const tiles: TileDef[] = [
  tile({ id: "grass" }),
  tile({ id: "crate", height: 2 }),
  tile({
    id: "player",
    height: 4,
    kind: "battler",
    directional: true,
    walkable: false,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
    interactions: {
      battler: {
        baseHp: PLAYER_BASE_HP,
        masteries: { toughness: PLAYER_TOUGHNESS },
        naturalWeapon: {
          type: "weapon",
          damage: 5,
          def: 0,
          accuracy: 100,
          variance: 0,
          spd: 100,
          mastery: "fist",
        },
        kit: [{ slot: "bag", tileId: BAG_TILE_ID, chance: 100 }],
      },
    },
  }),
  tile({
    id: BAG_TILE_ID,
    kind: "item",
    intangible: true,
    interactions: { item: { ...DEFAULT_CONTAINER } },
  }),
  consumable("cherry", 5, "crunch"),
  consumable("poison", -10, "glug"),
  consumable("hemlock", -PLAYER_MAX_HP, "glug"),
  consumable("quiet-cherry", 5),
  granter("berry", [{ id: "fed" }]),
  granter("mystery-fruit", [{ id: "no-such-status" }]),
  granter("bread", [{ id: "fed", fromMs: 60_000, toMs: 60_000 }]),
  ...normalizeTiles(tilesJson as unknown[]).filter((t) =>
    ["green-potion", "luminous-potion", "empty-bottle"].includes(t.id),
  ),
  tile({
    id: "potion",
    kind: "item",
    intangible: true,
    interactions: {
      item: { type: "consumable", label: "Drink", hp: 0, pile: 4, leaves: "bottle" },
    },
  }),
  tile({
    id: "bottle",
    kind: "item",
    intangible: true,
    interactions: { item: { type: "artifact", pile: 12 } },
  }),
  tile({
    id: "lost-potion",
    kind: "item",
    intangible: true,
    interactions: {
      item: { type: "consumable", label: "Drink", hp: 0, leaves: "no-such-tile" },
    },
  }),
  tile({
    id: "sword",
    kind: "item",
    intangible: true,
    interactions: {
      item: {
        type: "weapon",
        damage: 1,
        def: 0,
        accuracy: 100,
        variance: 0,
        spd: 50,
        mastery: "sharp",
      },
    },
  }),
  tile({
    id: "chest",
    kind: "item",
    intangible: true,
    interactions: { item: { ...DEFAULT_CONTAINER, size: 2, equippable: false } },
  }),
];

function field(half = 4): MapFile {
  let map = emptyMap();
  for (let x = -half; x <= half; x++) {
    for (let y = -half; y <= half; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  return replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "e" }]);
}

function withItem(x: number, y: number, tileId: string): GameSession {
  const map = replaceStack(field(), x, y, 0, [{ tileId: "grass" }, { tileId }]);
  return new GameSession(map, tiles);
}

function refAt(session: GameSession, x: number, y: number) {
  const stack = getStack(session.getMap(), x, y, 0);
  return { x, y, z: 0, stackIndex: stack.length - 1 };
}

function hpOf(session: GameSession): number | null {
  return session.actorSnapshots().find((a) => a.tileId === "player")?.hp ?? null;
}

function tilesAt(session: GameSession, x: number, y: number): string[] {
  return getStack(session.getMap(), x, y, 0).map((p) => p.tileId);
}

describe("eating off the floor", () => {
  it("takes the thing off the board without it ever entering the bag", () => {
    const session = withItem(1, 0, "cherry");
    session.drainEquipmentChanges();

    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) })).toBe(true);
    expect(tilesAt(session, 1, 0)).toEqual(["grass"]);
    expect(session.getSnapshot().equipment.bag?.contents).toEqual([]);
    expect(session.drainEquipmentChanges()).toEqual([]);
  });

  it("heals by what the tile says, up to the body's own maximum", () => {
    let map = field();
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "poison" }]);
    map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }, { tileId: "cherry" }]);
    const session = new GameSession(map, tiles);

    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });
    expect(hpOf(session)).toBe(PLAYER_MAX_HP - 10);

    session.consume({ kind: "floor", ref: refAt(session, 0, 1) });
    expect(hpOf(session)).toBe(PLAYER_MAX_HP - 10 + 5);
  });

  it("never heals past full, and still spends the item", () => {
    const session = withItem(1, 0, "cherry");
    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) })).toBe(true);
    expect(hpOf(session)).toBe(PLAYER_MAX_HP);
    expect(tilesAt(session, 1, 0)).toEqual(["grass"]);
  });

  it("shows poison as a damage number", () => {
    const session = withItem(1, 0, "poison");
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });

    const fresh = session.getSnapshot().damage.filter((d) => d.elapsedMs === 0);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.amount).toBe(10);
  });

  it("kills through the same death every blow uses", () => {
    const session = withItem(1, 0, "hemlock");
    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) })).toBe(true);

    expect(session.actorSnapshots()).toEqual([]);
    expect(tilesAt(session, 0, 0)).toEqual(["grass"]);
  });

  it("refuses one two cells away", () => {
    const session = withItem(2, 0, "cherry");
    expect(session.consume({ kind: "floor", ref: refAt(session, 2, 0) })).toBe(false);
    expect(tilesAt(session, 2, 0)).toEqual(["grass", "cherry"]);
  });

  it("refuses one buried under something else", () => {
    const map = replaceStack(field(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "cherry" },
      { tileId: "crate" },
    ]);
    const session = new GameSession(map, tiles);
    expect(session.consume({ kind: "floor", ref: { x: 1, y: 0, z: 0, stackIndex: 1 } })).toBe(
      false,
    );
  });

  it("refuses a thing that is not a consumable", () => {
    const session = withItem(1, 0, "sword");
    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) })).toBe(false);
    expect(tilesAt(session, 1, 0)).toEqual(["grass", "sword"]);
  });

  it("has nothing to say for an actor who is not here", () => {
    const session = withItem(1, 0, "cherry");
    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) }, "nobody")).toBe(false);
  });
});

describe("eating out of a slot", () => {
  it("spends the thing in the bag and announces the kit change once", () => {
    const session = withItem(1, 0, "cherry");
    session.pickUp(refAt(session, 1, 0));
    session.drainEquipmentChanges();

    expect(session.consume({ kind: "slot", slot: { kind: "contents", index: 0 } })).toBe(true);
    expect(session.getSnapshot().equipment.bag?.contents).toEqual([]);
    expect(session.drainEquipmentChanges()).toEqual([session.getSnapshot().self.id]);
  });

  it("moves the hit points exactly as a floor meal does", () => {
    let map = field();
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "poison" }]);
    map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }, { tileId: "cherry" }]);
    const session = new GameSession(map, tiles);
    session.pickUp(refAt(session, 1, 0));
    session.pickUp(refAt(session, 0, 1));

    session.consume({ kind: "slot", slot: { kind: "contents", index: 0 } });
    expect(hpOf(session)).toBe(PLAYER_MAX_HP - 10);

    session.consume({ kind: "slot", slot: { kind: "contents", index: 0 } });
    expect(hpOf(session)).toBe(PLAYER_MAX_HP - 10 + 5);
    expect(session.getSnapshot().equipment.bag?.contents).toEqual([]);
  });

  it("eats straight out of a chest on the floor, rewriting its placement", () => {
    const map = replaceStack(field(), 1, 0, 0, [
      { tileId: "grass" },
      {
        tileId: "chest",
        itemId: "itm_chest",
        contents: [{ id: "itm_snack", tileId: "cherry" }],
      },
    ]);
    const session = new GameSession(map, tiles);
    session.drainEquipmentChanges();
    const chest = refAt(session, 1, 0);

    expect(
      session.consume({
        kind: "slot",
        slot: { kind: "ground", ref: chest, index: 0 },
      }),
    ).toBe(true);
    expect(getStack(session.getMap(), 1, 0, 0)[1]!.contents).toEqual([]);
    expect(session.drainEquipmentChanges()).toEqual([]);
  });

  it("refuses a chest the player has walked away from", () => {
    const map = replaceStack(field(), 3, 0, 0, [
      { tileId: "grass" },
      {
        tileId: "chest",
        itemId: "itm_chest",
        contents: [{ id: "itm_snack", tileId: "cherry" }],
      },
    ]);
    const session = new GameSession(map, tiles);
    const chest = refAt(session, 3, 0);

    expect(
      session.consume({
        kind: "slot",
        slot: { kind: "ground", ref: chest, index: 0 },
      }),
    ).toBe(false);
    expect(getStack(session.getMap(), 3, 0, 0)[1]!.contents).toHaveLength(1);
  });

  it("refuses a slot holding something that is not a consumable", () => {
    const session = withItem(1, 0, "sword");
    session.pickUp(refAt(session, 1, 0));

    expect(session.consume({ kind: "slot", slot: { kind: "contents", index: 0 } })).toBe(false);
    expect(session.getSnapshot().equipment.bag?.contents).toHaveLength(1);
  });

  it("refuses an empty slot", () => {
    const session = new GameSession(field(), tiles);
    expect(session.consume({ kind: "slot", slot: { kind: "contents", index: 0 } })).toBe(false);
  });
});

describe("the noise a consumable makes", () => {
  it("makes it where it was eaten, with nobody's name on it", () => {
    const session = withItem(1, 0, "cherry");
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });

    const heard = session.drainNoise();
    expect(heard).toHaveLength(1);
    expect(heard[0]!.text).toBe("crunch");
    expect({ x: heard[0]!.x, y: heard[0]!.y, z: heard[0]!.z }).toEqual({
      x: 0,
      y: 0,
      z: 0,
    });
    expect(session.drainSpeech()).toEqual([]);
  });

  it("carries no actor or tile to be named by", () => {
    const session = withItem(1, 0, "cherry");
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });

    const noise = session.drainNoise()[0]!;
    expect(noise).not.toHaveProperty("actorId");
    expect(noise).not.toHaveProperty("tileId");
  });

  it("makes it when the meal came out of a bag too", () => {
    const session = withItem(1, 0, "cherry");
    session.pickUp(refAt(session, 1, 0));
    session.drainNoise();

    session.consume({ kind: "slot", slot: { kind: "contents", index: 0 } });
    expect(session.drainNoise().map((s) => s.text)).toEqual(["crunch"]);
  });

  it("stays silent for one with no noise authored on it", () => {
    const session = withItem(1, 0, "quiet-cherry");
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });

    expect(session.drainNoise()).toEqual([]);
  });

  it("still sounds when the drink is the one that kills you", () => {
    const session = withItem(1, 0, "hemlock");
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });

    expect(session.actorSnapshots()).toEqual([]);
    expect(session.drainNoise().map((s) => s.text)).toEqual(["glug"]);
  });

  it("makes none when the consume was refused", () => {
    const session = withItem(2, 0, "cherry");
    session.consume({ kind: "floor", ref: refAt(session, 2, 0) });

    expect(session.drainNoise()).toEqual([]);
  });

  it("leaves the wire's copy behind at the next tick", () => {
    const session = withItem(1, 0, "cherry");
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });

    session.tick();
    expect(session.drainNoise()).toEqual([]);
  });

  it("keeps the world awake until the brains have had a turn at it", () => {
    const session = withItem(1, 0, "cherry");
    expect(session.isAtRest()).toBe(true);

    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });
    expect(session.isAtRest()).toBe(false);

    for (let elapsed = 0; elapsed < BRAIN_TICK_MS; elapsed += TICK_MS) {
      session.tick(TICK_MS);
    }
    expect(session.isAtRest()).toBe(true);
  });

  it("is still on screen after the tick that cleared the wire's copy", () => {
    const session = withItem(1, 0, "cherry");
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });

    session.tick();
    expect(session.getSnapshot().noises.map((n) => n.text)).toEqual(["crunch"]);
  });

  it("fades out of the snapshot once its time is up", () => {
    const session = withItem(1, 0, "cherry");
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });

    for (let elapsed = 0; elapsed <= NOISE_LIFETIME_MS; elapsed += TICK_MS) {
      session.tick(TICK_MS);
    }
    expect(session.getSnapshot().noises).toEqual([]);
  });
});

describe("a consumer with no hit points", () => {
  const ghostTiles = tiles.map((t) => (t.id === "player" ? { ...t, kind: "prop" as const } : t));

  it("refuses, and the thing is still there", () => {
    const map = replaceStack(field(), 1, 0, 0, [{ tileId: "grass" }, { tileId: "cherry" }]);
    const session = new GameSession(map, ghostTiles);

    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) })).toBe(false);
    expect(tilesAt(session, 1, 0)).toEqual(["grass", "cherry"]);
  });
});

describe("eating something that grants a status", () => {
  const FED_MS = 300_000;

  const catalogue = statusesById([
    {
      id: "fed",
      name: "Fed",
      description: "Slowly recovering health.",
      tone: "good",
      icon: { tilesetId: "ultima-vi", rect: { x: 48, y: 20, w: 1, h: 1 } },
      fromMs: FED_MS,
      toMs: FED_MS,
      stacks: true,
      maxMs: 3_600_000,
      everyMs: "ceil(MAX_HP / 100) * 300000 / MAX_HP / (2 - has_status('combat'))",
      effects: { hp: "ceil(MAX_HP / 100)" },
    },
  ]);

  function cadenceSecondsOf(def: StatusDef, fighting: boolean): number {
    const ms = def.everyMs.evaluate({
      DURATION_SEC: 0,
      REMAINING_SEC: 0,
      ELAPSED_SEC: 0,
      MAX_HP: PLAYER_MAX_HP,
      HP: PLAYER_MAX_HP,
      statuses: fighting ? [{ defId: COMBAT_STATUS_ID }] : [],
    });
    return snapToTick(ms) / 1000;
  }

  function fedWorld(): GameSession {
    let map = replaceStack(field(), 1, 0, 0, [{ tileId: "grass" }, { tileId: "berry" }]);
    map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }, { tileId: "poison" }]);
    return new GameSession(map, tiles, { statuses: catalogue });
  }

  function wound(session: GameSession) {
    session.consume({ kind: "floor", ref: refAt(session, 0, 1) });
  }

  function runSeconds(session: GameSession, seconds: number) {
    for (let i = 0; i < Math.round((seconds * 1000) / TICK_MS); i++) {
      session.tick(TICK_MS);
    }
  }

  function eatenOn(session: GameSession): string[] {
    return (session.statusesOf("local") ?? [])
      .map((s) => s.defId)
      .filter((id) => id !== COMBAT_STATUS_ID);
  }

  it("moves no hit points on the tick it is eaten", () => {
    const session = fedWorld();
    wound(session);
    const before = hpOf(session);
    expect(before).toBe(PLAYER_MAX_HP - 10);

    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) })).toBe(true);
    expect(hpOf(session)).toBe(before);
    expect(eatenOn(session)).toEqual(["fed"]);
  });

  it("heals a whole share of the maximum on a cadence set by the maximum", () => {
    const session = fedWorld();
    wound(session);
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });
    const start = hpOf(session)!;

    const perPeriod = Math.ceil(PLAYER_MAX_HP / 100);
    const periods = 3;
    expect(session.inCombat("local")).toBe(true);
    runSeconds(session, periods * cadenceSecondsOf(catalogue.fed!, true));
    expect(perPeriod * periods).toBeLessThan(10);
    expect(hpOf(session)).toBe(start + perPeriod * periods);
  });

  it("stops at the maximum", () => {
    const session = fedWorld();
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });
    runSeconds(session, 3 * cadenceSecondsOf(catalogue.fed!, false));
    expect(hpOf(session)).toBe(PLAYER_MAX_HP);
  });

  it("runs out, and stops", () => {
    const session = fedWorld();
    wound(session);
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });
    runSeconds(session, FED_MS / 1000);

    expect(eatenOn(session)).toEqual([]);
    expect(hpOf(session)).toBe(PLAYER_MAX_HP);
  });

  it("puts somebody hurt by what they ate in combat", () => {
    const session = fedWorld();
    expect(session.inCombat("local")).toBe(false);
    wound(session);
    expect(session.inCombat("local")).toBe(true);
  });

  it("puts somebody a status is hurting in combat", () => {
    const authored = statusesById(statusesJson as unknown[]);
    const session = new GameSession(field(), tiles, { statuses: authored });
    session.runCommand("/status poison");
    expect(session.inCombat("local")).toBe(false);

    runSeconds(session, cadenceSecondsOf(authored.poison!, false));

    expect(session.inCombat("local")).toBe(true);
  });

  it("stacks a second helping onto what is left", () => {
    const map = replaceStack(
      replaceStack(field(), 1, 0, 0, [{ tileId: "grass" }, { tileId: "berry" }]),
      0,
      1,
      0,
      [{ tileId: "grass" }, { tileId: "berry" }],
    );
    const session = new GameSession(map, tiles, { statuses: catalogue });
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });
    session.consume({ kind: "floor", ref: refAt(session, 0, 1) });
    expect(session.statusesOf("local")).toHaveLength(1);
    expect(session.statusesOf("local")![0]!.remainingMs).toBe(FED_MS * 2);
  });

  it("takes the item's duration over the status's own", () => {
    const map = replaceStack(field(), 1, 0, 0, [{ tileId: "grass" }, { tileId: "bread" }]);
    const session = new GameSession(map, tiles, { statuses: catalogue });

    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });

    expect(session.statusesOf("local")![0]!.remainingMs).toBe(60_000);
  });

  it("stacks a meal onto a snack as one status", () => {
    const map = replaceStack(
      replaceStack(field(), 1, 0, 0, [{ tileId: "grass" }, { tileId: "berry" }]),
      0,
      1,
      0,
      [{ tileId: "grass" }, { tileId: "bread" }],
    );
    const session = new GameSession(map, tiles, { statuses: catalogue });

    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });
    session.consume({ kind: "floor", ref: refAt(session, 0, 1) });

    expect(session.statusesOf("local")).toHaveLength(1);
    expect(session.statusesOf("local")![0]!.remainingMs).toBe(FED_MS + 60_000);
  });

  it("eats an item naming a status nobody authored, and does nothing", () => {
    const map = replaceStack(field(), 1, 0, 0, [{ tileId: "grass" }, { tileId: "mystery-fruit" }]);
    const session = new GameSession(map, tiles, { statuses: catalogue });
    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) })).toBe(true);
    expect(session.statusesOf("local")).toEqual([]);
    expect(tilesAt(session, 1, 0)).toEqual(["grass"]);
  });
});

describe("drinking the green potion, as authored", () => {
  const catalogue = statusesById(statusesJson);

  function potionWorld(): GameSession {
    const map = replaceStack(field(), 1, 0, 0, [{ tileId: "grass" }, { tileId: "green-potion" }]);
    return new GameSession(map, tiles, { statuses: catalogue });
  }

  it("grants poison and spends the bottle", () => {
    const session = potionWorld();
    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) })).toBe(true);
    expect(tilesAt(session, 1, 0)).toEqual(["grass"]);
    const held = session.statusesOf("local");
    expect(held?.map((s) => s.defId)).toEqual(["poison"]);
    expect(held![0]!.remainingMs).toBeGreaterThanOrEqual(10_000);
    expect(held![0]!.remainingMs).toBeLessThanOrEqual(30_000);
  });

  it("moves no hit points on the tick it is drunk", () => {
    const session = potionWorld();
    expect(hpOf(session)).toBe(PLAYER_MAX_HP);
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });
    expect(hpOf(session)).toBe(PLAYER_MAX_HP);
  });
});

describe("a drink that leaves its bottle", () => {
  const BAG_SLOT = { kind: "contents", index: 0 } as const;

  function bagOf(session: GameSession) {
    return session
      .getSnapshot()
      .equipment.bag?.contents?.map((i) => (i.count ? `${i.tileId}x${i.count}` : i.tileId));
  }

  function fillBag(session: GameSession) {
    for (const [x, y] of [
      [-1, 0],
      [-1, 1],
      [0, -1],
      [-1, -1],
    ] as const) {
      session.pickUp(refAt(session, x, y));
    }
  }

  function armoury(): GameSession {
    let map = field();
    for (const [x, y] of [
      [-1, 0],
      [-1, 1],
      [0, -1],
      [-1, -1],
    ] as const) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }, { tileId: "sword" }]);
    }
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "potion" }]);
    return new GameSession(map, tiles);
  }

  it("leaves the bottle on the floor when drunk where it lay", () => {
    const session = withItem(1, 0, "potion");
    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) })).toBe(true);
    expect(tilesAt(session, 1, 0)).toEqual(["grass", "bottle"]);
    expect(bagOf(session)).toEqual([]);
  });

  it("pours a second bottle onto the first on the floor", () => {
    const map = replaceStack(field(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "bottle" },
      { tileId: "potion", count: 2 },
    ]);
    const session = new GameSession(map, tiles);
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });
    expect(getStack(session.getMap(), 1, 0, 0)).toMatchObject([
      { tileId: "grass" },
      { tileId: "bottle", count: 2 },
      { tileId: "potion" },
    ]);
  });

  it("leaves the bottle in the bag the potion was drunk out of", () => {
    const session = withItem(1, 0, "potion");
    session.pickUp(refAt(session, 1, 0));
    session.drainEquipmentChanges();

    expect(session.consume({ kind: "slot", slot: BAG_SLOT })).toBe(true);
    expect(bagOf(session)).toEqual(["bottle"]);
    expect(session.drainEquipmentChanges()).toEqual([session.getSnapshot().self.id]);
  });

  it("pours onto the bottles already in the bag", () => {
    const map = replaceStack(field(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "potion", count: 3 },
    ]);
    const session = new GameSession(map, tiles);
    session.pickUp(refAt(session, 1, 0));
    session.consume({ kind: "slot", slot: BAG_SLOT });
    session.consume({ kind: "slot", slot: BAG_SLOT });
    expect(bagOf(session)).toEqual(["potion", "bottlex2"]);
  });

  it("leaves the bottle in the hand that held the potion", () => {
    const session = armoury();
    fillBag(session);
    session.pickUp(refAt(session, 1, 0));
    expect(session.getSnapshot().equipment.offhand?.tileId).toBe("potion");

    expect(session.consume({ kind: "slot", slot: { kind: "offhand" } })).toBe(true);
    expect(session.getSnapshot().equipment.offhand?.tileId).toBe("bottle");
  });

  it("leaves the bottle in a chest the potion was drunk out of", () => {
    const map = replaceStack(field(), 1, 0, 0, [
      { tileId: "grass" },
      {
        tileId: "chest",
        itemId: "itm_chest",
        contents: [{ id: "itm_potion", tileId: "potion" }],
      },
    ]);
    const session = new GameSession(map, tiles);
    const chest = refAt(session, 1, 0);
    expect(session.consume({ kind: "slot", slot: { kind: "ground", ref: chest, index: 0 } })).toBe(
      true,
    );
    expect(getStack(session.getMap(), 1, 0, 0)[1]!.contents?.map((i) => i.tileId)).toEqual([
      "bottle",
    ]);
  });

  it("refuses the drink, says so, and leaves the potion where it was", () => {
    let map = field();
    for (const [x, y] of [
      [-1, 0],
      [-1, 1],
      [0, -1],
      [-1, -1],
    ] as const) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }, { tileId: "sword" }]);
    }
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "potion", count: 2 }]);
    map = replaceStack(map, 1, 1, 0, [{ tileId: "grass" }, { tileId: "cherry" }]);
    const session = new GameSession(map, tiles);
    fillBag(session);
    session.pickUp(refAt(session, 1, 0));
    session.pickUp(refAt(session, 1, 1));
    expect(session.getSnapshot().equipment.offhand).toMatchObject({ tileId: "potion", count: 2 });
    expect(session.getSnapshot().equipment.weapon?.tileId).toBe("cherry");
    session.drainEquipmentChanges();

    expect(session.consume({ kind: "slot", slot: { kind: "offhand" } })).toBe(false);
    expect(session.getSnapshot().equipment.offhand).toMatchObject({ tileId: "potion", count: 2 });
    expect(session.drainEquipmentChanges()).toEqual([]);
    expect(session.drainNotices()).toEqual(["There is nowhere to put bottle"]);
  });

  it("refuses a floor drink whose bottle the cell cannot hold", () => {
    const map = replaceStack(field(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "crate" },
      { tileId: "crate" },
      { tileId: "crate" },
      { tileId: "potion" },
    ]);
    const session = new GameSession(map, tiles);
    const before = tilesAt(session, 1, 0);
    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) })).toBe(false);
    expect(tilesAt(session, 1, 0)).toEqual(before);
    expect(session.drainNotices()).toEqual(["There is nowhere to put bottle"]);
  });

  it("leaves nothing for a residue the catalogue no longer holds", () => {
    const session = withItem(1, 0, "lost-potion");
    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) })).toBe(true);
    expect(tilesAt(session, 1, 0)).toEqual(["grass"]);
    expect(session.drainNotices()).toEqual([]);
  });
});

describe("drinking the luminous potion, as authored", () => {
  const catalogue = statusesById(statusesJson);
  const HOUR_MS = 60 * 60 * 1000;

  function potionWorld(): GameSession {
    const map = replaceStack(field(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "luminous-potion" },
    ]);
    return new GameSession(map, tiles, { statuses: catalogue });
  }

  it("glows for a real hour, and leaves the bottle where it stood", () => {
    const session = potionWorld();
    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) })).toBe(true);
    expect(tilesAt(session, 1, 0)).toEqual(["grass", "empty-bottle"]);
    const held = session.statusesOf("local");
    expect(held?.map((s) => s.defId)).toEqual(["luminous"]);
    expect(held![0]!.remainingMs).toBe(HOUR_MS);
  });

  it("glows because the status carries a light, and nothing else", () => {
    const luminous = catalogue.luminous;
    expect(luminous).toBeDefined();
    expect(luminous!.vfx.light).not.toBeNull();
    expect(luminous!.vfx.light!.radius).toBeGreaterThan(0);
  });

  it("puts the bottle in the bag when drunk out of it", () => {
    const session = potionWorld();
    session.pickUp(refAt(session, 1, 0));
    expect(session.consume({ kind: "slot", slot: { kind: "contents", index: 0 } })).toBe(true);
    expect(session.getSnapshot().equipment.bag?.contents?.map((i) => i.tileId)).toEqual([
      "empty-bottle",
    ]);
  });
});

describe("eating raw meat, as authored", () => {
  const catalogue = statusesById(statusesJson);

  const carnivores: TileDef[] = [
    ...tiles,
    ...normalizeTiles(tilesJson as unknown[]).filter((t) => ["raw-meat", "wolf"].includes(t.id)),
  ];

  function meatWorld(seed: number, eater = "player"): GameSession {
    let map = replaceStack(field(), 1, 0, 0, [{ tileId: "grass" }, { tileId: "raw-meat" }]);
    if (eater !== "player") {
      map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }, { tileId: eater }]);
    }
    return new GameSession(map, carnivores, { statuses: catalogue, seed });
  }

  function heldBy(session: GameSession, id: string): string[] {
    return (session.statusesOf(id) ?? []).map((one) => one.defId);
  }

  it("always feeds, and does not take a bite out of you", () => {
    const session = meatWorld(1);
    const before = hpOf(session);

    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) })).toBe(true);

    expect(heldBy(session, "local")).toContain("fed");
    expect(hpOf(session)).toBe(before);
  });

  it("turns your stomach most of the time, but not always", () => {
    const ill = [...Array(20).keys()].filter((seed) => {
      const session = meatWorld(seed);
      session.consume({ kind: "floor", ref: refAt(session, 1, 0) });
      return heldBy(session, "local").includes("food-poisoning");
    });

    expect(ill.length).toBeGreaterThan(0);
    expect(ill.length).toBeLessThan(20);
  });

  it("never makes a wolf ill, whatever the dice say", () => {
    for (const seed of [...Array(20).keys()]) {
      const session = meatWorld(seed, "wolf");
      const wolf = session.actorIds().find((id) => id !== "local" && id !== "alice")!;
      session.consume({ kind: "floor", ref: refAt(session, 1, 0) }, wolf);

      expect(heldBy(session, wolf)).toEqual(["fed"]);
    }
  });
});
