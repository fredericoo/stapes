import * as v from "valibot";
import { clampLevel } from "../lib/types";
import { cameraForCenter, centerCell, type Viewport } from "./camera";
import { snapZoom, useEditorStore, type ZoomLevel } from "./store";

export type MapView = {
  center: { x: number; y: number; z: number };
  zoom: ZoomLevel;
  viewport: Viewport;
};

export type MapApi = {
  setCenter: (center: { x: number; y: number; z?: number }) => MapView;
  setZoom: (zoom: number) => MapView;
  getView: () => MapView;
};

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
