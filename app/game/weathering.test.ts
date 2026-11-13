import { describe, expect, it } from "vitest";
import type { BrainDef } from "../lib/brain";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import { FRAME, tile } from "../lib/testTile";
import type { MapFile, TileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import type { WeatherKind } from "../lib/weather";
import { TICK_MS } from "./constants";
import { GameSession } from "./GameSession";
import { weatherOn, type Sky } from "./weatherOn";

const FIRE_MS = 3000;
const PUDDLE_MS = 2000;
const HALF = 5;
const SHELTER_CELLS = 8;

function shelteringBrain(): BrainDef {
  return {
    initial: "graze",
    states: {
      graze: { do: [{ action: "hold" }] },
      sheltering: {
        do: [{ action: "take_shelter", from: "rain", cells: SHELTER_CELLS }, { action: "hold" }],
      },
    },
    transitions: [
      {
        from: "graze",
        if: {
          combinator: "and",
          rules: [
            { cond: "weather", is: "rain" },
            { cond: "shelter_near", from: "rain", cells: SHELTER_CELLS },
          ],
        },
        to: "sheltering",
      },
      {
        from: "sheltering",
        if: {
          combinator: "and",
          not: true,
          rules: [{ cond: "weather", is: "rain", overhead: true }],
        },
        to: "graze",
      },
    ],
  };
}

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "glass", height: 0, lightPassing: true }),
  tile({
    id: "player",
    height: 4,
    directional: true,
    affectedByGravity: true,
    walkable: false,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
  }),
  tile({
    id: "fire",
    height: 0,
    interactions: { weather: [{ in: "rain", tileId: "", fromMs: FIRE_MS, toMs: FIRE_MS }] },
  }),
  tile({
    id: "dust",
    height: 0,
    interactions: {
      weather: [{ in: "rain", tileId: "puddle", fromMs: PUDDLE_MS, toMs: PUDDLE_MS }],
    },
  }),
  tile({
    id: "puddle",
    height: 0,
    interactions: {
      weather: [{ in: "clear", tileId: "dust", fromMs: PUDDLE_MS, toMs: PUDDLE_MS }],
    },
  }),
  tile({
    id: "hare",
    height: 2,
    actor: true,
    affectedByGravity: true,
    walkable: false,
    interactions: { brain: shelteringBrain() },
  }),
];

const tilesById = tilesByIdFromList(tiles);

function field(): MapFile {
  let map = emptyMap();
  for (let x = -HALF; x <= HALF; x++) {
    for (let y = -HALF; y <= HALF; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  return replaceStack(map, -HALF, -HALF, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "e" },
  ]);
}

function on(map: MapFile, x: number, y: number, tileId: string): MapFile {
  return replaceStack(map, x, y, 0, [{ tileId: "grass" }, { tileId }]);
}

function roofed(map: MapFile, x: number, y: number, tileId = "grass"): MapFile {
  return replaceStack(map, x, y, 1, [{ tileId }]);
}

function everywhere(weather: WeatherKind): Sky {
  return { weather, areas: [] };
}

function world(map: MapFile, sky: Sky): GameSession {
  const session = new GameSession(map, tiles);
  session.setSky(sky);
  return session;
}

function run(session: GameSession, ms: number) {
  for (let i = 0; i <= Math.ceil(ms / TICK_MS); i++) session.tick(TICK_MS);
}

function top(session: GameSession, x: number, y: number): string | undefined {
  return getStack(session.getMap(), x, y, 0).at(-1)?.tileId;
}

function hareCell(session: GameSession): string {
  const hare = session.actorSnapshots().find((actor) => actor.tileId === "hare");
  return hare ? `${hare.x},${hare.y}` : "gone";
}

describe("weatherOn", () => {
  const dryEast: Sky = {
    weather: "rain",
    areas: [{ x0: 3, y0: -HALF, x1: HALF, y1: HALF, rain: false, fog: false }],
  };

  it("puts rain on a cell under open sky and not on one with a floor above it", () => {
    const map = roofed(field(), 1, 0);
    expect(weatherOn(map, everywhere("rain"), { x: 0, y: 0, z: 0 }, tilesById)).toBe("rain");
    expect(weatherOn(map, everywhere("rain"), { x: 1, y: 0, z: 0 }, tilesById)).toBe("clear");
  });

  it("lets rain through a floor that light passes", () => {
    const map = roofed(field(), 1, 0, "glass");
    expect(weatherOn(map, everywhere("rain"), { x: 1, y: 0, z: 0 }, tilesById)).toBe("rain");
  });

  it("stops rain at the edge of an area it does not reach", () => {
    expect(weatherOn(field(), dryEast, { x: 2, y: 0, z: 0 }, tilesById)).toBe("rain");
    expect(weatherOn(field(), dryEast, { x: 3, y: 0, z: 0 }, tilesById)).toBe("clear");
  });

  it("puts fog under a roof at ground level and keeps it out of a cellar", () => {
    const map = roofed(field(), 1, 0);
    expect(weatherOn(map, everywhere("fog"), { x: 1, y: 0, z: 0 }, tilesById)).toBe("fog");
    expect(weatherOn(map, everywhere("fog"), { x: 1, y: 0, z: -1 }, tilesById)).toBe("clear");
  });
});

describe("a tile's weather reaction", () => {
  it("removes a fire the rain falls on and leaves one under a roof", () => {
    const map = roofed(on(on(field(), 0, 0, "fire"), 2, 0, "fire"), 2, 0);
    const session = world(map, everywhere("rain"));

    run(session, FIRE_MS - 1000);
    expect(top(session, 0, 0)).toBe("fire");

    run(session, 2000);
    expect(top(session, 0, 0)).toBe("grass");
    expect(top(session, 2, 0)).toBe("fire");
  });

  it("leaves the fire alone while the sky is clear", () => {
    const session = world(on(field(), 0, 0, "fire"), everywhere("clear"));
    run(session, FIRE_MS * 3);
    expect(top(session, 0, 0)).toBe("fire");
  });

  it("starts the wait over when the rain stops and comes back", () => {
    const session = world(on(field(), 0, 0, "fire"), everywhere("rain"));
    run(session, FIRE_MS - 1000);
    session.setSky(everywhere("clear"));
    run(session, 1500);
    session.setSky(everywhere("rain"));

    run(session, FIRE_MS - 1000);
    expect(top(session, 0, 0)).toBe("fire");
    run(session, 2000);
    expect(top(session, 0, 0)).toBe("grass");
  });

  it("turns one tile into another, which turns back in the weather it names", () => {
    const session = world(on(field(), 0, 0, "dust"), everywhere("rain"));
    run(session, PUDDLE_MS + 1000);
    expect(top(session, 0, 0)).toBe("puddle");

    session.setSky(everywhere("clear"));
    run(session, PUDDLE_MS + 1000);
    expect(top(session, 0, 0)).toBe("dust");
  });
});

describe("a brain sheltering from rain", () => {
  it("walks under the nearest roof and stays there while it rains", () => {
    const session = world(roofed(on(field(), 0, 0, "hare"), 3, 0), everywhere("rain"));
    run(session, 8000);
    expect(hareCell(session)).toBe("3,0");

    run(session, 4000);
    expect(hareCell(session)).toBe("3,0");
  });

  it("walks out of the area the rain reaches when nothing is overhead", () => {
    const sky: Sky = {
      weather: "rain",
      areas: [{ x0: 3, y0: -HALF, x1: HALF, y1: HALF, rain: false, fog: false }],
    };
    const session = world(on(field(), 0, 0, "hare"), sky);
    run(session, 8000);
    expect(hareCell(session)).toBe("3,0");
  });

  it("stays where it grazes when no dry cell is within reach", () => {
    const session = world(on(field(), 0, 0, "hare"), everywhere("rain"));
    run(session, 8000);
    expect(hareCell(session)).toBe("0,0");
  });

  it("does not move for rain that is not falling", () => {
    const session = world(roofed(on(field(), 0, 0, "hare"), 3, 0), everywhere("clear"));
    run(session, 8000);
    expect(hareCell(session)).toBe("0,0");
  });
});
