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

/**
 * Playing a tile's transition: which ones to play, how far along each is, and
 * what the world shader is told.
 *
 * The renderer owns all of it, clock included. The server says only *that* a
 * flame formed; how far through forming it is on this screen is this module's
 * business, which is why nothing on the other side ages a transition.
 *
 * **Only a transitioning tile pays.** A placement that is forming or dissolving
 * is drawn as a mesh of its own for the length of the effect, with its own
 * material holding the uniforms below — the same bargain a status tint makes
 * (see `./spriteTint`). The merged batches carry nothing extra, and every other
 * material reads {@link NO_TRANSITION_UNIFORMS}, whose branch is skipped.
 */

/**
 * The most transitions playing at once.
 *
 * Decay fires in bursts, so a disappear authored on something that decays in
 * bulk must not start a hundred meshes on one tick. Past the cap a tile simply
 * changes, which is what every tile did before this existed.
 */
export const MAX_LIVE_TRANSITIONS = 32;

/**
 * The grid a dissolving tile's light steps down on.
 *
 * Shared by every fading light rather than measured from each one's start, so
 * any number fading at once change on the same frames. The overlay cache keys
 * on each light's intensity, so every distinct step is one rebake of the light
 * window — per grid step, then, and not per light per step.
 */
export const LIGHT_FADE_STEP_MS = 150;

/** A transition this renderer has taken on, stamped against its own clock. */
export type LiveTransition = {
  note: TileTransitionNote;
  transition: Transition;
  startMs: number;
};

/** The placement a note is about, as the renderer keys it. */
export function transitionAddress(note: {
  x: number;
  y: number;
  z: number;
  stackIndex: number;
}): string {
  return `${note.z}:${note.x},${note.y}#${note.stackIndex}`;
}

/**
 * What a placement is wherever it stands, when it carries a name: the actor
 * driving it, or its item id.
 *
 * An appear on a named placement follows the name rather than the cell it
 * formed in, so a body that takes a step while it forms goes on forming in
 * the next cell. An anonymous tile is found by its cell, and a step drops its
 * appear — which costs nothing today, since everything that walks has an owner.
 */
export function placementIdentity(placed: {
  owner?: string;
  itemId?: string;
}): string | undefined {
  if (placed.owner) return `owner:${placed.owner}`;
  if (placed.itemId) return `item:${placed.itemId}`;
  return undefined;
}

export type TransitionIntake = {
  clockMs: number;
  /** How many are already playing. */
  live: number;
  /** This client's own catalogue, which is the one it draws with. */
  transitionOf(note: TileTransitionNote): Transition | undefined;
  /** Whether the note's cell is inside what is being drawn at all. */
  inWindow(note: TileTransitionNote): boolean;
};

/**
 * The notes worth playing, in the order they were heard.
 *
 * Four reasons to drop one, each of which leaves the tile changing the instant
 * the map does: this client's catalogue has no such side, it has already had
 * its whole duration, its cell is off screen (notes are broadcast world-wide),
 * or {@link MAX_LIVE_TRANSITIONS} are already playing.
 */
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

/**
 * The slot in `stack` a note really means, or undefined when it cannot say.
 *
 * **A note's slot is a hint.** It is exact at the moment the change happened,
 * and the rest of that tick can still move things — gravity settling a conjured
 * flame, a creature eating the berry under an ember. So the slot is trusted only
 * while the tile it names is still there; failing that, the cell's only copy of
 * that tile is taken; failing that, there is no telling which copy was meant and
 * the tile simply changes, as every tile did before this existed.
 */
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

/** How much of the tile is showing now. @see shownFraction */
export function liveShown(live: LiveTransition, clockMs: number): number {
  return shownFraction(
    live.note.side,
    clockMs - live.startMs,
    live.transition.durationMs,
  );
}

/** Where a transitioning sprite stands, `shown` of the way to whole. */
export type TransitionPose = {
  /** 1 is its authored size; it shrinks towards the middle of its base cell. */
  scale: number;
  /** How many storeys above its own cell it is drawn and sorted. */
  dropLevels: number;
};

/**
 * The pose a transition puts its sprite in at `shown`.
 *
 * Both effects describe the hidden end, like every other: a scale is nothing at
 * 0 and whole at 1, and a drop is `levels` up at 0 and landed at 1. So a tile
 * that appears falls in, and one that disappears would rise out.
 */
export function transitionPose(
  transition: Transition,
  shown: number,
): TransitionPose {
  return {
    scale: transition.scale ? shown : 1,
    dropLevels: transition.drop ? transition.drop.levels * (1 - shown) : 0,
  };
}

/** A transitioning quad, whole, in world pixels. */
export type PoseableQuad = {
  centreX: number;
  centreY: number;
  /** The middle of the cell it stands on, which a scale shrinks towards. */
  pivotX: number;
  pivotY: number;
  w: number;
  h: number;
};

/**
 * Where a posed quad is drawn, **on the world-pixel grid**.
 *
 * Its size is rounded to whole world pixels and its top-left corner is too, so
 * no world pixel is left half covered by it. With the shader sampling one texel
 * per world pixel (`TRANSITION_GLSL_SNAP`), a shrinking sprite loses whole rows
 * and columns of its art rather than drawing it with pixels of a smaller size —
 * the mixels a continuous scale would put next to full-size art.
 *
 * A drop's lift is rounded on its own and handed back as `dropLevels`, the
 * storeys actually drawn, so its depth can be raised by exactly as much as its
 * picture was.
 */
export function pixelSnappedQuad(
  quad: PoseableQuad,
  pose: TransitionPose,
): { scaleX: number; scaleY: number; x: number; y: number; dropLevels: number } {
  const w = Math.round(quad.w * pose.scale);
  const h = Math.round(quad.h * pose.scale);
  // The projection lifts a storey up-left by the same amount on both axes.
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

export function isFinished(live: LiveTransition, clockMs: number): boolean {
  return clockMs - live.startMs >= live.transition.durationMs;
}

/** What one live transition contributes to the plumes. */
export type TransitionEmitters = {
  live: LiveTransition;
  /** Appear only: the id of the placement's own plume, which thins in with it. */
  plumeId: string | null;
  /** Disappear only: the plume the tile gave off, carried on by its copy. */
  plume: ParticleEmitterSpec | null;
  /** The transition's own burst, for as long as it runs. */
  burst: ParticleEmitterSpec | null;
};

/** The id a dissolving copy's plume runs under. @see appendTransitionEmitters */
export function goingPlumeId(plumeId: string, noteId: string): string {
  return `${plumeId}:going:${noteId}`;
}

/**
 * Add live transitions' plumes to a frame's list, after the board's own — so a
 * crowded screen thins a burst before it drops a fire.
 *
 * - **A forming tile's own plume thins in with it.** Its entry is *replaced*
 *   with a tapered copy rather than written to: the spec belongs to its chunk,
 *   which says a tile is never winding down, and is rebuilt at full strength
 *   when the tile rejoins its batch.
 * - **A dissolving tile's plume is carried on by its copy, under an id of its
 *   own**, tapering as the tile goes. Not the original id: that slot may already
 *   hold whatever the tile turned into, with a plume of its own under that id,
 *   and two specs under one id leave one drawn with the other's config. The
 *   original's sparks finish by themselves once it is retired.
 * - **A burst** runs until its transition is finished.
 */
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

/**
 * How much of a dissolving tile's light is left, on the shared step grid.
 *
 * Read at the last grid line rather than now, which is the whole trick: the
 * value can only change when the grid does, and the grid is the same for every
 * light. See {@link LIGHT_FADE_STEP_MS}.
 */
export function fadingLightScale(live: LiveTransition, clockMs: number): number {
  const gridMs = Math.floor(clockMs / LIGHT_FADE_STEP_MS) * LIGHT_FADE_STEP_MS;
  return shownFraction(
    "disappear",
    gridMs - live.startMs,
    live.transition.durationMs,
  );
}

/** Values of {@link TransitionUniforms}.uFxPattern. */
const PATTERN_NONE = 0;
const PATTERN_CODE = { noise: 1, sweep: 2, dither: 3 } as const;

/** The transition half of a world material's uniforms. @see injectWorldShader */
export type TransitionUniforms = {
  /** Zero is the branch that costs nothing, on every material but a few. */
  uFxEnabled: { value: number };
  /** How much of the tile is showing, written each frame. @see liveShown */
  uFxShown: { value: number };
  /** 0 for no dissolve at all, then noise, sweep, dither. */
  uFxPattern: { value: number };
  /**
   * The sprite's middle in world pixels, before any scale or drop. Every
   * pattern is read at `position + this`, so it stays fixed to the art while
   * the mesh shrinks or falls — noise that moved with the world would slide
   * across a shrinking sprite instead of taking pixels off it.
   */
  uFxAnchorPx: { value: THREE.Vector2 };
  /** Sweep only: where the front starts, in world pixels. */
  uFxOriginPx: { value: THREE.Vector2 };
  /** Sweep only: from the origin to the sprite's farthest corner. */
  uFxSpanPx: { value: number };
  /** Sweep only: 1 when the pixels nearest the origin are the first to show. */
  uFxSweepAppear: { value: number };
  uFxClumpPx: { value: number };
  /** Linear RGB, because that is what `diffuseColor` is by then. */
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

/**
 * The uniforms every material without a transition shares.
 *
 * One object, bound by reference into every such material and never written:
 * a transition always gets uniforms of its own from
 * {@link transitionUniforms}.
 */
export const NO_TRANSITION_UNIFORMS: TransitionUniforms = noTransitionUniforms();

/** The sprite a transition plays on, in world pixels. */
export type TransitionSprite = {
  centreX: number;
  centreY: number;
  w: number;
  h: number;
};

/**
 * Uniforms for one live transition on one sprite.
 *
 * World pixels run right and *down*, so a sweep from `{x: -1, y: -1}` starts a
 * cell up and to the left of the sprite's middle.
 */
export function transitionUniforms(
  live: LiveTransition,
  sprite: TransitionSprite,
): TransitionUniforms {
  const u = noTransitionUniforms();
  writeTransitionUniforms(u, live, sprite);
  return u;
}

/**
 * Point an existing set of uniforms at a transition, or at none.
 *
 * Written in place for the reason `writeTintUniforms` is: a material binds its
 * uniform holders once, when its program compiles. The editor's preview keeps
 * one holder bound into its subject and plays transition after transition
 * through it without asking for a material again.
 */
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

function farthestCornerPx(
  originX: number,
  originY: number,
  sprite: TransitionSprite,
): number {
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

/** The sRGB transfer curve, undone. */
function srgbToLinear(channel: number): number {
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

/**
 * The vertex half: where each art pixel sits before the mesh is scaled or
 * dropped. Only a transitioning quad reads it, and only a mesh of its own
 * ever transitions, so `position` is always the quad's own local corner.
 */
export const TRANSITION_GLSL_VERTEX_COMMON = /* glsl */ `
uniform vec2 uFxAnchorPx;
varying vec2 vFxPx;
`;

export const TRANSITION_GLSL_VERTEX = /* glsl */ `
vFxPx = position.xy + uFxAnchorPx;
`;

/**
 * How far past a world pixel's centre the art pixel under it is chosen.
 *
 * At scales like ½ a world pixel's centre lands exactly on the edge between
 * two art pixels, and with float error the fragments inside that one world
 * pixel would disagree about which side they are on — drawing the very mixels
 * the snap is there to prevent. A nudge smaller than any pixel makes them all
 * choose the same side.
 */
const FX_EDGE_NUDGE_PX = 0.001;

/**
 * The fragment half's first step: redraw the sprite **one texel per world pixel**.
 *
 * Spliced in right after the texture is sampled. A transitioning mesh may be
 * scaled, and a scaled sprite sampled per fragment draws its art with pixels
 * smaller than the world's. So each fragment finds the centre of the world pixel
 * it falls in, steps its art-pixel position there along its screen-space
 * derivative (the world is drawn axis-aligned, so x only moves with x and y with
 * y), chooses the art pixel under that point, and fetches that art pixel's own
 * centre. `fxPx`, which every pattern reads, is that same centre, so a whole
 * world pixel shows one texel and dissolves at once.
 *
 * Before the roof cut's discard, so the derivatives are taken while every
 * fragment of the quad is still running.
 */
export const TRANSITION_GLSL_SNAP = /* glsl */ `
vec2 fxPx = vFxPx;
if (uFxEnabled > 0.5) {
  vec2 fxToCentre = floor(vWorldPx) + 0.5 - vWorldPx;
  vec2 fxSteps = vec2(
    fxToCentre.x / dFdx(vWorldPx.x),
    fxToCentre.y / dFdy(vWorldPx.y)
  );
  vec2 fxAtCentre = vFxPx + dFdx(vFxPx) * fxSteps.x + dFdy(vFxPx) * fxSteps.y;
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

/**
 * The fragment shader's declarations for a transition, and the threshold each
 * pattern compares against.
 *
 * Every pattern is read per **art pixel** (`floor(vFxPx)`), never per
 * fragment, so a dissolve eats whole pixels at every zoom. A pixel shows while
 * its key is at or above a threshold that climbs as the tile goes: noise and
 * dither give each pixel a fixed key, and a sweep gives it one from its
 * distance to the origin, roughed up so the front is not a clean circle.
 */
export const TRANSITION_GLSL_COMMON = /* glsl */ `
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

/**
 * The discard, spliced in after the roof cut.
 *
 * The threshold is stretched by the edge width so that a tile fully shown has
 * no band left on it and a tile fully gone has no pixel left.
 */
export const TRANSITION_GLSL_DISCARD = /* glsl */ `
float fxEdge = 0.0;
if (uFxEnabled > 0.5 && uFxPattern > 0.5) {
  float fxThreshold = (1.0 - uFxShown) * (1.0 + uFxEdgeWidth) - uFxEdgeWidth;
  float fxK = fxKey(floor(fxPx));
  if (fxK < fxThreshold) discard;
  fxEdge = step(fxK, fxThreshold + uFxEdgeWidth) * step(0.0001, uFxEdgeWidth);
}
`;

/**
 * The edge band, after the light: the front of a dissolve glows rather than
 * being lit by the room it is in, on the terms an unlit spark does.
 */
export const TRANSITION_GLSL_EDGE = /* glsl */ `
if (fxEdge > 0.5) {
  diffuseColor.rgb = uFxEdgeColor;
}
`;
