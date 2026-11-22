import { describe, expect, it } from "vitest";
import {
  emptyMap,
  flattenMap,
  getStack,
  parseMap,
  parseSharedMap,
  replaceStack,
  serializeMap,
  shareMap,
} from "./mapData";
import type { MapFile, PlacedTile } from "./types";

function mapAt(cells: Array<[x: number, y: number, z: number, stack: PlacedTile[]]>): MapFile {
  let map = emptyMap();
  for (const [x, y, z, stack] of cells) map = replaceStack(map, x, y, z, stack);
  return map;
}

const grass = (): PlacedTile[] => [{ tileId: "grass" }];

describe("parseSharedMap", () => {
  const authored = mapAt([
    [0, 0, 0, grass()],
    [1, 0, 0, grass()],
    [-17, -3, 0, [{ tileId: "sand" }, { tileId: "bush", direction: "s" }]],
    [40, 40, -2, [{ tileId: "sign", inscription: 'says "hi",\nthen }' }]],
    [5, 5, 3, [{ tileId: "chest", contents: [{ id: "i1", tileId: "coin", count: 3 }] }]],
    [6, 5, 3, [{ tileId: "door", teleportTo: { x: 1, y: 2, z: 0 } }]],
  ]);

  it("reads a serialized map into the same cells as parseMap", () => {
    const text = serializeMap(authored);
    expect(flattenMap(parseSharedMap(text))).toEqual(flattenMap(parseMap(text)));
  });

  it("reads any other layout of the same JSON into the same cells", () => {
    const compact = JSON.stringify(flattenMap(authored));
    expect(flattenMap(parseSharedMap(compact))).toEqual(flattenMap(authored));
  });

  it("reads an older map version through the same migration as parseMap", () => {
    const old = JSON.stringify({
      version: 1,
      levels: { "0": { "2,2": [{ tileId: "sign", description: "old words" }] } },
    });
    expect(getStack(parseSharedMap(old), 2, 2, 0)).toEqual([
      { tileId: "sign", inscription: "old words" },
    ]);
  });

  it("gives an edit to one cell no reach into another that held the same tiles", () => {
    const map = parseSharedMap(serializeMap(authored));
    const edited = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "flower" }]);
    expect(getStack(edited, 0, 0, 0)).toEqual([{ tileId: "grass" }, { tileId: "flower" }]);
    expect(getStack(edited, 1, 0, 0)).toEqual(grass());
  });
});

describe("shareMap", () => {
  it("leaves the caller's map untouched when the shared copy is edited", () => {
    const own = mapAt([
      [0, 0, 0, grass()],
      [3, 3, 0, [{ tileId: "chest", contents: [{ id: "i2", tileId: "coin", count: 1 }] }]],
    ]);
    const before = structuredClone(own);
    const shared = shareMap(own);
    getStack(shared, 3, 3, 0)[0]!.contents!.push({ id: "i3", tileId: "gem" });
    replaceStack(shared, 0, 0, 0, []);
    expect(own).toEqual(before);
  });
});
