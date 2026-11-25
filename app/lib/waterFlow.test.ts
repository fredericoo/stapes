import { describe, expect, it } from "vitest";
import { shippedTiles } from "../game/testShippedTiles";
import { emptyMap, getStack, replaceStack } from "./mapData";
import type { MapFile, PlacedTile, TileDef } from "./types";
import {
  FLOW_PERIOD,
  WaterCells,
  colorCycleTileIds,
  flowDelta,
  flowTimes,
  placedBank,
  settleFlow,
  withFlow,
} from "./waterFlow";

const tilesById: Record<string, TileDef> = Object.fromEntries(
  shippedTiles().map((def) => [def.id, def]),
);
const cycling = colorCycleTileIds(tilesById);

const WATER: PlacedTile[] = [{ tileId: "dirt" }, { tileId: "water" }];
const LAND: PlacedTile[] = [{ tileId: "grass-2" }];

/**
 * Sea round an island (x 12..47, y 10..39) on a 60 by 50 map. A river two
 * cells wide runs from a spring at y 14 south to the island's south coast, and
 * a pond lies in the island's east, joined to nothing.
 */
function island(): MapFile {
  let map = emptyMap();
  for (let y = 0; y < 50; y++) {
    for (let x = 0; x < 60; x++) {
      const onIsland = x >= 12 && x <= 47 && y >= 10 && y <= 39;
      const river = (x === 29 || x === 30) && y >= 14 && y <= 39;
      const pond = x >= 38 && x <= 43 && y >= 20 && y <= 27;
      map = replaceStack(map, x, y, 0, onIsland && !river && !pond ? LAND : WATER);
    }
  }
  return map;
}

function timesOf(map: MapFile) {
  const cells = new WaterCells(map, cycling);
  const { times } = flowTimes(cells);
  return (x: number, y: number) => times[cells.at(x, y, 0)]!;
}

describe("flowTimes", () => {
  const at = timesOf(island());

  it("runs a river downstream to the sea", () => {
    expect(at(29, 20)).toBeGreaterThan(at(29, 16));
    expect(at(29, 30)).toBeGreaterThan(at(29, 20));
    expect(at(30, 38)).toBeGreaterThan(at(30, 30));
  });

  it("runs the sea in towards the coast", () => {
    expect(at(20, 41)).toBeGreaterThan(at(20, 46));
    expect(at(5, 20)).toBeGreaterThan(at(1, 20));
  });

  it("drifts a pond that reaches no sea south", () => {
    expect(at(40, 26)).toBeGreaterThan(at(40, 21));
  });
});

describe("flowTimes waves", () => {
  it("draws more, smaller waves in a river than on the sea", () => {
    const cells = new WaterCells(island(), cycling);
    const { waves } = flowTimes(cells);
    expect(waves[cells.at(29, 25, 0)]).toBeGreaterThan(1);
    expect(waves[cells.at(20, 46, 0)]).toBe(1);
  });
});

describe("withFlow", () => {
  it("gives every water placement a flow within the stored period", () => {
    const map = withFlow(island(), tilesById);
    for (const [x, y] of [
      [0, 0],
      [29, 20],
      [40, 25],
    ] as const) {
      const flow = getStack(map, x, y, 0).find((p) => p.tileId === "water")?.flow;
      expect(flow).toBeGreaterThanOrEqual(0);
      expect(flow).toBeLessThan(FLOW_PERIOD);
    }
    expect(getStack(map, 20, 20, 0)[0]!.flow).toBeUndefined();
  });

  it("writes how far each cell is from a bank, so open sea is told from the shallows", () => {
    const map = withFlow(island(), tilesById);
    const bankAt = (x: number, y: number) =>
      placedBank(getStack(map, x, y, 0).find((p) => p.tileId === "water")!);
    expect(bankAt(20, 40)).toBe(1);
    expect(bankAt(20, 46)).toBeGreaterThan(bankAt(20, 43));
  });
});

describe("settleFlow", () => {
  it("gives water put down beside a current that current", () => {
    const before = withFlow(island(), tilesById);
    const after = settleFlow(before, replaceStack(before, 31, 20, 0, WATER), tilesById);
    const flow = getStack(after, 31, 20, 0).find((p) => p.tileId === "water")?.flow;
    const beside = getStack(after, 30, 20, 0).find((p) => p.tileId === "water")!.flow!;
    expect(flow).toBeDefined();
    expect(Math.abs(flowDelta(beside, flow!))).toBeLessThan(1);
  });

  it("leaves a step through water alone", () => {
    const before = withFlow(island(), tilesById);
    const waded = replaceStack(before, 29, 20, 0, [
      ...getStack(before, 29, 20, 0),
      { tileId: "player" },
    ]);
    expect(settleFlow(before, waded, tilesById)).toBe(waded);
  });
});
