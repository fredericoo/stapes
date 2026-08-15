import { describe, expect, it } from "vitest";
import { chunkifyMap } from "./mapData";
import type { FlatMapFile } from "./types";
import {
  AUTOTILE_SLICE_MASKS,
  blobMaskToSlice,
  blobSliceCount,
  maskBlobCorners,
  neighborMask,
  pickAutotileSprite,
  resolveAutotileSlice,
  N,
  NE,
  E,
  SE,
  S,
  SW,
  W,
  NW,
} from "./autotile";
import type { MapFile, TileDef } from "./types";
import { coordKey, levelKey } from "./types";

describe("autotile blob", () => {
  it("produces 47 unique slices", () => {
    expect(blobSliceCount()).toBe(47);
  });

  it("maps isolated (0) to slice 0", () => {
    expect(blobMaskToSlice(0)).toBe(0);
  });

  it("clears corner bits when edges are missing", () => {
    // Only NE present — both N and E missing → corner cleared
    expect(maskBlobCorners(NE)).toBe(0);
    // N+E+NE → NE kept
    expect(maskBlobCorners(N | E | NE)).toBe(N | E | NE);
    // N+NE without E → NE cleared
    expect(maskBlobCorners(N | NE)).toBe(N);
  });

  it("exposes a representative mask for every slice", () => {
    expect(AUTOTILE_SLICE_MASKS).toHaveLength(47);
    expect(AUTOTILE_SLICE_MASKS[0]).toBe(0);
    for (let i = 0; i < 47; i++) {
      expect(blobMaskToSlice(AUTOTILE_SLICE_MASKS[i]!)).toBe(i);
    }
  });
});

function mapWith(
  cells: { x: number; y: number; z?: number; tileId: string }[],
): MapFile {
  const levels: FlatMapFile["levels"] = {};
  for (const c of cells) {
    const z = c.z ?? 0;
    const lk = levelKey(z);
    const ck = coordKey(c.x, c.y);
    if (!levels[lk]) levels[lk] = {};
    if (!levels[lk][ck]) levels[lk][ck] = [];
    levels[lk][ck].push({ tileId: c.tileId });
  }
  return chunkifyMap({ version: 1, levels });
}

describe("neighbor matching", () => {
  it("sets N bit when north neighbor has same tileId", () => {
    const map = mapWith([
      { x: 0, y: 0, tileId: "grass" },
      { x: 0, y: -1, tileId: "grass" },
    ]);
    expect(neighborMask(map, 0, 0, 0, "grass")).toBe(N);
  });

  it("ignores different tileIds", () => {
    const map = mapWith([
      { x: 0, y: 0, tileId: "grass" },
      { x: 0, y: -1, tileId: "dirt" },
    ]);
    expect(neighborMask(map, 0, 0, 0, "grass")).toBe(0);
  });

  it("resolveAutotileSlice uses blob mapping", () => {
    const map = mapWith([
      { x: 0, y: 0, tileId: "g" },
      { x: 0, y: -1, tileId: "g" },
      { x: 1, y: 0, tileId: "g" },
    ]);
    expect(resolveAutotileSlice(map, 0, 0, 0, "g")).toBe(
      blobMaskToSlice(N | E),
    );
  });
});

describe("pickAutotileSprite", () => {
  const frame = (id: string) => ({
    sprite: {
      tilesetId: "t",
      rect: { x: 0, y: 0, w: 1, h: 1 },
      base: { x: 0, y: 0 },
    },
    durationMs: 200,
    // tag via tileset — actually use duration as marker; use light color
    light: { radius: 1, intensity: 1, color: id },
  });

  const tile: TileDef = {
    id: "auto",
    name: "Auto",
    height: 0,
    type: "autotile",
    kind: "prop",
    attributes: {},
    slices: {
      0: { frames: [frame("#000000")] },
      5: { frames: [frame("#050505")] },
    },
  };

  it("returns the exact slice when present", () => {
    expect(pickAutotileSprite(tile, 5)?.frames[0].light?.color).toBe("#050505");
  });

  it("falls back to slice 0 when missing", () => {
    expect(pickAutotileSprite(tile, 12)?.frames[0].light?.color).toBe("#000000");
  });
});
