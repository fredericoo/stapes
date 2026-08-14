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
 * ## Closed is closed
 *
 * There is no "temporarily out of view" state to come back from. Anything that
 * stops the panel — walking off, somebody carrying the box away, a crate landing
 * on it — closes it for good, and opening it again is a deliberate act. The
 * alternative reopens a panel on its own as you wander back past a chest, which
 * is a window appearing without anybody asking for one.
 *
 * That also disposes of the case worth being strict about. A reference names a
 * *slot*, not a thing, so a box that has been carried off leaves its slot to
 * whatever comes next; a reference kept alive across that would show the inside
 * of whatever took its place. **You must not see what is in a bag somebody else
 * has picked up.** With nothing kept, there is nothing to substitute into.
 *
 * The identity check earns its keep even so: a box can be swapped while you are
 * standing right over it, and that is precisely when nobody is walking anywhere
 * to close the panel.
 */
export type OpenedContainerRead =
  /** In reach and the same box. Here is what is in it. */
  | { kind: "open"; container: OpenedContainer; itemId: string }
  /** Not something this viewer may look into. Forget the reference. */
  | { kind: "closed" };

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
  if (!placed || !itemId) return { kind: "closed" };
  // Learnt on the first read, checked on every one after it.
  if (openedItemId !== null && openedItemId !== itemId) {
    return { kind: "closed" };
  }

  // Reach and "is this still a container at all" are one question, and it is
  // the same one that offered the row in the first place — so a box you can
  // open is a box you can go on looking into, with no second rule to disagree.
  if (!canOpenFrom(map, tilesById, self, ref)) return { kind: "closed" };

  const instance = instanceFromPlacement(placed);
  if (!instance) return { kind: "closed" };
  return { kind: "open", container: { instance, ref }, itemId };
}
