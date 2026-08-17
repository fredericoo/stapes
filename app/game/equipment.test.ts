import { describe, expect, it } from "vitest";
import type { BattlerDef } from "../lib/battler";
import { DEFAULT_BATTLER, MAX_PERCENT_STAT, MIN_PERCENT_STAT } from "../lib/battler";
import { DEFAULT_CONTAINER, DEFAULT_WEAPON } from "../lib/item";
import type { TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import {
  applyWeaponStats,
  carriedInstances,
  carriedLightTileIds,
  effectiveBattler,
  emptyEquipment,
  restoredEquipment,
  startingEquipment,
} from "./equipment";

const base: BattlerDef = {
  ...DEFAULT_BATTLER,
  maxHp: 20,
  atk: 5,
  def: 1,
  acc: 50,
  flee: 20,
  spd: 40,
};

describe("applyWeaponStats", () => {
  it("is the base stats with no weapon", () => {
    expect(applyWeaponStats(base, null)).toEqual(base);
  });

  it("adds attack and defence", () => {
    const out = applyWeaponStats(base, { atk: 3, def: 2, acc: 0, spd: 0 });
    expect(out.atk).toBe(8);
    expect(out.def).toBe(3);
  });

  it("adds nothing at all when every field is zero", () => {
    expect(applyWeaponStats(base, { atk: 0, def: 0, acc: 0, spd: 0 })).toEqual(
      base,
    );
  });

  /**
   * The whole point of the two signed stats: a weapon may be slower *and* more
   * accurate, which one `weight` spent against both could never say.
   */
  it("moves speed and accuracy independently, in either direction", () => {
    const out = applyWeaponStats(base, { atk: 0, def: 0, acc: 12, spd: -10 });
    expect(out.acc).toBe(62);
    expect(out.spd).toBe(30);
  });

  it("takes a positive shift as a bonus rather than as free", () => {
    const out = applyWeaponStats(base, { atk: 0, def: 0, acc: 5, spd: 5 });
    expect(out.acc).toBe(55);
    expect(out.spd).toBe(45);
  });

  it("leaves max hp and flee alone", () => {
    const out = applyWeaponStats(base, { atk: 9, def: 9, acc: -30, spd: -30 });
    expect(out.maxHp).toBe(base.maxHp);
    expect(out.flee).toBe(base.flee);
  });

  it("clamps the percent stats at the floor rather than going negative", () => {
    const out = applyWeaponStats(base, { atk: 0, def: 0, acc: -100, spd: -100 });
    expect(out.spd).toBe(MIN_PERCENT_STAT);
    expect(out.acc).toBe(MIN_PERCENT_STAT);
  });

  it("clamps at the ceiling too, since a shift may be a bonus", () => {
    const out = applyWeaponStats(base, { atk: 0, def: 0, acc: 100, spd: 100 });
    expect(out.acc).toBe(MAX_PERCENT_STAT);
    expect(out.spd).toBe(MAX_PERCENT_STAT);
  });

  it("leaves attack and defence unbounded above, unlike the percent stats", () => {
    const out = applyWeaponStats(
      { ...base, acc: MAX_PERCENT_STAT },
      { atk: 500, def: 500, acc: 10, spd: 0 },
    );
    expect(out.atk).toBe(505);
    expect(out.acc).toBe(MAX_PERCENT_STAT);
  });

  it("does not mutate the base stats", () => {
    const snapshot = { ...base };
    applyWeaponStats(base, { atk: 3, def: 2, acc: -5, spd: -10 });
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

describe("effectiveBattler", () => {
  it("is the base stats with no equipment at all", () => {
    expect(effectiveBattler(base, null, lightTiles)).toBe(base);
    expect(effectiveBattler(base, emptyEquipment(), lightTiles)).toBe(base);
  });

  it("counts a weapon in the hand", () => {
    const kit = { weapon: { id: "w", tileId: "sword" }, bag: null };
    const out = effectiveBattler(base, kit, lightTiles);
    expect(out.atk).toBe(base.atk + DEFAULT_WEAPON.atk);
  });

  /** The bag is carried, not wielded — nothing in it reaches a blow. */
  it("ignores what is in the bag", () => {
    const kit = {
      weapon: null,
      bag: { id: "b", tileId: "bag", contents: [{ id: "c", tileId: "sword" }] },
    };
    expect(effectiveBattler(base, kit, lightTiles)).toBe(base);
  });

  it("ignores a slot holding something that is not a weapon", () => {
    const kit = { weapon: { id: "w", tileId: "bag" }, bag: null };
    expect(effectiveBattler(base, kit, lightTiles)).toEqual(base);
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
