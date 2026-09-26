import { describe, expect, it } from "vitest";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import type { RoofCut } from "../lib/levelVisibility";
import { coordKey } from "../lib/types";
import { isCellVisible, isHiddenFromCamera } from "./cameraSight";
import { tile } from "../lib/testTile";

function cutting(floor: number, ...cells: Array<{ x: number; y: number; z: number }>): RoofCut {
  const byZ = new Map<number, Set<string>>();
  for (const cell of cells) {
    const level = byZ.get(cell.z) ?? new Set<string>();
    level.add(coordKey(cell.x, cell.y));
    byZ.set(cell.z, level);
  }
  return { floor, cells: byZ };
}

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "floor", height: 0, walkable: true }),
  tile({ id: "wall", height: 4, walkable: false }),
  tile({ id: "glass", height: 4, walkable: false, lightPassing: true }),
];

const tilesById = Object.fromEntries(tiles.map((t) => [t.id, t]));

function field(z = 0): MapFile {
  let map = emptyMap();
  for (let x = -6; x <= 6; x++) {
    for (let y = -6; y <= 6; y++) {
      map = replaceStack(map, x, y, z, [{ tileId: "grass" }]);
    }
  }
  return map;
}

function put(map: MapFile, x: number, y: number, z: number, tileId: string): MapFile {
  return replaceStack(map, x, y, z, [{ tileId }]);
}

const origin = { x: 0, y: 0, z: 0 };

describe("camera sight", () => {
  it("sees a body under open sky", () => {
    expect(isHiddenFromCamera(field(), tilesById, origin, origin.z, undefined)).toBe(false);
  });

  it("hides a body under a floor on the diagonal", () => {
    const map = put(field(-1), 1, 1, 0, "floor");
    const inCave = { x: 0, y: 0, z: -1 };

    expect(isHiddenFromCamera(map, tilesById, inCave, inCave.z, undefined)).toBe(true);
  });

  it("keeps a body hidden when the gap is off the ray", () => {
    let map = field(-1);
    for (let x = -2; x <= 2; x++) {
      for (let y = -2; y <= 2; y++) {
        if (x === 2 && y === 2) continue;
        map = put(map, x, y, 0, "floor");
      }
    }

    expect(isHiddenFromCamera(map, tilesById, { x: 0, y: 0, z: -1 }, -1, undefined)).toBe(true);
    expect(isHiddenFromCamera(map, tilesById, { x: 1, y: 1, z: -1 }, -1, undefined)).toBe(false);
  });

  it("is not fooled by a ceiling one cell off the ray", () => {
    for (const [dx, dy] of [
      [0, 1],
      [1, 0],
      [2, 2],
      [-1, -1],
    ]) {
      const map = put(field(), dx, dy, 1, "wall");
      expect(isHiddenFromCamera(map, tilesById, origin, origin.z, undefined)).toBe(false);
    }
  });

  it("follows the diagonal up through every level", () => {
    for (const k of [1, 2, 3]) {
      const map = put(field(), k, k, k, "wall");
      expect(isHiddenFromCamera(map, tilesById, origin, origin.z, undefined)).toBe(true);
    }
  });

  it("reads a body through something light passes", () => {
    const map = put(field(), 1, 1, 1, "glass");

    expect(isHiddenFromCamera(map, tilesById, origin, origin.z, undefined)).toBe(false);
  });

  it("ignores anything the roof-cut has taken away", () => {
    const map = put(field(), 1, 1, 1, "wall");
    const cut = cutting(0, { x: 1, y: 1, z: 1 });

    expect(isHiddenFromCamera(map, tilesById, origin, origin.z, cut)).toBe(false);
  });

  it("still counts a roof the cut left standing", () => {
    const map = put(field(), 1, 1, 1, "wall");
    const elsewhere = cutting(0, { x: 5, y: 5, z: 1 });

    expect(isHiddenFromCamera(map, tilesById, origin, origin.z, elsewhere)).toBe(true);
  });

  it("is never hidden by its own cell", () => {
    const map = put(field(), 0, 0, 0, "wall");

    expect(isHiddenFromCamera(map, tilesById, origin, origin.z, undefined)).toBe(false);
  });

  it("hides a body under a floor between it and the viewer", () => {
    const map = put(field(-1), 0, 0, 0, "floor");
    const below = { x: 0, y: 0, z: -1 };

    expect(isHiddenFromCamera(map, tilesById, below, 0, undefined)).toBe(true);
    expect(isHiddenFromCamera(map, tilesById, below, -1, undefined)).toBe(false);
  });

  it("counts every floor up to the viewer, not just the first", () => {
    let map = put(field(-2), 0, 0, -1, "floor");
    map = put(map, 0, 0, 0, "floor");
    const deep = { x: 0, y: 0, z: -2 };

    expect(isHiddenFromCamera(map, tilesById, deep, 0, undefined)).toBe(true);
  });
});

describe("isCellVisible", () => {
  it("shows the viewer's own floor whatever is standing on it", () => {
    const map = put(field(), 1, 1, 1, "wall");

    expect(isCellVisible(map, tilesById, origin, 0, undefined)).toBe(true);
  });

  it("hides a cell the roof-cut has taken", () => {
    const map = put(field(), 0, 0, 1, "floor");
    const above = { x: 0, y: 0, z: 1 };
    const cut = cutting(0, above);

    expect(isCellVisible(map, tilesById, above, 0, cut)).toBe(false);
  });

  it("hides a blow struck a storey down under a cave roof", () => {
    const map = put(field(-1), 0, 0, 0, "floor");

    expect(isCellVisible(map, tilesById, { x: 0, y: 0, z: -1 }, 0, undefined)).toBe(false);
  });

  it("still shows a storey down that is open to the sky", () => {
    const map = field(-1);

    expect(isCellVisible(map, tilesById, { x: 0, y: 0, z: -1 }, 0, undefined)).toBe(true);
  });
});
