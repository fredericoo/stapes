import { describe, expect, it } from "vitest";
import {
  CONSUME_FALLBACK_VERB,
  DEFAULT_ARMOR,
  DEFAULT_ARTIFACT,
  DEFAULT_CONSUMABLE,
  DEFAULT_CONTAINER,
  DEFAULT_PILE,
  DEFAULT_SHIELD,
  DEFAULT_WEAPON,
  MAX_ARMOR_DEF,
  MAX_CONSUMABLE_HP_SHIFT,
  MAX_CONSUMABLE_SOUND_LENGTH,
  MAX_CONTAINER_SIZE,
  MAX_PERCENT_STAT,
  MAX_WEAPON_DAMAGE,
  MELEE_REACH,
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

  // Poison is the same block with the sign flipped, so the floor of the range
  // is as legal as the ceiling.
  it("reads a consumable that harms", () => {
    const poison = { type: "consumable", label: "Eat", hp: -10 };
    expect(resolveConsumable(tile("item", { item: poison }))).toEqual(poison);
  });

  it("reads the noise it makes", () => {
    const berry = { type: "consumable", label: "Eat", sound: "crunch", hp: 5 };
    expect(resolveConsumable(tile("item", { item: berry }))).toEqual(berry);
  });

  // Silence is a legal consumable, and the commonest one before anybody thinks
  // to author a noise.
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
    expect(consumeVerb({ type: "consumable", label: "Drink", hp: 1 })).toBe(
      "Drink",
    );
    // Whitespace is not a verb.
    expect(consumeVerb({ type: "consumable", label: "  ", hp: 1 })).toBe(
      CONSUME_FALLBACK_VERB,
    );
  });

  it("is null for a tile with no block at all", () => {
    expect(resolveItem(tile("item"))).toBeNull();
    expect(isItem(tile("prop"))).toBe(false);
  });

  // The gate is the whole reason `kind` is stored rather than derived: without
  // it, a block left behind by a hand-edit would quietly still be in charge.
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
      ["no type at all", { damage: 1, def: 1, accuracy: 0, variance: 0, spd: 0, mastery: "blade" }],
      ["an unknown mastery", { ...DEFAULT_WEAPON, mastery: "sonic" }],
      ["a fractional stat", { ...DEFAULT_WEAPON, damage: 1.5 }],
      ["a negative stat", { ...DEFAULT_WEAPON, damage: -1 }],
      ["a percent stat past the cap", { ...DEFAULT_WEAPON, spd: MAX_PERCENT_STAT + 1 }],
      ["a percent stat below zero, which is broken rather than worse", { ...DEFAULT_WEAPON, accuracy: -1 }],
      ["a fractional percent stat", { ...DEFAULT_WEAPON, variance: 60.5 }],
      ["damage past the cap", { ...DEFAULT_WEAPON, damage: MAX_WEAPON_DAMAGE + 1 }],
      ["a weapon missing its accuracy", { type: "weapon", damage: 1, def: 1, variance: 0, spd: 0, mastery: "blade" }],
      ["a weapon missing its variance", { type: "weapon", damage: 1, def: 1, accuracy: 60, spd: 0, mastery: "blade" }],
      ["a consumable with no hp at all", { type: "consumable", label: "Eat" }],
      [
        "a noise longer than the cap",
        { ...DEFAULT_CONSUMABLE, sound: "z".repeat(MAX_CONSUMABLE_SOUND_LENGTH + 1) },
      ],
      ["a fractional hp", { ...DEFAULT_CONSUMABLE, hp: 2.5 }],
      ["an hp past the cap", { ...DEFAULT_CONSUMABLE, hp: MAX_CONSUMABLE_HP_SHIFT + 1 }],
      ["an hp past the floor", { ...DEFAULT_CONSUMABLE, hp: -MAX_CONSUMABLE_HP_SHIFT - 1 }],
      ["armour with a fractional defence", { ...DEFAULT_ARMOR, def: 1.5 }],
      ["armour that makes blows worse", { ...DEFAULT_ARMOR, def: -1 }],
      ["armour past the cap", { ...DEFAULT_ARMOR, def: MAX_ARMOR_DEF + 1 }],
      ["armour resisting by a fraction", { ...DEFAULT_ARMOR, resist: { blade: 0.5 } }],
      ["armour resisting a kind negatively", { ...DEFAULT_ARMOR, resist: { blade: -1 } }],
      ["a container with no room", { ...DEFAULT_CONTAINER, size: 0 }],
      ["a container past the cap", { ...DEFAULT_CONTAINER, size: MAX_CONTAINER_SIZE + 1 }],
      ["a container missing equippable", { type: "container", size: 2 }],
      [
        "a weapon status with no chance on it",
        { ...DEFAULT_WEAPON, statuses: [{ id: "poison" }] },
      ],
      [
        "a chance past the cap",
        { ...DEFAULT_WEAPON, statuses: [{ id: "poison", chance: MAX_PERCENT_STAT + 1 }] },
      ],
      [
        "a chance below zero",
        { ...DEFAULT_WEAPON, statuses: [{ id: "poison", chance: -1 }] },
      ],
      [
        "a nameless status",
        { ...DEFAULT_WEAPON, statuses: [{ id: "  ", chance: 10 }] },
      ],
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
    ];

    for (const [name, block] of cases) {
      it(name, () => {
        expect(resolveItem(tile("item", { item: block }))).toBeNull();
      });
    }
  });

  // A stray key is ignored rather than fatal, matching every other resolver in
  // `./interactions`: the file is hand-edited, and a leftover field from an
  // earlier shape should not be the difference between a sword and a rock.
  it("strips fields belonging to the other arm rather than refusing", () => {
    const def = tile("item", { item: { ...DEFAULT_WEAPON, size: 4 } });
    expect(resolveItem(def)).toEqual(DEFAULT_WEAPON);
    expect(resolveItem(def)).not.toHaveProperty("size");
  });
});

describe("resolveBattler's kind gate", () => {
  const stats = {
    masteries: { fist: 6, toughness: 4 },
    naturalWeapon: { ...DEFAULT_WEAPON, mastery: "fist" },
  };

  it("reads stats on a battler", () => {
    // Floors of interest and the kit are optional, so a block without them
    // parses to minding its own floor and to carrying nothing. That fallback is
    // the compatibility promise, so it is asserted here. Reach is no longer
    // among them: it moved onto the weapon, and the natural weapon in `stats`
    // already carries it. @see `./item`'s `Reach`
    expect(resolveBattler(tile("battler", { battler: stats }))).toEqual({
      ...stats,
      sight: { up: 0, down: 0 },
      kit: [],
    });
  });

  /**
   * A body with no masteries and no weapon has no numbers at all, and there is
   * nothing sensible to invent for it — so it reads as not-a-battler, which is
   * also what every tile authored before masteries existed now reads as.
   */
  it("refuses a block from before masteries existed", () => {
    const old = { maxHp: 10, atk: 1, def: 0, acc: 50, flee: 0, spd: 50 };
    expect(resolveBattler(tile("battler", { battler: old }))).toBeNull();
  });

  it("refuses stats on a prop", () => {
    expect(resolveBattler(tile("prop", { battler: stats }))).toBeNull();
  });

  it("refuses stats on an item", () => {
    expect(resolveBattler(tile("item", { battler: stats }))).toBeNull();
  });
});

/**
 * The one answer to "what does this draft reach", shared by the fields that
 * draw it and the save that writes it. Both used to read `weapon.reach`
 * straight off the draft, and both threw for every weapon in `tiles.json` that
 * predates the field — which is all of them but the bow.
 */
describe("reachOf", () => {
  it("is an arm's length for a weapon that never named one", () => {
    const { reach: _absent, ...noReach } = DEFAULT_WEAPON;
    expect(reachOf(noReach as never)).toEqual(MELEE_REACH);
  });

  it("is whatever the author named, when they named one", () => {
    expect(reachOf({ reach: { cells: 6, height: 2 } })).toEqual({
      cells: 6,
      height: 2,
    });
  });

  /**
   * A fresh object every call. Handing back the constant would let one weapon's
   * edit reach through into every other that took the default — the bug
   * `DEFAULT_WEAPON` spreads `MELEE_REACH` to avoid.
   */
  it("never hands back the shared constant", () => {
    const { reach: _absent, ...noReach } = DEFAULT_WEAPON;
    expect(reachOf(noReach as never)).not.toBe(MELEE_REACH);
  });

  /** Half a reach in the draft still comes back whole. */
  it("fills in the half an unfinished draft is missing", () => {
    expect(reachOf({ reach: { cells: 4 } as never })).toEqual({
      cells: 4,
      height: MELEE_REACH.height,
    });
  });
});

describe("itemForSave", () => {
  it("drops fields belonging to the other arm of the union", () => {
    // What an editor draft looks like after a weapon → container → weapon trip.
    const draft = { ...DEFAULT_WEAPON, size: 4, equippable: true } as never;
    expect(itemForSave(draft)).toEqual(DEFAULT_WEAPON);
    expect(itemForSave(draft)).not.toHaveProperty("size");
  });

  /**
   * The draft an editor hands back is the *authored* block, never the parsed
   * one, so the schema's default for `reach` has not run on it. Every weapon in
   * `tiles.json` but the bow predates reach moving off the body and omits the
   * key, so assuming it threw on the way to disk for all of them — and for every
   * natural weapon, which is saved through the same function.
   */
  it("writes an arm's length for a weapon that never named a reach", () => {
    const { reach: _absent, ...noReach } = DEFAULT_WEAPON;
    expect(itemForSave(noReach as never)).toEqual(DEFAULT_WEAPON);
  });

  it("keeps a reach the author did name", () => {
    const bow = { ...DEFAULT_WEAPON, reach: { cells: 6, height: 2 } };
    expect(weaponForSave(bow).reach).toEqual({ cells: 6, height: 2 });
  });

  it("keeps armour's defence, and drops the resistances that say nothing", () => {
    // What a draft looks like after somebody has touched one of the five fields:
    // the editor writes a key per mastery, and zero is not a resistance.
    const draft = {
      type: "armor",
      def: 3,
      resist: { blade: 4, blunt: 0, fist: 0, ranged: 0, arcane: 0 },
    } as const;
    expect(itemForSave(draft)).toEqual({
      type: "armor",
      def: 3,
      resist: { blade: 4 },
    });
  });

  it("writes no resist block at all when none of them survive", () => {
    const draft = { type: "armor", def: 3, resist: { blade: 0 } } as const;
    expect(itemForSave(draft)).toEqual({ type: "armor", def: 3 });
    expect(itemForSave(draft)).not.toHaveProperty("resist");
  });

  /**
   * Absent already says "worn on the chest" — see `DEFAULT_ARMOR_SLOT` — so
   * writing it would rewrite every armour in the file to say what it said
   * before, on the terms a zeroed resistance is dropped.
   */
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
    const draft = { ...DEFAULT_ARMOR, mastery: "blade", damage: 9 } as never;
    expect(itemForSave(draft)).toEqual(DEFAULT_ARMOR);
  });

  it("writes an artifact as the bare type, whatever the draft carried", () => {
    // A torch was a weapon until this type existed, so this is the exact draft
    // an author produces by switching the arm on the tile it was authored on.
    const draft = { ...DEFAULT_ARTIFACT, damage: 1, def: 3 } as never;
    expect(itemForSave(draft)).toEqual({ type: "artifact" });
    expect(itemForSave(draft)).not.toHaveProperty("damage");
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
    // A blank verb is an absent key, not an empty string in the file.
    expect(itemForSave({ type: "consumable", label: "  ", hp: 2 })).toEqual({
      type: "consumable",
      hp: 2,
      pile: DEFAULT_PILE,
    });
  });

  it("keeps a consumable's noise and drops a blank one", () => {
    expect(
      itemForSave({ type: "consumable", label: "Drink", sound: "glug", hp: 1 }),
    ).toEqual({
      type: "consumable",
      label: "Drink",
      sound: "glug",
      hp: 1,
      pile: DEFAULT_PILE,
    });
    expect(
      itemForSave({ type: "consumable", sound: "   ", hp: 1 }),
    ).toEqual({ type: "consumable", hp: 1, pile: DEFAULT_PILE });
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
      // Written whatever it says, like a weapon's reach — see `pileOf`.
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
    expect(
      itemForSave({ type: "consumable", hp: 0, statuses: [] }),
    ).toEqual({ type: "consumable", hp: 0, pile: DEFAULT_PILE });
    expect(
      itemForSave({ type: "consumable", hp: 0, statuses: [{ id: "  " }] }),
    ).toEqual({ type: "consumable", hp: 0, pile: DEFAULT_PILE });
  });

  it("keeps a weapon's statuses and drops an empty list", () => {
    const venomous = {
      ...DEFAULT_WEAPON,
      statuses: [{ id: "poison", chance: 10, fromMs: 30_000, toMs: 60_000 }],
    };
    expect(itemForSave(venomous)).toEqual(venomous);
    expect(itemForSave({ ...DEFAULT_WEAPON, statuses: [] })).toEqual(DEFAULT_WEAPON);
    expect(
      itemForSave({ ...DEFAULT_WEAPON, statuses: [{ id: " ", chance: 10 }] }),
    ).toEqual(DEFAULT_WEAPON);
  });

  /**
   * A draft that had an override switched off still carries the two ends, and
   * writing them would be writing half of one — which is the shape the schema
   * refuses, so it would come back as a weapon that inflicts nothing.
   */
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

/**
 * Armour, as a kind of item.
 *
 * The parsing claims, kept beside the other three arms of the union: an armour
 * block that does not parse reads as "not an item" exactly as a malformed weapon
 * does, and the resistances are optional because most armour is the same against
 * everything.
 */
describe("resolveArmor", () => {
  it("reads an armour block", () => {
    const def = tile("item", { item: { ...DEFAULT_ARMOR } });
    expect(resolveArmor(def)).toEqual(DEFAULT_ARMOR);
    expect(isItem(def)).toBe(true);
    // The other resolvers say no, which is what the union is for.
    expect(resolveWeapon(def)).toBeNull();
    expect(resolveContainer(def)).toBeNull();
    expect(resolveConsumable(def)).toBeNull();
  });

  it("reads the resistances beside it", () => {
    const def = tile("item", {
      item: { type: "armor", def: 2, resist: { blade: 4, arcane: 1 } },
    });
    expect(resolveArmor(def)?.resist).toEqual({ blade: 4, arcane: 1 });
  });

  /** An empty block says what no block says, and a round trip must survive it. */
  it("takes an empty resist block rather than refusing it", () => {
    const def = tile("item", { item: { type: "armor", def: 2, resist: {} } });
    expect(resolveArmor(def)).toEqual({ type: "armor", def: 2, resist: {} });
  });

  /**
   * Stripped rather than fatal, matching every other resolver here: the file is
   * hand-edited, and a kind of blow that does not exist should cost the armour
   * that line and not the tile. Toughness and Agility are the interesting case —
   * they are real masteries, and they are what a body *is* rather than something
   * anybody swings.
   */
  it("drops a resistance against something no weapon strikes with", () => {
    const def = tile("item", {
      item: { type: "armor", def: 2, resist: { blade: 4, toughness: 9, sonic: 9 } },
    });
    expect(resolveArmor(def)?.resist).toEqual({ blade: 4 });
  });

  it("is null for a weapon, and for a tile that is not an item", () => {
    expect(resolveArmor(tile("item", { item: { ...DEFAULT_WEAPON } }))).toBeNull();
    expect(resolveArmor(tile("prop", { item: { ...DEFAULT_ARMOR } }))).toBeNull();
  });
});

/**
 * The arm with nothing on it. What it is worth is entirely what it is *not*: a
 * torch was a `weapon` block with numbers nobody wanted, and the point of this
 * type is that no combat resolver can see it at all.
 */
describe("resolveItem, for an artifact", () => {
  it("reads a bare block, and every other resolver refuses it", () => {
    const def = tile("item", { item: { ...DEFAULT_ARTIFACT } });
    expect(resolveItem(def)).toEqual(DEFAULT_ARTIFACT);
    expect(isItem(def)).toBe(true);
    // The whole reason the type exists: a body holding one has, as far as a
    // fight is concerned, an empty hand.
    expect(resolveWeapon(def)).toBeNull();
    expect(resolveArmor(def)).toBeNull();
    expect(resolveContainer(def)).toBeNull();
    expect(resolveConsumable(def)).toBeNull();
  });

  /**
   * The block a torch is left holding when somebody flips the arm in the editor
   * and saves before the rebuild drops the rest. Parsing it as an artifact is
   * what stops the leftovers meaning anything.
   */
  it("ignores what a block it used to be left behind", () => {
    const def = tile("item", {
      item: { type: "artifact", damage: 9, mastery: "blade" },
    });
    expect(resolveItem(def)).toEqual({ type: "artifact" });
  });

  it("is not an item at all on a tile whose kind is not one", () => {
    expect(resolveItem(tile("prop", { item: { ...DEFAULT_ARTIFACT } }))).toBeNull();
  });
});

/**
 * The word the interface uses, read off the thing and never off the square —
 * "Press to wield it" over a backpack is what reading the destination produced.
 */
describe("equipVerb", () => {
  it("wears armour, wields a sword, holds a torch, puts on a pack", () => {
    expect(equipVerb(tile("item", { item: { ...DEFAULT_ARMOR } }))).toBe("Wear");
    expect(equipVerb(tile("item", { item: { ...DEFAULT_WEAPON } }))).toBe("Wield");
    expect(
      equipVerb(tile("item", { item: { ...DEFAULT_SHIELD } })),
    ).toBe("Hold");
    expect(equipVerb(tile("item", { item: { ...DEFAULT_CONTAINER } }))).toBe(
      "Put on",
    );
    // The same word an off-hand weapon gets, from the other direction: an
    // artifact is nothing *but* a thing you hold.
    expect(equipVerb(tile("item", { item: { ...DEFAULT_ARTIFACT } }))).toBe(
      "Hold",
    );
  });
});
