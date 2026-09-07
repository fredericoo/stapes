import { CELL_SIZE } from "../lib/types";
import { CELL_CENTRE } from "../lib/geometry";
import { useEditorStore, ZOOM_LEVELS, type ZoomLevel } from "./store";

/** Neighbouring {@link ZOOM_LEVELS} differ by this factor. */
const ZOOM_STEP_RATIO = 2;

/**
 * How far two fingers must spread before the zoom steps: the geometric
 * midpoint between two neighbouring zoom levels, so the pinch lands on
 * whichever step its spread is now nearer. A linear threshold would step early
 * in one direction and late in the other.
 */
export const PINCH_ZOOM_RATIO = Math.sqrt(ZOOM_STEP_RATIO);

export type Viewport = { width: number; height: number };

/** Apply a wheel event as a camera pan (same math as the map canvas). */
export function panCameraByWheel(
  e: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "shiftKey">,
  pageSize?: Viewport,
) {
  const store = useEditorStore.getState();
  // Shift+wheel on mice often only reports deltaY — treat it as horizontal.
  let dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
  let dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
  if (e.deltaMode === 1) {
    dx *= 16;
    dy *= 16;
  } else if (e.deltaMode === 2) {
    dx *= pageSize?.width ?? window.innerWidth;
    dy *= pageSize?.height ?? window.innerHeight;
  }
  store.setCamera({
    x: store.camera.x + dx / store.zoom,
    y: store.camera.y + dy / store.zoom,
  });
}

/**
 * World-pixel offset that puts the centre of cell (x, y) on level z in the
 * middle of a viewport of that size.
 *
 * The `-CELL_SIZE * z` is the level's own screen shift (`levelScreenOffset`),
 * which is what `screenToCoord` undoes: centring has to bake it in or a call
 * that also changes level lands one cell off per level travelled.
 */
export function cameraForCenter(
  cell: { x: number; y: number; z: number },
  zoom: number,
  viewport: Viewport,
): { x: number; y: number } {
  return {
    x:
      (cell.x + CELL_CENTRE) * CELL_SIZE -
      CELL_SIZE * cell.z -
      viewport.width / 2 / zoom,
    y:
      (cell.y + CELL_CENTRE) * CELL_SIZE -
      CELL_SIZE * cell.z -
      viewport.height / 2 / zoom,
  };
}

/** The cell under the middle of the viewport — the inverse of {@link cameraForCenter}. */
export function centerCell(
  camera: { x: number; y: number },
  zoom: number,
  viewport: Viewport,
  z: number,
): { x: number; y: number } {
  const worldX = camera.x + viewport.width / 2 / zoom;
  const worldY = camera.y + viewport.height / 2 / zoom;
  return {
    x: Math.floor((worldX + CELL_SIZE * z) / CELL_SIZE),
    y: Math.floor((worldY + CELL_SIZE * z) / CELL_SIZE),
  };
}

/**
 * The camera that leaves whatever is under `screenPoint` under it after a zoom
 * change. Without this a pinch drifts: the content grows out of the middle of
 * the canvas rather than out from between the fingers.
 */
export function cameraAnchoredAtZoom(
  camera: { x: number; y: number },
  screenPoint: { x: number; y: number },
  fromZoom: number,
  toZoom: number,
): { x: number; y: number } {
  return {
    x: camera.x + screenPoint.x / fromZoom - screenPoint.x / toZoom,
    y: camera.y + screenPoint.y / fromZoom - screenPoint.y / toZoom,
  };
}

/** One step along {@link ZOOM_LEVELS}, clamped at either end. */
export function steppedZoom(current: ZoomLevel, steps: number): ZoomLevel {
  const i = ZOOM_LEVELS.indexOf(current);
  const from = i === -1 ? 0 : i;
  const next = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, from + steps));
  return ZOOM_LEVELS[next];
}

/**
 * How many zoom steps a pinch has earned, given how far the fingers have
 * spread since the last step. Returns 0 until the spread crosses
 * {@link PINCH_ZOOM_RATIO}, so a two-finger drag that holds its width pans and
 * nothing else.
 */
export function pinchZoomSteps(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  const steps = Math.log(ratio) / Math.log(ZOOM_STEP_RATIO);
  // Rounded on the absolute value rather than with `Math.round`, which sends
  // -0.5 to -0 and would make closing the fingers need more travel than
  // spreading them.
  const rounded = Math.round(Math.abs(steps));
  if (rounded === 0) return 0;
  return steps < 0 ? -rounded : rounded;
}
