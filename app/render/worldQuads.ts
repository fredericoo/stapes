import * as THREE from "three";
import {
  DEPTH_MAX,
  DEPTH_MIN,
  DEPTH_OVERHANG_BIAS,
  DEPTH_PLANE_BIAS,
  DEPTH_PLANE_EAST_WEIGHT,
  DEPTH_STACK_BIAS,
  type DepthBox,
  PX_PER_HEIGHT,
  RAY_DEPTH_ELEV,
} from "../lib/geometry";
import { CELL_SIZE, HEIGHT_PER_LEVEL } from "../lib/types";
import { ANIM_MAX_FRAMES, NO_ANIMATION } from "./animTable";
import { TINT_GLSL_COMMON, TINT_GLSL_FRAGMENT, type TintUniforms } from "./spriteTint";
import {
  NO_TRANSITION_UNIFORMS,
  TRANSITION_GLSL_COMMON,
  TRANSITION_GLSL_DISCARD,
  TRANSITION_GLSL_EDGE,
  TRANSITION_GLSL_SNAP,
  TRANSITION_GLSL_VERTEX,
  TRANSITION_GLSL_VERTEX_COMMON,
  type TransitionUniforms,
} from "./tileTransitions";

export type Quad = {
  x: number;
  y: number;
  w: number;
  h: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  box: DepthBox;
  stackBias: number;
  animRow?: number;
  animPhaseMs?: number;
  lightX0: number;
  lightY0: number;
  lightX1: number;
  lightY1: number;
  unlit: boolean;
};

export type LevelLightUniforms = {
  uLightMap: { value: THREE.Texture };
  uLightOrigin: { value: THREE.Vector2 };
  uLightSize: { value: THREE.Vector2 };
  uLightingEnabled: { value: number };
  uAmbient: { value: THREE.Vector3 };
};

export type LevelCutUniforms = {
  uCutMask: { value: THREE.Texture };
  uCutOrigin: { value: THREE.Vector2 };
  uCutSize: { value: THREE.Vector2 };
  uCutEnabled: { value: number };
};

export function noCutUniforms(placeholder: THREE.Texture): LevelCutUniforms {
  return {
    uCutMask: { value: placeholder },
    uCutOrigin: { value: new THREE.Vector2(0, 0) },
    uCutSize: { value: new THREE.Vector2(1, 1) },
    uCutEnabled: { value: 0 },
  };
}

export type LevelAnimUniforms = {
  uAnimTable: { value: THREE.Texture };
  uAnimSize: { value: THREE.Vector2 };
  uAnimClockMs: { value: number };
  uAnimEnabled: { value: number };
};

export function noAnimUniforms(placeholder: THREE.Texture): LevelAnimUniforms {
  return {
    uAnimTable: { value: placeholder },
    uAnimSize: { value: new THREE.Vector2(1, 1) },
    uAnimClockMs: { value: 0 },
    uAnimEnabled: { value: 0 },
  };
}

const VERTS_PER_QUAD = 4;
const BOX_COMPONENTS = 4;
const WADE_COMPONENTS = 2;

const WADE_ALPHA = 0.5;

/**
 * Bump the version suffix whenever this shader's source changes, or three.js
 * reuses the stale compiled program from its cache.
 */
export const WORLD_SHADER_CACHE_KEY = "stapes-lit-world-v12";

function glsl(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
}

function lightCellsPerPixel(
  q: Pick<Quad, "w" | "h" | "lightX0" | "lightY0" | "lightX1" | "lightY1">,
): [number, number] {
  return [
    q.w === 0 ? 0 : (q.lightX1 - q.lightX0) / q.w,
    q.h === 0 ? 0 : (q.lightY1 - q.lightY0) / q.h,
  ];
}

function writeQuadBox(
  boxes: Float32Array,
  stacks: Float32Array,
  quadIndex: number,
  box: DepthBox,
  stackBias: number,
) {
  const bb = quadIndex * VERTS_PER_QUAD * BOX_COMPONENTS;
  for (let v = 0; v < VERTS_PER_QUAD; v++) {
    const o = bb + v * BOX_COMPONENTS;
    boxes[o] = box.eastPx;
    boxes[o + 1] = box.southPx;
    boxes[o + 2] = box.foot;
    boxes[o + 3] = box.top;
    stacks[quadIndex * VERTS_PER_QUAD + v] = stackBias;
  }
}

export function buildMergedQuadGeometry(quads: Quad[]): THREE.BufferGeometry {
  const n = quads.length;
  const positions = new Float32Array(n * VERTS_PER_QUAD * 3);
  const uvs = new Float32Array(n * VERTS_PER_QUAD * 2);
  const lightUvs = new Float32Array(n * VERTS_PER_QUAD * 2);
  const unlit = new Float32Array(n * VERTS_PER_QUAD);
  const boxes = new Float32Array(n * VERTS_PER_QUAD * BOX_COMPONENTS);
  const stacks = new Float32Array(n * VERTS_PER_QUAD);
  const lightScales = new Float32Array(n * VERTS_PER_QUAD * 2);
  const anims = new Float32Array(n * VERTS_PER_QUAD * 2);
  const indices = n * VERTS_PER_QUAD > 65535 ? new Uint32Array(n * 6) : new Uint16Array(n * 6);

  for (let i = 0; i < n; i++) {
    const q = quads[i]!;
    const x0 = q.x;
    const y0 = q.y;
    const x1 = q.x + q.w;
    const y1 = q.y + q.h;
    const pb = i * 12;
    positions[pb] = x0;
    positions[pb + 1] = y1;
    positions[pb + 3] = x1;
    positions[pb + 4] = y1;
    positions[pb + 6] = x0;
    positions[pb + 7] = y0;
    positions[pb + 9] = x1;
    positions[pb + 10] = y0;

    const ub = i * 8;
    uvs[ub] = q.u0;
    uvs[ub + 1] = q.v0;
    uvs[ub + 2] = q.u1;
    uvs[ub + 3] = q.v0;
    uvs[ub + 4] = q.u0;
    uvs[ub + 5] = q.v1;
    uvs[ub + 6] = q.u1;
    uvs[ub + 7] = q.v1;

    lightUvs[ub] = q.lightX0;
    lightUvs[ub + 1] = q.lightY1;
    lightUvs[ub + 2] = q.lightX1;
    lightUvs[ub + 3] = q.lightY1;
    lightUvs[ub + 4] = q.lightX0;
    lightUvs[ub + 5] = q.lightY0;
    lightUvs[ub + 6] = q.lightX1;
    lightUvs[ub + 7] = q.lightY0;

    const u = q.unlit ? 1 : 0;
    const vb = i * VERTS_PER_QUAD;
    unlit[vb] = u;
    unlit[vb + 1] = u;
    unlit[vb + 2] = u;
    unlit[vb + 3] = u;

    writeQuadBox(boxes, stacks, i, q.box, q.stackBias);

    const [lsx, lsy] = lightCellsPerPixel(q);
    const row = q.animRow ?? NO_ANIMATION;
    const phase = q.animPhaseMs ?? 0;
    for (let v = 0; v < VERTS_PER_QUAD; v++) {
      lightScales[ub + v * 2] = lsx;
      lightScales[ub + v * 2 + 1] = lsy;
      anims[ub + v * 2] = row;
      anims[ub + v * 2 + 1] = phase;
    }

    const base = i * VERTS_PER_QUAD;
    const ib = i * 6;
    indices[ib] = base;
    indices[ib + 1] = base + 2;
    indices[ib + 2] = base + 1;
    indices[ib + 3] = base + 2;
    indices[ib + 4] = base + 3;
    indices[ib + 5] = base + 1;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute("aLightUv", new THREE.BufferAttribute(lightUvs, 2));
  geo.setAttribute("aUnlit", new THREE.BufferAttribute(unlit, 1));
  geo.setAttribute("aBox", new THREE.BufferAttribute(boxes, BOX_COMPONENTS));
  geo.setAttribute("aStack", new THREE.BufferAttribute(stacks, 1));
  geo.setAttribute("aLightScale", new THREE.BufferAttribute(lightScales, 2));
  geo.setAttribute("aAnim", new THREE.BufferAttribute(anims, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  return geo;
}

export function buildSingleQuadGeometry(q: Omit<Quad, "x" | "y">): THREE.BufferGeometry {
  const hw = q.w / 2;
  const hh = q.h / 2;
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array([-hw, hh, 0, hw, hh, 0, -hw, -hh, 0, hw, -hh, 0]);
  const uvs = new Float32Array([q.u0, q.v0, q.u1, q.v0, q.u0, q.v1, q.u1, q.v1]);
  const lightUvs = new Float32Array([
    q.lightX0,
    q.lightY1,
    q.lightX1,
    q.lightY1,
    q.lightX0,
    q.lightY0,
    q.lightX1,
    q.lightY0,
  ]);
  const unlit = new Float32Array(VERTS_PER_QUAD).fill(q.unlit ? 1 : 0);
  const boxes = new Float32Array(VERTS_PER_QUAD * BOX_COMPONENTS);
  const stacks = new Float32Array(VERTS_PER_QUAD);
  writeQuadBox(boxes, stacks, 0, q.box, q.stackBias);
  const [lsx, lsy] = lightCellsPerPixel(q);
  const lightScales = new Float32Array([lsx, lsy, lsx, lsy, lsx, lsy, lsx, lsy]);
  const anims = new Float32Array(VERTS_PER_QUAD * 2);
  for (let v = 0; v < VERTS_PER_QUAD; v++) anims[v * 2] = NO_ANIMATION;

  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute("aLightUv", new THREE.BufferAttribute(lightUvs, 2));
  geo.setAttribute("aUnlit", new THREE.BufferAttribute(unlit, 1));
  geo.setAttribute("aBox", new THREE.BufferAttribute(boxes, BOX_COMPONENTS));
  geo.setAttribute("aStack", new THREE.BufferAttribute(stacks, 1));
  geo.setAttribute("aLightScale", new THREE.BufferAttribute(lightScales, 2));
  geo.setAttribute("aAnim", new THREE.BufferAttribute(anims, 2));
  geo.setAttribute(
    "aWade",
    new THREE.BufferAttribute(new Float32Array(VERTS_PER_QUAD * WADE_COMPONENTS), WADE_COMPONENTS),
  );
  geo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 2, 1, 2, 3, 1]), 1));
  return geo;
}

export function writeLightUvAttr(
  geo: THREE.BufferGeometry,
  lightX0: number,
  lightY0: number,
  lightX1: number,
  lightY1: number,
) {
  const attr = geo.getAttribute("aLightUv") as THREE.BufferAttribute;
  const uvs = attr.array as Float32Array;
  uvs[0] = lightX0;
  uvs[1] = lightY1;
  uvs[2] = lightX1;
  uvs[3] = lightY1;
  uvs[4] = lightX0;
  uvs[5] = lightY0;
  uvs[6] = lightX1;
  uvs[7] = lightY0;
  attr.needsUpdate = true;
}

export function writeWadeAttr(geo: THREE.BufferGeometry, sinkPx: number, edgePx: number): boolean {
  const attr = geo.getAttribute("aWade") as THREE.BufferAttribute | undefined;
  if (!attr) return false;
  const arr = attr.array as Float32Array;
  if (arr[0] === sinkPx && arr[1] === edgePx) return false;
  for (let v = 0; v < VERTS_PER_QUAD; v++) {
    arr[v * WADE_COMPONENTS] = sinkPx;
    arr[v * WADE_COMPONENTS + 1] = edgePx;
  }
  attr.needsUpdate = true;
  return true;
}

export function writeBoxAttr(geo: THREE.BufferGeometry, box: DepthBox, stackBias: number) {
  const boxAttr = geo.getAttribute("aBox") as THREE.BufferAttribute;
  const stackAttr = geo.getAttribute("aStack") as THREE.BufferAttribute;
  writeQuadBox(boxAttr.array as Float32Array, stackAttr.array as Float32Array, 0, box, stackBias);
  boxAttr.needsUpdate = true;
  stackAttr.needsUpdate = true;
}

/**
 * The animated-frame offset is added straight onto `vMapUv`, which is correct only
 * while the world material has no texture transform. If one is set, the offset
 * must go through `mapTransform`.
 */
export function injectWorldShader(
  shader: { vertexShader: string; fragmentShader: string; uniforms: object },
  lightUniforms: LevelLightUniforms,
  tint: TintUniforms,
  cut: LevelCutUniforms,
  anim: LevelAnimUniforms,
  transition: TransitionUniforms = NO_TRANSITION_UNIFORMS,
) {
  Object.assign(shader.uniforms, lightUniforms, tint, cut, anim, transition);
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      `#include <common>
attribute vec2 aLightUv;
attribute float aUnlit;
attribute vec4 aBox;
attribute float aStack;
attribute vec2 aLightScale;
attribute vec2 aAnim;
attribute vec2 aWade;
uniform sampler2D uAnimTable;
uniform vec2 uAnimSize;
uniform float uAnimClockMs;
uniform float uAnimEnabled;
varying vec2 vLightUv;
varying float vUnlit;
varying vec4 vBox;
varying float vStack;
varying vec2 vWorldPx;
varying vec2 vLightScale;
varying vec2 vWade;
${TRANSITION_GLSL_VERTEX_COMMON}

// Walks the row until the texel's z (that frame's cumulative end time)
// passes the clock; the last column repeats the cycle length so the loop
// always stops before reading past the row's real frames.
vec2 animFrameOffset(float row, float clockMs) {
  float v = (row + 0.5) / uAnimSize.y;
  float total = texture2D(uAnimTable, vec2(1.0 - 0.5 / uAnimSize.x, v)).z;
  float t = mod(clockMs, max(total, 1.0));
  vec2 offset = vec2(0.0);
  for (int i = 0; i < ${ANIM_MAX_FRAMES}; i++) {
    if (float(i) >= uAnimSize.x) break;
    vec4 texel = texture2D(uAnimTable, vec2((float(i) + 0.5) / uAnimSize.x, v));
    offset = texel.xy;
    if (t < texel.z) break;
  }
  return offset;
}`,
    )
    .replace(
      "#include <uv_vertex>",
      `#include <uv_vertex>
vLightUv = aLightUv;
vUnlit = aUnlit;
vBox = aBox;
vStack = aStack;
vLightScale = aLightScale;
vWade = aWade;
vWorldPx = (modelMatrix * vec4(position, 1.0)).xy;
${TRANSITION_GLSL_VERTEX}
#ifdef USE_MAP
if (uAnimEnabled > 0.5 && aAnim.x >= 0.0) {
  vMapUv += animFrameOffset(aAnim.x, uAnimClockMs + aAnim.y);
}
#endif`,
    );

  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      `#include <common>
uniform sampler2D uLightMap;
uniform vec2 uLightOrigin;
uniform vec2 uLightSize;
uniform float uLightingEnabled;
uniform vec3 uAmbient;
uniform sampler2D uCutMask;
uniform vec2 uCutOrigin;
uniform vec2 uCutSize;
uniform float uCutEnabled;
varying vec2 vLightUv;
varying float vUnlit;
varying vec4 vBox;
varying float vStack;
varying vec2 vWorldPx;
varying vec2 vLightScale;
varying vec2 vWade;
${TINT_GLSL_COMMON}
${TRANSITION_GLSL_COMMON}`,
    )
    .replace(
      "#include <map_fragment>",
      `#include <map_fragment>
${TRANSITION_GLSL_SNAP}
// vBox.xy is this quad's unshifted base cell, constant across the quad
// however tall the sprite is, so a tall wall is cut with the cell it stands on.
if (uCutEnabled > 0.5) {
  vec2 cutCell = vBox.xy / ${glsl(CELL_SIZE)} - 0.5;
  vec2 cutUv = (cutCell - uCutOrigin) / uCutSize;
  if (texture2D(uCutMask, cutUv).r > 0.5) discard;
}
${TRANSITION_GLSL_DISCARD}
${TINT_GLSL_FRAGMENT}
// Sample at the art pixel's centre rather than the fragment: a fragment is
// smaller than a texel once zoomed, so sampling per fragment would smear a
// gradient across art that should read flat per pixel.
vec2 depthPx = floor(vWorldPx) + 0.5;
if (uLightingEnabled > 0.5 && vUnlit < 0.5) {
  // vLightUv and vWorldPx are both affine across the quad, so stepping from
  // the fragment to the pixel centre is just the constant per-quad gradient.
  vec2 lightCell = vLightUv + (depthPx - vWorldPx) * vLightScale;
  vec2 lightUv = (lightCell - uLightOrigin) / uLightSize;
  vec4 lightTexel = texture2D(uLightMap, lightUv);
  // RGB is block light, alpha is the sky factor, so the ambient tint is
  // applied here rather than baked into the map.
  vec3 light = min(vec3(1.0), lightTexel.a * uAmbient + lightTexel.rgb);
  diffuseColor.rgb *= light;
}
${TRANSITION_GLSL_EDGE}
// A ray cast from this pixel: each visible (south/east/top) face caps how far
// it climbs before leaving the box, so the exit point is the lowest of them.
float eastFace = (vBox.x - depthPx.x) / ${glsl(PX_PER_HEIGHT)};
float southFace = (vBox.y - depthPx.y) / ${glsl(PX_PER_HEIGHT)};
float exitElev = min(min(eastFace, southFace), vBox.w);
// The far (north/west) faces, one cell of climb behind the near ones.
float farFaceElev =
  max(eastFace, southFace) - ${glsl(HEIGHT_PER_LEVEL)};
// A surface above the exit point means the ray left without crossing a face —
// art drawn outside its own silhouette — so it falls back to whichever
// neighbouring plane already owns that space.
float surfaceElev = max(max(exitElev, farFaceElev), vBox.z);
float overhangBias =
  surfaceElev > exitElev && (farFaceElev > exitElev || vBox.w > vBox.z)
    ? ${glsl(DEPTH_OVERHANG_BIAS)}
    : 0.0;
// Breaks ties between two flat overhanging sprites at the same elevation,
// restoring south-then-east painter order.
float planeBias =
  (vBox.y + vBox.x * ${glsl(DEPTH_PLANE_EAST_WEIGHT)}) *
  ${glsl(DEPTH_PLANE_BIAS)};
float rayDepth =
  (depthPx.x + depthPx.y) / ${glsl(CELL_SIZE)} +
  ${glsl(RAY_DEPTH_ELEV)} * surfaceElev +
  vStack * ${glsl(DEPTH_STACK_BIAS)} +
  planeBias +
  overhangBias;
gl_FragDepth = clamp(
  (${glsl(DEPTH_MAX)} - rayDepth) / ${glsl(DEPTH_MAX - DEPTH_MIN)},
  0.0,
  1.0
);`,
    )
    .replace(
      "#include <alphatest_fragment>",
      `#include <alphatest_fragment>
// Feet measured from the sprite's own sunk position, not its box, since a
// body's slot is two cells square and the box corner is empty.
if (vWade.y > 0.0) {
  vec2 sunkFeet =
    vBox.xy - ${glsl(CELL_SIZE / 2)} - vBox.z * ${glsl(PX_PER_HEIGHT)} + vWade.x;
  vec2 fromFeet = sunkFeet - depthPx;
  float fromLine = min(fromFeet.x, fromFeet.y);
  if (fromLine < 1.0) discard;
  if (fromLine < vWade.y) diffuseColor.a *= ${glsl(WADE_ALPHA)};
}`,
    );
}
