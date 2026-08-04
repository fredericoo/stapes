import * as THREE from "three";
import {
  DEPTH_MAX,
  DEPTH_MIN,
  DEPTH_STACK_BIAS,
  type DepthBox,
  PX_PER_HEIGHT,
  RAY_DEPTH_ELEV,
} from "../lib/geometry";
import { CELL_SIZE } from "../lib/types";

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
};

const VERTS_PER_QUAD = 4;
const BOX_COMPONENTS = 4;

/** Both renderers must agree, or the same tile sorts differently in each. */
export const WORLD_SHADER_CACHE_KEY = "stapes-lit-world-v3";

function glsl(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
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

  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute("aLightUv", new THREE.BufferAttribute(lightUvs, 2));
  geo.setAttribute("aUnlit", new THREE.BufferAttribute(unlit, 1));
  geo.setAttribute("aBox", new THREE.BufferAttribute(boxes, BOX_COMPONENTS));
  geo.setAttribute("aStack", new THREE.BufferAttribute(stacks, 1));
  geo.setIndex(
    new THREE.BufferAttribute(new Uint16Array([0, 2, 1, 2, 3, 1]), 1),
  );
  return geo;
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
 * orderings no single per-sprite depth can satisfy at once.
 *
 * Lighting: per-level light map sampled in cell space.
 */
export function injectWorldShader(
  shader: { vertexShader: string; fragmentShader: string; uniforms: object },
  lightUniforms: LevelLightUniforms,
) {
  Object.assign(shader.uniforms, lightUniforms);
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      /* glsl */ `#include <common>
attribute vec2 aLightUv;
attribute float aUnlit;
attribute vec4 aBox;
attribute float aStack;
varying vec2 vLightUv;
varying float vUnlit;
varying vec4 vBox;
varying float vStack;
varying vec2 vWorldPx;`,
    )
    .replace(
      "#include <uv_vertex>",
      /* glsl */ `#include <uv_vertex>
vLightUv = aLightUv;
vUnlit = aUnlit;
vBox = aBox;
vStack = aStack;
vWorldPx = (modelMatrix * vec4(position, 1.0)).xy;`,
    );

  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      /* glsl */ `#include <common>
uniform sampler2D uLightMap;
uniform vec2 uLightOrigin;
uniform vec2 uLightSize;
uniform float uLightingEnabled;
varying vec2 vLightUv;
varying float vUnlit;
varying vec4 vBox;
varying float vStack;
varying vec2 vWorldPx;`,
    )
    .replace(
      "#include <map_fragment>",
      /* glsl */ `#include <map_fragment>
if (uLightingEnabled > 0.5 && vUnlit < 0.5) {
  vec2 lightUv = (vLightUv - uLightOrigin) / uLightSize;
  vec3 light = texture2D(uLightMap, lightUv).rgb;
  diffuseColor.rgb *= light;
}
// Sample depth at the art pixel's centre, not the fragment's own position: a
// fragment is smaller than a texel once zoomed, and sampling per fragment lets
// a depth crossing cut a texel in half, drawing a smooth diagonal seam through
// pixel art. Snapping keeps every crossing on a texel boundary.
vec2 depthPx = floor(vWorldPx) + 0.5;
// Nearest box surface on this ray: each visible face caps how far the ray
// climbs before leaving the box, so the highest point inside is the min.
float faces = min(
  (vBox.x - depthPx.x) / ${glsl(PX_PER_HEIGHT)},
  (vBox.y - depthPx.y) / ${glsl(PX_PER_HEIGHT)}
);
float surfaceElev = clamp(min(faces, vBox.w), vBox.z, vBox.w);
float rayDepth =
  (depthPx.x + depthPx.y) / ${glsl(CELL_SIZE)} +
  ${glsl(RAY_DEPTH_ELEV)} * surfaceElev +
  vStack * ${glsl(DEPTH_STACK_BIAS)};
gl_FragDepth = clamp(
  (${glsl(DEPTH_MAX)} - rayDepth) / ${glsl(DEPTH_MAX - DEPTH_MIN)},
  0.0,
  1.0
);`,
    );
}
