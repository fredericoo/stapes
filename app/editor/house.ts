import { getStack, isPlayerBody, setStacks, stackHeight, type StackEdit } from "../lib/mapData";
import type { Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL, MAX_LEVEL, physicalHeight, resolveActor } from "../lib/types";
import { canReplaceStack } from "../lib/validation";
import {
  MAX_FOOTPRINT,
  type Bounds,
  type GeneratedPlan,
  type Rect,
  boundsOf,
  placed,
} from "./generator";

export type RoofOrientation = "vertical" | "horizontal";

export type RoofOrientationSetting = RoofOrientation | "auto";

export function resolveRoofOrientation(
  setting: RoofOrientationSetting,
  width: number,
  depth: number,
): RoofOrientation {
  if (setting !== "auto") return setting;
  return width > depth ? "horizontal" : "vertical";
}

export type RoofColour = "red" | "yellow" | "blue";

export type RoofPitch = "steep" | "low";

export const ROOF_PITCHES: RoofPitch[] = ["steep", "low"];

type RoofTiles = { eaveTileId: string; ridgeTileId: string };

export const ROOF_COLOURS: Record<RoofColour, { label: string } & Record<RoofPitch, RoofTiles>> = {
  red: {
    label: "Red",
    steep: { eaveTileId: "roof-1", ridgeTileId: "roof-3" },
    low: { eaveTileId: "low-roof-red", ridgeTileId: "low-roof-red-ridge" },
  },
  yellow: {
    label: "Yellow",
    steep: { eaveTileId: "roof-2", ridgeTileId: "roof-5" },
    low: { eaveTileId: "low-roof-yellow", ridgeTileId: "low-roof-yellow-ridge" },
  },
  blue: {
    label: "Blue",
    steep: { eaveTileId: "roof-4", ridgeTileId: "roof-6" },
    low: { eaveTileId: "low-roof-blue", ridgeTileId: "low-roof-blue-ridge" },
  },
};

export const ROOF_COLOUR_IDS = Object.keys(ROOF_COLOURS) as RoofColour[];

export const ROOF_FILL_TILE_ID = "plaster";

export type DoorRow = "north" | "centre" | "south";
export type DoorColumn = "west" | "centre" | "east";

export type HouseConfig = {
  generator: "house";
  storeys: number;
  roofOrientation: RoofOrientationSetting;
  roofColour: RoofColour | null;
  roofPitch: RoofPitch;
  wallTileId: string;
  floorTileId: string;
  windowTileId: string | null;
  windowSpacing: number;
  doorTileId: string | null;
  doorRow: DoorRow;
  doorColumn: DoorColumn;
};

export type HousePlan = GeneratedPlan;

export const MIN_FOOTPRINT = 3;

export { MAX_FOOTPRINT } from "./generator";

const DOOR_MIN_FROM_CORNER = 2;
const WINDOW_MIN_FROM_CORNER = 1;
const WINDOW_MIN_FROM_DOOR = 2;

export const WINDOW_SPACING_RANGE = { min: 2, max: 12 } as const;

const ROOF_INSET_PER_LEVEL: Record<RoofPitch, number> = { steep: 1, low: 2 };

export function roofLevelsFor(span: number, pitch: RoofPitch = "steep"): number {
  return Math.max(0, Math.ceil(span / (2 * ROOF_INSET_PER_LEVEL[pitch])));
}

/**
 * `window-1` has two sprites under four names — the north/south pair and the
 * east/west pair — so a wall running east-west shows its south face and one
 * running north-south its east face. That is the convention every window in
 * `data/map.json` is authored with.
 */
function windowDirectionFor(wall: Direction): Direction {
  return wall === "n" || wall === "s" ? "s" : "e";
}

function anchorAlong(
  lo: number,
  hi: number,
  anchor: "low" | "centre" | "high",
  margin: number,
): number | null {
  const first = lo + margin;
  const last = hi - margin;
  if (first > last) return null;
  if (anchor === "low") return first;
  if (anchor === "high") return last;
  const middle = Math.floor((lo + hi) / 2);
  return Math.min(last, Math.max(first, middle));
}

type DoorSpot = { x: number; y: number; wall: Direction };

export function doorSpotFor(bounds: Bounds, row: DoorRow, column: DoorColumn): DoorSpot | null {
  const { minX, maxX, minY, maxY } = bounds;
  const columnAnchor = column === "west" ? "low" : column === "east" ? "high" : "centre";
  const rowAnchor = row === "north" ? "low" : row === "south" ? "high" : "centre";

  if (row === "north" || row === "south") {
    const x = anchorAlong(minX, maxX, columnAnchor, DOOR_MIN_FROM_CORNER);
    if (x == null) return null;
    return row === "north" ? { x, y: minY, wall: "n" } : { x, y: maxY, wall: "s" };
  }

  if (column === "centre") return null;

  const y = anchorAlong(minY, maxY, rowAnchor, DOOR_MIN_FROM_CORNER);
  if (y == null) return null;
  return column === "west" ? { x: minX, y, wall: "w" } : { x: maxX, y, wall: "e" };
}

export function windowsAlong(
  lo: number,
  hi: number,
  blocked: number | null,
  spacing: number,
): number[] {
  const first = lo + WINDOW_MIN_FROM_CORNER;
  const last = hi - WINDOW_MIN_FROM_CORNER;
  if (first > last) return [];

  const step = Math.max(WINDOW_SPACING_RANGE.min, Math.floor(spacing));
  const count = Math.floor((last - first) / step) + 1;
  const slack = last - first - (count - 1) * step;
  const margin = Math.floor(slack / 2);
  const widenedGap = slack - margin * 2;
  const afterMiddle = Math.ceil(count / 2);

  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const at = first + margin + i * step + (i >= afterMiddle ? widenedGap : 0);
    if (blocked != null && Math.abs(at - blocked) < WINDOW_MIN_FROM_DOOR) {
      continue;
    }
    out.push(at);
  }
  return out;
}

function windowCells(
  bounds: Bounds,
  door: DoorSpot | null,
  spacing: number,
): Map<string, Direction> {
  const { minX, maxX, minY, maxY } = bounds;
  const out = new Map<string, Direction>();

  const doorAlong = (wall: Direction): number | null => {
    if (!door || door.wall !== wall) return null;
    return wall === "n" || wall === "s" ? door.x : door.y;
  };

  for (const wall of ["n", "s"] as const) {
    const y = wall === "n" ? minY : maxY;
    for (const x of windowsAlong(minX, maxX, doorAlong(wall), spacing)) {
      out.set(`${x},${y}`, windowDirectionFor(wall));
    }
  }
  for (const wall of ["w", "e"] as const) {
    const x = wall === "w" ? minX : maxX;
    for (const y of windowsAlong(minY, maxY, doorAlong(wall), spacing)) {
      out.set(`${x},${y}`, windowDirectionFor(wall));
    }
  }
  return out;
}

function storeyEdits(
  bounds: Bounds,
  z: number,
  config: HouseConfig,
  tilesById: Record<string, TileDef>,
  door: DoorSpot | null,
  standingOn: (x: number, y: number) => readonly PlacedTile[],
): StackEdit[] {
  const { minX, maxX, minY, maxY } = bounds;
  const windows = config.windowTileId ? windowCells(bounds, door, config.windowSpacing) : new Map();
  const floor = placed(config.floorTileId, tilesById);
  const edits: StackEdit[] = [];

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const under = standingOn(x, y).map((p) => ({ ...p }));
      const onWall = x === minX || x === maxX || y === minY || y === maxY;
      if (!onWall) {
        edits.push({ x, y, z, stack: [...under, { ...floor }] });
        continue;
      }

      if (door && config.doorTileId && door.x === x && door.y === y) {
        edits.push({
          x,
          y,
          z,
          stack: [...under, { ...floor }, placed(config.doorTileId, tilesById, door.wall)],
        });
        continue;
      }

      const windowFace = windows.get(`${x},${y}`);
      const top =
        windowFace && config.windowTileId
          ? placed(config.windowTileId, tilesById, windowFace)
          : placed(config.wallTileId, tilesById);
      edits.push({ x, y, z, stack: [...under, { ...floor }, top] });
    }
  }
  return edits;
}

/**
 * The stack one roof cell holds, `fromEdge` cells in from the nearer eave of a
 * level whose span is `span` cells. A low eave rises two units, so the second
 * cell in stands it on a `plaster` to carry the slope on up to the next level,
 * and a low ridge is one unit on the same pitch.
 */
function roofStack(
  pitch: RoofPitch,
  fromEdge: number,
  span: number,
  eave: PlacedTile,
  ridge: PlacedTile,
): PlacedTile[] {
  const fill = { tileId: ROOF_FILL_TILE_ID };
  const middle = fromEdge * 2 + 1 === span;
  if (pitch === "steep") {
    if (fromEdge > 0) return [{ ...fill }, { ...fill }];
    return [middle ? ridge : eave];
  }
  if (fromEdge > 1) return [{ ...fill }, { ...fill }];
  const top = middle ? ridge : eave;
  return fromEdge === 0 ? [top] : [{ ...fill }, top];
}

function roofEdits(
  bounds: Bounds,
  baseLevel: number,
  config: HouseConfig,
  orientation: RoofOrientation,
  tilesById: Record<string, TileDef>,
): StackEdit[] {
  if (!config.roofColour) return [];

  const { minX, maxX, minY, maxY } = bounds;
  const pitch = config.roofPitch;
  const { eaveTileId, ridgeTileId } = ROOF_COLOURS[config.roofColour][pitch];
  const inset = ROOF_INSET_PER_LEVEL[pitch];
  const vertical = orientation === "vertical";
  const span = vertical ? maxX - minX + 1 : maxY - minY + 1;
  const ridge = placed(ridgeTileId, tilesById, vertical ? "s" : "e");
  const lowEave = placed(eaveTileId, tilesById, vertical ? "e" : "s");
  const highEave = placed(eaveTileId, tilesById, vertical ? "w" : "n");
  const edits: StackEdit[] = [];

  for (let step = 0; step < roofLevelsFor(span, pitch); step++) {
    const z = baseLevel + step;
    const lo = (vertical ? minX : minY) + step * inset;
    const hi = (vertical ? maxX : maxY) - step * inset;
    const acrossLo = vertical ? minY : minX;
    const acrossHi = vertical ? maxY : maxX;

    for (let at = lo; at <= hi; at++) {
      const fromLo = at - lo;
      const fromHi = hi - at;
      const eave = fromLo <= fromHi ? lowEave : highEave;
      const stack = roofStack(pitch, Math.min(fromLo, fromHi), hi - lo + 1, eave, ridge);
      for (let across = acrossLo; across <= acrossHi; across++) {
        const cell = stack.map((p) => ({ ...p }));
        edits.push(
          vertical ? { x: at, y: across, z, stack: cell } : { x: across, y: at, z, stack: cell },
        );
      }
    }
  }
  return edits;
}

function measureSite(
  map: MapFile,
  bounds: Bounds,
  z: number,
  tilesById: Record<string, TileDef>,
): { ok: true; height: number } | { ok: false; reason: string } {
  let height: number | null = null;
  let measuredAt = "";

  for (let y = bounds.minY; y <= bounds.maxY; y++) {
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      const stack = getStack(map, x, y, z);
      for (const p of stack) {
        const def = tilesById[p.tileId];
        if (isPlayerBody(p) || (def && resolveActor(def))) {
          return { ok: false, reason: `Somebody is standing at ${x},${y}` };
        }
      }
      const here = stackHeight(stack, tilesById);
      if (height == null) {
        height = here;
        measuredAt = `${x},${y}`;
        continue;
      }
      if (here !== height) {
        return {
          ok: false,
          reason: `The ground is not level: ${measuredAt} stands ${height} units and ${x},${y} stands ${here}`,
        };
      }
    }
  }
  return { ok: true, height: height ?? 0 };
}

function groundFloorHeight(
  siteHeight: number,
  config: HouseConfig,
  tilesById: Record<string, TileDef>,
): number {
  const heightOf = (id: string) => {
    const def = tilesById[id];
    return def ? physicalHeight(def) : 0;
  };
  return siteHeight + heightOf(config.floorTileId) + heightOf(config.wallTileId);
}

function occupiedAbove(
  map: MapFile,
  edits: readonly StackEdit[],
  groundLevel: number,
): string | null {
  for (const edit of edits) {
    if (edit.z === groundLevel) continue;
    if (getStack(map, edit.x, edit.y, edit.z).length > 0) {
      return `Something is already at ${edit.x},${edit.y} on z${edit.z}`;
    }
  }
  return null;
}

export function planHouse(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  rect: Rect,
  z: number,
  config: HouseConfig,
): HousePlan {
  const bounds = boundsOf(rect);
  const width = bounds.maxX - bounds.minX + 1;
  const depth = bounds.maxY - bounds.minY + 1;

  if (width < MIN_FOOTPRINT || depth < MIN_FOOTPRINT) {
    return {
      ok: false,
      reason: `A house is at least ${MIN_FOOTPRINT}×${MIN_FOOTPRINT} cells`,
    };
  }
  if (width > MAX_FOOTPRINT || depth > MAX_FOOTPRINT) {
    return {
      ok: false,
      reason: `A house is at most ${MAX_FOOTPRINT}×${MAX_FOOTPRINT} cells`,
    };
  }
  if (config.storeys < 1) {
    return { ok: false, reason: "A house has at least one storey" };
  }

  const roofBase = z + config.storeys;
  const orientation = resolveRoofOrientation(config.roofOrientation, width, depth);
  const roofSpan = orientation === "vertical" ? width : depth;
  const topLevel = config.roofColour
    ? roofBase + roofLevelsFor(roofSpan, config.roofPitch) - 1
    : roofBase - 1;
  if (topLevel > MAX_LEVEL) {
    return {
      ok: false,
      reason: `The building would pass z${MAX_LEVEL}`,
    };
  }

  const site = measureSite(map, bounds, z, tilesById);
  if (!site.ok) return site;

  const storeyHeight = groundFloorHeight(site.height, config, tilesById);
  if (storeyHeight > HEIGHT_PER_LEVEL) {
    return {
      ok: false,
      reason: `The site stands ${site.height} units and a storey on it would be ${storeyHeight}, past the ${HEIGHT_PER_LEVEL} a level holds`,
    };
  }

  const door = config.doorTileId ? doorSpotFor(bounds, config.doorRow, config.doorColumn) : null;

  const edits: StackEdit[] = [];
  for (let storey = 0; storey < config.storeys; storey++) {
    edits.push(
      ...storeyEdits(
        bounds,
        z + storey,
        config,
        tilesById,
        storey === 0 ? door : null,
        storey === 0 ? (x, y) => getStack(map, x, y, z) : () => [],
      ),
    );
  }
  edits.push(...roofEdits(bounds, roofBase, config, orientation, tilesById));

  const blocked = occupiedAbove(map, edits, z);
  if (blocked) return { ok: false, reason: blocked };

  const built = setStacks(map, edits);
  for (const edit of edits) {
    const check = canReplaceStack(built, edit.x, edit.y, edit.z, edit.stack, tilesById);
    if (!check.ok) {
      return { ok: false, reason: `${check.reason} at ${edit.x},${edit.y}` };
    }
  }

  return { ok: true, edits };
}
