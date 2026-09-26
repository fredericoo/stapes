import { isItem } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { mintItemId } from "../lib/itemInstance";
import { listCoords, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL } from "../lib/types";

function mintContentIds(contents: ItemInstance[]): ItemInstance[] {
  let touched = false;
  const next = contents.map((instance) => {
    if (instance.id) return instance;
    touched = true;
    return { ...instance, id: mintItemId() };
  });
  return touched ? next : contents;
}

export function mintItemIds(map: MapFile, tilesById: Record<string, TileDef>): MapFile {
  let next = map;
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { x, y, stack } of listCoords(map, z)) {
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
      if (touched) next = replaceStack(next, x, y, z, replaced);
    }
  }
  return next;
}
