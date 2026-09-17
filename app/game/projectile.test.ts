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
    expect(
      flightDurationMs(at(0, 0), at(4, 0), { ...STEADY, cellsPerSecond: 20 }),
    ).toBeCloseTo(2 * CELL_MS);
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

describe("which side a landing plays", () => {
  function land(flight: ProjectileFlight, def: TileDef) {
    const effects: FlightEffect[] = [];
    ageFlights([flight], 200, { arrow: def }, effects);
    return effects;
  }

  it("plays the hit where a shot that connected lands", () => {
    const effects = land(flying({ hit: true }), projectile({ hit: SPARK }));

    expect(effects).toEqual([
      {
        id: "shot-1:hit",
        at: at(4, 2, HEIGHT_PER_LEVEL),
        transition: SPARK,
        elapsedMs: 0,
      },
    ]);
  });

  /** A miss and a dodge are drawn in full and leave the hit alone. */
  it("plays nothing where a shot that did not connect lands", () => {
    expect(land(flying({ hit: false }), projectile({ hit: SPARK }))).toEqual([]);
  });

  it("plays the disappear where a shot that did not connect lands", () => {
    const effects = land(flying({ hit: false }), projectile({ disappear: SPARK }));

    expect(effects.map((effect) => effect.id)).toEqual(["shot-1:disappear"]);
  });

  /**
   * The fallback is what makes `hit` an addition rather than a rearrangement: a
   * fireball that dissolves wherever it stops is one block, and the second is
   * only written by an author who wants the landing that connected to differ.
   */
  it("falls back to the disappear for a hit nobody authored", () => {
    const effects = land(flying({ hit: true }), projectile({ disappear: SPARK }));

    expect(effects.map((effect) => effect.id)).toEqual(["shot-1:hit"]);
    // Equal rather than identical: the fixture goes through `normalizeTileDef`,
    // which parses the block rather than passing the object through.
    expect(effects[0]!.transition).toEqual(SPARK);
  });

  /** And never the other way: a miss may not borrow the hit's sparks. */
  it("does not fall back the other way", () => {
    expect(land(flying({ hit: false }), projectile({ hit: SPARK }))).toEqual([]);
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
    const crate = { ...projectile({ hit: SPARK }), kind: "prop" as const };
    ageFlights([flying()], 200, { arrow: crate }, effects);

    expect(effects).toEqual([]);
  });

  /** The effect outlives the flight, so it may not hold a reference into it. */
  it("copies the point rather than sharing the flight's own", () => {
    const flight = flying();
    const effects = land(flight, projectile({ hit: SPARK }));

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
