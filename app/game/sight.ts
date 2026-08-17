/**
 * Whether one cell can see another.
 *
 * Kept out of the session for the same reason `affordances` is: this is a pure
 * question about a board, asked by a brain condition today and by anything else
 * that needs it tomorrow. Nothing here knows what a creature is.
 *
 * ## Sight is light
 *
 * A cell blocks sight when it blocks light outright — {@link stackOcclusion}'s
 * own answer, reused rather than reinvented. That single decision buys the
 * behaviour an author would otherwise have to be told about: a window is glass,
 * so it is see-through; water is light-passing, so you can see across a pond;
 * and a wall is a wall.
 *
 * `opacity >= 1` rather than `> 0` is the other half of it. Opacity is blocking
 * height over {@link HEIGHT_PER_LEVEL}, so a floor scores 0 and a crate scores a
 * half — which means **you can see over anything shorter than a full level**.
 * A creature that lost sight of somebody behind a barrel would read as blind
 * rather than as careful.
 */

import { stackOcclusion } from "../lib/lighting";
import { getStack } from "../lib/mapData";
import type { Coord, MapFile, TileDef } from "../lib/types";

/** Does this cell stop a look crossing it sideways? @see module doc */
function blocksSight(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  x: number,
  y: number,
  z: number,
): boolean {
  return stackOcclusion(getStack(map, x, y, z), tilesById).opacity >= 1;
}

/**
 * Does this cell's ground stop a look passing *through* it, up or down?
 *
 * The other half of {@link stackOcclusion}, and it has to be a separate question
 * because the two disagree on the tile that matters most. A floor is height
 * zero, so it blocks no light sideways and scores no opacity at all — correct
 * for a lamp in the room, and hopeless for a look travelling vertically, which
 * it stops completely. `sealsLevel` is the flag that already says "something
 * solid is here" regardless of how tall it is.
 *
 * Glass and water are light-passing and so seal nothing, which is what lets a
 * creature watch you through a skylight or across the bottom of a pond.
 */
function sealsAgainstVertical(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  x: number,
  y: number,
  z: number,
): boolean {
  return stackOcclusion(getStack(map, x, y, z), tilesById).sealsLevel;
}

/**
 * Is the path from `from` to `to` unobstructed?
 *
 * **Geometry only.** Whether a particular creature would *bother* looking that
 * far, or that far up, is a fact about the creature and is asked separately —
 * see `BattlerDef.sight`. This answers the question the world can answer: is
 * there anything in the way.
 *
 * ## Two ways to be blocked
 *
 * A look is stopped sideways by a full-height wall and vertically by a floor,
 * and those are genuinely different tests on genuinely different fields — see
 * {@link blocksSight} and {@link sealsAgainstVertical}. The vertical one is the
 * half that used to be missing, and its absence is why this could not be trusted
 * across levels at all: with only the sideways test, a creature in a sealed
 * basement is in plain view of the sky.
 *
 * Crossing between two levels is refused by the *upper* cell's ground, whichever
 * way the look is travelling — the floor of the room above is the ceiling of the
 * room below, and it is one tile doing both jobs.
 *
 * ## The endpoints
 *
 * Never tested sideways. A viewer standing inside their own body would otherwise
 * blind themselves, and a target behind a full-height door they are standing
 * *in* would be invisible while in plain sight.
 *
 * They are very much tested vertically, and that asymmetry is deliberate. The
 * floor you are standing on is between you and anything below it, including
 * something directly underfoot — the cave in the scenarios is exactly this, and
 * an endpoint rule that skipped it would see straight through the rock.
 *
 * ## Sampling
 *
 * One sample per step of the longest axis, each rounded to a cell. That is not a
 * supercover walk, and the difference is one authored case — a perfect diagonal
 * gap between two wall corners reads as visible here, where a stricter sweep
 * would close it. For a creature deciding whether it noticed you, being generous
 * at the corner is the better failure.
 */
export function hasLineOfSight(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  from: Coord,
  to: Coord,
): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  // The same cell: there is nothing in between to be in the way.
  if (steps === 0) return true;

  let prevZ = from.z;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(from.x + dx * t);
    const y = Math.round(from.y + dy * t);
    const z = Math.round(from.z + dz * t);

    if (
      z !== prevZ &&
      sealsAgainstVertical(map, tilesById, x, y, Math.max(z, prevZ))
    ) {
      return false;
    }
    prevZ = z;

    if (i < steps && blocksSight(map, tilesById, x, y, z)) return false;
  }
  return true;
}
