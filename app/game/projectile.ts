import { PX_PER_HEIGHT } from "../lib/geometry";
import { type ProjectileBlock, projectileEffect, type ProjectileSide } from "../lib/projectile";
import { shownFraction, type Transition } from "../lib/tileTransition";
import { CELL_SIZE, HEIGHT_PER_LEVEL, type TileDef } from "../lib/types";
import type { ReachPoint } from "./distance";

export type FlightPoint = ReachPoint;

export type ProjectileFlight = {
  id: string;
  tileId: string;
  from: FlightPoint;
  to: FlightPoint;
  targetId?: string;
  durationMs: number;
  elapsedMs: number;
  hit: boolean;
};

export type FlightEffect = {
  id: string;
  at: FlightPoint;
  transition: Transition;
  elapsedMs: number;
};

/**
 * `elevPx` is subtracted from both axes because the world is drawn in
 * oblique cabinet projection, where a height unit shifts a sprite on both
 * the x and y axes of the screen rather than only upward.
 */
export function flightScreenDelta(from: FlightPoint, to: FlightPoint): { dx: number; dy: number } {
  const elevPx = (to.elevAbs - from.elevAbs) * PX_PER_HEIGHT;
  return {
    dx: (to.x - from.x) * CELL_SIZE - elevPx,
    dy: (to.y - from.y) * CELL_SIZE - elevPx,
  };
}

export function flightDurationMs(
  from: FlightPoint,
  to: FlightPoint,
  projectile: ProjectileBlock,
): number {
  const { dx, dy } = flightScreenDelta(from, to);
  const pxPerMs = (projectile.cellsPerSecond * CELL_SIZE) / MS_PER_SECOND;
  return Math.max(MIN_FLIGHT_MS, Math.hypot(dx, dy) / pxPerMs);
}

const MS_PER_SECOND = 1000;

export const MIN_FLIGHT_MS = 1000 / 30;

export const FLIGHT_BODY_SHARE = 0.5;

export function flightElevation(footElevAbs: number, bodyHeight: number): number {
  return footElevAbs + bodyHeight * FLIGHT_BODY_SHARE;
}

export function flightPosition(
  flight: ProjectileFlight,
  progress: number,
  to: FlightPoint = flight.to,
): FlightPoint {
  const t = Math.min(1, Math.max(0, progress));
  return {
    x: flight.from.x + (to.x - flight.from.x) * t,
    y: flight.from.y + (to.y - flight.from.y) * t,
    elevAbs: flight.from.elevAbs + (to.elevAbs - flight.from.elevAbs) * t,
  };
}

export function flightLevel(point: FlightPoint): number {
  return Math.floor(point.elevAbs / HEIGHT_PER_LEVEL);
}

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

export type FlightPhase = {
  side: ProjectileSide;
  transition: Transition;
  shown: number;
};

export function flightLifetimeMs(flight: ProjectileFlight, def: TileDef | undefined): number {
  /**
   * `disappear`, never `hit`: `disappear` is the transition that plays on the
   * arrow itself, while `hit` plays on whatever the arrow struck.
   */
  const going = projectileEffect(def, "disappear");
  return flight.durationMs + (going?.durationMs ?? 0);
}

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

  const going = projectileEffect(def, "disappear");
  if (!going || flight.elapsedMs < flight.durationMs) return null;
  return {
    side: "disappear",
    transition: going,
    shown: shownFraction("disappear", flight.elapsedMs - flight.durationMs, going.durationMs),
  };
}

export function ageFlights(
  flights: ProjectileFlight[],
  dtMs: number,
  tilesById: Record<string, TileDef>,
  into: FlightEffect[],
): ProjectileFlight[] {
  let done = false;
  for (const flight of flights) {
    const def = tilesById[flight.tileId];
    const wasFlying = flight.elapsedMs < flight.durationMs;
    flight.elapsedMs += dtMs;
    if (wasFlying && flight.elapsedMs >= flight.durationMs) {
      beginEffect(flight, "disappear", flight.to, def, into);
    }
    if (flight.elapsedMs >= flightLifetimeMs(flight, def)) done = true;
  }
  if (!done) return flights;
  return flights.filter(
    (flight) => flight.elapsedMs < flightLifetimeMs(flight, tilesById[flight.tileId]),
  );
}

export function ageEffects(effects: FlightEffect[], dtMs: number): FlightEffect[] {
  let expired = false;
  for (const effect of effects) {
    effect.elapsedMs += dtMs;
    if (effect.elapsedMs >= effect.transition.durationMs) expired = true;
  }
  if (!expired) return effects;
  return effects.filter((effect) => effect.elapsedMs < effect.transition.durationMs);
}
