import { describe, expect, it } from "vitest";
import { tile } from "../lib/testTile";
import { chunkifyMap, replaceStack } from "../lib/mapData";
import { MAP_FILE_VERSION, coordKey, levelKey } from "../lib/types";
import type { FlatMapFile, MapFile, TileDef } from "../lib/types";
import {
  MAX_REFLECTIVE_TILES,
  REFLECTION_LEVELS_BELOW,
  REFLECTION_REACH_CELLS,
  ReflectiveCells,
  mirrorUvShift,
  reflectiveTileIndex,
} from "./reflections";

const MIRROR = { colors: ["#335c8c"], opacity: 0.4, fadePx: 24, turbulence: 1 };

const tiles: Record<string, TileDef> = {
  grass: tile({ id: "grass" }),
  rock: tile({ id: "rock", height: 2 }),
  water: tile({ id: "water", reflective: MIRROR }),
};

function mapAt(cells: Array<{ x: number; y: number; z?: number; tiles: string[] }>): MapFile {
  const levels: FlatMapFile["levels"] = {};
  for (const c of cells) {
    const lk = levelKey(c.z ?? 0);
    levels[lk] ??= {};
    levels[lk][coordKey(c.x, c.y)] = c.tiles.map((tileId) => ({ tileId }));
  }
  return chunkifyMap({ version: MAP_FILE_VERSION, levels });
}

function cellsFor(byId: Record<string, TileDef>) {
  return new ReflectiveCells(byId, reflectiveTileIndex(byId));
}

describe("reflectiveTileIndex", () => {
  it("numbers reflective tiles from one in id order, skipping tiles with no mirror colours", () => {
    const index = reflectiveTileIndex({
      water: tile({ id: "water", reflective: MIRROR }),
      grass: tile({ id: "grass" }),
      ice: tile({ id: "ice", reflective: MIRROR }),
      blank: tile({ id: "blank", reflective: { ...MIRROR, colors: [] } }),
    });
    expect([...index]).toEqual([
      ["ice", 1],
      ["water", 2],
    ]);
  });

  it("keeps only as many tiles as the shader has slots for", () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_REFLECTIVE_TILES + 2 }, (_, i) => {
        const id = `pool-${String(i).padStart(2, "0")}`;
        return [id, tile({ id, reflective: MIRROR })];
      }),
    );
    expect(reflectiveTileIndex(many).size).toBe(MAX_REFLECTIVE_TILES);
  });
});

describe("ReflectiveCells.waterlineNear", () => {
  it("finds water south-east of a thing within reach, and none beyond it", () => {
    const near = mapAt([
      { x: REFLECTION_REACH_CELLS, y: REFLECTION_REACH_CELLS, tiles: ["water"] },
    ]);
    const far = mapAt([{ x: REFLECTION_REACH_CELLS + 1, y: 0, tiles: ["water"] }]);
    expect(cellsFor(tiles).waterlineNear(near, 0, 0, 0)).not.toBeNull();
    expect(cellsFor(tiles).waterlineNear(far, 0, 0, 0)).toBeNull();
  });

  it("picks the nearest water when two pools sit at different heights", () => {
    const map = mapAt([
      { x: 1, y: 0, tiles: ["rock", "water"] },
      { x: 3, y: 0, tiles: ["water"] },
    ]);
    const lowOnly = mapAt([{ x: 3, y: 0, tiles: ["water"] }]);
    const cells = cellsFor(tiles);
    expect(cells.waterlineNear(map, 0, 0, 0)).toBeGreaterThan(
      cells.waterlineNear(lowOnly, 0, 0, 0)!,
    );
  });

  it("finds water on a level below for an upper storey", () => {
    const map = mapAt([{ x: 1, y: 1, z: 0, tiles: ["water"] }]);
    const cells = cellsFor(tiles);
    expect(cells.waterlineNear(map, 0, 0, REFLECTION_LEVELS_BELOW)).not.toBeNull();
    expect(cells.waterlineNear(map, 0, 0, REFLECTION_LEVELS_BELOW + 1)).toBeNull();
  });

  it("finds nothing when no tile is reflective", () => {
    const map = mapAt([{ x: 1, y: 0, tiles: ["water"] }]);
    const plain = { ...tiles, water: tile({ id: "water" }) };
    expect(cellsFor(plain).waterlineNear(map, 0, 0, 0)).toBeNull();
  });
});

describe("ReflectiveCells.changedChunks", () => {
  it("reports a chunk only when its reflective cells change", () => {
    const before = mapAt([{ x: 0, y: 0, tiles: ["grass"] }]);
    const cells = cellsFor(tiles);
    const grassMoved = replaceStack(before, 1, 0, 0, [{ tileId: "grass" }]);
    const waterAdded = replaceStack(before, 1, 0, 0, [{ tileId: "water" }]);
    expect(cells.changedChunks(before, grassMoved, 0)).toEqual([]);
    expect(cells.changedChunks(before, waterAdded, 0)).toHaveLength(1);
  });
});

describe("mirrorUvShift", () => {
  const SHEET = { id: "sheet", name: "sheet", file: "sheet.png", width: 128, height: 64 };
  const facing = (x: number, y: number, base = { x: 3, y: 3 }) => ({
    frames: [{ sprite: { rect: { x, y, w: 4, h: 4 }, base }, durationMs: 200 }],
  });
  const body = (west = facing(12, 4)) =>
    tile({
      id: "body",
      type: "directional",
      anchor: { tilesetId: "sheet", x: 0, y: 0 },
      sprites: { n: facing(4, 0), e: facing(12, 0), s: facing(4, 4), w: west },
    });

  it("points an east-facing frame at the west-facing art, and back", () => {
    const def = body();
    const east = def.sprites!.e!.frames[0]!;
    const west = def.sprites!.w!.frames[0]!;
    expect(mirrorUvShift(def, east, SHEET)).toEqual([0, -32 / 64]);
    expect(mirrorUvShift(def, west, SHEET)).toEqual([0, 32 / 64]);
  });

  it("leaves north and south as they are", () => {
    const def = body();
    expect(mirrorUvShift(def, def.sprites!.n!.frames[0]!, SHEET)).toEqual([0, 0]);
    expect(mirrorUvShift(def, def.sprites!.s!.frames[0]!, SHEET)).toEqual([0, 0]);
  });

  it("does not swap to opposite art standing on a different base cell", () => {
    const def = body(facing(12, 4, { x: 0, y: 3 }));
    expect(mirrorUvShift(def, def.sprites!.e!.frames[0]!, SHEET)).toEqual([0, 0]);
  });
});
