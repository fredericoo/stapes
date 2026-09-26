import { getStack, listCoords, replaceStack } from "../lib/mapData";
import type { ReceiveInteraction, SignalValue } from "../lib/interactions";
import { receiveTriggers, resolveEmit, resolveReceive } from "../lib/interactions";
import type { Coord, MapFile, PlacedTile, TileDef } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import { canReplaceStack } from "../lib/validation";

export type ChannelTally = {
  on: number;
  total: number;
};

export type ChannelState = Map<string, ChannelTally>;

export type ExtraEmitter = { channel: string; value: SignalValue };

export function channelPowered(
  state: ChannelState,
  channel: string,
  mode: ReceiveInteraction["mode"],
): boolean {
  const tally = state.get(channel);
  if (!tally || tally.total === 0) return false;
  return mode === "all" ? tally.on === tally.total : tally.on > 0;
}

export function cellIsWired(map: MapFile, cell: Coord): boolean {
  return getStack(map, cell.x, cell.y, cell.z).some((placed) => Boolean(placed.channel));
}

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

export function readChannels(
  map: MapFile,
  cells: Iterable<Coord>,
  tilesById: Record<string, TileDef>,
  extra: Iterable<ExtraEmitter> = [],
): ChannelState {
  const state: ChannelState = new Map();
  const add = (channel: string, value: SignalValue) => {
    const tally = state.get(channel) ?? { on: 0, total: 0 };
    tally.total += 1;
    if (value === "on") tally.on += 1;
    state.set(channel, tally);
  };

  for (const cell of cells) {
    for (const placed of getStack(map, cell.x, cell.y, cell.z)) {
      const channel = placed.channel;
      if (!channel) continue;
      const def = tilesById[placed.tileId];
      const emit = def && resolveEmit(def);
      if (!emit) continue;
      add(channel, emit.value);
    }
  }
  for (const source of extra) add(source.channel, source.value);
  return state;
}

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
  return canReplaceStack(map, cell.x, cell.y, cell.z, next, tilesById).ok ? next : null;
}

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
  changed: Coord[];
};

export function settleSignals(
  map: MapFile,
  cells: Iterable<Coord>,
  tilesById: Record<string, TileDef>,
  extra: Iterable<ExtraEmitter> = [],
): SignalResult {
  const wired = [...cells];
  const state = readChannels(map, wired, tilesById, extra);
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
