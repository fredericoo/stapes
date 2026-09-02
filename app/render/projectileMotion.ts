import {
  flightLevel,
  flightPosition,
  flightScreenDelta,
  type ProjectileFlight,
} from "../game/projectile";
import { OCTANTS, type Octant } from "../lib/types";

/**
 * Where an arrow is and which way it is pointing, this frame.
 *
 * Pure, and out here rather than on the renderer for the reason
 * `./strikeMotion` is: the arithmetic is the whole of the behaviour and it wants
 * a test, while the renderer around it wants a canvas.
 *
 * Nothing here decides anything about a fight. A flight is a picture of a blow
 * that was settled the moment it was loosed — see `../game/projectile`, which
 * argues why that is the only arrangement two clients can agree about.
 */

/** How many bearings there are, and therefore how wide one of them is. */
const OCTANT_RADIANS = (Math.PI * 2) / OCTANTS.length;

/**
 * Which of the eight ways a flight is pointing.
 *
 * **Measured on screen rather than on the plan**, which is what makes a shot at
 * somebody a storey up point *up*: a height unit is drawn up-left, so a body
 * directly above you is offset from you on both axes and a shot with no plan
 * delta at all still has a bearing. The same projection `./strikeMotion` leans
 * along, for the same reason.
 *
 * Angles run clockwise from north, which is the order {@link OCTANTS} is written
 * in — `atan2(dx, -dy)` rather than the usual `atan2(dy, dx)` because screen y
 * grows downward and north is the zero. Rounding to the nearest eighth means
 * each bearing owns a 45° wedge centred on itself, so a shot one degree east of
 * north draws as north rather than as something between.
 *
 * A shot with no delta at all — at a body in your own cell, at your own height —
 * has no bearing to report and answers south, on the same grounds a placement
 * with no facing draws south: it is the direction a thing faces when nothing has
 * said otherwise.
 */
export function projectileOctant(flight: ProjectileFlight): Octant {
  const { dx, dy } = flightScreenDelta(flight.from, flight.to);
  if (dx === 0 && dy === 0) return "s";

  const index = Math.round(Math.atan2(dx, -dy) / OCTANT_RADIANS);
  // Modulo twice, because a negative angle gives a negative index and JS's `%`
  // keeps the sign — `-2 % 8` is `-2`, which is not an index into anything.
  return OCTANTS[((index % OCTANTS.length) + OCTANTS.length) % OCTANTS.length]!;
}

/** One arrow, as the renderer is asked to draw it. */
export type ProjectileView = {
  /** Stable per flight; the mesh cache is keyed on it. */
  id: string;
  /** The tile to draw. Resolved against the catalogue by the renderer. */
  tileId: string;
  /** Which of the tile's eight bearings to draw it on. */
  direction: Octant;
  /** Fractional cell on the plan — an arrow is between cells almost always. */
  x: number;
  y: number;
  /** Absolute height in height units, four to a level. */
  elevAbs: number;
  /**
   * The level whose light it takes and whose roof-cut hides it.
   *
   * Derived from the height rather than carried from either end, so an arrow
   * crossing a storey mid-flight changes floors exactly when it passes the
   * boundary — and cannot be under one level's lighting while drawn at another's
   * height. @see `../game/projectile`'s `flightLevel`
   */
  z: number;
};

/**
 * Every arrow in the air, positioned for this frame.
 *
 * The bearing is taken from the whole flight rather than from the step just
 * travelled, and that is not an optimisation: a flight is a straight line, so
 * every step has the same bearing, and measuring it per frame would only invite
 * a rounding error to flip an arrow between two neighbouring sprites halfway
 * across the yard.
 *
 * Nothing is dropped for having arrived. Whoever is aging these — the session on
 * its tick clock, or `RemoteSession` on the render loop's — takes a landed
 * flight off the list, and clamping is `flightPosition`'s job for the frame in
 * between.
 */
export function projectileViews(
  flights: readonly ProjectileFlight[],
): ProjectileView[] {
  return flights.map((flight) => {
    const at = flightPosition(flight, flight.elapsedMs / flight.durationMs);
    return {
      id: flight.id,
      tileId: flight.tileId,
      direction: projectileOctant(flight),
      x: at.x,
      y: at.y,
      elevAbs: at.elevAbs,
      z: flightLevel(at),
    };
  });
}
