import { resolveWeatherReactions, weatherReactionIn } from "../lib/interactions";
import { getStack, listCoords, presentLevels } from "../lib/mapData";
import type { Coord, MapFile, PlacedTile, TileDef } from "../lib/types";
import type { WeatherKind } from "../lib/weather";
import type { PlacementTurn } from "./decay";
import { cellKey } from "./pressurePlates";
import type { Rng } from "./rng";

/** How often placements are asked what the weather on their cell is. */
export const WEATHERING_STEP_MS = 1000;

function reacts(placed: PlacedTile, tilesById: Record<string, TileDef>): boolean {
  if (placed.owner || placed.itemId) return false;
  const def = tilesById[placed.tileId];
  return def !== undefined && resolveWeatherReactions(def).length > 0;
}

export function cellHasWeathering(
  map: MapFile,
  cell: Coord,
  tilesById: Record<string, TileDef>,
): boolean {
  return getStack(map, cell.x, cell.y, cell.z).some((placed) => reacts(placed, tilesById));
}

export function findWeatheringCells(map: MapFile, tilesById: Record<string, TileDef>): Coord[] {
  const reactive = new Set<string>();
  for (const def of Object.values(tilesById)) {
    if (resolveWeatherReactions(def).length > 0) reactive.add(def.id);
  }
  if (reactive.size === 0) return [];

  const out: Coord[] = [];
  for (const z of presentLevels(map)) {
    for (const { x, y } of listCoords(map, z)) {
      const cell = { x, y, z };
      if (cellHasWeathering(map, cell, tilesById)) out.push(cell);
    }
  }
  return out;
}

type Exposure = { in: WeatherKind; leftMs: number };

/**
 * Counts how long each reacting placement has stood in the weather its
 * reaction names. The count starts over when the weather on the cell changes:
 * a wait is drawn for one spell of weather and nothing of it carries to the next.
 */
export class Weathering {
  private readonly cells = new Map<string, Coord>();
  private exposures = new Map<string, Exposure>();
  private sinceStepMs = 0;

  constructor(private readonly rng: Rng) {}

  index(map: MapFile, cell: Coord, tilesById: Record<string, TileDef>) {
    const key = cellKey(cell);
    if (cellHasWeathering(map, cell, tilesById)) this.cells.set(key, { ...cell });
    else this.cells.delete(key);
  }

  advance(
    tickMs: number,
    map: MapFile,
    tilesById: Record<string, TileDef>,
    weatherOn: (cell: Coord) => WeatherKind,
  ): PlacementTurn[] {
    if (this.cells.size === 0) return NO_TURNS;
    this.sinceStepMs += tickMs;
    if (this.sinceStepMs < WEATHERING_STEP_MS) return NO_TURNS;
    const stepMs = this.sinceStepMs;
    this.sinceStepMs = 0;

    const due: PlacementTurn[] = [];
    const standing = new Map<string, Exposure>();
    for (const [key, cell] of this.cells) {
      const weather = weatherOn(cell);
      for (const placed of getStack(map, cell.x, cell.y, cell.z)) {
        if (!reacts(placed, tilesById)) continue;
        const reaction = weatherReactionIn(tilesById[placed.tileId]!, weather);
        const entry = `${key}|${placed.tileId}`;
        if (!reaction || standing.has(entry)) continue;

        const known = this.exposures.get(entry);
        const exposure =
          known?.in === weather
            ? known
            : {
                in: weather,
                leftMs: reaction.fromMs + this.rng.int(reaction.toMs - reaction.fromMs + 1),
              };
        exposure.leftMs -= stepMs;
        if (exposure.leftMs > 0) standing.set(entry, exposure);
        else due.push({ cell, tileId: placed.tileId, into: reaction.tileId });
      }
    }
    this.exposures = standing;
    return due;
  }
}

const NO_TURNS: PlacementTurn[] = [];
