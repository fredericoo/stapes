import { describe, expect, it } from "vitest";
import { changedCellsOnLevel, chunkifyMap, setStacks } from "../lib/mapData";
import { CHUNK_SIZE, MAP_FILE_VERSION, coordKey, levelKey } from "../lib/types";
import type { FlatMapFile, MapFile } from "../lib/types";

const SMALL_SIDE = 2;
const LARGE_SIDE = 64;
const CALLS = 200;
const ROUNDS = 7;
/**
 * The work is the same on both levels, so the ratio sits near one. Sweeping
 * the level puts it in the hundreds, which leaves room for a noisy host.
 */
const MAX_RATIO = 4;

/** A level `side` chunks square, four cells and a pool per chunk. */
function level(side: number): MapFile {
  const cells: Record<string, { tileId: string }[]> = {};
  for (let cx = 0; cx < side; cx++) {
    for (let cy = 0; cy < side; cy++) {
      const x = cx * CHUNK_SIZE;
      const y = cy * CHUNK_SIZE;
      cells[coordKey(x, y)] = [{ tileId: "grass" }];
      cells[coordKey(x + 1, y)] = [{ tileId: "grass" }];
      cells[coordKey(x, y + 1)] = [{ tileId: "water" }, { tileId: "body" }];
      cells[coordKey(x + 1, y + 1)] = [{ tileId: "water" }];
    }
  }
  const flat: FlatMapFile = { version: MAP_FILE_VERSION, levels: { [levelKey(0)]: cells } };
  return chunkifyMap(flat);
}

/**
 * Two frames of a walking client: each is the player's predicted step laid on
 * a different server version, so neither frame is a copy of the other.
 */
function walkingFrames(side: number): { before: MapFile; after: MapFile } {
  const server = level(side);
  const ticked = setStacks(server, [
    { x: 0, y: 1, z: 0, stack: [{ tileId: "water" }] },
    { x: 1, y: 1, z: 0, stack: [{ tileId: "water" }, { tileId: "body" }] },
  ]);
  const before = setStacks(server, [
    { x: 0, y: 0, z: 0, stack: [{ tileId: "grass" }, { tileId: "body" }] },
  ]);
  const after = setStacks(ticked, [
    { x: 1, y: 0, z: 0, stack: [{ tileId: "grass" }, { tileId: "body" }] },
  ]);
  return { before, after };
}

function fastestRoundMs(run: () => void): number {
  for (let i = 0; i < CALLS; i++) run();
  let best = Infinity;
  for (let round = 0; round < ROUNDS; round++) {
    const t0 = performance.now();
    for (let i = 0; i < CALLS; i++) run();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

function ratioOf(ask: (frames: { before: MapFile; after: MapFile }) => void): number {
  const small = walkingFrames(SMALL_SIDE);
  const large = walkingFrames(LARGE_SIDE);
  return fastestRoundMs(() => ask(large)) / fastestRoundMs(() => ask(small));
}

describe("diffing two frames of a walking client", () => {
  it(`changedCellsOnLevel costs the same on a level ${(LARGE_SIDE / SMALL_SIDE) ** 2}x the size`, () => {
    const { before, after } = walkingFrames(LARGE_SIDE);
    expect([...changedCellsOnLevel(before, after, 0)].sort()).toEqual(
      [coordKey(0, 0), coordKey(1, 0), coordKey(0, 1), coordKey(1, 1)].sort(),
    );
    expect(ratioOf(({ before, after }) => changedCellsOnLevel(before, after, 0))).toBeLessThan(
      MAX_RATIO,
    );
  });
});
