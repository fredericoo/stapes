import { describe, expect, it } from "vitest";
import { getStack, setStacks } from "../lib/mapData";
import { DEFAULT_CONTAINER, DEFAULT_WEAPON } from "../lib/item";
import type { MapFile, PlacedTile, TileDef, TileKind } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { mintItemIds } from "./itemIds";

function tile(id: string, kind: TileKind, item?: unknown): TileDef {
  return normalizeTileDef({
    id,
    name: id,
    height: 0,
    type: "simple",
    kind,
    attributes: {},
    sprite: { frames: [] },
    ...(item ? { interactions: { item } } : {}),
  });
}

const tiles = [
  tile("grass", "prop"),
  tile("rusty-sword", "item", DEFAULT_WEAPON),
  tile("basic-bag", "item", DEFAULT_CONTAINER),
  // A stale item block on a prop: the kind gate means it is not an item, so it
  // must not be given an identity either.
  tile("fake-sword", "prop", DEFAULT_WEAPON),
];
const tilesById = tilesByIdFromList(tiles);

function mapWith(stacks: Array<{ x: number; y: number; stack: PlacedTile[] }>): MapFile {
  return setStacks({ version: 1, levels: {} }, stacks.map((s) => ({ ...s, z: 0 })));
}

describe("mintItemIds", () => {
  it("gives every item an identity", () => {
    const map = mapWith([
      { x: 0, y: 0, stack: [{ tileId: "grass" }, { tileId: "rusty-sword" }] },
    ]);
    const next = mintItemIds(map, tilesById);
    const stack = getStack(next, 0, 0, 0);
    expect(stack[0].itemId).toBeUndefined();
    expect(stack[1].itemId).toMatch(/^itm_/);
  });

  it("gives two of the same tile two different identities", () => {
    const map = mapWith([
      { x: 0, y: 0, stack: [{ tileId: "rusty-sword" }] },
      { x: 1, y: 0, stack: [{ tileId: "rusty-sword" }] },
    ]);
    const next = mintItemIds(map, tilesById);
    const a = getStack(next, 0, 0, 0)[0].itemId;
    const b = getStack(next, 1, 0, 0)[0].itemId;
    expect(a).toBeDefined();
    expect(a).not.toBe(b);
  });

  /**
   * The property a resumed world depends on: minting runs on every load, and
   * re-minting would make yesterday's sword a different sword.
   */
  it("leaves an identity it has already given alone", () => {
    const map = mapWith([
      { x: 0, y: 0, stack: [{ tileId: "rusty-sword", itemId: "itm_known" }] },
    ]);
    const next = mintItemIds(map, tilesById);
    expect(getStack(next, 0, 0, 0)[0].itemId).toBe("itm_known");
  });

  it("is idempotent — a second pass changes nothing at all", () => {
    const map = mapWith([
      { x: 0, y: 0, stack: [{ tileId: "basic-bag" }] },
    ]);
    const once = mintItemIds(map, tilesById);
    const twice = mintItemIds(once, tilesById);
    // Same object, not merely equal: a pass with nothing to do must not copy
    // the map, or every load would invalidate every chunk in the world.
    expect(twice).toBe(once);
  });

  it("returns the same map when there are no items in it", () => {
    const map = mapWith([{ x: 0, y: 0, stack: [{ tileId: "grass" }] }]);
    expect(mintItemIds(map, tilesById)).toBe(map);
  });

  it("does not mint for a stale item block on a prop", () => {
    const map = mapWith([{ x: 0, y: 0, stack: [{ tileId: "fake-sword" }] }]);
    expect(mintItemIds(map, tilesById)).toBe(map);
  });

  it("leaves the placement's other fields untouched", () => {
    const map = mapWith([
      {
        x: 0,
        y: 0,
        stack: [{ tileId: "basic-bag", channel: "gate", description: "loot" }],
      },
    ]);
    const placed = getStack(mintItemIds(map, tilesById), 0, 0, 0)[0];
    expect(placed.channel).toBe("gate");
    expect(placed.description).toBe("loot");
  });
});
