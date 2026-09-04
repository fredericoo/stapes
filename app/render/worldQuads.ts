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
import {
  TINT_GLSL_COMMON,
  TINT_GLSL_FRAGMENT,
  type TintUniforms,
} from "./spriteTint";

/**
 * One tile sprite: a screen-space rectangle of texture, plus the solid box it
 * depicts. Draw order comes from the box (per-pixel, in the shader), not from
 * the quad's position — see {@link injectWorldShader}.
 */
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
  /** Breaks ties between coplanar surfaces; normally the tile's stack index. */
  stackBias: number;
  /**
   * Row in the level's {@link AnimationTable}, or absent for a quad that does
   * not animate — which is almost all of them, and is why this is optional
   * rather than a number every caller has to think about.
   *
   * Only the merged path can use it. A quad with a mesh of its own is rebuilt
   * wherever it moves to, so it rewrites its own UVs and never asks the table.
   */
  animRow?: number;
  /** Where in the cycle this placement starts — see `types.cellPhaseMs`. */
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
  /**
   * Time-of-day tint, multiplied into the sky factor per fragment. Keeping this
   * a uniform is what lets the clock move without re-tinting and re-uploading
   * every light texture — see the alpha convention on `uLightMap`.
   */
  uAmbient: { value: THREE.Vector3 };
};

/**
 * The roof-cut, as a per-level mask the fragment shader reads.
 *
 * A cut is a set of *cells* now rather than a level threshold (see
 * `lib/levelVisibility`), and level geometry is merged into one draw call per
 * texture — so there is no object to hide. This is the same road the light map
 * already travels: a small texture in cell space, sampled at the quad's own
 * cell, and a fragment whose cell is cut is discarded.
 *
 * Uploaded when the cut changes rather than per frame, and it is the bounding
 * box of that level's cut cells plus an apron, so a lifted roof is a few
 * hundred bytes whatever the size of the world.
 */
export type LevelCutUniforms = {
  /** Red channel: nonzero where the cell is cut away. */
  uCutMask: { value: THREE.Texture };
  /** Cell coordinate of the mask's first texel. */
  uCutOrigin: { value: THREE.Vector2 };
  /** Mask size in cells, which is also its size in texels. */
  uCutSize: { value: THREE.Vector2 };
  uCutEnabled: { value: number };
};

/**
 * A cut that takes nothing, for a renderer that has none.
 *
 * Takes a texture rather than making one because the sampler is bound whatever
 * the branch does with it, and a null sampler is a warning per frame per
 * material. Any 1×1 texture will do — the shader never reads it while
 * `uCutEnabled` is 0.
 */
export function noCutUniforms(placeholder: THREE.Texture): LevelCutUniforms {
  return {
    uCutMask: { value: placeholder },
    uCutOrigin: { value: new THREE.Vector2(0, 0) },
    uCutSize: { value: new THREE.Vector2(1, 1) },
    uCutEnabled: { value: 0 },
  };
}

/**
 * The level's animations, as a table the *vertex* shader reads.
 *
 * Vertex rather than fragment because a frame is constant across a quad: this
 * costs four lookups per animated quad and leaves the fragment stage — which is
 * where the depth and lighting work is — untouched.
 *
 * `uAnimClockMs` is the only one that moves, and it moves once per level per
 * frame. Everything else changes when the level is rebuilt. See
 * `./animTable` for the encoding.
 */
export type LevelAnimUniforms = {
  uAnimTable: { value: THREE.Texture };
  /** Table size in texels: frames across, animations down. */
  uAnimSize: { value: THREE.Vector2 };
  uAnimClockMs: { value: number };
  uAnimEnabled: { value: number };
};

/**
 * No animations, for a renderer whose quads never carry a row.
 *
 * Same reason {@link noCutUniforms} takes a placeholder: the sampler is bound
 * whatever the branch does, and a null one is a warning per frame per material.
 * The particle and preview layers share this shader without sharing its
 * geometry, so their quads have no `aAnim` at all — an absent attribute reads
 * as zero, and zero is a valid row, which is exactly why the branch is on a
 * uniform and not on the attribute alone.
 */
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

/** Both renderers must agree, or the same tile sorts differently in each. */
export const WORLD_SHADER_CACHE_KEY = "stapes-lit-world-v10";

function glsl(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
}

/**
 * Light-map cells covered per world pixel of this quad — the gradient of
 * `aLightUv` across it. Constant per quad, so the shader can re-evaluate the
 * light coordinate at any point on the quad from any other.
 */
function lightCellsPerPixel(q: Pick<
  Quad,
  "w" | "h" | "lightX0" | "lightY0" | "lightX1" | "lightY1"
>): [number, number] {
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

/**
 * Merge many quads into one draw call. Vertex Z is 0 for every quad — depth is
 * written per fragment — so merging never costs correctness.
 */
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
  const indices =
    n * VERTS_PER_QUAD > 65535 ? new Uint32Array(n * 6) : new Uint16Array(n * 6);

  for (let i = 0; i < n; i++) {
    const q = quads[i]!;
    const x0 = q.x;
    const y0 = q.y;
    const x1 = q.x + q.w;
    const y1 = q.y + q.h;
    const pb = i * 12;
    // Match PlaneGeometry + Y-down UV mapping (see buildSingleQuadGeometry).
    // vert0 (local +Y / screen-bottom): (x0, y1) uv (u0, v0)
    // vert1: (x1, y1) uv (u1, v0)
    // vert2 (local -Y / screen-top): (x0, y0) uv (u0, v1)
    // vert3: (x1, y0) uv (u1, v1)
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

    // Same vert order as UVs — cell-space corners for the light map.
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
    // PlaneGeometry winding: 0,2,1 / 2,3,1
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
  geo.setAttribute(
    "aLightScale",
    new THREE.BufferAttribute(lightScales, 2),
  );
  geo.setAttribute("aAnim", new THREE.BufferAttribute(anims, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  return geo;
}

/**
 * One quad centred on its own origin, for sprites that need their own mesh
 * (animated, or moving and therefore offset every frame). The caller positions
 * the mesh; the shader reads world position back off the model matrix.
 */
export function buildSingleQuadGeometry(
  q: Omit<Quad, "x" | "y">,
): THREE.BufferGeometry {
  const hw = q.w / 2;
  const hh = q.h / 2;
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array([
    -hw, hh, 0,
    hw, hh, 0,
    -hw, -hh, 0,
    hw, -hh, 0,
  ]);
  const uvs = new Float32Array([q.u0, q.v0, q.u1, q.v0, q.u0, q.v1, q.u1, q.v1]);
  const lightUvs = new Float32Array([
    q.lightX0, q.lightY1,
    q.lightX1, q.lightY1,
    q.lightX0, q.lightY0,
    q.lightX1, q.lightY0,
  ]);
  const unlit = new Float32Array(VERTS_PER_QUAD).fill(q.unlit ? 1 : 0);
  const boxes = new Float32Array(VERTS_PER_QUAD * BOX_COMPONENTS);
  const stacks = new Float32Array(VERTS_PER_QUAD);
  writeQuadBox(boxes, stacks, 0, q.box, q.stackBias);
  const [lsx, lsy] = lightCellsPerPixel(q);
  const lightScales = new Float32Array([lsx, lsy, lsx, lsy, lsx, lsy, lsx, lsy]);
  // Never the table's: a quad with its own mesh rewrites its own UVs. The
  // attribute is still written, because an absent one reads as zero and zero is
  // a valid row.
  const anims = new Float32Array(VERTS_PER_QUAD * 2);
  for (let v = 0; v < VERTS_PER_QUAD; v++) anims[v * 2] = NO_ANIMATION;

  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute("aLightUv", new THREE.BufferAttribute(lightUvs, 2));
  geo.setAttribute("aUnlit", new THREE.BufferAttribute(unlit, 1));
  geo.setAttribute("aBox", new THREE.BufferAttribute(boxes, BOX_COMPONENTS));
  geo.setAttribute("aStack", new THREE.BufferAttribute(stacks, 1));
  geo.setAttribute(
    "aLightScale",
    new THREE.BufferAttribute(lightScales, 2),
  );
  geo.setAttribute("aAnim", new THREE.BufferAttribute(anims, 2));
  geo.setIndex(
    new THREE.BufferAttribute(new Uint16Array([0, 2, 1, 2, 3, 1]), 1),
  );
  return geo;
}

/**
 * Retarget a single-quad mesh's light sample. A quad that moves across cells
 * has to take the light of wherever it is now, or it wears the lighting of the
 * cell it was built in for as long as it travels.
 *
 * Only the origin moves; the *span* is a fixed cell either way, so `aLightScale`
 * is written once at build time and never touched again.
 *
 * A walking tile does not need this — its mesh is rebuilt at the cell it lands
 * in, and a step is one cell and 200ms. Something that crosses several cells
 * without ever committing to one does: see `./projectileMotion`.
 */
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

/**
 * Retarget a single-quad mesh's depth box. A moving tile straddles cells, so
 * its box travels with it — call this whenever its position changes, from the
 * same motion snapshot, or the sprite and its depth disagree for a frame.
 */
export function writeBoxAttr(
  geo: THREE.BufferGeometry,
  box: DepthBox,
  stackBias: number,
) {
  const boxAttr = geo.getAttribute("aBox") as THREE.BufferAttribute;
  const stackAttr = geo.getAttribute("aStack") as THREE.BufferAttribute;
  writeQuadBox(
    boxAttr.array as Float32Array,
    stackAttr.array as Float32Array,
    0,
    box,
    stackBias,
  );
  boxAttr.needsUpdate = true;
  stackAttr.needsUpdate = true;
}

/**
 * Tile shading and depth, patched into MeshBasicMaterial.
 *
 * Depth: each fragment resolves which face of its tile's box it depicts and
 * writes that point's ray depth, so a sprite is not forced to sit wholly in
 * front of or behind another. This is what lets a character mid-step be behind
 * the wall beside it while standing on the floor tile in front of it — two
 * orderings no single per-sprite depth can satisfy at once. Fragments whose ray
 * misses the box — art drawn outside its own silhouette — fall back to the
 * entry plane, which sorts them with the cell they hang over.
 *
 * Lighting: per-level light map sampled in cell space.
 *
 * Tint: an optional OKLab wash worn by whatever is carrying a status, applied to
 * the sampled texel before the light reaches it. Free on the materials that do
 * not have one — see `./spriteTint`.
 */
export function injectWorldShader(
  shader: { vertexShader: string; fragmentShader: string; uniforms: object },
  lightUniforms: LevelLightUniforms,
  tint: TintUniforms,
  cut: LevelCutUniforms,
  anim: LevelAnimUniforms,
) {
  Object.assign(shader.uniforms, lightUniforms, tint, cut, anim);
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      /* glsl */ `#include <common>
attribute vec2 aLightUv;
attribute float aUnlit;
attribute vec4 aBox;
attribute float aStack;
attribute vec2 aLightScale;
attribute vec2 aAnim;
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

// Where this row's frame at clockMs sits, relative to frame 0, in UV space.
//
// The walk stops at the live frame, so its cost is the frame's index rather
// than the cycle's length — and the loop's bound is a constant only because
// GLSL needs one, never because a row is expected to be that long. The last
// column always holds the cycle length in its z channel (rows are padded with
// copies of their final frame), so the modulo needs no separate lookup.
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
      /* glsl */ `#include <uv_vertex>
vLightUv = aLightUv;
vUnlit = aUnlit;
vBox = aBox;
vStack = aStack;
vLightScale = aLightScale;
vWorldPx = (modelMatrix * vec4(position, 1.0)).xy;
#ifdef USE_MAP
if (uAnimEnabled > 0.5 && aAnim.x >= 0.0) {
  // Straight onto the map coordinate, which is sound because nothing here sets
  // a texture transform, so mapTransform is the identity and UV space and
  // atlas space are the same space.
  vMapUv += animFrameOffset(aAnim.x, uAnimClockMs + aAnim.y);
}
#endif`,
    );

  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      /* glsl */ `#include <common>
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
${TINT_GLSL_COMMON}`,
    )
    .replace(
      "#include <map_fragment>",
      /* glsl */ `#include <map_fragment>
// The roof cut, first, because a discarded fragment is not worth shading.
//
// vBox.xy are this quad's own base cell — the unshifted east and south edges in
// world pixels — so the cell is constant across the quad however tall the
// sprite is. A wall two levels high is cut with the cell it stands on, which is
// the cell the fill claimed.
if (uCutEnabled > 0.5) {
  vec2 cutCell = vBox.xy / ${glsl(CELL_SIZE)} - 0.5;
  vec2 cutUv = (cutCell - uCutOrigin) / uCutSize;
  if (texture2D(uCutMask, cutUv).r > 0.5) discard;
}
${TINT_GLSL_FRAGMENT}
// Everything below samples at the centre of the art pixel this fragment falls
// in, not at the fragment itself. A fragment is smaller than a texel once
// zoomed (16 of them per texel at 4x), so sampling per fragment lets a value
// vary *inside* a pixel — which is how a smooth diagonal seam or a smooth
// light gradient ends up drawn across art that should be flat per pixel.
vec2 depthPx = floor(vWorldPx) + 0.5;
if (uLightingEnabled > 0.5 && vUnlit < 0.5) {
  // vLightUv and vWorldPx are both affine across the quad, so stepping from the
  // fragment to the pixel centre is just the constant per-quad gradient.
  vec2 lightCell = vLightUv + (depthPx - vWorldPx) * vLightScale;
  vec2 lightUv = (lightCell - uLightOrigin) / uLightSize;
  // RGB is block light, alpha is the sky factor, so the tint happens here
  // rather than on the CPU. Alpha 0 means "already composed" — a caller that
  // tints its own texture uploads it that way and this reduces to a passthrough.
  vec4 lightTexel = texture2D(uLightMap, lightUv);
  vec3 light = min(vec3(1.0), lightTexel.a * uAmbient + lightTexel.rgb);
  diffuseColor.rgb *= light;
}
// Depth, at that same pixel centre, so a crossing between two sprites can only
// ever land on a texel boundary.
// Where the ray leaves the box: each visible (south/east/top) face caps how far
// it climbs before getting out, so the highest point inside is the min.
float eastFace = (vBox.x - depthPx.x) / ${glsl(PX_PER_HEIGHT)};
float southFace = (vBox.y - depthPx.y) / ${glsl(PX_PER_HEIGHT)};
float exitElev = min(min(eastFace, southFace), vBox.w);
// The far (north/west) faces, one cell of ray climb behind the near ones.
float farFaceElev =
  max(eastFace, southFace) - ${glsl(HEIGHT_PER_LEVEL)};
// A surface above the exit means no face was crossed: art drawn outside its own
// silhouette, landing on a fallback plane — the far face when it hangs up-left
// over the cells behind it, the foot when it hangs down-right over the cells in
// front. Either plane is where a neighbour's own face already is, so the nudge
// settles that tie for the art. The foot case needs the box to have volume: a
// flat tile's art past its own foot is more floor, and coplanar floors keep
// painter order. See boxSurface.
float surfaceElev = max(max(exitElev, farFaceElev), vBox.z);
float overhangBias =
  surfaceElev > exitElev && (farFaceElev > exitElev || vBox.w > vBox.z)
    ? ${glsl(DEPTH_OVERHANG_BIAS)}
    : 0.0;
// vBox.xy are the unshifted east/south edges of the base cell. When two flat
// overhanging sprites share a pixel at the same elev, this restores S-then-E
// painter order (merge draw order alone is not stable).
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
    );
}
