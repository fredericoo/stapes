/**
 * What of the map a client is told about.
 *
 * The world is one board and every client used to be sent all of it: the whole
 * map on join, and every cell that changed anywhere on every tick. That was
 * right while the map was a town — 2.4MB to join, 12 KB/s to keep up — and
 * stopped being right when the underworld arrived: 4.6MB to join, four and a
 * half seconds before a player could move, and 106 KB/s of cells for a den on
 * the other side of the world.
 *
 * A player can only ever see {@link VIEW_CELLS} across, and that is a guarantee
 * rather than a happy accident — the viewport is a fixed square of world on
 * every device, so nobody's monitor buys them a longer sightline. Which makes
 * the answer to "what do they need" small, knowable, and the same for everybody.
 *
 * **The unit is the cell, and that was not the first answer.** Quantising to the
 * map's chunks looked obviously right — a chunk is what the checkpoint and the
 * copy-on-write diff already work in, and it means a subscription changes when
 * you cross a boundary rather than on every step. What it costs is paid at those
 * boundaries, and a chunk column of the den is four levels of dense cave: about
 * 50KB, arriving as a spike, every few seconds of walking. Measured, a client
 * walking non-stop cost *more* that way than being sent the whole world's
 * changes had. A rect moves with the player and hands over the thin strip that
 * has just come into reach — a fifth of a chunk column, spread evenly rather
 * than arriving in lumps.
 *
 * **Every level of it, always.** Scoping by level as well is tempting and is a
 * trap: you can see down a hole into the floor below, a pit drops you a level
 * without warning, and a ramp is a level change you walk up. A body has to land
 * somewhere it has been told about.
 */
import { getStack } from "../lib/mapData";
import { MAX_LEVEL, MIN_LEVEL, coordKey, levelKey } from "../lib/types";
import type { FlatMapFile, MapFile, PlacedTile } from "../lib/types";
import { VIEW_CELLS } from "../lib/view";

/**
 * Cells of world kept loaded beyond the edge of what can be seen.
 *
 * A subscription is recomputed every tick, so this is not a margin against the
 * server being slow — it is how much built world lies past the edge of the
 * screen, and so how wrong the server may be about where somebody is going
 * before they can tell. Six cells is a little over a second at a walk.
 *
 * **It is not the lever for the light that leaks in at the boundary**, which is
 * the tempting reading and was measured to be wrong. What a client does not
 * hold, the sky flood reads as open air, so the edge of a subscription seeds
 * daylight that spills inward — and the obvious answer, an apron wider than
 * `MAX_LIGHT_LEVEL`, pushes the leak off-screen at the cost of a client holding
 * 2.3x the map. Measured over two interleaved rounds, that traded a frame p50 of
 * 6.0ms for one of 8.3–16.9ms: the extra world costs more to carry than the
 * light costs to get wrong. Unknown has to be *told* to read as solid instead.
 *
 * It is also the term that costs, and it is paid on the square: six puts a join
 * at about 190KB of the den, where fifteen makes it 460KB.
 */
export const INTEREST_APRON_CELLS = 6;

/** How far from a body the world is kept loaded, in cells. */
const INTEREST_REACH = Math.floor(VIEW_CELLS / 2) + INTEREST_APRON_CELLS;

/** The square of world one client holds. Inclusive on all four sides. */
export type Interest = { x0: number; y0: number; x1: number; y1: number };

/**
 * What a body standing at `(x, y)` is told about.
 *
 * Deliberately not a function of which way they are facing or moving. A
 * subscription that leads the player would have to be un-led when they turn
 * round, and turning round is free.
 */
export function interestAt(x: number, y: number): Interest {
  return {
    x0: x - INTEREST_REACH,
    y0: y - INTEREST_REACH,
    x1: x + INTEREST_REACH,
    y1: y + INTEREST_REACH,
  };
}

/** Is this a cell the holder of `interest` has been sent? */
export function covers(interest: Interest, x: number, y: number): boolean {
  return x >= interest.x0 && x <= interest.x1 && y >= interest.y0 && y <= interest.y1;
}

/** Two subscriptions over the same square — nothing has come into reach. */
export function sameInterest(a: Interest | undefined, b: Interest): boolean {
  return a != null && a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
}

/** Every occupied cell of `interest` that `skip` did not already cover. */
function eachCell(
  map: MapFile,
  interest: Interest,
  skip: Interest | undefined,
  visit: (x: number, y: number, z: number, stack: PlacedTile[]) => void,
) {
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (let x = interest.x0; x <= interest.x1; x++) {
      for (let y = interest.y0; y <= interest.y1; y++) {
        if (skip && covers(skip, x, y)) continue;
        const stack = getStack(map, x, y, z);
        if (stack.length > 0) visit(x, y, z, stack);
      }
    }
  }
}

/**
 * The map as one client should first see it.
 *
 * The shape is a whole `FlatMapFile` because that is what a joiner is sent and
 * what it parses — a client is not told it is holding part of a map, and has no
 * use for knowing. What it does not have, it cannot see.
 */
export function mapOfInterest(map: MapFile, interest: Interest): FlatMapFile {
  const levels: FlatMapFile["levels"] = {};
  eachCell(map, interest, undefined, (x, y, z, stack) => {
    (levels[levelKey(z)] ??= {})[coordKey(x, y)] = stack;
  });
  return { version: 1, levels };
}

/**
 * The cells that came into reach between one subscription and the next.
 *
 * Their current contents rather than a diff, because there is nothing on the far
 * end to diff against: those cells have been changing, unwatched, for as long as
 * this client has been connected.
 *
 * A step east is one column down the eastern edge. A teleport is the whole
 * square, which is right — you have arrived somewhere you have never been.
 */
export function cellsEntered(
  map: MapFile,
  before: Interest | undefined,
  now: Interest,
): Array<{ x: number; y: number; z: number; stack: PlacedTile[] }> {
  const out: Array<{ x: number; y: number; z: number; stack: PlacedTile[] }> = [];
  eachCell(map, now, before, (x, y, z, stack) => out.push({ x, y, z, stack }));
  return out;
}
