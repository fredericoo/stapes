import { describe, expect, it } from "vitest";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { MapFile, PlacedTile } from "../lib/types";
import { applyCellEdit, cellEdit } from "./cellEdits";

const AT = { x: 1, y: 2, z: 0 };

const grass: PlacedTile = { tileId: "grass" };
const chest: PlacedTile = { tileId: "chest" };
const apple: PlacedTile = { tileId: "apple", itemId: "itm_apple" };
const sword: PlacedTile = { tileId: "sword", itemId: "itm_sword" };
const body: PlacedTile = { tileId: "player", owner: "me" };

function cell(stack: PlacedTile[]): MapFile {
  return replaceStack(emptyMap(), AT.x, AT.y, AT.z, stack);
}

function tilesAt(map: MapFile): string[] {
  return getStack(map, AT.x, AT.y, AT.z).map((placed) => placed.itemId ?? placed.tileId);
}

describe("cellEdit", () => {
  it("lays a pick up over a stack a body has since walked onto", () => {
    const edit = cellEdit(cell([grass, apple, sword]), cell([grass, sword]), AT)!;

    expect(tilesAt(applyCellEdit(cell([grass, apple, sword, body]), edit))).toEqual([
      "grass",
      "itm_sword",
      "player",
    ]);
  });

  it("does nothing more to a stack the server has already changed the same way", () => {
    const edit = cellEdit(cell([grass, apple]), cell([grass]), AT)!;

    expect(tilesAt(applyCellEdit(cell([grass]), edit))).toEqual(["grass"]);
  });

  it("puts a dropped thing on top, once, however often it is laid", () => {
    const edit = cellEdit(cell([grass, body]), cell([grass, body, sword]), AT)!;

    const once = applyCellEdit(cell([grass, body]), edit);
    expect(tilesAt(applyCellEdit(once, edit))).toEqual(["grass", "player", "itm_sword"]);
  });

  it("knows a chest by its tile when an item beneath it is taken", () => {
    const filled = { ...chest, contents: [{ id: "itm_coin", tileId: "coin" }] };
    const edit = cellEdit(cell([grass, apple, chest]), cell([grass, filled]), AT)!;

    const laid = applyCellEdit(cell([grass, apple, chest, body]), edit);
    expect(getStack(laid, AT.x, AT.y, AT.z)).toEqual([grass, filled, body]);
  });

  it("finds nothing to lay when the act changed nothing in the cell", () => {
    expect(cellEdit(cell([grass, apple]), cell([grass, apple]), AT)).toBeNull();
  });
});
