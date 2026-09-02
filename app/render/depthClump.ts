import { terrainHeight } from "../lib/mapData";
import type { PlacedTile, TileDef } from "../lib/types";

/** Where a slot is drawn from and to, in height units above its level's base. */
export type DepthExtent = { foot: number; top: number };

const EMPTY: DepthExtent = { foot: 0, top: 0 };

/**
 * The extent each slot of a stack is sorted by, with overlapping slots merged.
 *
 * **Two things in one cell that occupy the same space cannot be sorted by
 * geometry**, because geometry says they are in the same place. That is not a
 * rare corner: an intangible tile with height takes up no elevation, so
 * whatever is stacked on it stands *inside* it — a person in an open doorway, a
 * barrel shoved into one. Sorted by their own boxes the taller one wins every
 * pixel where it alone has a surface, which is how a door came to be drawn
 * across the face of whoever stood in it, and across the top of a barrel left
 * in it.
 *
 * Merging the run is the whole of the fix. One extent for all of it means every
 * member gets the same depth, so the only thing left to separate them is
 * `depthStackBias` — stack order, which is the one true answer to which of two
 * things in the same place is in front.
 *
 * **Only what actually overlaps.** A body standing on a crate rests *on* it
 * rather than in it, so the two are separate runs and sort by height exactly as
 * they always did. The test is the honest one — a slot joins the run when its
 * foot is below the run's top — so nothing merges that geometry could have
 * sorted on its own.
 *
 * The top is the *authored* height and not `physicalHeight`, because this is
 * about what is drawn: an intangible door is a full-height picture whatever it
 * lets through.
 */
export function clumpExtents(
  stack: PlacedTile[],
  tilesById: Record<string, TileDef>,
): DepthExtent[] {
  const out: DepthExtent[] = new Array(stack.length);
  if (stack.length === 0) return out;

  // Feet first, as a running total, because a slot's foot is everything the
  // stack raises below it — the same walk `../lib/mapData`'s `elevationAt`
  // does, done once for the whole stack rather than once per slot.
  const feet: number[] = new Array(stack.length);
  const tops: number[] = new Array(stack.length);
  let elev = 0;
  for (let i = 0; i < stack.length; i++) {
    const placed = stack[i]!;
    feet[i] = elev;
    tops[i] = elev + (tilesById[placed.tileId]?.height ?? 0);
    elev += terrainHeight(placed, tilesById);
  }

  let start = 0;
  let foot = feet[0]!;
  let top = tops[0]!;
  const close = (end: number) => {
    const extent: DepthExtent = { foot, top };
    for (let i = start; i < end; i++) out[i] = extent;
  };

  for (let i = 1; i < stack.length; i++) {
    if (feet[i]! < top) {
      foot = Math.min(foot, feet[i]!);
      top = Math.max(top, tops[i]!);
      continue;
    }
    close(i);
    start = i;
    foot = feet[i]!;
    top = tops[i]!;
  }
  close(stack.length);
  return out;
}

/**
 * {@link clumpExtents} for one slot, for the callers that draw a single tile —
 * a walker, a faller, a shoved column. A stack is a handful of tiles, so
 * building all of them to read one is cheaper than a second way of saying it
 * that could disagree.
 */
export function clumpExtentAt(
  stack: PlacedTile[],
  stackIndex: number,
  tilesById: Record<string, TileDef>,
): DepthExtent {
  return clumpExtents(stack, tilesById)[stackIndex] ?? EMPTY;
}

/**
 * The extent a tile would join if it were appended to this stack.
 *
 * A walker is still placed in the cell it left — the simulation commits a step
 * at the end of it — so the clump it is *arriving* into does not exist on the
 * board yet, and asking the destination stack about it would leave the door out
 * of the answer. This is that answer, without building the stack the step will
 * make.
 *
 * Merging against the topmost run alone is exact rather than a shortcut: an
 * arriving tile's foot is the whole stack's elevation, so it is at or above
 * every slot's foot, and a merge can therefore only ever reach the last run —
 * never cascade into the one below it.
 */
export function clumpExtentOnArrival(
  stack: PlacedTile[],
  arriving: TileDef | undefined,
  tilesById: Record<string, TileDef>,
): DepthExtent {
  let foot = 0;
  for (const placed of stack) foot += terrainHeight(placed, tilesById);
  // A tile the catalogue has never heard of takes up nothing, exactly as
  // {@link clumpExtents} reads one.
  let top = foot + (arriving?.height ?? 0);

  const extents = clumpExtents(stack, tilesById);
  const last = extents[extents.length - 1];
  if (last && foot < last.top) {
    foot = Math.min(foot, last.foot);
    top = Math.max(top, last.top);
  }
  return { foot, top };
}

/**
 * Where the midpoint of a step is, as a fraction of it.
 *
 * A walker belongs to the clump it is arriving into for the *second half* of
 * its step rather than from the moment the simulation commits one. Committing
 * is the honest instant for the board and the wrong one for the picture: a body
 * walking north into a doorway is already drawn over the doorway long before it
 * arrives there, so a door that only gets out of its way at the end clips its
 * head for most of the step. Half is where the sprite has visibly crossed.
 */
const STEP_CLUMP_AT = 0.5;

/**
 * How tall a walker sorts, part-way through a step.
 *
 * Pure, and out here rather than on the renderer for the reason `./fallAnchor`
 * and `./slideMotion` are: the arithmetic is the whole of the behaviour and it
 * wants a test, while the renderer around it wants a canvas.
 */
export function steppingClumpHeight(
  origin: { stack: PlacedTile[]; stackIndex: number },
  destination: { stack: PlacedTile[]; arriving: TileDef | undefined },
  progress: number,
  tilesById: Record<string, TileDef>,
): number {
  const extent =
    progress < STEP_CLUMP_AT
      ? clumpExtentAt(origin.stack, origin.stackIndex, tilesById)
      : clumpExtentOnArrival(
          destination.stack,
          destination.arriving,
          tilesById,
        );
  return extent.top - extent.foot;
}
