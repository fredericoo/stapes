import { describe, expect, it } from "vitest";
import { chunkifyMap } from "./mapData";
import type { FlatMapFile } from "./types";
import {
  AMBIENT_PRESETS,
  computeLighting,
  emitterCenter,
  isSkyExposed,
  overlayEmitterOverrides,
  rayTransmission,
  sampleLevelLight,
  stackOcclusion,
} from "./lighting";
import { MAX_LIGHT_LEVEL } from "./lightingFlood";
import type { MapFile, TileDef } from "./types";
import { coordKey, levelKey, normalizeTileDef } from "./types";

function tile(
  partial: Record<string, unknown> & Pick<TileDef, "id">,
): TileDef {
  return normalizeTileDef({
    name: partial.id,
    height: 0,
    directional: false,
    variants: {
      default: [
        {
          sprite: {
            tilesetId: "t",
            rect: { x: 0, y: 0, w: 1, h: 1 },
            base: { x: 0, y: 0 },
          },
          durationMs: 200,
        },
      ],
    },
    attributes: {},
    ...partial,
  });
}

function mapAt(
  cells: Array<{
    x: number;
    y: number;
    z?: number;
    tiles: string[];
  }>,
): MapFile {
  const levels: FlatMapFile["levels"] = {};
  for (const c of cells) {
    const z = c.z ?? 0;
    const lk = levelKey(z);
    if (!levels[lk]) levels[lk] = {};
    levels[lk]![coordKey(c.x, c.y)] = c.tiles.map((tileId) => ({ tileId }));
  }
  return chunkifyMap({ version: 1, levels });
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

  it("maps blocking height to opacity (half = 0.5, full = 1)", () => {
    expect(stackOcclusion([{ tileId: "half" }], tilesById).opacity).toBe(0.5);
    expect(stackOcclusion([{ tileId: "wall" }], tilesById).opacity).toBe(1);
    expect(
      stackOcclusion([{ tileId: "half" }, { tileId: "half" }], tilesById)
        .opacity,
    ).toBe(1);
  });

  it("ignores light-passing tiles", () => {
    expect(stackOcclusion([{ tileId: "water" }], tilesById)).toEqual({
      opacity: 0,
      sealsLevel: false,
    });
  });

  it("still occludes with authored height when intangible", () => {
    const openDoor = tile({
      id: "door-open",
      height: 4,
      intangible: true,
      walkable: false,
    });
    const byId = { ...tilesById, "door-open": openDoor };
    expect(stackOcclusion([{ tileId: "door-open" }], byId)).toEqual({
      opacity: 1,
      sealsLevel: true,
    });
  });
});

describe("isSkyExposed", () => {
  it("is true with nothing above", () => {
    expect(isSkyExposed(0, 0, 0, new Map())).toBe(true);
  });

  it("is blocked by a floor plate above", () => {
    const occlusion = new Map([
      ["1:0,0", { opacity: 0, sealsLevel: true }],
    ]);
    expect(isSkyExposed(0, 0, 0, occlusion)).toBe(false);
    expect(isSkyExposed(0, 0, 1, occlusion)).toBe(true);
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

  it("half-decays through a half-block", () => {
    const occlusion = new Map([
      ["0:1,0", { opacity: 0.5, sealsLevel: true }],
    ]);
    expect(rayTransmission(0, 0, 0, 3, 0, 0, occlusion)).toBeCloseTo(0.5);
  });

  it("seals vertical travel through a floor plate", () => {
    const occlusion = new Map([
      ["1:0,0", { opacity: 0, sealsLevel: true }],
    ]);
    expect(rayTransmission(0, 0, 0, 0, 0, 2, occlusion)).toBe(0);
  });

  it("half-decays vertical travel through a half-block", () => {
    const occlusion = new Map([
      ["1:0,0", { opacity: 0.5, sealsLevel: true }],
    ]);
    expect(rayTransmission(0, 0, 0, 0, 0, 2, occlusion)).toBeCloseTo(0.5);
  });
});

describe("emitterCenter", () => {
  it("emits from the cell centre at floor level for a flat lit tile", () => {
    expect(
      emitterCenter(3, 4, 0, [{ tileId: "torch" }], 0, tilesById),
    ).toEqual({ fx: 3.5, fy: 4.5, fz: 0 });
  });

  it("raises Z by half the tile height", () => {
    const tall = tile({
      id: "lamp",
      height: 4,
      light: { radius: 4, intensity: 1, color: "#ffffff" },
    });
    const byId = { ...tilesById, lamp: tall };
    expect(emitterCenter(0, 0, 0, [{ tileId: "lamp" }], 0, byId)).toEqual({
      fx: 0.5,
      fy: 0.5,
      fz: 0.5,
    });
  });

  it("uses authored height for an intangible emitter", () => {
    const lamp = tile({
      id: "ghost-lamp",
      height: 4,
      intangible: true,
      light: { radius: 4, intensity: 1, color: "#ffffff" },
    });
    const byId = { ...tilesById, "ghost-lamp": lamp };
    expect(
      emitterCenter(0, 0, 0, [{ tileId: "ghost-lamp" }], 0, byId),
    ).toEqual({ fx: 0.5, fy: 0.5, fz: 0.5 });
  });

  it("accounts for standing on a half-block base", () => {
    expect(
      emitterCenter(
        0,
        0,
        0,
        [{ tileId: "half" }, { tileId: "torch" }],
        1,
        tilesById,
      ),
    ).toEqual({ fx: 0.5, fy: 0.5, fz: 0.5 });
  });
});

describe("computeLighting flood fill", () => {
  it("torch light seeps through a half-block at half strength", () => {
    const map = mapAt([
      { x: 0, y: 0, tiles: ["floor", "torch"] },
      { x: 1, y: 0, tiles: ["half"] },
      { x: 2, y: 0, tiles: ["floor"] },
    ]);
    const grid = computeLighting(map, tilesById, [0, 0, 0]);
    const level = grid.levels.get(0)!;
    const before = sampleLevelLight(level, 0, 0)[0];
    const after = sampleLevelLight(level, 2, 0)[0];
    expect(before).toBeGreaterThan(0.5);
    expect(after).toBeGreaterThan(0.05);
    expect(after).toBeLessThan(before);
  });

  it("contains torch light inside walls — no bleed past a full wall", () => {
    const map = mapAt([
      { x: 0, y: 0, tiles: ["floor", "torch"] },
      { x: 1, y: 0, tiles: ["floor"] },
      { x: 2, y: 0, tiles: ["wall"] },
      { x: 3, y: 0, tiles: ["floor"] },
    ]);
    const grid = computeLighting(map, tilesById, [0, 0, 0]);
    const level = grid.levels.get(0)!;
    const inside = sampleLevelLight(level, 1, 0)[0];
    const wallCell = sampleLevelLight(level, 2, 0)[0];
    const outside = sampleLevelLight(level, 3, 0)[0];
    expect(inside).toBeGreaterThan(0.5);
    // Solid wall stays dark (sky ambient is 0 in this bake).
    expect(wallCell).toBeLessThan(0.05);
    // Direct path through the wall is blocked — wrap-around is allowed but weaker.
    expect(outside).toBeLessThan(inside);
  });

  it("does not leak light to the floor above through a seal", () => {
    // Sealed shaft: torch below cannot wrap around to the roof via open air.
    const map = mapAt([
      { x: 0, y: 0, z: 0, tiles: ["floor", "torch"] },
      { x: 0, y: 0, z: 1, tiles: ["floor"] },
      { x: 1, y: 0, z: 0, tiles: ["wall"] },
      { x: -1, y: 0, z: 0, tiles: ["wall"] },
      { x: 0, y: 1, z: 0, tiles: ["wall"] },
      { x: 0, y: -1, z: 0, tiles: ["wall"] },
      { x: 1, y: 0, z: 1, tiles: ["wall"] },
      { x: -1, y: 0, z: 1, tiles: ["wall"] },
      { x: 0, y: 1, z: 1, tiles: ["wall"] },
      { x: 0, y: -1, z: 1, tiles: ["wall"] },
    ]);
    const grid = computeLighting(map, tilesById, [0, 0, 0]);
    expect(sampleLevelLight(grid.levels.get(1)!, 0, 0)[0]).toBe(0);
  });

  it("lights the floor below from a torch above (open shaft)", () => {
    const map = mapAt([
      { x: 0, y: 0, z: 1, tiles: ["torch"] },
      { x: 0, y: 0, z: 0, tiles: ["floor"] },
      { x: 1, y: 0, z: 0, tiles: ["floor"] },
    ]);
    const grid = computeLighting(map, tilesById, [0, 0, 0]);
    expect(sampleLevelLight(grid.levels.get(0)!, 0, 0)[0]).toBeGreaterThan(0.4);
  });

  it("daytime: sky-exposed walls, half-bricks, and trees get full daylight", () => {
    // Positive-height tiles are opaque to flood but must still receive the
    // vertical shaft so outdoor solids aren't baked black.
    const map = mapAt([
      { x: 0, y: 0, tiles: ["wall"] },
      { x: 1, y: 0, tiles: ["half"] },
      { x: 2, y: 0, tiles: ["floor"] },
      { x: 0, y: 1, tiles: ["floor"] },
    ]);
    const grid = computeLighting(map, tilesById, AMBIENT_PRESETS.day);
    const level = grid.levels.get(0)!;
    expect(sampleLevelLight(level, 0, 0)[0]).toBeCloseTo(1, 1);
    expect(sampleLevelLight(level, 1, 0)[0]).toBeCloseTo(1, 1);
    expect(sampleLevelLight(level, 2, 0)[0]).toBeCloseTo(1, 1);
  });

  it("daytime: solid under a sealed roof stays dark (cave wall)", () => {
    const map = mapAt([
      { x: 0, y: 0, z: 0, tiles: ["wall"] },
      { x: 0, y: 0, z: 1, tiles: ["floor"] },
    ]);
    const grid = computeLighting(map, tilesById, AMBIENT_PRESETS.day);
    expect(sampleLevelLight(grid.levels.get(0)!, 0, 0)[0]).toBeLessThan(0.15);
    expect(sampleLevelLight(grid.levels.get(1)!, 0, 0)[0]).toBeCloseTo(1, 1);
  });

  it("daytime: open cells get full sky; sealed caves stay dark", () => {
    const cells: Array<{ x: number; y: number; z?: number; tiles: string[] }> =
      [];
    for (let x = 0; x <= 2; x++) {
      for (let y = 0; y <= 2; y++) {
        cells.push({ x, y, z: 0, tiles: ["floor"] });
        cells.push({ x, y, z: 1, tiles: ["floor"] });
      }
    }
    for (let x = 0; x <= 2; x++) {
      cells.push({ x, y: 0, z: 0, tiles: ["floor", "wall"] });
      cells.push({ x, y: 2, z: 0, tiles: ["floor", "wall"] });
    }
    cells.push({ x: 0, y: 1, z: 0, tiles: ["floor", "wall"] });
    cells.push({ x: 2, y: 1, z: 0, tiles: ["floor", "wall"] });

    const map = mapAt(cells);
    const grid = computeLighting(map, tilesById, AMBIENT_PRESETS.day);
    expect(sampleLevelLight(grid.levels.get(1)!, 1, 1)[0]).toBeCloseTo(1, 1);
    expect(sampleLevelLight(grid.levels.get(0)!, 1, 1)[0]).toBeLessThan(0.15);
  });

  it("daytime: skylight hole is bright and spills to roofed neighbours", () => {
    const cells: Array<{ x: number; y: number; z?: number; tiles: string[] }> =
      [
        { x: 0, y: 0, z: 0, tiles: ["floor"] },
        { x: 1, y: 0, z: 0, tiles: ["floor"] },
        { x: 2, y: 0, z: 0, tiles: ["floor"] },
        { x: 0, y: 0, z: 1, tiles: ["floor"] },
        { x: 2, y: 0, z: 1, tiles: ["floor"] },
        { x: 0, y: 1, z: 0, tiles: ["wall"] },
        { x: 1, y: 1, z: 0, tiles: ["wall"] },
        { x: 2, y: 1, z: 0, tiles: ["wall"] },
        { x: 0, y: -1, z: 0, tiles: ["wall"] },
        { x: 1, y: -1, z: 0, tiles: ["wall"] },
        { x: 2, y: -1, z: 0, tiles: ["wall"] },
        { x: -1, y: 0, z: 0, tiles: ["wall"] },
        { x: 3, y: 0, z: 0, tiles: ["wall"] },
      ];
    const map = mapAt(cells);
    const grid = computeLighting(map, tilesById, AMBIENT_PRESETS.day);
    const level = grid.levels.get(0)!;
    const hole = sampleLevelLight(level, 1, 0);
    const underRoof = sampleLevelLight(level, 0, 0);
    expect(hole[0]).toBeCloseTo(1, 1);
    expect(underRoof[0]).toBeGreaterThan(0.05);
    expect(underRoof[0]).toBeLessThan(hole[0]);
  });

  it("daytime: sky spill wraps around walls via open air (diagonal flood)", () => {
    // Incomplete wall boxes don't isolate rooms once sky floods the exterior;
    // Euclidean diagonals make wrap-around brighter than Manhattan, but the
    // wall still blocks the direct path so the next room stays below full sky.
    const map = mapAt([
      { x: 0, y: 0, z: 0, tiles: ["floor"] },
      { x: 1, y: 0, z: 0, tiles: ["wall"] },
      { x: 2, y: 0, z: 0, tiles: ["floor"] },
      { x: 2, y: 0, z: 1, tiles: ["floor"] },
      { x: 0, y: 1, z: 0, tiles: ["wall"] },
      { x: 1, y: 1, z: 0, tiles: ["wall"] },
      { x: 2, y: 1, z: 0, tiles: ["wall"] },
      { x: 0, y: -1, z: 0, tiles: ["wall"] },
      { x: 1, y: -1, z: 0, tiles: ["wall"] },
      { x: 2, y: -1, z: 0, tiles: ["wall"] },
      { x: -1, y: 0, z: 0, tiles: ["wall"] },
      { x: 3, y: 0, z: 0, tiles: ["wall"] },
    ]);
    const grid = computeLighting(map, tilesById, AMBIENT_PRESETS.day);
    const level = grid.levels.get(0)!;
    const open = sampleLevelLight(level, 0, 0)[0];
    const nextRoom = sampleLevelLight(level, 2, 0)[0];
    expect(open).toBeCloseTo(1, 1);
    expect(nextRoom).toBeLessThan(open);
  });

  it("night: outdoor sky still glows dimly; buried caves are darker", () => {
    const cells: Array<{ x: number; y: number; z?: number; tiles: string[] }> =
      [];
    for (let x = 0; x <= 2; x++) {
      for (let y = 0; y <= 2; y++) {
        cells.push({ x, y, z: 0, tiles: ["floor"] });
        cells.push({ x, y, z: 1, tiles: ["floor"] });
      }
    }
    for (let x = 0; x <= 2; x++) {
      cells.push({ x, y: 0, z: 0, tiles: ["floor", "wall"] });
      cells.push({ x, y: 2, z: 0, tiles: ["floor", "wall"] });
    }
    cells.push({ x: 0, y: 1, z: 0, tiles: ["floor", "wall"] });
    cells.push({ x: 2, y: 1, z: 0, tiles: ["floor", "wall"] });

    const map = mapAt(cells);
    const grid = computeLighting(map, tilesById, AMBIENT_PRESETS.night);
    expect(sampleLevelLight(grid.levels.get(1)!, 1, 1)[0]).toBeCloseTo(
      AMBIENT_PRESETS.night[0],
      1,
    );
    expect(sampleLevelLight(grid.levels.get(0)!, 1, 1)[0]).toBeLessThan(
      AMBIENT_PRESETS.night[0] * 0.5 + 0.02,
    );
  });

  it("torch still lights a buried cave at night", () => {
    const cells: Array<{ x: number; y: number; z?: number; tiles: string[] }> =
      [];
    for (let x = 0; x <= 2; x++) {
      for (let y = 0; y <= 2; y++) {
        cells.push({ x, y, z: 0, tiles: ["floor"] });
        cells.push({ x, y, z: 1, tiles: ["floor"] });
      }
    }
    for (let x = 0; x <= 2; x++) {
      cells.push({ x, y: 0, z: 0, tiles: ["floor", "wall"] });
      cells.push({ x, y: 2, z: 0, tiles: ["floor", "wall"] });
    }
    cells.push({ x: 0, y: 1, z: 0, tiles: ["floor", "wall"] });
    cells.push({ x: 2, y: 1, z: 0, tiles: ["floor", "wall"] });
    cells.push({ x: 1, y: 1, z: 0, tiles: ["floor", "torch"] });

    const map = mapAt(cells);
    const grid = computeLighting(map, tilesById, AMBIENT_PRESETS.night);
    expect(sampleLevelLight(grid.levels.get(0)!, 1, 1)[0]).toBeGreaterThan(0.5);
  });

  it("overlayEmitterOverrides respects a wall out near the radius edge", () => {
    // The overlay only gathers occluders within the emitter's reach. A wall
    // three cells out, shadowing a target near the rim, is exactly what a
    // too-tight reach box would miss — the target would come back lit.
    const map = mapAt([
      { x: 0, y: 0, tiles: ["floor", "torch"] },
      { x: 1, y: 0, tiles: ["floor"] },
      { x: 2, y: 0, tiles: ["floor", "wall"] },
      { x: 3, y: 0, tiles: ["floor"] },
    ]);
    const omit = new Set(["torch"]);
    const staticGrid = computeLighting(map, tilesById, [0, 0, 0], undefined, omit);
    const painted = overlayEmitterOverrides(staticGrid, map, tilesById, [
      { x: 0, y: 0, z: 0, fx: 0.5, fy: 0.5, fz: 0 },
    ]);

    // Open cell before the wall is lit; the one it shadows is not.
    expect(sampleLevelLight(painted.levels.get(0)!, 1, 0)[0]).toBeGreaterThan(0);
    expect(sampleLevelLight(painted.levels.get(0)!, 3, 0)[0]).toBe(0);
  });

  it("overlayEmitterOverrides lights the whole radius, not a clipped box", () => {
    // Torch radius is 4, so cell 3 must still receive light. A reach box built
    // from anything smaller than the radius would cut this short.
    const cells = [{ x: 0, y: 0, tiles: ["floor", "torch"] }];
    for (let x = 1; x <= 6; x++) cells.push({ x, y: 0, tiles: ["floor"] });
    const map = mapAt(cells);
    const omit = new Set(["torch"]);
    const staticGrid = computeLighting(map, tilesById, [0, 0, 0], undefined, omit);
    const painted = overlayEmitterOverrides(staticGrid, map, tilesById, [
      { x: 0, y: 0, z: 0, fx: 0.5, fy: 0.5, fz: 0 },
    ]);

    const level = painted.levels.get(0)!;
    expect(sampleLevelLight(level, 3, 0)[0]).toBeGreaterThan(0);
    // Falls off with distance rather than ending abruptly.
    expect(sampleLevelLight(level, 1, 0)[0]).toBeGreaterThan(
      sampleLevelLight(level, 3, 0)[0],
    );
  });

  it("overlayEmitterOverrides adds an omitted player-style light", () => {
    const map = mapAt([
      { x: 0, y: 0, tiles: ["floor", "torch"] },
      { x: 1, y: 0, tiles: ["floor"] },
    ]);
    const omit = new Set(["torch"]);
    const staticGrid = computeLighting(map, tilesById, [0, 0, 0], undefined, omit);
    expect(sampleLevelLight(staticGrid.levels.get(0)!, 0, 0)[0]).toBe(0);
    const painted = overlayEmitterOverrides(staticGrid, map, tilesById, [
      { x: 0, y: 0, z: 0, fx: 0.5, fy: 0.5, fz: 0 },
    ]);
    expect(sampleLevelLight(painted.levels.get(0)!, 0, 0)[0]).toBeGreaterThan(
      0.5,
    );
  });

  // A torch in somebody's bag is not on the board — that is the whole item
  // model — so there is no cell to look it up in and no tile for the bake to
  // omit. The override has to carry the light itself, and this is the case that
  // says so: an empty floor, lit by a lantern nothing is standing on.
  it("overlayEmitterOverrides casts lights the override carries itself", () => {
    const map = mapAt([
      { x: 0, y: 0, tiles: ["floor"] },
      { x: 1, y: 0, tiles: ["floor"] },
    ]);
    const staticGrid = computeLighting(map, tilesById, [0, 0, 0]);
    expect(sampleLevelLight(staticGrid.levels.get(0)!, 0, 0)[0]).toBe(0);

    const painted = overlayEmitterOverrides(staticGrid, map, tilesById, [
      {
        x: 0,
        y: 0,
        z: 0,
        fx: 0.5,
        fy: 0.5,
        fz: 0,
        lights: [{ radius: 4, intensity: 1, color: "#ffffff" }],
      },
    ]);
    expect(sampleLevelLight(painted.levels.get(0)!, 0, 0)[0]).toBeGreaterThan(
      0.5,
    );
    expect(sampleLevelLight(painted.levels.get(0)!, 1, 0)[0]).toBeGreaterThan(0);
  });

  // Two lanterns is twice the light, and it falls out of the cast accumulating
  // rather than out of a blending rule anybody had to invent.
  it("overlayEmitterOverrides sums several carried lights at one position", () => {
    const map = mapAt([{ x: 0, y: 0, tiles: ["floor"] }]);
    const staticGrid = computeLighting(map, tilesById, [0, 0, 0]);
    const dim = { radius: 4, intensity: 0.2, color: "#ffffff" };
    const at = { x: 0, y: 0, z: 0, fx: 0.5, fy: 0.5, fz: 0 };

    const one = overlayEmitterOverrides(staticGrid, map, tilesById, [
      { ...at, lights: [dim] },
    ]);
    const two = overlayEmitterOverrides(staticGrid, map, tilesById, [
      { ...at, lights: [dim, dim] },
    ]);
    expect(sampleLevelLight(two.levels.get(0)!, 0, 0)[0]).toBeGreaterThan(
      sampleLevelLight(one.levels.get(0)!, 0, 0)[0],
    );
  });

  // The point of the whole path: a carried light is painted over the bake, so
  // the map it is cast against is untouched and the chunks nobody edited stay
  // the objects they were. That identity is what `ChunkedLighting` re-bakes on.
  it("overlayEmitterOverrides leaves the map it lights alone", () => {
    const map = mapAt([{ x: 0, y: 0, tiles: ["floor"] }]);
    const staticGrid = computeLighting(map, tilesById, [0, 0, 0]);
    const before = map.levels[levelKey(0)];
    overlayEmitterOverrides(staticGrid, map, tilesById, [
      {
        x: 0,
        y: 0,
        z: 0,
        fx: 0.5,
        fy: 0.5,
        fz: 0,
        lights: [{ radius: 4, intensity: 1, color: "#ffffff" }],
      },
    ]);
    expect(map.levels[levelKey(0)]).toBe(before);
  });

  it(`uses MAX_LIGHT_LEVEL=${MAX_LIGHT_LEVEL}`, () => {
    expect(MAX_LIGHT_LEVEL).toBe(15);
  });
});
