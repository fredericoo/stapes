import { describe, expect, it } from "vitest";
import type { ProjectileFlight } from "../game/projectile";
import { HEIGHT_PER_LEVEL, type Octant } from "../lib/types";
import { projectileOctant, projectileViews } from "./projectileMotion";

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
  };
}

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
    expect(projectileViews([flight])).toEqual([
      {
        id: "shot-1",
        tileId: "arrow",
        direction: "e",
        x: 12,
        y: 10,
        elevAbs: 0,
        z: 0,
      },
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
      (elapsedMs) => projectileViews([{ ...flight, elapsedMs }])[0]!.direction,
    );
    expect(new Set(bearings).size).toBe(1);
  });
});
