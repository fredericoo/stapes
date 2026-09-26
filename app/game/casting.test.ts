import { describe, expect, it } from "vitest";
import statusesJson from "../../data/statuses.json";
import tilesJson from "../../data/tiles.json";
import { ARMOR_SLOTS, resolveCharm, resolveItem, resolveStone } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { spellElements } from "../lib/mastery";
import { resolveProjectile } from "../lib/projectile";
import { statusesById } from "../lib/status";
import { resolveBattler } from "../lib/battler";
import { type Masteries, MAX_MASTERY, meetsRequirements } from "../lib/mastery";
import { type Element, ELEMENTS } from "../lib/element";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTiles } from "../lib/types";
import { emptyMap, replaceStack } from "../lib/mapData";
import { tilesByIdFromList } from "../lib/validation";
import {
  CAST_SQUARES,
  castability,
  castableSpells,
  squareSlot,
  castDurationMs,
  type CastContext,
  type CasterPoint,
  type CastPoint,
  conjureLanding,
  spellPress,
  spellReading,
} from "./casting";
import { damageFraction } from "./combat";
import {
  emptyEquipment,
  handAccepts,
  handToSwing,
  type Equipment,
  weaponSwungBy,
  wornAccepts,
} from "./equipment";
import { tile } from "../lib/testTile";

function stoneTile(id: string, item: Record<string, unknown>): TileDef {
  return tile({
    id,
    kind: "item",
    lightPassing: true,
    intangible: true,
    interactions: { item: { type: "stone", ...item } },
  });
}

function charmTile(id: string, item: Record<string, unknown>): TileDef {
  return tile({
    id,
    kind: "item",
    lightPassing: true,
    intangible: true,
    interactions: { item: { type: "charm", ...item } },
  });
}

const NEAR_REACH = { cells: 3, height: 2 };

const tiles: TileDef[] = [
  tile({ id: "grass" }),
  tile({ id: "wall", height: 4, lightPassing: false }),
  stoneTile("mend-stone", {
    effect: { kind: "bolt", damage: -10, on: "caster" },
    cooldownMs: 60_000,
  }),
  stoneTile("bolt-stone", {
    effect: {
      kind: "bolt",
      damage: 10,
      on: "target",
      projectile: "arrow",
    },
    cooldownMs: 20_000,
    reach: NEAR_REACH,
  }),
  stoneTile("ward-stone", {
    effect: {
      kind: "bolt",
      on: "caster",
      statuses: [{ id: "luminous", chance: 100 }],
    },
    cooldownMs: 30_000,
  }),
  stoneTile("curse-stone", {
    effect: {
      kind: "bolt",
      on: "target",
      statuses: [{ id: "burned", chance: 100 }],
    },
    cooldownMs: 30_000,
    reach: NEAR_REACH,
  }),
  stoneTile("flame-stone", {
    effect: { kind: "conjure", tileId: "fire" },
    cooldownMs: 120_000,
    reach: NEAR_REACH,
  }),
  stoneTile("adept-stone", {
    effect: { kind: "bolt", damage: -5, on: "caster" },
    cooldownMs: 10_000,
    requirements: { arcane: 10 },
  }),
  charmTile("life-charm", { everyMs: 10_000, hp: 5 }),
  charmTile("balm-charm", {
    everyMs: 10_000,
    hp: 5,
    statuses: [{ id: "luminous", chance: 100 }],
  }),
  tile({
    id: "sword",
    kind: "item",
    interactions: {
      item: {
        type: "weapon",
        damage: 5,
        def: 0,
        accuracy: 90,
        variance: 0,
        spd: 50,
        mastery: "sharp",
      },
    },
  }),
  tile({
    id: "helm",
    kind: "item",
    interactions: { item: { type: "armor", slot: "head", def: 2 } },
  }),
  tile({ id: "fire", intangible: true, lightPassing: true }),
  tile({ id: "body", height: 2 }),
  tile({ id: "rat", height: 2, interactions: { brain: { kind: "wander" } } }),
  tile({ id: "water", walkable: false }),
  tile({ id: "bush", height: 2, walkable: false }),
];

const tilesById = tilesByIdFromList(tiles);

let nextId = 0;
function instance(tileId: string, cooldownMs?: number): ItemInstance {
  return {
    id: `itm_${++nextId}`,
    tileId,
    ...(cooldownMs === undefined ? {} : { cooldownMs }),
  };
}

function open(apart: number): MapFile {
  let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
  for (let x = 1; x <= apart; x++) {
    map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
  }
  return map;
}

const HERE: CasterPoint = {
  x: 0,
  y: 0,
  z: 0,
  elevAbs: 0,
  stackIndex: 1,
  facing: "e",
  tileId: "body",
};
const point = (x: number): CastPoint => ({
  x,
  y: 0,
  z: 0,
  elevAbs: 0,
  stackIndex: 1,
});

function inFront(tileId: string): MapFile {
  return replaceStack(open(6), 1, 0, 0, [{ tileId: "grass" }, { tileId }]);
}

function context(equipment: Partial<Equipment>, extra: Partial<CastContext> = {}): CastContext {
  return {
    map: open(6),
    tilesById,
    equipment: { ...emptyEquipment(), ...equipment },
    masteries: {},
    caster: HERE,
    casting: null,
    spells: [],
    spellCooldownsMs: {},
    target: null,
    ...extra,
  };
}

describe("why a stone cannot be cast", () => {
  it("refuses an empty square", () => {
    expect(castability(context({}), squareSlot("weapon"))).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("refuses a square holding something that is not a stone", () => {
    expect(castability(context({ weapon: instance("sword") }), squareSlot("weapon"))).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("refuses every square while a cast is running, naming the one it came from", () => {
    const casting = context(
      { weapon: instance("mend-stone"), offhand: instance("ward-stone") },
      { casting: { remainingMs: 1_500, durationMs: 3_000, slot: squareSlot("weapon") } },
    );

    expect(castability(casting, squareSlot("weapon"))).toEqual({
      ok: false,
      reason: "underway",
    });
    expect(castability(casting, squareSlot("offhand"))).toEqual({
      ok: false,
      reason: "casting",
    });
  });

  it("refuses a stone that is still cooling", () => {
    expect(
      castability(context({ weapon: instance("mend-stone", 4_000) }), squareSlot("weapon")),
    ).toEqual({ ok: false, reason: "cooling" });
  });

  it("says cooling over out of range when both are true", () => {
    const state = context({ weapon: instance("curse-stone", 4_000) }, { target: point(6) });
    expect(castability(state, squareSlot("weapon"))).toEqual({
      ok: false,
      reason: "cooling",
    });
  });

  it("refuses a stone whose mastery has not been earned", () => {
    expect(
      castability(
        context({ weapon: instance("adept-stone") }, { masteries: { arcane: 9 } }),
        squareSlot("weapon"),
      ),
    ).toEqual({ ok: false, reason: "mastery" });
  });

  it("allows one whose mastery has been met exactly", () => {
    expect(
      castability(
        context({ weapon: instance("adept-stone") }, { masteries: { arcane: 10 } }),
        squareSlot("weapon"),
      ),
    ).toEqual({ ok: true });
  });

  it("allows one that asks for nothing, of a caster who has nothing", () => {
    expect(
      castability(
        context({ weapon: instance("mend-stone") }, { masteries: {} }),
        squareSlot("weapon"),
      ),
    ).toEqual({ ok: true });
  });

  it("refuses a stone that acts on a target when nobody is targeted", () => {
    expect(castability(context({ weapon: instance("curse-stone") }), squareSlot("weapon"))).toEqual(
      { ok: false, reason: "noTarget" },
    );
  });

  it("refuses a bolt that takes health at somebody it may not harm", () => {
    const state = context(
      { weapon: instance("bolt-stone") },
      { target: point(1), mayHarmTarget: false },
    );
    expect(castability(state, squareSlot("weapon"))).toEqual({
      ok: false,
      reason: "peaceful",
    });
  });

  it("refuses every stone to a caster who cannot act", () => {
    const state = context(
      { weapon: instance("bolt-stone") },
      { target: point(1), incapacitated: true },
    );
    expect(castability(state, squareSlot("weapon"))).toEqual({
      ok: false,
      reason: "incapacitated",
    });
  });

  it("allows the same bolt at anybody else", () => {
    const state = context({ weapon: instance("bolt-stone") }, { target: point(1) });
    expect(castability(state, squareSlot("weapon"))).toEqual({ ok: true });
  });

  it("allows a bolt that takes no health, curse or no curse", () => {
    const state = context(
      { weapon: instance("curse-stone") },
      { target: point(1), mayHarmTarget: false },
    );
    expect(castability(state, squareSlot("weapon"))).toEqual({ ok: true });
  });

  it("refuses a target out of the stone's reach", () => {
    const state = context({ weapon: instance("curse-stone") }, { target: point(5) });
    expect(castability(state, squareSlot("weapon"))).toEqual({
      ok: false,
      reason: "outOfRange",
    });
  });

  it("refuses a target in reach with a wall in the way", () => {
    let map = open(4);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "wall" }]);
    const state = context({ weapon: instance("curse-stone") }, { map, target: point(2) });
    expect(castability(state, squareSlot("weapon"))).toEqual({
      ok: false,
      reason: "outOfRange",
    });
  });

  it("allows a target inside the reach with a clear line", () => {
    const state = context({ weapon: instance("curse-stone") }, { target: point(2) });
    expect(castability(state, squareSlot("weapon"))).toEqual({ ok: true });
  });
});

describe("a stone that acts on its caster", () => {
  it("works with no target and ignores one entirely", () => {
    const alone = context({ weapon: instance("mend-stone") });
    expect(castability(alone, squareSlot("weapon"))).toEqual({ ok: true });

    const aiming = context({ weapon: instance("mend-stone") }, { target: point(6) });
    expect(castability(aiming, squareSlot("weapon"))).toEqual({ ok: true });
  });

  it("does the same for a status the stone puts on its caster", () => {
    expect(castability(context({ weapon: instance("ward-stone") }), squareSlot("weapon"))).toEqual({
      ok: true,
    });
  });
});

describe("a conjuring stone", () => {
  it("can be cast with nothing targeted", () => {
    expect(castability(context({ weapon: instance("flame-stone") }), squareSlot("weapon"))).toEqual(
      { ok: true },
    );
  });

  it("is still held to its reach when something is targeted", () => {
    const near = context({ weapon: instance("flame-stone") }, { target: point(2) });
    expect(castability(near, squareSlot("weapon"))).toEqual({ ok: true });

    const far = context({ weapon: instance("flame-stone") }, { target: point(5) });
    expect(castability(far, squareSlot("weapon"))).toEqual({
      ok: false,
      reason: "outOfRange",
    });
  });

  it("lands on the cell the caster faces", () => {
    const state = context({});
    expect(conjureLanding(state, "fire")).toEqual({ at: { x: 1, y: 0, z: 0 } });

    const west = context({}, { caster: { ...HERE, x: 3, facing: "w" } });
    expect(conjureLanding(west, "fire")).toEqual({ at: { x: 2, y: 0, z: 0 } });
  });

  it("lands beneath whoever is standing in the cell it faces", () => {
    const state = context({}, { map: inFront("rat") });
    expect(conjureLanding(state, "fire")).toEqual({
      at: { x: 1, y: 0, z: 0 },
      under: 1,
    });
  });

  it("lands beneath a target, so they are standing in it", () => {
    const state = context({}, { target: point(2) });
    expect(conjureLanding(state, "fire")).toEqual({
      at: { x: 2, y: 0, z: 0 },
      under: 1,
    });
  });

  it.each(["wall", "bush", "water"])("refuses to conjure where a %s is in front", (tileId) => {
    const state = context(
      { weapon: instance("flame-stone") },
      { map: tileId === "water" ? waterInFront() : inFront(tileId) },
    );
    expect(castability(state, squareSlot("weapon"))).toEqual({
      ok: false,
      reason: "blocked",
    });
  });
});

function waterInFront(): MapFile {
  return replaceStack(open(6), 1, 0, 0, [{ tileId: "water" }]);
}

describe("the charm square", () => {
  it("asks for a target exactly as a hand does", () => {
    const nobodyTargeted = context({
      charm: instance("curse-stone"),
      weapon: instance("curse-stone"),
    });
    expect(castability(nobodyTargeted, squareSlot("charm"))).toEqual({
      ok: false,
      reason: "noTarget",
    });
    expect(castability(nobodyTargeted, squareSlot("weapon"))).toEqual({
      ok: false,
      reason: "noTarget",
    });
  });

  it("is held to the stone's reach exactly as a hand is", () => {
    const near = context(
      { charm: instance("curse-stone"), weapon: instance("curse-stone") },
      { target: point(2) },
    );
    expect(castability(near, squareSlot("charm"))).toEqual({ ok: true });
    expect(castability(near, squareSlot("weapon"))).toEqual({ ok: true });

    const far = context(
      { charm: instance("curse-stone"), weapon: instance("curse-stone") },
      { target: point(6) },
    );
    expect(castability(far, squareSlot("charm"))).toEqual({
      ok: false,
      reason: "outOfRange",
    });
    expect(castability(far, squareSlot("weapon"))).toEqual({
      ok: false,
      reason: "outOfRange",
    });
  });

  it("is the only square that takes a charm", () => {
    expect(wornAccepts("charm", tilesById["life-charm"]!)).toBe(true);
    expect(handAccepts(tilesById["life-charm"]!)).toBe(false);
    for (const slot of ARMOR_SLOTS) {
      if (slot === "charm") continue;
      expect(wornAccepts(slot, tilesById["life-charm"]!), slot).toBe(false);
    }
  });

  it("takes a stone that either hand would also take", () => {
    expect(wornAccepts("charm", tilesById["mend-stone"]!)).toBe(true);
    expect(handAccepts(tilesById["mend-stone"]!)).toBe(true);
  });
});

describe("what the squares will take", () => {
  it("lets either hand hold a stone that is pressed", () => {
    expect(handAccepts(tilesById["mend-stone"]!)).toBe(true);
  });

  it("refuses a hand a charm, and the charm square takes it", () => {
    expect(handAccepts(tilesById["life-charm"]!)).toBe(false);
    expect(wornAccepts("charm", tilesById["life-charm"]!)).toBe(true);
  });

  it("takes a stone on the charm and nowhere else that is worn", () => {
    expect(wornAccepts("charm", tilesById["mend-stone"]!)).toBe(true);
    for (const slot of ["head", "armor", "footwear"] as const) {
      expect(wornAccepts(slot, tilesById["mend-stone"]!)).toBe(false);
    }
  });

  it("still takes armour in the square that armour names", () => {
    expect(wornAccepts("head", tilesById.helm!)).toBe(true);
    expect(wornAccepts("charm", tilesById.helm!)).toBe(false);
  });
});

describe("the rotation, unchanged", () => {
  it("takes no turn for a hand holding a stone", () => {
    const kit = {
      ...emptyEquipment(),
      weapon: instance("mend-stone"),
    };
    expect(weaponSwungBy(kit, tilesById, "weapon")).toBeNull();
  });

  it("swings the weapon every turn beside a stone", () => {
    const kit = {
      ...emptyEquipment(),
      weapon: instance("sword"),
      offhand: instance("mend-stone"),
    };
    expect(handToSwing(kit, tilesById, "weapon")).toBe("weapon");
    expect(handToSwing(kit, tilesById, "offhand")).toBe("weapon");
  });

  it("falls back to the natural weapon with two stones", () => {
    const kit = {
      ...emptyEquipment(),
      weapon: instance("mend-stone"),
      offhand: instance("ward-stone"),
    };
    expect(handToSwing(kit, tilesById, "weapon")).toBeNull();
  });
});

describe("the row of buttons", () => {
  it("is empty for a body carrying no stones", () => {
    expect(castableSpells(context({ weapon: instance("sword") }))).toEqual([]);
  });

  it("has one button per stone, in square order", () => {
    const buttons = castableSpells(
      context({
        weapon: instance("mend-stone"),
        offhand: instance("sword"),
        charm: instance("ward-stone"),
      }),
    );
    expect(buttons.map((button) => button.slot)).toEqual([
      squareSlot("weapon"),
      squareSlot("charm"),
    ]);
  });

  it("leaves out a stone the caster has not earned", () => {
    expect(
      castableSpells(context({ weapon: instance("adept-stone") }, { masteries: { arcane: 9 } })),
    ).toEqual([]);
  });

  it("offers it as soon as the mastery is met", () => {
    const buttons = castableSpells(
      context({ weapon: instance("adept-stone") }, { masteries: { arcane: 10 } }),
    );
    expect(buttons.map((button) => button.tileId)).toEqual(["adept-stone"]);
  });

  it("leaves it out while the caster is part-way through another cast", () => {
    const buttons = castableSpells(
      context(
        { weapon: instance("mend-stone"), charm: instance("adept-stone") },
        {
          masteries: { arcane: 9 },
          casting: { remainingMs: 1_500, durationMs: 3_000, slot: squareSlot("weapon") },
        },
      ),
    );
    expect(buttons.map((button) => button.slot)).toEqual([squareSlot("weapon")]);
  });

  it("carries the stone's own sprite and its cooldown", () => {
    const [button] = castableSpells(context({ weapon: instance("mend-stone", 4_000) }));
    expect(button).toMatchObject({
      tileId: "mend-stone",
      cooldownMs: 4_000,
      cooldownTotalMs: 60_000,
      castability: { ok: false, reason: "cooling" },
    });
  });

  it("never offers a fourth, because there is no fourth square", () => {
    expect(CAST_SQUARES).toHaveLength(3);
  });
});

describe("what a row of buttons says", () => {
  it("reads the same across one second of cooling", () => {
    const at = (cooldownMs: number) =>
      spellReading(castableSpells(context({ weapon: instance("mend-stone", cooldownMs) })));
    expect(at(4_400).replace(/itm_\d+/, "x")).toBe(at(4_001).replace(/itm_\d+/, "x"));
    expect(at(4_400).replace(/itm_\d+/, "x")).not.toBe(at(3_400).replace(/itm_\d+/, "x"));
  });

  it("is empty for a body with nothing to press", () => {
    expect(spellReading([])).toBe("");
  });
});

const LADDER: Record<Element, readonly string[]> = {
  fire: ["arcane-stone-of-cinder", "arcane-stone-of-ember", "arcane-stone-of-pyre"],
  water: ["arcane-stone-of-sleet", "arcane-stone-of-frost", "arcane-stone-of-rime"],
  nature: ["arcane-stone-of-barbs", "arcane-stone-of-thorns", "arcane-stone-of-bramble"],
};

const TRAITS: Record<Element, { damage: number; variance: number; cooldown: number }> = {
  fire: { damage: 1, variance: 60, cooldown: 0.8 },
  water: { damage: 1, variance: 25, cooldown: 1 },
  nature: { damage: 1.2, variance: 25, cooldown: 1.2 },
};

const LEAVES: Record<Element, string> = {
  fire: "burned",
  water: "chilled",
  nature: "poison",
};

const NEUTRAL_LADDER = [
  "arcane-stone-of-spark",
  "arcane-stone-of-bolt",
  "arcane-stone-of-lance",
] as const;

const ELEMENTAL_ARCANE_GAP = 5;

const BESIDE_THE_LADDER = ["arcane-stone-of-flame", "arcane-stone-of-verdance"];

describe("the stones we ship", () => {
  const shipped = tilesByIdFromList(normalizeTiles(tilesJson as unknown[]));
  const statusDefs = statusesById(statusesJson as unknown[]);

  const SHIPPED = [...ELEMENTS.flatMap((e) => LADDER[e]), ...NEUTRAL_LADDER, ...BESIDE_THE_LADDER];

  function rung(element: Element, index: number) {
    const id = LADDER[element][index]!;
    const stone = resolveStone(shipped[id]!);
    if (!stone) throw new Error(`${id} is not a stone`);
    return stone;
  }

  function neutral(index: number) {
    const id = NEUTRAL_LADDER[index]!;
    const stone = resolveStone(shipped[id]!);
    if (!stone) throw new Error(`${id} is not a stone`);
    return stone;
  }

  function neutralBolt(index: number) {
    const effect = neutral(index).effect;
    if (effect.kind !== "bolt") throw new Error(`neutral ${index} is not a bolt`);
    return effect;
  }

  function bolt(element: Element, index: number) {
    const effect = rung(element, index).effect;
    if (effect.kind !== "bolt") throw new Error(`${element} ${index} is not a bolt`);
    return effect;
  }

  it("parses every one of them as a stone", () => {
    for (const id of SHIPPED) {
      const def = shipped[id];
      expect(def, id).toBeDefined();
      expect(resolveStone(def!), id).not.toBeNull();
    }
  });

  it("uses both of the two effects", () => {
    const kinds = SHIPPED.map((id) => resolveStone(shipped[id]!)!.effect.kind);
    expect([...new Set(kinds)].sort()).toEqual(["bolt", "conjure"]);
  });

  it("ships a bolt that mends and a bolt that harms", () => {
    const verdance = resolveStone(shipped["arcane-stone-of-verdance"]!)!;
    expect(verdance.effect).toMatchObject({ kind: "bolt", on: "caster" });
    if (verdance.effect.kind !== "bolt") return;
    expect(verdance.effect.damage).toBeLessThan(0);

    const first = bolt("fire", 0);
    expect(first.on).toBe("target");
    expect(first.damage).toBeGreaterThan(0);
    expect(resolveProjectile(shipped[first.projectile!])).not.toBeNull();
  });

  it("gives every stone a cast time", () => {
    for (const id of SHIPPED) {
      expect(resolveStone(shipped[id]!)!.castTimeMs ?? 0, id).toBeGreaterThan(0);
    }
  });

  it("makes Flame quick for an arcanist who has outgrown it", () => {
    const flame = resolveStone(shipped["arcane-stone-of-flame"]!)!;
    const asks = flame.requirements!;

    expect(castDurationMs(flame, asks)).toBe(3_000);
    expect(castDurationMs(flame, { ...asks, arcane: 16 })).toBeLessThan(2_000);
    expect(castDurationMs(flame, { arcane: MAX_MASTERY, fire: MAX_MASTERY })).toBe(0);
  });

  it("names a status and a tile the world actually has", () => {
    for (const element of ELEMENTS) {
      for (let index = 0; index < LADDER[element].length; index++) {
        for (const status of bolt(element, index).statuses ?? []) {
          expect(statusDefs[status.id], status.id).toBeDefined();
        }
      }
    }

    const flame = resolveStone(shipped["arcane-stone-of-flame"]!)!;
    expect(flame.effect.kind).toBe("conjure");
    if (flame.effect.kind !== "conjure") return;
    expect(shipped[flame.effect.tileId]).toBeDefined();
  });

  it("climbs damage, cooldown, cast time, reach and requirements at every step", () => {
    for (const element of ELEMENTS) {
      for (let index = 1; index < LADDER[element].length; index++) {
        const below = rung(element, index - 1);
        const above = rung(element, index);
        const where = `${element} ${index - 1} -> ${index}`;

        expect(bolt(element, index).damage, where).toBeGreaterThan(
          bolt(element, index - 1).damage!,
        );
        expect(above.cooldownMs, where).toBeGreaterThan(below.cooldownMs);
        expect(above.castTimeMs!, where).toBeGreaterThan(below.castTimeMs!);
        expect(above.reach!.cells, where).toBeGreaterThan(below.reach!.cells);
        expect(above.requirements!.arcane, where).toBeGreaterThan(below.requirements!.arcane!);
        expect(above.requirements![element], where).toBeGreaterThan(below.requirements![element]!);
      }
    }
  });

  it("gives each element the same character on every rung", () => {
    for (const element of ELEMENTS) {
      const trait = TRAITS[element];
      for (let index = 0; index < LADDER[element].length; index++) {
        const where = `${element} rung ${index}`;

        expect(bolt(element, index).damage, where).toBe(
          bolt("water", index).damage! * trait.damage,
        );
        expect(bolt(element, index).variance, where).toBe(trait.variance);
        expect(rung(element, index).cooldownMs, where).toBe(
          rung("water", index).cooldownMs * trait.cooldown,
        );
      }
    }
  });

  it("comes to the same expected damage a second on every element", () => {
    for (let index = 0; index < LADDER.water.length; index++) {
      const rates = ELEMENTS.map((element) => {
        const effect = bolt(element, index);
        const mean = effect.damage! * damageFraction(effect.variance!, [0.5, 0.5]);
        return mean / rung(element, index).cooldownMs;
      });
      for (const rate of rates) {
        expect(rate, `rung ${index}`).toBeCloseTo(rates[0]!, 10);
      }
    }
  });

  it("asks and reaches the same whichever element you climbed", () => {
    for (const element of ELEMENTS) {
      for (let index = 0; index < LADDER[element].length; index++) {
        const where = `${element} rung ${index}`;
        const stone = rung(element, index);
        const yardstick = rung("water", index);

        expect(stone.reach, where).toEqual(yardstick.reach);
        expect(stone.castTimeMs, where).toBe(yardstick.castTimeMs);
        expect(stone.requirements!.arcane, where).toBe(yardstick.requirements!.arcane);
        expect(stone.requirements![element], where).toBe(yardstick.requirements!.water);
      }
    }
  });

  it("climbs the neutral ladder at every step too", () => {
    for (let index = 1; index < NEUTRAL_LADDER.length; index++) {
      const below = neutral(index - 1);
      const above = neutral(index);
      const where = `neutral ${index - 1} -> ${index}`;

      expect(neutralBolt(index).damage, where).toBeGreaterThan(neutralBolt(index - 1).damage!);
      expect(above.cooldownMs, where).toBeGreaterThan(below.cooldownMs);
      expect(above.castTimeMs!, where).toBeGreaterThan(below.castTimeMs!);
      expect(above.reach!.cells, where).toBeGreaterThan(below.reach!.cells);
      expect(above.requirements!.arcane, where).toBeGreaterThan(below.requirements!.arcane!);
    }
  });

  it("asks Arcane of the neutral rungs and never an element", () => {
    for (let index = 0; index < NEUTRAL_LADDER.length; index++) {
      const where = `neutral rung ${index}`;
      const stone = neutral(index);

      expect(spellElements(stone.requirements), where).toEqual([]);
      expect(stone.requirements!.arcane, where).toBeGreaterThan(0);
      expect(Object.keys(stone.requirements!), where).toEqual(["arcane"]);
      expect(neutralBolt(index).statuses, where).toBeUndefined();
    }
  });

  it("runs the neutral ladder one gate below the elemental one", () => {
    for (let index = 0; index < NEUTRAL_LADDER.length; index++) {
      const where = `rung ${index}`;
      const plain = neutral(index);
      const yardstick = rung("water", index);

      expect(plain.reach, where).toEqual(yardstick.reach);
      expect(plain.castTimeMs, where).toBe(yardstick.castTimeMs);
      expect(plain.cooldownMs, where).toBe(yardstick.cooldownMs);
      expect(neutralBolt(index).damage, where).toBeLessThan(bolt("water", index).damage!);
      expect(yardstick.requirements!.arcane, where).toBe(
        plain.requirements!.arcane! + ELEMENTAL_ARCANE_GAP,
      );
    }
  });

  it("opens plain and leaves more behind the higher it goes", () => {
    for (const element of ELEMENTS) {
      expect(bolt(element, 0).statuses, element).toBeUndefined();

      const middle = bolt(element, 1).statuses!;
      const top = bolt(element, 2).statuses!;
      expect(
        middle.map((s) => s.id),
        element,
      ).toEqual([LEAVES[element]]);
      expect(
        top.map((s) => s.id),
        element,
      ).toEqual([LEAVES[element]]);
      expect(top[0]!.chance, element).toBeGreaterThan(middle[0]!.chance!);

      expect(middle[0]!.toMs, element).toBeLessThan(statusDefs[LEAVES[element]]!.toMs);
      expect(top[0]!.fromMs, element).toBeUndefined();
      expect(top[0]!.toMs, element).toBeUndefined();
    }
  });

  it("lets a brand new player onto the bottom neutral rung and no other", () => {
    const seeded = resolveBattler(shipped.player!)!.masteries;

    expect(meetsRequirements(seeded, neutral(0).requirements)).toBe(true);
    expect(meetsRequirements(seeded, neutral(1).requirements)).toBe(false);

    for (const element of ELEMENTS) {
      expect(meetsRequirements(seeded, rung(element, 0).requirements), element).toBe(false);
    }
  });

  it("keeps the elemental gate on Arcane rather than on the element", () => {
    const seeded = resolveBattler(shipped.player!)!.masteries;

    for (const element of ELEMENTS) {
      const asks = rung(element, 0).requirements!;
      expect(asks[element], element).toBe(seeded[element]);
      expect(asks.arcane, element).toBeGreaterThan(seeded.arcane!);
    }
  });

  it("keeps Flame beside the ladder rather than on it", () => {
    const flame = resolveStone(shipped["arcane-stone-of-flame"]!)!;
    expect(flame.effect.kind).toBe("conjure");
    expect(flame.requirements).toEqual(rung("fire", 0).requirements);
    expect(flame.cooldownMs).toBeGreaterThan(rung("fire", 2).cooldownMs);
  });

  it("gives the conjured flame a lifetime and leaves the hearth alone", () => {
    const flame = resolveStone(shipped["arcane-stone-of-flame"]!)!;
    if (flame.effect.kind !== "conjure") throw new Error("not a conjure");
    const conjured = shipped[flame.effect.tileId]!;
    expect(conjured.interactions?.decay).toBeDefined();
    expect(conjured.id).not.toBe("flame");
    expect(shipped.flame!.interactions?.decay).toBeUndefined();
  });

  it("authors them on the item union and nowhere else", () => {
    for (const id of SHIPPED) {
      expect(resolveItem(shipped[id]!)?.type, id).toBe("stone");
    }
  });

  it("ships a necklace that is a charm rather than a stone that presses itself", () => {
    const def = shipped["arcane-necklace-of-life"]!;
    expect(resolveStone(def)).toBeNull();

    const charm = resolveCharm(def);
    expect(charm).not.toBeNull();
    expect(charm!.everyMs).toBeGreaterThan(0);
    expect(charm!.hp).toBeGreaterThan(0);
    expect(wornAccepts("charm", def)).toBe(true);
    expect(handAccepts(def)).toBe(false);
  });
});

describe("how long a cast takes", () => {
  const AUTHORED_MS = 3_000;

  const ASKS = { arcane: 8, fire: 2 };

  function stone(castTimeMs: number | undefined, requirements: Masteries = ASKS) {
    return {
      type: "stone" as const,
      effect: { kind: "bolt" as const, damage: 10, on: "target" as const },
      cooldownMs: 10_000,
      requirements,
      ...(castTimeMs === undefined ? {} : { castTimeMs }),
    };
  }

  it("is nothing at all for a stone with no cast time authored", () => {
    expect(castDurationMs(stone(undefined), { arcane: 8, fire: 2 })).toBe(0);
  });

  it("is the authored time for a caster who meets it exactly", () => {
    expect(castDurationMs(stone(AUTHORED_MS), { arcane: 8, fire: 2 })).toBe(AUTHORED_MS);
  });

  it("takes a tenth off for a caster bringing 110% of it", () => {
    expect(castDurationMs(stone(AUTHORED_MS), { arcane: 9, fire: 2 })).toBe(AUTHORED_MS * 0.9);
  });

  it("is half for a caster half again past it", () => {
    expect(castDurationMs(stone(AUTHORED_MS), { arcane: 13, fire: 2 })).toBe(AUTHORED_MS / 2);
  });

  it("is instant for a caster who has doubled it, and never negative", () => {
    expect(castDurationMs(stone(AUTHORED_MS), { arcane: 16, fire: 4 })).toBe(0);
    expect(castDurationMs(stone(AUTHORED_MS), { arcane: 100, fire: 100 })).toBe(0);
  });

  it("counts every requirement, and never runs longer than authored", () => {
    expect(castDurationMs(stone(AUTHORED_MS), { arcane: 8, fire: 3 })).toBe(AUTHORED_MS * 0.9);
    expect(castDurationMs(stone(AUTHORED_MS), {})).toBe(AUTHORED_MS);
  });

  it("holds a stone that asks nothing at its authored time", () => {
    expect(castDurationMs(stone(AUTHORED_MS, {}), { arcane: 100 })).toBe(AUTHORED_MS);
  });
});

describe("spellPress", () => {
  it("asks for a cast from a stone that would land", () => {
    expect(spellPress({ ok: true })).toBe("cast");
  });

  it("asks for one with nobody targeted, so the session can say why not", () => {
    expect(spellPress({ ok: false, reason: "noTarget" })).toBe("cast");
  });

  it("asks to stop from the stone whose cast is running", () => {
    expect(spellPress({ ok: false, reason: "underway" })).toBe("stop");
  });

  it.each(["empty", "casting", "cooling", "mastery", "outOfRange", "blocked"] as const)(
    "asks nothing of a stone refused for %s, which the button already draws",
    (reason) => {
      expect(spellPress({ ok: false, reason })).toBeNull();
    },
  );
});
