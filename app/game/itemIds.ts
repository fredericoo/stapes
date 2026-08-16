import { isItem } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { mintItemId } from "../lib/itemInstance";
import { listCoords, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL } from "../lib/types";

/**
 * Everything a container is holding, each with an identity.
 *
 * Contents are minted on exactly the terms the placements holding them are, and
 * for a reason that is not symmetry: `serializeMap` strips a content's `id` on
 * the way to disk precisely *because* this pass hands it a fresh one on the way
 * back — see `authoredPlacement`. An authored chest therefore arrives full of
 * anonymous items every single load, and they are anonymous in a shape whose
 * `id` is required rather than optional. One taken out of the chest is an
 * `ItemInstance` with no id, which is a frame the client's own protocol refuses
 * to parse.
 *
 * One level deep and never recursive, because a container may not hold a
 * container — see `../lib/item`.
 *
 * Returns the same array when every item already had one, so the caller can
 * tell a chest that needed nothing from one that did by identity.
 */
function mintContentIds(contents: ItemInstance[]): ItemInstance[] {
  let touched = false;
  const next = contents.map((instance) => {
    if (instance.id) return instance;
    touched = true;
    return { ...instance, id: mintItemId() };
  });
  return touched ? next : contents;
}

/**
 * Give every item in the world an identity, once, when it loads.
 *
 * Minting here rather than on first pickup is what "traceable" costs. An id
 * handed out the first time somebody touches a thing would leave everything
 * nobody has handled anonymous — which is precisely the population you would
 * want to follow, and precisely the one a dropped-and-forgotten sword belongs
 * to.
 *
 * "Every item" includes the ones inside chests, which are reached through
 * {@link mintContentIds}: a sword in a crate is as much a thing somebody can
 * carry off as one lying on the floor beside it.
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
        // Contents are minted whatever the holder turns out to be, and before
        // the item gate rather than behind it: what is in a chest needs an
        // identity because somebody can take it out, which stays true of a
        // chest whose own tile has since been authored into scenery.
        const contents = placed.contents && mintContentIds(placed.contents);
        const withContents =
          contents && contents !== placed.contents
            ? { ...placed, contents }
            : placed;
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
