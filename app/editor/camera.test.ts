import { describe, expect, it } from "vitest";
import { screenToCoord } from "../lib/geometry";
import {
  cameraAnchoredAtZoom,
  cameraForCenter,
  centerCell,
  pinchZoomSteps,
  steppedZoom,
} from "./camera";

const VIEWPORT = { width: 800, height: 600 };

describe("cameraForCenter", () => {
  it("puts the asked-for cell under the middle of the canvas", () => {
    for (const z of [-2, 0, 3]) {
      const camera = cameraForCenter({ x: 12, y: -5, z }, 4, VIEWPORT);
      const under = screenToCoord(
        VIEWPORT.width / 2,
        VIEWPORT.height / 2,
        4,
        camera.x,
        camera.y,
        z,
      );
      expect(under).toEqual({ x: 12, y: -5 });
    }
  });

  it("round-trips through centerCell at every zoom", () => {
    for (const zoom of [1, 2, 4, 8]) {
      const camera = cameraForCenter({ x: -3, y: 41, z: 1 }, zoom, VIEWPORT);
      expect(centerCell(camera, zoom, VIEWPORT, 1)).toEqual({ x: -3, y: 41 });
    }
  });
});

describe("cameraAnchoredAtZoom", () => {
  it("leaves the world under the anchor where it was", () => {
    const camera = { x: -32, y: -32 };
    const anchor = { x: 610, y: 90 };
    const before = screenToCoord(anchor.x, anchor.y, 2, camera.x, camera.y, 0);
    const zoomed = cameraAnchoredAtZoom(camera, anchor, 2, 8);
    const after = screenToCoord(anchor.x, anchor.y, 8, zoomed.x, zoomed.y, 0);
    expect(after).toEqual(before);
  });

  it("is its own inverse", () => {
    const camera = { x: 17.5, y: -4 };
    const anchor = { x: 120, y: 300 };
    const there = cameraAnchoredAtZoom(camera, anchor, 4, 1);
    const back = cameraAnchoredAtZoom(there, anchor, 1, 4);
    expect(back.x).toBeCloseTo(camera.x);
    expect(back.y).toBeCloseTo(camera.y);
  });
});

describe("steppedZoom", () => {
  it("moves one discrete step at a time", () => {
    expect(steppedZoom(2, 1)).toBe(4);
    expect(steppedZoom(2, -1)).toBe(1);
    expect(steppedZoom(2, 2)).toBe(8);
  });

  it("clamps at both ends rather than wrapping", () => {
    expect(steppedZoom(8, 1)).toBe(8);
    expect(steppedZoom(1, -1)).toBe(1);
  });
});

describe("pinchZoomSteps", () => {
  it("holds still until the spread passes the midpoint between steps", () => {
    expect(pinchZoomSteps(1)).toBe(0);
    expect(pinchZoomSteps(1.3)).toBe(0);
    expect(pinchZoomSteps(1 / 1.3)).toBe(0);
  });

  it("steps out as the fingers spread and in as they close", () => {
    expect(pinchZoomSteps(1.5)).toBe(1);
    expect(pinchZoomSteps(1 / 1.5)).toBe(-1);
    expect(pinchZoomSteps(3)).toBe(2);
    expect(pinchZoomSteps(1 / 3)).toBe(-2);
  });

  it("ignores a degenerate spread rather than producing Infinity", () => {
    expect(pinchZoomSteps(0)).toBe(0);
    expect(pinchZoomSteps(Number.NaN)).toBe(0);
  });
});
