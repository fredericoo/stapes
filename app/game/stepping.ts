import type { Coord, Direction, MapFile, TileDef } from "../lib/types";
import { canWalk } from "./movement";

/**
 * What a set of held directions resolves to against the board.
 *
 * Facing and stepping are separate answers because they are separately true: a
 * player pressing into a wall still turns to face it. `facing` is therefore
 * always set, and `step` only when one of the held directions was walkable.
 */
export type StepChoice = {
  /** Facing to take, whether or not `step` is possible. */
  facing: Direction;
  /** The step to walk, when one of the held directions was legal. */
  step: { direction: Direction; to: Coord } | null;
};

/** What the player is asking for, from whatever is producing it. */
export type StepRequest = {
  directions: readonly Direction[];
  /** Shift: turn to face, do not walk. */
  faceOnly?: boolean;
  /** Option/Alt: prefer the lowest surface in the climb band. */
  preferDescend?: boolean;
};

/**
 * Pick the step held input asks for, or null when it asks for nothing.
 *
 * The one place the rule lives, because two machines have to agree on it. The
 * simulation runs it to move an actor; the online client runs it to decide what
 * to predict and what to tell the server it did. A client that used a different
 * rule would predict steps the server then refuses, and every disagreement is a
 * visible snap-back.
 *
 * Latest press wins, so the search runs newest-first and takes the first legal
 * direction. Facing follows every direction it *tried*, not only the one that
 * won: pressing into a wall with nothing else held leaves the actor facing the
 * wall, which is the behaviour the walk loop has always had.
 *
 * @param isReserved cells another actor is already walking into. A walk
 *   commits to the map only when it lands, so for the whole step its
 *   destination still reads as empty — the map cannot answer this and the
 *   caller has to.
 */
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
