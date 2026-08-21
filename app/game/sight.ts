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
 * ## You see over anything shorter than you are
 *
 * How tall the thing in the way stands is only half the question; the other half
 * is who is looking over it. A crate is half a level, so a person clears it and
 * a rat does not — and that is not a special case about crates, it is the whole
 * rule. The threshold is the looker's own height, so it falls out of the tile
 * heights an author already sets rather than needing a "blocks sight" flag
 * beside them.
 *
 * It used to be a fixed full level for everybody, which read as blind in one
 * direction and x-ray in the other: a person lost sight of you behind a barrel
 * they could plainly see over, and a snake watched you across a room full of
 * boxes. @see blocksSight
 *
 * The *target's* height is deliberately not in it. What has to clear the
 * obstruction is the looker's eyes, and a rule that also counted the height of
 * whatever is being looked at would let a rat see the top of your head over a
 * wall — which makes "am I hidden" impossible to reason about from the board.
 */

import { stackBlockHeight, stackOcclusion } from "../lib/lighting";
import { getStack } from "../lib/mapData";
import { HEIGHT_PER_LEVEL, type Coord, type MapFile, type TileDef } from "../lib/types";

/**
 * Does this cell stop a look crossing it sideways?
 *
 * Blocking height against the looker's, uncapped on both sides — which is why
 * this reads {@link stackBlockHeight} rather than the opacity beside it. Opacity
 * saturates at a full level, so a wall and a wall with a crate on top are the
 * same number, and the comparison a taller creature needs is gone.
 *
 * Equal heights block. A rat is exactly as tall as the crate in front of it and
 * is looking at the side of it, not over it; the alternative reads as a creature
 * seeing through anything it could just barely stand beside. @see module doc
 */
function blocksSight(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  x: number,
  y: number,
  z: number,
  eyeHeight: number,
): boolean {
  return stackBlockHeight(getStack(map, x, y, z), tilesById) >= eyeHeight;
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
 *
 * ## How tall the looker is
 *
 * `eyeHeight` is the looking body's own height, in the units a tile's `height`
 * is written in — so it is read off the tile rather than authored twice, and a
 * creature drawn shorter is short-sighted over furniture without anybody saying
 * so.
 *
 * It defaults to a full level, which is exactly the rule this had before anybody
 * passed one: every caller whose subject is the player — reaching, shooting,
 * pointing at a thing — is a full level tall, so leaving it off is not a
 * placeholder but the right answer. What changed is that a *brain* now passes
 * its own body's height. @see ../lib/lighting's `stackBlockHeight`
 */
export function hasLineOfSight(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  from: Coord,
  to: Coord,
  eyeHeight: number = HEIGHT_PER_LEVEL,
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

    if (i < steps && blocksSight(map, tilesById, x, y, z, eyeHeight)) {
      return false;
    }
  }
  return true;
}
