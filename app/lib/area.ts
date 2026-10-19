export const AREA_SHAPES = ["circle", "square", "cross", "diagonal-cross"] as const;

export type AreaShape = (typeof AREA_SHAPES)[number];

export const AREA_SUBJECTS = ["others", "self", "both"] as const;

export type AreaSubject = (typeof AREA_SUBJECTS)[number];

export const MIN_AREA_RADIUS = 1;
export const MAX_AREA_RADIUS = 8;

export type AreaOffset = { dx: number; dy: number };

/**
 * `r(r+1)` rather than `r²` for the circle: it lies halfway between two
 * squares, so the disc takes in the cells its rim only grazes and comes out
 * round instead of diamond-shaped, the same reason `MELEE_REACH` is 1.5.
 */
export function inAreaShape(shape: AreaShape, radius: number, dx: number, dy: number): boolean {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax > radius || ay > radius) return false;
  if (shape === "square") return true;
  if (shape === "cross") return ax === 0 || ay === 0;
  if (shape === "diagonal-cross") return ax === ay;
  return ax * ax + ay * ay <= radius * (radius + 1);
}

export function areaOffsets(shape: AreaShape, radius: number): AreaOffset[] {
  const out: AreaOffset[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (inAreaShape(shape, radius, dx, dy)) out.push({ dx, dy });
    }
  }
  return out;
}

export function affectsBody(affects: AreaSubject, isCaster: boolean): boolean {
  if (affects === "both") return true;
  return (affects === "self") === isCaster;
}
