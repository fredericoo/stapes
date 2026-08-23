import { describe, expect, it } from "vitest";
import { chunkifyMap } from "./mapData";
import type { FlatMapFile } from "./types";
import tilesFile from "../../data/tiles.json";
import {
  VIEW_RADIUS,
  levelsAboveShouldHide,
  viewAnchorFor,
} from "./levelVisibility";
import type { MapFile, TileDef } from "./types";
import { coordKey, levelKey, normalizeTileDef } from "./types";
import { tilesByIdFromList } from "./validation";

function tile(
  partial: Partial<TileDef> & Pick<TileDef, "id">,
): TileDef {
  return normalizeTileDef({
    name: partial.id,
    height: 0,
    directional: false,
    variants: {
      default: [
        {
          sprite: {
            tilesetId: "t",
            rect: { x: 0, y: 0, w: 1, h: 1 },
            base: { x: 0, y: 0 },
          },
          durationMs: 200,
        },
      ],
    },
    attributes: {},
    ...partial,
  });
}

function mapAt(
  cells: Array<{
    x: number;
    y: number;
    z?: number;
    tiles: string[];
  }>,
): MapFile {
  const levels: FlatMapFile["levels"] = {};
  for (const c of cells) {
    const z = c.z ?? 0;
    const lk = levelKey(z);
    if (!levels[lk]) levels[lk] = {};
    levels[lk]![coordKey(c.x, c.y)] = c.tiles.map((tileId) => ({ tileId }));
  }
  return chunkifyMap({ version: 1, levels });
}

const floor = tile({ id: "floor", height: 0 });
const half = tile({ id: "half", height: 1 });
const wall = tile({ id: "wall", height: 2 });
const window = tile({ id: "window", height: 2, lightPassing: true });
const roof = tile({ id: "roof", height: 0 });

const tilesById: Record<string, TileDef> = {
  floor,
  half,
  wall,
  window,
  roof,
};

describe("viewAnchorFor", () => {
  it("uses the committed cell when idle", () => {
    expect(
      viewAnchorFor({
        x: 1,
        y: 2,
        z: 0,
        walk: null,
        fall: null,
      }),
    ).toEqual({ x: 1, y: 2, z: 0 });
  });

  it("uses walk destination while walking", () => {
    expect(
      viewAnchorFor({
        x: 0,
        y: 0,
        z: 0,
        walk: { to: { x: 1, y: 0, z: 1 } },
        fall: null,
      }),
    ).toEqual({ x: 1, y: 0, z: 1 });
  });

  it("uses landing level while falling", () => {
    // landingAbs 2 → level 1 (HEIGHT_PER_LEVEL = 2)
    expect(
      viewAnchorFor({
        x: 3,
        y: 4,
        z: 2,
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

  it("does not hide a roof behind a solid wall", () => {
    const map = mapAt([
      { x: 0, y: 0, z: 0, tiles: ["floor"] },
      { x: 1, y: 0, z: 0, tiles: ["wall"] },
      { x: 2, y: 0, z: 0, tiles: ["floor"] },
      { x: 2, y: 0, z: 1, tiles: ["roof"] },
    ]);
    expect(levelsAboveShouldHide(map, tilesById, view)).toBe(false);
  });

  it("does not hide when standing against a solid wall with content above", () => {
    const map = mapAt([
      { x: 0, y: 0, z: 0, tiles: ["floor"] },
      { x: 1, y: 0, z: 0, tiles: ["wall"] },
      { x: 1, y: 0, z: 1, tiles: ["roof"] },
    ]);
    expect(levelsAboveShouldHide(map, tilesById, view)).toBe(false);
  });

  it("hides through a light-passing window into a covered cell", () => {
    const map = mapAt([
      { x: 0, y: 0, z: 0, tiles: ["floor"] },
      { x: 1, y: 0, z: 0, tiles: ["window"] },
      { x: 1, y: 0, z: 1, tiles: ["roof"] },
    ]);
    expect(levelsAboveShouldHide(map, tilesById, view)).toBe(true);
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
    // (2, 1) → dist √5 ≈ 2.236 ≤ 2.5
    const map = mapAt([
      { x: 0, y: 0, z: 0, tiles: ["floor"] },
      { x: 2, y: 1, z: 1, tiles: ["roof"] },
    ]);
    expect(levelsAboveShouldHide(map, tilesById, view, VIEW_RADIUS)).toBe(
      true,
    );
  });

  it("excludes a roof just outside the Euclidean radius", () => {
    // (2, 2) → dist √8 ≈ 2.828 > 2.5
    const map = mapAt([
      { x: 0, y: 0, z: 0, tiles: ["floor"] },
      { x: 2, y: 2, z: 1, tiles: ["roof"] },
    ]);
    expect(levelsAboveShouldHide(map, tilesById, view, VIEW_RADIUS)).toBe(
      false,
    );
  });

  it("treats stacked halves as a full LOS block like light", () => {
    const map = mapAt([
      { x: 0, y: 0, z: 0, tiles: ["floor"] },
      { x: 1, y: 0, z: 0, tiles: ["half", "half"] },
      { x: 2, y: 0, z: 0, tiles: ["floor"] },
      { x: 2, y: 0, z: 1, tiles: ["roof"] },
    ]);
    expect(levelsAboveShouldHide(map, tilesById, view)).toBe(false);
  });
});

/**
 * The scenarios the shipped map used to be read for, rebuilt cell by cell out
 * of the real tile catalogue.
 *
 * Reading `data/map.json` meant each case pinned a coordinate in a file the
 * editor rewrites: swapping one wall of the square for a window flipped an
 * expectation and broke the build, which says nothing about this code. What is
 * worth keeping is that the shipped tiles — their heights, their light-passing
 * flags — really do drive the roof-cut, so the tile definitions stay real and
 * only the geometry is local.
 */
describe("levelsAboveShouldHide with the shipped tiles", () => {
  const mapTiles = tilesByIdFromList(
    (tilesFile as Array<Parameters<typeof normalizeTileDef>[0]>).map((t) =>
      normalizeTileDef(t),
    ),
  );
  const origin = { x: 0, y: 0, z: 0 };

  it("hides on the path two cells from a roofed doorway", () => {
    const map = mapAt([
      { x: 0, y: 0, tiles: ["grass-2", "cobblestone"] },
      { x: 1, y: 0, tiles: ["grass-2", "cobblestone"] },
      { x: 2, y: 0, tiles: ["wooden-floor"] },
      { x: 2, y: 0, z: 1, tiles: ["roof-1"] },
    ]);
    expect(levelsAboveShouldHide(map, mapTiles, origin)).toBe(true);
  });

  it("does not hide one cell further back, outside the radius", () => {
    const map = mapAt([
      { x: 0, y: 0, tiles: ["grass-2", "cobblestone"] },
      { x: 1, y: 0, tiles: ["grass-2", "cobblestone"] },
      { x: 2, y: 0, tiles: ["grass-2", "cobblestone"] },
      { x: 3, y: 0, tiles: ["wooden-floor"] },
      { x: 3, y: 0, z: 1, tiles: ["roof-1"] },
    ]);
    expect(levelsAboveShouldHide(map, mapTiles, origin)).toBe(false);
  });

  it("does not hide standing against a roofed building's solid wall", () => {
    const map = mapAt([
      { x: 0, y: 0, tiles: ["grass-2", "dirt"] },
      { x: 1, y: 0, tiles: ["grass-2", "dirt", "wooden-floor", "sw2"] },
      { x: 1, y: 0, z: 1, tiles: ["roof-1"] },
    ]);
    expect(levelsAboveShouldHide(map, mapTiles, origin)).toBe(false);
  });

  it("hides next to a window into a building with a storey above", () => {
    const map = mapAt([
      { x: 0, y: 0, tiles: ["grass-2", "dirt"] },
      { x: 1, y: 0, tiles: ["grass-2", "dirt", "wooden-floor", "window-1"] },
      { x: 1, y: 0, z: 1, tiles: ["wooden-floor", "sw2"] },
    ]);
    expect(levelsAboveShouldHide(map, mapTiles, origin)).toBe(true);
  });

  it("does not hide against that same building away from the window", () => {
    const map = mapAt([
      { x: 0, y: 0, tiles: ["grass-2", "dirt"] },
      { x: 1, y: 0, tiles: ["grass-2", "dirt", "wooden-floor", "sw2"] },
      { x: 1, y: 0, z: 1, tiles: ["wooden-floor", "sw2"] },
    ]);
    expect(levelsAboveShouldHide(map, mapTiles, origin)).toBe(false);
  });
});

describe("occluders out at the probe radius", () => {
  // The probe only gathers occluders near the anchor. These pin that box wide
  // enough: an occluder two cells out still has to count, which a tighter
  // gather would miss — and missing an occluder fails open, hiding the roof
  // when the player cannot actually see under it.
  it("a solid wall at the far probe cell blocks seeing content above it", () => {
    const map = mapAt([
      { x: 0, y: 0, tiles: ["floor"] },
      { x: 1, y: 0, tiles: ["floor"] },
      { x: 2, y: 0, tiles: ["floor", "wall"] },
      { x: 2, y: 0, z: 1, tiles: ["roof"] },
    ]);
    expect(
      levelsAboveShouldHide(map, tilesById, { x: 0, y: 0, z: 0 }),
    ).toBe(false);
  });

  it("still hides when that far cell is see-through", () => {
    const map = mapAt([
      { x: 0, y: 0, tiles: ["floor"] },
      { x: 1, y: 0, tiles: ["floor"] },
      { x: 2, y: 0, tiles: ["floor", "window"] },
      { x: 2, y: 0, z: 1, tiles: ["roof"] },
    ]);
    expect(
      levelsAboveShouldHide(map, tilesById, { x: 0, y: 0, z: 0 }),
    ).toBe(true);
  });

  it("a wall midway blocks content above the cell beyond it", () => {
    const map = mapAt([
      { x: 0, y: 0, tiles: ["floor"] },
      { x: 1, y: 0, tiles: ["floor", "wall"] },
      { x: 2, y: 0, tiles: ["floor"] },
      { x: 2, y: 0, z: 1, tiles: ["roof"] },
    ]);
    expect(
      levelsAboveShouldHide(map, tilesById, { x: 0, y: 0, z: 0 }),
    ).toBe(false);
  });

  it("VIEW_RADIUS reaches at least two cells, which the box must cover", () => {
    expect(VIEW_RADIUS).toBeGreaterThanOrEqual(2);
  });
});
