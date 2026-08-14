import { getStack } from "../lib/mapData";
import { instanceFromPlacement } from "../lib/itemInstance";
import type { Coord, MapFile, TileDef } from "../lib/types";
import { canOpenFrom, type ObjectRef } from "./affordances";
import type { OpenedContainer } from "./itemMoves";

/**
 * Whether a container somebody opened is still theirs to look into.
 *
 * Pure, and out here rather than inside the render loop, because it is a rule
 * about the world rather than about drawing: *may this person see inside that
 * box, right now*. The loop's job is only to ask it at the right moments — see
 * `GameRenderer.pushOpenedContainer`, which asks whenever the viewer moves or
 * the container's cell changes, and those are the only two things that can
 * change the answer.
 *
 * ## Three answers, not two
 *
 * Out of reach and gone are different, and collapsing them would be a leak
 * either way round. Something merely out of reach is still that thing: walk
 * back and it is the same box with the same contents. Something *gone* has left
 * the slot — taken by somebody else, shoved along, or buried — and the
 * reference that named it now names whatever took its place. Keeping that
 * reference alive would mean walking back into range and being shown the
 * inside of a different container entirely, which is the exact shape of the
 * problem worth avoiding: **you must not see what is in a bag somebody else
 * has picked up.**
 *
 * Identity is what tells the two apart. The item id on the placement is the
 * thing that was opened; a slot holding anything else is holding somebody
 * else's business.
 */
export type OpenedContainerRead =
  /** In reach and the same box. Here is what is in it. */
  | { kind: "open"; container: OpenedContainer; itemId: string }
  /** Still there, still that box, too far to see into. Keep the reference. */
  | { kind: "outOfReach"; itemId: string }
  /** Not that box any more, if anything at all. Forget the reference. */
  | { kind: "gone" };

/**
 * Look up what an opened reference is worth now.
 *
 * @param openedItemId what was opened, or null on the first read after opening
 *   — the identity is learnt from the board rather than passed in, because the
 *   thing that opens a container is a click on a cell, which knows a slot and
 *   not an id.
 */
export function readOpenedContainer(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  self: Coord,
  ref: ObjectRef,
  openedItemId: string | null,
): OpenedContainerRead {
  const placed = getStack(map, ref.x, ref.y, ref.z)[ref.stackIndex];
  const itemId = placed?.itemId;
  if (!placed || !itemId) return { kind: "gone" };
  // Learnt on the first read, checked on every one after it.
  if (openedItemId !== null && openedItemId !== itemId) return { kind: "gone" };

  // Reach and "is this still a container at all" are one question, and it is
  // the same one that offered the row in the first place — so a box you can
  // open is a box you can go on looking into, with no second rule to disagree.
  if (!canOpenFrom(map, tilesById, self, ref)) {
    // A thing that stopped being a container while you were standing over it is
    // gone in the sense that matters, but that cannot be told from being out of
    // reach without asking twice. Asking twice is cheap and being wrong is not:
    // treat it as merely far off, and the identity check above catches the
    // substitution that would actually leak anything.
    return { kind: "outOfReach", itemId };
  }

  const instance = instanceFromPlacement(placed);
  if (!instance) return { kind: "gone" };
  return { kind: "open", container: { instance, ref }, itemId };
}
