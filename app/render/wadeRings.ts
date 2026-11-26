import * as THREE from "three";
import { CELL_SIZE } from "../lib/types";
import { PX_PER_HEIGHT, type DepthBox } from "../lib/geometry";

/** The base shade of `deep-water`, so the ring reads as the water darkening round the legs. */
export const WADE_RING_COLOR = "#323353";

export const WADE_RING_FRAMES = 4;
export const WADE_RING_FRAME_MS = 220;
const MIN_RADIUS_PX = 2;

/** A quarter of the sprite's width, so a rat gets a ring it fills and a cyclops one it stands in. */
export function wadeRingRadiusPx(spriteWidthPx: number): number {
  return Math.max(MIN_RADIUS_PX, Math.round(spriteWidthPx / 4));
}

/** Each frame squashes the circle one way or the other; a small ring wobbles by half as much. */
function squashPx(radiusPx: number, frame: number): number {
  const amount = radiusPx >= 4 ? 1 : 0.5;
  return [0, amount, 0, -amount][frame % WADE_RING_FRAMES]!;
}

export function wadeRingSidePx(radiusPx: number): number {
  return 2 * (radiusPx + 1);
}

/**
 * Whether the art pixel at (x, y) of a frame is inside the ring. Pixels are
 * tested at their centres against an ellipse centred on the frame's middle,
 * which falls between pixels, so the ring is even and symmetric.
 */
export function wadeRingCovers(radiusPx: number, frame: number, x: number, y: number): boolean {
  const half = wadeRingSidePx(radiusPx) / 2;
  const squash = squashPx(radiusPx, frame);
  const rx = radiusPx + squash;
  const ry = radiusPx - squash;
  const dx = (x + 0.5 - half) / rx;
  const dy = (y + 0.5 - half) / ry;
  return dx * dx + dy * dy <= 1;
}

/** The frame a ring shows at `clockMs`, offset per body so a crowd does not wobble in step. */
export function wadeRingFrameAt(clockMs: number, phaseMs: number): number {
  return Math.floor((clockMs + phaseMs) / WADE_RING_FRAME_MS) % WADE_RING_FRAMES;
}

export function wadeRingPhaseMs(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(hash) % (WADE_RING_FRAME_MS * WADE_RING_FRAMES);
}

/** Where a body's feet are drawn, in world pixels, before it is sunk; the world shader's wade cut measures from the same point. */
export function feetPx(box: DepthBox): { x: number; y: number } {
  const lift = box.foot * PX_PER_HEIGHT;
  return { x: box.eastPx - CELL_SIZE / 2 - lift, y: box.southPx - CELL_SIZE / 2 - lift };
}

/** The frame's u range in a sheet of `WADE_RING_FRAMES` frames side by side. */
export function wadeRingUs(frame: number): { u0: number; u1: number } {
  return { u0: frame / WADE_RING_FRAMES, u1: (frame + 1) / WADE_RING_FRAMES };
}

/** One sheet per radius, built on first use and kept for the renderer's life. */
export class WadeRingSheets {
  private readonly sheets = new Map<number, THREE.Texture>();

  sheet(radiusPx: number): THREE.Texture {
    const cached = this.sheets.get(radiusPx);
    if (cached) return cached;
    const side = wadeRingSidePx(radiusPx);
    const canvas = document.createElement("canvas");
    canvas.width = side * WADE_RING_FRAMES;
    canvas.height = side;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    ctx.fillStyle = WADE_RING_COLOR;
    for (let frame = 0; frame < WADE_RING_FRAMES; frame++) {
      for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) {
          if (wadeRingCovers(radiusPx, frame, x, y)) ctx.fillRect(frame * side + x, y, 1, 1);
        }
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = true;
    texture.needsUpdate = true;
    this.sheets.set(radiusPx, texture);
    return texture;
  }

  dispose() {
    for (const texture of this.sheets.values()) texture.dispose();
    this.sheets.clear();
  }
}
