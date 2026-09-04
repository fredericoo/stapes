import { describe, expect, it } from "vitest";
import { resolveScatterIndex, scatterHash } from "./scatter";
import { getFrames, resolveTileSprite } from "./tileResolve";
import { allTileSprites, type TileDef, type TileSprite } from "./types";

const grass = (
  scatter: TileSprite[],
  extra: Partial<TileDef> = {},
): TileDef => ({
  id: "grass",
  name: "Grass",
  height: 0,
  type: "scatter",
  kind: "prop",
  attributes: {},
  scatter,
  ...extra,
});

function spriteAt(x: number): TileSprite {
  return {
    frames: [
      {
        sprite: {
          tilesetId: "t",
          rect: { x, y: 0, w: 1, h: 1 },
          base: { x: 0, y: 0 },
        },
        durationMs: 200,
      },
    ],
  };
}

/** How many of each face a patch of ground gets, for a tile of `count` faces. */
function tally(tile: TileDef, count: number, span: number): number[] {
  const hits = new Array<number>(count).fill(0);
  for (let y = 0; y < span; y++) {
    for (let x = 0; x < span; x++) {
      hits[resolveScatterIndex(x, y, 0, tile, count)]! += 1;
    }
  }
  return hits;
}

describe("resolveScatterIndex", () => {
  const tile = grass([spriteAt(0), spriteAt(1), spriteAt(2), spriteAt(3)]);

  it("gives the same cell the same face every time it is asked", () => {
    const first = resolveScatterIndex(12, -7, 1, tile, 4);
    expect(resolveScatterIndex(12, -7, 1, tile, 4)).toBe(first);
    expect(resolveScatterIndex(12, -7, 1, tile, 4)).toBe(first);
  });

  it("stays in range, including on negative coordinates", () => {
    for (let y = -40; y < 40; y++) {
      for (let x = -40; x < 40; x++) {
        const i = resolveScatterIndex(x, y, -2, tile, 4);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(4);
      }
    }
  });

  it("answers 0 for a tile with one face or none, without dividing by zero", () => {
    expect(resolveScatterIndex(3, 4, 0, tile, 1)).toBe(0);
    expect(resolveScatterIndex(3, 4, 0, tile, 0)).toBe(0);
  });

  it("spreads faces evenly enough that none is rare", () => {
    // A 40x40 patch, four faces: 400 each if it were perfect. The bound is
    // loose on purpose — this is a hash, not a shuffle, and the test is here to
    // catch a mix that has collapsed, not to pin its exact distribution.
    const hits = tally(tile, 4, 40);
    for (const n of hits) {
      expect(n).toBeGreaterThan(300);
      expect(n).toBeLessThan(500);
    }
  });

  it("does not repeat along a row, a column or a diagonal", () => {
    // The failure a bad mix produces is stripes, and stripes are what somebody
    // laying a brick road would notice first.
    const row = Array.from({ length: 16 }, (_, x) =>
      resolveScatterIndex(x, 0, 0, tile, 4),
    );
    const col = Array.from({ length: 16 }, (_, y) =>
      resolveScatterIndex(0, y, 0, tile, 4),
    );
    const diag = Array.from({ length: 16 }, (_, i) =>
      resolveScatterIndex(i, i, 0, tile, 4),
    );
    for (const line of [row, col, diag]) {
      expect(new Set(line).size).toBeGreaterThan(1);
    }
  });

  it("re-rolls the whole patch when the seed changes", () => {
    const reseeded = grass(tile.scatter!, { scatterSeed: 99 });
    const before = tally(tile, 4, 8);
    const after = tally(reseeded, 4, 8);
    const moved = Array.from({ length: 64 }, (_, i) => {
      const x = i % 8;
      const y = Math.floor(i / 8);
      return (
        resolveScatterIndex(x, y, 0, tile, 4) !==
        resolveScatterIndex(x, y, 0, reseeded, 4)
      );
    }).filter(Boolean).length;
    // Roughly three cells in four should land somewhere else with four faces.
    expect(moved).toBeGreaterThan(32);
    // And it is a re-roll, not a thinning: every face still turns up.
    expect(after.filter((n) => n > 0)).toHaveLength(before.length);
  });

  it("gives two tiles on the default seed different patches", () => {
    const pebbles = grass(tile.scatter!, { id: "pebbles" });
    const disagreements = Array.from({ length: 64 }, (_, i) => {
      const x = i % 8;
      const y = Math.floor(i / 8);
      return (
        resolveScatterIndex(x, y, 0, tile, 4) !==
        resolveScatterIndex(x, y, 0, pebbles, 4)
      );
    }).filter(Boolean).length;
    expect(disagreements).toBeGreaterThan(32);
  });

  it("separates the levels of a stack", () => {
    const perLevel = new Set(
      Array.from({ length: 6 }, (_, z) => resolveScatterIndex(4, 4, z, tile, 4)),
    );
    expect(perLevel.size).toBeGreaterThan(1);
  });
});

describe("scatterHash", () => {
  it("is an unsigned 32-bit value", () => {
    for (const [x, y] of [
      [0, 0],
      [-1, -1],
      [1e6, -1e6],
    ]) {
      const h = scatterHash(x!, y!, 0, 0);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
  });

  it("does not agree with itself when the axes are swapped", () => {
    expect(scatterHash(3, 9, 0, 0)).not.toBe(scatterHash(9, 3, 0, 0));
  });
});

describe("resolving a scatter tile's sprite", () => {
  const tile = grass([spriteAt(0), spriteAt(1), spriteAt(2)]);

  it("draws the face the cell picks", () => {
    const index = resolveScatterIndex(5, 6, 0, tile, 3);
    expect(getFrames(tile, { x: 5, y: 6, z: 0 })?.[0]?.sprite.rect.x).toBe(index);
  });

  it("draws the first face when asked with no cell at all", () => {
    expect(getFrames(tile)?.[0]?.sprite.rect.x).toBe(0);
  });

  it("takes an explicit index, for a preview", () => {
    expect(getFrames(tile, { scatterIndex: 2 })?.[0]?.sprite.rect.x).toBe(2);
  });

  it("falls back to the first face when the index is past what is authored", () => {
    expect(getFrames(tile, { scatterIndex: 9 })?.[0]?.sprite.rect.x).toBe(0);
  });

  it("counts a state's faces off idle, so a face survives the walk", () => {
    const walking = grass([spriteAt(0), spriteAt(1), spriteAt(2)], {
      states: { moving: { scatter: [spriteAt(10), spriteAt(11)] } },
    });
    expect(
      getFrames(walking, { state: "moving", scatterIndex: 1 })?.[0]?.sprite.rect.x,
    ).toBe(11);
    // Face 2 is unauthored on the state, so it falls back to idle's face 2
    // rather than to one of the state's own.
    expect(
      getFrames(walking, { state: "moving", scatterIndex: 2 })?.[0]?.sprite.rect.x,
    ).toBe(2);
  });

  it("is nothing at all when no face is authored", () => {
    expect(resolveTileSprite(grass([]), { x: 1, y: 1, z: 0 })).toBeUndefined();
  });

  it("shows every face to the sprite scan", () => {
    const walking = grass([spriteAt(0), spriteAt(1), spriteAt(2)], {
      states: { moving: { scatter: [spriteAt(10)] } },
    });
    expect(allTileSprites(walking)).toHaveLength(4);
  });
});
