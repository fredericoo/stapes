import { getStack, listCoords, replaceStack } from "../lib/mapData";
import type { ReceiveInteraction } from "../lib/interactions";
import {
  receiveTriggers,
  resolveEmit,
  resolveReceive,
} from "../lib/interactions";
import type { Coord, MapFile, PlacedTile, TileDef } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import { canReplaceStack } from "../lib/validation";

/**
 * How many emitters on a channel are currently driving it on.
 *
 * Both numbers are kept because the aggregation is the receiver's call, not
 * the channel's: a door wired to three plates may want any one of them or all
 * three, and a channel that resolved itself to a single boolean could not
 * answer both.
 */
export type ChannelTally = {
  on: number;
  total: number;
};

/** Channel name → its emitters' tally. Channels with no emitter are absent. */
export type ChannelState = Map<string, ChannelTally>;

/**
 * Does this channel read as powered, for a receiver aggregating this way?
 *
 * An unknown channel is unpowered rather than an error: wiring a door before
 * its plate exists is a half-finished map, not a broken one, and a door that
 * refused to resolve would be worse to author against than one that sits
 * closed. `all` on an empty channel is likewise false — "all of nothing" is a
 * vacuous truth that would read on screen as a door opening for no reason.
 */
export function channelPowered(
  state: ChannelState,
  channel: string,
  mode: ReceiveInteraction["mode"],
): boolean {
  const tally = state.get(channel);
  if (!tally || tally.total === 0) return false;
  return mode === "all" ? tally.on === tally.total : tally.on > 0;
}

/**
 * Does any tile in this cell's stack sit on a channel?
 *
 * The channel alone answers this — not whether the tile currently in the slot
 * emits or receives. A wired slot holds a door that alternates between a form
 * that receives and one that does not, and an index that dropped the cell the
 * moment it stopped listening would have no way to notice it started again.
 */
export function cellIsWired(map: MapFile, cell: Coord): boolean {
  return getStack(map, cell.x, cell.y, cell.z).some((placed) =>
    Boolean(placed.channel),
  );
}

/**
 * Every cell holding a wired placement. Whole-map scan — for building an index
 * once, not for running per tick.
 */
export function findWiredCells(map: MapFile): Coord[] {
  const out: Coord[] = [];
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { x, y } of listCoords(map, z)) {
      const cell = { x, y, z };
      if (cellIsWired(map, cell)) out.push(cell);
    }
  }
  return out;
}

/**
 * What every channel reads right now, from the emitters in `cells`.
 *
 * Read fresh each pass rather than maintained incrementally: an emitter's
 * value is a property of the tile currently in the slot, so any swap anywhere
 * can change it, and a handful of wired cells is cheaper to re-read than to
 * keep an invalidation rule honest.
 */
export function readChannels(
  map: MapFile,
  cells: Iterable<Coord>,
  tilesById: Record<string, TileDef>,
): ChannelState {
  const state: ChannelState = new Map();
  for (const cell of cells) {
    for (const placed of getStack(map, cell.x, cell.y, cell.z)) {
      const channel = placed.channel;
      if (!channel) continue;
      const def = tilesById[placed.tileId];
      const emit = def && resolveEmit(def);
      if (!emit) continue;

      const tally = state.get(channel) ?? { on: 0, total: 0 };
      tally.total += 1;
      if (emit.value === "on") tally.on += 1;
      state.set(channel, tally);
    }
  }
  return state;
}

/**
 * `stack` with the receiver at `i` swapped for its target, or null when its
 * channel does not call for it. A swap that would not fit is refused rather
 * than forced, exactly as for plates: a door must not open into whatever has
 * been stacked on it.
 */
function swapReceiverAt(
  map: MapFile,
  cell: Coord,
  stack: PlacedTile[],
  i: number,
  state: ChannelState,
  tilesById: Record<string, TileDef>,
): PlacedTile[] | null {
  const placed = stack[i];
  if (!placed?.channel) return null;
  const def = tilesById[placed.tileId];
  const receive: ReceiveInteraction | null = def ? resolveReceive(def) : null;
  if (!receive || !tilesById[receive.tileId]) return null;
  if (!receiveTriggers(receive, channelPowered(state, placed.channel, receive.mode))) {
    return null;
  }

  const next = stack.map((p, j) => (j === i ? { ...p, tileId: receive.tileId } : p));
  return canReplaceStack(map, cell.x, cell.y, cell.z, next, tilesById).ok
    ? next
    : null;
}

/** The stack this cell settles to, or null when no receiver in it triggers. */
function settledStack(
  map: MapFile,
  cell: Coord,
  state: ChannelState,
  tilesById: Record<string, TileDef>,
): PlacedTile[] | null {
  const stack = getStack(map, cell.x, cell.y, cell.z);
  let next = stack;
  for (let i = 0; i < stack.length; i++) {
    const swapped = swapReceiverAt(map, cell, next, i, state, tilesById);
    if (swapped) next = swapped;
  }
  return next === stack ? null : next;
}

export type SignalResult = {
  map: MapFile;
  /** Cells whose stack changed — their wired index entries are now suspect. */
  changed: Coord[];
};

/**
 * One settle pass over `cells`: read every channel, then bring every receiver
 * in line with the channel it watches.
 *
 * Channels are read once, up front, so the pass is order-independent — a
 * receiver does not see a sibling's swap land mid-sweep and every receiver on
 * a channel therefore agrees about it. Emitters driven by this pass's own
 * swaps are picked up on the next one, which is the same single-pass rule
 * plates settle under: a loop wired back on itself oscillates at tick rate
 * instead of spinning the frame.
 */
export function settleSignals(
  map: MapFile,
  cells: Iterable<Coord>,
  tilesById: Record<string, TileDef>,
): SignalResult {
  const wired = [...cells];
  const state = readChannels(map, wired, tilesById);
  const changed: Coord[] = [];
  let next = map;
  for (const cell of wired) {
    const stack = settledStack(next, cell, state, tilesById);
    if (!stack) continue;
    next = replaceStack(next, cell.x, cell.y, cell.z, stack);
    changed.push(cell);
  }
  return { map: next, changed };
}
