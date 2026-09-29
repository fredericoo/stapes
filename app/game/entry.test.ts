import { MAP_FILE_VERSION } from "../lib/types";
import { describe, expect, it } from "vitest";
import { ENTRY_SEARCH_RADIUS, findEntryCell } from "./entry";
import { chunkifyMap } from "../lib/mapData";
import type { FlatMapFile, MapFile, PlacedTile, TileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { FRAME, tile } from "../lib/testTile";

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "slab", height: 2 }),
  tile({ id: "wall", height: 4, walkable: false }),
  tile({
    id: "player",
    height: 4,
    directional: true,
    affectedByGravity: true,
    walkable: false,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
  }),
];

const tilesById = tilesByIdFromList(tiles);

const grass = { tileId: "grass" } as PlacedTile;
const slab = { tileId: "slab" } as PlacedTile;
const wall = { tileId: "wall" } as PlacedTile;

const SPAWN = { x: 20, y: 20, z: 0 };

function floorWith(
  built: Record<string, PlacedTile[]>,
  upstairs: Record<string, PlacedTile[]> = {},
): MapFile {
  const ground: Record<string, PlacedTile[]> = {};
  for (let y = -10; y <= 22; y++) {
    for (let x = -10; x <= 22; x++) ground[`${x},${y}`] = [grass];
  }
  return chunkifyMap({
    version: MAP_FILE_VERSION,
    levels: { "0": { ...ground, ...built }, "1": upstairs },
  } as unknown as FlatMapFile);
}

const WAS_AT = { x: 0, y: 0, z: 0 };

describe("findEntryCell", () => {
  it("puts somebody back exactly where they were when it is still free", () => {
    const map = floorWith({});
    expect(findEntryCell(map, tilesById, WAS_AT, SPAWN)).toEqual(WAS_AT);
  });

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

  it("gives up at the spawn point rather than searching the world", () => {
    const blocked: Record<string, PlacedTile[]> = {};
    const reach = ENTRY_SEARCH_RADIUS;
    for (let y = -reach; y <= reach; y++) {
      for (let x = -reach; x <= reach; x++) blocked[`${x},${y}`] = [grass, wall];
    }
    expect(findEntryCell(floorWith(blocked), tilesById, WAS_AT, SPAWN)).toEqual(SPAWN);
  });
});
