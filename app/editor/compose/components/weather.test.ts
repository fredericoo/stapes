import { describe, expect, it } from "vitest";
import { weatherOn, type Sky } from "../../../game/weatherOn";
import type { WeatherKind } from "../../../lib/weather";
import type { BuildResult } from "../build";
import type { MapNode } from "../doc";
import { buildTree, frame, land, node, standingAt, tilesById, type Spot } from "../testTree";
import { weatherAreasOf } from "./weather";

const SIZE = { w: 40, h: 24 };
const PEAK = { x: 10, y: 12 };
const VALLEY = { x: 32, y: 12 };

const hill = () => node("hill", { levels: 2, terrace: 3 }, { frame: frame(2, 4, 16, 16) });

function weatherAt(built: BuildResult, weather: WeatherKind, spot: Spot): WeatherKind {
  const sky: Sky = { weather, areas: weatherAreasOf(built.layout) };
  return weatherOn(built.map, sky, standingAt(built, spot), tilesById);
}

function world(children: MapNode[]): BuildResult {
  return buildTree(land(SIZE, [hill(), ...children]));
}

describe("weather", () => {
  it("keeps fog to the hilltop it covers once an area round the whole world keeps it out", () => {
    const everywhere = world([]);
    expect(weatherAt(everywhere, "fog", VALLEY)).toBe("fog");

    const hilltop = world([
      node("weather", { rain: true, fog: false }),
      node("weather", { rain: true, fog: true }, { frame: frame(4, 6, 12, 12) }),
    ]);
    expect(weatherAt(hilltop, "fog", PEAK)).toBe("fog");
    expect(weatherAt(hilltop, "fog", VALLEY)).toBe("clear");
    expect(weatherAt(hilltop, "rain", VALLEY)).toBe("rain");
  });

  it("keeps rain off the cells inside it and lets it fall beside them", () => {
    const desert = world([
      node("weather", { rain: false, fog: false }, { frame: frame(24, 0, 16, 24) }),
    ]);
    expect(weatherAt(desert, "rain", VALLEY)).toBe("clear");
    expect(weatherAt(desert, "rain", PEAK)).toBe("rain");
  });

  it("lets the later of two overlapping areas decide", () => {
    const later = world([
      node("weather", { rain: false }, { frame: frame(24, 0, 16, 24) }),
      node("weather", { rain: true }, { frame: frame(28, 8, 8, 8) }),
    ]);
    expect(weatherAt(later, "rain", VALLEY)).toBe("rain");
  });

  it("goes where its group goes, is cut to the group's frame, and lays nothing hidden", () => {
    const grouped = (at: number, hidden = false) =>
      world([
        node(
          "group",
          {},
          {
            frame: frame(at, 0, 12, 24),
            hidden,
            children: [node("weather", { rain: false }, { frame: frame(-20, 0, 40, 24) })],
          },
        ),
      ]);
    expect(weatherAt(grouped(26), "rain", VALLEY)).toBe("clear");
    expect(weatherAt(grouped(26), "rain", PEAK)).toBe("rain");
    expect(weatherAt(grouped(4), "rain", VALLEY)).toBe("rain");
    expect(weatherAt(grouped(26, true), "rain", VALLEY)).toBe("rain");
  });
});
