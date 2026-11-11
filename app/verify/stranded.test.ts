import { describe, expect, it } from "vitest";
import { shippedTiles } from "../game/testShippedTiles";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile, PlacedTile } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { findStranded } from "./stranded";

const tilesById = tilesByIdFromList(shippedTiles());

const GRASS: PlacedTile = { tileId: "grass-2" };
const STONE: PlacedTile = { tileId: "half-stone" };

/**
 * A lawn nine cells wide inside a ring of trees, with the player at its west
 * end. A wall of raised ground one level up stands across it at x 5 and 6 over
 * the rows given, with a ramp up its west face on the middle row.
 */
function lawnWithHill(hillRows: readonly number[]): MapFile {
  let map = emptyMap();
  for (let y = -1; y <= 5; y++) {
    for (let x = -1; x <= 9; x++) {
      const edge = x === -1 || x === 9 || y === -1 || y === 5;
      map = replaceStack(map, x, y, 0, edge ? [GRASS, { tileId: "tree" }] : [GRASS]);
    }
  }
  for (const y of hillRows) {
    for (const x of [5, 6]) {
      map = replaceStack(map, x, y, 0, [GRASS, STONE, STONE]);
      map = replaceStack(map, x, y, 1, [GRASS]);
    }
  }
  map = replaceStack(map, 3, 2, 0, [GRASS, { tileId: "ramp", direction: "w" }]);
  map = replaceStack(map, 4, 2, 0, [GRASS, STONE, { tileId: "ramp", direction: "w" }]);
  return replaceStack(map, 0, 2, 0, [GRASS, { tileId: "player" }]);
}

describe("findStranded", () => {
  it("finds nothing where the ground below a ledge leads back to the ramp", () => {
    const report = findStranded(lawnWithHill([1, 2, 3]), tilesById, {});
    expect(report.ok).toBe(true);
    expect(report.regions).toEqual([]);
  });

  it("reports the ground a player can only drop into, and the drops that lead there", () => {
    const report = findStranded(lawnWithHill([0, 1, 2, 3, 4]), tilesById, {});
    expect(report.ok).toBe(false);
    expect(report.regions).toHaveLength(1);

    const [pocket] = report.regions;
    const cells = pocket!.cells.map((c) => `${c.x},${c.y},${c.z}`).sort();
    const beyond = [7, 8].flatMap((x) => [0, 1, 2, 3, 4].map((y) => `${x},${y},0`)).sort();
    expect(cells).toEqual(beyond);
    expect(pocket!.entrances.length).toBeGreaterThan(0);
    for (const entrance of pocket!.entrances) {
      expect(entrance.by).toBe("drop");
      expect(entrance.from).toMatchObject({ x: 6, z: 1 });
      expect(entrance.to).toMatchObject({ x: 7, z: 0 });
    }
  });

  it("does not count a creature standing in the way round as a wall", () => {
    let map = lawnWithHill([1, 2, 3]);
    for (const y of [0, 4]) map = replaceStack(map, 7, y, 0, [GRASS, { tileId: "rat" }]);
    expect(findStranded(map, tilesById, {}).ok).toBe(true);
  });

  it("has nothing to say about a map with no player on it", () => {
    const report = findStranded(replaceStack(emptyMap(), 0, 0, 0, [GRASS]), tilesById, {});
    expect(report).toMatchObject({ ok: false, start: null, stranded: 0 });
  });
});
