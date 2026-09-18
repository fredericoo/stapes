/**
 * A thing in the air between the body that loosed it and the body it was aimed
 * at.
 *
 * **Entirely a picture.** Nothing here collides, nothing here can miss, and
 * nothing in this file changes a hit point. The whole fight — whether the shot
 * connected, what it took off, whether it killed — was settled on the tick the
 * arrow left the bow, by exactly the same `rollAttack` a fist goes through.
 *
 * That is not a corner cut to avoid writing the physics. A blow whose *outcome*
 * is decided when the arrow arrives is an outcome that depends on a flight, and
 * a flight is drawn on a clock that every client runs slightly differently — so
 * two people watching one fight would disagree about the moment somebody died.
 * The dice are read once, on the server, on the tick the string is let go.
 *
 * **What the flight does buy is the moment.** How long a shot takes is how long
 * its blow waits: {@link flightDurationMs} is the countdown
 * `GameSession.blowsInFlight` holds the settled blow on, so the health comes off
 * and the receipt floats when the arrow gets there, and a slow projectile hurts
 * later than a fast one. That is not the same thing as deciding the outcome
 * late — the picture may lag the truth, and still cannot contradict it. Nothing
 * here does the holding; this file only says how long.
 *
 * Two things follow, and both are correct rather than tolerated:
 *
 * - **A shot at somebody who dies before it lands still finishes its flight**,
 *   and arrives at nobody. The arrow was loosed. Deleting it in mid-air would be
 *   the picture editing itself after the fact, and it would look like the shot
 *   was never taken.
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
import {
  landingPlays,
  type ProjectileBlock,
  projectileEffect,
  type ProjectileSide,
} from "../lib/projectile";
import { shownFraction, type Transition } from "../lib/tileTransition";
import { CELL_SIZE, HEIGHT_PER_LEVEL, type TileDef } from "../lib/types";
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
 * the same flight and the wire announces it once. See docs/notes.md, "The wire
 * is patches plus motion events".
 */
export type ProjectileFlight = {
  /** Stable for the life of the flight; the renderer's mesh is keyed on it. */
  id: string;
  /**
   * Which projectile this is — the id of a `projectile` tile.
   *
   * An id and not the block itself, unlike the two endpoints below, and the
   * difference is what a catalogue *is*: both ends of the wire hold the same
   * tiles, resolved once per load, so naming one says everything the whole
   * entry would and cannot go stale against it. The endpoints are readings of a
   * board that is about to move, which is why those are copied.
   *
   * An id the catalogue has lost, or one that names something which is not a
   * projectile, draws nothing and plays nothing — see `../lib/projectile`.
   */
  tileId: string;
  from: FlightPoint;
  to: FlightPoint;
  /**
   * How long the whole flight takes, decided once when it is loosed.
   *
   * Stored rather than recomputed per frame, because a flight has to keep its
   * own answer: it is the one number every frame of the drawing is a fraction
   * of, and re-deriving it from a tile an editor can change mid-flight would
   * make the arrow jump.
   */
  durationMs: number;
  elapsedMs: number;
  /**
   * Whether the blow this is a receipt for connected.
   *
   * **The one thing a flight is told about the fight it came out of**, and it
   * buys exactly one thing: which side plays where it lands — see
   * `../lib/projectile`'s {@link ProjectileSide}. The flight is drawn
   * identically either way, because the arrow was loosed either way.
   *
   * Decided by whoever fired it, never here: only they have read the dice, and
   * a bolt has no dice to read.
   */
  hit: boolean;
};

/**
 * One of a flight's three effects, playing on the board.
 *
 * **Its own thing rather than a phase of the flight**, because the two are over
 * at different moments: an arrow is a sprite following a line and is gone the
 * instant it arrives, and what it leaves behind stands still and keeps emitting
 * for the length its author wrote. Keeping the landed flight around instead
 * would park an arrow on its target for the length of the spray.
 *
 * Client-side and amnesiac on exactly the terms every other particle is — see
 * `../lib/particleVfx`. Nothing downstream of one changes a hit point.
 */
export type FlightEffect = {
  /** `${flight.id}:${side}`, so a plume is as unique as the moment that threw it. */
  id: string;
  /** Where it plays: the near end of the flight, or the far one. */
  at: FlightPoint;
  transition: Transition;
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
  projectile: ProjectileBlock,
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

/**
 * How far up a body a flight leaves from and lands on, as a share of its height.
 *
 * **A flight used to run foot to foot**, because both ends came straight from
 * `GameSession.reachPointOf` — which answers the surface a body is *standing
 * on*, and is exactly right for measuring reach. Drawn, it put the arrow on the
 * floor: at the bottom of a three-high player sprite, at ground level, with a
 * depth box the same zero thickness as the tile it was crossing. The shot was
 * cut and revealed by every tuft and step it passed over, which reads as a
 * bolt bobbing over the terrain rather than flying across it.
 *
 * Half, so the line is drawn between the two bodies' middles: the chest of a
 * player, the flank of a rat. Both ends take the same share, which is what
 * keeps a shot across flat ground level — a launch height that came from the
 * shooter alone would tilt every shot by the difference between the two bodies.
 *
 * **The picture only.** Reach is still measured foot to foot, because how far
 * you can hit is a fact about where the two of you are standing and not about
 * how tall you are — see `GameSession.reachPointOf`, which this never touches.
 */
export const FLIGHT_BODY_SHARE = 0.5;

/**
 * Where on a body a flight starts or ends, given the surface it stands on.
 *
 * @see FLIGHT_BODY_SHARE
 */
export function flightElevation(footElevAbs: number, bodyHeight: number): number {
  return footElevAbs + bodyHeight * FLIGHT_BODY_SHARE;
}

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

/**
 * Start one of a flight's effects, if the projectile authored that side.
 *
 * Silently nothing for a side nobody wrote, and for an id the catalogue has
 * lost — which between them are the overwhelming majority and are not a case
 * anybody had to write: there is simply nothing to play.
 *
 * The point is copied rather than shared with the flight, because an effect
 * outlives the flight that threw it and nothing that outlives its source should
 * hold a reference into it.
 */
export function beginEffect(
  flight: ProjectileFlight,
  side: ProjectileSide,
  at: FlightPoint,
  def: TileDef | undefined,
  into: FlightEffect[],
) {
  const transition = projectileEffect(def, side);
  if (!transition) return;
  into.push({
    id: `${flight.id}:${side}`,
    at: { x: at.x, y: at.y, elevAbs: at.elevAbs },
    transition,
    elapsedMs: 0,
  });
}

/**
 * Which of a flight's sides is playing right now, and how much of the sprite it
 * is showing.
 *
 * **The half a plume cannot carry.** A flight's three sides have always been
 * handed to `../render/projectileMotion`'s `flightEmitter`, which turns a
 * transition into particles and answers null for anything else — so a dissolve
 * or a scale authored on a projectile played silently nowhere. Particles are a
 * thing thrown *into* a cell and a dissolve is a thing done *to a sprite*, and
 * the only sprite a flight has is the arrow itself.
 *
 * So the arrow wears them. An `appear` runs over the first stretch of the
 * flight, which is the projectile forming as it is loosed; a landing runs after
 * it arrives, on the arrow parked where it stopped — see
 * {@link flightLifetimeMs}, which is why a flight now outlives its own arrival.
 *
 * Null between the two, which is most of every flight: an arrow in the middle
 * of its crossing is simply an arrow.
 */
export type FlightPhase = {
  side: ProjectileSide;
  transition: Transition;
  /** 1 is the whole sprite, 0 is none of it. @see shownFraction */
  shown: number;
};

/**
 * How long a flight is drawn for, which is longer than it is in the air.
 *
 * The crossing plus whatever its landing side runs for, because the landing is
 * played on the arrow itself and an arrow disposed of on arrival has nothing
 * left to dissolve. A projectile with no landing side — the overwhelming
 * majority — has a lifetime of exactly its crossing, so nothing that was drawn
 * before this existed is drawn for a frame longer.
 *
 * **Not the number a blow waits on.** That is {@link flightDurationMs}, the
 * crossing alone — `GameSession.blowsInFlight` holds the settled blow on it, so
 * the health comes off the moment the arrow arrives. What this adds is the
 * stretch *after* that, in which the arrow is parked where it stopped and
 * dissolving: the target has already been hit, and what is left on screen is
 * the shot going rather than the shot landing. Two numbers, and reading the
 * longer one as the blow's would make a slow dissolve into a delayed hit.
 */
export function flightLifetimeMs(
  flight: ProjectileFlight,
  def: TileDef | undefined,
): number {
  // `disappear` and never the landing's other side, because this is the life of
  // the *arrow*: `disappear` is the one that plays on it, and a `hit` is thrown
  // at the point it stopped and ages on its own — see {@link flightPhase}. A
  // long hit and no disappear at all would otherwise hold a sprite on screen
  // with nothing happening to it.
  const going = projectileEffect(def, "disappear");
  return flight.durationMs + (going?.durationMs ?? 0);
}

/** @see FlightPhase */
export function flightPhase(
  flight: ProjectileFlight,
  def: TileDef | undefined,
): FlightPhase | null {
  const arriving = projectileEffect(def, "appear");
  if (arriving && flight.elapsedMs < arriving.durationMs) {
    return {
      side: "appear",
      transition: arriving,
      shown: shownFraction("appear", flight.elapsedMs, arriving.durationMs),
    };
  }

  // **`disappear` and never `hit`**, of the two a landing plays. A transition
  // worn by a sprite is a thing done *to* that sprite, and of the two only
  // `disappear` is about the arrow: it is the projectile going. A `hit` is
  // about the blow, it plays on whatever was struck, and the arrow is never
  // that — which is what `../components/ProjectileTab` has always said about
  // it. Its plume is thrown at the point the shot stopped and ages on its own.
  const going = projectileEffect(def, "disappear");
  if (!going || flight.elapsedMs < flight.durationMs) return null;
  return {
    side: "disappear",
    transition: going,
    shown: shownFraction(
      "disappear",
      flight.elapsedMs - flight.durationMs,
      going.durationMs,
    ),
  };
}

/**
 * Wind every flight forward, and start what the landings owe.
 *
 * Shared by the two things that age flights — the simulation on its tick clock
 * and `../net/RemoteSession` on the render loop's — because the rule that a
 * landing plays a side is one rule, and written twice it is one rule that can
 * disagree with itself. The clocks differ and that is fine: a flight is a
 * fraction of a fixed line either way.
 *
 * Mutates each flight's elapsed time in place, on the terms every other motion
 * here is aged, and hands back the list of those still in the air — **the same
 * array when nothing landed**, so the common frame allocates nothing.
 */
export function ageFlights(
  flights: ProjectileFlight[],
  dtMs: number,
  tilesById: Record<string, TileDef>,
  into: FlightEffect[],
): ProjectileFlight[] {
  let done = false;
  for (const flight of flights) {
    const def = tilesById[flight.tileId];
    // Read before the clock moves, so the crossing is detected as a *crossing*
    // rather than as "already arrived" — which is what keeps the landing's
    // plume thrown exactly once now that a flight outlives its own arrival.
    const wasFlying = flight.elapsedMs < flight.durationMs;
    flight.elapsedMs += dtMs;
    if (wasFlying && flight.elapsedMs >= flight.durationMs) {
      // Both sides of the landing, in order — see `../lib/projectile`'s
      // {@link landingPlays}. A projectile that authored only one of them
      // begins only that one, because `beginEffect` is silently nothing for a
      // side nobody wrote.
      for (const side of landingPlays(flight.hit)) {
        beginEffect(flight, side, flight.to, def, into);
      }
    }
    if (flight.elapsedMs >= flightLifetimeMs(flight, def)) done = true;
  }
  if (!done) return flights;
  return flights.filter(
    (flight) =>
      flight.elapsedMs < flightLifetimeMs(flight, tilesById[flight.tileId]),
  );
}

/**
 * Wind the effects forward, and drop the ones that have finished.
 *
 * Dropped rather than faded: the particle system retires an emitter it stops
 * being handed and lets its live sparks finish, so an effect that leaves this
 * list is still on screen for as long as its longest particle lives. Fading it
 * out here as well would be the same taper applied twice.
 *
 * Returns the same array when nothing expired, on the terms {@link ageFlights}
 * does.
 */
export function ageEffects(
  effects: FlightEffect[],
  dtMs: number,
): FlightEffect[] {
  let expired = false;
  for (const effect of effects) {
    effect.elapsedMs += dtMs;
    if (effect.elapsedMs >= effect.transition.durationMs) expired = true;
  }
  if (!expired) return effects;
  return effects.filter(
    (effect) => effect.elapsedMs < effect.transition.durationMs,
  );
}
