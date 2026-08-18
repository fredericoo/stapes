import { describe, expect, it } from "vitest";
import {
  CONSUME_FALLBACK_VERB,
  DEFAULT_CONSUMABLE,
  DEFAULT_CONTAINER,
  DEFAULT_WEAPON,
  MAX_CONSUMABLE_HP_SHIFT,
  MAX_CONSUMABLE_SOUND_LENGTH,
  MAX_CONTAINER_SIZE,
  MAX_PERCENT_STAT,
  MAX_WEAPON_DAMAGE,
  consumeVerb,
  isItem,
  itemForSave,
  resolveConsumable,
  resolveContainer,
  resolveItem,
  resolveWeapon,
} from "./item";
import { DEFAULT_MELEE_RANGE, resolveBattler } from "./battler";
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
      ["a container with no room", { ...DEFAULT_CONTAINER, size: 0 }],
      ["a container past the cap", { ...DEFAULT_CONTAINER, size: MAX_CONTAINER_SIZE + 1 }],
      ["a container missing equippable", { type: "container", size: 2 }],
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
    // Reach and floors of interest are optional, so a block without them parses
    // to the melee default and to minding its own floor. That fallback is the
    // compatibility promise, so it is asserted here.
    expect(resolveBattler(tile("battler", { battler: stats }))).toEqual({
      ...stats,
      range: DEFAULT_MELEE_RANGE,
      sight: { up: 0, down: 0 },
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

describe("itemForSave", () => {
  it("drops fields belonging to the other arm of the union", () => {
    // What an editor draft looks like after a weapon → container → weapon trip.
    const draft = { ...DEFAULT_WEAPON, size: 4, equippable: true } as never;
    expect(itemForSave(draft)).toEqual(DEFAULT_WEAPON);
    expect(itemForSave(draft)).not.toHaveProperty("size");
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
    });
    // A blank verb is an absent key, not an empty string in the file.
    expect(itemForSave({ type: "consumable", label: "  ", hp: 2 })).toEqual({
      type: "consumable",
      hp: 2,
    });
  });

  it("keeps a consumable's noise and drops a blank one", () => {
    expect(
      itemForSave({ type: "consumable", label: "Drink", sound: "glug", hp: 1 }),
    ).toEqual({ type: "consumable", label: "Drink", sound: "glug", hp: 1 });
    expect(
      itemForSave({ type: "consumable", sound: "   ", hp: 1 }),
    ).toEqual({ type: "consumable", hp: 1 });
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
