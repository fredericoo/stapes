import { describe, expect, it } from "vitest";
import { chunkifyMap, getStack, listCoords, replaceStack } from "./mapData";
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

  it("hands back the same grid until the window leaves its chunks", () => {
    const chunked = new ChunkedLighting(tilesById, omit);
    // Sized and stepped so both edges stay inside chunk 0 for the whole walk —
    // the point is a window that moves without changing which chunks it covers.
    const width = 10;
    const steps = 6;
    expect(width + steps).toBeLessThan(LIGHT_CHUNK_SIZE);

    // Warm the window and its prefetch ring first, so nothing bakes mid-walk
    // and every identity change we see is the assemble, not a fill.
    for (let i = 0; i < 40; i++) {
      chunked.packedGridFor(mapFile, { x0: 0, y0: 0, x1: width, y1: width });
    }

    const seen = new Set<unknown>();
    // One cell east at a time. Every frame's output is byte-identical, and
    // callers key their texture uploads on this object — so a fresh one per
    // step is a full re-upload per step, for bytes the GPU already has.
    for (let step = 0; step < steps; step++) {
      seen.add(
        chunked.packedGridFor(mapFile, {
          x0: step,
          y0: 0,
          x1: step + width,
          y1: width,
        }),
      );
      expect(chunked.bakedLastCall, `step ${step} baked`).toBe(0);
    }
    expect(seen.size).toBe(1);
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

  /**
   * Invalidation is sized per edit — an emitter swap dirties its own radius,
   * not the sky flood's whole apron. Under-reaching leaves stale light on
   * screen and nothing else in the suite would notice, so every kind of edit is
   * checked against a cache that never saw the old map.
   */
  describe("an edit leaves no stale light behind", () => {
    const rect: WorldRect = { x0: -64, y0: -64, x1: 64, y1: 64 };

    /**
     * Cells this far inside a chunk are the ones that discriminate. Nearer the
     * edge than the smallest emitter radius, so real light spills into the
     * neighbouring chunk — but far enough in that a token reach does not reach
     * it by accident.
     */
    const EDGE_OFFSET_LO = 2;
    const EDGE_OFFSET_HI = 7;

    /**
     * A populated cell just inside a chunk edge.
     *
     * The choice of cell is what gives these tests teeth, and two ways of
     * choosing it look right and are not. Mid-chunk fails to discriminate
     * because dropping the cell's own chunk already covers everything its light
     * touches, so any reach passes. Flush against the edge fails too, and less
     * obviously: at offset 0 even a reach of 1 crosses into the neighbour, so
     * the neighbour is dropped for the wrong reason and the test still passes.
     * Between the two, only a reach that genuinely spans the emitter's radius
     * drops the chunk the light spills into.
     */
    function cellNearChunkEdge(z: number): { x: number; y: number } {
      const offset = (x: number) =>
        ((x % LIGHT_CHUNK_SIZE) + LIGHT_CHUNK_SIZE) % LIGHT_CHUNK_SIZE;
      const found = listCoords(mapFile, z).find(
        ({ x }) => offset(x) >= EDGE_OFFSET_LO && offset(x) <= EDGE_OFFSET_HI,
      );
      if (!found) throw new Error(`fixture has no near-edge cell on level ${z}`);
      return { x: found.x, y: found.y };
    }

    function expectMatchesColdBake(edited: MapFile) {
      const incremental = new ChunkedLighting(tilesById, omit);
      incremental.gridFor(mapFile, ambient, rect);
      incremental.syncTo(mapFile, edited);
      const got = incremental.gridFor(edited, ambient, rect);

      const cold = new ChunkedLighting(tilesById, omit);
      const want = cold.gridFor(edited, ambient, rect);

      expect([...got.levels.keys()].sort()).toEqual(
        [...want.levels.keys()].sort(),
      );
      for (const [z, wantLevel] of want.levels) {
        const gotLevel = got.levels.get(z)!;
        expect({ z, rgb: [...gotLevel.rgb] }).toEqual({
          z,
          rgb: [...wantLevel.rgb],
        });
      }
    }

    it("when an emitter is added", () => {
      const at = cellNearChunkEdge(0);
      expectMatchesColdBake(
        replaceStack(mapFile, at.x, at.y, 0, [
          ...getStack(mapFile, at.x, at.y, 0),
          { tileId: "torch", direction: "n" },
        ]),
      );
    });

    it("when an emitter is removed", () => {
      const at = cellNearChunkEdge(0);
      const lit = replaceStack(mapFile, at.x, at.y, 0, [
        ...getStack(mapFile, at.x, at.y, 0),
        { tileId: "torch", direction: "n" },
      ]);
      // Same comparison, run the other way round: bake with the torch, then
      // take it away. A reach that is too small shows up as light that stays.
      const incremental = new ChunkedLighting(tilesById, omit);
      incremental.gridFor(lit, ambient, rect);
      incremental.syncTo(lit, mapFile);
      const got = incremental.gridFor(mapFile, ambient, rect);

      const cold = new ChunkedLighting(tilesById, omit);
      const want = cold.gridFor(mapFile, ambient, rect);
      for (const [z, wantLevel] of want.levels) {
        expect([...got.levels.get(z)!.rgb]).toEqual([...wantLevel.rgb]);
      }
    });

    /**
     * A lamp that lights up without changing shape — the case the emission
     * reach exists for, and the one no fixture tile covers. `torch` occludes
     * and every fixture swap that changes emission also changes occlusion, so
     * without a pair like this the emission branch is never taken and its reach
     * could be any number at all.
     */
    function lampPair(): {
      defs: Record<string, TileDef>;
      offId: string;
      onId: string;
      radius: number;
    } {
      const radius = 8;
      const base = {
        name: "Test lamp",
        height: 1,
        type: "simple",
        attributes: {},
        lightPassing: true,
        intangible: true,
      } as const;
      const frame = {
        sprite: {
          tilesetId: "tiny-ranch-tiles",
          rect: { x: 0, y: 0, w: 1, h: 1 },
          base: { x: 0, y: 0 },
        },
        durationMs: 100,
      };
      const off: TileDef = { ...base, id: "test-lamp-off", sprite: { frames: [frame] } };
      const on: TileDef = {
        ...base,
        id: "test-lamp-on",
        sprite: {
          frames: [{ ...frame, light: { radius, intensity: 1, color: "#ffffff" } }],
        },
      };
      return {
        defs: { ...tilesById, [off.id]: off, [on.id]: on },
        offId: off.id,
        onId: on.id,
        radius,
      };
    }

    it("when a lamp lights up without changing shape", () => {
      const { defs, offId, onId, radius } = lampPair();
      const at = cellNearChunkEdge(0);
      expect(radius).toBeGreaterThan(EDGE_OFFSET_HI);

      const dark = replaceStack(mapFile, at.x, at.y, 0, [
        ...getStack(mapFile, at.x, at.y, 0),
        { tileId: offId },
      ]);
      const lit = replaceStack(mapFile, at.x, at.y, 0, [
        ...getStack(mapFile, at.x, at.y, 0),
        { tileId: onId },
      ]);

      const incremental = new ChunkedLighting(defs, omit);
      incremental.gridFor(dark, ambient, rect);
      incremental.syncTo(dark, lit);
      const got = incremental.gridFor(lit, ambient, rect);

      const cold = new ChunkedLighting(defs, omit);
      const want = cold.gridFor(lit, ambient, rect);
      for (const [z, wantLevel] of want.levels) {
        expect({ z, rgb: [...got.levels.get(z)!.rgb] }).toEqual({
          z,
          rgb: [...wantLevel.rgb],
        });
      }
    });

    it("costs nothing at all when a plate presses", () => {
      // Both plate forms are height 0, solid and light-blocking, so the swap
      // cannot change a single baked cell. Keying invalidation on the tile id
      // charged this the full sky apron — up to four chunks rebaked, on the
      // frame the player steps, for output that is identical by construction.
      const at = cellNearChunkEdge(0);
      const up = replaceStack(mapFile, at.x, at.y, 0, [
        ...getStack(mapFile, at.x, at.y, 0),
        { tileId: "pressure-plate" },
      ]);
      const pressed = replaceStack(mapFile, at.x, at.y, 0, [
        ...getStack(mapFile, at.x, at.y, 0),
        { tileId: "pressure-plate-pressed" },
      ]);

      const chunked = new ChunkedLighting(tilesById, omit);
      chunked.gridFor(up, ambient, rect);
      const cached = chunked.cachedChunks;
      expect(cached).toBeGreaterThan(0);

      chunked.syncTo(up, pressed);
      expect(chunked.cachedChunks).toBe(cached);

      chunked.gridFor(pressed, ambient, rect);
      expect(chunked.bakedLastCall).toBe(0);
    });

    it("still pays the full apron when a door opens", () => {
      // The counterpart: door-open is light-passing and intangible where
      // door-closed is neither, so this genuinely changes what is in shadow.
      const at = cellNearChunkEdge(0);
      const closed = replaceStack(mapFile, at.x, at.y, 0, [
        ...getStack(mapFile, at.x, at.y, 0),
        { tileId: "door-closed" },
      ]);
      const opened = replaceStack(mapFile, at.x, at.y, 0, [
        ...getStack(mapFile, at.x, at.y, 0),
        { tileId: "door-open" },
      ]);

      const incremental = new ChunkedLighting(tilesById, omit);
      incremental.gridFor(closed, ambient, rect);
      const cached = incremental.cachedChunks;
      incremental.syncTo(closed, opened);
      // The contract, not just "the output happens to match": an occlusion
      // change must drop chunks. If this ever stops dropping any, the parity
      // below would pass for the wrong reason.
      expect(incremental.cachedChunks).toBeLessThan(cached);
      const got = incremental.gridFor(opened, ambient, rect);

      const cold = new ChunkedLighting(tilesById, omit);
      const want = cold.gridFor(opened, ambient, rect);
      for (const [z, wantLevel] of want.levels) {
        expect({ z, rgb: [...got.levels.get(z)!.rgb] }).toEqual({
          z,
          rgb: [...wantLevel.rgb],
        });
      }
    });

    it("when an occluder is added", () => {
      const at = cellNearChunkEdge(0);
      const solid = (tiles as TileDef[]).find(
        (t) => t.height > 0 && !t.lightPassing && !t.intangible,
      );
      expect(solid).toBeDefined();
      expectMatchesColdBake(
        replaceStack(mapFile, at.x, at.y, 0, [
          ...getStack(mapFile, at.x, at.y, 0),
          { tileId: solid!.id },
        ]),
      );
    });

    it("when a whole stack is cleared", () => {
      const at = cellNearChunkEdge(0);
      expectMatchesColdBake(replaceStack(mapFile, at.x, at.y, 0, []));
    });
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
