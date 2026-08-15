import { describe, expect, it } from "vitest";
import { DEFAULT_CONTAINER, DEFAULT_WEAPON } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import type { TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { itemUseFor } from "./itemUse";

/**
 * What a tap on a carried thing does.
 *
 * The rule worth pinning is the one the interface is built on: a tap never
 * asks "where does this go", it asks what the thing is *for*. So every case
 * here is about the item's own kind, and the slot only ever decides which way
 * round the answer runs.
 */

function tile(partial: Record<string, unknown>): TileDef {
  return normalizeTileDef({
    name: partial.id,
    height: 0,
    type: "simple",
    kind: "prop",
    attributes: {},
    sprite: { frames: [] },
    ...partial,
  });
}

const tiles = [
  tile({ id: "sword", kind: "item", interactions: { item: DEFAULT_WEAPON } }),
  tile({ id: "bag", kind: "item", interactions: { item: DEFAULT_CONTAINER } }),
  tile({
    id: "chest",
    kind: "item",
    interactions: {
      item: { ...DEFAULT_CONTAINER, size: 2, equippable: false },
    },
  }),
  tile({ id: "sign" }),
];
const tilesById = tilesByIdFromList(tiles);

function instance(tileId: string): ItemInstance {
  return { id: `itm_${tileId}`, tileId };
}

const GROUND = { x: 1, y: 0, z: 0, stackIndex: 1 };

describe("itemUseFor", () => {
  it("wields a weapon from wherever it is", () => {
    for (const slot of [
      { kind: "contents", index: 2 } as const,
      { kind: "ground", ref: GROUND, index: 0 } as const,
    ]) {
      expect(itemUseFor(instance("sword"), slot, tilesById)).toEqual({
        type: "move",
        to: { kind: "weapon" },
      });
    }
  });

  it("puts away the weapon already in hand", () => {
    expect(
      itemUseFor(instance("sword"), { kind: "weapon" }, tilesById),
    ).toEqual({ type: "move", to: { kind: "contents", index: 0 } });
  });

  it("opens the bag on your back", () => {
    expect(itemUseFor(instance("bag"), { kind: "bag" }, tilesById)).toEqual({
      type: "open",
    });
  });

  // No container may hold a container, so the bag slot is the only square in the
  // game one can be sitting in. This is the case that would matter if that ever
  // changed, and it must not quietly start opening a panel nothing sized.
  it("does nothing with a container anywhere but the bag slot", () => {
    expect(
      itemUseFor(
        instance("chest"),
        { kind: "ground", ref: GROUND, index: 0 },
        tilesById,
      ),
    ).toBeNull();
  });

  it("does nothing with a thing that is not for anything yet", () => {
    expect(
      itemUseFor(instance("sign"), { kind: "contents", index: 0 }, tilesById),
    ).toBeNull();
  });

  it("does nothing with a tile that is not in the catalogue", () => {
    expect(
      itemUseFor(instance("ghost"), { kind: "contents", index: 0 }, tilesById),
    ).toBeNull();
  });
});
