/**
 * The off-thread refresh path.
 *
 * Driven through a hand-controlled {@link ChunkBaker} rather than a real
 * worker, so the interesting moments — a result landing late, an edit arriving
 * while one is in flight — are things a test can sit in the middle of instead
 * of things it has to race.
 */
import { describe, expect, it } from "vitest";
import mapJson from "../../data/map.json";
import tilesJson from "../../data/tiles.json";
import { chunkifyMap, getStack, replaceStack } from "./mapData";
import {
  type BakedChunk,
  bakeRegion,
  type ChunkBaker,
  ChunkedLighting,
  type WorldRect,
} from "./lightingChunks";
import { PLAYER_TILE_ID } from "../game/constants";
import type { FlatMapFile, MapFile, TileDef } from "./types";

const tilesById = Object.fromEntries(
  (tilesJson as TileDef[]).map((t) => [t.id, t]),
) as Record<string, TileDef>;
const omit = new Set([PLAYER_TILE_ID]);
const base = chunkifyMap(mapJson as FlatMapFile);

/** A window well inside the fixture map's content. */
const WINDOW: WorldRect = { x0: -8, y0: -8, x1: 8, y1: 8 };

/** Somewhere in that window with a stack to mutate. */
const EDIT = { x: 0, y: 0, z: 0 };

/** A baker whose results only land when the test says so. */
class ManualBaker implements ChunkBaker {
  readonly asked: WorldRect[] = [];
  private queue: Array<() => void> = [];
  /** Map each queued bake reads from — set before the bake is released. */
  map: MapFile = base;

  bake(rect: WorldRect, timeMs: number): Promise<Map<string, BakedChunk>> {
    this.asked.push(rect);
    return new Promise((resolve) => {
      this.queue.push(() =>
        resolve(bakeRegion(this.map, tilesById, omit, rect, timeMs)),
      );
    });
  }

  get inFlight(): number {
    return this.queue.length;
  }

  /**
   * Release everything queued and let the promise callbacks run to the end.
   *
   * A macrotask, not a couple of microtasks. The cache hangs its bookkeeping off
   * `.then().catch().finally()`, so the slot it counts requests against is only
   * given back on the third tick — awaiting two left it permanently held, and
   * every later refresh was silently declined for want of it.
   */
  async flush() {
    const queued = this.queue;
    this.queue = [];
    for (const run of queued) run();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function putTorch(m: MapFile): MapFile {
  const stack = getStack(m, EDIT.x, EDIT.y, EDIT.z) ?? [];
  return replaceStack(m, EDIT.x, EDIT.y, EDIT.z, [
    ...stack,
    { tileId: "torch" },
  ]);
}

function planeOf(grid: { levels: Map<number, { rgba: Uint8Array }> }) {
  return Array.from(grid.levels.get(EDIT.z)!.rgba);
}

/**
 * Two clock readings the fixture torch shows different light at. Its frames run
 * 180ms each and differ only in intensity, so these are its bright half and its
 * dim one — a real flicker rather than a synthetic one, which matters because
 * the phase key is built from the tile's own frames.
 */
const BRIGHT_MS = 0;
const DIM_MS = 200;

describe("off-thread chunk refresh", () => {
  it("keeps drawing the old light instead of baking in the frame", async () => {
    const baker = new ManualBaker();
    const lighting = new ChunkedLighting(tilesById, omit);
    lighting.setBaker(baker);

    lighting.syncTo(null, base);
    const cold = planeOf(lighting.packedGridFor(base, WINDOW));
    baker.asked.length = 0;
    await baker.flush();

    // The edit lands. Nothing may be baked on this thread for it, and what is
    // on screen must not change until the refresh arrives.
    const lit = putTorch(base);
    baker.map = lit;
    lighting.syncTo(base, lit);
    expect(lighting.staleChunks).toBeGreaterThan(0);

    const during = lighting.packedGridFor(lit, WINDOW);
    expect(lighting.bakedLastCall).toBe(0);
    expect(planeOf(during)).toEqual(cold);
    expect(baker.asked.length).toBe(1);

    await baker.flush();

    const after = planeOf(lighting.packedGridFor(lit, WINDOW));
    expect(after).not.toEqual(cold);
    expect(lighting.staleChunks).toBe(0);
  });

  it("matches what the synchronous path would have produced", async () => {
    const baker = new ManualBaker();
    const async_ = new ChunkedLighting(tilesById, omit);
    async_.setBaker(baker);
    const sync = new ChunkedLighting(tilesById, omit);

    async_.syncTo(null, base);
    async_.packedGridFor(base, WINDOW);
    sync.syncTo(null, base);
    sync.packedGridFor(base, WINDOW);
    await baker.flush();

    const lit = putTorch(base);
    baker.map = lit;
    async_.syncTo(base, lit);
    async_.packedGridFor(lit, WINDOW);
    await baker.flush();
    // Drain the prefetch the settled window then asks for.
    async_.packedGridFor(lit, WINDOW);
    await baker.flush();

    sync.syncTo(base, lit);

    expect(planeOf(async_.packedGridFor(lit, WINDOW))).toEqual(
      planeOf(sync.packedGridFor(lit, WINDOW)),
    );
  });

  it("re-asks when an edit lands while a bake is in flight", async () => {
    const baker = new ManualBaker();
    const lighting = new ChunkedLighting(tilesById, omit);
    lighting.setBaker(baker);

    lighting.syncTo(null, base);
    lighting.packedGridFor(base, WINDOW);
    await baker.flush();

    const lit = putTorch(base);
    lighting.syncTo(base, lit);
    lighting.packedGridFor(lit, WINDOW);
    expect(baker.inFlight).toBe(1);

    // A second edit while the first bake is still out. Its result is about to
    // arrive computed against a map that no longer exists.
    const relit = replaceStack(lit, EDIT.x, EDIT.y, EDIT.z, [
      ...(getStack(lit, EDIT.x, EDIT.y, EDIT.z) ?? []),
      { tileId: "torch" },
    ]);
    lighting.syncTo(lit, relit);
    baker.map = relit;
    await baker.flush();

    // Landing must not have marked the chunk clean — the edit it missed is
    // still unaccounted for.
    expect(lighting.staleChunks).toBeGreaterThan(0);
    lighting.packedGridFor(relit, WINDOW);
    await baker.flush();
    expect(lighting.staleChunks).toBe(0);
  });

  it("still bakes inline for a chunk it has no pixels for at all", () => {
    const baker = new ManualBaker();
    const lighting = new ChunkedLighting(tilesById, omit);
    lighting.setBaker(baker);

    // Nothing cached anywhere, so waiting would mean drawing a hole.
    lighting.syncTo(null, base);
    lighting.packedGridFor(base, WINDOW);
    expect(lighting.bakedLastCall).toBeGreaterThan(0);
  });

  it("survives a baker that refuses, and asks again next call", async () => {
    const refusing: ChunkBaker = {
      bake: () => Promise.reject(new Error("worker gone")),
    };
    const lighting = new ChunkedLighting(tilesById, omit);
    lighting.setBaker(refusing);

    lighting.syncTo(null, base);
    const cold = planeOf(lighting.packedGridFor(base, WINDOW));

    const lit = putTorch(base);
    lighting.syncTo(base, lit);
    lighting.packedGridFor(lit, WINDOW);
    await Promise.resolve();
    await Promise.resolve();

    // Stale light, not missing light, and the chunk is still asking.
    expect(planeOf(lighting.packedGridFor(lit, WINDOW))).toEqual(cold);
    expect(lighting.staleChunks).toBeGreaterThan(0);
  });

  it("drops chunks outright when nothing is there to refresh them", () => {
    const lighting = new ChunkedLighting(tilesById, omit);
    lighting.syncTo(null, base);
    lighting.packedGridFor(base, WINDOW);

    const lit = putTorch(base);
    lighting.syncTo(base, lit);
    lighting.packedGridFor(lit, WINDOW);

    // The synchronous path is unchanged: an edit is baked in the frame that
    // asks, and nothing is ever left stale.
    expect(lighting.bakedLastCall).toBeGreaterThan(0);
    expect(lighting.staleChunks).toBe(0);
  });
});

describe("off-thread refresh and the animation clock", () => {
  it("fetches the phase it is missing without stopping to bake it", async () => {
    const baker = new ManualBaker();
    const lighting = new ChunkedLighting(tilesById, omit);
    lighting.setBaker(baker);
    const lit = putTorch(base);
    baker.map = lit;

    lighting.syncTo(null, lit);
    const bright = planeOf(lighting.packedGridFor(lit, WINDOW, BRIGHT_MS));
    await baker.flush();

    // The clock moves to the torch's other frame. That phase has never been
    // baked, and baking it here is exactly what the worker exists to avoid.
    const first = lighting.packedGridFor(lit, WINDOW, DIM_MS);
    expect(lighting.bakedLastCall).toBe(0);
    // Drawn from the phase it does have, so the chunk is lit rather than black.
    expect(planeOf(first)).toEqual(bright);

    await baker.flush();

    const settled = planeOf(lighting.packedGridFor(lit, WINDOW, DIM_MS));
    expect(settled).not.toEqual(bright);
    // And the phase it fell back to is still there to return to.
    expect(planeOf(lighting.packedGridFor(lit, WINDOW, BRIGHT_MS))).toEqual(
      bright,
    );
  });

  it("settles on the same light the synchronous cache bakes", async () => {
    const baker = new ManualBaker();
    const lit = putTorch(base);
    baker.map = lit;

    const async_ = new ChunkedLighting(tilesById, omit);
    async_.setBaker(baker);
    async_.syncTo(null, lit);
    const sync = new ChunkedLighting(tilesById, omit);
    sync.syncTo(null, lit);

    // Turn the cycle a few times. Each pass asks for one phase and lands the
    // one asked for last, which is exactly how it warms up in a running frame
    // loop — a phase is a bake behind until its turn comes round again.
    for (let turn = 0; turn < 3; turn++) {
      for (const timeMs of [BRIGHT_MS, DIM_MS]) {
        async_.packedGridFor(lit, WINDOW, timeMs);
        await baker.flush();
      }
    }

    for (const timeMs of [BRIGHT_MS, DIM_MS]) {
      expect(
        planeOf(async_.packedGridFor(lit, WINDOW, timeMs)),
        `phase at ${timeMs}ms`,
      ).toEqual(planeOf(sync.packedGridFor(lit, WINDOW, timeMs)));
    }
  });

  it("throws away every phase of a chunk an edit reached", async () => {
    const baker = new ManualBaker();
    const lighting = new ChunkedLighting(tilesById, omit);
    lighting.setBaker(baker);
    const lit = putTorch(base);
    baker.map = lit;

    lighting.syncTo(null, lit);
    for (let turn = 0; turn < 3; turn++) {
      for (const timeMs of [BRIGHT_MS, DIM_MS]) {
        lighting.packedGridFor(lit, WINDOW, timeMs);
        await baker.flush();
      }
    }
    const beforeEdit = planeOf(lighting.packedGridFor(lit, WINDOW, BRIGHT_MS));
    // Reading a phase kicks off a speculative prefetch; let it land so the edit
    // below is not queued behind it.
    await baker.flush();

    // A second torch goes up nearby. Both phases are wrong now, not just the
    // one the clock happens to be at, so the other must not survive to be drawn
    // when the flicker comes back round to it.
    const brighter = replaceStack(lit, EDIT.x + 2, EDIT.y, EDIT.z, [
      { tileId: "torch" },
    ]);
    baker.map = brighter;
    lighting.syncTo(lit, brighter);
    lighting.packedGridFor(brighter, WINDOW, DIM_MS);
    await baker.flush();

    expect(
      planeOf(lighting.packedGridFor(brighter, WINDOW, BRIGHT_MS)),
    ).not.toEqual(beforeEdit);
  });
});
