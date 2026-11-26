import * as THREE from "three";
import { CELL_SIZE } from "../lib/types";
import { PX_PER_HEIGHT, type DepthBox } from "../lib/geometry";

/** The base shade of `deep-water`, so the ring reads as the water darkening round the legs. */
export const WADE_RING_COLOR = "#323353";
/** `water`'s crest shade, so the ripple reads as the same water moving. */
export const WADE_RIPPLE_COLOR = "#5b8fbf";

export const WADE_RING_FRAMES = 8;
export const WADE_RING_FRAME_MS = 150;
const MIN_RADIUS_PX = 2;
/** From this frame the ripple keeps alternate pixels, and from the next fade frame one in three, as it fades out. */
const RIPPLE_FADE_FRAMES = [4, 6] as const;

/** A quarter of the sprite's width, so a rat gets a ring it fills and a cyclops one it stands in. */
export function wadeRingRadiusPx(spriteWidthPx: number): number {
  return Math.max(MIN_RADIUS_PX, Math.round(spriteWidthPx / 4));
}

/** The circle squashes one way and then the other once a ripple; a small one by half as much. */
function squashPx(radiusPx: number, frame: number): number {
  const amount = radiusPx >= 4 ? 1 : 0.5;
  return [0, amount, 0, -amount][Math.floor(frame / 2) % 4]!;
}

/** How far the ripple travels out past the circle's edge over a cycle. */
function rippleSpreadPx(radiusPx: number): number {
  return Math.max(2, Math.round(radiusPx * 0.75));
}

/** How far past the wade cut the ring is lifted, up-left: 1px for a sprite a body wide, more for a bigger one. */
export function wadeRingLiftPx(spriteWidthPx: number): number {
  return Math.max(1, Math.round(spriteWidthPx / 16));
}

export function wadeRingSidePx(radiusPx: number): number {
  return 2 * (radiusPx + rippleSpreadPx(radiusPx) + 2);
}

export type WadeRingPixel = "dark" | "ripple" | null;

/**
 * What the art pixel at (x, y) of a frame shows: the dark circle, the ripple
 * or nothing. Pixels are tested at their centres against shapes centred on
 * the frame's middle, which falls between pixels, so both are symmetric. The
 * ripple is a one-pixel ring that starts just outside the circle and grows
 * outward through the frames.
 */
export function wadeRingPixel(
  radiusPx: number,
  frame: number,
  x: number,
  y: number,
): WadeRingPixel {
  const half = wadeRingSidePx(radiusPx) / 2;
  const px = x + 0.5 - half;
  const py = y + 0.5 - half;
  const squash = squashPx(radiusPx, frame);
  const rx = radiusPx + squash;
  const ry = radiusPx - squash;
  if ((px / rx) ** 2 + (py / ry) ** 2 <= 1) return "dark";
  const step = frame % WADE_RING_FRAMES;
  const rippleRadius = radiusPx + 1.5 + (step / WADE_RING_FRAMES) * rippleSpreadPx(radiusPx);
  if (Math.abs(Math.hypot(px, py) - rippleRadius) >= 0.5) return null;
  const keepEvery = step >= RIPPLE_FADE_FRAMES[1] ? 3 : step >= RIPPLE_FADE_FRAMES[0] ? 2 : 1;
  if ((x + y + step) % keepEvery !== 0) return null;
  return "ripple";
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
    for (let frame = 0; frame < WADE_RING_FRAMES; frame++) {
      for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) {
          const pixel = wadeRingPixel(radiusPx, frame, x, y);
          if (!pixel) continue;
          ctx.fillStyle = pixel === "dark" ? WADE_RING_COLOR : WADE_RIPPLE_COLOR;
          ctx.fillRect(frame * side + x, y, 1, 1);
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
