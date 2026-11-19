import { isItem } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { mintItemId } from "../lib/itemInstance";
import { getStack, listCoords, presentLevels, replaceStack } from "../lib/mapData";
import type { Coord, MapFile, PlacedTile, TileDef } from "../lib/types";

function mintContentIds(contents: ItemInstance[]): ItemInstance[] {
  let touched = false;
  const next = contents.map((instance) => {
    if (instance.id) return instance;
    touched = true;
    return { ...instance, id: mintItemId() };
  });
  return touched ? next : contents;
}

function mintStackItemIds(stack: PlacedTile[], tilesById: Record<string, TileDef>): PlacedTile[] {
  let touched = false;
  const replaced = stack.map((placed) => {
    const contents = placed.contents && mintContentIds(placed.contents);
    const withContents =
      contents && contents !== placed.contents ? { ...placed, contents } : placed;
    if (withContents !== placed) touched = true;

    if (withContents.itemId) return withContents;
    const def = tilesById[withContents.tileId];
    if (!def || !isItem(def)) return withContents;
    touched = true;
    return { ...withContents, itemId: mintItemId() };
  });
  return touched ? replaced : stack;
}

/** Sweeps the whole board, so only for a board being loaded. */
export function mintItemIds(map: MapFile, tilesById: Record<string, TileDef>): MapFile {
  let next = map;
  for (const z of presentLevels(map)) {
    for (const { x, y, stack } of listCoords(map, z)) {
      /**
       * Read off `map` rather than `next`: the only edit here stamps an id
       * onto a placement, so nothing moves out from under the walk, and
       * re-reading `next` per level would begin from the map being rebuilt.
       */
      const replaced = mintStackItemIds(stack, tilesById);
      if (replaced !== stack) next = replaceStack(next, x, y, z, replaced);
    }
  }
  return next;
}

export function mintCellItemIds(
  map: MapFile,
  cell: Coord,
  tilesById: Record<string, TileDef>,
): MapFile {
  const stack = getStack(map, cell.x, cell.y, cell.z);
  const replaced = mintStackItemIds(stack, tilesById);
  return replaced === stack ? map : replaceStack(map, cell.x, cell.y, cell.z, replaced);
}
