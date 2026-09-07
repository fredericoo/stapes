import { beforeEach, describe, expect, it } from "vitest";
import { MAX_LEVEL } from "../lib/types";
import { createMapApi } from "./mapApi";
import { useEditorStore } from "./store";

const VIEWPORT = { width: 640, height: 480 };
const api = createMapApi(() => VIEWPORT);

beforeEach(() => {
  useEditorStore.setState({ camera: { x: -32, y: -32 }, zoom: 4, currentLevel: 0 });
});

describe("setCenter", () => {
  it("reports back the cell it was asked for", () => {
    expect(api.setCenter({ x: 40, y: -12 }).center).toEqual({
      x: 40,
      y: -12,
      z: 0,
    });
    expect(api.getView().center).toEqual({ x: 40, y: -12, z: 0 });
  });

  it("switches level, and stays on the named cell after it has", () => {
    const view = api.setCenter({ x: 5, y: 5, z: -2 });
    expect(view.center).toEqual({ x: 5, y: 5, z: -2 });
    expect(useEditorStore.getState().currentLevel).toBe(-2);
  });

  it("holds the level it is not given", () => {
    api.setCenter({ x: 0, y: 0, z: 3 });
    expect(api.setCenter({ x: 9, y: 9 }).center.z).toBe(3);
  });

  it("clamps a level outside the world rather than editing one that isn't there", () => {
    expect(api.setCenter({ x: 0, y: 0, z: 999 }).center.z).toBe(MAX_LEVEL);
  });

  it("refuses a coordinate that isn't a whole number", () => {
    expect(() => api.setCenter({ x: 1.5, y: 0 })).toThrow();
    expect(() => api.setCenter({ x: Number.NaN, y: 0 })).toThrow();
    expect(useEditorStore.getState().camera).toEqual({ x: -32, y: -32 });
  });
});

describe("setZoom", () => {
  it("snaps to a zoom step and keeps the centre cell centred", () => {
    api.setCenter({ x: 20, y: 30 });
    const view = api.setZoom(7);
    expect(view.zoom).toBe(8);
    expect(view.center).toEqual({ x: 20, y: 30, z: 0 });
  });

  it("reports the canvas it measured against", () => {
    expect(api.getView().viewport).toEqual(VIEWPORT);
  });
});
