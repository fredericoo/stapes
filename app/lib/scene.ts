import { emptyMap, replaceStack } from "./mapData";
import { DIRECTIONS, type Direction, type MapFile, type PlacedTile, type TileDef } from "./types";

export type ScenePlacement = string | { tile: string; facing?: Direction; variant?: string };

export type SceneCells =
  | { at: [number, number] | [number, number, number]; tiles: ScenePlacement[] }
  | { from: [number, number]; to: [number, number]; z?: number; tiles: ScenePlacement[] };

/**
 * A few cells of map, written by hand, for the scene page to draw with the real
 * renderer and no game behind it. Later entries replace the stacks of earlier
 * ones, so a scene fills the ground first and places things on it after.
 */
export type Scene = {
  cells: SceneCells[];
  /** "hh:mm"; noon when absent. */
  time?: string;
  /** Screen pixels per art pixel. */
  zoom?: number;
  /** The cell drawn at the centre of the view; the middle of the scene when absent. */
  look?: [number, number] | [number, number, number];
  lighting?: boolean;
  /** Milliseconds the animation clock has run before the shot; zero when absent. */
  clockMs?: number;
};

export type BuiltScene = {
  map: MapFile;
  minutesOfDay: number;
  zoom: number;
  look: { x: number; y: number; z: number };
  lighting: boolean;
  clockMs: number;
};

export const DEFAULT_SCENE_ZOOM = 6;
const NOON = 12 * 60;
const TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;

export function buildScene(scene: Scene, tilesById: Record<string, TileDef>): BuiltScene {
  if (!Array.isArray(scene.cells) || scene.cells.length === 0) {
    throw new Error("A scene needs at least one entry in `cells`");
  }

  let map = emptyMap();
  const xs: number[] = [];
  const ys: number[] = [];
  let lowestZ = Infinity;

  for (const entry of scene.cells) {
    const stack = entry.tiles.map((placement) => placed(placement, tilesById));
    for (const [x, y, z] of cellsOf(entry)) {
      map = replaceStack(map, x, y, z, stack);
      xs.push(x);
      ys.push(y);
      lowestZ = Math.min(lowestZ, z);
    }
  }

  const middle = (values: number[]) => Math.floor((Math.min(...values) + Math.max(...values)) / 2);
  const look = scene.look
    ? { x: scene.look[0], y: scene.look[1], z: scene.look[2] ?? 0 }
    : { x: middle(xs), y: middle(ys), z: lowestZ };

  return {
    map,
    minutesOfDay: scene.time === undefined ? NOON : minutesOf(scene.time),
    zoom: scene.zoom ?? DEFAULT_SCENE_ZOOM,
    look,
    lighting: scene.lighting ?? true,
    clockMs: scene.clockMs ?? 0,
  };
}

function cellsOf(entry: SceneCells): [number, number, number][] {
  if ("at" in entry) {
    const [x, y, z = 0] = entry.at;
    return [[x, y, z]];
  }
  const [x0, y0] = entry.from;
  const [x1, y1] = entry.to;
  const cells: [number, number, number][] = [];
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) cells.push([x, y, entry.z ?? 0]);
  }
  return cells;
}

function placed(placement: ScenePlacement, tilesById: Record<string, TileDef>): PlacedTile {
  const spec = typeof placement === "string" ? { tile: placement } : placement;
  if (!tilesById[spec.tile]) throw new Error(`No tile called "${spec.tile}"`);
  if (spec.facing !== undefined && !DIRECTIONS.includes(spec.facing)) {
    throw new Error(`"${spec.facing}" is not a facing. Use one of ${DIRECTIONS.join(", ")}`);
  }
  return {
    tileId: spec.tile,
    ...(spec.facing ? { direction: spec.facing } : {}),
    ...(spec.variant ? { variant: spec.variant } : {}),
  };
}

function minutesOf(time: string): number {
  const match = TIME_PATTERN.exec(time);
  const hours = match ? Number(match[1]) : Number.NaN;
  const minutes = match ? Number(match[2]) : Number.NaN;
  if (!(hours < 24 && minutes < 60)) {
    throw new Error(`"${time}" is not a time. Write it like 18:00`);
  }
  return hours * 60 + minutes;
}
