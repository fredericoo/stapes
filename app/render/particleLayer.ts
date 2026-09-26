import * as THREE from "three";
import { PX_PER_HEIGHT } from "../lib/geometry";
import {
  DEFAULT_PARTICLES,
  MAX_LIVE_PARTICLES,
  MAX_PARTICLE_RADIUS_PX,
  PARTICLE_SHAPE_PX,
  type ParticleShape,
  rampIndexAt,
  shapeHas,
} from "../lib/particleVfx";
import { CELL_SIZE } from "../lib/types";
import {
  type ParticleEmitterSpec,
  type ParticleReading,
  ParticleSystem,
  type Random,
} from "./particles";
import { noTintUniforms } from "./spriteTint";
import type { CellHidden } from "./tileEmitters";
import {
  injectWorldShader,
  noAnimUniforms,
  noCutUniforms,
  type LevelLightUniforms,
  WORLD_SHADER_CACHE_KEY,
} from "./worldQuads";

const CIRCLE_CELL_PX = MAX_PARTICLE_RADIUS_PX * 2 + 1;

const CIRCLE_STEPS = MAX_PARTICLE_RADIUS_PX + 1;

const ATLAS_W = CIRCLE_CELL_PX * CIRCLE_STEPS;

const SHAPES_PER_ROW = Math.floor(ATLAS_W / PARTICLE_SHAPE_PX);

const SHAPE_ROWS = 4;

export const SHAPE_SLOTS = SHAPES_PER_ROW * SHAPE_ROWS;

const ATLAS_H = CIRCLE_CELL_PX + SHAPE_ROWS * PARTICLE_SHAPE_PX;

const VERTS_PER_QUAD = 4;
const INDICES_PER_QUAD = 6;
const BOX_COMPONENTS = 4;
const COLOR_COMPONENTS = 4;

const PARTICLE_ALPHA_CUTOFF = 0.02;

const PARTICLE_RENDER_ORDER = 1;

export function createParticleAtlas(): THREE.DataTexture {
  const data = new Uint8Array(ATLAS_W * ATLAS_H * 4);
  for (let r = 0; r < CIRCLE_STEPS; r++) {
    const cellX = r * CIRCLE_CELL_PX;
    for (let py = 0; py < CIRCLE_CELL_PX; py++) {
      for (let px = 0; px < CIRCLE_CELL_PX; px++) {
        const dx = px - MAX_PARTICLE_RADIUS_PX;
        const dy = py - MAX_PARTICLE_RADIUS_PX;
        /**
         * `<= r*r` rather than a fudged radius: `(r + 0.5)^2` makes radius 1 a
         * 3x3 square instead of a circle. This gives a plus at 1 and a proper
         * rounded blob from 2 up.
         */
        const inside = dx * dx + dy * dy <= r * r;
        const o = (py * ATLAS_W + cellX + px) * 4;
        data[o] = 255;
        data[o + 1] = 255;
        data[o + 2] = 255;
        data[o + 3] = inside ? 255 : 0;
      }
    }
  }
  const tex = new THREE.DataTexture(data, ATLAS_W, ATLAS_H, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function circleSlice(radius: number): {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  sizePx: number;
} {
  const r = Math.max(0, Math.min(MAX_PARTICLE_RADIUS_PX, Math.round(radius)));
  const sizePx = r * 2 + 1;
  const x0 = r * CIRCLE_CELL_PX + (MAX_PARTICLE_RADIUS_PX - r);
  const y0 = MAX_PARTICLE_RADIUS_PX - r;
  return {
    u0: x0 / ATLAS_W,
    u1: (x0 + sizePx) / ATLAS_W,
    v0: y0 / ATLAS_H,
    v1: (y0 + sizePx) / ATLAS_H,
    sizePx,
  };
}

function shapeCellOrigin(slot: number): { x: number; row: number } {
  return {
    x: (slot % SHAPES_PER_ROW) * PARTICLE_SHAPE_PX,
    row: CIRCLE_CELL_PX + Math.floor(slot / SHAPES_PER_ROW) * PARTICLE_SHAPE_PX,
  };
}

export function shapeSlice(slot: number): {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  sizePx: number;
} {
  const { x, row } = shapeCellOrigin(slot);
  return {
    u0: x / ATLAS_W,
    u1: (x + PARTICLE_SHAPE_PX) / ATLAS_W,
    v0: row / ATLAS_H,
    v1: (row + PARTICLE_SHAPE_PX) / ATLAS_H,
    sizePx: PARTICLE_SHAPE_PX,
  };
}

export function writeShapeCell(data: Uint8Array, slot: number, shape: ParticleShape) {
  const { x, row } = shapeCellOrigin(slot);
  for (let y = 0; y < PARTICLE_SHAPE_PX; y++) {
    const dataRow = row + PARTICLE_SHAPE_PX - 1 - y;
    for (let px = 0; px < PARTICLE_SHAPE_PX; px++) {
      const o = (dataRow * ATLAS_W + x + px) * 4;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = shapeHas(shape, px, y) ? 255 : 0;
    }
  }
}

export function particleWorldPx(cell: number, elevAbs: number): number {
  return cell * CELL_SIZE - PX_PER_HEIGHT * elevAbs;
}

export class ParticleLayer {
  readonly system: ParticleSystem;
  readonly mesh: THREE.Mesh;

  private readonly geometry: THREE.BufferGeometry;
  private readonly atlas: THREE.DataTexture;
  private readonly lightUniformsFor: (z: number) => LevelLightUniforms;
  private readonly materials = new Map<number, THREE.MeshBasicMaterial>();
  private levels: number[] = [];

  private readonly positions = new Float32Array(MAX_LIVE_PARTICLES * VERTS_PER_QUAD * 3);
  private readonly uvs = new Float32Array(MAX_LIVE_PARTICLES * VERTS_PER_QUAD * 2);
  private readonly boxes = new Float32Array(MAX_LIVE_PARTICLES * VERTS_PER_QUAD * BOX_COMPONENTS);
  private readonly stacks = new Float32Array(MAX_LIVE_PARTICLES * VERTS_PER_QUAD);
  private readonly colors = new Float32Array(
    MAX_LIVE_PARTICLES * VERTS_PER_QUAD * COLOR_COMPONENTS,
  );
  private readonly unlit = new Float32Array(MAX_LIVE_PARTICLES * VERTS_PER_QUAD);
  private readonly lightUvs = new Float32Array(MAX_LIVE_PARTICLES * VERTS_PER_QUAD * 2);
  private readonly lightScales = new Float32Array(MAX_LIVE_PARTICLES * VERTS_PER_QUAD * 2);

  private readonly buckets = new Map<number, number[]>();

  private readonly hiddenSpecs = new Map<ParticleEmitterSpec, boolean>();

  private readonly shapeSlots = new Map<string, number>();

  private readonly shapeKeys = new WeakMap<ParticleShape, string>();

  private readonly reading: ParticleReading = {
    x: 0,
    y: 0,
    elev: 0,
    life: 0,
    config: DEFAULT_PARTICLES,
    ramp: new Float32Array(0),
    z: 0,
    box: { eastPx: 0, southPx: 0, foot: 0, top: 0 },
    stackBias: 0,
    taper: 1,
  };

  constructor(lightUniformsFor: (z: number) => LevelLightUniforms, random?: Random) {
    this.system = new ParticleSystem(random);
    this.lightUniformsFor = lightUniformsFor;
    this.atlas = createParticleAtlas();
    this.geometry = this.buildGeometry();

    this.mesh = new THREE.Mesh(this.geometry, []);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    this.mesh.renderOrder = PARTICLE_RENDER_ORDER;
    this.mesh.visible = false;
  }

  private materialFor(z: number): THREE.MeshBasicMaterial {
    const existing = this.materials.get(z);
    if (existing) return existing;

    const material = new THREE.MeshBasicMaterial({
      map: this.atlas,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      alphaTest: PARTICLE_ALPHA_CUTOFF,
    });
    const lightUniforms = this.lightUniformsFor(z);
    material.onBeforeCompile = (shader) => {
      injectWorldShader(
        shader,
        lightUniforms,
        noTintUniforms(),
        noCutUniforms(this.atlas),
        noAnimUniforms(this.atlas),
      );
      injectParticleShader(shader);
    };
    material.customProgramCacheKey = () => PARTICLE_SHADER_CACHE_KEY;
    this.materials.set(z, material);
    return material;
  }

  setEmitters(specs: readonly ParticleEmitterSpec[]) {
    this.system.setEmitters(specs);
  }

  update(dtMs: number, hidden: CellHidden | undefined): boolean {
    this.system.advance(dtMs);
    const drawn = this.writeQuads(hidden);
    this.mesh.visible = drawn > 0;
    return drawn > 0;
  }

  get active(): boolean {
    return this.system.count > 0 || this.system.emitterCount > 0;
  }

  dispose() {
    this.geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
    this.atlas.dispose();
    this.system.clear();
  }

  private writeQuads(hidden: CellHidden | undefined): number {
    for (const bucket of this.buckets.values()) bucket.length = 0;
    if (this.shapeSlots.size >= SHAPE_SLOTS) this.shapeSlots.clear();
    this.hiddenSpecs.clear();

    for (let i = 0; i < this.system.count; i++) {
      const spec = this.system.specAt(i);
      const z = spec.z;
      if (hidden) {
        let isHidden = this.hiddenSpecs.get(spec);
        if (isHidden === undefined) {
          isHidden = hidden(Math.floor(spec.cx), Math.floor(spec.cy), z);
          this.hiddenSpecs.set(spec, isHidden);
        }
        if (isHidden) continue;
      }
      let bucket = this.buckets.get(z);
      if (!bucket) {
        bucket = [];
        this.buckets.set(z, bucket);
      }
      bucket.push(i);
    }

    this.geometry.clearGroups();
    this.levels.length = 0;
    let quad = 0;

    for (const [z, bucket] of this.buckets) {
      if (bucket.length === 0) continue;
      const groupStart = quad * INDICES_PER_QUAD;
      for (const index of bucket) {
        if (this.writeQuad(index, quad)) quad++;
      }
      const written = quad * INDICES_PER_QUAD - groupStart;
      if (written === 0) continue;
      this.geometry.addGroup(groupStart, written, this.levels.length);
      this.levels.push(z);
    }

    this.mesh.material = this.levels.map((z) => this.materialFor(z));
    if (quad > 0) this.flushAttributes(quad);
    return quad;
  }

  private writeQuad(index: number, quad: number): boolean {
    const p = this.system.read(index, this.reading);
    const life = p.life;
    const radius =
      (p.config.radiusFromPx + (p.config.radiusToPx - p.config.radiusFromPx) * life) * p.taper;
    const shapeSlot = p.config.shape ? this.shapeSlotFor(p.config.shape) : null;
    const slice = shapeSlot === null ? circleSlice(radius) : shapeSlice(shapeSlot);
    const alpha = p.config.alphaFrom + (p.config.alphaTo - p.config.alphaFrom) * life;
    if (alpha <= PARTICLE_ALPHA_CUTOFF) return false;

    const half = (slice.sizePx - 1) / 2;
    const cx = Math.round(particleWorldPx(p.x, p.elev));
    const cy = Math.round(particleWorldPx(p.y, p.elev));
    const x0 = cx - half;
    const y0 = cy - half;
    const x1 = x0 + slice.sizePx;
    const y1 = y0 + slice.sizePx;

    const rampBase = rampIndexAt(life) * 3;
    const r = p.ramp[rampBase] ?? 1;
    const g = p.ramp[rampBase + 1] ?? 1;
    const b = p.ramp[rampBase + 2] ?? 1;

    const lightCellX = Math.floor(p.x);
    const lightCellY = Math.floor(p.y);
    const unlit = p.config.lit ? 0 : 1;

    const pb = quad * VERTS_PER_QUAD * 3;
    this.positions[pb] = x0;
    this.positions[pb + 1] = y1;
    this.positions[pb + 3] = x1;
    this.positions[pb + 4] = y1;
    this.positions[pb + 6] = x0;
    this.positions[pb + 7] = y0;
    this.positions[pb + 9] = x1;
    this.positions[pb + 10] = y0;

    const ub = quad * VERTS_PER_QUAD * 2;
    this.uvs[ub] = slice.u0;
    this.uvs[ub + 1] = slice.v0;
    this.uvs[ub + 2] = slice.u1;
    this.uvs[ub + 3] = slice.v0;
    this.uvs[ub + 4] = slice.u0;
    this.uvs[ub + 5] = slice.v1;
    this.uvs[ub + 6] = slice.u1;
    this.uvs[ub + 7] = slice.v1;

    for (let v = 0; v < VERTS_PER_QUAD; v++) {
      const bb = (quad * VERTS_PER_QUAD + v) * BOX_COMPONENTS;
      this.boxes[bb] = p.box.eastPx;
      this.boxes[bb + 1] = p.box.southPx;
      this.boxes[bb + 2] = p.box.foot;
      this.boxes[bb + 3] = p.box.top;
      this.stacks[quad * VERTS_PER_QUAD + v] = p.stackBias;
      this.unlit[quad * VERTS_PER_QUAD + v] = unlit;

      const cb = (quad * VERTS_PER_QUAD + v) * COLOR_COMPONENTS;
      this.colors[cb] = r;
      this.colors[cb + 1] = g;
      this.colors[cb + 2] = b;
      this.colors[cb + 3] = alpha;

      const lb = (quad * VERTS_PER_QUAD + v) * 2;
      this.lightUvs[lb] = lightCellX;
      this.lightUvs[lb + 1] = lightCellY;
      this.lightScales[lb] = 0;
      this.lightScales[lb + 1] = 0;
    }

    return true;
  }

  private shapeSlotFor(shape: ParticleShape): number | null {
    let key = this.shapeKeys.get(shape);
    if (key === undefined) {
      key = shape.join("");
      this.shapeKeys.set(shape, key);
    }
    const known = this.shapeSlots.get(key);
    if (known !== undefined) return known;
    if (this.shapeSlots.size >= SHAPE_SLOTS) return null;

    const slot = this.shapeSlots.size;
    writeShapeCell(this.atlas.image.data as Uint8Array, slot, shape);
    this.atlas.needsUpdate = true;
    this.shapeSlots.set(key, slot);
    return slot;
  }

  private flushAttributes(quad: number) {
    const verts = quad * VERTS_PER_QUAD;
    const ranges: [string, number][] = [
      ["position", 3],
      ["uv", 2],
      ["aBox", BOX_COMPONENTS],
      ["aStack", 1],
      ["aParticleColor", COLOR_COMPONENTS],
      ["aUnlit", 1],
      ["aLightUv", 2],
      ["aLightScale", 2],
    ];
    for (const [name, components] of ranges) {
      const attr = this.geometry.getAttribute(name) as THREE.BufferAttribute;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, verts * components);
      attr.needsUpdate = true;
    }
  }

  private buildGeometry(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(this.uvs, 2));
    geo.setAttribute("aBox", new THREE.BufferAttribute(this.boxes, BOX_COMPONENTS));
    geo.setAttribute("aStack", new THREE.BufferAttribute(this.stacks, 1));
    geo.setAttribute("aParticleColor", new THREE.BufferAttribute(this.colors, COLOR_COMPONENTS));
    geo.setAttribute("aLightUv", new THREE.BufferAttribute(this.lightUvs, 2));
    geo.setAttribute("aLightScale", new THREE.BufferAttribute(this.lightScales, 2));
    geo.setAttribute("aUnlit", new THREE.BufferAttribute(this.unlit, 1));

    const indices = new Uint16Array(MAX_LIVE_PARTICLES * INDICES_PER_QUAD);
    for (let q = 0; q < MAX_LIVE_PARTICLES; q++) {
      const base = q * VERTS_PER_QUAD;
      const ib = q * INDICES_PER_QUAD;
      indices[ib] = base;
      indices[ib + 1] = base + 2;
      indices[ib + 2] = base + 1;
      indices[ib + 3] = base + 2;
      indices[ib + 4] = base + 3;
      indices[ib + 5] = base + 1;
    }
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    /**
     * Left wide open on purpose: a group does not replace the draw range, it
     * is intersected with it, so a range pinned to setDrawRange(0, 0) draws
     * nothing however many groups exist. The groups are what bounds the draw.
     */
    geo.setDrawRange(0, Infinity);
    return geo;
  }
}

const PARTICLE_SHADER_CACHE_KEY = `${WORLD_SHADER_CACHE_KEY}-particles-v1`;

/**
 * This must run after `injectWorldShader`. Both patch `#include <common>`,
 * and replacing an include that has already been replaced hits the copy at
 * the head of the previous patch's text, so running second is what puts
 * these declarations in front of the world shader's.
 */
function injectParticleShader(shader: { vertexShader: string; fragmentShader: string }) {
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      `#include <common>
attribute vec4 aParticleColor;
varying vec4 vParticleColor;`,
    )
    .replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
vParticleColor = aParticleColor;`,
    );

  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      `#include <common>
varying vec4 vParticleColor;`,
    )
    .replace(
      "#include <color_fragment>",
      `#include <color_fragment>
diffuseColor *= vParticleColor;`,
    );
}
