import { describe, expect, it } from "vitest";
import type { BattlerDef } from "../lib/battler";
import { MAX_PERCENT_STAT, MIN_PERCENT_STAT } from "../lib/battler";
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
  startingEquipment,
} from "./equipment";

const base: BattlerDef = {
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

  it("finds a light inside a bag", () => {
    const kit = {
      weapon: null,
      bag: { id: "b", tileId: "bag", contents: [{ id: "c", tileId: "torch" }] },
    };
    expect(carriedLightTileIds(kit, lightTiles)).toEqual(["torch"]);
  });

  /**
   * Every carried light counts, and each is a separate entry — the cast
   * accumulates emitters, so two torches at one position is two emitters and
   * twice the light rather than one torch's worth.
   */
  it("lists every light separately, so they can be summed", () => {
    const kit = {
      weapon: { id: "w", tileId: "torch" },
      bag: {
        id: "b",
        tileId: "lamp-bag",
        contents: [{ id: "c", tileId: "torch" }, { id: "d", tileId: "sword" }],
      },
    };
    expect(carriedLightTileIds(kit, lightTiles)).toEqual([
      "torch",
      "lamp-bag",
      "torch",
    ]);
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
