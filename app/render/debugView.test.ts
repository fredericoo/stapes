import { describe, expect, it } from "vitest";
import {
  boundsOfColumns,
  builtChunkColumns,
  chunkColumnRectPx,
  clampZoomOut,
  columnTouches,
  debugSpanPx,
  debugViewRequested,
  DEBUG_MAX_ZOOM_OUT,
  DEBUG_ZOOM_OUT,
  heldChunkColumns,
  playSquareOrigin,
  reachInCells,
  rectPx,
} from "./debugView";
import { VIEW_PX } from "./viewport";
import { emptyMap, replaceStack } from "../lib/mapData";
import { CELL_SIZE, CHUNK_SIZE } from "../lib/types";

describe("the switch", () => {
  it("is off unless it is asked for by name", () => {
    expect(debugViewRequested("")).toBe(false);
    expect(debugViewRequested("?foo=1")).toBe(false);
    expect(debugViewRequested("?debug=0")).toBe(false);
    expect(debugViewRequested("?debug=true")).toBe(false);
    expect(debugViewRequested("?debug=1")).toBe(true);
    expect(debugViewRequested("?x=2&debug=1")).toBe(true);
  });
});

describe("the debug camera", () => {
  it("spans whole play squares", () => {
    for (const zoom of [1, 2, 3, DEBUG_MAX_ZOOM_OUT]) {
      expect(debugSpanPx(zoom) % VIEW_PX).toBe(0);
      expect(debugSpanPx(zoom) / VIEW_PX).toBe(zoom);
    }
  });

  it("keeps the play square in the middle of the frame", () => {
    const player = { x: 400, y: 320 };
    for (const zoom of [1, DEBUG_ZOOM_OUT, DEBUG_MAX_ZOOM_OUT]) {
      const half = debugSpanPx(zoom) / 2;
      const camera = { x: player.x - half, y: player.y - half };
      expect(playSquareOrigin(camera, zoom)).toEqual({
        x: player.x - VIEW_PX / 2,
        y: player.y - VIEW_PX / 2,
      });
    }
  });

  it("refuses a zoom that would draw nothing or everything", () => {
    expect(clampZoomOut(0)).toBe(1);
    expect(clampZoomOut(-4)).toBe(1);
    expect(clampZoomOut(999)).toBe(DEBUG_MAX_ZOOM_OUT);
    expect(clampZoomOut(Number.NaN)).toBe(DEBUG_ZOOM_OUT);
  });
});

describe("what gets outlined", () => {
  it("covers a window's last cell, not its last corner", () => {
    expect(rectPx({ x0: 0, y0: 0, x1: 1, y1: 1 })).toEqual({
      x: 0,
      y: 0,
      w: 2 * CELL_SIZE,
      h: 2 * CELL_SIZE,
    });
  });

  it("puts a chunk column where its cells are", () => {
    const side = CHUNK_SIZE * CELL_SIZE;
    expect(chunkColumnRectPx("2,-1")).toEqual({
      x: 2 * side,
      y: -side,
      w: side,
      h: side,
    });
  });

  it("reads built chunk addresses as columns", () => {
    const columns = builtChunkColumns(["0:1,1", "-3:1,1", "4:2,1"]);
    expect(new Set(columns)).toEqual(new Set(["1,1", "2,1"]));
  });
});

describe("culling to the drawn frame", () => {
  const frame = { x0: 0, y0: 0, x1: 31, y1: 31 };

  it("keeps a column the frame overlaps at all", () => {
    expect(columnTouches("0,0", frame)).toBe(true);
    expect(columnTouches("1,1", frame)).toBe(true);
    expect(columnTouches("2,0", frame)).toBe(false);
  });

  it("keeps the column a frame's edge only just enters", () => {
    expect(columnTouches("2,0", { ...frame, x1: 32 })).toBe(true);
    expect(columnTouches("-1,0", { ...frame, x0: -1 })).toBe(true);
  });

  it("drops a column the frame has walked away from", () => {
    expect(columnTouches("-1,-1", frame)).toBe(false);
    expect(columnTouches("9,9", frame)).toBe(false);
  });
});

describe("the subscription, read off the map", () => {
  it("names every column the map holds anything in, on any level", () => {
    let map = emptyMap();
    map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 40, 8, -3, [{ tileId: "grass" }]);
    expect(new Set(heldChunkColumns(map))).toEqual(new Set(["0,0", "2,0"]));
  });

  it("has no bounds before anything has arrived", () => {
    expect(boundsOfColumns([])).toBeNull();
    expect(heldChunkColumns(emptyMap())).toEqual([]);
  });

  it("bounds the columns by their cells", () => {
    expect(boundsOfColumns(["0,0", "1,0"])).toEqual({
      x0: 0,
      y0: 0,
      x1: 2 * CHUNK_SIZE - 1,
      y1: CHUNK_SIZE - 1,
    });
  });
});

describe("reach past the play square", () => {
  it("is zero for a window that is exactly the view", () => {
    const play = { x: 0, y: 0 };
    const cells = VIEW_PX / CELL_SIZE;
    expect(reachInCells({ x0: 0, y0: 0, x1: cells, y1: cells }, play)).toBe(0);
  });

  it("reports the side that reaches furthest", () => {
    const play = { x: 0, y: 0 };
    const cells = VIEW_PX / CELL_SIZE;
    const window = { x0: -2, y0: -9, x1: cells + 5, y1: cells };
    expect(reachInCells(window, play)).toBe(9);
  });

  it("goes negative for a window narrower than the view", () => {
    const play = { x: 0, y: 0 };
    const cells = VIEW_PX / CELL_SIZE;
    expect(reachInCells({ x0: 3, y0: 3, x1: cells - 3, y1: cells - 3 }, play)).toBe(-3);
  });
});
