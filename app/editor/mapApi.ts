import * as v from "valibot";
import { clampLevel } from "../lib/types";
import { cameraForCenter, centerCell, type Viewport } from "./camera";
import { snapZoom, useEditorStore, type ZoomLevel } from "./store";

/**
 * `window.map` — driving the editor's view from the console.
 *
 * The map editor has no address bar: where you are looking is camera state in
 * a zustand store, so "show me the well at 118,64" is a drag across a canvas
 * and there is no way to say it. That is fine for a person with a mouse and
 * useless to anything scripting the page — an agent asked to look at a corner
 * of the map, a bug report that wants to name a view, a screenshot taken the
 * same way twice.
 *
 * Shipped in production builds rather than gated behind `import.meta.env.DEV`,
 * because the point is to drive the deployed editor. It reads and writes view
 * state only — the camera, the zoom, which level is being edited — so the worst
 * a caller can do is look somewhere unhelpful. Nothing here touches the map.
 */
export type MapView = {
  /** The cell under the middle of the canvas, on the level being edited. */
  center: { x: number; y: number; z: number };
  zoom: ZoomLevel;
  /** Canvas size in CSS pixels — what a caller needs to know how much is in shot. */
  viewport: Viewport;
};

export type MapApi = {
  /** Centre the view on a cell, optionally switching to that level first. */
  setCenter: (center: { x: number; y: number; z?: number }) => MapView;
  /** Snap to a zoom step ({@link ZOOM_LEVELS}), keeping the centre cell centred. */
  setZoom: (zoom: number) => MapView;
  getView: () => MapView;
};

/**
 * Coordinates arrive from a console or a script, so they are parsed rather
 * than trusted: a `NaN` written into the camera moves the view nowhere and
 * leaves every later pan and screen-to-cell conversion producing `NaN` too,
 * which reads as a dead canvas rather than as a bad argument.
 */
const centerSchema = v.object({
  x: v.pipe(v.number(), v.integer()),
  y: v.pipe(v.number(), v.integer()),
  z: v.optional(v.pipe(v.number(), v.integer())),
});

const zoomSchema = v.pipe(v.number(), v.finite());

export function createMapApi(viewportSize: () => Viewport): MapApi {
  const getView = (): MapView => {
    const { camera, zoom, currentLevel } = useEditorStore.getState();
    const viewport = viewportSize();
    const cell = centerCell(camera, zoom, viewport, currentLevel);
    return {
      center: { x: cell.x, y: cell.y, z: currentLevel },
      zoom,
      viewport,
    };
  };

  const centerOn = (cell: { x: number; y: number; z: number }): MapView => {
    const store = useEditorStore.getState();
    store.setLevel(cell.z);
    store.setCamera(cameraForCenter(cell, store.zoom, viewportSize()));
    return getView();
  };

  return {
    getView,
    setCenter: (center) => {
      const parsed = v.parse(centerSchema, center);
      const z = clampLevel(parsed.z ?? useEditorStore.getState().currentLevel);
      return centerOn({ x: parsed.x, y: parsed.y, z });
    },
    setZoom: (zoom) => {
      const held = getView().center;
      useEditorStore.getState().setZoom(snapZoom(v.parse(zoomSchema, zoom)));
      return centerOn(held);
    },
  };
}

declare global {
  interface Window {
    map?: MapApi;
  }
}
