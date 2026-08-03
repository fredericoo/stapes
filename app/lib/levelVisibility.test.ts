import { describe, expect, it } from "vitest";
import {
  VIEW_RADIUS,
  levelsAboveShouldHide,
  viewAnchorFromSnapshot,
} from "./levelVisibility";
import type { MapFile, TileDef } from "./types";
import { coordKey, levelKey } from "./types";

function tile(
  partial: Partial<TileDef> & Pick<TileDef, "id">,
): TileDef {
  return {
    name: partial.id,
    height: 0,
    directional: false,
    variants: {},
    attributes: {},
    ...partial,
  };
}

function mapAt(
  cells: Array<{
    x: number;
    y: number;
    z?: number;
    tiles: string[];
  }>,
): MapFile {
  const levels: MapFile["levels"] = {};
  for (const c of cells) {
    const z = c.z ?? 0;
    const lk = levelKey(z);
    if (!levels[lk]) levels[lk] = {};
    levels[lk]![coordKey(c.x, c.y)] = c.tiles.map((tileId) => ({ tileId }));
  }
  return { version: 1, levels };
}

const floor = tile({ id: "floor", height: 0 });
const wall = tile({ id: "wall", height: 2 });
const roof = tile({ id: "roof", height: 0 });

const tilesById: Record<string, TileDef> = { floor, wall, roof };

describe("viewAnchorFromSnapshot", () => {
  it("uses committed player when idle", () => {
    expect(
      viewAnchorFromSnapshot({
        player: { x: 1, y: 2, z: 0 },
        walk: null,
        fall: null,
      }),
    ).toEqual({ x: 1, y: 2, z: 0 });
  });

  it("uses walk destination while walking", () => {
    expect(
      viewAnchorFromSnapshot({
        player: { x: 0, y: 0, z: 0 },
        walk: { to: { x: 1, y: 0, z: 1 } },
        fall: null,
      }),
    ).toEqual({ x: 1, y: 0, z: 1 });
  });

  it("uses landing level while falling", () => {
    // landingAbs 2 → level 1 (HEIGHT_PER_LEVEL = 2)
    expect(
      viewAnchorFromSnapshot({
        player: { x: 3, y: 4, z: 2 },
        walk: null,
        fall: { landingAbs: 2 },
      }),
    ).toEqual({ x: 3, y: 4, z: 1 });
  });
});

describe("levelsAboveShouldHide", () => {
  const view = { x: 0, y: 0, z: 0 };

  it("hides when a roof is over the view cell", () => {
    const map = mapAt([
      { x: 0, y: 0, z: 0, tiles: ["floor"] },
      { x: 0, y: 0, z: 1, tiles: ["roof"] },
    ]);
    expect(levelsAboveShouldHide(map, tilesById, view)).toBe(true);
  });

  it("does not hide when there is nothing above in range", () => {
    const map = mapAt([{ x: 0, y: 0, z: 0, tiles: ["floor"] }]);
    expect(levelsAboveShouldHide(map, tilesById, view)).toBe(false);
  });

  it("does not hide when content is only below the view level", () => {
    const map = mapAt([
      { x: 0, y: 0, z: 0, tiles: ["floor"] },
      { x: 0, y: 0, z: -1, tiles: ["floor"] },
    ]);
    expect(levelsAboveShouldHide(map, tilesById, view)).toBe(false);
  });

  it("does not hide a roof behind a wall", () => {
    const map = mapAt([
      { x: 0, y: 0, z: 0, tiles: ["floor"] },
      { x: 1, y: 0, z: 0, tiles: ["wall"] },
      { x: 2, y: 0, z: 0, tiles: ["floor"] },
      { x: 2, y: 0, z: 1, tiles: ["roof"] },
    ]);
    expect(levelsAboveShouldHide(map, tilesById, view)).toBe(false);
  });

  it("hides when a roof is visible past open floor", () => {
    const map = mapAt([
      { x: 0, y: 0, z: 0, tiles: ["floor"] },
      { x: 1, y: 0, z: 0, tiles: ["floor"] },
      { x: 2, y: 0, z: 0, tiles: ["floor"] },
      { x: 2, y: 0, z: 1, tiles: ["roof"] },
    ]);
    expect(levelsAboveShouldHide(map, tilesById, view)).toBe(true);
  });

  it("includes a roof just inside the Euclidean radius", () => {
    // (2, 0) → dist 2, on the boundary
    const map = mapAt([
      { x: 0, y: 0, z: 0, tiles: ["floor"] },
      { x: 2, y: 0, z: 1, tiles: ["roof"] },
    ]);
    expect(levelsAboveShouldHide(map, tilesById, view, VIEW_RADIUS)).toBe(
      true,
    );
  });

  it("excludes a roof just outside the Euclidean radius", () => {
    // (3, 0) → dist 3 > 2
    const map = mapAt([
      { x: 0, y: 0, z: 0, tiles: ["floor"] },
      { x: 3, y: 0, z: 1, tiles: ["roof"] },
    ]);
    expect(levelsAboveShouldHide(map, tilesById, view, VIEW_RADIUS)).toBe(
      false,
    );
  });
});
