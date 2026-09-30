import { describe, expect, it } from "vitest";
import { settleAllSpans, settleSpans } from "./footprint";
import { appendTile, emptyMap, getStack, removeTileAt, replaceStack } from "./mapData";
import { tile } from "./testTile";
import type { MapFile, PlacedTile, TileDef } from "./types";
import { tilesByIdFromList } from "./validation";

const prop = (partial: Record<string, unknown> & Pick<TileDef, "id">) =>
  tile({ kind: "prop", ...partial });

const tilesById = tilesByIdFromList([
  prop({ id: "grass" }),
  prop({ id: "wall", height: 4 }),
  prop({ id: "bed", height: 1, footprint: { w: 2, d: 1 } }),
  prop({ id: "burnt-bed", height: 1, footprint: { w: 2, d: 1 } }),
  prop({ id: "ash", height: 0 }),
]);

/** A 3×3 lawn on level 0, with whatever else is listed on top. */
function lawn(extra: Array<[number, number, PlacedTile]> = []): MapFile {
  let map = emptyMap();
  for (let x = 0; x < 3; x++) {
    for (let y = 0; y < 3; y++) map = appendTile(map, x, y, 0, { tileId: "grass" });
  }
  for (const [x, y, placed] of extra) map = appendTile(map, x, y, 0, placed);
  return map;
}

/** The tile ids in a cell above the grass, each with whether it is a part. */
function above(map: MapFile, x: number, y: number): string[] {
  return getStack(map, x, y, 0)
    .slice(1)
    .map((p) => (p.span && (p.span.dx || p.span.dy) ? `${p.tileId} part` : p.tileId));
}

/** Put a tile down the way anything in the world does, and let the spans settle. */
function place(map: MapFile, x: number, y: number, placed: PlacedTile): MapFile {
  return settleSpans(map, appendTile(map, x, y, 0, placed), tilesById);
}

describe("settleSpans", () => {
  it("covers the cells west of a new placement facing south", () => {
    const map = place(lawn(), 1, 1, { tileId: "bed" });
    expect(above(map, 1, 1)).toEqual(["bed"]);
    expect(above(map, 0, 1)).toEqual(["bed part"]);
    expect(above(map, 1, 0)).toEqual([]);
  });

  it("turns the footprint with the facing", () => {
    const map = place(lawn(), 1, 1, { tileId: "bed", direction: "e" });
    expect(above(map, 1, 0)).toEqual(["bed part"]);
    expect(above(map, 0, 1)).toEqual([]);
    expect(getStack(map, 1, 0, 0)[1]!.direction).toBe("e");
  });

  it("removes every cell when the anchor is removed", () => {
    const placed = place(lawn(), 1, 1, { tileId: "bed" });
    const map = settleSpans(placed, removeTileAt(placed, 1, 1, 0, 1), tilesById);
    expect(above(map, 0, 1)).toEqual([]);
  });

  it("removes every cell when a part is removed", () => {
    const placed = place(lawn(), 1, 1, { tileId: "bed" });
    const map = settleSpans(placed, removeTileAt(placed, 0, 1, 0, 1), tilesById);
    expect(above(map, 1, 1)).toEqual([]);
  });

  it("carries a change to one part across the whole footprint", () => {
    const placed = place(lawn(), 1, 1, { tileId: "bed" });
    const part = getStack(placed, 0, 1, 0);
    const burnt = replaceStack(placed, 0, 1, 0, [part[0]!, { ...part[1]!, tileId: "burnt-bed" }]);
    const map = settleSpans(placed, burnt, tilesById);
    expect(above(map, 1, 1)).toEqual(["burnt-bed"]);
    expect(above(map, 0, 1)).toEqual(["burnt-bed part"]);
  });

  it("re-cuts the footprint when the anchor becomes a one-cell tile", () => {
    const placed = place(lawn(), 1, 1, { tileId: "bed" });
    const anchor = getStack(placed, 1, 1, 0);
    const ashed = replaceStack(placed, 1, 1, 0, [anchor[0]!, { ...anchor[1]!, tileId: "ash" }]);
    const map = settleSpans(placed, ashed, tilesById);
    expect(above(map, 0, 1)).toEqual([]);
    expect(getStack(map, 1, 1, 0)[1]).toEqual({ tileId: "ash" });
  });

  it("does not place a footprint one of whose cells cannot take it", () => {
    const map = place(lawn([[0, 1, { tileId: "wall" }]]), 1, 1, { tileId: "bed" });
    expect(above(map, 1, 1)).toEqual([]);
    expect(above(map, 0, 1)).toEqual(["wall"]);
  });

  it("keeps two footprints anchored in one cell apart", () => {
    const one = place(lawn(), 1, 1, { tileId: "bed" });
    const two = place(one, 1, 1, { tileId: "bed", direction: "e" });
    expect(above(two, 0, 1)).toEqual(["bed part"]);
    expect(above(two, 1, 0)).toEqual(["bed part"]);
    const map = settleSpans(two, removeTileAt(two, 1, 0, 0, 1), tilesById);
    expect(above(map, 1, 1)).toEqual(["bed"]);
    expect(above(map, 0, 1)).toEqual(["bed part"]);
  });
});

describe("settleAllSpans", () => {
  it("drops a part whose anchor is not there, and completes an anchor missing its parts", () => {
    const map = settleAllSpans(
      lawn([
        [2, 2, { tileId: "bed", span: { id: "a", dx: 0, dy: 0 } }],
        [0, 0, { tileId: "bed", span: { id: "gone", dx: 1, dy: 0 } }],
      ]),
      tilesById,
    );
    expect(above(map, 1, 2)).toEqual(["bed part"]);
    expect(above(map, 0, 0)).toEqual([]);
  });
});
