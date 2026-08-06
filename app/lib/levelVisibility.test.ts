import { describe, expect, it } from "vitest";
import mapFile from "../../data/map.json";
import tilesFile from "../../data/tiles.json";
import {
  VIEW_RADIUS,
  levelsAboveShouldHide,
  viewAnchorFromSnapshot,
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

describe("levelsAboveShouldHide on the current map", () => {
  const map = mapFile as MapFile;
  const mapTiles = tilesByIdFromList(
    (tilesFile as Array<Parameters<typeof normalizeTileDef>[0]>).map((t) =>
      normalizeTileDef(t),
    ),
  );

  it.each([
    // Covered house doorway at 12,5 — within 2.5 and clear LOS
    [{ x: 10, y: 5, z: 0 }, true],
    [{ x: 10, y: 4, z: 0 }, true],
    [{ x: 10, y: 6, z: 0 }, true],
    // Outside radius of the house
    [{ x: 9, y: 5, z: 0 }, false],
    // Against the solid east wall — no LOS in
    [{ x: 17, y: 5, z: 0 }, false],
    // Next to the window looking into the tall covered building
    [{ x: 17, y: -6, z: 0 }, true],
    // Against the solid wall, away from the window
    [{ x: 17, y: -4, z: 0 }, false],
  ] as const)("%j → hide=%s", (view, hide) => {
    expect(levelsAboveShouldHide(map, mapTiles, view)).toBe(hide);
  });
});
