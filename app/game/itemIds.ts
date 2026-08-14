import { isItem } from "../lib/item";
import { mintItemId } from "../lib/itemInstance";
import { listCoords, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL } from "../lib/types";

/**
 * Give every item in the world an identity, once, when it loads.
 *
 * Minting here rather than on first pickup is what "traceable" costs. An id
 * handed out the first time somebody touches a thing would leave everything
 * nobody has handled anonymous — which is precisely the population you would
 * want to follow, and precisely the one a dropped-and-forgotten sword belongs
 * to.
 *
 * Idempotent, on the same terms `adoptResidents` is: a placement that already
 * carries an id keeps it, because a resumed world's items have been minted
 * before and re-minting would make yesterday's sword a different sword. That is
 * also why this can run on every load without a flag to say whether it has.
 *
 * A sweep, and one of only two the world does at load. It is bounded by the map
 * rather than by anything that grows during play, and it runs once — the
 * standing rule against sweeping is about answering *local* questions in the
 * tick loop, which this is not.
 *
 * Returns the same map object when nothing needed an id, so a world of loaded
 * scenery costs a walk and no copy at all.
 */
export function mintItemIds(
  map: MapFile,
  tilesById: Record<string, TileDef>,
): MapFile {
  let next = map;
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    // Read off `map` rather than `next`: the only edit made here is stamping an
    // id onto a placement, so nothing moves out from under the walk, and
    // re-reading the copy per level would be a walk of a map being rebuilt.
    for (const { x, y, stack } of listCoords(map, z)) {
      let touched = false;
      const replaced = stack.map((placed) => {
        if (placed.itemId) return placed;
        const def = tilesById[placed.tileId];
        if (!def || !isItem(def)) return placed;
        touched = true;
        return { ...placed, itemId: mintItemId() };
      });
      if (touched) next = replaceStack(next, x, y, z, replaced);
    }
  }
  return next;
}
