import { describe, expect, it } from "vitest";
import type { BattlerDef } from "../lib/battler";
import { DEFAULT_BATTLER, maxHpFrom, fleeFrom } from "../lib/battler";
import { DEFAULT_CONTAINER, DEFAULT_WEAPON } from "../lib/item";
import type { TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import {
  carriedInstances,
  carriedLightTileIds,
  effectiveBattler,
  emptyEquipment,
  restoredEquipment,
  startingEquipment,
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
    const kit = { weapon: { id: "w", tileId: "sword" }, bag: null };
    expect(weaponInHand(base, kit, lightTiles)).toEqual(DEFAULT_WEAPON);
  });

  /** The bag is carried, not wielded — nothing in it reaches a blow. */
  it("ignores what is in the bag", () => {
    const kit = {
      weapon: null,
      bag: { id: "b", tileId: "bag", contents: [{ id: "c", tileId: "sword" }] },
    };
    expect(weaponInHand(base, kit, lightTiles)).toEqual(CLAWS);
  });

  it("falls back when the slot holds something that is not a weapon", () => {
    const kit = { weapon: { id: "w", tileId: "bag" }, bag: null };
    expect(weaponInHand(base, kit, lightTiles)).toEqual(CLAWS);
  });

  /**
   * A tile renamed while somebody was holding it. The fact is out of date, not
   * corrupt, so the hand reads as empty rather than as a body with no weapon at
   * all — which would be a creature that cannot swing.
   */
  it("falls back when the held tile is gone from the catalogue", () => {
    const kit = { weapon: { id: "w", tileId: "no-such-tile" }, bag: null };
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
    const kit = { weapon: { id: "w", tileId: "sword" }, bag: null };
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
    const kit = { weapon: { id: "w", tileId: "sword" }, bag: null };
    for (const equipment of [null, emptyEquipment(), kit]) {
      const out = effectiveBattler(base, equipment, lightTiles);
      expect(out.maxHp).toBe(maxHpFrom(20));
      expect(out.flee).toBe(fleeFrom(6));
    }
  });

  it("keeps the body's own reach and sight", () => {
    const out = effectiveBattler(base, null, lightTiles);
    expect(out.range).toBe(base.range);
    expect(out.sight).toEqual(base.sight);
  });

  it("does not mutate the body it was asked about", () => {
    const snapshot = structuredClone(base);
    effectiveBattler(base, { weapon: { id: "w", tileId: "sword" }, bag: null }, lightTiles);
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

describe("startingEquipment", () => {
  it("hands out the bag when the tile is an equippable container", () => {
    const kit = startingEquipment(lightTiles, "bag");
    expect(kit.bag?.tileId).toBe("bag");
    expect(kit.bag?.contents).toEqual([]);
    expect(kit.weapon).toBeNull();
  });

  it("hands out nothing when the tile is missing", () => {
    expect(startingEquipment(lightTiles, "no-such-tile")).toEqual(emptyEquipment());
  });

  it("hands out nothing when the tile is not a container", () => {
    expect(startingEquipment(lightTiles, "sword")).toEqual(emptyEquipment());
  });

  it("hands out nothing when the container cannot be worn", () => {
    const tiles = tilesByIdFromList([
      itemTile("chest", { ...DEFAULT_CONTAINER, equippable: false }),
    ]);
    expect(startingEquipment(tiles, "chest")).toEqual(emptyEquipment());
  });
});

describe("carriedInstances", () => {
  it("is empty for an empty kit", () => {
    expect(carriedInstances(emptyEquipment())).toEqual([]);
  });

  it("counts the weapon, the bag, and what is in the bag", () => {
    const ids = carriedInstances({
      weapon: { id: "w", tileId: "sword" },
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
    const kit = { weapon: { id: "w", tileId: "sword" }, bag: null };
    expect(carriedLightTileIds(kit, lightTiles)).toEqual([]);
  });

  it("finds a light in the hand", () => {
    const kit = { weapon: { id: "w", tileId: "torch" }, bag: null };
    expect(carriedLightTileIds(kit, lightTiles)).toEqual(["torch"]);
  });

  it("finds a light in a bag that is itself lit, because a bag is worn", () => {
    const kit = { weapon: null, bag: { id: "b", tileId: "lamp-bag" } };
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
      bag: {
        id: "b",
        tileId: "lamp-bag",
        contents: [{ id: "c", tileId: "torch" }, { id: "d", tileId: "sword" }],
      },
    };
    expect(carriedLightTileIds(kit, lightTiles)).toEqual(["torch", "lamp-bag"]);
  });

  it("ignores a tile the catalogue has never heard of", () => {
    const kit = { weapon: { id: "w", tileId: "ghost" }, bag: null };
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
      bag: bag("bag", [{ id: "itm_a", tileId: "sword" }]),
    };
    expect(restoredEquipment(saved, tiles)).toEqual(saved);
  });

  it("drops a weapon whose tile has left the world", () => {
    const restored = restoredEquipment(
      { weapon: { id: "itm_w", tileId: "gone" }, bag: null },
      tiles,
    );
    expect(restored.weapon).toBeNull();
  });

  it("drops a weapon whose tile is no longer a weapon", () => {
    const restored = restoredEquipment(
      { weapon: { id: "itm_w", tileId: "bag" }, bag: null },
      tiles,
    );
    expect(restored.weapon).toBeNull();
  });

  // The bag goes and its contents go with it. There is nowhere else for them:
  // the inventory *is* the bag's `contents`, so a kit with things in no bag is
  // a shape the model does not have.
  it("drops the whole bag when its tile is no longer wearable", () => {
    const restored = restoredEquipment(
      { weapon: null, bag: bag("chest", [{ id: "itm_a", tileId: "sword" }]) },
      tiles,
    );
    expect(restored.bag).toBeNull();
  });

  it("keeps a weapon whose bag went", () => {
    const restored = restoredEquipment(
      { weapon: { id: "itm_w", tileId: "sword" }, bag: bag("gone", []) },
      tiles,
    );
    expect(restored.weapon?.tileId).toBe("sword");
    expect(restored.bag).toBeNull();
  });

  it("drops contents whose tiles have left the world", () => {
    const restored = restoredEquipment(
      {
        weapon: null,
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
      { weapon: null, bag: bag("bag", [{ id: "itm_a", tileId: "chest" }]) },
      tiles,
    );
    expect(restored.bag?.contents).toEqual([]);
  });

  it("truncates to a bag that has been made smaller", () => {
    const restored = restoredEquipment(
      {
        weapon: null,
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
