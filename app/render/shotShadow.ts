import { standingSurfacesBetween } from "../game/movement";
import { CELL_CENTRE, PX_PER_HEIGHT } from "../lib/geometry";
import { footingOfStack, getStack } from "../lib/mapData";
import { CELL_SIZE, HEIGHT_PER_LEVEL, type MapFile, type TileDef } from "../lib/types";

type Point = { x: number; y: number };

/** One end of a shot: the screen point under the body's feet, and the heights of its feet and of the point the line is drawn from. */
export type ShotEnd = { ground: Point; footAbs: number; shotAbs: number };

/**
 * Inverts `baseCellWorldOrigin`: a screen point at a known absolute height is
 * one cell coordinate, offset up and left by `PX_PER_HEIGHT` per unit of height.
 */
function cellOf(screen: number, abs: number): number {
  return (screen + PX_PER_HEIGHT * abs) / CELL_SIZE - CELL_CENTRE;
}

function screenOf(cell: number, abs: number): number {
  return (cell + CELL_CENTRE) * CELL_SIZE - PX_PER_HEIGHT * abs;
}

/**
 * Whether the shot passes inside the solid part of the stack on its own
 * level. Stacks are built up from their level's floor, so a shot below that
 * top is inside it; bodies are left out, so the shooter and the target do not
 * count as something the shot passes through.
 */
function insideSolid(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  x: number,
  y: number,
  shotAbs: number,
): boolean {
  const z = Math.floor(shotAbs / HEIGHT_PER_LEVEL);
  const footing = footingOfStack(getStack(map, x, y, z), tilesById);
  return footing !== null && z * HEIGHT_PER_LEVEL + footing.elev > shotAbs;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Where the shadow of the point a fraction `t` along a shot falls: on the
 * highest standing surface below it, so a shot off a cliff casts its shadow on
 * the cliff top and then on the ground beneath it. A shadow is never above
 * its shot, so where the line passes through a block or a wall the shadow is
 * the dot itself.
 */
export function shotShadow(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  from: ShotEnd,
  to: ShotEnd,
): (t: number) => Point {
  const fromX = cellOf(from.ground.x, from.footAbs);
  const fromY = cellOf(from.ground.y, from.footAbs);
  const toX = cellOf(to.ground.x, to.footAbs);
  const toY = cellOf(to.ground.y, to.footAbs);
  const lowest = Math.min(from.footAbs, to.footAbs) - HEIGHT_PER_LEVEL;
  return (t) => {
    const x = lerp(fromX, toX, t);
    const y = lerp(fromY, toY, t);
    const shotAbs = lerp(from.shotAbs, to.shotAbs, t);
    const cellX = Math.round(x);
    const cellY = Math.round(y);
    let abs = insideSolid(map, tilesById, cellX, cellY, shotAbs) ? shotAbs : -Infinity;
    if (abs === -Infinity) {
      for (const surface of standingSurfacesBetween(
        map,
        cellX,
        cellY,
        lowest,
        shotAbs,
        tilesById,
      )) {
        if (surface.abs > abs) abs = surface.abs;
      }
    }
    if (abs === -Infinity) abs = lerp(from.footAbs, to.footAbs, t);
    return { x: screenOf(x, abs), y: screenOf(y, abs) };
  };
}
