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
export function projectileOctant(flight: ProjectileFlight, to: FlightPoint = flight.to): Octant {
  const { dx, dy } = flightScreenDelta(flight.from, to);
  if (dx === 0 && dy === 0) return "s";

  const index = Math.round(Math.atan2(dx, -dy) / OCTANT_RADIANS);
  // Modulo twice, because a negative angle gives a negative index and JS's `%`
  // keeps the sign — `-2 % 8` is `-2`, which is not an index into anything.
  return OCTANTS[((index % OCTANTS.length) + OCTANTS.length) % OCTANTS.length]!;
}

/**
 * The moments a flight can wear a transition at, which is two of its three.
 *
 * **`hit` is not one of them, and that is the whole shape of the split.** A
 * transition worn by a sprite is a thing done *to* that sprite, and of the
 * sides a landing plays only `disappear` is about the arrow — it is the
 * projectile going. A `hit` is about the blow: it plays on whatever was struck,
 * the arrow is never that, and its plume is thrown into the world by
 * {@link flightEmitter} instead. A dissolve authored on a `hit` has nothing to
 * dissolve, so counting it here would buy a material nothing ever writes to.
 */
const FLIGHT_SIDES = ["appear", "disappear"] as const;

/**
 * Whether this projectile's sides ask anything of its sprite.
 *
 * **The question the renderer asks once per flight**, to decide whether the
 * arrow needs a material of its own. A dissolve and a scale are done *to a
 * sprite*, so only they are counted: a side made purely of particles is thrown
 * into the world by {@link flightEmitter} and asks nothing of the arrow, and a
 * side with a `drop` asks for storeys above a cell that a flight does not
 * stand in. And only the sides the arrow itself wears are asked at all — see
 * {@link FLIGHT_SIDES}.
 */
export function wearsFlightTransition(def: TileDef): boolean {
  return FLIGHT_SIDES.some((side) => {
    const transition = projectileEffect(def, side);
    return Boolean(transition?.dissolve || transition?.scale);
  });
}

/**
 * Where a body is right now, for a shot that is following it.
 *
 * Asked of the caller rather than worked out here, because the finest answer
 * lives at the far end of the frame: `../render/GameRenderer` has every actor's
 * *drawn* position, walk lerp and all, which is smoother than any cell a tick
 * could have committed. Undefined for a body that has gone, and for a flight
 * that never named one.
 */
export type AimAt = (targetId: string) => FlightPoint | undefined;

/**
 * The far end of a flight this frame: where its target is, or where it was
 * aimed.
 *
 * **A shot at somebody who died mid-flight keeps the end it started with**,
 * which is what makes "the arrow still finishes its flight" true rather than
 * merely tolerated — it arrives at where they were standing, and at nobody.
 */
export function aimedAt(flight: ProjectileFlight, aimAt: AimAt | undefined): FlightPoint {
  if (!flight.targetId || !aimAt) return flight.to;
  return aimAt(flight.targetId) ?? flight.to;
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
  /**
   * The side playing on the arrow itself, if one is.
   *
   * Null for most of every flight, and for every projectile that authored no
   * sides at all — which is the case the renderer keeps cheap: no transition
   * means the shared material, and no transition means no per-frame uniform to
   * write. @see `../game/projectile`'s {@link FlightPhase}
   */
  phase: FlightPhase | null;
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
  tilesById: Record<string, TileDef>,
  aimAt?: AimAt,
): ProjectileView[] {
  const views: ProjectileView[] = [];
  for (const flight of flights) {
    // A flight whose tile has gone, or whose tile has stopped being a
    // projectile, is skipped rather than drawn as something else: guessing
    // would put the wrong sprite in the air. Its blow landed regardless — see
    // `../game/projectile`.
    if (!resolveProjectile(tilesById[flight.tileId])) continue;
    const to = aimedAt(flight, aimAt);
    const at = flightPosition(flight, flight.elapsedMs / flight.durationMs, to);
    views.push({
      id: flight.id,
      tileId: flight.tileId,
      // Re-read every frame rather than once, which it used to be: a flight's
      // bearing was fixed because both its ends were, and a shot that follows a
      // stepping target turns as it goes.
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

/**
 * Whether this tile emits at all, memoised per def.
 *
 * {@link tileCanEmitLight} walks every bearing and every frame and allocates as
 * it goes, which is fine once per tile and wasteful once per flight per frame.
 * Keyed on the def object rather than the id, on exactly the terms
 * `../lib/lightingFlood` memoises the same question: an edited catalogue is a
 * new object and simply misses, with the old entry collected behind it.
 */
const canEmitByDef = new WeakMap<TileDef, boolean>();

function canEmit(def: TileDef): boolean {
  let known = canEmitByDef.get(def);
  if (known === undefined) {
    known = tileCanEmitLight(def);
    canEmitByDef.set(def, known);
  }
  return known;
}

/**
 * One flight's light, cast from wherever the arrow is this frame.
 *
 * **A flight falls between the two ways a light gets made, and had neither.**
 * The bake walks placements in the map's stacks and an arrow is never in one;
 * `../render/GameRenderer`'s `emitterOverridesFor` paints one override per
 * *actor* and an arrow is not one either. So a fireball carrying a light lit
 * nothing at all — it was drawn at full brightness, because
 * {@link tileCanEmitLight} makes any emitter `unlit`, and cast nothing on the
 * ground it crossed. The look of a lamp with none of the effect.
 *
 * This is the door a torch in a bag goes through: an {@link EmitterOverride}
 * carrying its own lights, which is what {@link EmitterOverride.lights} means —
 * an emitter that is not on the board and has no cell to be looked up in.
 *
 * **Frame 0's light rather than the live frame's**, on the terms
 * `./WorldRenderer`'s `withFadingLights` takes it: the override list is joined
 * into the overlay's cache key, so a light read off a flickering sprite would
 * add steps of its own to that key and miss the cache on frames the arrow had
 * not even moved through.
 *
 * Null for the overwhelming majority — an arrow, a mote, anything that carries
 * no light — so the common flight costs one memoised lookup and nothing else.
 */
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
    // The logical cell, which is what the overlay marks as self-lit. Floored
    // rather than rounded, because a fractional cell is *in* the cell it is
    // floored into and rounding would claim the one next door for half of it.
    x: Math.floor(at.x),
    y: Math.floor(at.y),
    z: flightLevel(at),
    // The middle of the cell it is over, exactly as {@link flightEmitter}
    // hangs a plume — a flight point names a corner, and a light cast from a
    // corner sits half a cell from where the arrow is drawn.
    fx: at.x + CELL_CENTRE,
    fy: at.y + CELL_CENTRE,
    // In levels, fractional, which is the unit an override's height is in —
    // see `../render/GameRenderer`'s `actorEmitter`. No half-height is added
    // the way a body's is: a flight point is already where its sprite hangs.
    fz: at.elevAbs / HEIGHT_PER_LEVEL,
    lights: [{ ...light, intensity: light.intensity * scale }],
  };
}

/**
 * How much of a flight's light is left, on the shared step grid.
 *
 * Whole while it is crossing, and falling away with the landing it is playing —
 * a flight outlives its own arrival now, and an arrow dissolving to nothing
 * while its light stayed at full strength and then snapped off would be the
 * picture and the lighting telling different stories.
 *
 * Read at the last grid line rather than at the exact moment, which is the trick
 * {@link fadingLightScale} plays for the same reason: the value can only change
 * when the grid does, so a landing arrow — which is parked, and therefore has a
 * position the cache key already agrees with across frames — stops churning that
 * key every frame. A crossing arrow churns it regardless, because it is moving.
 */
function flightLightScale(flight: ProjectileFlight, def: TileDef | undefined): number {
  const phase = flightPhase(flight, def);
  if (!phase || phase.side === "appear") return 1;
  const landed = flight.elapsedMs - flight.durationMs;
  const gridMs = Math.floor(landed / LIGHT_FADE_STEP_MS) * LIGHT_FADE_STEP_MS;
  return Math.max(0, 1 - gridMs / phase.transition.durationMs);
}

/**
 * Where an effect sorts within its level: above anything standing in the cell.
 *
 * The same number an arrow is drawn with — `WorldRenderer`'s own — because what
 * a flight leaves behind belongs exactly where the arrow that left it was, and
 * a second number derived for it would be two answers to one question. Above
 * anything a real stack reaches, since stacks are single digits and the band is
 * 64 wide. @see depthStackBias
 */
const FLIGHT_STACK_BIAS = 32;

/**
 * One of a flight's effects, as an emitter the renderer can hand over.
 *
 * **Stood exactly where the arrow was at that moment** — the same cell, the same
 * absolute height, the same level derived the same way — so sparks coming off a
 * struck body sit in front of it rather than behind.
 *
 * The level comes from the height rather than from either end of the flight, on
 * the terms {@link flightLevel} sets: a shot down a stairwell plays its landing
 * under the lighting of the floor it lands on.
 *
 * Null for an effect with no plume, which is every dissolve and every scale.
 * Those are things done to a *sprite*, and they are not dropped: the arrow
 * itself wears them — see `../game/projectile`'s `flightPhase`, which is why a
 * flight now outlives its own arrival. This is the plume half of the same
 * side, and a transition carrying both plays both.
 *
 * No taper. A taper is a status winding down over seconds; an effect runs for
 * the length its author wrote and then stops being handed over at all.
 */
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
