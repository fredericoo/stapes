import { describe, expect, it } from "vitest";
import {
  boundsOfColumns,
  builtChunkColumns,
  chunkColumnRectPx,
  clampZoomOut,
  columnTouches,
  debugCameraOrigin,
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
  /**
   * The point of the whole view: what is drawn is a whole number of play
   * squares, so the render scale stays whole and the art stays on its grid.
   */
  it("spans whole play squares", () => {
    for (const zoom of [1, 2, 3, DEBUG_MAX_ZOOM_OUT]) {
      expect(debugSpanPx(zoom) % VIEW_PX).toBe(0);
      expect(debugSpanPx(zoom) / VIEW_PX).toBe(zoom);
    }
  });

  it("keeps the play square in the middle of the frame", () => {
    const play = { x: 400, y: 320 };
    const camera = debugCameraOrigin(play, DEBUG_ZOOM_OUT);
    expect(playSquareOrigin(camera, DEBUG_ZOOM_OUT)).toEqual(play);
    // Concentric: the same slack on both sides.
    const span = debugSpanPx(DEBUG_ZOOM_OUT);
    expect(play.x - camera.x).toBe(camera.x + span - (play.x + VIEW_PX));
  });

  it("draws exactly the play square at ×1", () => {
    const play = { x: 96, y: -48 };
    expect(debugCameraOrigin(play, 1)).toEqual(play);
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
    // A window of cells 0..1 is two cells wide, not one.
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

  /** Seventeen levels of one column is one rectangle on screen. */
  it("reads built chunk addresses as columns", () => {
    const columns = builtChunkColumns(["0:1,1", "-3:1,1", "4:2,1"]);
    expect(new Set(columns)).toEqual(new Set(["1,1", "2,1"]));
  });
});

describe("culling to the drawn frame", () => {
  /**
   * In single player the whole map counts as "sent", so without this the view
   * would add a rectangle per chunk of the world and the draw-call number it
   * exists to report would be mostly itself.
   */
  const frame = { x0: 0, y0: 0, x1: 31, y1: 31 };

  it("keeps a column the frame overlaps at all", () => {
    expect(columnTouches("0,0", frame)).toBe(true);
    expect(columnTouches("1,1", frame)).toBe(true);
    // Cells 32..47 — the frame reaches 31, so this one is one cell outside.
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
    // A cell far away and several levels down — still a column we hold.
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
  /**
   * The number the panel exists to show: how much world is paid for that
   * nobody in the game can see.
   */
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
    expect(
      reachInCells({ x0: 3, y0: 3, x1: cells - 3, y1: cells - 3 }, play),
    ).toBe(-3);
  });
});
