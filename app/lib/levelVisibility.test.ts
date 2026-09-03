import { describe, expect, it } from "vitest";
import { chunkifyMap } from "./mapData";
import type { FlatMapFile } from "./types";
import tilesFile from "../../data/tiles.json";
import {
  MAX_CUT_CELLS,
  type RoofCut,
  VIEW_RADIUS,
  cutHides,
  cutHidesWholeLevel,
  roofCutFor,
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
const half = tile({ id: "half", height: 2 });
const wall = tile({ id: "wall", height: 4 });
const window = tile({ id: "window", height: 4, lightPassing: true });
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
    // landingAbs 4 → level 1 (one whole HEIGHT_PER_LEVEL up)
    expect(
      viewAnchorFor({
        x: 3,
        y: 4,
        z: 2,
        walk: null,
        fall: { landingAbs: 4 },
      }),
    ).toEqual({ x: 3, y: 4, z: 1 });
  });
});

/**
 * Does the cut take anything at all? The question the old boolean roof-cut
 * asked, kept because every case below it is still a case about the probe —
 * which cells the viewer can see above themselves — and the probe did not
 * change when the cut stopped being a storey.
 */
function cuts(
  map: MapFile,
  tiles: Record<string, TileDef>,
  view: { x: number; y: number; z: number },
  radius?: number,
): boolean {
  return roofCutFor(map, tiles, view, radius) !== undefined;
}

/** Every cut cell as `z:x,y`, for asserting the shape of one structure. */
function cutCells(cut: RoofCut | undefined): string[] {
  if (!cut || cut.cells === null) return [];
  const out: string[] = [];
  for (const [z, cells] of cut.cells) {
    for (const key of cells) out.push(`${z}:${key}`);
  }
  return out.sort();
}

describe("the roof-cut probe", () => {
  const view = { x: 0, y: 0, z: 0 };

  it("hides when a roof is over the view cell", () => {
    const map = mapAt([
      { x: 0, y: 0, z: 0, tiles: ["floor"] },
      { x: 0, y: 0, z: 1, tiles: ["roof"] },
    ]);
    expect(cuts(map, tilesById, view)).toBe(true);
  });

  it("does not hide when there is nothing above in range", () => {
    const map = mapAt([{ x: 0, y: 0, z: 0, tiles: ["floor"] }]);
    expect(cuts(map, tilesById, view)).toBe(false);
  });

  it("does not hide when content is only below the view level", () => {
    const map = mapAt([
      { x: 0, y: 0, z: 0, tiles: ["floor"] },
      { x: 0, y: 0, z: -1, tiles: ["floor"] },
    ]);
    expect(cuts(map, tilesById, view)).toBe(false);
  });

  it("does not hide a roof behind a solid wall", () => {
    const map = mapAt([
      { x: 0, y: 0, z: 0, tiles: ["floor"] },
      { x: 1, y: 0, z: 0, tiles: ["wall"] },
      { x: 2, y: 0, z: 0, tiles: ["floor"] },
      { x: 2, y: 0, z: 1, tiles: ["roof"] },
    ]);
    expect(cuts(map, tilesById, view)).toBe(false);
  });

  it("does not hide when standing against a solid wall with content above", () => {
    const map = mapAt([
      { x: 0, y: 0, z: 0, tiles: ["floor"] },
      { x: 1, y: 0, z: 0, tiles: ["wall"] },
      { x: 1, y: 0, z: 1, tiles: ["roof"] },
    ]);
    expect(cuts(map, tilesById, view)).toBe(false);
  });

  it("hides through a light-passing window into a covered cell", () => {
    const map = mapAt([
      { x: 0, y: 0, z: 0, tiles: ["floor"] },
      { x: 1, y: 0, z: 0, tiles: ["window"] },
      { x: 1, y: 0, z: 1, tiles: ["roof"] },
    ]);
    expect(cuts(map, tilesById, view)).toBe(true);
  });

  it("hides when a roof is visible past open floor", () => {
    const map = mapAt([
      { x: 0, y: 0, z: 0, tiles: ["floor"] },
      { x: 1, y: 0, z: 0, tiles: ["floor"] },
      { x: 2, y: 0, z: 0, tiles: ["floor"] },
      { x: 2, y: 0, z: 1, tiles: ["roof"] },
    ]);
    expect(cuts(map, tilesById, view)).toBe(true);
  });

  it("includes a roof just inside the Euclidean radius", () => {
    // (2, 1) → dist √5 ≈ 2.236 ≤ 2.5
    const map = mapAt([
      { x: 0, y: 0, z: 0, tiles: ["floor"] },
      { x: 2, y: 1, z: 1, tiles: ["roof"] },
    ]);
    expect(cuts(map, tilesById, view, VIEW_RADIUS)).toBe(
      true,
    );
  });

  it("excludes a roof just outside the Euclidean radius", () => {
    // (2, 2) → dist √8 ≈ 2.828 > 2.5
    const map = mapAt([
      { x: 0, y: 0, z: 0, tiles: ["floor"] },
      { x: 2, y: 2, z: 1, tiles: ["roof"] },
    ]);
    expect(cuts(map, tilesById, view, VIEW_RADIUS)).toBe(
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
    expect(cuts(map, tilesById, view)).toBe(false);
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
describe("the roof-cut probe with the shipped tiles", () => {
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
    expect(cuts(map, mapTiles, origin)).toBe(true);
  });

  it("does not hide one cell further back, outside the radius", () => {
    const map = mapAt([
      { x: 0, y: 0, tiles: ["grass-2", "cobblestone"] },
      { x: 1, y: 0, tiles: ["grass-2", "cobblestone"] },
      { x: 2, y: 0, tiles: ["grass-2", "cobblestone"] },
      { x: 3, y: 0, tiles: ["wooden-floor"] },
      { x: 3, y: 0, z: 1, tiles: ["roof-1"] },
    ]);
    expect(cuts(map, mapTiles, origin)).toBe(false);
  });

  it("does not hide standing against a roofed building's solid wall", () => {
    const map = mapAt([
      { x: 0, y: 0, tiles: ["grass-2", "dirt"] },
      { x: 1, y: 0, tiles: ["grass-2", "dirt", "wooden-floor", "sw2"] },
      { x: 1, y: 0, z: 1, tiles: ["roof-1"] },
    ]);
    expect(cuts(map, mapTiles, origin)).toBe(false);
  });

  it("hides next to a window into a building with a storey above", () => {
    const map = mapAt([
      { x: 0, y: 0, tiles: ["grass-2", "dirt"] },
      { x: 1, y: 0, tiles: ["grass-2", "dirt", "wooden-floor", "window-1"] },
      { x: 1, y: 0, z: 1, tiles: ["wooden-floor", "sw2"] },
    ]);
    expect(cuts(map, mapTiles, origin)).toBe(true);
  });

  it("does not hide against that same building away from the window", () => {
    const map = mapAt([
      { x: 0, y: 0, tiles: ["grass-2", "dirt"] },
      { x: 1, y: 0, tiles: ["grass-2", "dirt", "wooden-floor", "sw2"] },
      { x: 1, y: 0, z: 1, tiles: ["wooden-floor", "sw2"] },
    ]);
    expect(cuts(map, mapTiles, origin)).toBe(false);
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
      cuts(map, tilesById, { x: 0, y: 0, z: 0 }),
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
      cuts(map, tilesById, { x: 0, y: 0, z: 0 }),
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
      cuts(map, tilesById, { x: 0, y: 0, z: 0 }),
    ).toBe(false);
  });

  it("VIEW_RADIUS reaches at least two cells, which the box must cover", () => {
    expect(VIEW_RADIUS).toBeGreaterThanOrEqual(2);
  });
});

/**
 * A house is a house, and the one next door is not.
 *
 * The geometry here is the smallest thing that can tell the two apart: two
 * one-cell rooms with a gap between them, each with its own roof. Before the
 * cut was a structure, standing in either lifted both roofs.
 */
describe("roofCutFor picks out one structure", () => {
  const inside = { x: 0, y: 0, z: 0 };

  /** Two roofed rooms at x=0 and x=3, far enough apart to be separate. */
  const twoHouses = mapAt([
    { x: 0, y: 0, tiles: ["floor"] },
    { x: 0, y: 0, z: 1, tiles: ["roof"] },
    { x: 3, y: 0, tiles: ["floor"] },
    { x: 3, y: 0, z: 1, tiles: ["roof"] },
  ]);

  it("cuts the roof over the viewer", () => {
    const cut = roofCutFor(twoHouses, tilesById, inside);
    expect(cutHides(cut, 0, 0, 1)).toBe(true);
  });

  it("leaves the other house's roof alone", () => {
    const cut = roofCutFor(twoHouses, tilesById, inside);
    expect(cutHides(cut, 3, 0, 1)).toBe(false);
  });

  it("cuts nothing at or below the viewer's own level", () => {
    const cut = roofCutFor(twoHouses, tilesById, inside);
    expect(cutHides(cut, 0, 0, 0)).toBe(false);
    expect(cutHides(cut, 0, 0, -1)).toBe(false);
  });

  it("takes the whole roof, including the part out of probe range", () => {
    // The roof runs six cells east; the probe reaches two and a half. The fill
    // is what carries the cut to the far end, and has to — half a roof drawn is
    // worse than none of it cut.
    const map = mapAt([
      { x: 0, y: 0, tiles: ["floor"] },
      ...[0, 1, 2, 3, 4, 5].map((x) => ({ x, y: 0, z: 1, tiles: ["roof"] })),
    ]);
    const cut = roofCutFor(map, tilesById, inside);
    expect(cutCells(cut)).toEqual([
      "1:0,0",
      "1:1,0",
      "1:2,0",
      "1:3,0",
      "1:4,0",
      "1:5,0",
    ]);
  });

  it("stops at a gap in the roof", () => {
    // Same run of roof with cell 3 missing: what is past the gap is a different
    // structure, and stays drawn.
    const map = mapAt([
      { x: 0, y: 0, tiles: ["floor"] },
      ...[0, 1, 2, 4, 5].map((x) => ({ x, y: 0, z: 1, tiles: ["roof"] })),
    ]);
    const cut = roofCutFor(map, tilesById, inside);
    expect(cutHides(cut, 2, 0, 1)).toBe(true);
    expect(cutHides(cut, 4, 0, 1)).toBe(false);
  });

  it("climbs to the storey above the storey it cut", () => {
    // A two-storey house: the upper floor is cut with the roof over it, because
    // the roof would otherwise be all that lifted and the floor beneath it is
    // just as much in the way.
    const map = mapAt([
      { x: 0, y: 0, tiles: ["floor"] },
      { x: 0, y: 0, z: 1, tiles: ["floor", "wall"] },
      { x: 0, y: 0, z: 2, tiles: ["roof"] },
    ]);
    const cut = roofCutFor(map, tilesById, inside);
    expect(cutHides(cut, 0, 0, 1)).toBe(true);
    expect(cutHides(cut, 0, 0, 2)).toBe(true);
  });

  it("cuts only what is above the viewer's own storey", () => {
    // The same house, stood in from the upper floor: its own floor is under the
    // viewer's feet now and only the roof is overhead.
    const map = mapAt([
      { x: 0, y: 0, tiles: ["floor"] },
      { x: 0, y: 0, z: 1, tiles: ["floor", "wall"] },
      { x: 0, y: 0, z: 2, tiles: ["roof"] },
    ]);
    const cut = roofCutFor(map, tilesById, { x: 0, y: 0, z: 1 });
    expect(cutCells(cut)).toEqual(["2:0,0"]);
  });

  it("merges roofs that touch only at a corner", () => {
    // 26-way adjacency, stated as a test because it is a decision and not a
    // detail: two structures that touch diagonally cut as one. See fillStructure
    // for why that is the safe direction to be wrong in.
    const map = mapAt([
      { x: 0, y: 0, tiles: ["floor"] },
      { x: 0, y: 0, z: 1, tiles: ["roof"] },
      { x: 1, y: 1, z: 1, tiles: ["roof"] },
    ]);
    const cut = roofCutFor(map, tilesById, inside);
    expect(cutHides(cut, 1, 1, 1)).toBe(true);
  });

  it("does not reach a roof two cells clear of the one it cut", () => {
    const map = mapAt([
      { x: 0, y: 0, tiles: ["floor"] },
      { x: 0, y: 0, z: 1, tiles: ["roof"] },
      { x: 2, y: 2, z: 1, tiles: ["roof"] },
    ]);
    const cut = roofCutFor(map, tilesById, inside);
    expect(cutHides(cut, 2, 2, 1)).toBe(false);
  });
});

/**
 * Terrain is not a structure, and the cut says so by giving up.
 *
 * A continuous slab above the viewer — the level over a cliff, a cave ceiling —
 * has no building in it to single out. The fill refuses past MAX_CUT_CELLS and
 * the cut degrades to the whole storey, which is what this did before it could
 * tell one house from another.
 */
describe("roofCutFor falls back to the whole storey", () => {
  it("cuts every level above once the fill runs past its budget", () => {
    const side = 80; // 6400 cells, comfortably past MAX_CUT_CELLS
    expect(side * side).toBeGreaterThan(MAX_CUT_CELLS);
    const cells: Array<{ x: number; y: number; z?: number; tiles: string[] }> =
      [{ x: 0, y: 0, tiles: ["floor"] }];
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        cells.push({ x, y, z: 1, tiles: ["floor"] });
      }
    }
    const cut = roofCutFor(mapAt(cells), tilesById, { x: 0, y: 0, z: 0 });

    expect(cut?.cells).toBeNull();
    expect(cutHides(cut, 79, 79, 1)).toBe(true);
    // And a level with nothing on it at all, since the fallback is a threshold
    // rather than a set of cells.
    expect(cutHides(cut, 500, 500, 4)).toBe(true);
    expect(cutHides(cut, 0, 0, 0)).toBe(false);
  });

  it("reports the whole-storey cut so a caller can skip drawing the level", () => {
    const cut: RoofCut = { floor: 0, cells: null };
    expect(cutHidesWholeLevel(cut, 1)).toBe(true);
    expect(cutHidesWholeLevel(cut, 0)).toBe(false);
    expect(cutHidesWholeLevel({ floor: 0, cells: new Map() }, 1)).toBe(false);
    expect(cutHidesWholeLevel(undefined, 1)).toBe(false);
  });
});
