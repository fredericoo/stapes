import { describe, expect, it } from "vitest";
import {
  chunkAddressKey,
  parseChunkAddress,
  visibleChunkKeys,
} from "./meshWindow";
import { emptyMap, replaceStack } from "../lib/mapData";
import { CHUNK_SIZE, MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import type { MapFile } from "../lib/types";

/**
 * What has to exist as geometry.
 *
 * Everything here is a cost that is invisible when it is wrong in the generous
 * direction: a chunk built for a floor nobody is looking at draws nothing and
 * still cost its quads. The mean direction is visible immediately, which is
 * why the margin cases below are the ones worth pinning.
 */

/**
 * A window over cells `10..25` at level 0 — a viewport's worth, and
 * deliberately not chunk-aligned.
 *
 * Aligned to a chunk boundary these tests would pass with the level shift and
 * the margin both deleted, because either error is smaller than a chunk and
 * the rect is rounded out to chunks anyway. Offset, each of them moves the
 * answer.
 */
const WINDOW = { x0: 10, y0: 10, x1: 25, y1: 25 };

/** A map with one cell at each of the given coordinates. */
function mapAt(...cells: Array<{ x: number; y: number; z: number }>): MapFile {
  let map = emptyMap();
  for (const cell of cells) {
    map = replaceStack(map, cell.x, cell.y, cell.z, [{ tileId: "grass" }]);
  }
  return map;
}

/** The chunk a cell lives in, as an address key. */
function addressOf(x: number, y: number, z: number): string {
  return chunkAddressKey(
    z,
    `${Math.floor(x / CHUNK_SIZE)},${Math.floor(y / CHUNK_SIZE)}`,
  );
}

describe("which chunks are worth meshing", () => {
  it("takes the chunk the window is over", () => {
    const map = mapAt({ x: 20, y: 20, z: 0 });

    expect([...visibleChunkKeys(map, WINDOW)]).toEqual([addressOf(20, 20, 0)]);
  });

  it("leaves a chunk of the same level well outside it", () => {
    const far = { x: CHUNK_SIZE * 20, y: CHUNK_SIZE * 20, z: 0 };
    const map = mapAt({ x: 20, y: 20, z: 0 }, far);

    const keys = visibleChunkKeys(map, WINDOW);

    expect(keys.has(addressOf(far.x, far.y, 0))).toBe(false);
    expect(keys.has(addressOf(20, 20, 0))).toBe(true);
  });

  it("asks about a chunk the map does not have without inventing it", () => {
    expect([...visibleChunkKeys(emptyMap(), WINDOW)]).toEqual([]);
  });

  /**
   * The projection shifts level `z` by exactly `z` cells, so what is on screen
   * at a level below is further west and north than the level-0 rect says. A
   * window that ignored the shift would build the wrong chunks on every floor
   * but the player's own — which on the den map is three floors of cave.
   */
  it("follows the level shift down as well as up", () => {
    // At level `z` the visible cells are the base rect plus `z`, so each of
    // these is in view on its own floor and on no other. Both are outside the
    // unshifted rect, which is what makes them say something: a window that
    // ignored the shift would leave the player's own floor built and every
    // other one — three floors of cave, on the den map — dark.
    const high = { x: 34, y: 34, z: MAX_LEVEL };
    const low = { x: -10, y: -10, z: MIN_LEVEL };
    const map = mapAt(high, low);

    const keys = visibleChunkKeys(map, WINDOW);

    expect(keys.has(addressOf(high.x, high.y, high.z))).toBe(true);
    expect(keys.has(addressOf(low.x, low.y, low.z))).toBe(true);
  });

  /**
   * The margin's job, stated as the thing it has to cover rather than as its
   * own value — a test written against `MESH_WINDOW_MARGIN` would move with it
   * and pass at any setting, including zero.
   *
   * The window is its own, ending a few cells short of a chunk boundary.
   * Against a window that straddles one, deleting the margin outright changes
   * nothing, because six cells is less than a chunk and the rect is rounded out
   * to chunks anyway.
   */
  it("reaches far enough past the camera to catch a tall sprite", () => {
    // The tallest thing in the catalogue is four units — a wall, a door, a
    // cave troll — and a sprite is drawn from its cell upward, so one standing
    // this far below the bottom edge still paints inside it.
    const TALLEST_SPRITE_CELLS = 4;
    const window = { x0: 4, y0: 4, x1: 12, y1: 12 };
    const below = {
      x: window.x1 + TALLEST_SPRITE_CELLS,
      y: window.y1 + TALLEST_SPRITE_CELLS,
      z: 0,
    };
    const far = { x: window.x1 + CHUNK_SIZE * 3, y: window.y1 + CHUNK_SIZE * 3, z: 0 };
    const map = mapAt(below, far);

    const keys = visibleChunkKeys(map, window);

    expect(keys.has(addressOf(below.x, below.y, 0))).toBe(true);
    expect(keys.has(addressOf(far.x, far.y, 0))).toBe(false);
  });

  /**
   * The property the whole thing exists for. A window asks each level about the
   * chunks its own rect covers and no others, so a floor with a cave under
   * every cell of the map answers with as many chunks as that rect has — the
   * same handful a floor holding one room does. Grow the map a hundredfold and
   * this number does not move.
   */
  it("answers with the window's chunks however big the level is", () => {
    // A hundred times the chunks the window covers, which is the point being
    // made, and small enough that the copy-on-write writes below stay quick —
    // a fixture big enough to be impressive was slow enough to flake under the
    // suite's own timeout.
    const SPAN = 10;
    let dense = emptyMap();
    for (let cx = -SPAN; cx < SPAN; cx++) {
      for (let cy = -SPAN; cy < SPAN; cy++) {
        dense = replaceStack(dense, cx * CHUNK_SIZE, cy * CHUNK_SIZE, 0, [
          { tileId: "grass" },
        ]);
      }
    }

    // The rect is the window plus the margin on each side, rounded out to whole
    // chunks: cells 4..31 is chunks 0..1 on both axes.
    expect(visibleChunkKeys(dense, WINDOW).size).toBe(4);
  });

  it("looks at every level, since a cut roof is still built", () => {
    let map = emptyMap();
    for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
      map = replaceStack(map, 20 + z, 20 + z, z, [{ tileId: "grass" }]);
    }

    expect(visibleChunkKeys(map, WINDOW).size).toBe(MAX_LEVEL - MIN_LEVEL + 1);
  });
});

describe("naming a chunk of a level", () => {
  it("reads back what it wrote, negatives included", () => {
    expect(parseChunkAddress(chunkAddressKey(-3, "-2,-7"))).toEqual({
      z: -3,
      chunk: "-2,-7",
    });
  });
});
