import { isItem } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { mintItemId } from "../lib/itemInstance";
import { getStack, listCoords, presentLevels, replaceStack, setStacks } from "../lib/mapData";
import type { StackEdit } from "../lib/mapData";
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

export function stackNeedsItemIds(
  stack: readonly PlacedTile[],
  tilesById: Record<string, TileDef>,
): boolean {
  return stack.some((placed) => {
    if (placed.contents?.some((instance) => !instance.id)) return true;
    if (placed.itemId) return false;
    const def = tilesById[placed.tileId];
    return def !== undefined && isItem(def);
  });
}

/**
 * Sweeps the whole board, so only for a board being loaded. The edits go in
 * one `setStacks`: one per cell would copy the level's record each time, and
 * every copy outlives the sweep, since a `WeakRef` made in a job holds its
 * target until the job ends.
 */
export function mintItemIds(map: MapFile, tilesById: Record<string, TileDef>): MapFile {
  const edits: StackEdit[] = [];
  for (const z of presentLevels(map)) {
    for (const { x, y, stack } of listCoords(map, z)) {
      const replaced = mintStackItemIds(stack, tilesById);
      if (replaced !== stack) edits.push({ x, y, z, stack: replaced });
    }
  }
  return setStacks(map, edits);
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
