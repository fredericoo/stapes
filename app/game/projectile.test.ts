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

function at(x: number, y: number, elevAbs = 0) {
  return { x, y, elevAbs };
}

const STEADY: ProjectileBlock = { cellsPerSecond: 10 };

const CELL_MS = 100;

describe("how far a shot travels on screen", () => {
  it("counts a cell as a cell", () => {
    expect(flightScreenDelta(at(0, 0), at(3, 0))).toEqual({
      dx: 3 * CELL_SIZE,
      dy: 0,
    });
  });

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

  it("crosses one cell per second at a speed of one", () => {
    const crawling: ProjectileBlock = { cellsPerSecond: 1 };
    expect(flightDurationMs(at(0, 0), at(1, 0), crawling)).toBeCloseTo(1000);
    expect(flightDurationMs(at(0, 0), at(6, 0), crawling)).toBeCloseTo(6000);
  });

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

  it("rounds down, so a step up is not a new floor", () => {
    expect(flightLevel(at(0, 0, 1))).toBe(0);
    expect(flightLevel(at(0, 0, HEIGHT_PER_LEVEL + 1))).toBe(1);
  });

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

  it("outlives its arrival by whatever its disappear runs for", () => {
    expect(flightLifetimeMs(flying({ hit: true }), projectile({ disappear: FADE }))).toBe(300);
  });

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

  it("wears nothing between the appear and the landing", () => {
    expect(flightPhase(flying({ elapsedMs: 150 }), projectile({ appear: FADE }))).toBeNull();
  });

  it("falls away over the disappear, parked where it stopped", () => {
    const phase = flightPhase(flying({ elapsedMs: 250 }), projectile({ disappear: FADE }));

    expect(phase?.side).toBe("disappear");
    expect(phase?.shown).toBe(0.5);
  });

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

  it("plays it on a shot that did not connect too", () => {
    const effects = land(flying({ hit: false }), projectile({ disappear: SPARK }));

    expect(effects.map((effect) => effect.id)).toEqual(["shot-1:disappear"]);
  });

  it("leaves the hit to whoever knows what was struck", () => {
    expect(land(flying({ hit: true }), projectile({ hit: SPARK }))).toEqual([]);
  });

  it("plays nothing at all for a projectile that authored no disappear", () => {
    expect(land(flying({ hit: false }), projectile({ hit: SPARK }))).toEqual([]);
  });

  it("plays the disappear once for a blow whose hit nobody authored", () => {
    const effects = land(flying({ hit: true }), projectile({ disappear: SPARK }));

    expect(effects.map((effect) => effect.id)).toEqual(["shot-1:disappear"]);
    expect(effects[0]!.transition).toEqual(SPARK);
  });

  it("plays nothing for a tile the catalogue has lost", () => {
    const effects: FlightEffect[] = [];
    ageFlights([flying()], 200, {}, effects);

    expect(effects).toEqual([]);
  });

  it("plays nothing for a tile that has stopped being a projectile", () => {
    const effects: FlightEffect[] = [];
    const crate = { ...projectile({ disappear: SPARK }), kind: "prop" as const };
    ageFlights([flying()], 200, { arrow: crate }, effects);

    expect(effects).toEqual([]);
  });

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

  it("drops one the clock jumped clean past", () => {
    const effects: FlightEffect[] = [
      { id: "shot-1:hit", at: at(4, 2), transition: SPARK, elapsedMs: 0 },
    ];

    expect(ageEffects(effects, SPARK.durationMs * 10)).toEqual([]);
  });
});
