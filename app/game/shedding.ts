import { resolveShed, type ShedInteraction } from "../lib/interactions";
import { getStack, listCoords, presentLevels } from "../lib/mapData";
import { countOf } from "../lib/piles";
import type { Coord, MapFile, PlacedTile, TileDef } from "../lib/types";
import { landingFor } from "./affordances";
import { cellKey } from "./pressurePlates";
import type { Rng } from "./rng";

/** How often shedding placements count down; a tree drops fruit every few minutes, so a second is fine-grained enough. */
export const SHEDDING_STEP_MS = 1000;

export type DueShed = { from: Coord; tileId: string; shed: ShedInteraction };

function sheds(placed: PlacedTile, tilesById: Record<string, TileDef>): ShedInteraction | null {
  if (placed.owner || placed.itemId) return null;
  const def = tilesById[placed.tileId];
  return def ? resolveShed(def) : null;
}

export function cellHasShedding(
  map: MapFile,
  cell: Coord,
  tilesById: Record<string, TileDef>,
): boolean {
  return getStack(map, cell.x, cell.y, cell.z).some((placed) => sheds(placed, tilesById));
}

export function findSheddingCells(map: MapFile, tilesById: Record<string, TileDef>): Coord[] {
  if (!Object.values(tilesById).some((def) => resolveShed(def))) return [];
  const out: Coord[] = [];
  for (const z of presentLevels(map)) {
    for (const { x, y } of listCoords(map, z)) {
      const cell = { x, y, z };
      if (cellHasShedding(map, cell, tilesById)) out.push(cell);
    }
  }
  return out;
}

const NEIGHBOURS: readonly [number, number][] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/**
 * Where a shed item lands: a random one of the eight cells around `from`, on
 * the same level, that has a floor to take it. Null when `max` of it already
 * lie around, counting piles by their size, or when no cell has room.
 */
export function shedLanding(
  map: MapFile,
  from: Coord,
  shed: ShedInteraction,
  tilesById: Record<string, TileDef>,
  rng: Rng,
): Coord | null {
  const cells = NEIGHBOURS.map(([dx, dy]) => ({ x: from.x + dx, y: from.y + dy, z: from.z }));
  const lying = cells.reduce(
    (sum, cell) =>
      sum +
      getStack(map, cell.x, cell.y, cell.z)
        .filter((placed) => placed.tileId === shed.tileId)
        .reduce((n, placed) => n + countOf(placed), 0),
    0,
  );
  if (lying >= shed.max) return null;
  const item: PlacedTile = { tileId: shed.tileId };
  const open = cells.filter((cell) => {
    const at = landingFor(map, cell, [item], tilesById);
    return at !== null && at.z === from.z;
  });
  return open.length === 0 ? null : open[rng.int(open.length)]!;
}

/**
 * Counts each shedding placement down to its next drop. A wait is drawn when
 * the placement is first seen and again after every drop, whether or not the
 * drop found room, so a tree hemmed in by its own fruit tries again later
 * rather than every step.
 */
export class Shedding {
  private readonly cells = new Map<string, Coord>();
  private waits = new Map<string, number>();
  private sinceStepMs = 0;

  constructor(private readonly rng: Rng) {}

  index(map: MapFile, cell: Coord, tilesById: Record<string, TileDef>) {
    const key = cellKey(cell);
    if (cellHasShedding(map, cell, tilesById)) this.cells.set(key, { ...cell });
    else this.cells.delete(key);
  }

  advance(tickMs: number, map: MapFile, tilesById: Record<string, TileDef>): DueShed[] {
    if (this.cells.size === 0) return NO_SHEDS;
    this.sinceStepMs += tickMs;
    if (this.sinceStepMs < SHEDDING_STEP_MS) return NO_SHEDS;
    const stepMs = this.sinceStepMs;
    this.sinceStepMs = 0;

    const due: DueShed[] = [];
    const waiting = new Map<string, number>();
    for (const [key, cell] of this.cells) {
      for (const placed of getStack(map, cell.x, cell.y, cell.z)) {
        const shed = sheds(placed, tilesById);
        const entry = `${key}|${placed.tileId}`;
        if (!shed || waiting.has(entry)) continue;
        const left = (this.waits.get(entry) ?? this.draw(shed)) - stepMs;
        if (left > 0) {
          waiting.set(entry, left);
          continue;
        }
        due.push({ from: cell, tileId: placed.tileId, shed });
        waiting.set(entry, this.draw(shed));
      }
    }
    this.waits = waiting;
    return due;
  }

  private draw(shed: ShedInteraction): number {
    return shed.fromMs + this.rng.int(shed.toMs - shed.fromMs + 1);
  }
}

const NO_SHEDS: DueShed[] = [];
