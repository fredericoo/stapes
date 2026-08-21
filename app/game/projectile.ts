/**
 * A thing in the air between the body that loosed it and the body it was aimed
 * at.
 *
 * **Entirely a picture.** Nothing here collides, nothing here can miss, and
 * nothing downstream of it changes a hit point. The whole fight — whether the
 * shot connected, what it took off, whether it killed — was settled on the tick
 * the arrow left the bow, by exactly the same `rollAttack` a fist goes through.
 * What travels is a receipt, arriving late.
 *
 * That is not a corner cut to avoid writing the physics. A blow that lands when
 * the arrow *arrives* is a blow whose outcome depends on a flight, and a flight
 * is drawn on a clock that every client runs slightly differently — so two
 * people watching one fight would disagree about the moment somebody died, and
 * the server would have to hold a shot open across ticks to arbitrate. Damage
 * now and the arrow after is the one arrangement where the picture is allowed to
 * lag the truth and can never contradict it.
 *
 * Two things follow, and both are correct rather than tolerated:
 *
 * - **A shot at somebody who dies before it lands still finishes its flight.**
 *   The arrow was loosed. Deleting it in mid-air would be the picture editing
 *   itself after the fact, and it would look like the shot was never taken.
 * - **A wall that grows between the two ends does not stop it.** Nothing can
 *   grow there in the two hundred milliseconds this takes, and a flight that
 *   re-asked the board every frame would be the collision test this deliberately
 *   does not have.
 *
 * Whether the shot was allowed *at all* is a different question, asked once,
 * before any of this: `./combat`'s `canReach` wants both the reach and a clear
 * line. A wall between you and your target is what stops the bow from firing —
 * not what stops the arrow, because by then there is no arrow.
 */

import { PX_PER_HEIGHT } from "../lib/geometry";
import type { ProjectileDef } from "../lib/item";
import { CELL_SIZE, HEIGHT_PER_LEVEL } from "../lib/types";
import type { ReachPoint } from "./distance";

/**
 * Where a flight starts or ends: a cell on the plan, and an absolute height.
 *
 * The same shape reach is measured in — see `./distance` — because it is
 * measured between the same two points. Fractional on the plan is meaningful and
 * happens: the position part-way through is one of these.
 */
export type FlightPoint = ReachPoint;

/**
 * One projectile, mid-air.
 *
 * Carries where it came from and where it is going rather than a direction and a
 * speed, for the reason a `StrikeState` carries a delta: by the time this is
 * drawn there may be nobody at either end to measure against. It also means the
 * arrow cannot drift — every frame is a fraction of a fixed line, so the last
 * one lands exactly where the blow did however the clock behaved on the way.
 *
 * Aged in place like every other motion, so the same object across two ticks is
 * the same flight and the wire announces it once. See AGENTS.md, "The wire is
 * patches plus motion events".
 */
export type ProjectileFlight = {
  /** Stable for the life of the flight; the renderer's mesh is keyed on it. */
  id: string;
  /**
   * The tile drawn in flight — a `directional8` one, by convention rather than
   * by check. A four-way arrow is not wrong, only blunt: it points at the
   * nearest cardinal instead of where it is actually going. See
   * `../lib/tileResolve`.
   */
  tileId: string;
  from: FlightPoint;
  to: FlightPoint;
  /**
   * How long the whole flight takes, decided once when it is loosed.
   *
   * Stored rather than recomputed from the speed each frame, because the speed
   * lives on a weapon that can be dropped, swapped or unauthored while the arrow
   * is still in the air. What is in flight owes nothing to what fired it.
   */
  durationMs: number;
  elapsedMs: number;
};

/**
 * How far apart two points are on screen, in world pixels.
 *
 * Screen space rather than plan space, and that is what makes a flight time
 * *look* right: a level is drawn as one cell up-left, so a shot at somebody a
 * storey above covers real distance on screen that no plan measure can see, and
 * timing it by cells would make a vertical shot snap across instantly.
 *
 * The same projection `../render/strikeMotion` leans along, for the same reason
 * it does: a height unit shifts a thing on both axes.
 */
export function flightScreenDelta(
  from: FlightPoint,
  to: FlightPoint,
): { dx: number; dy: number } {
  const elevPx = (to.elevAbs - from.elevAbs) * PX_PER_HEIGHT;
  return {
    dx: (to.x - from.x) * CELL_SIZE - elevPx,
    dy: (to.y - from.y) * CELL_SIZE - elevPx,
  };
}

/**
 * How long this shot takes, at this weapon's speed.
 *
 * A distance divided by a speed, so a long shot takes longer than a short one —
 * which is the only thing in the animation carrying any information about how
 * far the arrow went. A fixed duration would draw a six-cell shot and a
 * two-cell shot at wildly different apparent speeds and call them the same
 * weapon.
 *
 * **The distance is in screen pixels and the speed is in cells per second**, so
 * one of them has to be converted and it is the speed — an author reasons in
 * cells, and the projection is the renderer's business. A cell is
 * {@link CELL_SIZE} pixels across, so a cell a second is `CELL_SIZE / 1000`
 * pixels a millisecond.
 *
 * Floored at a single tick. A shot at somebody standing in your own cell has no
 * distance at all, and a duration of zero is a flight that is over before it is
 * drawn — one frame of arrow is a poor picture, and no frames is a shot that
 * silently did not happen.
 */
export function flightDurationMs(
  from: FlightPoint,
  to: FlightPoint,
  projectile: ProjectileDef,
): number {
  const { dx, dy } = flightScreenDelta(from, to);
  const pxPerMs = (projectile.cellsPerSecond * CELL_SIZE) / MS_PER_SECOND;
  return Math.max(MIN_FLIGHT_MS, Math.hypot(dx, dy) / pxPerMs);
}

/** So the conversion above reads as one, rather than as a bare thousand. */
const MS_PER_SECOND = 1000;

/**
 * The shortest a flight may be, in milliseconds.
 *
 * One simulation tick, because that is the finest the world can tell the
 * difference between: anything shorter is loosed and finished inside a single
 * tick, and the client would be handed an arrow that has already landed.
 */
export const MIN_FLIGHT_MS = 1000 / 30;

/** Where the arrow is, as a fraction of the way along. */
export function flightPosition(
  flight: ProjectileFlight,
  progress: number,
): FlightPoint {
  const t = Math.min(1, Math.max(0, progress));
  return {
    x: flight.from.x + (flight.to.x - flight.from.x) * t,
    y: flight.from.y + (flight.to.y - flight.from.y) * t,
    elevAbs:
      flight.from.elevAbs + (flight.to.elevAbs - flight.from.elevAbs) * t,
  };
}

/**
 * Which floor a point in the air belongs to.
 *
 * Derived from the height rather than carried beside it, so the two can never
 * disagree about an arrow crossing a storey mid-flight. A body standing on a
 * level's floor sits exactly on that level's boundary and rounds down onto its
 * own floor, which is the answer everything else in the game gives for the same
 * body.
 *
 * What reads it is the renderer, deciding which level's light an arrow is under
 * and which group it hides with under a roof-cut.
 */
export function flightLevel(point: FlightPoint): number {
  return Math.floor(point.elevAbs / HEIGHT_PER_LEVEL);
}
