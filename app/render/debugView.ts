/**
 * The renderer's windows, drawn.
 *
 * Play is a fixed square (`./viewport`) and almost everything the renderer
 * decides is a window around it: which chunks exist as geometry
 * (`./meshWindow`), how far the light bake reads (`../lib/lightingChunks`),
 * which cells of the map the server has even sent us (`../net/interest`). All
 * of those are derived from the same rect, none of them are the same size as
 * it, and none of them are visible — the play square is exactly the part you
 * cannot see any of this from.
 *
 * **Debug mode pulls the camera back and leaves every window where it was.**
 * That is why {@link WorldView.playSquare} exists:
 * grow the camera and the windows grow with it, and there is nothing to look
 * at. Pinned, the extra world on screen is a picture of what the renderer was
 * already paying for — chunks appearing a chunk-column ahead of the walk, light
 * chunks baking, a subscription boundary you can walk towards.
 *
 * Everything here is level 0. A level is drawn one cell up-left of the one
 * below it, so a chunk column is seventeen rectangles on screen rather than
 * one, and drawing all of them would be a hatch pattern rather than a reading.
 * The columns are the honest unit anyway: a subscription names chunk columns,
 * not chunks (`../net/interest`), and geometry is built per level within one.
 */
import { listChunkKeys } from "../lib/mapData";
import { CELL_SIZE, CHUNK_SIZE, MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import type { MapFile } from "../lib/types";
import type { WorldRect } from "../lib/lightingChunks";
import { VIEW_PX } from "./viewport";

/**
 * How many play squares across the debug camera spans, and the range the
 * player may take it to.
 *
 * The default is three because that is what the *mesh* window costs: six cells
 * of margin either side of a 23-cell view, rounded out to 16-cell chunks, is a
 * square about 67 cells across — a shade under three views. So at three, the
 * green chunk outlines sit inside the frame with a little air around them, and
 * the world beyond them is black because nothing has been built there, which is
 * the point being made.
 *
 * The subscription does not fit at any zoom worth playing at: the interest
 * reach is 79 cells, so the square the server keeps us supplied with is 176
 * cells across, seven and a half views. {@link DEBUG_MAX_ZOOM_OUT} is wide
 * enough to hold it, and unreadable — which is a fair picture of the ratio
 * between what you can see and what is being kept ready for you.
 */
export const DEBUG_ZOOM_OUT = 3;
export const DEBUG_MIN_ZOOM_OUT = 1;
export const DEBUG_MAX_ZOOM_OUT = 8;

/** Side of the debug camera's square, in world pixels. */
export function debugSpanPx(zoomOut: number): number {
  return VIEW_PX * clampZoomOut(zoomOut);
}

export function clampZoomOut(zoomOut: number): number {
  const whole = Math.round(zoomOut);
  if (!Number.isFinite(whole)) return DEBUG_ZOOM_OUT;
  return Math.min(DEBUG_MAX_ZOOM_OUT, Math.max(DEBUG_MIN_ZOOM_OUT, whole));
}

/**
 * Where the pulled-back camera starts, given where the play square does.
 *
 * Concentric, so the player stays in the middle of the frame and the play
 * square stays in the middle of the extra world rather than drifting to a
 * corner of it as the zoom changes.
 */
export function debugCameraOrigin(
  playCamera: { x: number; y: number },
  zoomOut: number,
): { x: number; y: number } {
  const inset = (debugSpanPx(zoomOut) - VIEW_PX) / 2;
  return { x: playCamera.x - inset, y: playCamera.y - inset };
}

/** The inverse: the play square inside a frame the camera has been pulled off. */
export function playSquareOrigin(
  drawnCamera: { x: number; y: number },
  zoomOut: number,
): { x: number; y: number } {
  const inset = (debugSpanPx(zoomOut) - VIEW_PX) / 2;
  return { x: drawnCamera.x + inset, y: drawnCamera.y + inset };
}

/** A rectangle to outline, in world pixels. */
export type PxRect = { x: number; y: number; w: number; h: number };

/** A window of cells as the rectangle that bounds it, at level 0. */
export function rectPx(rect: WorldRect): PxRect {
  return {
    x: rect.x0 * CELL_SIZE,
    y: rect.y0 * CELL_SIZE,
    // Inclusive on both ends — a window that reaches cell 7 covers all of it.
    w: (rect.x1 - rect.x0 + 1) * CELL_SIZE,
    h: (rect.y1 - rect.y0 + 1) * CELL_SIZE,
  };
}

/** One chunk column — `"cx,cy"` — as the square it occupies at level 0. */
export function chunkColumnRectPx(key: string): PxRect {
  const comma = key.indexOf(",");
  const cx = Number(key.slice(0, comma));
  const cy = Number(key.slice(comma + 1));
  const side = CHUNK_SIZE * CELL_SIZE;
  return { x: cx * side, y: cy * side, w: side, h: side };
}

/**
 * The chunk columns a map holds anything in, on any level.
 *
 * This is the client's subscription read off the only record of it the client
 * has: the server never says what it has sent, it just sends it, so what we
 * hold *is* what we are subscribed to. In single player it is the whole map,
 * which is the honest answer there — nothing is being withheld.
 */
export function heldChunkColumns(map: MapFile): string[] {
  const columns = new Set<string>();
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const key of listChunkKeys(map, z)) columns.add(key);
  }
  return [...columns];
}

/**
 * The chunk columns under a set of built chunk addresses (`"z:cx,cy"`).
 *
 * Deduplicated across levels, because that is what gets drawn — see the note at
 * the top of this file about why a column and not a chunk.
 */
export function builtChunkColumns(addresses: Iterable<string>): string[] {
  const columns = new Set<string>();
  for (const address of addresses) columns.add(address.slice(address.indexOf(":") + 1));
  return [...columns];
}

/**
 * How far past the play square a window reaches, in whole cells, on the side it
 * reaches furthest.
 *
 * One number rather than four edges: the windows are symmetric about the player
 * by construction, and what a reader wants off the panel is "how much more than
 * I can see", not which corner won.
 */
export function reachInCells(
  window: WorldRect,
  playSquare: { x: number; y: number },
): number {
  const x0 = Math.floor(playSquare.x / CELL_SIZE);
  const y0 = Math.floor(playSquare.y / CELL_SIZE);
  const x1 = Math.floor((playSquare.x + VIEW_PX) / CELL_SIZE);
  const y1 = Math.floor((playSquare.y + VIEW_PX) / CELL_SIZE);
  return Math.max(
    x0 - window.x0,
    y0 - window.y0,
    window.x1 - x1,
    window.y1 - y1,
  );
}

/**
 * The chunk columns a map holds, as the rect that bounds them.
 *
 * Null for an empty map — a client that has been sent nothing yet, which
 * happens for a frame or two after a join.
 */
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

/**
 * The switch. `?debug=1` and nothing else — see `docs/notes.md`.
 *
 * A query parameter rather than a build flag because the thing worth looking at
 * is the *deployed* world: chunks arriving over a real socket, at the real
 * reach, on the real map. `import.meta.env.DEV` would gate it to the one
 * environment where the subscription is least interesting.
 *
 * Takes the search string rather than reading `location` itself, so it is a
 * function rather than a fact about the page.
 */
export const DEBUG_PARAM = "debug";

export function debugViewRequested(search: string): boolean {
  return new URLSearchParams(search).get(DEBUG_PARAM) === "1";
}

/**
 * Does this chunk column have any cell inside `frame`?
 *
 * The debug view culls its own outlines to what the camera draws. Not an
 * optimisation for its own sake: in single player the map is entirely "sent",
 * so without this the view would add a rectangle per chunk of the whole world
 * and the draw-call number it exists to report would be mostly itself.
 */
export function columnTouches(key: string, frame: WorldRect): boolean {
  const rect = chunkColumnRectPx(key);
  const x0 = rect.x / CELL_SIZE;
  const y0 = rect.y / CELL_SIZE;
  return (
    x0 <= frame.x1 &&
    x0 + CHUNK_SIZE > frame.x0 &&
    y0 <= frame.y1 &&
    y0 + CHUNK_SIZE > frame.y0
  );
}
