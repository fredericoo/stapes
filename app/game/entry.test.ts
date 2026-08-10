import { describe, expect, it } from "vitest";
import { ENTRY_SEARCH_RADIUS, findEntryCell } from "./entry";
import { chunkifyMap } from "../lib/mapData";
import type { FlatMapFile, MapFile, PlacedTile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";

/**
 * Where a returning player is put back.
 *
 * The world keeps moving while somebody is away, so their last position is the
 * one piece of restored state that can be *wrong* by the time it is used — and
 * the ways it goes wrong are geometric rather than obvious. These cover the
 * three answers: the cell itself, a neighbour, and giving up.
 */

const frame = {
  sprite: {
    tilesetId: "basic",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  durationMs: 200,
};

function tile(
  partial: Record<string, unknown> & Pick<TileDef, "id" | "height">,
): TileDef {
  return normalizeTileDef({
    name: partial.id,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    ...partial,
  });
}

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  // Half a level. On its own it leaves exactly enough headroom for a player;
  // under a roof it does not, which is the case this whole module exists for.
  tile({ id: "slab", height: 1 }),
  tile({ id: "wall", height: 2, walkable: false }),
  tile({
    id: "player",
    height: 2,
    directional: true,
    affectedByGravity: true,
    walkable: false,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
  }),
];

const tilesById = tilesByIdFromList(tiles);

const grass = { tileId: "grass" } as PlacedTile;
const slab = { tileId: "slab" } as PlacedTile;
const wall = { tileId: "wall" } as PlacedTile;

/** Where the map's authored spawn marker sits, well away from the test cells. */
const SPAWN = { x: 20, y: 20, z: 0 };

/** A floor of grass, with whatever the caller has built on top of it. */
function floorWith(
  built: Record<string, PlacedTile[]>,
  upstairs: Record<string, PlacedTile[]> = {},
): MapFile {
  const ground: Record<string, PlacedTile[]> = {};
  for (let y = -10; y <= 22; y++) {
    for (let x = -10; x <= 22; x++) ground[`${x},${y}`] = [grass];
  }
  return chunkifyMap({
    version: 1,
    levels: { "0": { ...ground, ...built }, "1": upstairs },
  } as unknown as FlatMapFile);
}

const WAS_AT = { x: 0, y: 0, z: 0 };

describe("findEntryCell", () => {
  it("puts somebody back exactly where they were when it is still free", () => {
    const map = floorWith({});
    expect(findEntryCell(map, tilesById, WAS_AT, SPAWN)).toEqual(WAS_AT);
  });

  /**
   * The case the whole search is for, and the reason the check is volume rather
   * than "is there a tile here". A slab alone leaves a player room to stand on
   * it; the same slab with a floor overhead does not, and nothing about the
   * cell they were in has visibly changed.
   */
  it("moves them off a cell a roof has closed over a slab", () => {
    const map = floorWith({ "0,0": [grass, slab] }, { "0,0": [grass] });
    const found = findEntryCell(map, tilesById, WAS_AT, SPAWN);
    expect(found).not.toEqual(WAS_AT);
    expect(found).not.toEqual(SPAWN);
  });

  it("leaves them on a slab with open sky above it", () => {
    const map = floorWith({ "0,0": [grass, slab] });
    expect(findEntryCell(map, tilesById, WAS_AT, SPAWN)).toEqual(WAS_AT);
  });

  /**
   * West first, and it has to be pinned: any fixed order is correct, but only a
   * fixed one makes returning to the same blocked cell twice land in the same
   * place twice.
   */
  it("takes the west neighbour ahead of the other three", () => {
    const map = floorWith({ "0,0": [grass, wall] });
    expect(findEntryCell(map, tilesById, WAS_AT, SPAWN)).toEqual({
      x: -1,
      y: 0,
      z: 0,
    });
  });

  it("falls through W to N, E and S as each fills up", () => {
    const blocked: Record<string, PlacedTile[]> = {
      "0,0": [grass, wall],
      "-1,0": [grass, wall],
    };
    expect(findEntryCell(floorWith(blocked), tilesById, WAS_AT, SPAWN)).toEqual({
      x: 0,
      y: -1,
      z: 0,
    });

    blocked["0,-1"] = [grass, wall];
    expect(findEntryCell(floorWith(blocked), tilesById, WAS_AT, SPAWN)).toEqual({
      x: 1,
      y: 0,
      z: 0,
    });

    blocked["1,0"] = [grass, wall];
    expect(findEntryCell(floorWith(blocked), tilesById, WAS_AT, SPAWN)).toEqual({
      x: 0,
      y: 1,
      z: 0,
    });
  });

  /** Ring by ring: everything one step away is tried before anything two. */
  it("exhausts the near ring before reaching further out", () => {
    const blocked: Record<string, PlacedTile[]> = {};
    for (const [x, y] of [
      [0, 0],
      [-1, 0],
      [0, -1],
      [1, 0],
      [0, 1],
    ]) {
      blocked[`${x},${y}`] = [grass, wall];
    }
    const found = findEntryCell(floorWith(blocked), tilesById, WAS_AT, SPAWN);
    expect(Math.abs(found.x) + Math.abs(found.y)).toBe(2);
  });

  /**
   * The bound is the point, not an implementation detail: without it "find a
   * free cell" is a sweep of a map headed for thousands of cells square, run at
   * the moment somebody is waiting on a connection.
   */
  it("gives up at the spawn point rather than searching the world", () => {
    const blocked: Record<string, PlacedTile[]> = {};
    const reach = ENTRY_SEARCH_RADIUS;
    for (let y = -reach; y <= reach; y++) {
      for (let x = -reach; x <= reach; x++) blocked[`${x},${y}`] = [grass, wall];
    }
    expect(findEntryCell(floorWith(blocked), tilesById, WAS_AT, SPAWN)).toEqual(
      SPAWN,
    );
  });
});
