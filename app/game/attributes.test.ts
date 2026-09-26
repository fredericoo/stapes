import { describe, expect, it } from "vitest";
import type { BattlerDef } from "../lib/battler";
import { DEFAULT_BASE_HP } from "../lib/battler";
import { constantFormula } from "../lib/formula";
import { MELEE_REACH, type ItemDef, type Reach, type WeaponItem } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { DEFAULT_STATUS_SOURCE, type StatusDef } from "../lib/status";
import { normalizeTileDef, type TileDef } from "../lib/types";
import { attributesOf, sameAttributes, type Attributes } from "./attributes";
import { swingIntervalMs } from "./combat";
import { potentialDamages } from "./combatMetrics";
import { effectiveBattler, type Equipment, emptyEquipment } from "./equipment";
import { walkDurationMsFor } from "./movement";

const FANG: WeaponItem = {
  type: "weapon",
  damage: 12,
  def: 0,
  accuracy: 86,
  variance: 40,
  spd: 52,
  reach: { ...MELEE_REACH },
  mastery: "sharp",
};

const CLUB: WeaponItem = {
  ...FANG,
  damage: 30,
  spd: 10,
  mastery: "blunt",
};

const BODY_TILE: TileDef = normalizeTileDef({
  id: "body",
  name: "Body",
  kind: "entity",
  walkDurationMs: 200,
});

function bodyWith(over: Partial<BattlerDef> = {}): BattlerDef {
  return {
    baseHp: DEFAULT_BASE_HP,
    masteries: { sharp: 30, agility: 20, toughness: 10 },
    naturalWeapon: { ...FANG },
    sight: { up: 0, down: 0 },
    kit: [],
    ...over,
  };
}

function bowWith(over: Partial<Reach> = {}): WeaponItem {
  return {
    ...FANG,
    reach: { cells: 6, height: 2, ...over },
    projectile: "arrow",
  };
}

function itemTile(id: string, item: ItemDef): TileDef {
  return normalizeTileDef({ id, name: id, kind: "item", interactions: { item } });
}

function held(tileId: string): ItemInstance {
  return { id: `${tileId}-1`, tileId };
}

const TILES: Record<string, TileDef> = {
  body: BODY_TILE,
  fang: itemTile("fang", { ...FANG }),
  club: itemTile("club", { ...CLUB }),
};

function holding(over: Partial<Equipment>): Equipment {
  return { ...emptyEquipment(), ...over };
}

function readingOf(over: Partial<Parameters<typeof attributesOf>[0]> = {}) {
  return attributesOf({
    body: bodyWith(),
    bodyDef: BODY_TILE,
    equipment: emptyEquipment(),
    tilesById: TILES,
    statuses: [],
    statusDefs: {},
    hp: null,
    ...over,
  });
}

const withFang = readingOf({ equipment: holding({ weapon: held("fang") }) });
const withClub = readingOf({ equipment: holding({ weapon: held("club") }) });

describe("the damage row", () => {
  it("is the band a blow can actually land in", () => {
    const body = bodyWith();
    const stats = effectiveBattler(body, emptyEquipment(), TILES, null);
    const odds = potentialDamages(stats);

    const reading = readingOf();
    expect(reading.minDamage).toBe(odds[0]!.value);
    expect(reading.maxDamage).toBe(odds[odds.length - 1]!.value);
  });

  it("collapses to one figure for a weapon with no variance", () => {
    const reading = readingOf({
      body: bodyWith({ naturalWeapon: { ...FANG, variance: 0 } }),
    });
    expect(reading.minDamage).toBe(reading.maxDamage);
  });

  it("widens downward as variance does, and never past full damage", () => {
    const narrow = readingOf({
      body: bodyWith({ naturalWeapon: { ...FANG, variance: 10 } }),
    });
    const wide = readingOf({
      body: bodyWith({ naturalWeapon: { ...FANG, variance: 80 } }),
    });
    expect(wide.minDamage).toBeLessThan(narrow.minDamage);
    expect(wide.maxDamage).toBe(narrow.maxDamage);
  });
});

describe("the swing row", () => {
  it("is the interval a fight is actually clocked at", () => {
    const body = bodyWith();
    const stats = effectiveBattler(body, emptyEquipment(), TILES, null);
    expect(readingOf().swingMs).toBe(swingIntervalMs(stats));
  });

  it("follows the weapon in hand rather than the one the body was born with", () => {
    const bare = readingOf();
    expect(withClub.swingMs).not.toBe(bare.swingMs);
    expect(withClub.maxDamage).toBeGreaterThan(bare.maxDamage);
  });
});

describe("the hand reported", () => {
  it("does not depend on whose turn it is", () => {
    const reading = readingOf({
      equipment: holding({
        weapon: held("fang"),
        offhand: held("club"),
      }),
    });
    expect(reading).toEqual(withFang);
  });

  it("is the armed hand when the other is empty", () => {
    const reading = readingOf({
      equipment: holding({ offhand: held("club") }),
    });
    expect(reading).toEqual(withClub);
  });
});

describe("the walk row", () => {
  it("is the pace the body is authored at, as a rate", () => {
    expect(readingOf().walkPace).toBeCloseTo(1000 / walkDurationMsFor(BODY_TILE, 0), 6);
  });

  it("counts whatever is slowing the body", () => {
    const chill: StatusDef = {
      ...DEFAULT_STATUS_SOURCE,
      everyMs: constantFormula(0),
      id: "chill",
      name: "Chill",
      walkSpeedPercent: -50,
    };
    const reading = readingOf({
      statuses: [{ defId: "chill", remainingMs: 5000, durationMs: 5000, sinceEffectMs: 0 }],
      statusDefs: { chill },
    });
    expect(reading.walkPace).toBeCloseTo(1000 / walkDurationMsFor(BODY_TILE, -50), 6);
    expect(reading.walkPace).toBeLessThan(readingOf().walkPace);
  });
});

describe("statuses", () => {
  it("move the numbers a fight reads", () => {
    const guarded: StatusDef = {
      ...DEFAULT_STATUS_SOURCE,
      everyMs: constantFormula(0),
      id: "guarded",
      name: "Guarded",
      modifiers: { def: constantFormula(7) },
    };
    const reading = readingOf({
      statuses: [{ defId: "guarded", remainingMs: 5000, durationMs: 5000, sinceEffectMs: 0 }],
      statusDefs: { guarded },
    });
    expect(reading.def).toBe(readingOf().def + 7);
  });

  it("are ignored when the catalogue has lost them", () => {
    const reading = readingOf({
      statuses: [{ defId: "gone", remainingMs: 5000, durationMs: 5000, sinceEffectMs: 0 }],
      statusDefs: {},
    });
    expect(reading).toEqual(readingOf());
  });
});

describe("the reach row", () => {
  it("names an arm's length rather than measuring it", () => {
    expect(readingOf().reach).toBe("Melee");
  });

  it("counts the cells for anything longer, and says nothing about arrows", () => {
    const reading = readingOf({ body: bodyWith({ naturalWeapon: bowWith() }) });
    expect(reading.reach).toBe("6c");
  });

  it("states a floor as a span", () => {
    const reading = readingOf({
      body: bodyWith({ naturalWeapon: bowWith({ min: 2 }) }),
    });
    expect(reading.reach).toBe("2–6c");
  });

  it("is never Melee for something with a floor, however short its reach", () => {
    const reading = readingOf({
      body: bodyWith({
        naturalWeapon: {
          ...FANG,
          reach: { ...MELEE_REACH, min: 1 },
        },
      }),
    });
    expect(reading.reach).toBe(`1–${MELEE_REACH.cells}c`);
  });
});

describe("sameAttributes", () => {
  const reading = readingOf();

  it("holds for two readings of the same body", () => {
    expect(sameAttributes(reading, readingOf())).toBe(true);
  });

  it("holds for two absences and fails across one", () => {
    expect(sameAttributes(null, null)).toBe(true);
    expect(sameAttributes(reading, null)).toBe(false);
    expect(sameAttributes(null, reading)).toBe(false);
  });

  it("fails on a change to any field", () => {
    for (const key of Object.keys(reading) as (keyof Attributes)[]) {
      const moved: Attributes = { ...reading };
      const was = moved[key];
      // @ts-expect-error
      moved[key] = typeof was === "number" ? was + 1 : `${was}!`;
      expect(sameAttributes(reading, moved), key).toBe(false);
    }
  });
});

describe("a body that has practised", () => {
  it("hits harder than one that has not", () => {
    const novice = readingOf({ body: bodyWith({ masteries: {} }) });
    const expert = readingOf({ body: bodyWith({ masteries: { sharp: 100 } }) });
    expect(expert.maxDamage).toBeGreaterThan(novice.maxDamage);
  });

  it("turns more aside and dodges more, off Toughness and Agility", () => {
    const soft = readingOf({ body: bodyWith({ masteries: {} }) });
    const hard = readingOf({
      body: bodyWith({ masteries: { toughness: 100, agility: 100 } }),
    });
    expect(hard.def).toBeGreaterThan(soft.def);
    expect(hard.flee).toBeGreaterThan(soft.flee);
  });
});
