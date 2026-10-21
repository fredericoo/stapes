import { describe, expect, it } from "vitest";
import { emptyMap, replaceStack } from "../lib/mapData";
import { tile } from "../lib/testTile";
import type { Coord, MapFile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL } from "../lib/types";
import { castReaching } from "./castApproach";
import { findPath } from "./pathfinding";

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "wall", height: HEIGHT_PER_LEVEL, walkable: false, lightPassing: false }),
  tile({ id: "rat", height: 2, actor: true, affectedByGravity: true, walkable: false }),
];

const tilesById = Object.fromEntries(tiles.map((def) => [def.id, def]));

const REACH = { cells: 3, height: 2 };

const HALF = 8;

function field(): MapFile {
  let map = emptyMap();
  for (let x = -HALF; x <= HALF; x++) {
    for (let y = -HALF; y <= HALF; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  return map;
}

function put(map: MapFile, x: number, y: number, tileId: string): MapFile {
  return replaceStack(map, x, y, 0, [{ tileId: "grass" }, { tileId }]);
}

function standing(x: number, y: number) {
  return { x, y, z: 0, stackIndex: 1 };
}

function walkIntoRange(map: MapFile, from: Coord, to: Coord): Coord | null {
  const self = standing(from.x, from.y);
  const target = standing(to.x, to.y);
  const reaching = castReaching(tilesById, REACH, () => ({ map, self, target }));
  const found = findPath(
    map,
    { at: self, self },
    target,
    tilesById.rat!,
    tilesById,
    {},
    {
      arrive: reaching,
    },
  );
  if (!found.ok) return null;
  return found.route.at(-1)?.to ?? from;
}

describe("castReaching", () => {
  it("stops the walk at the first cell the target is in reach from", () => {
    const map = put(put(field(), -6, 0, "rat"), 4, 0, "rat");
    expect(walkIntoRange(map, { x: -6, y: 0, z: 0 }, { x: 4, y: 0, z: 0 })).toEqual({
      x: 1,
      y: 0,
      z: 0,
    });
  });

  it("walks past a cell in reach that a wall hides the target from", () => {
    let map = put(put(field(), -6, 0, "rat"), 4, 0, "rat");
    for (let y = -2; y <= 2; y++) map = put(map, 3, y, "wall");
    const stop = walkIntoRange(map, { x: -6, y: 0, z: 0 }, { x: 4, y: 0, z: 0 });
    expect(stop).not.toBeNull();
    expect(stop!.x).toBeGreaterThan(3);
  });
});
