import type { Coord, Direction, MapFile, TileDef } from "../lib/types";
import { canWalk } from "./movement";

export type StepChoice = {
  facing: Direction;
  step: { direction: Direction; to: Coord } | null;
};

export type StepRequest = {
  directions: readonly Direction[];
  faceOnly?: boolean;
  preferDescend?: boolean;
};

export function chooseStep(
  map: MapFile,
  from: Coord & { stackIndex: number },
  request: StepRequest,
  tileDef: TileDef,
  tilesById: Record<string, TileDef>,
  isReserved?: (to: Coord) => boolean,
): StepChoice | null {
  const dirs = request.directions;
  if (dirs.length === 0) return null;

  let facing = dirs[dirs.length - 1]!;

  for (let i = dirs.length - 1; i >= 0; i--) {
    const direction = dirs[i]!;
    facing = direction;

    if (request.faceOnly) return { facing, step: null };

    const check = canWalk(map, from, direction, tileDef, tilesById, {
      preferDescend: request.preferDescend,
    });
    if (!check.ok) continue;
    if (isReserved?.(check.to)) continue;

    return { facing, step: { direction, to: check.to } };
  }

  return { facing, step: null };
}
