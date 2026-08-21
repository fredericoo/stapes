import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import type { BattlerDef } from "../lib/battler";
import {
  DEFAULT_BATTLER,
  fleeFrom,
  maxHpFrom,
  resolveBattler,
} from "../lib/battler";
import { DEFAULT_CONTAINER, DEFAULT_WEAPON, MELEE_REACH } from "../lib/item";
import type { TileDef } from "../lib/types";
import { normalizeTileDef, normalizeTiles } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import type { Equipment } from "./equipment";
import {
  carriedInstances,
  carriedLightTileIds,
  effectiveBattler,
  emptyEquipment,
  handAccepts,
  offhandDefence,
  restoredEquipment,
  weaponInHand,
} from "./equipment";

/**
 * A body with recognisable claws, so "which weapon won" is answerable by
 * looking at one number.
 *
 * Deliberately unlike {@link DEFAULT_WEAPON} in every field: a fixture that
 * happened to agree with the fallback would pass whichever weapon the code
 * picked, which is the one thing these tests exist to tell apart.
 */
const CLAWS = {
  type: "weapon",
  damage: 7,
  def: 3,
  accuracy: 44,
  variance: 35,
  spd: 33,
  reach: MELEE_REACH,
  mastery: "fist",
} as const;

const base: BattlerDef = {
  ...DEFAULT_BATTLER,
  masteries: { fist: 12, toughness: 20, agility: 6 },
  naturalWeapon: { ...CLAWS },
};

/**
 * Which weapon a body swings, and what the masteries do regardless.
 *
 * The claim under test is **replacement, not addition** — the rule the whole
 * mastery model rests on. Every assertion below would also pass under the old
 * sum if the numbers happened to line up, which is why the fixture's claws
 * disagree with the default weapon in every single field.
 */
describe("weaponInHand", () => {
  it("falls back to the natural weapon with an empty hand", () => {
    expect(weaponInHand(base, null, lightTiles)).toEqual(CLAWS);
    expect(weaponInHand(base, emptyEquipment(), lightTiles)).toEqual(CLAWS);
  });

  it("takes what is in the hand instead, rather than as well", () => {
    const kit = { weapon: { id: "w", tileId: "sword" }, offhand: null,
  bag: null };
    expect(weaponInHand(base, kit, lightTiles)).toEqual(DEFAULT_WEAPON);
  });

  /** The bag is carried, not wielded — nothing in it reaches a blow. */
  it("ignores what is in the bag", () => {
    const kit = {
      weapon: null,
      offhand: null,
      bag: { id: "b", tileId: "bag", contents: [{ id: "c", tileId: "sword" }] },
    };
    expect(weaponInHand(base, kit, lightTiles)).toEqual(CLAWS);
  });

  it("falls back when the slot holds something that is not a weapon", () => {
    const kit = { weapon: { id: "w", tileId: "bag" }, offhand: null,
  bag: null };
    expect(weaponInHand(base, kit, lightTiles)).toEqual(CLAWS);
  });

  /**
   * A tile renamed while somebody was holding it. The fact is out of date, not
   * corrupt, so the hand reads as empty rather than as a body with no weapon at
   * all — which would be a creature that cannot swing.
   */
  it("falls back when the held tile is gone from the catalogue", () => {
    const kit = { weapon: { id: "w", tileId: "no-such-tile" }, offhand: null,
  bag: null };
    expect(weaponInHand(base, kit, lightTiles)).toEqual(CLAWS);
  });
});

describe("effectiveBattler", () => {
  it("takes damage, defence, accuracy and speed from the weapon", () => {
    const out = effectiveBattler(base, null, lightTiles);
    expect(out.damage).toBe(CLAWS.damage);
    expect(out.def).toBe(CLAWS.def);
    expect(out.accuracy).toBe(CLAWS.accuracy);
    expect(out.variance).toBe(CLAWS.variance);
    expect(out.spd).toBe(CLAWS.spd);
  });

  it("replaces all four when a weapon is held, adding none of them", () => {
    const kit = { weapon: { id: "w", tileId: "sword" }, offhand: null,
  bag: null };
    const out = effectiveBattler(base, kit, lightTiles);
    expect(out.damage).toBe(DEFAULT_WEAPON.damage);
    expect(out.accuracy).toBe(DEFAULT_WEAPON.accuracy);
    expect(out.spd).toBe(DEFAULT_WEAPON.spd);
  });

  /**
   * The other half of the split: what a body *is* comes from its masteries and
   * cannot be picked up or put down. A sword that raised your hit points would
   * mean health had to be re-checked every time anybody equipped anything.
   */
  it("takes hit points and flee from the masteries, whatever is held", () => {
    const kit = { weapon: { id: "w", tileId: "sword" }, offhand: null,
  bag: null };
    for (const equipment of [null, emptyEquipment(), kit]) {
      const out = effectiveBattler(base, equipment, lightTiles);
      expect(out.maxHp).toBe(maxHpFrom(20));
      expect(out.flee).toBe(fleeFrom(6));
    }
  });

  it("takes its reach from the weapon and its sight from the body", () => {
    const out = effectiveBattler(base, null, lightTiles);
    // The natural weapon's, because that is what an empty hand swings — and the
    // whole of why reach moved off the body: a bow in that hand would answer
    // differently, where a tile-level number could not.
    expect(out.reach).toEqual(base.naturalWeapon.reach);
    expect(out.sight).toEqual(base.sight);
  });

  it("does not mutate the body it was asked about", () => {
    const snapshot = structuredClone(base);
    effectiveBattler(base, { weapon: { id: "w", tileId: "sword" }, offhand: null,
  bag: null }, lightTiles);
    expect(base).toEqual(snapshot);
  });
});

const LIT = { radius: 5, intensity: 1, color: "#ffcc88" };

function itemTile(id: string, item: unknown, light?: unknown): TileDef {
  return normalizeTileDef({
    id,
    name: id,
    height: 0,
    type: "simple",
    kind: "item",
    attributes: {},
    interactions: { item },
    sprite: {
      frames: [
        {
          sprite: {
            tilesetId: "basic",
            rect: { x: 0, y: 0, w: 1, h: 1 },
            base: { x: 0, y: 0 },
          },
          durationMs: 200,
          ...(light ? { light } : {}),
        },
      ],
    },
  });
}

const lightTiles = tilesByIdFromList([
  itemTile("sword", DEFAULT_WEAPON),
  itemTile("torch", DEFAULT_WEAPON, LIT),
  itemTile("bag", DEFAULT_CONTAINER),
  itemTile("lamp-bag", DEFAULT_CONTAINER, LIT),
]);

describe("carriedInstances", () => {
  it("is empty for an empty kit", () => {
    expect(carriedInstances(emptyEquipment())).toEqual([]);
  });

  it("counts the weapon, the bag, and what is in the bag", () => {
    const ids = carriedInstances({
      weapon: { id: "w", tileId: "sword" },
      offhand: null,
      bag: {
        id: "b",
        tileId: "bag",
        contents: [{ id: "c", tileId: "sword" }],
      },
    }).map((i) => i.id);
    expect(ids).toEqual(["w", "b", "c"]);
  });
});

describe("carriedLightTileIds", () => {
  it("is empty when nothing carried gives off light", () => {
    const kit = { weapon: { id: "w", tileId: "sword" }, offhand: null,
  bag: null };
    expect(carriedLightTileIds(kit, lightTiles)).toEqual([]);
  });

  it("finds a light in the hand", () => {
    const kit = { weapon: { id: "w", tileId: "torch" }, offhand: null,
  bag: null };
    expect(carriedLightTileIds(kit, lightTiles)).toEqual(["torch"]);
  });

  it("finds a light in a bag that is itself lit, because a bag is worn", () => {
    const kit = { weapon: null, offhand: null,
  bag: { id: "b", tileId: "lamp-bag" } };
    expect(carriedLightTileIds(kit, lightTiles)).toEqual(["lamp-bag"]);
  });

  /**
   * A torch in your pack lights nothing, and that is the point of a slot: with
   * the bag counting, carrying a lantern cost nothing and there was no decision
   * in whether to hold one.
   */
  it("ignores a light buried in the bag", () => {
    const kit = {
      weapon: null,
      offhand: null,
      bag: { id: "b", tileId: "bag", contents: [{ id: "c", tileId: "torch" }] },
    };
    expect(carriedLightTileIds(kit, lightTiles)).toEqual([]);
  });

  /**
   * Every worn light counts, and each is a separate entry — the cast
   * accumulates emitters, so two lights at one position is two emitters and
   * twice the light rather than one light's worth.
   */
  it("lists every worn light separately, so they can be summed", () => {
    const kit = {
      weapon: { id: "w", tileId: "torch" },
      offhand: null,
      bag: {
        id: "b",
        tileId: "lamp-bag",
        contents: [{ id: "c", tileId: "torch" }, { id: "d", tileId: "sword" }],
      },
    };
    expect(carriedLightTileIds(kit, lightTiles)).toEqual(["torch", "lamp-bag"]);
  });

  it("ignores a tile the catalogue has never heard of", () => {
    const kit = { weapon: { id: "w", tileId: "ghost" }, offhand: null,
  bag: null };
    expect(carriedLightTileIds(kit, lightTiles)).toEqual([]);
  });
});

/**
 * A kit coming back out of the world's memory.
 *
 * Everything here is about the authored content having moved on while somebody
 * was away, which is not corruption and must not cost them their world: what the
 * tiles no longer agree with is dropped, and the rest is handed back.
 */
describe("restoredEquipment", () => {
  const tiles = tilesByIdFromList([
    itemTile("sword", DEFAULT_WEAPON),
    itemTile("bag", DEFAULT_CONTAINER),
    itemTile("chest", { ...DEFAULT_CONTAINER, size: 2, equippable: false }),
    // Two slots, for the case where an author has shrunk the pack.
    itemTile("small-bag", { ...DEFAULT_CONTAINER, size: 2 }),
  ]);

  function bag(tileId: string, contents: Array<{ id: string; tileId: string }>) {
    return { id: "itm_bag", tileId, contents };
  }

  it("hands back a kit the world still agrees with", () => {
    const saved = {
      weapon: { id: "itm_w", tileId: "sword" },
      offhand: null,
      bag: bag("bag", [{ id: "itm_a", tileId: "sword" }]),
    };
    expect(restoredEquipment(saved, tiles)).toEqual(saved);
  });

  it("drops a weapon whose tile has left the world", () => {
    const restored = restoredEquipment(
      { weapon: { id: "itm_w", tileId: "gone" }, offhand: null,
  bag: null },
      tiles,
    );
    expect(restored.weapon).toBeNull();
  });

  /** A hand takes anything you can carry, so a pack in one survives a reload. */
  it("keeps a pack held in a hand", () => {
    const held = { id: "itm_w", tileId: "bag" };
    const restored = restoredEquipment(
      { weapon: held, offhand: null, bag: null },
      tiles,
    );
    expect(restored.weapon).toEqual(held);
  });

  it("drops a chest held in a hand, since no hand may carry one", () => {
    const restored = restoredEquipment(
      { weapon: { id: "itm_w", tileId: "chest" }, offhand: null, bag: null },
      tiles,
    );
    expect(restored.weapon).toBeNull();
  });

  // The bag goes and its contents go with it. There is nowhere else for them:
  // the inventory *is* the bag's `contents`, so a kit with things in no bag is
  // a shape the model does not have.
  it("drops the whole bag when its tile is no longer wearable", () => {
    const restored = restoredEquipment(
      { weapon: null, offhand: null,
  bag: bag("chest", [{ id: "itm_a", tileId: "sword" }]) },
      tiles,
    );
    expect(restored.bag).toBeNull();
  });

  it("keeps a weapon whose bag went", () => {
    const restored = restoredEquipment(
      { weapon: { id: "itm_w", tileId: "sword" }, offhand: null,
  bag: bag("gone", []) },
      tiles,
    );
    expect(restored.weapon?.tileId).toBe("sword");
    expect(restored.bag).toBeNull();
  });

  it("drops contents whose tiles have left the world", () => {
    const restored = restoredEquipment(
      {
        weapon: null,
        offhand: null,
        bag: bag("bag", [
          { id: "itm_a", tileId: "sword" },
          { id: "itm_b", tileId: "gone" },
        ]),
      },
      tiles,
    );
    expect(restored.bag?.contents?.map((i) => i.id)).toEqual(["itm_a"]);
  });

  // The nesting rule, arriving from the one direction that bypasses every gate
  // in `itemMoves`: not a move at all, but a memory of a world where that thing
  // was something else.
  it("drops a container that has found its way inside a bag", () => {
    const restored = restoredEquipment(
      { weapon: null, offhand: null,
  bag: bag("bag", [{ id: "itm_a", tileId: "chest" }]) },
      tiles,
    );
    expect(restored.bag?.contents).toEqual([]);
  });

  it("truncates to a bag that has been made smaller", () => {
    const restored = restoredEquipment(
      {
        weapon: null,
        offhand: null,
        bag: bag("small-bag", [
          { id: "itm_a", tileId: "sword" },
          { id: "itm_b", tileId: "sword" },
          { id: "itm_c", tileId: "sword" },
        ]),
      },
      tiles,
    );
    expect(restored.bag?.contents?.map((i) => i.id)).toEqual(["itm_a", "itm_b"]);
  });

  /**
   * Storage is where a shape from an older build arrives from, and this one was
   * written by a build that let an anonymous sword out of a chest. The kit is
   * unusable rather than merely odd: `id` is required on the wire, so one saved
   * item without one is a `hello` that fails to parse and a player stuck on
   * "Connecting" forever, with no way to put down the thing that did it.
   */
  it("gives a saved item with no identity one, rather than leaving it unsendable", () => {
    const restored = restoredEquipment(
      {
        weapon: null,
        offhand: null,
        bag: {
          id: "itm_bag",
          tileId: "bag",
          contents: [{ tileId: "sword" }] as never,
        },
      },
      tiles,
    );
    expect(restored.bag?.contents?.[0].id).toMatch(/^itm_/);
    expect(restored.bag?.contents?.[0].tileId).toBe("sword");
  });

  it("gives an anonymous weapon and an anonymous bag one too", () => {
    const restored = restoredEquipment(
      {
        weapon: { tileId: "sword" } as never,
        offhand: null,
        bag: { tileId: "bag", contents: [] } as never,
      },
      tiles,
    );
    expect(restored.weapon?.id).toMatch(/^itm_/);
    expect(restored.bag?.id).toMatch(/^itm_/);
  });

  it("hands back nothing at all for a kit of nothing", () => {
    expect(restoredEquipment(emptyEquipment(), tiles)).toEqual(emptyEquipment());
  });
});

/**
 * The other hand.
 *
 * It exists because the swinging hand was the only hand there was, and a held
 * weapon *replaces* your fists rather than adding to them — so a lantern, which
 * had to be authored as a weapon to be equippable at all, meant fighting at a
 * twentieth of your bare hands in order to see in the dark. That is a real
 * trade-off to offer somebody and a terrible one to impose on them silently.
 *
 * Against the shipped catalogue, because the whole point is what an author
 * actually wrote down.
 */
describe("the off hand", () => {
  const shipped = tilesByIdFromList(normalizeTiles(tilesJson as unknown[]));
  const player = resolveBattler(shipped["player"]!)!;

  const holding = (offhand: string | null, weapon: string | null = null): Equipment => ({
    weapon: weapon ? { id: `itm_${weapon}`, tileId: weapon } : null,
    offhand: offhand ? { id: `itm_${offhand}`, tileId: offhand } : null,
    bag: null,
  });

  it("takes anything you could carry, a pack included", () => {
    expect(handAccepts(shipped["hand-lantern"]!)).toBe(true);
    expect(handAccepts(shipped["rusty-sword"]!)).toBe(true);
    expect(handAccepts(shipped["berry"]!)).toBe(true);
    // Your choice, and the game has no business refusing it.
    expect(handAccepts(shipped["basic-bag"]!)).toBe(true);
    // The one refusal: `equippable: false` is an author saying this is a chest,
    // opened where it lies and never carried.
    expect(handAccepts(shipped["crate-chest"]!)).toBe(false);
    // Not an item at all.
    expect(handAccepts(shipped["grass"]!)).toBe(false);
  });

  /**
   * **The whole reason the slot exists**: a lamp lights the room from here, so
   * seeing in the dark no longer costs you the hand you fight with.
   */
  it("lights the room from the other hand, leaving the weapon hand free", () => {
    const lit = carriedLightTileIds(holding("hand-lantern", "rusty-sword"), shipped);
    expect(lit).toContain("hand-lantern");
  });

  it("leaves what you swing with entirely alone", () => {
    const bare = effectiveBattler(player, holding(null), shipped);
    const lamp = effectiveBattler(player, holding("hand-lantern"), shipped);

    expect(lamp.damage).toBe(bare.damage);
    expect(lamp.spd).toBe(bare.spd);
    expect(lamp.hitChance).toBe(bare.hitChance);
  });

  /**
   * And the other half of "a torch or a shield": defence, read off the `def`
   * that already lives on a weapon as a stopgap until armour exists — so a
   * shield is authorable today without a new item type being invented for it.
   */
  it("adds what it turns aside to your defence", () => {
    const shield = normalizeTileDef({
      id: "shield",
      name: "Shield",
      height: 0,
      kind: "item",
      directional: false,
      attributes: {},
      variants: { default: [] },
      intangible: true,
      interactions: { item: { ...DEFAULT_WEAPON, damage: 0, def: 3 } },
    });
    const withShield = { ...shipped, shield };

    const bare = effectiveBattler(player, holding(null), withShield);
    const guarded = effectiveBattler(player, holding("shield"), withShield);

    expect(guarded.def).toBe(bare.def + 3);
    // Still swinging your own fists, which is the point of it being the *other*
    // hand rather than a second weapon.
    expect(guarded.damage).toBe(bare.damage);
  });

  it("turns nothing aside when it is empty or holding a torch", () => {
    expect(offhandDefence(holding(null), shipped)).toBe(0);
    expect(offhandDefence(holding("hand-lantern"), shipped)).toBe(0);
    expect(offhandDefence(null, shipped)).toBe(0);
  });

  /** A kit saved before the slot existed comes back with an empty hand. */
  it("restores a kit that predates it", () => {
    const old = { weapon: null, bag: null } as unknown as Equipment;
    expect(restoredEquipment(old, shipped).offhand).toBeNull();
  });
});
