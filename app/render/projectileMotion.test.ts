import { describe, expect, it } from "vitest";
import type { FlightEffect, ProjectileFlight } from "../game/projectile";
import { CELL_CENTRE, depthStackBias } from "../lib/geometry";
import { normalizeTileDef, type TileDef } from "../lib/types";
import type { Transition } from "../lib/tileTransition";

import tilesJson from "../../data/tiles.json";
import { uniformFootprint } from "./animTable";
import { getFrames } from "../lib/tileResolve";
import { projectileTiles } from "../lib/projectile";
import { normalizeTiles } from "../lib/types";
import { HEIGHT_PER_LEVEL, OCTANTS, type Octant } from "../lib/types";
import {
  aimedAt,
  flightEmitter,
  flightLight,
  projectileOctant,
  projectileViews,
  wearsFlightTransition,
} from "./projectileMotion";

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

describe("a shot that follows its target", () => {
  const shot = (over: Partial<ProjectileFlight> = {}): ProjectileFlight => ({
    id: "shot-1",
    tileId: "arrow",
    from: { x: 0, y: 0, elevAbs: 0 },
    to: { x: 4, y: 0, elevAbs: 0 },
    durationMs: 400,
    elapsedMs: 200,
    hit: true,
    targetId: "rat",
    ...over,
  });

  const moved = { x: 4, y: 6, elevAbs: 0 };

  it("aims where the body is now", () => {
    expect(aimedAt(shot(), () => moved)).toBe(moved);
  });

  it("keeps the end it was loosed at when the body has gone", () => {
    const flight = shot();

    expect(aimedAt(flight, () => undefined)).toBe(flight.to);
  });

  it("keeps it for a shot that never named a body, and with nobody to ask", () => {
    const anonymous = shot({ targetId: undefined });
    const aimed = shot();

    expect(aimedAt(anonymous, () => moved)).toBe(anonymous.to);
    expect(aimedAt(aimed, undefined)).toBe(aimed.to);
  });

  it("draws the arrow part way to where the body is now", () => {
    const [view] = projectileViews([shot()], CATALOGUE, () => moved);

    expect(view!.x).toBe(2);
    expect(view!.y).toBe(3);
  });

  it("turns as the body it is chasing moves", () => {
    const flight = shot();

    expect(projectileOctant(flight)).toBe("e");
    expect(projectileOctant(flight, moved)).not.toBe("e");
  });
});

describe("the light a flight casts", () => {
  const GLOW = { radius: 3, intensity: 1, color: "#ffcc88" };

  const lit = (over: Record<string, unknown> = {}): TileDef =>
    normalizeTileDef({
      id: "fireball",
      name: "Fireball",
      height: 0,
      type: "simple",
      kind: "projectile",
      anchor: { tilesetId: "sheet", x: 0, y: 0 },
      sprite: {
        frames: [
          {
            sprite: { rect: { x: 0, y: 0, w: 1, h: 1 }, base: { x: 0, y: 0 } },
            durationMs: 200,
            light: GLOW,
          },
        ],
      },
      interactions: { projectile: { cellsPerSecond: 10 } },
      ...over,
    });

  const flight = (over: Partial<ProjectileFlight> = {}): ProjectileFlight => ({
    id: "shot-1",
    tileId: "fireball",
    from: { x: 0, y: 0, elevAbs: 2 },
    to: { x: 4, y: 0, elevAbs: 2 },
    durationMs: 400,
    elapsedMs: 200,
    hit: true,
    ...over,
  });

  it("casts the tile's own light from where the arrow is", () => {
    const cast = flightLight(flight(), lit());

    expect(cast?.lights).toEqual([GLOW]);
    expect(cast?.fx).toBe(2.5);
    expect(cast?.fy).toBe(0.5);
    expect(cast?.x).toBe(2);
    expect(cast?.y).toBe(0);
  });

  it("hangs it at the arrow's own height, in levels", () => {
    expect(flightLight(flight(), lit())?.fz).toBe(2 / HEIGHT_PER_LEVEL);
  });

  it("casts nothing for a projectile carrying no light", () => {
    const dark = normalizeTileDef({
      id: "arrow",
      name: "Arrow",
      height: 0,
      type: "simple",
      kind: "projectile",
      anchor: { tilesetId: "sheet", x: 0, y: 0 },
      sprite: {
        frames: [
          {
            sprite: { rect: { x: 0, y: 0, w: 1, h: 1 }, base: { x: 0, y: 0 } },
            durationMs: 200,
          },
        ],
      },
      interactions: { projectile: { cellsPerSecond: 10 } },
    });

    expect(flightLight(flight(), dark)).toBeNull();
    expect(flightLight(flight(), undefined)).toBeNull();
  });

  it("fades with the landing it is playing", () => {
    const def = lit({
      transitions: {
        disappear: {
          durationMs: 400,
          dissolve: {
            pattern: "noise",
            clumpPx: 3,
            edgeColor: "#ffffff",
            edgeWidth: 0.15,
          },
        },
      },
    });
    const at = (elapsedMs: number) =>
      flightLight(flight({ hit: false, elapsedMs }), def)?.lights?.[0]?.intensity;

    expect(at(400)).toBe(1);
    expect(at(600)).toBeLessThan(1);
    expect(at(600)).toBeGreaterThan(0);
    expect(at(750)).toBeLessThan(at(600)!);
  });

  it("holds one strength for the whole crossing", () => {
    const def = lit();
    for (const elapsedMs of [0, 100, 200, 399]) {
      expect(flightLight(flight({ elapsedMs }), def)?.lights?.[0]?.intensity).toBe(1);
    }
  });
});

describe("the projectiles we ship are drawn on one quad", () => {
  const tiles = normalizeTiles(tilesJson as unknown[]);

  it("keeps one footprint across every frame of every bearing", () => {
    const fired = projectileTiles(tiles);

    expect(fired.length).toBeGreaterThan(0);
    for (const def of fired) {
      for (const direction of OCTANTS) {
        const frames = getFrames(def, { direction });
        if (!frames || frames.length < 2) continue;
        expect(
          uniformFootprint(frames),
          `${def.id} draws ${direction} from frames that disagree about size or base`,
        ).toBe(true);
      }
    }
  });
});

describe("whether a projectile's sides ask anything of its sprite", () => {
  const sided = (sides: Record<string, Transition>, hit?: Transition) =>
    normalizeTileDef({
      id: "arrow",
      name: "Arrow",
      height: 0,
      type: "directional8",
      kind: "projectile",
      interactions: {
        projectile: { cellsPerSecond: 20, ...(hit ? { hit } : {}) },
      },
      ...(Object.keys(sides).length ? { transitions: sides } : {}),
    });

  const DISSOLVE: Transition = {
    durationMs: 100,
    dissolve: {
      pattern: "noise",
      clumpPx: 3,
      edgeColor: "#ffffff",
      edgeWidth: 0.15,
    },
  };

  it("asks nothing of a projectile with no sides at all", () => {
    expect(wearsFlightTransition(CATALOGUE.arrow!)).toBe(false);
  });

  it("asks nothing of a side that is only a plume", () => {
    expect(wearsFlightTransition(sided({}, SPARK))).toBe(false);
  });

  it("is asked by a dissolve on either side the arrow wears", () => {
    expect(wearsFlightTransition(sided({ appear: DISSOLVE }))).toBe(true);
    expect(wearsFlightTransition(sided({ disappear: DISSOLVE }))).toBe(true);
  });

  it("asks nothing of a dissolve authored on the hit", () => {
    expect(wearsFlightTransition(sided({}, DISSOLVE))).toBe(false);
  });

  it("is asked by a scale", () => {
    expect(wearsFlightTransition(sided({ appear: { durationMs: 100, scale: {} } }))).toBe(true);
  });
});

describe("which way an arrow points", () => {
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

  it("keeps a shot barely off a cardinal on that cardinal", () => {
    expect(projectileOctant(shot(1, -8))).toBe("n");
    expect(projectileOctant(shot(-1, -8))).toBe("n");
  });

  it("points up-left at somebody directly overhead", () => {
    expect(projectileOctant(shot(0, 0, HEIGHT_PER_LEVEL))).toBe("nw");
  });

  it("answers south for a shot with no bearing at all", () => {
    expect(projectileOctant(shot(0, 0))).toBe("s");
  });
});

describe("the views a frame is drawn from", () => {
  it("carries the position, the bearing and the floor", () => {
    const flight = { ...shot(4, 0), elapsedMs: 100 };
    expect(projectileViews([flight], CATALOGUE)).toEqual([
      {
        id: "shot-1",
        tileId: "arrow",
        direction: "e",
        x: 12,
        y: 10,
        elevAbs: 0,
        z: 0,
        phase: null,
      },
    ]);
  });

  it("keeps one bearing for the whole flight", () => {
    const flight = shot(6, -1);
    const bearings = [0, 60, 120, 199].map(
      (elapsedMs) => projectileViews([{ ...flight, elapsedMs }], CATALOGUE)[0]!.direction,
    );
    expect(new Set(bearings).size).toBe(1);
  });

  it("skips a flight whose tile the catalogue has lost", () => {
    const flight = { ...shot(4, 0), tileId: "ghost-arrow" };
    expect(projectileViews([flight], CATALOGUE)).toEqual([]);
  });

  it("skips a flight whose tile is no longer a projectile", () => {
    const crate = { ...CATALOGUE.arrow!, kind: "prop" as const };
    expect(projectileViews([shot(4, 0)], { arrow: crate })).toEqual([]);
  });
});

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

  it("takes the level from the height it stopped at", () => {
    expect(flightEmitter(effect({ x: 0, y: 0, elevAbs: 0 }))!.z).toBe(0);
    expect(flightEmitter(effect({ x: 0, y: 0, elevAbs: HEIGHT_PER_LEVEL }))!.z).toBe(1);
  });

  it("sorts above anything standing in that cell", () => {
    const spec = flightEmitter(effect({ x: 4, y: 2, elevAbs: 0 }))!;
    expect(spec.stackBias).toBeGreaterThan(depthStackBias(0, 8));
  });

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
