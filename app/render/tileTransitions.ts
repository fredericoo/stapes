import * as THREE from "three";
import { levelScreenOffset } from "../lib/geometry";
import { hexToRgb01 } from "../lib/palette";
import {
  shownFraction,
  type HeldTransition,
  type TileTransitionNote,
  type Transition,
} from "../lib/tileTransition";
import { CELL_SIZE } from "../lib/types";
import type { ParticleEmitterSpec } from "./particles";

export const MAX_LIVE_TRANSITIONS = 32;

export const LIGHT_FADE_STEP_MS = 150;

export type LiveTransition = {
  note: TileTransitionNote;
  transition: Transition;
  startMs: number;
};

export function transitionAddress(note: {
  x: number;
  y: number;
  z: number;
  stackIndex: number;
}): string {
  return `${note.z}:${note.x},${note.y}#${note.stackIndex}`;
}

export function placementIdentity(placed: { owner?: string; itemId?: string }): string | undefined {
  if (placed.owner) return `owner:${placed.owner}`;
  if (placed.itemId) return `item:${placed.itemId}`;
  return undefined;
}

export type TransitionIntake = {
  clockMs: number;
  live: number;
  transitionOf(note: TileTransitionNote): Transition | undefined;
  inWindow(note: TileTransitionNote): boolean;
};

export function admitTransitions(
  heard: readonly HeldTransition[],
  intake: TransitionIntake,
): LiveTransition[] {
  const admitted: LiveTransition[] = [];
  for (const { note, ageMs } of heard) {
    if (intake.live + admitted.length >= MAX_LIVE_TRANSITIONS) break;
    const transition = intake.transitionOf(note);
    if (!transition) continue;
    if (ageMs >= transition.durationMs) continue;
    if (!intake.inWindow(note)) continue;
    admitted.push({ note, transition, startMs: intake.clockMs - ageMs });
  }
  return admitted;
}

export function resolveTransitionSlot(
  stack: readonly { tileId: string }[],
  note: { tileId: string; stackIndex: number },
): number | undefined {
  if (stack[note.stackIndex]?.tileId === note.tileId) return note.stackIndex;
  let only: number | undefined;
  for (let i = 0; i < stack.length; i++) {
    if (stack[i]?.tileId !== note.tileId) continue;
    if (only !== undefined) return undefined;
    only = i;
  }
  return only;
}

export function struckRemainsSlot(
  note: TileTransitionNote,
  previousStack: readonly { tileId: string }[],
): number | undefined {
  if (!note.struckBy) return undefined;
  return resolveTransitionSlot(previousStack, note);
}

export function liveShown(live: LiveTransition, clockMs: number): number {
  return shownFraction(live.note.side, clockMs - live.startMs, live.transition.durationMs);
}

export type TransitionPose = {
  scale: number;
  dropLevels: number;
};

export function transitionPose(transition: Transition, shown: number): TransitionPose {
  return {
    scale: transition.scale ? shown : 1,
    dropLevels: transition.drop ? transition.drop.levels * (1 - shown) : 0,
  };
}

export type PoseableQuad = {
  centreX: number;
  centreY: number;
  pivotX: number;
  pivotY: number;
  w: number;
  h: number;
};

export function pixelSnappedQuad(
  quad: PoseableQuad,
  pose: TransitionPose,
): { scaleX: number; scaleY: number; x: number; y: number; dropLevels: number } {
  const w = Math.round(quad.w * pose.scale);
  const h = Math.round(quad.h * pose.scale);
  const liftPx = Math.round(levelScreenOffset(pose.dropLevels).x);
  const centreX = quad.pivotX + (quad.centreX - quad.pivotX) * pose.scale + liftPx;
  const centreY = quad.pivotY + (quad.centreY - quad.pivotY) * pose.scale + liftPx;
  const left = Math.round(centreX - w / 2);
  const top = Math.round(centreY - h / 2);
  return {
    scaleX: w / quad.w,
    scaleY: h / quad.h,
    x: left + w / 2,
    y: top + h / 2,
    dropLevels: liftPx === 0 ? 0 : -liftPx / CELL_SIZE,
  };
}

export function rejoinsBatch(mesh: { copy: boolean; moves: boolean }): boolean {
  return !mesh.copy && !mesh.moves;
}

export function isFinished(live: LiveTransition, clockMs: number): boolean {
  return clockMs - live.startMs >= live.transition.durationMs;
}

export type TransitionEmitters = {
  live: LiveTransition;
  plumeId: string | null;
  plume: ParticleEmitterSpec | null;
  burst: ParticleEmitterSpec | null;
};

export function goingPlumeId(plumeId: string, noteId: string): string {
  return `${plumeId}:going:${noteId}`;
}

export function appendTransitionEmitters(
  out: ParticleEmitterSpec[],
  transitions: Iterable<TransitionEmitters>,
  clockMs: number,
) {
  for (const t of transitions) {
    const shown = liveShown(t.live, clockMs);
    if (t.plumeId) {
      const at = out.findIndex((spec) => spec.id === t.plumeId);
      const own = out[at];
      if (own) out[at] = { ...own, taper: shown };
    }
    if (t.plume) {
      out.push({
        ...t.plume,
        id: goingPlumeId(t.plume.id, t.live.note.id),
        taper: shown,
      });
    }
    if (t.burst && !isFinished(t.live, clockMs)) out.push(t.burst);
  }
}

export function fadingLightScale(live: LiveTransition, clockMs: number): number {
  const gridMs = Math.floor(clockMs / LIGHT_FADE_STEP_MS) * LIGHT_FADE_STEP_MS;
  return shownFraction("disappear", gridMs - live.startMs, live.transition.durationMs);
}

const PATTERN_NONE = 0;
const PATTERN_CODE = { noise: 1, sweep: 2, dither: 3 } as const;

export type TransitionUniforms = {
  uFxEnabled: { value: number };
  uFxShown: { value: number };
  uFxPattern: { value: number };
  uFxAnchorPx: { value: THREE.Vector2 };
  uFxOriginPx: { value: THREE.Vector2 };
  uFxSpanPx: { value: number };
  uFxSweepAppear: { value: number };
  uFxClumpPx: { value: number };
  uFxEdgeColor: { value: THREE.Vector3 };
  uFxEdgeWidth: { value: number };
};

export function noTransitionUniforms(): TransitionUniforms {
  return {
    uFxEnabled: { value: 0 },
    uFxShown: { value: 1 },
    uFxPattern: { value: PATTERN_NONE },
    uFxAnchorPx: { value: new THREE.Vector2(0, 0) },
    uFxOriginPx: { value: new THREE.Vector2(0, 0) },
    uFxSpanPx: { value: 1 },
    uFxSweepAppear: { value: 0 },
    uFxClumpPx: { value: 1 },
    uFxEdgeColor: { value: new THREE.Vector3(0, 0, 0) },
    uFxEdgeWidth: { value: 0 },
  };
}

export const NO_TRANSITION_UNIFORMS: TransitionUniforms = noTransitionUniforms();

export type TransitionSprite = {
  centreX: number;
  centreY: number;
  w: number;
  h: number;
};

export function transitionUniforms(
  live: LiveTransition,
  sprite: TransitionSprite,
): TransitionUniforms {
  const u = noTransitionUniforms();
  writeTransitionUniforms(u, live, sprite);
  return u;
}

export function writeTransitionUniforms(
  u: TransitionUniforms,
  live: LiveTransition | null,
  sprite?: TransitionSprite,
) {
  u.uFxEnabled.value = live ? 1 : 0;
  u.uFxShown.value = 1;
  u.uFxPattern.value = PATTERN_NONE;
  u.uFxSweepAppear.value = 0;
  u.uFxEdgeWidth.value = 0;
  if (sprite) u.uFxAnchorPx.value.set(sprite.centreX, sprite.centreY);
  const dissolve = live?.transition.dissolve;
  if (!live || !dissolve) return;

  u.uFxPattern.value = PATTERN_CODE[dissolve.pattern];
  u.uFxClumpPx.value = dissolve.clumpPx;
  u.uFxEdgeWidth.value = dissolve.edgeWidth;
  const [r, g, b] = hexToRgb01(dissolve.edgeColor);
  u.uFxEdgeColor.value.set(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));

  if (dissolve.pattern === "sweep" && dissolve.from && sprite) {
    const originX = sprite.centreX + dissolve.from.x * CELL_SIZE;
    const originY = sprite.centreY + dissolve.from.y * CELL_SIZE;
    u.uFxOriginPx.value.set(originX, originY);
    u.uFxSpanPx.value = farthestCornerPx(originX, originY, sprite);
    u.uFxSweepAppear.value = live.note.side === "appear" ? 1 : 0;
  }
}

function farthestCornerPx(originX: number, originY: number, sprite: TransitionSprite): number {
  const halfW = sprite.w / 2;
  const halfH = sprite.h / 2;
  let farthest = 1;
  for (const dx of [-halfW, halfW]) {
    for (const dy of [-halfH, halfH]) {
      const cornerX = sprite.centreX + dx;
      const cornerY = sprite.centreY + dy;
      farthest = Math.max(farthest, Math.hypot(cornerX - originX, cornerY - originY));
    }
  }
  return farthest;
}

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

export const TRANSITION_GLSL_VERTEX_COMMON = `
uniform vec2 uFxAnchorPx;
varying vec2 vFxPx;
`;

export const TRANSITION_GLSL_VERTEX = `
vFxPx = position.xy + uFxAnchorPx;
`;

const FX_EDGE_NUDGE_PX = 0.001;

export const TRANSITION_GLSL_SNAP = `
vec2 fxPx = vFxPx;
if (uFxEnabled > 0.5) {
  vec2 fxToCentre = floor(vWorldPx) + 0.5 - vWorldPx;
  vec2 fxSteps = vec2(
    fxToCentre.x / dFdx(vWorldPx.x),
    fxToCentre.y / dFdy(vWorldPx.y)
  );
  vec2 fxAtCentre = vFxPx + dFdx(vFxPx) * fxSteps.x + dFdy(vFxPx) * fxSteps.y;
  // Nudged past the exact pixel edge: at scales like 1/2 a world pixel's
  // centre lands exactly between two art pixels, and float error would leave
  // neighbouring fragments disagreeing about which side they are on.
  fxPx = floor(fxAtCentre + ${FX_EDGE_NUDGE_PX}) + 0.5;
  #ifdef USE_MAP
  vec2 fxUvPerArtPx = vec2(
    dFdx(vMapUv).x / dFdx(vFxPx).x,
    dFdy(vMapUv).y / dFdy(vFxPx).y
  );
  diffuseColor =
    vec4(diffuse, opacity) * texture2D(map, vMapUv + (fxPx - vFxPx) * fxUvPerArtPx);
  #endif
}
`;

export const TRANSITION_GLSL_COMMON = `
uniform float uFxEnabled;
uniform float uFxShown;
uniform float uFxPattern;
uniform vec2 uFxOriginPx;
uniform float uFxSpanPx;
uniform float uFxSweepAppear;
uniform float uFxClumpPx;
uniform vec3 uFxEdgeColor;
uniform float uFxEdgeWidth;
varying vec2 vFxPx;

float fxHash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

float fxBayer2(vec2 a) {
  a = floor(a);
  return fract(a.x / 2.0 + a.y * a.y * 0.75);
}

float fxBayer4(vec2 a) {
  return fxBayer2(0.5 * a) * 0.25 + fxBayer2(a);
}

float fxKey(vec2 px) {
  if (uFxPattern < 1.5) {
    return 0.65 * fxHash(floor(px / uFxClumpPx)) + 0.35 * fxHash(px);
  }
  if (uFxPattern < 2.5) {
    float reach = clamp(distance(px + 0.5, uFxOriginPx) / uFxSpanPx, 0.0, 1.0);
    float rough = clamp(reach + (fxHash(px) - 0.5) * 0.12, 0.0, 1.0);
    return uFxSweepAppear > 0.5 ? 1.0 - rough : rough;
  }
  return fxBayer4(px);
}
`;

export const TRANSITION_GLSL_DISCARD = `
float fxEdge = 0.0;
if (uFxEnabled > 0.5 && uFxPattern > 0.5) {
  float fxThreshold = (1.0 - uFxShown) * (1.0 + uFxEdgeWidth) - uFxEdgeWidth;
  float fxK = fxKey(floor(fxPx));
  if (fxK < fxThreshold) discard;
  fxEdge = step(fxK, fxThreshold + uFxEdgeWidth) * step(0.0001, uFxEdgeWidth);
}
`;

export const TRANSITION_GLSL_EDGE = `
if (fxEdge > 0.5) {
  diffuseColor.rgb = uFxEdgeColor;
}
`;
