import type { ExtractInteraction, ExtractSlot } from "../lib/interactions";
import {
  MAX_EXTRACT_CHANCE,
  extractsLeft,
  extractsReserved,
  resolveExtract,
} from "../lib/interactions";
import { resolveContainer, resolveItem } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { getStack, listCoords, replaceStack } from "../lib/mapData";
import { stow } from "../lib/piles";
import { MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import type { Coord, MapFile, PlacedTile, TileDef } from "../lib/types";
import { coveredBySomething, withinReach, type Actor, type ObjectRef } from "./affordances";
import type { Equipment } from "./equipment";
import { capacityOf } from "./itemMoves";
import { cellKey } from "./pressurePlates";
import type { Progress } from "./progress";

export function extractKey(cell: Coord, tileId: string): string {
  return `${cellKey(cell)}|${tileId}`;
}

export function reachableExtractAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): ExtractInteraction | null {
  if (!withinReach(map, tilesById, actor, ref)) return null;
  const stack = getStack(map, ref.x, ref.y, ref.z);
  if (coveredBySomething(stack, ref.stackIndex, tilesById)) return null;
  const placed = stack[ref.stackIndex];
  if (!placed) return null;
  const def = tilesById[placed.tileId];
  return def ? resolveExtract(def) : null;
}

function placementAt(map: MapFile, ref: ObjectRef): PlacedTile | null {
  return getStack(map, ref.x, ref.y, ref.z)[ref.stackIndex] ?? null;
}

export function pullsLeftAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  extract: ExtractInteraction,
  ref: ObjectRef,
): number {
  const placed = placementAt(map, ref);
  if (!placed) return 0;
  const def = tilesById[placed.tileId];
  if (!def || resolveExtract(def) !== extract) return 0;
  return extractsLeft(placed, extract);
}

const HYPOTHETICAL = () => "itm_hypothetical";

export function stowExtracted(
  bag: ItemInstance,
  tileIds: readonly string[],
  tilesById: Record<string, TileDef>,
  mintId: () => string,
): ItemInstance[] | null {
  const capacity = capacityOf(bag, tilesById);
  let contents: ItemInstance[] = [...(bag.contents ?? [])];

  for (const tileId of tileIds) {
    const def = tilesById[tileId];
    if (!def) return null;
    if (!resolveItem(def) || resolveContainer(def)) return null;
    const next = stow(contents, { id: mintId(), tileId }, capacity, tilesById);
    if (!next) return null;
    contents = next;
  }

  return contents;
}

export function extractFits(
  extract: ExtractInteraction,
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
): boolean {
  const bag = equipment.bag;
  if (!bag) return false;
  const tileIds = extract.slots.map((slot) => slot.tileId);
  return stowExtracted(bag, tileIds, tilesById, HYPOTHETICAL) !== null;
}

export function extractOfferedAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): ExtractInteraction | null {
  const extract = reachableExtractAt(map, tilesById, actor, ref);
  if (!extract) return null;
  if (pullsLeftAt(map, tilesById, extract, ref) <= 0) return null;
  return extract;
}

export function pullsFreeAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  extract: ExtractInteraction,
  ref: ObjectRef,
): number {
  const placed = placementAt(map, ref);
  if (!placed) return 0;
  const left = pullsLeftAt(map, tilesById, extract, ref);
  return Math.max(0, left - extractsReserved(placed));
}

export function canExtractFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  ref: ObjectRef,
): boolean {
  const extract = extractOfferedAt(map, tilesById, actor, ref);
  if (!extract) return false;
  if (pullsFreeAt(map, tilesById, extract, ref) <= 0) return false;
  return extractFits(extract, tilesById, equipment);
}

export function extractionAt(
  map: MapFile,
  extracting: Extraction | null,
  ref: ObjectRef,
): Extraction | null {
  if (!extracting) return null;
  const placed = placementAt(map, ref);
  if (!placed) return null;
  return extracting.key === extractKey(ref, placed.tileId) ? extracting : null;
}

export function canBeginExtract(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  ref: ObjectRef,
  extracting: Extraction | null,
): boolean {
  if (!canExtractFrom(map, tilesById, actor, equipment, ref)) return false;
  return extractionAt(map, extracting, ref) === null;
}

export type Extraction = Progress & {
  key: string;
};

export type ExtractionProgress = Progress;

export function withReservation(placed: PlacedTile, delta: number): PlacedTile {
  const held = extractsReserved(placed) + delta;
  if (held > 0) return { ...placed, extractsReserved: held };
  return withoutReservations(placed);
}

export function withoutReservations(placed: PlacedTile): PlacedTile {
  const { extractsReserved: _held, ...rest } = placed;
  return rest;
}

export function clearExtractReservations(map: MapFile): MapFile {
  let next = map;
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { x, y, stack } of listCoords(map, z)) {
      if (!stack.some((placed) => placed.extractsReserved != null)) continue;
      next = replaceStack(
        next,
        x,
        y,
        z,
        stack.map((placed) =>
          placed.extractsReserved == null ? placed : withoutReservations(placed),
        ),
      );
    }
  }
  return next;
}

function drawn(slot: ExtractSlot, random: () => number): boolean {
  return random() * MAX_EXTRACT_CHANCE < slot.chance;
}

export function rollExtract(extract: ExtractInteraction, random: () => number): string[] {
  const out: string[] = [];
  for (const slot of extract.slots) {
    if (drawn(slot, random)) out.push(slot.tileId);
  }
  return out;
}

export function placementAfterPull(
  placed: PlacedTile,
  extract: ExtractInteraction,
): PlacedTile | null {
  const left = extractsLeft(placed, extract) - 1;
  if (left <= 0) return null;
  return { ...withReservation(placed, -1), extractsLeft: left };
}
