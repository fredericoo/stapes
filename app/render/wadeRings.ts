import * as THREE from "three";
import { CELL_SIZE } from "../lib/types";
import { PX_PER_HEIGHT, type DepthBox } from "../lib/geometry";

/** The base shade of `deep-water`, so the ring reads as the water darkening round the legs. */
export const WADE_RING_COLOR = "#323353";
/** `water`'s crest shade, so the ripple reads as the same water moving. */
export const WADE_RIPPLE_COLOR = "#5b8fbf";

/** More wading bodies than this in view and the furthest from the camera go without a ring. */
export const MAX_WADE_RINGS = 16;
export const WADE_RING_FRAMES = 8;
export const WADE_RING_FRAME_MS = 150;
const MIN_RADIUS_PX = 2;
/** From the first of these frames the ripple keeps every other pixel, and from the second one in three. */
const RIPPLE_FADE_FRAMES = [4, 6] as const;
/** How far a ring's foot may sit from a water surface's top and still be drawn on it. */
const SAME_SURFACE_ELEV = 0.75;

/** A quarter of the sprite's width, so a rat gets a ring it fills and a cyclops one it stands in. */
export function wadeRingRadiusPx(spriteWidthPx: number): number {
  return Math.max(MIN_RADIUS_PX, Math.round(spriteWidthPx / 4));
}

/** How far past the wade cut the ring is lifted, up-left: 1px for a sprite a body wide, more for a bigger one. */
export function wadeRingLiftPx(spriteWidthPx: number): number {
  return Math.max(1, Math.round(spriteWidthPx / 16));
}

/** Where a body's feet are drawn, in world pixels, before it is sunk; the world shader's wade cut measures from the same point. */
export function feetPx(box: DepthBox): { x: number; y: number } {
  const lift = box.foot * PX_PER_HEIGHT;
  return { x: box.eastPx - CELL_SIZE / 2 - lift, y: box.southPx - CELL_SIZE / 2 - lift };
}

/** Taken from the body's id rather than its cell, so the loop carries on as it walks. */
export function wadeRingPhaseMs(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(hash) % (WADE_RING_FRAME_MS * WADE_RING_FRAMES);
}

export function wadeRingFrameAt(clockMs: number, phaseMs: number): number {
  return Math.floor((clockMs + phaseMs) / WADE_RING_FRAME_MS) % WADE_RING_FRAMES;
}

export type WadeRing = { x: number; y: number; radiusPx: number; foot: number; phaseMs: number };

export type WadeRingUniforms = {
  uWadeRings: { value: THREE.Vector4[] };
  uWadeRingPhases: { value: number[] };
  uWadeRingCount: { value: number };
  uWadeClockMs: { value: number };
  uWadeRingColor: { value: THREE.Color };
  uWadeRippleColor: { value: THREE.Color };
};

export function createWadeRingUniforms(): WadeRingUniforms {
  return {
    uWadeRings: { value: Array.from({ length: MAX_WADE_RINGS }, () => new THREE.Vector4()) },
    uWadeRingPhases: { value: new Array<number>(MAX_WADE_RINGS).fill(0) },
    uWadeRingCount: { value: 0 },
    uWadeClockMs: { value: 0 },
    uWadeRingColor: { value: new THREE.Color(WADE_RING_COLOR) },
    uWadeRippleColor: { value: new THREE.Color(WADE_RIPPLE_COLOR) },
  };
}

/** Writes the rings nearest `(cx, cy)` into the uniforms, and says whether anything changed. */
export function writeWadeRings(
  uniforms: WadeRingUniforms,
  rings: readonly WadeRing[],
  cx: number,
  cy: number,
): boolean {
  const kept =
    rings.length <= MAX_WADE_RINGS
      ? rings
      : [...rings]
          .sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy))
          .slice(0, MAX_WADE_RINGS);
  let changed = uniforms.uWadeRingCount.value !== kept.length;
  kept.forEach((ring, i) => {
    const v = uniforms.uWadeRings.value[i]!;
    if (v.x !== ring.x || v.y !== ring.y || v.z !== ring.radiusPx || v.w !== ring.foot) {
      v.set(ring.x, ring.y, ring.radiusPx, ring.foot);
      changed = true;
    }
    if (uniforms.uWadeRingPhases.value[i] !== ring.phaseMs) {
      uniforms.uWadeRingPhases.value[i] = ring.phaseMs;
      changed = true;
    }
  });
  uniforms.uWadeRingCount.value = kept.length;
  return changed;
}

/** Whether any ring in the uniforms shows a different frame at `clockMs` than at `prevMs`. */
export function wadeRingsTurned(uniforms: WadeRingUniforms, prevMs: number, clockMs: number) {
  for (let i = 0; i < uniforms.uWadeRingCount.value; i++) {
    const phase = uniforms.uWadeRingPhases.value[i]!;
    if (wadeRingFrameAt(prevMs, phase) !== wadeRingFrameAt(clockMs, phase)) return true;
  }
  return false;
}

export const WADE_RING_GLSL_COMMON = `
#ifdef COLOR_CYCLE
uniform vec4 uWadeRings[${MAX_WADE_RINGS}];
uniform float uWadeRingPhases[${MAX_WADE_RINGS}];
uniform int uWadeRingCount;
uniform float uWadeClockMs;
uniform vec3 uWadeRingColor;
uniform vec3 uWadeRippleColor;
#endif
`;

/**
 * Runs on a colour-cycled sheet's key-coloured pixels only, so a ring shows on
 * open water and never on a bank, a rim or anything standing in the water.
 * Each ring is a dark ellipse that squashes one way and then the other, with a
 * one-pixel ripple leaving its edge and breaking up as it travels out. Pixels
 * are tested at their centres against a centre that falls between pixels, so
 * both shapes are symmetric.
 */
export const WADE_RING_GLSL_FRAGMENT = `
for (int i = 0; i < ${MAX_WADE_RINGS}; i++) {
  if (i >= uWadeRingCount) break;
  vec4 ring = uWadeRings[i];
  if (abs(ring.w - vBox.w) > ${SAME_SURFACE_ELEV.toFixed(2)}) continue;
  vec2 p = cyclePx - ring.xy;
  float radius = ring.z;
  float spread = max(2.0, floor(radius * 0.75 + 0.5));
  if (max(abs(p.x), abs(p.y)) > radius + spread + 2.0) continue;
  float step = mod(
    floor((uWadeClockMs + uWadeRingPhases[i]) / ${WADE_RING_FRAME_MS.toFixed(1)}),
    ${WADE_RING_FRAMES.toFixed(1)}
  );
  float squashStep = floor(step / 2.0);
  float squash =
    (squashStep == 1.0 ? 1.0 : squashStep == 3.0 ? -1.0 : 0.0) * (radius >= 4.0 ? 1.0 : 0.5);
  vec2 e = p / vec2(radius + squash, radius - squash);
  if (dot(e, e) <= 1.0) {
    cycleColor = uWadeRingColor;
    break;
  }
  float rippleRadius = radius + 1.5 + step / ${WADE_RING_FRAMES.toFixed(1)} * spread;
  if (abs(length(p) - rippleRadius) >= 0.5) continue;
  float keepEvery =
    step >= ${RIPPLE_FADE_FRAMES[1].toFixed(1)} ? 3.0 : step >= ${RIPPLE_FADE_FRAMES[0].toFixed(1)} ? 2.0 : 1.0;
  if (mod(floor(p.x) + floor(p.y) + step, keepEvery) == 0.0) cycleColor = uWadeRippleColor;
}
`;
