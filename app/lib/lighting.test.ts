import { describe, expect, it } from "vitest";
import {
  AMBIENT_PRESETS,
  computeLighting,
  rayTransmission,
  sampleLevelLight,
  stackOcclusion,
} from "./lighting";
import type { MapFile, TileDef } from "./types";
import { coordKey, levelKey } from "./types";

function tile(
  partial: Partial<TileDef> & Pick<TileDef, "id">,
): TileDef {
  return {
    name: partial.id,
    height: 0,
    directional: false,
    variants: {},
    attributes: {},
    ...partial,
  };
}

function mapAt(
  cells: Array<{
    x: number;
    y: number;
    z?: number;
    tiles: string[];
  }>,
): MapFile {
  const levels: MapFile["levels"] = {};
  for (const c of cells) {
    const z = c.z ?? 0;
    const lk = levelKey(z);
    if (!levels[lk]) levels[lk] = {};
    levels[lk]![coordKey(c.x, c.y)] = c.tiles.map((tileId) => ({ tileId }));
  }
  return { version: 1, levels };
}

const floor = tile({ id: "floor", height: 0 });
const wall = tile({ id: "wall", height: 4 });
const half = tile({ id: "half", height: 2 });
const water = tile({ id: "water", height: 0, lightPassing: true });
const torch = tile({
  id: "torch",
  height: 0,
  light: { radius: 4, intensity: 1, color: "#ffffff" },
});

const tilesById: Record<string, TileDef> = {
  floor,
  wall,
  half,
  water,
  torch,
};

describe("stackOcclusion", () => {
  it("treats default tiles as blockers that seal the level", () => {
    expect(stackOcclusion([{ tileId: "floor" }], tilesById)).toEqual({
      opacity: 0,
      sealsLevel: true,
    });
  });

  it("treats any positive height as a full hard block", () => {
    expect(stackOcclusion([{ tileId: "half" }], tilesById).opacity).toBe(1);
    expect(stackOcclusion([{ tileId: "wall" }], tilesById).opacity).toBe(1);
  });

  it("ignores light-passing tiles", () => {
    expect(stackOcclusion([{ tileId: "water" }], tilesById)).toEqual({
      opacity: 0,
      sealsLevel: false,
    });
  });
});

describe("rayTransmission", () => {
  it("passes freely through empty space", () => {
    expect(rayTransmission(0, 0, 0, 3, 0, 0, new Map())).toBe(1);
  });

  it("hard-blocks at a full wall", () => {
    const occlusion = new Map([
      ["0:1,0", { opacity: 1, sealsLevel: true }],
    ]);
    expect(rayTransmission(0, 0, 0, 3, 0, 0, occlusion)).toBe(0);
  });

  it("hard-blocks at a half wall", () => {
    const occlusion = new Map([
      ["0:1,0", { opacity: 1, sealsLevel: true }],
    ]);
    expect(rayTransmission(0, 0, 0, 3, 0, 0, occlusion)).toBe(0);
  });

  it("seals vertical travel through a floor plate", () => {
    const occlusion = new Map([
      ["1:0,0", { opacity: 0, sealsLevel: true }],
    ]);
    expect(rayTransmission(0, 0, 0, 0, 0, 2, occlusion)).toBe(0);
  });

  it("lets a descending diagonal cross floors on the destination level", () => {
    const occlusion = new Map<string, { opacity: number; sealsLevel: boolean }>();
    for (let x = 0; x <= 3; x++) {
      occlusion.set(`0:${x},0`, { opacity: 0, sealsLevel: true });
    }
    // Torch above (0,0,1) → floor cell (3,0,0). DDA steps down onto the floor
    // plane then walks across it — must not treat those horizontal moves as seals.
    expect(rayTransmission(0, 0, 1, 3, 0, 0, occlusion)).toBe(1);
  });

  it("blocks descending past an intermediate floor to a lower level", () => {
    const occlusion = new Map([
      ["1:0,0", { opacity: 0, sealsLevel: true }],
    ]);
    expect(rayTransmission(0, 0, 2, 0, 0, 0, occlusion)).toBe(0);
  });
});

describe("computeLighting", () => {
  it("contains light inside walls — no bleed past a full wall", () => {
    const map = mapAt([
      { x: 0, y: 0, tiles: ["floor", "torch"] },
      { x: 1, y: 0, tiles: ["floor"] },
      { x: 2, y: 0, tiles: ["wall"] },
      { x: 3, y: 0, tiles: ["floor"] },
    ]);
    const grid = computeLighting(map, tilesById, AMBIENT_PRESETS.night);
    const level = grid.levels.get(0)!;

    const inside = sampleLevelLight(level, 1, 0);
    const wallCell = sampleLevelLight(level, 2, 0);
    const outside = sampleLevelLight(level, 3, 0);

    expect(inside[0]).toBeGreaterThan(AMBIENT_PRESETS.night[0] + 0.1);
    expect(wallCell[0]).toBeCloseTo(AMBIENT_PRESETS.night[0], 1);
    expect(outside[0]).toBeCloseTo(AMBIENT_PRESETS.night[0], 1);
  });

  it("hard-blocks through half-height slabs", () => {
    const map = mapAt([
      { x: 0, y: 0, tiles: ["floor", "torch"] },
      { x: 1, y: 0, tiles: ["half"] },
      { x: 2, y: 0, tiles: ["floor"] },
    ]);
    const grid = computeLighting(map, tilesById, AMBIENT_PRESETS.night);
    const level = grid.levels.get(0)!;
    const slab = sampleLevelLight(level, 1, 0);
    const beyond = sampleLevelLight(level, 2, 0);
    expect(slab[0]).toBeCloseTo(AMBIENT_PRESETS.night[0], 1);
    expect(beyond[0]).toBeCloseTo(AMBIENT_PRESETS.night[0], 1);
  });

  it("does not light roof slabs on the level above", () => {
    const map = mapAt([
      { x: 0, y: 0, z: 0, tiles: ["floor", "torch"] },
      { x: 0, y: 0, z: 1, tiles: ["half"] },
      { x: 1, y: 0, z: 1, tiles: ["half"] },
    ]);
    const grid = computeLighting(map, tilesById, [0, 0, 0]);
    const above = grid.levels.get(1)!;
    expect(sampleLevelLight(above, 0, 0)[0]).toBe(0);
    expect(sampleLevelLight(above, 1, 0)[0]).toBe(0);
  });

  it("does not leak light to the floor above", () => {
    const map = mapAt([
      { x: 0, y: 0, z: 0, tiles: ["floor", "torch"] },
      { x: 0, y: 0, z: 1, tiles: ["floor"] },
    ]);
    const grid = computeLighting(map, tilesById, [0, 0, 0]);
    const above = sampleLevelLight(grid.levels.get(1)!, 0, 0);
    expect(above[0]).toBe(0);
  });

  it("lights the floor below from a torch above", () => {
    const map = mapAt([
      { x: 0, y: 0, z: 1, tiles: ["torch"] },
      { x: 0, y: 0, z: 0, tiles: ["floor"] },
      { x: 1, y: 0, z: 0, tiles: ["floor"] },
      { x: 2, y: 0, z: 0, tiles: ["floor"] },
    ]);
    const grid = computeLighting(map, tilesById, [0, 0, 0]);
    const below = grid.levels.get(0)!;
    expect(sampleLevelLight(below, 0, 0)[0]).toBeGreaterThan(0.5);
    expect(sampleLevelLight(below, 1, 0)[0]).toBeGreaterThan(0.3);
    expect(sampleLevelLight(below, 2, 0)[0]).toBeGreaterThan(0.1);
  });

  it("does not shine through an intermediate floor to the level below it", () => {
    const map = mapAt([
      { x: 0, y: 0, z: 2, tiles: ["torch"] },
      { x: 0, y: 0, z: 1, tiles: ["floor"] },
      { x: 0, y: 0, z: 0, tiles: ["floor"] },
    ]);
    const grid = computeLighting(map, tilesById, [0, 0, 0]);
    expect(sampleLevelLight(grid.levels.get(1)!, 0, 0)[0]).toBeGreaterThan(0.5);
    expect(sampleLevelLight(grid.levels.get(0)!, 0, 0)[0]).toBe(0);
  });

  it("lets light travel vertically through water", () => {
    const map = mapAt([
      { x: 0, y: 0, z: 0, tiles: ["water", "torch"] },
      { x: 0, y: 0, z: 1, tiles: ["water"] },
    ]);
    const grid = computeLighting(map, tilesById, [0, 0, 0]);
    const above = sampleLevelLight(grid.levels.get(1)!, 0, 0);
    expect(above[0]).toBeGreaterThan(0.2);
  });

  it("keeps full walls dark even next to a torch", () => {
    const map = mapAt([
      { x: 0, y: 0, tiles: ["floor", "torch"] },
      { x: 1, y: 0, tiles: ["wall"] },
    ]);
    const grid = computeLighting(map, tilesById, AMBIENT_PRESETS.night);
    const wallCell = sampleLevelLight(grid.levels.get(0)!, 1, 0);
    expect(wallCell[0]).toBeCloseTo(AMBIENT_PRESETS.night[0], 1);
  });

  it("does not let an emitter occlude its own light", () => {
    const tallLamp = tile({
      id: "tall-lamp",
      height: 3,
      light: { radius: 4, intensity: 1, color: "#ffffff" },
    });
    const map = mapAt([{ x: 0, y: 0, tiles: ["tall-lamp"] }]);
    const grid = computeLighting(
      map,
      { ...tilesById, "tall-lamp": tallLamp },
      [0, 0, 0],
    );
    const self = sampleLevelLight(grid.levels.get(0)!, 0, 0);
    expect(self[0]).toBeCloseTo(1, 1);
  });

  it("shifts neighbour light when an emitter is overridden halfway between cells", () => {
    const map = mapAt([
      { x: 0, y: 0, tiles: ["floor", "torch"] },
      { x: 1, y: 0, tiles: ["floor"] },
      { x: 2, y: 0, tiles: ["floor"] },
    ]);
    const baseline = computeLighting(map, tilesById, [0, 0, 0]);
    const moved = computeLighting(map, tilesById, [0, 0, 0], [
      { x: 0, y: 0, z: 0, fx: 0.5, fy: 0, fz: 0 },
    ]);
    const baseLevel = baseline.levels.get(0)!;
    const movedLevel = moved.levels.get(0)!;

    // Closer to (1,0) than the integer emitter — that neighbour brightens.
    expect(sampleLevelLight(movedLevel, 1, 0)[0]).toBeGreaterThan(
      sampleLevelLight(baseLevel, 1, 0)[0],
    );
    // Logical self-cell stays lit (emitter still keyed at origin).
    expect(sampleLevelLight(movedLevel, 0, 0)[0]).toBeGreaterThan(0.5);
  });

  it("override relocates only the matched emitter — other lights stay put", () => {
    const map = mapAt([
      { x: 0, y: 0, tiles: ["floor", "torch"] },
      { x: 10, y: 0, tiles: ["floor", "torch"] },
      { x: 11, y: 0, tiles: ["floor"] },
    ]);
    const baseline = computeLighting(map, tilesById, [0, 0, 0]);
    const moved = computeLighting(map, tilesById, [0, 0, 0], [
      { x: 0, y: 0, z: 0, fx: 1, fy: 0, fz: 0 },
    ]);
    const baseLevel = baseline.levels.get(0)!;
    const movedLevel = moved.levels.get(0)!;

    // Far torch at (10,0) unchanged — neighbour (11,0) same brightness.
    expect(sampleLevelLight(movedLevel, 11, 0)[0]).toBeCloseTo(
      sampleLevelLight(baseLevel, 11, 0)[0],
      2,
    );
    // Overridden torch now sits at (1,0) — that cell brighter than baseline.
    expect(sampleLevelLight(movedLevel, 1, 0)[0]).toBeGreaterThan(
      sampleLevelLight(baseLevel, 1, 0)[0],
    );
  });

  it("does not let an opaque emitter block its own light behind it mid-lerp", () => {
    const tallLamp = tile({
      id: "tall-lamp",
      height: 4,
      light: { radius: 4, intensity: 1, color: "#ffffff" },
    });
    const map = mapAt([
      { x: 0, y: 0, tiles: ["floor", "tall-lamp"] },
      { x: 1, y: 0, tiles: ["floor"] },
      { x: -1, y: 0, tiles: ["floor"] },
    ]);
    // Emit from (1,0) while the lamp tile still occupies (0,0). Rays back to
    // (-1,0) pass through the logical cell — must not self-occlude.
    const grid = computeLighting(
      map,
      { ...tilesById, "tall-lamp": tallLamp },
      [0, 0, 0],
      [{ x: 0, y: 0, z: 0, fx: 1, fy: 0, fz: 0 }],
    );
    const level = grid.levels.get(0)!;
    expect(sampleLevelLight(level, -1, 0)[0]).toBeGreaterThan(0.2);
  });
});
