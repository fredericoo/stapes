import { describe, expect, it } from "vitest";
import { chunkifyMap, listCoords } from "./mapData";
import type { FlatMapFile } from "./types";
import map from "../../data/map.json";
import tiles from "../../data/tiles.json";
import { AMBIENT_PRESETS, computeLighting, sampleLevelLight } from "./lighting";
import {
  ChunkedLighting,
  LIGHT_APRON,
  LIGHT_CHUNK_SIZE,
  type WorldRect,
} from "./lightingChunks";
import { PLAYER_TILE_ID } from "../game/constants";
import type { MapFile, TileDef } from "./types";
import { MAX_LEVEL, MIN_LEVEL, levelKey, parseCoordKey } from "./types";

const tilesById = Object.fromEntries(
  (tiles as TileDef[]).map((t) => [t.id, t]),
) as Record<string, TileDef>;
const mapFile = chunkifyMap(map as FlatMapFile);
const omit = new Set([PLAYER_TILE_ID]);

/** Bounding box of everything placed on the fixture map. */
function mapBounds(m: MapFile): WorldRect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    if (!m.levels[levelKey(z)]) continue;
    for (const { x, y } of listCoords(m, z)) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return { x0, y0, x1, y1 };
}

describe("chunked lighting", () => {
  const ambient = [...AMBIENT_PRESETS.night] as [number, number, number];

  it("matches the monolithic bake cell for cell", () => {
    const mono = computeLighting(mapFile, tilesById, ambient, undefined, omit);
    const chunked = new ChunkedLighting(tilesById, omit);
    const bounds = mapBounds(mapFile);

    // Fill one chunk at a time. Requesting the whole area at once would batch
    // into a single bake spanning everything, which reproduces the monolithic
    // result by construction and proves nothing about the apron. Chunks really
    // are baked apart from each other as the player walks, so that is the case
    // parity has to hold for.
    const chunkOf = (v: number) => Math.floor(v / LIGHT_CHUNK_SIZE);
    for (let cy = chunkOf(bounds.y0); cy <= chunkOf(bounds.y1); cy++) {
      for (let cx = chunkOf(bounds.x0); cx <= chunkOf(bounds.x1); cx++) {
        const x = cx * LIGHT_CHUNK_SIZE;
        const y = cy * LIGHT_CHUNK_SIZE;
        chunked.gridFor(mapFile, ambient, { x0: x, y0: y, x1: x, y1: y });
      }
    }
    const grid = chunked.gridFor(mapFile, ambient, bounds);
    expect(
      chunked.bakedLastCall,
      "assembly should have been fully cached by the per-chunk fills",
    ).toBe(0);

    let compared = 0;
    let differing = 0;
    let maxDelta = 0;
    for (const [z, monoLevel] of mono.levels) {
      const chunkLevel = grid.levels.get(z);
      // Every level the monolith lit must exist in the assembled grid, or
      // geometry there would sample black.
      expect(chunkLevel, `level ${z} missing from chunked grid`).toBeDefined();
      if (!chunkLevel) continue;
      for (let y = bounds.y0; y <= bounds.y1; y++) {
        for (let x = bounds.x0; x <= bounds.x1; x++) {
          const a = sampleLevelLight(monoLevel, x, y);
          const b = sampleLevelLight(chunkLevel, x, y);
          for (let c = 0; c < 3; c++) {
            compared++;
            const d = Math.abs(a[c]! - b[c]!) * 255;
            if (d > 0.5) differing++;
            if (d > maxDelta) maxDelta = d;
          }
        }
      }
    }

    expect(compared).toBeGreaterThan(100_000);
    expect(
      differing,
      `${differing}/${compared} samples differ, max delta ${maxDelta.toFixed(1)}/255`,
    ).toBe(0);
  });

  it("serves a second identical request entirely from cache", () => {
    const chunked = new ChunkedLighting(tilesById, omit);
    const rect: WorldRect = { x0: 0, y0: 0, x1: 40, y1: 40 };
    chunked.gridFor(mapFile, ambient, rect);
    const filled = chunked.bakedLastCall;
    expect(filled).toBeGreaterThan(0);

    chunked.gridFor(mapFile, ambient, rect);
    expect(chunked.bakedLastCall).toBe(0);
  });

  it("keeps walking free until the window crosses a chunk edge", () => {
    const chunked = new ChunkedLighting(tilesById, omit);
    const width = 40;
    let baked = 0;
    for (let step = 0; step < LIGHT_CHUNK_SIZE; step++) {
      chunked.gridFor(mapFile, ambient, {
        x0: step,
        y0: 0,
        x1: step + width,
        y1: width,
      });
      baked += chunked.bakedLastCall;
    }
    // Cold fill plus at most one column of chunks as the window slides a full
    // chunk east — never a rebake per step.
    expect(baked).toBeLessThanOrEqual(20);
  });

  it("an edit dirties only chunks within light reach", () => {
    const chunked = new ChunkedLighting(tilesById, omit);
    const rect: WorldRect = { x0: -64, y0: -64, x1: 64, y1: 64 };
    chunked.gridFor(mapFile, ambient, rect);
    const before = chunked.cachedChunks;

    chunked.invalidateAt(0, 0);
    const dropped = before - chunked.cachedChunks;

    // A point edit reaches LIGHT_APRON cells, so it can span at most a 2x2 of
    // chunks — provided the apron is not wider than a chunk.
    expect(LIGHT_APRON).toBeLessThan(LIGHT_CHUNK_SIZE);
    expect(dropped).toBeGreaterThan(0);
    expect(dropped).toBeLessThanOrEqual(4);
  });

  it("keeps window chunks cached when ambient changes", () => {
    const chunked = new ChunkedLighting(tilesById, omit);
    const rect: WorldRect = { x0: 0, y0: 0, x1: 40, y1: 40 };
    chunked.gridFor(mapFile, ambient, rect);
    const cached = chunked.cachedChunks;
    expect(cached).toBeGreaterThan(0);

    const dayGrid = chunked.gridFor(mapFile, [...AMBIENT_PRESETS.day], rect);
    // No window bake — ambient is a compose-time tint. Prefetch may still
    // trickle one ring chunk on an otherwise idle call.
    expect(chunked.bakedLastCall).toBe(0);
    expect(chunked.cachedChunks).toBeGreaterThanOrEqual(cached);
    // Recompose must produce a new grid identity so uploaders refresh textures.
    const nightGrid = chunked.gridFor(mapFile, ambient, rect);
    expect(dayGrid).not.toBe(nightGrid);
  });
});

describe("chunked lighting prefetch and eviction", () => {
  const ambient = [...AMBIENT_PRESETS.night] as [number, number, number];
  const window40 = (x: number): WorldRect => ({ x0: x, y0: 0, x1: x + 40, y1: 40 });

  /** Hold the window still long enough for the ring trickle to catch up. */
  function idle(c: ChunkedLighting, rect: WorldRect, calls: number) {
    for (let i = 0; i < calls; i++) c.gridFor(mapFile, ambient, rect);
  }

  it("warms the ring so crossing a chunk edge bakes nothing", () => {
    const chunked = new ChunkedLighting(tilesById, omit);
    chunked.gridFor(mapFile, ambient, window40(0));
    idle(chunked, window40(0), 40);

    // Walk east until the window's leading chunk index changes.
    const chunkOf = (v: number) => Math.floor(v / LIGHT_CHUNK_SIZE);
    const startEdge = chunkOf(40);
    let crossed = 0;
    let bakedOnCrossing = 0;
    for (let x = 1; x <= LIGHT_CHUNK_SIZE * 2; x++) {
      chunked.gridFor(mapFile, ambient, window40(x));
      if (chunkOf(x + 40) === startEdge + crossed) continue;
      crossed++;
      bakedOnCrossing += chunked.bakedLastCall;
    }

    expect(crossed).toBeGreaterThan(0);
    expect(
      bakedOnCrossing,
      "prefetch should have covered every chunk the window walked into",
    ).toBe(0);
  });

  it("does not prefetch on a call that already had to bake", () => {
    const chunked = new ChunkedLighting(tilesById, omit);
    chunked.gridFor(mapFile, ambient, window40(0));
    const afterCold = chunked.cachedChunks;

    // Cold fill bakes the window; the ring must wait for a quiet call so the
    // two costs never land on the same frame.
    expect(chunked.bakedLastCall).toBeGreaterThan(0);

    chunked.gridFor(mapFile, ambient, window40(0));
    expect(chunked.cachedChunks).toBeGreaterThan(afterCold);
  });

  it("caps the cache and keeps the window resident", () => {
    const cap = 12;
    const chunked = new ChunkedLighting(tilesById, omit, cap);
    for (let x = 0; x < 600; x += 8) {
      chunked.gridFor(mapFile, ambient, window40(x));
    }
    expect(chunked.cachedChunks).toBeLessThanOrEqual(cap);

    // The window it settled on must have survived its own eviction pass.
    chunked.gridFor(mapFile, ambient, window40(592));
    expect(chunked.bakedLastCall).toBe(0);
  });

  it("never evicts a chunk the current window is drawing", () => {
    // A cap tighter than the window would thrash; this asserts the guard, not
    // that such a cap is sane.
    const chunked = new ChunkedLighting(tilesById, omit, 1);
    chunked.gridFor(mapFile, ambient, window40(0));
    const resident = chunked.cachedChunks;
    expect(resident).toBeGreaterThan(1);

    chunked.gridFor(mapFile, ambient, window40(0));
    expect(chunked.bakedLastCall).toBe(0);
  });
});

describe("packed grid matches CPU-composed output", () => {
  /** What the fragment shader does: `min(1, a * ambient + rgb)`. */
  function composeLikeShader(
    rgba: Uint8Array,
    ambient: [number, number, number],
  ): Uint8Array {
    const rgb = new Uint8Array((rgba.length / 4) * 3);
    for (let i = 0, p = 0; i < rgba.length; i += 4, p += 3) {
      const sky = rgba[i + 3]! / 255;
      for (let c = 0; c < 3; c++) {
        rgb[p + c] = Math.round(
          Math.min(1, sky * ambient[c]! + rgba[i + c]! / 255) * 255,
        );
      }
    }
    return rgb;
  }

  const rect: WorldRect = { x0: -32, y0: -48, x1: 48, y1: 32 };

  for (const [name, ambient] of Object.entries(AMBIENT_PRESETS)) {
    it(`is identical to the composed grid at ${name}`, () => {
      const amb = [...ambient] as [number, number, number];
      const composed = new ChunkedLighting(tilesById, omit).gridFor(
        mapFile,
        amb,
        rect,
      );
      const packed = new ChunkedLighting(tilesById, omit).packedGridFor(
        mapFile,
        rect,
      );

      expect([...packed.levels.keys()].sort()).toEqual(
        [...composed.levels.keys()].sort(),
      );

      let differing = 0;
      let total = 0;
      for (const [z, packedLevel] of packed.levels) {
        const want = composed.levels.get(z)!.rgb;
        const got = composeLikeShader(packedLevel.rgba, amb);
        expect(got.length).toBe(want.length);
        for (let i = 0; i < want.length; i++) {
          total++;
          if (got[i] !== want[i]) differing++;
        }
      }
      expect(total).toBeGreaterThan(100_000);
      expect(differing, `${differing}/${total} bytes differ`).toBe(0);
    });
  }

  it("stays put when only the clock moves", () => {
    // The point of the packed path: ambient is no longer a bake input, so a
    // moving clock must not disturb the cache or the returned buffers.
    const c = new ChunkedLighting(tilesById, omit);
    const first = c.packedGridFor(mapFile, rect);
    const again = c.packedGridFor(mapFile, rect);

    // Same object back, and nothing re-baked on demand. The cache may still
    // have grown by a prefetched ring chunk — that is the trickle working, not
    // the clock invalidating anything.
    expect(again).toBe(first);
    expect(c.bakedLastCall).toBe(0);
  });
});
