import { describe, expect, it } from "vitest";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile, TileColorCycle, TileDef } from "../lib/types";
import { FLOW_PERIOD } from "../lib/waterFlow";
import { ColorCycleSheets, cycleCorners, cyclePhaseAt, cyclesPerPeriod } from "./colorCycle";

const cycling = new Set(["water"]);

function waterWithFlows(flows: Record<string, number>): MapFile {
  let map = emptyMap();
  for (const [key, flow] of Object.entries(flows)) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    map = replaceStack(map, x, y, 0, [{ tileId: "water", flow }]);
  }
  return map;
}

describe("cycleCorners", () => {
  it("averages across the point where the stored flow wraps without jumping half a period", () => {
    const top = FLOW_PERIOD - 0.25;
    const map = waterWithFlows({ "0,0": top, "1,0": 0.25, "0,1": top, "1,1": 0.25 });
    const [, ne, , se] = cycleCorners(map, 0, 0, 0, top, cycling);
    expect(ne).toBeCloseTo(FLOW_PERIOD);
    expect(se).toBeCloseTo(FLOW_PERIOD);
  });

  it("takes a corner beside dry ground from the water cells that meet there", () => {
    const map = waterWithFlows({ "0,0": 4 });
    expect(cycleCorners(map, 0, 0, 0, 4, cycling)).toEqual([4, 4, 4, 4]);
  });
});

describe("cyclePhaseAt", () => {
  const cycle: TileColorCycle = {
    key: "#000000",
    ramp: Array.from({ length: 16 }, () => "#000000"),
    cellsPerCycle: 4,
    msPerCycle: 1600,
    ripple: 0,
    gaps: 0,
  };
  const stepMs = cycle.msPerCycle / cycle.ramp.length;
  const loopMs = cycle.msPerCycle * cyclesPerPeriod(cycle);

  it.each([0.5, 1, 1.5, 2, 3])(
    "moves bands drawn at %s times the waves on by one step across the loop, as at any other step",
    (waves) => {
      const step = (from: number) => {
        const d = waves * (cyclePhaseAt(cycle, from + stepMs) - cyclePhaseAt(cycle, from));
        const period = waves * cyclesPerPeriod(cycle);
        return ((d % period) + period) % period;
      };
      expect(step(loopMs - stepMs)).toBeCloseTo(step(stepMs));
    },
  );
});

describe("ColorCycleSheets", () => {
  const water = (msPerCycle: number): TileDef =>
    ({
      id: "water",
      anchor: { tilesetId: "water", x: 0, y: 0 },
      colorCycle: {
        key: "#335c8c",
        ramp: Array.from({ length: 16 }, () => "#335c8c"),
        cellsPerCycle: 4,
        msPerCycle,
        ripple: 0,
        gaps: 0,
      },
    }) as TileDef;

  it("keeps turning the uniforms a material took after the catalogue is replaced", () => {
    const sheets = new ColorCycleSheets();
    sheets.use({ water: water(1600) });
    const taken = sheets.uniformsFor("water")!;

    sheets.use({
      water: water(1600),
      cloak: { id: "cloak", anchor: { tilesetId: "clothes", x: 0, y: 0 } } as TileDef,
    });
    sheets.turnTo(500);

    expect(sheets.uniformsFor("water")).toBe(taken);
    expect(taken.uCyclePhase.value).toBeGreaterThan(0);
  });

  it("writes a changed cycle into the uniforms already handed out", () => {
    const sheets = new ColorCycleSheets();
    sheets.use({ water: water(1600) });
    const taken = sheets.uniformsFor("water")!;

    sheets.use({
      water: { ...water(1600), colorCycle: { ...water(1600).colorCycle!, gaps: 0.5 } },
    });

    expect(taken.uCycleGaps.value).toBe(0.5);
  });
});
