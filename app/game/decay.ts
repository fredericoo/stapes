import type { DecayInteraction } from "../lib/interactions";
import { resolveDecay } from "../lib/interactions";
import { isItem, resolveContainer } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { countOf, peelOne, stackWithItem, stow, withCount } from "../lib/piles";
import type { StackEdit } from "../lib/mapData";
import { getStack, listCoords, replaceStack, setStacks } from "../lib/mapData";
import type { Coord, MapFile, PlacedTile, TileDef } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import { canReplaceStack } from "../lib/validation";
import { carriedInstances, EQUIPMENT_SLOTS, type Equipment } from "./equipment";
import { type SlotKind, slotAccepts } from "./itemMoves";
import { cellKey } from "./pressurePlates";
import type { Rng } from "./rng";

function entryKey(cell: Coord, tileId: string): string {
  return `${cellKey(cell)}|${tileId}`;
}

function itemEntryKey(itemId: string): string {
  return `item|${itemId}`;
}

export type PlacementDecay = {
  kind: "placement";
  cell: Coord;
  tileId: string;
  dueMs: number;
};

export type ItemDecay = {
  kind: "item";
  itemId: string;
  tileId: string;
  dueMs: number;
};

export type DecayEntry = PlacementDecay | ItemDecay;

export function cellHasDecay(
  map: MapFile,
  cell: Coord,
  tilesById: Record<string, TileDef>,
): boolean {
  return getStack(map, cell.x, cell.y, cell.z).some((placed) => {
    if (decayOf(placed.tileId, tilesById)) return true;
    return (placed.contents ?? []).some((held) => decayOf(held.tileId, tilesById));
  });
}

function decayOf(tileId: string, tilesById: Record<string, TileDef>): DecayInteraction | null {
  const def = tilesById[tileId];
  return def ? resolveDecay(def) : null;
}

export function findDecayCells(map: MapFile, tilesById: Record<string, TileDef>): Coord[] {
  const out: Coord[] = [];
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { x, y } of listCoords(map, z)) {
      const cell = { x, y, z };
      if (cellHasDecay(map, cell, tilesById)) out.push(cell);
    }
  }
  return out;
}

export class DecayIndex {
  private readonly entries = new Map<string, DecayEntry>();
  private readonly rng: Rng;
  private elapsedMs = 0;
  private nextDueMs = Number.POSITIVE_INFINITY;

  constructor(rng: Rng) {
    this.rng = rng;
  }

  advance(tickMs: number) {
    this.elapsedMs += tickMs;
  }

  pending(): boolean {
    return this.entries.size > 0;
  }

  armCell(map: MapFile, cell: Coord, tilesById: Record<string, TileDef>) {
    for (const placed of getStack(map, cell.x, cell.y, cell.z)) {
      if (placed.itemId) {
        this.armItem(placed.itemId, placed.tileId, tilesById);
      } else {
        this.armPlacement(cell, placed.tileId, tilesById);
      }
      for (const held of placed.contents ?? []) {
        this.armItem(held.id, held.tileId, tilesById);
      }
    }
  }

  armEquipment(equipment: Equipment, tilesById: Record<string, TileDef>) {
    for (const instance of carriedInstances(equipment)) {
      this.armItem(instance.id, instance.tileId, tilesById);
    }
  }

  private armPlacement(cell: Coord, tileId: string, tilesById: Record<string, TileDef>) {
    const decay = decayOf(tileId, tilesById);
    if (!decay) return;
    const key = entryKey(cell, tileId);
    if (this.entries.has(key)) return;
    this.file(key, {
      kind: "placement",
      cell: { ...cell },
      tileId,
      dueMs: this.elapsedMs + this.rollLifetimeMs(decay),
    });
  }

  private armItem(itemId: string | undefined, tileId: string, tilesById: Record<string, TileDef>) {
    if (!itemId) return;
    const decay = decayOf(tileId, tilesById);
    if (!decay) return;
    const key = itemEntryKey(itemId);
    if (this.entries.has(key)) return;
    this.file(key, {
      kind: "item",
      itemId,
      tileId,
      dueMs: this.elapsedMs + this.rollLifetimeMs(decay),
    });
  }

  private file(key: string, entry: DecayEntry) {
    this.entries.set(key, entry);
    if (entry.dueMs < this.nextDueMs) this.nextDueMs = entry.dueMs;
  }

  private rollLifetimeMs(decay: DecayInteraction): number {
    return decay.fromMs + this.rng.int(decay.toMs - decay.fromMs + 1);
  }

  takeDue(): DecayEntry[] {
    if (this.elapsedMs < this.nextDueMs) return [];

    const due: DecayEntry[] = [];
    let soonest = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.entries) {
      if (entry.dueMs <= this.elapsedMs) {
        due.push(entry);
        this.entries.delete(key);
      } else if (entry.dueMs < soonest) {
        soonest = entry.dueMs;
      }
    }
    this.nextDueMs = soonest;
    return due;
  }
}

export type DecayResult = {
  map: MapFile;
  changed: Coord[];
};

export type TurnedPlacement = {
  cell: Coord;
  tileId: string;
  fromIndex: number;
  into: { tileId: string; stackIndex: number } | undefined;
};

export type PlacementDecayResult = DecayResult & { turned: TurnedPlacement[] };

function turnsHere(placed: PlacedTile, tileId: string): boolean {
  return placed.tileId === tileId && !placed.owner && !placed.itemId;
}

type DecayedStack = {
  stack: PlacedTile[];
  swaps: Array<{ before: PlacedTile; after: PlacedTile | undefined }>;
};

function decayedStack(
  map: MapFile,
  cell: Coord,
  tileId: string,
  tilesById: Record<string, TileDef>,
): DecayedStack | null {
  const decay = decayOf(tileId, tilesById);
  if (!decay) return null;
  if (decay.tileId && !tilesById[decay.tileId]) return null;

  const stack = getStack(map, cell.x, cell.y, cell.z);
  const next: PlacedTile[] = [];
  const swaps: DecayedStack["swaps"] = [];
  for (const placed of stack) {
    if (!turnsHere(placed, tileId)) {
      next.push(placed);
      continue;
    }
    const after = decay.tileId ? { ...placed, tileId: decay.tileId } : undefined;
    if (after) next.push(after);
    swaps.push({ before: placed, after });
  }
  if (swaps.length === 0) return null;

  return canReplaceStack(map, cell.x, cell.y, cell.z, next, tilesById).ok
    ? { stack: next, swaps }
    : null;
}

export function applyDecay(
  map: MapFile,
  entries: Iterable<PlacementDecay>,
  tilesById: Record<string, TileDef>,
): PlacementDecayResult {
  const changed: Coord[] = [];
  const startedAt = new Map<PlacedTile, number>();
  const madeThisPass = new Set<PlacedTile>();
  const seenCells = new Set<string>();
  const swapped: Array<{
    cell: Coord;
    tileId: string;
    fromIndex: number;
    after: PlacedTile | undefined;
  }> = [];

  let next = map;
  for (const { cell, tileId } of entries) {
    const cellKey = `${cell.z}:${cell.x},${cell.y}`;
    if (!seenCells.has(cellKey)) {
      seenCells.add(cellKey);
      getStack(next, cell.x, cell.y, cell.z).forEach((placed, index) => {
        startedAt.set(placed, index);
      });
    }

    const decayed = decayedStack(next, cell, tileId, tilesById);
    if (!decayed) continue;
    for (const { before, after } of decayed.swaps) {
      const fromIndex = startedAt.get(before);
      if (after && fromIndex !== undefined) startedAt.set(after, fromIndex);
      if (after) madeThisPass.add(after);
      if (fromIndex === undefined || madeThisPass.has(before)) continue;
      swapped.push({ cell, tileId, fromIndex, after });
    }
    next = replaceStack(next, cell.x, cell.y, cell.z, decayed.stack);
    changed.push(cell);
  }

  const turned = swapped.map(({ cell, tileId, fromIndex, after }) => {
    const stackIndex = after ? getStack(next, cell.x, cell.y, cell.z).indexOf(after) : -1;
    return {
      cell,
      tileId,
      fromIndex,
      into: after && stackIndex >= 0 ? { tileId: after.tileId, stackIndex } : undefined,
    };
  });
  return { map: next, changed, turned };
}

type ItemSite = SlotKind | "floor";

type Turn =
  | { kind: "stays" }
  | { kind: "gone" }
  | { kind: "turned"; tileId: string }
  | { kind: "peeled"; tileId?: string };

const STAYS: Turn = { kind: "stays" };
const GONE: Turn = { kind: "gone" };
const PEELED_GONE: Turn = { kind: "peeled" };

function turnOf(
  thing: {
    id: string;
    tileId: string;
    contents?: ItemInstance[];
    count?: number;
  },
  site: ItemSite,
  due: ReadonlyMap<string, string>,
  tilesById: Record<string, TileDef>,
): Turn {
  if (due.get(thing.id) !== thing.tileId) return STAYS;
  const decay = decayOf(thing.tileId, tilesById);
  if (!decay) return STAYS;

  const pile = countOf(thing) > 1;
  if (pile && !decay.tileId) return PEELED_GONE;

  const held = thing.contents?.length ?? 0;
  if (!decay.tileId) return held > 0 ? STAYS : GONE;

  const target = tilesById[decay.tileId];
  if (!target) return STAYS;
  if (held > (resolveContainer(target)?.size ?? 0)) return STAYS;

  if (site === "floor") {
    return pile
      ? { kind: "peeled", tileId: decay.tileId }
      : { kind: "turned", tileId: decay.tileId };
  }
  const next: ItemInstance = pile
    ? { id: thing.id, tileId: decay.tileId }
    : { ...thing, tileId: decay.tileId };
  if (!isItem(target) || !slotAccepts(site, next, tilesById)) return STAYS;
  return pile ? { kind: "peeled", tileId: decay.tileId } : { kind: "turned", tileId: decay.tileId };
}

function roomIn(tileId: string, tilesById: Record<string, TileDef>): number {
  const def = tilesById[tileId];
  return def ? (resolveContainer(def)?.size ?? 0) : 0;
}

function decayedContents(
  contents: readonly ItemInstance[],
  site: ItemSite,
  due: ReadonlyMap<string, string>,
  tilesById: Record<string, TileDef>,
  capacity: number,
  mintId: () => string,
): ItemInstance[] | null {
  const next: ItemInstance[] = [];
  const peels: { at: number; shed: ItemInstance }[] = [];
  let touched = false;
  for (const held of contents) {
    const turn = turnOf(held, site, due, tilesById);
    if (turn.kind === "stays") {
      next.push(held);
      continue;
    }
    touched = true;
    if (turn.kind === "turned") next.push({ ...held, tileId: turn.tileId });
    if (turn.kind !== "peeled") continue;
    const rest = peelOne(held) ?? held;
    if (turn.tileId) {
      peels.push({ at: next.length, shed: { id: mintId(), tileId: turn.tileId } });
    }
    next.push(rest);
  }
  if (!touched) return null;

  let out = next;
  for (const { at, shed } of peels) {
    const stowed = stow(out, shed, capacity, tilesById);
    out = stowed ?? out.map((held, i) => (i === at ? withCount(held, countOf(held) + 1) : held));
  }
  return out;
}

type SlotAfter = { changed: boolean; instance: ItemInstance | null };

const UNCHANGED: SlotAfter = { changed: false, instance: null };

function slotAfter(
  instance: ItemInstance | null,
  site: SlotKind,
  due: ReadonlyMap<string, string>,
  tilesById: Record<string, TileDef>,
  mintId: () => string,
): SlotAfter {
  if (!instance) return UNCHANGED;
  const contents = instance.contents
    ? decayedContents(
        instance.contents,
        "contents",
        due,
        tilesById,
        roomIn(instance.tileId, tilesById),
        mintId,
      )
    : null;
  const held = contents ?? instance.contents;
  const inside = contents ? { ...instance, contents } : instance;

  const turn = turnOf({ ...instance, contents: held }, site, due, tilesById);
  if (turn.kind === "stays") {
    return { changed: contents != null, instance: inside };
  }
  if (turn.kind === "gone") return { changed: true, instance: null };
  if (turn.kind === "peeled") {
    if (turn.tileId) return { changed: contents != null, instance: inside };
    const rest = peelOne(inside);
    return { changed: true, instance: rest };
  }
  return { changed: true, instance: { ...inside, tileId: turn.tileId } };
}

function decayedEquipment(
  equipment: Equipment,
  due: ReadonlyMap<string, string>,
  tilesById: Record<string, TileDef>,
  mintId: () => string,
): Equipment | null {
  const next = { ...equipment };
  let changed = false;
  for (const slot of EQUIPMENT_SLOTS) {
    const after = slotAfter(equipment[slot], slot, due, tilesById, mintId);
    if (!after.changed) continue;
    changed = true;
    next[slot] = after.instance;
  }
  return changed ? next : null;
}

function placementAfterTurn(
  placed: PlacedTile,
  tileId: string,
  contents: ItemInstance[] | undefined,
  tilesById: Record<string, TileDef>,
): PlacedTile {
  const next: PlacedTile = { ...placed, tileId };
  if (contents) next.contents = contents;
  const def = tilesById[tileId];
  if (def && isItem(def)) return next;
  delete next.itemId;
  return next;
}

function decayedItemsInStack(
  stack: readonly PlacedTile[],
  due: ReadonlyMap<string, string>,
  tilesById: Record<string, TileDef>,
  mintId: () => string,
): PlacedTile[] | null {
  let next: PlacedTile[] = [];
  const shed: PlacedTile[] = [];
  let touched = false;
  for (const placed of stack) {
    const contents = placed.contents
      ? decayedContents(
          placed.contents,
          "ground",
          due,
          tilesById,
          roomIn(placed.tileId, tilesById),
          mintId,
        )
      : null;
    const held = contents ?? placed.contents;
    if (contents) touched = true;

    const turn = placed.itemId
      ? turnOf(
          {
            id: placed.itemId,
            tileId: placed.tileId,
            contents: held,
            count: placed.count,
          },
          "floor",
          due,
          tilesById,
        )
      : STAYS;
    if (turn.kind === "gone") {
      touched = true;
      continue;
    }
    if (turn.kind === "turned") {
      touched = true;
      next.push(placementAfterTurn(placed, turn.tileId, held, tilesById));
      continue;
    }
    if (turn.kind === "peeled") {
      touched = true;
      const rest = peelOne(placed) ?? placed;
      next.push(contents ? { ...rest, contents } : rest);
      if (turn.tileId) shed.push(shedPlacement(turn.tileId, tilesById, mintId));
      continue;
    }
    next.push(contents ? { ...placed, contents } : placed);
  }
  if (!touched) return null;
  for (const placed of shed) next = stackWithItem(next, placed, tilesById);
  return next;
}

function shedPlacement(
  tileId: string,
  tilesById: Record<string, TileDef>,
  mintId: () => string,
): PlacedTile {
  const def = tilesById[tileId];
  return def && isItem(def) ? { tileId, itemId: mintId() } : { tileId };
}

function decayedBoard(
  map: MapFile,
  due: ReadonlyMap<string, string>,
  tilesById: Record<string, TileDef>,
  mintId: () => string,
): DecayResult {
  const edits: StackEdit[] = [];
  const changed: Coord[] = [];
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { x, y, stack } of listCoords(map, z)) {
      const next = decayedItemsInStack(stack, due, tilesById, mintId);
      if (!next) continue;
      if (!canReplaceStack(map, x, y, z, next, tilesById).ok) continue;
      edits.push({ x, y, z, stack: next });
      changed.push({ x, y, z });
    }
  }
  return { map: setStacks(map, edits), changed };
}

export type Kit = { id: string; equipment: Equipment };

export type ItemDecayResult = DecayResult & {
  equipment: Map<string, Equipment>;
};

export function applyItemDecay(
  map: MapFile,
  kits: Iterable<Kit>,
  entries: Iterable<ItemDecay>,
  tilesById: Record<string, TileDef>,
  mintId: () => string,
): ItemDecayResult {
  const due = new Map<string, string>();
  for (const entry of entries) due.set(entry.itemId, entry.tileId);

  const equipment = new Map<string, Equipment>();
  for (const kit of kits) {
    const next = decayedEquipment(kit.equipment, due, tilesById, mintId);
    if (next) equipment.set(kit.id, next);
  }
  return { ...decayedBoard(map, due, tilesById, mintId), equipment };
}
