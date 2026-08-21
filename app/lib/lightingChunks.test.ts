import { describe, expect, it } from "vitest";
import { chunkifyMap, getStack, listCoords, replaceStack } from "./mapData";
import type { FlatMapFile } from "./types";
import map from "../../data/map.json";
import tiles from "../../data/tiles.json";
import {
  AMBIENT_PRESETS,
  composeLightGrid,
  computeLighting,
  sampleLevelLight,
} from "./lighting";
import { computeLightingFlood } from "./lightingFlood";
import {
  ChunkedLighting,
  LIGHT_APRON,
  LIGHT_CHUNK_SIZE,
  bakeRegion,
  type WorldRect,
} from "./lightingChunks";
import { PLAYER_TILE_ID } from "../game/constants";
import type { MapFile, TileDef } from "./types";
import {
  MAX_LEVEL,
  MIN_LEVEL,
  allTileSprites,
  coordKey,
  levelKey,
  normalizeTileDef,
  parseCoordKey,
} from "./types";

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

  /**
   * The apron is only a sound crop while nothing can reach past it, and
   * `LightDef.radius` is an unbounded field — so the guarantee lives in
   * `clampTileLight`, and these are the tests that hold it there. Without the
   * clamp an authored radius-25 lamp lights its own chunk, stops dead at the
   * edge of the next, and nothing anywhere throws.
   */
  describe("an authored radius cannot outrun the apron", () => {
    const sprite = {
      tilesetId: "tiny-ranch-tiles",
      rect: { x: 0, y: 0, w: 1, h: 1 },
      base: { x: 0, y: 0 },
    };
    const WILD_RADIUS = LIGHT_APRON + 10;
    const wildLight = {
      radius: WILD_RADIUS,
      intensity: 1,
      color: "#ffffff",
    };
    const base = {
      name: "Test",
      type: "simple",
      kind: "prop",
      attributes: {},
      lightPassing: true,
      intangible: true,
    } as const;

    /** Every emitting frame this def holds, across every sprite state. */
    function radiiOf(def: TileDef): number[] {
      return allTileSprites(def).flatMap((s) =>
        s.frames.flatMap((f) => (f.light ? [f.light.radius] : [])),
      );
    }

    it("clamps a radius past the cap on load", () => {
      const def = normalizeTileDef({
        ...base,
        id: "wild",
        height: 1,
        sprite: { frames: [{ sprite, durationMs: 100, light: wildLight }] },
      });
      expect(radiiOf(def)).toEqual([LIGHT_APRON]);
    });

    /**
     * A lantern that only glows while carried lives under `states`, which is a
     * second place frames hide — and the one a clamp written against the inline
     * sprite alone would walk straight past.
     */
    it("clamps a radius on a non-idle sprite state too", () => {
      const def = normalizeTileDef({
        ...base,
        id: "wild-carried",
        height: 1,
        sprite: { frames: [{ sprite, durationMs: 100 }] },
        states: {
          carried: {
            sprite: { frames: [{ sprite, durationMs: 100, light: wildLight }] },
          },
        },
      });
      expect(radiiOf(def)).toEqual([LIGHT_APRON]);
    });

    /** The legacy shape carries one light for the whole tile, not per frame. */
    it("clamps a radius arriving in the legacy tile shape", () => {
      const def = normalizeTileDef({
        id: "wild-legacy",
        name: "Test",
        height: 1,
        kind: "prop",
        variants: { default: [{ sprite, durationMs: 100 }] },
        light: wildLight,
      });
      expect(radiiOf(def)).toEqual([LIGHT_APRON]);
    });

    it("leaves a radius inside the cap exactly as authored", () => {
      const def = normalizeTileDef({
        ...base,
        id: "tame",
        height: 1,
        sprite: {
          frames: [
            { sprite, durationMs: 100, light: { ...wildLight, radius: 6 } },
          ],
        },
      });
      expect(radiiOf(def)).toEqual([6]);
    });

    /**
     * What the shipped catalogue actually holds, asserted so the cap stays a
     * fact rather than an intention. Every emitter here is well inside it —
     * the widest is a torch at 8 — which is why introducing the clamp changed
     * not one baked byte.
     */
    it("leaves every shipped tile untouched", () => {
      for (const def of Object.values(tilesById)) {
        for (const radius of radiiOf(def)) {
          expect(radius, `${def.id} emits past the apron`).toBeLessThanOrEqual(
            LIGHT_APRON,
          );
        }
      }
    });

    /**
     * The behaviour all of the above is for: a lamp authored far past the cap
     * still lights a chunk it does not stand in, exactly as the monolithic bake
     * does.
     *
     * Synthetic on both halves deliberately. A bare floor gives the light
     * somewhere to travel — dropped onto `data/map.json` the lamp would most
     * likely land against a wall and the test would pass either way — and the
     * lamp stands `LIGHT_APRON` + 2 cells from the target chunk's edge, which is
     * the only band that discriminates: near enough that an unclamped radius
     * would reach in, far enough that the chunk's own crop never reads it.
     */
    it("bakes a chunk the lamp does not stand in, cell for cell", () => {
      const floor: TileDef = normalizeTileDef({
        ...base,
        id: "test-floor",
        height: 0,
        sprite: { frames: [{ sprite, durationMs: 100 }] },
      });
      const lamp: TileDef = normalizeTileDef({
        ...base,
        id: "test-wide-lamp",
        height: 1,
        sprite: { frames: [{ sprite, durationMs: 100, light: wildLight }] },
      });
      const defs: Record<string, TileDef> = {
        ...tilesById,
        [floor.id]: floor,
        [lamp.id]: lamp,
      };

      const target: WorldRect = {
        x0: 0,
        y0: 0,
        x1: LIGHT_CHUNK_SIZE - 1,
        y1: LIGHT_CHUNK_SIZE - 1,
      };
      const lampAt = { x: -(LIGHT_APRON + 2), y: 8 };

      const cells: Record<string, { tileId: string }[]> = {};
      for (let y = -LIGHT_CHUNK_SIZE; y < LIGHT_CHUNK_SIZE * 2; y++) {
        for (let x = -LIGHT_CHUNK_SIZE; x < LIGHT_CHUNK_SIZE * 2; x++) {
          cells[coordKey(x, y)] = [{ tileId: floor.id }];
        }
      }
      cells[coordKey(lampAt.x, lampAt.y)] = [
        { tileId: floor.id },
        { tileId: lamp.id },
      ];
      const lit = chunkifyMap({
        version: 1,
        levels: { [levelKey(0)]: cells },
      } as unknown as FlatMapFile);

      const mono = computeLighting(lit, defs, ambient, undefined, omit);
      // One chunk, baked alone with its own crop — the shape a player walking
      // towards the lamp actually gets.
      const chunked = new ChunkedLighting(defs, omit);
      const grid = chunked.gridFor(lit, ambient, target);

      const monoLevel = mono.levels.get(0);
      const chunkLevel = grid.levels.get(0);
      expect(monoLevel).toBeDefined();
      expect(chunkLevel).toBeDefined();

      let differing = 0;
      let maxDelta = 0;
      let brightest = 0;
      for (let y = target.y0; y <= target.y1; y++) {
        for (let x = target.x0; x <= target.x1; x++) {
          const a = sampleLevelLight(monoLevel!, x, y);
          const b = sampleLevelLight(chunkLevel!, x, y);
          for (let c = 0; c < 3; c++) {
            if (a[c]! > brightest) brightest = a[c]!;
            const d = Math.abs(a[c]! - b[c]!) * 255;
            if (d > 0.5) differing++;
            if (d > maxDelta) maxDelta = d;
          }
        }
      }

      // Light has to reach the chunk at all, or the comparison holds vacuously.
      expect(
        brightest,
        "lamp light never reached the chunk under test",
      ).toBeGreaterThan(0);
      expect(
        differing,
        `${differing} samples differ, max delta ${maxDelta.toFixed(1)}/255`,
      ).toBe(0);
    });
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
        kind: "prop",
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

/**
 * The fixture `torch` is two frames of identical art at different intensities —
 * authored to flicker its light and nothing else, which is exactly the case a
 * bake keyed on frame 0 threw away.
 */
describe("a flickering emitter", () => {
  const ambient = [...AMBIENT_PRESETS.night] as [number, number, number];
  const FLICKER_FRAME_MS = 180;
  /** A window over chunk (0,0), which the fixture puts three torches in. */
  const lit: WorldRect = { x0: 8, y0: 4, x1: 24, y1: 20 };

  function rgbOf(grid: ReturnType<ChunkedLighting["gridFor"]>): string {
    return [...grid.levels.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([z, level]) => `${z}:${[...level.rgb].join(",")}`)
      .join("|");
  }

  it("bakes the light the live frame emits", () => {
    const dim = new ChunkedLighting(tilesById, omit).gridFor(
      mapFile,
      ambient,
      lit,
      FLICKER_FRAME_MS,
    );
    const bright = new ChunkedLighting(tilesById, omit).gridFor(
      mapFile,
      ambient,
      lit,
      0,
    );
    expect(rgbOf(dim)).not.toEqual(rgbOf(bright));
  });

  it("matches the monolithic bake at the same point in the cycle", () => {
    // Parity, but off frame 0 — a chunk bakes with an apron, so an emitter one
    // cell outside the window has to reach in at the phase the window is at.
    const mono = composeLightGrid(
      computeLightingFlood(
        mapFile,
        tilesById,
        undefined,
        omit,
        undefined,
        FLICKER_FRAME_MS,
      ),
      ambient,
    );
    const chunked = new ChunkedLighting(tilesById, omit).gridFor(
      mapFile,
      ambient,
      lit,
      FLICKER_FRAME_MS,
    );

    let compared = 0;
    let differing = 0;
    for (const [z, chunkLevel] of chunked.levels) {
      const monoLevel = mono.levels.get(z);
      if (!monoLevel) continue;
      for (let y = lit.y0; y <= lit.y1; y++) {
        for (let x = lit.x0; x <= lit.x1; x++) {
          const a = sampleLevelLight(monoLevel, x, y);
          const b = sampleLevelLight(chunkLevel, x, y);
          for (let c = 0; c < 3; c++) {
            compared++;
            if (Math.abs(a[c]! - b[c]!) * 255 > 0.5) differing++;
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
    expect(differing, `${differing}/${compared} samples differ`).toBe(0);
  });

  it("costs one bake per phase, not one per flicker", () => {
    const chunked = new ChunkedLighting(tilesById, omit);
    chunked.gridFor(mapFile, ambient, lit, 0);
    chunked.gridFor(mapFile, ambient, lit, FLICKER_FRAME_MS);
    expect(
      chunked.bakedLastCall,
      "the other half of the cycle has never been baked",
    ).toBeGreaterThan(0);

    // Round the cycle and back. A torch burns for the whole game, so anything
    // that rebakes per flicker rebakes several times a second, for ever.
    chunked.gridFor(mapFile, ambient, lit, FLICKER_FRAME_MS * 2);
    expect(chunked.bakedLastCall).toBe(0);
    chunked.gridFor(mapFile, ambient, lit, FLICKER_FRAME_MS * 3);
    expect(chunked.bakedLastCall).toBe(0);
  });

  it("leaves light no flicker reaches untouched", () => {
    // Far from any fixture torch: the clock moving must not bake, re-stitch or
    // hand back a new grid, or every empty field in the world would re-upload
    // its textures five times a second.
    const far: WorldRect = { x0: 200, y0: 200, x1: 230, y1: 230 };
    const chunked = new ChunkedLighting(tilesById, omit);
    const first = chunked.packedGridFor(mapFile, far, 0);
    expect(chunked.bakedLastCall).toBeGreaterThan(0);

    const later = chunked.packedGridFor(mapFile, far, FLICKER_FRAME_MS);
    expect(chunked.bakedLastCall).toBe(0);
    expect(later).toBe(first);
  });
});

/**
 * Which chunks a flicker is charged to, at the exact edge of its reach.
 *
 * Being charged is not free: it adds an axis to the chunk's phase key, so every
 * tick of that emitter's cycle is a phase the chunk has never been baked at and
 * a bake it has to pay for. A chunk the light cannot actually touch must
 * therefore not be charged — and the light stops one cell short of the radius,
 * because the flood attenuates by `1 - dist / radius` and drops the remainder.
 *
 * Pinned on a map built for it rather than on the fixture, so that moving a
 * torch in `data/map.json` cannot quietly stop this being covered.
 */
describe("a flicker's reach", () => {
  const RADIUS = 6;
  /** Last row of chunk (0, 0), the chunk baked below. */
  const CHUNK_LAST_ROW = LIGHT_CHUNK_SIZE - 1;
  /** Column the emitter stands in — inside the chunk's span, so only `y` varies. */
  const EMITTER_X = 4;

  /** Two frames of identical art at different intensities, like the fixture torch. */
  const flicker = normalizeTileDef({
    id: "flicker",
    name: "flicker",
    height: 0,
    type: "simple",
    kind: "prop",
    attributes: {},
    sprite: {
      frames: [1, 0.5].map((intensity) => ({
        sprite: {
          tilesetId: "t",
          rect: { x: 0, y: 0, w: 1, h: 1 },
          base: { x: 0, y: 0 },
        },
        durationMs: 180,
        light: { radius: RADIUS, intensity, color: "#ffffff" },
      })),
    },
  });
  const byId: Record<string, TileDef> = { flicker };

  /** The emitters chunk (0, 0) is charged with, for one placed this far south. */
  function chargedTo(emitterY: number): string[] {
    const levels: FlatMapFile["levels"] = {
      [levelKey(0)]: {
        [coordKey(EMITTER_X, emitterY)]: [{ tileId: "flicker" }],
      },
    };
    const baked = bakeRegion(
      chunkifyMap({ version: 1, levels }),
      byId,
      undefined,
      { x0: 0, y0: 0, x1: CHUNK_LAST_ROW, y1: CHUNK_LAST_ROW },
      0,
    );
    expect(baked.size, "expected a single chunk to have been baked").toBe(1);
    return [...baked.values()][0]!.animated;
  }

  it("charges a chunk it lights, however faintly", () => {
    expect(chargedTo(CHUNK_LAST_ROW + RADIUS - 1)).toEqual(["flicker"]);
  });

  it("spares a chunk exactly its radius away, where it is already black", () => {
    expect(chargedTo(CHUNK_LAST_ROW + RADIUS)).toEqual([]);
  });
});
