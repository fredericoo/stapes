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
  unlit: boolean;
};

/**
 * One level's light map plus the two it sits between.
 *
 * A fragment lights from the world point it depicts, which is rarely at the
 * height of its own level's slab — a wall face climbs a whole level across its
 * art. Holding the neighbours here is what lets the shader cross that boundary
 * smoothly instead of stepping at it. Each plane covers its own box, so each
 * carries its own origin and size.
 */
export type LevelLightUniforms = {
  uLightMap: { value: THREE.Texture };
  uLightOrigin: { value: THREE.Vector2 };
  uLightSize: { value: THREE.Vector2 };
  uLightMapUp: { value: THREE.Texture };
  uLightOriginUp: { value: THREE.Vector2 };
  uLightSizeUp: { value: THREE.Vector2 };
  uLightMapDown: { value: THREE.Texture };
  uLightOriginDown: { value: THREE.Vector2 };
  uLightSizeDown: { value: THREE.Vector2 };
  /** Which level this material draws, so the shader knows where its slab is. */
  uLevelZ: { value: number };
  uLightingEnabled: { value: number };
  /**
   * Time-of-day tint, multiplied into the sky factor per fragment. Keeping this
   * a uniform is what lets the clock move without re-tinting and re-uploading
   * every light texture — see the alpha convention on `uLightMap`.
   */
  uAmbient: { value: THREE.Vector3 };
};

const VERTS_PER_QUAD = 4;
const BOX_COMPONENTS = 4;

/** Both renderers must agree, or the same tile sorts differently in each. */
export const WORLD_SHADER_CACHE_KEY = "stapes-lit-world-v7";

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
  const unlit = new Float32Array(VERTS_PER_QUAD).fill(q.unlit ? 1 : 0);
  const boxes = new Float32Array(VERTS_PER_QUAD * BOX_COMPONENTS);
  const stacks = new Float32Array(VERTS_PER_QUAD);
  writeQuadBox(boxes, stacks, 0, q.box, q.stackBias);

  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
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
 * orderings no single per-sprite depth can satisfy at once. Fragments whose ray
 * misses the box — art drawn outside its own silhouette — fall back to the
 * entry plane, which sorts them with the cell they hang over.
 *
 * Lighting: the same answer feeds the light. A fragment samples the light field
 * at the world point it depicts — its pixel and the surface elevation found
 * above — interpolated across the level planes it falls between, so a wall face
 * is lit by the wall it draws rather than by the cell its sprite was authored
 * over.
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
attribute float aUnlit;
attribute vec4 aBox;
attribute float aStack;
varying float vUnlit;
varying vec4 vBox;
varying float vStack;
varying vec2 vWorldPx;`,
    )
    .replace(
      "#include <uv_vertex>",
      /* glsl */ `#include <uv_vertex>
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
uniform sampler2D uLightMapUp;
uniform vec2 uLightOriginUp;
uniform vec2 uLightSizeUp;
uniform sampler2D uLightMapDown;
uniform vec2 uLightOriginDown;
uniform vec2 uLightSizeDown;
uniform float uLevelZ;
uniform float uLightingEnabled;
uniform vec3 uAmbient;
varying float vUnlit;
varying vec4 vBox;
varying float vStack;
varying vec2 vWorldPx;`,
    )
    .replace(
      "#include <map_fragment>",
      /* glsl */ `#include <map_fragment>
// Everything below samples at the centre of the art pixel this fragment falls
// in, not at the fragment itself. A fragment is smaller than a texel once
// zoomed (16 of them per texel at 4x), so sampling per fragment lets a value
// vary *inside* a pixel — which is how a smooth diagonal seam or a smooth
// light gradient ends up drawn across art that should be flat per pixel.
vec2 depthPx = floor(vWorldPx) + 0.5;
// Where the ray leaves the box: each visible (south/east/top) face caps how far
// it climbs before getting out, so the highest point inside is the min.
float eastFace = (vBox.x - depthPx.x) / ${glsl(PX_PER_HEIGHT)};
float southFace = (vBox.y - depthPx.y) / ${glsl(PX_PER_HEIGHT)};
float exitElev = min(min(eastFace, southFace), vBox.w);
// The far (north/west) faces, one cell of ray climb behind the near ones.
float farFaceElev =
  max(eastFace, southFace) - ${glsl(HEIGHT_PER_LEVEL)};
// Far face above exit means the ray missed up-left: art hanging over the cells
// behind it, with no surface of its own. It takes the far-face plane, which is
// where the neighbour's face already is, plus a nudge that settles that tie for
// the art. Missing the other way (under the foot) is art hanging over ground
// nearer the camera, which must stay behind it — foot plane, no nudge. See
// boxSurface.
float surfaceElev = max(max(exitElev, farFaceElev), vBox.z);
float overhangBias =
  farFaceElev > exitElev ? ${glsl(DEPTH_OVERHANG_BIAS)} : 0.0;
if (uLightingEnabled > 0.5 && vUnlit < 0.5) {
  // Light the world point this fragment depicts, which the depth pass has
  // already found: the pixel it lands on plus the elevation of the surface
  // seen there. Inverting the projection off that pair recovers the cell,
  // so light follows the wall the art is drawing rather than the rectangle
  // the art was authored in — no reset at each sprite's edge.
  //
  // A surface reads its own cell. A solid one holds no light of its own, but
  // the bake has already handed it the brightest of the cells its visible
  // faces look into, so the field is continuous across the solid/air boundary
  // and a wall shades by cell rather than by face — hunting for lit air here
  // instead lit each face off a different neighbour, and the wall came out
  // looking patched together.
  //
  // A top face is the exception: what lights it is the air standing on it, so
  // it steps up half a level. That is nothing for a floor, whose own cell is
  // that air already, and a full level for a block, whose is the cell above.
  float topFace =
    farFaceElev <= exitElev && vBox.w <= eastFace && vBox.w <= southFace
      ? 0.5
      : 0.0;
  vec2 lightCell =
    (depthPx + surfaceElev * ${glsl(PX_PER_HEIGHT)}) / ${glsl(CELL_SIZE)};
  // A cell's light belongs at the middle of its own slab, which is what keeps a
  // stack of blocks from sawtoothing: the middle of each face reads its
  // neighbouring cell outright, and the seams between blocks are the halfway
  // blends between one cell and the next. Anchoring at the slab floor instead
  // made every face climb a whole level and snap back at the block above it.
  float levelsFromSlab =
    surfaceElev / ${glsl(HEIGHT_PER_LEVEL)} - 0.5 + topFace - uLevelZ;
  // RGB is block light, alpha is the sky factor, so the tint happens here
  // rather than on the CPU. Alpha 0 means "already composed" — a caller that
  // tints its own texture uploads it that way and this reduces to a passthrough.
  vec4 own = texture2D(uLightMap, (lightCell - uLightOrigin) / uLightSize);
  vec4 up = texture2D(uLightMapUp, (lightCell - uLightOriginUp) / uLightSizeUp);
  vec4 down =
    texture2D(uLightMapDown, (lightCell - uLightOriginDown) / uLightSizeDown);
  vec4 lightTexel = mix(
    own,
    levelsFromSlab < 0.0 ? down : up,
    clamp(abs(levelsFromSlab), 0.0, 1.0)
  );
  vec3 light = min(vec3(1.0), lightTexel.a * uAmbient + lightTexel.rgb);
  diffuseColor.rgb *= light;
}
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
