import { describe, expect, it } from "vitest";
import type { ProjectileBlock } from "../lib/projectile";
import { CELL_SIZE, HEIGHT_PER_LEVEL } from "../lib/types";
import {
  ageEffects,
  ageFlights,
  beginEffect,
  type FlightEffect,
  flightDurationMs,
  flightLevel,
  flightLifetimeMs,
  flightPhase,
  flightPosition,
  flightScreenDelta,
  MIN_FLIGHT_MS,
  type ProjectileFlight,
} from "./projectile";
import type { Transition } from "../lib/tileTransition";
import { normalizeTileDef, type TileDef } from "../lib/types";

/**
 * How long a shot takes and where it is part-way through.
 *
 * The arithmetic of a picture, which is exactly why it is asserted rather than
 * eyeballed: nothing in the game goes wrong when a flight time is subtly off. It
 * simply looks slightly wrong forever, and the only way to notice is to have
 * written down what it should be.
 */

function at(x: number, y: number, elevAbs = 0) {
  return { x, y, elevAbs };
}

/**
 * Ten cells a second, so a cell is a round hundred milliseconds.
 *
 * Deliberately slower than {@link MIN_FLIGHT_MS} bites at: much faster and every
 * shot worth authoring is over inside one tick, and every assertion below would
 * be measuring the floor instead of the arithmetic it is about.
 */
const STEADY: ProjectileBlock = { cellsPerSecond: 10 };

/** One cell at {@link STEADY}, in milliseconds. */
const CELL_MS = 100;

describe("how far a shot travels on screen", () => {
  it("counts a cell as a cell", () => {
    expect(flightScreenDelta(at(0, 0), at(3, 0))).toEqual({
      dx: 3 * CELL_SIZE,
      dy: 0,
    });
  });

  /**
   * **The reason this is measured on screen and not on the plan.** A level is
   * drawn one cell up-left, so a body directly overhead is a real distance away
   * on both axes — and a shot straight up has somewhere to go rather than
   * arriving before it is drawn.
   */
  it("counts a level as a cell up and a cell left", () => {
    const up = flightScreenDelta(at(0, 0), at(0, 0, HEIGHT_PER_LEVEL));
    expect(up).toEqual({ dx: -CELL_SIZE, dy: -CELL_SIZE });
  });
});

describe("how long a shot is in the air", () => {
  it("takes longer the further it goes", () => {
    const near = flightDurationMs(at(0, 0), at(2, 0), STEADY);
    const far = flightDurationMs(at(0, 0), at(6, 0), STEADY);
    expect(far).toBeCloseTo(near * 3);
  });

  it("divides the screen distance by the speed", () => {
    expect(flightDurationMs(at(0, 0), at(4, 0), STEADY)).toBeCloseTo(4 * CELL_MS);
    expect(flightDurationMs(at(0, 0), at(4, 0), { ...STEADY, cellsPerSecond: 20 })).toBeCloseTo(
      2 * CELL_MS,
    );
  });

  /**
   * **The unit is cells per second, and it is the whole reason this test
   * exists.** The first arrows in this game were authored at `0.03` in pixels
   * per millisecond, which is three and three quarter cells a second — slower
   * than a body walks — and nothing about the number said so. Anchoring a cell
   * to a round hundred milliseconds is what makes a wrong speed visible here
   * rather than in somebody's face six cells away.
   */
  it("crosses one cell per second at a speed of one", () => {
    const crawling: ProjectileBlock = { cellsPerSecond: 1 };
    expect(flightDurationMs(at(0, 0), at(1, 0), crawling)).toBeCloseTo(1000);
    expect(flightDurationMs(at(0, 0), at(6, 0), crawling)).toBeCloseTo(6000);
  });

  /**
   * A shot at somebody in your own cell at your own height. It happens — reach
   * includes where you are standing — and a flight of no time at all is one the
   * client is handed already finished.
   */
  it("floors at a tick, so a shot at nothing is still drawn", () => {
    expect(flightDurationMs(at(5, 5), at(5, 5), STEADY)).toBe(MIN_FLIGHT_MS);
  });
});

describe("where the arrow is", () => {
  const flight: ProjectileFlight = {
    id: "shot-1",
    tileId: "arrow",
    from: at(0, 0),
    to: at(4, 2, HEIGHT_PER_LEVEL),
    durationMs: 200,
    elapsedMs: 0,
    hit: true,
  };

  it("starts at the bow and lands on the target", () => {
    expect(flightPosition(flight, 0)).toEqual(flight.from);
    expect(flightPosition(flight, 1)).toEqual(flight.to);
  });

  it("interpolates the plan and the height together", () => {
    expect(flightPosition(flight, 0.5)).toEqual({
      x: 2,
      y: 1,
      elevAbs: HEIGHT_PER_LEVEL / 2,
    });
  });

  /**
   * Progress arrives with a frame's worth of interpolation on it and the last
   * frame of a flight routinely asks about a moment past the end — the same
   * reason a strike's lean clamps.
   */
  it("clamps at both ends rather than overshooting the target", () => {
    expect(flightPosition(flight, 1.4)).toEqual(flight.to);
    expect(flightPosition(flight, -0.2)).toEqual(flight.from);
  });
});

describe("which floor an arrow is over", () => {
  it("puts a body standing on a floor on that floor", () => {
    expect(flightLevel(at(0, 0, 0))).toBe(0);
    expect(flightLevel(at(0, 0, HEIGHT_PER_LEVEL))).toBe(1);
  });

  /** Half a level up is still that level — a crate is not a storey. */
  it("rounds down, so a step up is not a new floor", () => {
    expect(flightLevel(at(0, 0, 1))).toBe(0);
    expect(flightLevel(at(0, 0, HEIGHT_PER_LEVEL + 1))).toBe(1);
  });

  /** A shot from a balcony crosses the boundary on the way down. */
  it("changes floor mid-flight", () => {
    const descent: ProjectileFlight = {
      id: "shot-2",
      tileId: "arrow",
      from: at(0, 0, HEIGHT_PER_LEVEL),
      to: at(4, 0, 0),
      durationMs: 200,
      elapsedMs: 0,
      hit: true,
    };
    expect(flightLevel(flightPosition(descent, 0))).toBe(1);
    expect(flightLevel(flightPosition(descent, 0.9))).toBe(0);
  });
});

/**
 * What a flight plays, and when.
 *
 * The three sides are the one thing in this module that is a claim about the
 * fight rather than about arithmetic: a landing that connected plays `hit` and
 * one that did not plays `disappear`, so a burst thrown by a shot that missed
 * is the picture contradicting the truth it is a receipt for. Asserted here
 * because the two cases look identical for the whole of the flight and differ
 * only on the frame it ends.
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
    shape: null,
    radiusFromPx: 1,
    radiusToPx: 1,
    alphaFrom: 1,
    alphaTo: 0,
    ramp: [{ at: 0, color: "#ffffff" }],
  },
};

/**
 * A projectile tile with whichever sides a case is about.
 *
 * `hit` is the block's; `appear` and `disappear` are the tile's own
 * transitions, which is where a flight reads them from — see
 * `../lib/projectile`.
 */
function projectile(
  sides: { appear?: Transition; hit?: Transition; disappear?: Transition } = {},
): TileDef {
  const { hit, ...transitions } = sides;
  return normalizeTileDef({
    id: "arrow",
    name: "Arrow",
    height: 0,
    type: "directional8",
    kind: "projectile",
    interactions: { projectile: { cellsPerSecond: 10, ...(hit ? { hit } : {}) } },
    ...(transitions.appear || transitions.disappear ? { transitions } : {}),
  });
}

function flying(fields: Partial<ProjectileFlight> = {}): ProjectileFlight {
  return {
    id: "shot-1",
    tileId: "arrow",
    from: at(0, 0),
    to: at(4, 2, HEIGHT_PER_LEVEL),
    durationMs: 200,
    elapsedMs: 0,
    hit: true,
    ...fields,
  };
}

/**
 * A dissolve, which is the half of a side a plume cannot carry: particles are
 * thrown into a cell, and this is done to the arrow's own sprite.
 */
const FADE: Transition = {
  durationMs: 100,
  dissolve: {
    pattern: "noise",
    clumpPx: 3,
    edgeColor: "#ffffff",
    edgeWidth: 0.15,
  },
};

const SHRINK: Transition = { durationMs: 100, scale: {} };

describe("how long a flight is drawn for", () => {
  it("is the crossing alone for a projectile with no landing side", () => {
    expect(flightLifetimeMs(flying(), projectile())).toBe(200);
  });

  /**
   * The disappear plays on the arrow, so the arrow has to still be there. A
   * flight disposed of the moment it arrived had nothing left to dissolve.
   */
  it("outlives its arrival by whatever its disappear runs for", () => {
    expect(flightLifetimeMs(flying({ hit: true }), projectile({ disappear: FADE }))).toBe(300);
  });

  /**
   * **And by the disappear whether or not the blow connected**, because that is
   * the side the arrow itself wears. A `hit` is thrown at the point the shot
   * stopped and ages on its own, so it holds no sprite on screen — a long hit
   * with no disappear behind it would otherwise park an arrow with nothing
   * happening to it.
   */
  it("measures the arrow's life by the disappear and never the hit", () => {
    const def = projectile({ disappear: FADE, hit: { ...FADE, durationMs: 900 } });

    expect(flightLifetimeMs(flying({ hit: true }), def)).toBe(300);
    expect(flightLifetimeMs(flying({ hit: false }), def)).toBe(300);
  });

  it("is the crossing alone for a projectile that only authored a hit", () => {
    expect(flightLifetimeMs(flying({ hit: true }), projectile({ hit: FADE }))).toBe(200);
  });
});

describe("which side is playing on the arrow", () => {
  it("has nothing to wear on a projectile that authored no sides", () => {
    expect(flightPhase(flying({ elapsedMs: 50 }), projectile())).toBeNull();
  });

  it("forms over the appear as it is loosed", () => {
    const phase = flightPhase(flying({ elapsedMs: 25 }), projectile({ appear: FADE }));

    expect(phase?.side).toBe("appear");
    expect(phase?.shown).toBe(0.25);
  });

  /**
   * Most of every flight is simply an arrow. An appear that ran the whole
   * crossing would be a shot that never finished arriving.
   */
  it("wears nothing between the appear and the landing", () => {
    expect(flightPhase(flying({ elapsedMs: 150 }), projectile({ appear: FADE }))).toBeNull();
  });

  it("falls away over the disappear, parked where it stopped", () => {
    const phase = flightPhase(flying({ elapsedMs: 250 }), projectile({ disappear: FADE }));

    expect(phase?.side).toBe("disappear");
    expect(phase?.shown).toBe(0.5);
  });

  /**
   * **Never the hit, whatever the blow came to.** A transition worn by a sprite
   * is a thing done to that sprite, and of the two sides a landing plays only
   * `disappear` is about the arrow. A `hit` plays on whatever was struck, which
   * is never the projectile.
   */
  it("wears the disappear on a landing that connected too", () => {
    const def = projectile({ hit: FADE, disappear: SHRINK });
    const phase = flightPhase(flying({ hit: true, elapsedMs: 250 }), def);

    expect(phase?.side).toBe("disappear");
    expect(phase?.transition).toBe(def.transitions?.disappear);
  });

  it("wears nothing at all for a projectile that only authored a hit", () => {
    expect(
      flightPhase(flying({ hit: true, elapsedMs: 250 }), projectile({ hit: FADE })),
    ).toBeNull();
  });

  /**
   * Whole at the moment it lands and gone at the end, which is what makes the
   * landing read as the arrow going rather than as it blinking out.
   */
  it("shows the whole arrow the instant it arrives and none at the end", () => {
    const def = projectile({ disappear: FADE });

    expect(flightPhase(flying({ elapsedMs: 200 }), def)?.shown).toBe(1);
    expect(flightPhase(flying({ elapsedMs: 300 }), def)?.shown).toBe(0);
  });
});

describe("which side a landing plays", () => {
  function land(flight: ProjectileFlight, def: TileDef) {
    const effects: FlightEffect[] = [];
    ageFlights([flight], 200, { arrow: def }, effects);
    return effects;
  }

  it("plays the disappear wherever a shot stops", () => {
    const effects = land(flying({ hit: true }), projectile({ disappear: SPARK }));

    expect(effects).toEqual([
      {
        id: "shot-1:disappear",
        at: at(4, 2, HEIGHT_PER_LEVEL),
        transition: SPARK,
        elapsedMs: 0,
      },
    ]);
  });

  /** However the blow went: the projectile went either way. */
  it("plays it on a shot that did not connect too", () => {
    const effects = land(flying({ hit: false }), projectile({ disappear: SPARK }));

    expect(effects.map((effect) => effect.id)).toEqual(["shot-1:disappear"]);
  });

  /**
   * **And never the hit, which is not the arrow's to play.** A landing plays
   * two sides, and of the two only `disappear` happens to the projectile. The
   * hit happens to whatever was struck, and is raised on that body by
   * `GameSession.strikeBody` — raising it here as well would play the same
   * effect twice, once in the air and once on the body.
   */
  it("leaves the hit to whoever knows what was struck", () => {
    expect(land(flying({ hit: true }), projectile({ hit: SPARK }))).toEqual([]);
  });

  it("plays nothing at all for a projectile that authored no disappear", () => {
    expect(land(flying({ hit: false }), projectile({ hit: SPARK }))).toEqual([]);
  });

  /**
   * **No fallback either way.** `hit` used to borrow `disappear` when nothing
   * was authored, back when a landing played exactly one side. And a miss still
   * never borrows the hit's sparks, which would be the picture saying a shot
   * landed that did not.
   */
  it("plays the disappear once for a blow whose hit nobody authored", () => {
    const effects = land(flying({ hit: true }), projectile({ disappear: SPARK }));

    expect(effects.map((effect) => effect.id)).toEqual(["shot-1:disappear"]);
    // Equal rather than identical: the fixture goes through `normalizeTileDef`,
    // which parses the block rather than passing the object through.
    expect(effects[0]!.transition).toEqual(SPARK);
  });

  it("plays nothing for a tile the catalogue has lost", () => {
    const effects: FlightEffect[] = [];
    ageFlights([flying()], 200, {}, effects);

    expect(effects).toEqual([]);
  });

  /**
   * And nothing for a tile that is no longer a projectile, which is the kind
   * gate doing its job: a block left on a tile somebody re-kinded is inert.
   */
  it("plays nothing for a tile that has stopped being a projectile", () => {
    const effects: FlightEffect[] = [];
    const crate = { ...projectile({ disappear: SPARK }), kind: "prop" as const };
    ageFlights([flying()], 200, { arrow: crate }, effects);

    expect(effects).toEqual([]);
  });

  /** The effect outlives the flight, so it may not hold a reference into it. */
  it("copies the point rather than sharing the flight's own", () => {
    const flight = flying();
    const effects = land(flight, projectile({ disappear: SPARK }));

    expect(effects[0]!.at).not.toBe(flight.to);
    expect(effects[0]!.at).toEqual(flight.to);
  });
});

describe("ageing flights and what they play", () => {
  it("keeps a flight still in the air, and the array it came in", () => {
    const flights = [flying()];
    const effects: FlightEffect[] = [];

    expect(ageFlights(flights, 50, {}, effects)).toBe(flights);
    expect(flights[0]!.elapsedMs).toBe(50);
  });

  it("drops a flight that has arrived", () => {
    expect(ageFlights([flying()], 200, {}, [])).toEqual([]);
  });

  it("starts the near end's effect where the shot was loosed", () => {
    const flight = flying();
    const effects: FlightEffect[] = [];
    beginEffect(flight, "appear", flight.from, projectile({ appear: SPARK }), effects);

    expect(effects[0]).toMatchObject({ id: "shot-1:appear", at: at(0, 0) });
  });

  it("keeps an effect that is still running, and the array it came in", () => {
    const effects: FlightEffect[] = [
      { id: "shot-1:hit", at: at(4, 2), transition: SPARK, elapsedMs: 0 },
    ];

    expect(ageEffects(effects, 50)).toBe(effects);
    expect(effects[0]!.elapsedMs).toBe(50);
  });

  it("drops one that has run its authored length", () => {
    const effects: FlightEffect[] = [
      { id: "shot-1:hit", at: at(4, 2), transition: SPARK, elapsedMs: 0 },
    ];

    expect(ageEffects(effects, SPARK.durationMs)).toEqual([]);
  });

  /** One frame's dt can be longer than the whole effect on a slow machine. */
  it("drops one the clock jumped clean past", () => {
    const effects: FlightEffect[] = [
      { id: "shot-1:hit", at: at(4, 2), transition: SPARK, elapsedMs: 0 },
    ];

    expect(ageEffects(effects, SPARK.durationMs * 10)).toEqual([]);
  });
});
