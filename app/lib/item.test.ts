import { describe, expect, it } from "vitest";
import {
  CONSUME_FALLBACK_VERB,
  DEFAULT_ARMOR,
  DEFAULT_ARTIFACT,
  DEFAULT_CONSUMABLE,
  DEFAULT_CONTAINER,
  DEFAULT_PILE,
  DEFAULT_SHIELD,
  DEFAULT_STONE,
  DEFAULT_WEAPON,
  MAX_ARMOR_DEF,
  MAX_CONSUMABLE_HP_SHIFT,
  MAX_SOUND_LENGTH,
  MAX_CONTAINER_SIZE,
  MAX_PERCENT_STAT,
  MAX_WEAPON_DAMAGE,
  MELEE_REACH,
  MIN_CAST_TIME_MS,
  consumeVerb,
  equipVerb,
  isItem,
  itemForSave,
  resolveArmor,
  resolveConsumable,
  resolveContainer,
  resolveItem,
  reachOf,
  resolveWeapon,
  weaponForSave,
} from "./item";
import type { ItemDef } from "./item";
import { resolveBattler } from "./battler";
import type { TileDef, TileKind } from "./types";
import { normalizeTileDef } from "./types";

function tile(kind: TileKind, interactions?: unknown): TileDef {
  return normalizeTileDef({
    id: "t",
    name: "T",
    height: 0,
    type: "simple",
    kind,
    attributes: {},
    sprite: { frames: [] },
    ...(interactions ? { interactions } : {}),
  });
}

describe("resolveItem", () => {
  it("reads a weapon block", () => {
    const def = tile("item", { item: { ...DEFAULT_WEAPON } });
    expect(resolveItem(def)).toEqual(DEFAULT_WEAPON);
    expect(resolveWeapon(def)).toEqual(DEFAULT_WEAPON);
    expect(resolveContainer(def)).toBeNull();
    expect(isItem(def)).toBe(true);
  });

  it("reads a container block", () => {
    const def = tile("item", { item: { ...DEFAULT_CONTAINER } });
    expect(resolveContainer(def)).toEqual(DEFAULT_CONTAINER);
    expect(resolveWeapon(def)).toBeNull();
  });

  it("reads a consumable block", () => {
    const def = tile("item", { item: { ...DEFAULT_CONSUMABLE } });
    expect(resolveConsumable(def)).toEqual(DEFAULT_CONSUMABLE);
    expect(resolveWeapon(def)).toBeNull();
    expect(resolveContainer(def)).toBeNull();
    expect(isItem(def)).toBe(true);
  });

  it("reads a consumable that harms", () => {
    const poison = { type: "consumable", label: "Eat", hp: -10 };
    expect(resolveConsumable(tile("item", { item: poison }))).toEqual(poison);
  });

  it("reads the noise it makes", () => {
    const berry = { type: "consumable", label: "Eat", sound: "crunch", hp: 5 };
    expect(resolveConsumable(tile("item", { item: berry }))).toEqual(berry);
  });

  it("reads one that makes no noise at all", () => {
    const quiet = { type: "consumable", hp: 1 };
    const parsed = resolveConsumable(tile("item", { item: quiet }));
    expect(parsed).toEqual(quiet);
    expect(parsed?.sound).toBeUndefined();
  });

  it("reads a consumable with no verb authored on it", () => {
    const plain = { type: "consumable", hp: 3 };
    const parsed = resolveConsumable(tile("item", { item: plain }));
    expect(parsed).toEqual(plain);
    expect(consumeVerb(parsed!)).toBe(CONSUME_FALLBACK_VERB);
  });

  it("answers the authored verb where there is one", () => {
    expect(consumeVerb({ type: "consumable", label: "Drink", hp: 1 })).toBe("Drink");
    expect(consumeVerb({ type: "consumable", label: "  ", hp: 1 })).toBe(CONSUME_FALLBACK_VERB);
  });

  it("is null for a tile with no block at all", () => {
    expect(resolveItem(tile("item"))).toBeNull();
    expect(isItem(tile("prop"))).toBe(false);
  });

  it("refuses a block on a tile that is not an item", () => {
    const stale = tile("prop", { item: { ...DEFAULT_WEAPON } });
    expect(resolveItem(stale)).toBeNull();
    expect(isItem(stale)).toBe(false);
  });

  it("refuses an item block on a battler", () => {
    expect(resolveItem(tile("battler", { item: { ...DEFAULT_WEAPON } }))).toBeNull();
  });

  describe("malformed blocks read as not-an-item", () => {
    const cases: Array<[string, unknown]> = [
      ["an unknown type", { type: "hat", damage: 1 }],
      ["no type at all", { damage: 1, def: 1, accuracy: 0, variance: 0, spd: 0, mastery: "sharp" }],
      ["an unknown mastery", { ...DEFAULT_WEAPON, mastery: "sonic" }],
      ["a fractional stat", { ...DEFAULT_WEAPON, damage: 1.5 }],
      ["a negative stat", { ...DEFAULT_WEAPON, damage: -1 }],
      ["a percent stat past the cap", { ...DEFAULT_WEAPON, spd: MAX_PERCENT_STAT + 1 }],
      [
        "a percent stat below zero, which is broken rather than worse",
        { ...DEFAULT_WEAPON, accuracy: -1 },
      ],
      ["a fractional percent stat", { ...DEFAULT_WEAPON, variance: 60.5 }],
      ["damage past the cap", { ...DEFAULT_WEAPON, damage: MAX_WEAPON_DAMAGE + 1 }],
      [
        "a weapon missing its accuracy",
        { type: "weapon", damage: 1, def: 1, variance: 0, spd: 0, mastery: "sharp" },
      ],
      [
        "a weapon missing its variance",
        { type: "weapon", damage: 1, def: 1, accuracy: 60, spd: 0, mastery: "sharp" },
      ],
      ["a consumable with no hp at all", { type: "consumable", label: "Eat" }],
      [
        "a noise longer than the cap",
        { ...DEFAULT_CONSUMABLE, sound: "z".repeat(MAX_SOUND_LENGTH + 1) },
      ],
      [
        "a stone whose noise is longer than the cap",
        { ...DEFAULT_STONE, sound: "z".repeat(MAX_SOUND_LENGTH + 1) },
      ],
      ["a fractional hp", { ...DEFAULT_CONSUMABLE, hp: 2.5 }],
      ["an hp past the cap", { ...DEFAULT_CONSUMABLE, hp: MAX_CONSUMABLE_HP_SHIFT + 1 }],
      ["an hp past the floor", { ...DEFAULT_CONSUMABLE, hp: -MAX_CONSUMABLE_HP_SHIFT - 1 }],
      ["armour with a fractional defence", { ...DEFAULT_ARMOR, def: 1.5 }],
      ["armour that makes blows worse", { ...DEFAULT_ARMOR, def: -1 }],
      ["armour past the cap", { ...DEFAULT_ARMOR, def: MAX_ARMOR_DEF + 1 }],
      ["armour resisting by a fraction", { ...DEFAULT_ARMOR, resist: { sharp: 0.5 } }],
      ["armour resisting a kind negatively", { ...DEFAULT_ARMOR, resist: { sharp: -1 } }],
      ["a container with no room", { ...DEFAULT_CONTAINER, size: 0 }],
      ["a container past the cap", { ...DEFAULT_CONTAINER, size: MAX_CONTAINER_SIZE + 1 }],
      ["a container missing equippable", { type: "container", size: 2 }],
      ["a weapon status with no chance on it", { ...DEFAULT_WEAPON, statuses: [{ id: "poison" }] }],
      [
        "a chance past the cap",
        { ...DEFAULT_WEAPON, statuses: [{ id: "poison", chance: MAX_PERCENT_STAT + 1 }] },
      ],
      ["a chance below zero", { ...DEFAULT_WEAPON, statuses: [{ id: "poison", chance: -1 }] }],
      ["a nameless status", { ...DEFAULT_WEAPON, statuses: [{ id: "  ", chance: 10 }] }],
      [
        "half a duration override on a weapon",
        { ...DEFAULT_WEAPON, statuses: [{ id: "poison", chance: 10, fromMs: 1000 }] },
      ],
      [
        "an inverted duration override on a weapon",
        {
          ...DEFAULT_WEAPON,
          statuses: [{ id: "poison", chance: 10, fromMs: 2000, toMs: 1000 }],
        },
      ],
      [
        "a minimum reach beyond the maximum",
        { ...DEFAULT_WEAPON, reach: { cells: 4, min: 5, height: 2 } },
      ],
      [
        "a minimum reach below zero",
        { ...DEFAULT_WEAPON, reach: { cells: 4, min: -1, height: 2 } },
      ],
    ];

    for (const [name, block] of cases) {
      it(name, () => {
        expect(resolveItem(tile("item", { item: block }))).toBeNull();
      });
    }
  });

  it("strips fields belonging to the other arm rather than refusing", () => {
    const def = tile("item", { item: { ...DEFAULT_WEAPON, size: 4 } });
    expect(resolveItem(def)).toEqual(DEFAULT_WEAPON);
    expect(resolveItem(def)).not.toHaveProperty("size");
  });
});

describe("resolveBattler's kind gate", () => {
  const stats = {
    baseHp: 8,
    masteries: { fist: 6, toughness: 4 },
    naturalWeapon: { ...DEFAULT_WEAPON, mastery: "fist" },
  };

  it("reads stats on a battler", () => {
    expect(resolveBattler(tile("battler", { battler: stats }))).toEqual({
      ...stats,
      sight: { up: 0, down: 0 },
      kit: [],
      spells: [],
    });
  });

  it("refuses a block from before masteries existed", () => {
    const old = { maxHp: 10, atk: 1, def: 0, acc: 50, flee: 0, spd: 50 };
    expect(resolveBattler(tile("battler", { battler: old }))).toBeNull();
  });

  it("refuses a block with no base hit points", () => {
    const { baseHp: _dropped, ...noBase } = stats;
    expect(resolveBattler(tile("battler", { battler: noBase }))).toBeNull();
  });

  it("refuses stats on a prop", () => {
    expect(resolveBattler(tile("prop", { battler: stats }))).toBeNull();
  });

  it("refuses stats on an item", () => {
    expect(resolveBattler(tile("item", { battler: stats }))).toBeNull();
  });
});

describe("reachOf", () => {
  it("is an arm's length for a weapon that never named one", () => {
    const { reach: _absent, ...noReach } = DEFAULT_WEAPON;
    expect(reachOf(noReach as never)).toEqual(MELEE_REACH);
  });

  it("is whatever the author named, when they named one", () => {
    expect(reachOf({ reach: { cells: 6, height: 4 } })).toEqual({
      cells: 6,
      height: 4,
    });
  });

  it("never hands back the shared constant", () => {
    const { reach: _absent, ...noReach } = DEFAULT_WEAPON;
    expect(reachOf(noReach as never)).not.toBe(MELEE_REACH);
  });

  it("fills in the half an unfinished draft is missing", () => {
    expect(reachOf({ reach: { cells: 4 } as never })).toEqual({
      cells: 4,
      height: MELEE_REACH.height,
    });
  });
});

describe("itemForSave", () => {
  it("drops fields belonging to the other arm of the union", () => {
    const draft = { ...DEFAULT_WEAPON, size: 4, equippable: true } as never;
    expect(itemForSave(draft)).toEqual(DEFAULT_WEAPON);
    expect(itemForSave(draft)).not.toHaveProperty("size");
  });

  it("writes an arm's length for a weapon that never named a reach", () => {
    const { reach: _absent, ...noReach } = DEFAULT_WEAPON;
    expect(itemForSave(noReach as never)).toEqual(DEFAULT_WEAPON);
  });

  it("keeps a reach the author did name", () => {
    const bow = { ...DEFAULT_WEAPON, reach: { cells: 6, height: 4 } };
    expect(weaponForSave(bow).reach).toEqual({ cells: 6, height: 4 });
  });

  it("keeps a minimum the author did name", () => {
    const bow = { ...DEFAULT_WEAPON, reach: { cells: 8, min: 2, height: 4 } };
    expect(weaponForSave(bow).reach).toEqual({ cells: 8, min: 2, height: 4 });
  });

  it("drops a minimum of nothing rather than writing it on every weapon", () => {
    const sword = { ...DEFAULT_WEAPON, reach: { cells: 1.5, min: 0, height: 2 } };
    expect(weaponForSave(sword).reach).not.toHaveProperty("min");
  });

  it("keeps armour's defence, and drops the resistances that say nothing", () => {
    const draft = {
      type: "armor",
      def: 3,
      resist: { sharp: 4, blunt: 0, fist: 0, ranged: 0, arcane: 0 },
    } as const;
    expect(itemForSave(draft)).toEqual({
      type: "armor",
      def: 3,
      resist: { sharp: 4 },
    });
  });

  it("writes no resist block at all when none of them survive", () => {
    const draft = { type: "armor", def: 3, resist: { sharp: 0 } } as const;
    expect(itemForSave(draft)).toEqual({ type: "armor", def: 3 });
    expect(itemForSave(draft)).not.toHaveProperty("resist");
  });

  it("writes an armour's square only when it is not the body", () => {
    expect(itemForSave({ type: "armor", def: 2, slot: "armor" })).toEqual({
      type: "armor",
      def: 2,
    });
    expect(itemForSave({ type: "armor", def: 2, slot: "head" })).toEqual({
      type: "armor",
      slot: "head",
      def: 2,
    });
  });

  it("drops a weapon's fields from a draft that has been armour and back", () => {
    const draft = { ...DEFAULT_ARMOR, mastery: "sharp", damage: 9 } as never;
    expect(itemForSave(draft)).toEqual(DEFAULT_ARMOR);
  });

  it("writes an artifact as the bare type, whatever the draft carried", () => {
    const draft = { ...DEFAULT_ARTIFACT, damage: 1, def: 3 } as never;
    expect(itemForSave(draft)).toEqual({ type: "artifact" });
    expect(itemForSave(draft)).not.toHaveProperty("damage");
  });

  it("keeps an artifact's pile, and drops a pile of one", () => {
    expect(itemForSave({ type: "artifact", pile: 99 })).toEqual({
      type: "artifact",
      pile: 99,
    });
    expect(itemForSave({ type: "artifact", pile: 1 })).toEqual({
      type: "artifact",
    });
  });

  it("keeps a container's own fields", () => {
    const container = { type: "container", size: 2, equippable: false } as const;
    expect(itemForSave(container)).toEqual(container);
  });

  it("is undefined for no item", () => {
    expect(itemForSave(undefined)).toBeUndefined();
  });

  it("keeps a consumable's verb and drops a blank one", () => {
    expect(itemForSave({ type: "consumable", label: "Drink", hp: -2 })).toEqual({
      type: "consumable",
      label: "Drink",
      hp: -2,
      pile: DEFAULT_PILE,
    });
    expect(itemForSave({ type: "consumable", label: "  ", hp: 2 })).toEqual({
      type: "consumable",
      hp: 2,
      pile: DEFAULT_PILE,
    });
  });

  it("keeps a consumable's noise and drops a blank one", () => {
    expect(itemForSave({ type: "consumable", label: "Drink", sound: "glug", hp: 1 })).toEqual({
      type: "consumable",
      label: "Drink",
      sound: "glug",
      hp: 1,
      pile: DEFAULT_PILE,
    });
    expect(itemForSave({ type: "consumable", sound: "   ", hp: 1 })).toEqual({
      type: "consumable",
      hp: 1,
      pile: DEFAULT_PILE,
    });
  });

  it("keeps a consumable's statuses and drops an empty list", () => {
    const withStatus = {
      type: "consumable" as const,
      label: "Eat",
      hp: 0,
      statuses: [{ id: "fed" }],
    };
    expect(itemForSave(withStatus)).toEqual({
      ...withStatus,
      pile: DEFAULT_PILE,
    });
    expect(
      itemForSave({
        type: "consumable",
        hp: 0,
        statuses: [{ id: "fed", fromMs: 60_000, toMs: 120_000 }],
      }),
    ).toEqual({
      type: "consumable",
      hp: 0,
      statuses: [{ id: "fed", fromMs: 60_000, toMs: 120_000 }],
      pile: DEFAULT_PILE,
    });
    expect(itemForSave({ type: "consumable", hp: 0, statuses: [] })).toEqual({
      type: "consumable",
      hp: 0,
      pile: DEFAULT_PILE,
    });
    expect(itemForSave({ type: "consumable", hp: 0, statuses: [{ id: "  " }] })).toEqual({
      type: "consumable",
      hp: 0,
      pile: DEFAULT_PILE,
    });
  });

  it("keeps a weapon's statuses and drops an empty list", () => {
    const venomous = {
      ...DEFAULT_WEAPON,
      statuses: [{ id: "poison", chance: 10, fromMs: 30_000, toMs: 60_000 }],
    };
    expect(itemForSave(venomous)).toEqual(venomous);
    expect(itemForSave({ ...DEFAULT_WEAPON, statuses: [] })).toEqual(DEFAULT_WEAPON);
    expect(itemForSave({ ...DEFAULT_WEAPON, statuses: [{ id: " ", chance: 10 }] })).toEqual(
      DEFAULT_WEAPON,
    );
  });

  it("drops half a duration override a draft was still holding", () => {
    const saved = itemForSave({
      ...DEFAULT_WEAPON,
      statuses: [{ id: "poison", chance: 10, fromMs: 30_000 }],
    });
    expect(saved).toEqual({
      ...DEFAULT_WEAPON,
      statuses: [{ id: "poison", chance: 10 }],
    });
    expect(resolveItem(tile("item", { item: saved }))).toEqual(saved);
  });

  it("drops weapon fields a draft carried into a consumable", () => {
    const draft = { ...DEFAULT_CONSUMABLE, atk: 3, size: 4 } as never;
    expect(itemForSave(draft)).toEqual(DEFAULT_CONSUMABLE);
  });

  it("round-trips through the resolver", () => {
    const saved = itemForSave({ ...DEFAULT_CONTAINER, equippable: false });
    expect(resolveItem(tile("item", { item: saved }))).toEqual({
      ...DEFAULT_CONTAINER,
      equippable: false,
    });
  });

  it("drops a bolt's variance and projectile when they say nothing", () => {
    const draft = {
      type: "stone",
      effect: {
        kind: "bolt",
        damage: 12,
        on: "target",
        variance: 0,
        projectile: "  ",
      },
      cooldownMs: 10_000,
    } as const;
    const saved = itemForSave(draft);
    expect(saved).toEqual({
      type: "stone",
      effect: { kind: "bolt", damage: 12, on: "target" },
      cooldownMs: 10_000,
    });
    expect(resolveItem(tile("item", { item: saved }))).toEqual(saved);
  });

  it("keeps a bolt's variance and projectile when they say something", () => {
    const draft = {
      type: "stone",
      effect: {
        kind: "bolt",
        damage: -12,
        on: "caster",
        variance: 25,
        projectile: " mote ",
      },
      cooldownMs: 10_000,
    } as const;
    const saved = itemForSave(draft);
    expect(saved).toEqual({
      type: "stone",
      effect: {
        kind: "bolt",
        damage: -12,
        on: "caster",
        variance: 25,
        projectile: "mote",
      },
      cooldownMs: 10_000,
    });
    expect(resolveItem(tile("item", { item: saved }))).toEqual(saved);
  });

  it("refuses a bolt of zero and takes either sign", () => {
    const bolt = (damage: number) => ({
      type: "stone" as const,
      effect: { kind: "bolt" as const, damage, on: "caster" as const },
      cooldownMs: 10_000,
    });
    expect(resolveItem(tile("item", { item: bolt(0) }))).toBeNull();
    expect(resolveItem(tile("item", { item: bolt(5) }))).toEqual(bolt(5));
    expect(resolveItem(tile("item", { item: bolt(-5) }))).toEqual(bolt(-5));
  });

  it("takes a bolt that only leaves a status, and refuses one that does neither", () => {
    const ward = {
      type: "stone" as const,
      effect: {
        kind: "bolt" as const,
        on: "caster" as const,
        statuses: [{ id: "luminous", chance: 100 }],
      },
      cooldownMs: 10_000,
    };
    expect(resolveItem(tile("item", { item: ward }))).toEqual(ward);

    const empty = {
      type: "stone" as const,
      effect: { kind: "bolt" as const, on: "caster" as const },
      cooldownMs: 10_000,
    };
    expect(resolveItem(tile("item", { item: empty }))).toBeNull();
    expect(
      resolveItem(tile("item", { item: { ...empty, effect: { ...empty.effect, statuses: [] } } })),
    ).toBeNull();
  });

  it("round-trips a bolt that does both halves", () => {
    const draft: ItemDef = {
      type: "stone",
      effect: {
        kind: "bolt",
        damage: 18,
        on: "target",
        statuses: [{ id: "burned", chance: 60, fromMs: 2_000, toMs: 3_000 }],
      },
      cooldownMs: 45_000,
    };
    const saved = itemForSave(draft);
    expect(saved).toEqual(draft);
    expect(resolveItem(tile("item", { item: saved }))).toEqual(draft);
  });

  it("drops a cast time of nothing and an uninterruptible of false", () => {
    const saved = itemForSave({
      type: "stone",
      effect: { kind: "bolt", damage: -5, on: "caster" },
      cooldownMs: 10_000,
      castTimeMs: 0,
      uninterruptible: false,
    });
    expect(saved).toEqual({
      type: "stone",
      effect: { kind: "bolt", damage: -5, on: "caster" },
      cooldownMs: 10_000,
    });
  });

  it("round-trips a stone that takes time and cannot be broken", () => {
    const draft: ItemDef = {
      type: "stone",
      effect: { kind: "conjure", tileId: "flame" },
      cooldownMs: 45_000,
      castTimeMs: 3_000,
      uninterruptible: true,
      requirements: { arcane: 5, fire: 1 },
    };
    const saved = itemForSave(draft);
    expect(saved).toEqual(draft);
    expect(resolveItem(tile("item", { item: saved }))).toEqual(draft);
  });

  it("round-trips the noise a stone makes", () => {
    const draft: ItemDef = {
      type: "stone",
      effect: { kind: "conjure", tileId: "flame" },
      cooldownMs: 45_000,
      sound: "whoosh",
    };
    const saved = itemForSave(draft);
    expect(saved).toEqual(draft);
    expect(resolveItem(tile("item", { item: saved }))).toEqual(draft);
  });

  it("drops a stone's blank noise", () => {
    const saved = itemForSave({
      type: "stone",
      effect: { kind: "bolt", damage: -5, on: "caster" },
      cooldownMs: 10_000,
      sound: "  ",
    });
    expect(saved).not.toHaveProperty("sound");
  });

  it("refuses a cast time shorter than a bar is worth drawing", () => {
    const flicker = {
      type: "stone" as const,
      effect: { kind: "bolt" as const, damage: 5, on: "caster" as const },
      cooldownMs: 10_000,
      castTimeMs: MIN_CAST_TIME_MS - 1,
    };
    expect(resolveItem(tile("item", { item: flicker }))).toBeNull();
  });

  it("drops a bolt's unnamed status rows", () => {
    const saved = itemForSave({
      type: "stone",
      effect: {
        kind: "bolt",
        damage: -5,
        on: "caster",
        statuses: [{ id: "  ", chance: 100 }],
      },
      cooldownMs: 10_000,
    });
    expect(saved).toEqual({
      type: "stone",
      effect: { kind: "bolt", damage: -5, on: "caster" },
      cooldownMs: 10_000,
    });
  });
});

describe("normalizeTileDef and kind", () => {
  it("keeps an authored kind", () => {
    expect(tile("item").kind).toBe("item");
  });

  it("defaults to prop rather than guessing from the blocks", () => {
    const def = normalizeTileDef({
      id: "t",
      name: "T",
      height: 0,
      type: "simple",
      attributes: {},
      interactions: { battler: { maxHp: 1, atk: 1, def: 0, acc: 1, flee: 1, spd: 1 } },
    });
    expect(def.kind).toBe("prop");
    expect(resolveBattler(def)).toBeNull();
  });

  it("defaults an unrecognised kind to prop", () => {
    const def = normalizeTileDef({
      id: "t",
      name: "T",
      height: 0,
      type: "simple",
      kind: "weapon",
      attributes: {},
    });
    expect(def.kind).toBe("prop");
  });

  it("carries kind through the legacy sprite migration", () => {
    const def = normalizeTileDef({
      id: "t",
      name: "T",
      height: 0,
      kind: "item",
      directional: false,
      variants: { default: [] },
    });
    expect(def.kind).toBe("item");
    expect(def.type).toBe("simple");
  });
});

describe("resolveArmor", () => {
  it("reads an armour block", () => {
    const def = tile("item", { item: { ...DEFAULT_ARMOR } });
    expect(resolveArmor(def)).toEqual(DEFAULT_ARMOR);
    expect(isItem(def)).toBe(true);
    expect(resolveWeapon(def)).toBeNull();
    expect(resolveContainer(def)).toBeNull();
    expect(resolveConsumable(def)).toBeNull();
  });

  it("reads the resistances beside it", () => {
    const def = tile("item", {
      item: { type: "armor", def: 2, resist: { sharp: 4, arcane: 1 } },
    });
    expect(resolveArmor(def)?.resist).toEqual({ sharp: 4, arcane: 1 });
  });

  it("takes an empty resist block rather than refusing it", () => {
    const def = tile("item", { item: { type: "armor", def: 2, resist: {} } });
    expect(resolveArmor(def)).toEqual({ type: "armor", def: 2, resist: {} });
  });

  it("drops a resistance against something no weapon strikes with", () => {
    const def = tile("item", {
      item: { type: "armor", def: 2, resist: { sharp: 4, toughness: 9, sonic: 9 } },
    });
    expect(resolveArmor(def)?.resist).toEqual({ sharp: 4 });
  });

  it("is null for a weapon, and for a tile that is not an item", () => {
    expect(resolveArmor(tile("item", { item: { ...DEFAULT_WEAPON } }))).toBeNull();
    expect(resolveArmor(tile("prop", { item: { ...DEFAULT_ARMOR } }))).toBeNull();
  });
});

describe("resolveItem, for an artifact", () => {
  it("reads a bare block, and every other resolver refuses it", () => {
    const def = tile("item", { item: { ...DEFAULT_ARTIFACT } });
    expect(resolveItem(def)).toEqual(DEFAULT_ARTIFACT);
    expect(isItem(def)).toBe(true);
    expect(resolveWeapon(def)).toBeNull();
    expect(resolveArmor(def)).toBeNull();
    expect(resolveContainer(def)).toBeNull();
    expect(resolveConsumable(def)).toBeNull();
  });

  it("ignores what a block it used to be left behind", () => {
    const def = tile("item", {
      item: { type: "artifact", damage: 9, mastery: "sharp" },
    });
    expect(resolveItem(def)).toEqual({ type: "artifact" });
  });

  it("is not an item at all on a tile whose kind is not one", () => {
    expect(resolveItem(tile("prop", { item: { ...DEFAULT_ARTIFACT } }))).toBeNull();
  });
});

describe("equipVerb", () => {
  it("wears armour, wields a sword, holds a torch, puts on a pack", () => {
    expect(equipVerb(tile("item", { item: { ...DEFAULT_ARMOR } }))).toBe("Wear");
    expect(equipVerb(tile("item", { item: { ...DEFAULT_WEAPON } }))).toBe("Wield");
    expect(equipVerb(tile("item", { item: { ...DEFAULT_SHIELD } }))).toBe("Hold");
    expect(equipVerb(tile("item", { item: { ...DEFAULT_CONTAINER } }))).toBe("Put on");
    expect(equipVerb(tile("item", { item: { ...DEFAULT_ARTIFACT } }))).toBe("Hold");
  });
});
