import { listChunkKeys } from "../lib/mapData";
import { CELL_SIZE, CHUNK_SIZE, MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import type { MapFile } from "../lib/types";
import type { WorldRect } from "../lib/lightingChunks";
import { VIEW_PX } from "./viewport";

export const DEBUG_ZOOM_OUT = 3;
export const DEBUG_MIN_ZOOM_OUT = 1;
export const DEBUG_MAX_ZOOM_OUT = 8;

export function debugSpanPx(zoomOut: number): number {
  return VIEW_PX * clampZoomOut(zoomOut);
}

export function clampZoomOut(zoomOut: number): number {
  const whole = Math.round(zoomOut);
  if (!Number.isFinite(whole)) return DEBUG_ZOOM_OUT;
  return Math.min(DEBUG_MAX_ZOOM_OUT, Math.max(DEBUG_MIN_ZOOM_OUT, whole));
}

export function playSquareOrigin(
  drawnCamera: { x: number; y: number },
  zoomOut: number,
): { x: number; y: number } {
  const inset = (debugSpanPx(zoomOut) - VIEW_PX) / 2;
  return { x: drawnCamera.x + inset, y: drawnCamera.y + inset };
}

export type PxRect = { x: number; y: number; w: number; h: number };

export function rectPx(rect: WorldRect): PxRect {
  return {
    x: rect.x0 * CELL_SIZE,
    y: rect.y0 * CELL_SIZE,
    w: (rect.x1 - rect.x0 + 1) * CELL_SIZE,
    h: (rect.y1 - rect.y0 + 1) * CELL_SIZE,
  };
}

export function chunkColumnRectPx(key: string): PxRect {
  const comma = key.indexOf(",");
  const cx = Number(key.slice(0, comma));
  const cy = Number(key.slice(comma + 1));
  const side = CHUNK_SIZE * CELL_SIZE;
  return { x: cx * side, y: cy * side, w: side, h: side };
}

export function heldChunkColumns(map: MapFile): string[] {
  const columns = new Set<string>();
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const key of listChunkKeys(map, z)) columns.add(key);
  }
  return [...columns];
}

export function builtChunkColumns(addresses: Iterable<string>): string[] {
  const columns = new Set<string>();
  for (const address of addresses) columns.add(address.slice(address.indexOf(":") + 1));
  return [...columns];
}

export function reachInCells(window: WorldRect, playSquare: { x: number; y: number }): number {
  const x0 = Math.floor(playSquare.x / CELL_SIZE);
  const y0 = Math.floor(playSquare.y / CELL_SIZE);
  const x1 = Math.floor((playSquare.x + VIEW_PX) / CELL_SIZE);
  const y1 = Math.floor((playSquare.y + VIEW_PX) / CELL_SIZE);
  return Math.max(x0 - window.x0, y0 - window.y0, window.x1 - x1, window.y1 - y1);
}

export function boundsOfColumns(columns: readonly string[]): WorldRect | null {
  if (columns.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const key of columns) {
    const comma = key.indexOf(",");
    const cx = Number(key.slice(0, comma));
    const cy = Number(key.slice(comma + 1));
    x0 = Math.min(x0, cx * CHUNK_SIZE);
    y0 = Math.min(y0, cy * CHUNK_SIZE);
    x1 = Math.max(x1, (cx + 1) * CHUNK_SIZE - 1);
    y1 = Math.max(y1, (cy + 1) * CHUNK_SIZE - 1);
  }
  return { x0, y0, x1, y1 };
}

export const DEBUG_PARAM = "debug";

export function debugViewRequested(search: string): boolean {
  return new URLSearchParams(search).get(DEBUG_PARAM) === "1";
}

export function columnTouches(key: string, frame: WorldRect): boolean {
  const rect = chunkColumnRectPx(key);
  const x0 = rect.x / CELL_SIZE;
  const y0 = rect.y / CELL_SIZE;
  return (
    x0 <= frame.x1 && x0 + CHUNK_SIZE > frame.x0 && y0 <= frame.y1 && y0 + CHUNK_SIZE > frame.y0
  );
}
