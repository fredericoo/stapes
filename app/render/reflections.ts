import * as THREE from "three";
import { PX_PER_HEIGHT, absoluteElevation } from "../lib/geometry";
import {
  chunkKeyFor,
  elevationAfter,
  footElevation,
  getChunk,
  listChunkKeys,
} from "../lib/mapData";
import {
  CELL_SIZE,
  DEFAULT_REFLECTION_FADE_PX,
  DEFAULT_REFLECTION_OPACITY,
  MAX_REFLECTIVE_COLORS,
  coordKey,
  facingKeysFor,
  isDirectional,
  spriteRect,
  type Frame,
  type MapFile,
  type Octant,
  type OverrideSpriteState,
  type SpriteState,
  type TileDef,
  type TilesetDef,
} from "../lib/types";
import { resolveTileSprite } from "../lib/tileResolve";
import { ANIM_GLSL_FUNCTION } from "./animTable";
import type { LevelAnimUniforms } from "./worldQuads";

export const MAX_REFLECTIVE_TILES = 8;

/**
 * How many cells north and west of a reflective cell a thing can stand and
 * still land its reflection on it. A reflection hangs down and right from the
 * thing's foot by its own height, so this is the tallest art in cells.
 */
export const REFLECTION_REACH_CELLS = 3;
/** A sprite flipped about its foot reaches one cell back the other way too. */
const REFLECTION_BACK_REACH_CELLS = 1;
/**
 * How many levels down a thing looks for water to stand over: an upper storey
 * or a roof reflects in the pond its ground floor stands beside.
 */
export const REFLECTION_LEVELS_BELOW = 3;

/**
 * The world px of `x + y` either side of the camera that the reflection pass
 * can order by depth. A thing further south-east stands nearer the viewer.
 */
const REFLECTION_DEPTH_SPAN_PX = 32768;

/**
 * A reflection texel packs three things into RGBA8. The top six bits of each
 * channel are the sRGB colour. The low two bits of r, g and b together name the
 * waterline in half heights modulo 64, so water on another level that shares
 * the screen pixel ignores it. Alpha is the art pixel's height above the
 * waterline plus one, so zero means nothing is reflected there.
 */
const REFLECTION_PACKING_GLSL = `
float waterlineTag(float elev) {
  return mod(floor(elev * 2.0 + 0.5), 64.0);
}
vec4 packReflection(vec3 srgb, float elev, float heightPx) {
  vec3 colour = floor(clamp(srgb, 0.0, 1.0) * 63.0 + 0.5) * 4.0;
  float tag = waterlineTag(elev);
  vec3 tagBits = vec3(floor(tag / 16.0), mod(floor(tag / 4.0), 4.0), mod(tag, 4.0));
  return vec4(colour + tagBits, clamp(heightPx, 0.0, 254.0) + 1.0) / 255.0;
}
`;

const UNPACK_REFLECTION_GLSL = `
float unpackedWaterlineTag(vec3 bytes) {
  vec3 bits = mod(bytes, 4.0);
  return bits.r * 16.0 + bits.g * 4.0 + bits.b;
}
`;

/** Squared sRGB distance under which a texel counts as one of the mask colours. */
const MASK_TOLERANCE_SQ = 1e-4;
/** Radians of wobble phase per art pixel row: about two rows per ripple at this rate. */
const RIPPLE_RADIANS_PER_ROW = 1.7;
const RIPPLE_RADIANS_PER_MS = 0.004;

export type ReflectionUniforms = {
  uReflectMap: { value: THREE.Texture | null };
  uReflectSize: { value: THREE.Vector2 };
  uReflectFragPerPx: { value: number };
  uReflectClockMs: { value: number };
  uReflectMask: { value: THREE.Vector3[] };
  uReflectOpacity: { value: number[] };
  uReflectFadePx: { value: number[] };
  uReflectTurbulence: { value: number[] };
};

export function createReflectionUniforms(): ReflectionUniforms {
  return {
    uReflectMap: { value: null },
    uReflectSize: { value: new THREE.Vector2(1, 1) },
    uReflectFragPerPx: { value: 1 },
    uReflectClockMs: { value: 0 },
    uReflectMask: {
      value: Array.from(
        { length: MAX_REFLECTIVE_TILES * MAX_REFLECTIVE_COLORS },
        () => new THREE.Vector3(-1, -1, -1),
      ),
    },
    uReflectOpacity: { value: new Array<number>(MAX_REFLECTIVE_TILES).fill(0) },
    uReflectFadePx: { value: new Array<number>(MAX_REFLECTIVE_TILES).fill(1) },
    uReflectTurbulence: { value: new Array<number>(MAX_REFLECTIVE_TILES).fill(0) },
  };
}

export const NO_REFLECTION_UNIFORMS = createReflectionUniforms();

/**
 * One-based, so a quad's `aReflect` of zero (also what an absent attribute
 * reads as) means "not reflective". Sorted by id so the numbering does not
 * depend on catalogue order.
 */
export function reflectiveTileIndex(tilesById: Record<string, TileDef>): Map<string, number> {
  const ids = Object.values(tilesById)
    .filter((def) => def.reflective && def.reflective.colors.length > 0)
    .map((def) => def.id)
    .sort();
  const index = new Map<string, number>();
  for (const id of ids.slice(0, MAX_REFLECTIVE_TILES)) index.set(id, index.size + 1);
  return index;
}

export function writeReflectionDefs(
  uniforms: ReflectionUniforms,
  tilesById: Record<string, TileDef>,
  index: ReadonlyMap<string, number>,
): void {
  for (const v of uniforms.uReflectMask.value) v.set(-1, -1, -1);
  for (const [id, n] of index) {
    const reflective = tilesById[id]?.reflective;
    if (!reflective) continue;
    const slot = n - 1;
    const colors = reflective.colors.slice(0, MAX_REFLECTIVE_COLORS);
    colors.forEach((hex, i) => {
      const c = new THREE.Color(hex);
      c.convertLinearToSRGB();
      uniforms.uReflectMask.value[slot * MAX_REFLECTIVE_COLORS + i]!.set(c.r, c.g, c.b);
    });
    uniforms.uReflectOpacity.value[slot] = reflective.opacity ?? DEFAULT_REFLECTION_OPACITY;
    uniforms.uReflectFadePx.value[slot] = Math.max(
      1,
      reflective.fadePx ?? DEFAULT_REFLECTION_FADE_PX,
    );
    uniforms.uReflectTurbulence.value[slot] = reflective.turbulence;
  }
}

export const REFLECT_GLSL_VERTEX_COMMON = `
attribute float aReflect;
varying float vReflect;
`;

export const REFLECT_GLSL_VERTEX = `
vReflect = aReflect;
`;

export const REFLECT_GLSL_COMMON = `
uniform sampler2D uReflectMap;
uniform vec2 uReflectSize;
uniform float uReflectFragPerPx;
uniform float uReflectClockMs;
uniform vec3 uReflectMask[${MAX_REFLECTIVE_TILES * MAX_REFLECTIVE_COLORS}];
uniform float uReflectOpacity[${MAX_REFLECTIVE_TILES}];
uniform float uReflectFadePx[${MAX_REFLECTIVE_TILES}];
uniform float uReflectTurbulence[${MAX_REFLECTIVE_TILES}];
varying float vReflect;
${REFLECTION_PACKING_GLSL}
${UNPACK_REFLECTION_GLSL}
`;

/**
 * Runs before lighting, so a reflection is lit (and darkened at night) like the
 * water it lies on. It reads the art pixel's centre, shifted a whole number of
 * art pixels per row, so a ripple moves the reflection in steps of the art grid.
 * The reflection fades out linearly over `fadePx` art pixels above the
 * waterline, and its sRGB colour is decoded before the linear blend.
 */
export const REFLECT_GLSL_FRAGMENT = `
#ifdef USE_MAP
if (vReflect > 0.5) {
  int reflectSlot = int(vReflect - 0.5);
  vec3 reflectTexel = sRGBTransferOETF(sampledDiffuseColor).rgb;
  bool mirrors = false;
  for (int i = 0; i < ${MAX_REFLECTIVE_COLORS}; i++) {
    vec3 d = reflectTexel - uReflectMask[reflectSlot * ${MAX_REFLECTIVE_COLORS} + i];
    if (dot(d, d) < ${MASK_TOLERANCE_SQ.toExponential()}) mirrors = true;
  }
  if (mirrors) {
    float row = floor(vWorldPx.y);
    float shiftPx = floor(
      uReflectTurbulence[reflectSlot] *
        sin(row * ${RIPPLE_RADIANS_PER_ROW} + uReflectClockMs * ${RIPPLE_RADIANS_PER_MS}) +
        0.5
    );
    vec2 artPx = floor(vWorldPx) + 0.5 + vec2(shiftPx, 0.0);
    // World y runs down the screen and gl_FragCoord.y runs up it.
    vec2 frag = gl_FragCoord.xy + (artPx - vWorldPx) * vec2(uReflectFragPerPx, -uReflectFragPerPx);
    vec4 bytes = floor(texture2D(uReflectMap, frag / uReflectSize) * 255.0 + 0.5);
    if (bytes.a > 0.5 && unpackedWaterlineTag(bytes.rgb) == waterlineTag(vBox.z)) {
      vec3 srgb = floor(bytes.rgb / 4.0) / 63.0;
      vec3 reflectedLinear = sRGBTransferEOTF(vec4(srgb, 1.0)).rgb;
      float fade = clamp(1.0 - (bytes.a - 1.0) / uReflectFadePx[reflectSlot], 0.0, 1.0);
      diffuseColor.rgb = mix(diffuseColor.rgb, reflectedLinear, uReflectOpacity[reflectSlot] * fade);
    }
  }
}
#endif
`;

/** An `aPivot.z` below which nothing is cut: the reflection runs its full length. */
export const NO_REFLECTION_CUT = 1e9;

/**
 * Draws a sprite turned half a turn about `aPivot.xy` (the centre of its base
 * cell at the waterline, in model space) into the reflection target in its own
 * colours, packed with its waterline `aPivot.w` and height above it (see
 * `REFLECTION_PACKING_GLSL`). Below `aPivot.z` (model space y) it is cut off
 * flat. A wading body is turned as it is drawn, sunk and cropped, about the
 * same pivot it would have on dry ground. `aMirrorUv` moves a body's art to its
 * opposite facing, so the half turn leaves it facing the way it does on land.
 */
export function createReflectionMaterial(
  texture: THREE.Texture,
  anim: LevelAnimUniforms,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: texture }, ...anim },
    vertexShader: `
attribute vec4 aPivot;
attribute vec2 aAnim;
attribute vec4 aBox;
attribute vec2 aWade;
attribute vec2 aMirrorUv;
varying vec2 vUv;
varying vec2 vSourcePx;
varying vec2 vFeetPx;
varying float vWading;
varying float vReflectedY;
varying float vCutY;
varying float vWaterline;
varying float vPivotY;
${ANIM_GLSL_FUNCTION}
void main() {
  vUv = uv + aMirrorUv;
  if (uAnimEnabled > 0.5 && aAnim.x >= 0.0) {
    vUv += animFrameOffset(aAnim.x, uAnimClockMs + aAnim.y);
  }
  vec2 world = (modelMatrix * vec4(position, 1.0)).xy;
  vec2 pivot = (modelMatrix * vec4(aPivot.xy, 0.0, 1.0)).xy;
  vCutY = (modelMatrix * vec4(0.0, aPivot.z, 0.0, 1.0)).y;
  vWading = aWade.y > 0.0 ? 1.0 : 0.0;
  // The same feet the world shader measures its wade cut from.
  vFeetPx = aBox.xy - ${glsl(CELL_SIZE / 2)} - aBox.z * ${glsl(PX_PER_HEIGHT)} + aWade.x;
  // The mesh is offset by the wade sink, and the pivot with it; the pivot stays on the cell.
  pivot -= aWade.x;
  vSourcePx = world;
  vec2 reflected = 2.0 * pivot - world;
  vReflectedY = reflected.y;
  vWaterline = aPivot.w;
  vPivotY = pivot.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(reflected, 0.0, 1.0);
  // The camera is orthographic, so w is 1 and this is the NDC depth: nearer the viewer is lower.
  float nearness = aBox.x + aBox.y + aBox.z * 0.5 - cameraPosition.x - cameraPosition.y;
  gl_Position.z = clamp(-nearness / ${glsl(REFLECTION_DEPTH_SPAN_PX)}, -1.0, 1.0);
}`,
    fragmentShader: `
uniform sampler2D map;
varying vec2 vUv;
varying vec2 vSourcePx;
varying vec2 vFeetPx;
varying float vWading;
varying float vReflectedY;
varying float vCutY;
varying float vWaterline;
varying float vPivotY;
${REFLECTION_PACKING_GLSL}
void main() {
  if (vReflectedY > vCutY) discard;
  if (vWading > 0.5) {
    vec2 fromFeet = vFeetPx - (floor(vSourcePx) + 0.5);
    if (min(fromFeet.x, fromFeet.y) < 1.0) discard;
  }
  vec4 texel = texture2D(map, vUv);
  if (texel.a < 0.5) discard;
  vec3 srgb = sRGBTransferOETF(vec4(texel.rgb, 1.0)).rgb;
  float heightPx = floor(vPivotY - floor(vSourcePx.y));
  gl_FragColor = packReflection(srgb, vWaterline, heightPx);
}`,
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: true,
    transparent: false,
  });
}

const HORIZONTAL_MIRROR: Record<Octant, Octant> = {
  n: "n",
  ne: "nw",
  e: "w",
  se: "sw",
  s: "s",
  sw: "se",
  w: "e",
  nw: "ne",
};

const mirrorFramesByDef = new WeakMap<TileDef, Map<Frame, Frame>>();

/**
 * Each frame of a directional tile paired with the same frame of its
 * left-right opposite facing, in every state. Only the facings the tile type
 * has are walked: a four-way tile's diagonals fall back to cardinals that are
 * not each other's mirror.
 */
function mirrorFrames(def: TileDef): Map<Frame, Frame> {
  let pairs = mirrorFramesByDef.get(def);
  if (pairs) return pairs;
  pairs = new Map();
  if (isDirectional(def)) {
    const states: SpriteState[] = [
      "idle",
      ...(Object.keys(def.states ?? {}) as OverrideSpriteState[]),
    ];
    for (const state of states) {
      for (const direction of facingKeysFor(def)) {
        const own = resolveTileSprite(def, { state, direction })?.frames;
        const opposite = resolveTileSprite(def, {
          state,
          direction: HORIZONTAL_MIRROR[direction],
        })?.frames;
        if (!own?.length || !opposite?.length || own === opposite) continue;
        own.forEach((frame, i) => {
          if (!pairs!.has(frame)) pairs!.set(frame, opposite[i % opposite.length]!);
        });
      }
    }
  }
  mirrorFramesByDef.set(def, pairs);
  return pairs;
}

/**
 * The uv offset from `frame` to its left-right opposite facing's frame, which
 * the half turn turns back round so a body's reflection faces the way it does.
 * Zero when there is no opposite, or it is drawn at another size or base.
 */
export function mirrorUvShift(def: TileDef, frame: Frame, tileset: TilesetDef): [number, number] {
  const opposite = mirrorFrames(def).get(frame);
  if (!opposite) return [0, 0];
  const own = spriteRect(def.anchor, frame.sprite);
  const other = spriteRect(def.anchor, opposite.sprite);
  const sameBase =
    frame.sprite.base.x === opposite.sprite.base.x &&
    frame.sprite.base.y === opposite.sprite.base.y;
  if (own.w !== other.w || own.h !== other.h || !sameBase) return [0, 0];
  return [
    ((other.x - own.x) * CELL_SIZE) / tileset.width,
    ((own.y - other.y) * CELL_SIZE) / tileset.height,
  ];
}

export function writeMirrorUvAttr(geo: THREE.BufferGeometry, shift: readonly [number, number]) {
  const verts = geo.getAttribute("position").count;
  const existing = geo.getAttribute("aMirrorUv") as THREE.BufferAttribute | undefined;
  const attr = existing ?? new THREE.BufferAttribute(new Float32Array(verts * 2), 2);
  for (let v = 0; v < verts; v++) attr.setXY(v, shift[0], shift[1]);
  attr.needsUpdate = true;
  if (!existing) geo.setAttribute("aMirrorUv", attr);
}

/**
 * Where a sprite standing with its foot at `footElev` is pivoted so its
 * reflection hangs from the waterline: the foot drawn at the water's height.
 */
export function waterlinePivot(
  pivot: { x: number; y: number },
  footElev: number,
  waterElev: number,
): { x: number; y: number } {
  const lift = (footElev - waterElev) * PX_PER_HEIGHT;
  return { x: pivot.x + lift, y: pivot.y + lift };
}

export type ReflectionPivot = { x: number; y: number; cutY: number; waterElev: number };

export function writePivotAttr(
  geo: THREE.BufferGeometry,
  pivots: readonly ReflectionPivot[],
): void {
  const verts = geo.getAttribute("position").count;
  const perQuad = verts / pivots.length;
  const arr = new Float32Array(verts * PIVOT_COMPONENTS);
  pivots.forEach((p, q) => {
    for (let v = 0; v < perQuad; v++) {
      const o = (q * perQuad + v) * PIVOT_COMPONENTS;
      arr[o] = p.x;
      arr[o + 1] = p.y;
      arr[o + 2] = p.cutY;
      arr[o + 3] = p.waterElev;
    }
  });
  geo.setAttribute("aPivot", new THREE.BufferAttribute(arr, PIVOT_COMPONENTS));
}

const PIVOT_COMPONENTS = 4;

function glsl(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
}

/**
 * The reflective cells of each chunk with the absolute elevation of their
 * surface, cached on the chunk object: copy-on-write gives an edited chunk a
 * new identity, so a hit is always current.
 */
export class ReflectiveCells {
  private byChunk = new WeakMap<object, Map<string, number>>();

  constructor(
    private readonly tilesById: Record<string, TileDef>,
    private readonly index: ReadonlyMap<string, number>,
  ) {}

  get any(): boolean {
    return this.index.size > 0;
  }

  cellsIn(map: MapFile, z: number, chunk: string): ReadonlyMap<string, number> | undefined {
    const cells = getChunk(map, z, chunk);
    if (!cells) return undefined;
    let found = this.byChunk.get(cells);
    if (found) return found;
    found = new Map();
    for (const key in cells) {
      let elev = 0;
      for (const placed of cells[key]!) {
        const foot = footElevation(elev, placed);
        if (this.index.has(placed.tileId)) found.set(key, absoluteElevation(z, foot));
        elev = elevationAfter(elev, placed, this.tilesById);
      }
    }
    this.byChunk.set(cells, found);
    return found;
  }

  /** Whether any chunk a reflection from the chunk holding (x, y) could land on holds a reflective cell. */
  chunkNeighbourhoodReflects(map: MapFile, z: number, x: number, y: number, size: number) {
    for (let wz = z; wz >= z - REFLECTION_LEVELS_BELOW; wz--) {
      for (const [dx, dy] of NEIGHBOURHOOD) {
        const cells = this.cellsIn(map, wz, chunkKeyFor(x + dx * size, y + dy * size));
        if (cells && cells.size > 0) return true;
      }
    }
    return false;
  }

  /**
   * The chunks of level `z` whose reflective cells differ between two maps.
   * Whatever reflects in them may stand in a neighbouring chunk or a storey
   * above, which nothing else would rebuild.
   */
  changedChunks(prev: MapFile, next: MapFile, z: number): string[] {
    if (!this.any) return [];
    const keys = new Set([...listChunkKeys(prev, z), ...listChunkKeys(next, z)]);
    const changed: string[] = [];
    for (const chunk of keys) {
      if (getChunk(prev, z, chunk) === getChunk(next, z, chunk)) continue;
      if (!sameCells(this.cellsIn(prev, z, chunk), this.cellsIn(next, z, chunk))) {
        changed.push(chunk);
      }
    }
    return changed;
  }

  /**
   * The surface elevation of the nearest reflective cell a thing at (x, y, z)
   * reflects onto: on its own level first, then on each level below it.
   */
  waterlineNear(map: MapFile, x: number, y: number, z: number): number | null {
    for (let wz = z; wz >= z - REFLECTION_LEVELS_BELOW; wz--) {
      const found = this.waterlineOnLevel(map, x, y, wz);
      if (found != null) return found;
    }
    return null;
  }

  private waterlineOnLevel(map: MapFile, x: number, y: number, z: number): number | null {
    let best: number | null = null;
    let bestDist = Infinity;
    for (let dy = -REFLECTION_BACK_REACH_CELLS; dy <= REFLECTION_REACH_CELLS; dy++) {
      for (let dx = -REFLECTION_BACK_REACH_CELLS; dx <= REFLECTION_REACH_CELLS; dx++) {
        const cx = x + dx;
        const cy = y + dy;
        const elev = this.cellsIn(map, z, chunkKeyFor(cx, cy))?.get(coordKey(cx, cy));
        if (elev == null) continue;
        const dist = Math.abs(dx) + Math.abs(dy);
        if (dist >= bestDist) continue;
        best = elev;
        bestDist = dist;
      }
    }
    return best;
  }
}

function sameCells(
  a: ReadonlyMap<string, number> | undefined,
  b: ReadonlyMap<string, number> | undefined,
): boolean {
  if ((a?.size ?? 0) !== (b?.size ?? 0)) return false;
  for (const [key, elev] of a ?? []) if (b?.get(key) !== elev) return false;
  return true;
}

export const NEIGHBOURHOOD: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [0, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];
