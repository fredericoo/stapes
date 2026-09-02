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
 *
 * ## Everything is measured from the bottom of the world
 *
 * Height alone is not enough, because a creature standing on something is
 * looking from further up. Both the obstruction and the looker's eyes are put on
 * one absolute scale — level, plus whatever solid is stacked under them — so
 * what decides a look is the *difference*, and two bodies raised equally see
 * each other exactly as they would on the flat.
 *
 * Measuring the looker's own ground with the same function that measures the
 * obstruction is what makes that hold, and skipping it is a real bug rather than
 * a rounding error: a rat on a half-level floor was blind, because the floor
 * scored its full height as something in the way while the rat's eye was
 * measured from zero. The ground it walked on was taller than it was.
 *
 * A body stands on top of whatever is solid beneath it, and a body is
 * light-passing, so it is not counted in its own column — which is why none of
 * this needs to know where in a stack the body sits.
 */

import { stackBlockHeight, stackOcclusion } from "../lib/lighting";
import { getStack } from "../lib/mapData";
import {
  HEIGHT_PER_LEVEL,
  type Coord,
  type MapFile,
  type TileDef,
} from "../lib/types";

/**
 * How high the solid part of a cell stands, measured from the bottom of the
 * world rather than from the cell's own floor.
 *
 * The level is worth its full {@link HEIGHT_PER_LEVEL} here because that is what
 * a level *is* — the storey above starts a level up whatever is under it — and
 * putting both the obstruction and the looker on one scale is the whole job of
 * this function. Two numbers measured from different floors cannot be compared,
 * and the bug that made this necessary is exactly that comparison.
 *
 * Reads {@link stackBlockHeight} rather than the opacity beside it, because
 * opacity saturates at a full level: a wall and a wall with a crate on top are
 * one number to a lamp, and the difference is the entire question here.
 */
function solidTopAbs(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  x: number,
  y: number,
  z: number,
): number {
  return (
    z * HEIGHT_PER_LEVEL + stackBlockHeight(getStack(map, x, y, z), tilesById)
  );
}

/**
 * Where a body's eyes are, on that same scale.
 *
 * A body stands on top of whatever is solid beneath it, so the ground it is
 * standing on is {@link solidTopAbs} of its own cell — and that works without
 * knowing where in the stack the body sits, because a body is light-passing and
 * therefore is not counted in its own column. Its eyes are its height above
 * that.
 *
 * Measuring the floor with the same function that measures the obstruction is
 * the point. A rat on a half-level floor used to be blind: the floor scored its
 * full height as something in the way while the rat's eye was measured from
 * zero, so the ground it walked on was taller than it was.
 */
function eyeAbs(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  at: Coord,
  eyeHeight: number,
): number {
  return solidTopAbs(map, tilesById, at.x, at.y, at.z) + eyeHeight;
}

/**
 * Does this cell stop a look crossing it sideways?
 *
 * Both sides on one scale, so what decides it is the difference in elevation
 * rather than either number alone: two creatures raised equally see each other
 * exactly as they would on the flat, and a creature standing on a crate really
 * does see over the next crate along.
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
  eyeAt: number,
): boolean {
  const blockH = stackBlockHeight(getStack(map, x, y, z), tilesById);
  // Nothing solid standing here at all, so there is nothing to be behind. The
  // guard is load-bearing rather than an optimisation: without it an *empty*
  // cell reports the floor of its own level as a top, and a look travelling
  // upward through open air is stopped by the air.
  if (blockH === 0) return false;
  return z * HEIGHT_PER_LEVEL + blockH >= eyeAt;
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
 * Crossing between two levels is refused by **the ground over whichever end of
 * the step is lower** — the column the step enters on the way down, the column
 * it leaves on the way up. One slab either way, which is what makes a look
 * reversible: what you can see from the ledge can see you back.
 *
 * Reading it off the column being *entered* regardless of direction, which it
 * did, is a look that climbs being stopped by the floor its own target is
 * standing on. Directly overhead the two readings are the same tile and it went
 * unnoticed; one cell across they are two different tiles, and the wrong one is
 * not in the way at all — it is what holds the target up. That is what made a
 * chest on the ledge beside you unreachable while the one in the cellar under
 * your feet was not.
 *
 * ## The endpoints
 *
 * Never tested sideways. A viewer standing inside their own body would otherwise
 * blind themselves, and a target behind a full-height door they are standing
 * *in* would be invisible while in plain sight.
 *
 * Their *ceilings* are very much tested, and that asymmetry is deliberate. The
 * floor you are standing on is between you and anything below it, including
 * something directly underfoot — the cave in the scenarios is exactly this, and
 * an endpoint rule that skipped it would see straight through the rock. What is
 * never counted is the ground the higher end stands *on*: a body on a ledge is
 * on top of that slab, not behind it.
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
 * so. It is measured from that body's own feet; where those feet are is this
 * function's to work out, from the ground under `from`.
 *
 * It defaults to a full level — the tallest a body can be, and so the most
 * generous eye — which is what the callers that do not have a body to hand pass
 * by omission: reaching, shooting, pointing at a thing. That is a shade taller
 * than the player, who is {@link HEIGHT_PER_LEVEL} less one so that a roof
 * leaves room to stand on a stool, and nothing is authored between the two, so
 * the generosity has nothing to see over that a person could not. What passes a
 * real height is a brain, out of the body it drives.
 * @see ../lib/lighting's `stackBlockHeight`
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

  const eyeAt = eyeAbs(map, tilesById, from, eyeHeight);

  let prevX = from.x;
  let prevY = from.y;
  let prevZ = from.z;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(from.x + dx * t);
    const y = Math.round(from.y + dy * t);
    const z = Math.round(from.z + dz * t);

    // The ground over whichever end of the step is *lower* — see the doc above
    // for why the column that answers depends on which way the look travels.
    const lowerX = z < prevZ ? x : prevX;
    const lowerY = z < prevZ ? y : prevY;
    if (
      z !== prevZ &&
      sealsAgainstVertical(map, tilesById, lowerX, lowerY, Math.max(z, prevZ))
    ) {
      return false;
    }
    prevX = x;
    prevY = y;
    prevZ = z;

    if (i < steps && blocksSight(map, tilesById, x, y, z, eyeAt)) {
      return false;
    }
  }
  return true;
}
