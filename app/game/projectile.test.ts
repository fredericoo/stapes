import { describe, expect, it } from "vitest";
import type { ProjectileDef } from "../lib/item";
import { CELL_SIZE, HEIGHT_PER_LEVEL } from "../lib/types";
import {
  flightDurationMs,
  flightLevel,
  flightPosition,
  flightScreenDelta,
  MIN_FLIGHT_MS,
  type ProjectileFlight,
} from "./projectile";

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
const STEADY: ProjectileDef = { tileId: "arrow", cellsPerSecond: 10 };

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
    expect(flightDurationMs(at(0, 0), at(4, 0), STEADY)).toBeCloseTo(
      4 * CELL_MS,
    );
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
    const crawling: ProjectileDef = { tileId: "arrow", cellsPerSecond: 1 };
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
    };
    expect(flightLevel(flightPosition(descent, 0))).toBe(1);
    expect(flightLevel(flightPosition(descent, 0.9))).toBe(0);
  });
});
