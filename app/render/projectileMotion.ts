import {
  type FlightEffect,
  flightLevel,
  type FlightPoint,
  type FlightPhase,
  flightPhase,
  flightPosition,
  flightScreenDelta,
  type ProjectileFlight,
} from "../game/projectile";
import type { EmitterOverride } from "../lib/lighting";
import { resolveLight } from "../lib/tileResolve";
import { LIGHT_FADE_STEP_MS } from "./tileTransitions";
import { CELL_CENTRE, depthBox, depthStackBias } from "../lib/geometry";
import { projectileEffect, resolveProjectile } from "../lib/projectile";
import type { ParticleEmitterSpec } from "./particles";
import {
  HEIGHT_PER_LEVEL,
  OCTANTS,
  type Octant,
  tileCanEmitLight,
  type TileDef,
} from "../lib/types";

const OCTANT_RADIANS = (Math.PI * 2) / OCTANTS.length;

export function projectileOctant(flight: ProjectileFlight, to: FlightPoint = flight.to): Octant {
  const { dx, dy } = flightScreenDelta(flight.from, to);
  if (dx === 0 && dy === 0) return "s";

  const index = Math.round(Math.atan2(dx, -dy) / OCTANT_RADIANS);
  return OCTANTS[((index % OCTANTS.length) + OCTANTS.length) % OCTANTS.length]!;
}

const FLIGHT_SIDES = ["appear", "disappear"] as const;

export function wearsFlightTransition(def: TileDef): boolean {
  return FLIGHT_SIDES.some((side) => {
    const transition = projectileEffect(def, side);
    return Boolean(transition?.dissolve || transition?.scale);
  });
}

export type AimAt = (targetId: string) => FlightPoint | undefined;

export function aimedAt(flight: ProjectileFlight, aimAt: AimAt | undefined): FlightPoint {
  if (!flight.targetId || !aimAt) return flight.to;
  return aimAt(flight.targetId) ?? flight.to;
}

export type ProjectileView = {
  id: string;
  tileId: string;
  direction: Octant;
  x: number;
  y: number;
  elevAbs: number;
  z: number;
  phase: FlightPhase | null;
};

export function projectileViews(
  flights: readonly ProjectileFlight[],
  tilesById: Record<string, TileDef>,
  aimAt?: AimAt,
): ProjectileView[] {
  const views: ProjectileView[] = [];
  for (const flight of flights) {
    if (!resolveProjectile(tilesById[flight.tileId])) continue;
    const to = aimedAt(flight, aimAt);
    const at = flightPosition(flight, flight.elapsedMs / flight.durationMs, to);
    views.push({
      id: flight.id,
      tileId: flight.tileId,
      direction: projectileOctant(flight, to),
      x: at.x,
      y: at.y,
      elevAbs: at.elevAbs,
      z: flightLevel(at),
      phase: flightPhase(flight, tilesById[flight.tileId]),
    });
  }
  return views;
}

const canEmitByDef = new WeakMap<TileDef, boolean>();

function canEmit(def: TileDef): boolean {
  let known = canEmitByDef.get(def);
  if (known === undefined) {
    known = tileCanEmitLight(def);
    canEmitByDef.set(def, known);
  }
  return known;
}

export function flightLight(
  flight: ProjectileFlight,
  def: TileDef | undefined,
  aimAt?: AimAt,
): EmitterOverride | null {
  if (!def || !canEmit(def)) return null;
  const light = resolveLight(def, {}, 0);
  if (!light) return null;
  const scale = flightLightScale(flight, def);
  if (scale <= 0) return null;

  const at = flightPosition(flight, flight.elapsedMs / flight.durationMs, aimedAt(flight, aimAt));
  return {
    x: Math.floor(at.x),
    y: Math.floor(at.y),
    z: flightLevel(at),
    fx: at.x + CELL_CENTRE,
    fy: at.y + CELL_CENTRE,
    fz: at.elevAbs / HEIGHT_PER_LEVEL,
    lights: [{ ...light, intensity: light.intensity * scale }],
  };
}

function flightLightScale(flight: ProjectileFlight, def: TileDef | undefined): number {
  const phase = flightPhase(flight, def);
  if (!phase || phase.side === "appear") return 1;
  const landed = flight.elapsedMs - flight.durationMs;
  const gridMs = Math.floor(landed / LIGHT_FADE_STEP_MS) * LIGHT_FADE_STEP_MS;
  return Math.max(0, 1 - gridMs / phase.transition.durationMs);
}

const FLIGHT_STACK_BIAS = 32;

export function flightEmitter(effect: FlightEffect): ParticleEmitterSpec | null {
  const particles = effect.transition.particles;
  if (!particles) return null;
  const { x, y, elevAbs } = effect.at;
  const z = flightLevel(effect.at);
  return {
    id: effect.id,
    config: particles,
    cx: x + CELL_CENTRE,
    cy: y + CELL_CENTRE,
    footElev: elevAbs,
    z,
    box: depthBox(x, y, elevAbs, elevAbs + HEIGHT_PER_LEVEL),
    stackBias: depthStackBias(z, FLIGHT_STACK_BIAS),
    taper: 1,
  };
}
