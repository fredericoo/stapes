import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import { chunkifyMap } from "./mapData";
import { resolveTileSprite } from "./tileResolve";
import { normalizeTiles } from "./types";
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
    expect(neighborMask(map, 0, 0, 0, { id: "grass" })).toBe(N);
  });

  it("ignores different tileIds", () => {
    const map = mapWith([
      { x: 0, y: 0, tileId: "grass" },
      { x: 0, y: -1, tileId: "dirt" },
    ]);
    expect(neighborMask(map, 0, 0, 0, { id: "grass" })).toBe(0);
  });

  it("resolveAutotileSlice uses blob mapping", () => {
    const map = mapWith([
      { x: 0, y: 0, tileId: "g" },
      { x: 0, y: -1, tileId: "g" },
      { x: 1, y: 0, tileId: "g" },
    ]);
    expect(resolveAutotileSlice(map, 0, 0, 0, { id: "g" })).toBe(
      blobMaskToSlice(N | E),
    );
  });

  it("counts a connectsTo neighbour as itself", () => {
    const map = mapWith([
      { x: 0, y: 0, tileId: "grass" },
      { x: 0, y: -1, tileId: "dirt" },
    ]);
    expect(neighborMask(map, 0, 0, 0, { id: "grass", connectsTo: ["dirt"] })).toBe(N);
  });

  it("sees a connectsTo neighbour anywhere in the stack", () => {
    const map = mapWith([
      { x: 0, y: 0, tileId: "grass" },
      { x: 0, y: -1, tileId: "water" },
      { x: 0, y: -1, tileId: "dirt" },
    ]);
    expect(neighborMask(map, 0, 0, 0, { id: "grass", connectsTo: ["dirt"] })).toBe(N);
  });

  it("does not connect back the other way", () => {
    const map = mapWith([
      { x: 0, y: 0, tileId: "dirt" },
      { x: 0, y: -1, tileId: "grass" },
    ]);
    expect(neighborMask(map, 0, 0, 0, { id: "dirt" })).toBe(0);
  });

  it("ignores a connectsTo id that is nowhere nearby", () => {
    const map = mapWith([
      { x: 0, y: 0, tileId: "grass" },
      { x: 0, y: -1, tileId: "stone" },
    ]);
    expect(neighborMask(map, 0, 0, 0, { id: "grass", connectsTo: ["dirt"] })).toBe(0);
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
    expect(pickAutotileSprite(tile, 5)?.frames[0]!.light?.color).toBe("#050505");
  });

  it("falls back to slice 0 when missing", () => {
    expect(pickAutotileSprite(tile, 12)?.frames[0]!.light?.color).toBe("#000000");
  });
});

/**
 * The wooden floor's inner block, as authored, against the real `tiles.json`.
 *
 * The inset floor and its complement have to agree on *which* neighbourhood
 * they are in, or the two halves are drawn for different shapes and meet in a
 * seam. Nothing in the data says so: the agreement is produced entirely by the
 * inner tile naming the floor in `connectsTo`, which is what makes it read the
 * stack it sits on as more of itself. The last test here is the one that would
 * actually catch its removal — an author paints the inner tile on the ring
 * hugging an opening and nowhere else, so an inner tile left to autotile
 * against its own placements sees a thin ring where the floor sees a field.
 */
describe("wooden floor inner", () => {
  const tiles = normalizeTiles(tilesJson as unknown[]);
  const byId = Object.fromEntries(tiles.map((t) => [t.id, t]));
  const floor = byId["wooden-floor"]!;
  const inner = byId["wooden-floor-inner"]!;

  const HOLE = { x: 2, y: 2 };
  const FIELD = 5;

  /** The cells an author would close: the ring touching the opening. */
  const RING = [-1, 0, 1]
    .flatMap((dy) => [-1, 0, 1].map((dx) => ({ x: HOLE.x + dx, y: HOLE.y + dy })))
    .filter((c) => !(c.x === HOLE.x && c.y === HOLE.y));

  /** A field of floor with one cell cut out, inner painted only on the ring. */
  function ringMap() {
    const cells: { x: number; y: number; tileId: string }[] = [];
    for (let y = 0; y < FIELD; y++) {
      for (let x = 0; x < FIELD; x++) {
        if (x === HOLE.x && y === HOLE.y) continue;
        cells.push({ x, y, tileId: "wooden-floor" });
      }
    }
    for (const c of RING) {
      cells.push({ x: c.x, y: c.y, tileId: "wooden-floor-inner" });
    }
    return mapWith(cells);
  }

  const rectOf = (tile: TileDef, ctx: Parameters<typeof resolveTileSprite>[1]) =>
    resolveTileSprite(tile, ctx)!.frames[0]!.sprite.rect;

  it("connects to the floor it sits on", () => {
    expect(inner.connectsTo).toContain("wooden-floor");
  });

  it("covers every slice the floor does", () => {
    expect(Object.keys(inner.slices ?? {}).sort()).toEqual(
      Object.keys(floor.slices ?? {}).sort(),
    );
  });

  it("reads the same neighbourhood as the floor beneath it", () => {
    const map = ringMap();
    for (const c of RING) {
      expect(neighborMask(map, c.x, c.y, 0, inner)).toBe(
        neighborMask(map, c.x, c.y, 0, floor),
      );
    }
  });

  it("draws the complement cell of whatever the floor draws", () => {
    const map = ringMap();
    const COMPLEMENT_COL_OFFSET = 8;
    for (const c of RING) {
      const ctx = { map, x: c.x, y: c.y, z: 0 };
      const base = rectOf(floor, ctx);
      expect(rectOf(inner, ctx)).toEqual({
        ...base,
        x: base.x + COMPLEMENT_COL_OFFSET,
      });
    }
  });

  it("misreads the neighbourhood without connectsTo", () => {
    const map = ringMap();
    const orphan = { id: inner.id };
    const disagreeing = RING.filter(
      (c) =>
        neighborMask(map, c.x, c.y, 0, orphan) !==
        neighborMask(map, c.x, c.y, 0, floor),
    );
    expect(disagreeing.length).toBe(RING.length);
  });
});
