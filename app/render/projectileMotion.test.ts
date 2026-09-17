import { describe, expect, it } from "vitest";
import type { FlightEffect, ProjectileFlight } from "../game/projectile";
import { CELL_CENTRE, depthStackBias } from "../lib/geometry";
import { normalizeTileDef, type TileDef } from "../lib/types";
import type { Transition } from "../lib/tileTransition";

import { HEIGHT_PER_LEVEL, type Octant } from "../lib/types";
import {
  flightEmitter,
  projectileOctant,
  projectileViews,
} from "./projectileMotion";

/**
 * Which of the eight ways an arrow points, and where it is while it does.
 *
 * The bearing is the assertion worth having: it is one `atan2` and a rounding,
 * and every way of getting it wrong produces arrows that still fly and still
 * look like arrows — sideways, mirrored, or rotated by one eighth for the whole
 * game. None of that fails anything except the eye.
 */

function shot(dx: number, dy: number, dElev = 0): ProjectileFlight {
  return {
    id: "shot-1",
    tileId: "arrow",
    from: { x: 10, y: 10, elevAbs: 0 },
    to: { x: 10 + dx, y: 10 + dy, elevAbs: dElev },
    durationMs: 200,
    elapsedMs: 0,
    hit: true,
  };
}

/** The one tile every flight here names. @see `../lib/projectile` */
const CATALOGUE: Record<string, TileDef> = {
  arrow: normalizeTileDef({
    id: "arrow",
    name: "Arrow",
    height: 0,
    type: "directional8",
    kind: "projectile",
    interactions: { projectile: { cellsPerSecond: 20 } },
  }),
};

describe("which way an arrow points", () => {
  /** Screen y grows downward, so north is a negative dy. */
  const CARDINALS: Array<[number, number, Octant]> = [
    [0, -4, "n"],
    [4, 0, "e"],
    [0, 4, "s"],
    [-4, 0, "w"],
  ];

  it.each(CARDINALS)("reads (%i, %i) as %s", (dx, dy, want) => {
    expect(projectileOctant(shot(dx, dy))).toBe(want);
  });

  const CORNERS: Array<[number, number, Octant]> = [
    [4, -4, "ne"],
    [4, 4, "se"],
    [-4, 4, "sw"],
    [-4, -4, "nw"],
  ];

  it.each(CORNERS)("reads (%i, %i) as %s", (dx, dy, want) => {
    expect(projectileOctant(shot(dx, dy))).toBe(want);
  });

  /** Each bearing owns a 45° wedge centred on itself, not one starting at it. */
  it("keeps a shot barely off a cardinal on that cardinal", () => {
    expect(projectileOctant(shot(1, -8))).toBe("n");
    expect(projectileOctant(shot(-1, -8))).toBe("n");
  });

  /**
   * **Measured on screen, which is what makes a shot upward point upward.** A
   * level is drawn one cell up-left, so a body directly overhead is north-west
   * of you on the screen even though it is nowhere on the plan.
   */
  it("points up-left at somebody directly overhead", () => {
    expect(projectileOctant(shot(0, 0, HEIGHT_PER_LEVEL))).toBe("nw");
  });

  /** Nowhere to point, and south is what everything else here draws by default. */
  it("answers south for a shot with no bearing at all", () => {
    expect(projectileOctant(shot(0, 0))).toBe("s");
  });
});

describe("the views a frame is drawn from", () => {
  it("carries the position, the bearing and the floor", () => {
    const flight = { ...shot(4, 0), elapsedMs: 100 };
    expect(projectileViews([flight], CATALOGUE)).toEqual([
      { id: "shot-1", tileId: "arrow", direction: "e", x: 12, y: 10, elevAbs: 0, z: 0 },
    ]);
  });

  /**
   * A straight line has one bearing, so it is taken from the whole flight
   * rather than from the step just travelled — otherwise a rounding error near
   * the boundary could flip an arrow between two sprites halfway across.
   */
  it("keeps one bearing for the whole flight", () => {
    const flight = shot(6, -1);
    const bearings = [0, 60, 120, 199].map(
      (elapsedMs) =>
        projectileViews([{ ...flight, elapsedMs }], CATALOGUE)[0]!.direction,
    );
    expect(new Set(bearings).size).toBe(1);
  });

  /**
   * The catalogue is what says which tile a flight is, so an entry that has
   * gone leaves nothing to draw. Guessing a sprite would put the wrong thing in
   * the air; the blow it was a receipt for landed either way.
   */
  it("skips a flight whose tile the catalogue has lost", () => {
    const flight = { ...shot(4, 0), tileId: "ghost-arrow" };
    expect(projectileViews([flight], CATALOGUE)).toEqual([]);
  });

  /** And one whose tile has stopped being a projectile. @see resolveProjectile */
  it("skips a flight whose tile is no longer a projectile", () => {
    const crate = { ...CATALOGUE.arrow!, kind: "prop" as const };
    expect(projectileViews([shot(4, 0)], { arrow: crate })).toEqual([]);
  });
});

/**
 * The plume a flight's effect hangs from.
 *
 * Out here with the rest of the arithmetic for the reason `projectileViews` is:
 * where a burst stands and how it sorts is the whole of the behaviour, and every
 * way of getting it wrong leaves sparks that still look like sparks — behind the
 * body they came off, on the wrong floor, or half a cell from the arrow.
 */
const SPARK: Transition = {
  durationMs: 150,
  particles: {
    ratePerSecond: 60,
    ttlFromMs: 100,
    ttlToMs: 200,
    spawnRadiusCells: 0.2,
    spawnElevFrom: 0,
    spawnElevTo: 2,
    riseFrom: 1,
    riseTo: 4,
    driftCellsPerSecond: 1,
    lit: false,
    gravity: -10,
    windX: 0,
    windY: 0,
    radiusFromPx: 1,
    radiusToPx: 1,
    alphaFrom: 1,
    alphaTo: 0,
    ramp: [{ at: 0, color: "#ffffff" }],
  },
};

function effect(at: { x: number; y: number; elevAbs: number }): FlightEffect {
  return { id: "shot-1:hit", at, transition: SPARK, elapsedMs: 0 };
}

describe("the emitter an effect hangs from", () => {
  it("stands in the middle of the cell the arrow stopped in", () => {
    const spec = flightEmitter(effect({ x: 4, y: 2, elevAbs: 0 }))!;

    expect(spec).toMatchObject({
      id: "shot-1:hit",
      cx: 4 + CELL_CENTRE,
      cy: 2 + CELL_CENTRE,
      footElev: 0,
      config: SPARK.particles,
      taper: 1,
    });
  });

  /** A shot down a stairwell plays where it lands, not where it was loosed. */
  it("takes the level from the height it stopped at", () => {
    expect(flightEmitter(effect({ x: 0, y: 0, elevAbs: 0 }))!.z).toBe(0);
    expect(
      flightEmitter(effect({ x: 0, y: 0, elevAbs: HEIGHT_PER_LEVEL }))!.z,
    ).toBe(1);
  });

  /** In front of the body it came off, never behind it. */
  it("sorts above anything standing in that cell", () => {
    const spec = flightEmitter(effect({ x: 4, y: 2, elevAbs: 0 }))!;
    expect(spec.stackBias).toBeGreaterThan(depthStackBias(0, 8));
  });

  /**
   * A dissolve and a scale are things done to a mesh, and a flight's mesh is
   * not a placement — so an effect with neither a plume nor anything else this
   * side can play hangs nothing at all, rather than an emitter of nothing.
   */
  it("hangs nothing for an effect with no plume", () => {
    const dissolving: FlightEffect = {
      id: "shot-1:disappear",
      at: { x: 1, y: 1, elevAbs: 0 },
      transition: { durationMs: 200, scale: {} },
      elapsedMs: 0,
    };

    expect(flightEmitter(dissolving)).toBeNull();
  });
});
