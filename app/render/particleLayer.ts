import * as THREE from "three";
import { PX_PER_HEIGHT } from "../lib/geometry";
import {
  DEFAULT_PARTICLES,
  MAX_LIVE_PARTICLES,
  MAX_PARTICLE_RADIUS_PX,
  rampIndexAt,
} from "../lib/particleVfx";
import { CELL_SIZE } from "../lib/types";
import {
  type ParticleEmitterSpec,
  type ParticleReading,
  ParticleSystem,
  type Random,
} from "./particles";
import { noTintUniforms } from "./spriteTint";
import {
  injectWorldShader,
  type LevelLightUniforms,
  WORLD_SHADER_CACHE_KEY,
} from "./worldQuads";

/**
 * Particles, on screen: one mesh, one draw call, rebuilt every frame.
 *
 * ## Circles, drawn rather than loaded
 *
 * A particle is a filled pixel circle, and every circle it can ever be is
 * rasterised once into {@link createCircleAtlas} at startup — one cell per
 * integer radius. No PNG, nothing to author, nothing to keep in step with the
 * art. A quad indexes the cell for its current radius, so growth over a
 * particle's life is a UV change and never a resample: a radius-3 circle is
 * *the* radius-3 circle at every zoom, which is the whole difference between
 * pixel art and a scaled sprite.
 *
 * Radii are integers because a circle between two pixel sizes does not exist.
 * {@link ParticleEmitterDef.radiusFromPx} is interpolated and then rounded, so a
 * particle growing from 1 to 3 visibly steps through 2 rather than smearing.
 *
 * ## Why one mesh and not one per plume
 *
 * Sorting is per fragment — every quad carries the depth box it should sort as —
 * so grouping decides nothing about draw order, and the cheapest grouping is
 * therefore the right one. A hundred sparks across six burning bodies is one
 * buffer and one draw.
 *
 * The buffers are allocated once at {@link MAX_LIVE_PARTICLES} and only the
 * prefix in use is uploaded (`addUpdateRange`) — a frame with four particles
 * pushes four quads across the bus, not two thousand.
 *
 * ## Depth, and the rule it implements
 *
 * Every particle of a plume takes **the plume's** box, not its own: the order of
 * a two-high tile standing on top of the affected stack. A spark that has drifted
 * a cell away still sorts where the fire is. That is deliberate and it is what
 * keeps a plume stable — boxes derived per particle would have sparks crossing
 * the sprite's own depth as they rose, and a fire that flickers *behind* the
 * thing on fire reads as a bug rather than as a fire.
 */

/** Widest cell in the atlas: a radius-`MAX` circle needs `2*MAX+1` pixels. */
const CIRCLE_CELL_PX = MAX_PARTICLE_RADIUS_PX * 2 + 1;

/** One cell per integer radius, zero included — a radius-0 circle is one pixel. */
const CIRCLE_STEPS = MAX_PARTICLE_RADIUS_PX + 1;

const ATLAS_W = CIRCLE_CELL_PX * CIRCLE_STEPS;
const ATLAS_H = CIRCLE_CELL_PX;

const VERTS_PER_QUAD = 4;
const INDICES_PER_QUAD = 6;
const BOX_COMPONENTS = 4;
const COLOR_COMPONENTS = 4;

/**
 * Alpha below which a particle fragment is thrown away.
 *
 * Doing most of the work: the atlas is a hard-edged mask, so this is what turns
 * the square quad into a circle. It also retires a particle a hair before it
 * reaches zero alpha, which is invisible and saves the blend.
 */
const PARTICLE_ALPHA_CUTOFF = 0.02;

/**
 * Drawn after every world sprite.
 *
 * World materials are all `transparent`, so they share a queue with this one and
 * three sorts that queue by render order first. Without this a plume could be
 * drawn before a sprite that has not yet written its depth, and depth-test
 * against a hole — a spark in front of a wall it is behind.
 */
const PARTICLE_RENDER_ORDER = 1;

/** A `PARTICLE_ALPHA_CUTOFF`-masked disc per integer radius, laid out in a row. */
export function createCircleAtlas(): THREE.DataTexture {
  const data = new Uint8Array(ATLAS_W * ATLAS_H * 4);
  for (let r = 0; r < CIRCLE_STEPS; r++) {
    const cellX = r * CIRCLE_CELL_PX;
    for (let py = 0; py < CIRCLE_CELL_PX; py++) {
      for (let px = 0; px < CIRCLE_CELL_PX; px++) {
        const dx = px - MAX_PARTICLE_RADIUS_PX;
        const dy = py - MAX_PARTICLE_RADIUS_PX;
        // `<= r*r` rather than a fudged radius, because the fudges are all
        // wrong at this size: `(r + 0.5)^2` makes radius 1 a 3x3 square, which
        // is not a circle, it is a block. This gives a plus at 1 and a proper
        // rounded blob from 2 up — the shapes a pixel artist would draw.
        const inside = dx * dx + dy * dy <= r * r;
        const o = ((py * ATLAS_W) + cellX + px) * 4;
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

/**
 * The atlas slice for one integer radius: `u0, v0, u1, v1` and the quad's side.
 *
 * The circle is cut tight rather than drawn as the whole cell, so a one-pixel
 * spark costs one pixel of fill instead of the 17×17 the widest one needs.
 */
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
    // Same flip the tileset quads use, so one convention covers every sheet.
    v0: 1 - (y0 + sizePx) / ATLAS_H,
    v1: 1 - y0 / ATLAS_H,
    sizePx,
  };
}

/**
 * World-pixel position of a point in the world, from an **absolute** elevation.
 *
 * The level term cancels: a level shifts a cell by `CELL_SIZE * z` and an
 * absolute elevation already carries `HEIGHT_PER_LEVEL * z` of that shift, and
 * `PX_PER_HEIGHT * HEIGHT_PER_LEVEL` *is* `CELL_SIZE`. So a particle needs no
 * level at all to be placed — which is exactly right for something that can rise
 * out of the storey it started in.
 */
export function particleWorldPx(
  cell: number,
  elevAbs: number,
): number {
  return cell * CELL_SIZE - PX_PER_HEIGHT * elevAbs;
}

export class ParticleLayer {
  readonly system: ParticleSystem;
  readonly mesh: THREE.Mesh;

  private readonly geometry: THREE.BufferGeometry;
  private readonly atlas: THREE.DataTexture;
  private readonly lightUniformsFor: (z: number) => LevelLightUniforms;
  /**
   * One material per level, made on the frame a plume first appears there.
   *
   * **The reason this is not a single material** is the light map: it is bound
   * per level, so a lit spark on the first storey drawn with the ground floor's
   * uniforms would be lit by a room it is not in. Unlit sparks do not care, but
   * splitting only the lit ones would mean two grouping rules where one does.
   *
   * In practice this is one entry: every plume on screen is usually on the level
   * the player is standing on.
   */
  private readonly materials = new Map<number, THREE.MeshBasicMaterial>();
  /** Levels drawn this frame, in the order their groups appear. */
  private levels: number[] = [];

  private readonly positions = new Float32Array(
    MAX_LIVE_PARTICLES * VERTS_PER_QUAD * 3,
  );
  private readonly uvs = new Float32Array(
    MAX_LIVE_PARTICLES * VERTS_PER_QUAD * 2,
  );
  private readonly boxes = new Float32Array(
    MAX_LIVE_PARTICLES * VERTS_PER_QUAD * BOX_COMPONENTS,
  );
  private readonly stacks = new Float32Array(
    MAX_LIVE_PARTICLES * VERTS_PER_QUAD,
  );
  private readonly colors = new Float32Array(
    MAX_LIVE_PARTICLES * VERTS_PER_QUAD * COLOR_COMPONENTS,
  );
  /** 1 for a spark that lights itself, 0 for one the room lights. */
  private readonly unlit = new Float32Array(
    MAX_LIVE_PARTICLES * VERTS_PER_QUAD,
  );
  /**
   * Where each particle samples the light map, in cell space.
   *
   * All four corners of a quad get the same value and {@link lightScales} stays
   * zero, so a particle takes one flat sample rather than a gradient — it is a
   * pixel or two across, which is far smaller than the cell it is being lit by.
   */
  private readonly lightUvs = new Float32Array(
    MAX_LIVE_PARTICLES * VERTS_PER_QUAD * 2,
  );
  private readonly lightScales = new Float32Array(
    MAX_LIVE_PARTICLES * VERTS_PER_QUAD * 2,
  );

  /**
   * Live particle indices, bucketed by the level they belong to.
   *
   * Held and cleared rather than rebuilt, because this runs every frame and the
   * arrays are the only thing here that would otherwise be garbage. Quads have
   * to be written level by level so each level's run of indices is contiguous
   * and can be one geometry group.
   */
  private readonly buckets = new Map<number, number[]>();

  /** Reused across every particle of every frame. @see ParticleSystem.read */
  private readonly reading: ParticleReading = {
    x: 0,
    y: 0,
    elev: 0,
    life: 0,
    // Overwritten on the first read; a real config rather than a cast, so
    // nothing here can be the thing that puts undefined into a buffer.
    config: DEFAULT_PARTICLES,
    ramp: new Float32Array(0),
    z: 0,
    box: { eastPx: 0, southPx: 0, foot: 0, top: 0 },
    stackBias: 0,
    taper: 1,
  };

  /**
   * @param lightUniformsFor The level's light uniforms, asked for per level
   * rather than handed over once — a plume can appear on any storey, and the
   * caller is the only thing that knows how a level's light is bound.
   */
  constructor(
    lightUniformsFor: (z: number) => LevelLightUniforms,
    random?: Random,
  ) {
    this.system = new ParticleSystem(random);
    this.lightUniformsFor = lightUniformsFor;
    this.atlas = createCircleAtlas();
    this.geometry = this.buildGeometry();

    this.mesh = new THREE.Mesh(this.geometry, []);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    this.mesh.renderOrder = PARTICLE_RENDER_ORDER;
    this.mesh.visible = false;
  }

  /**
   * The material a plume on this level is drawn with.
   *
   * The same depth machinery every sprite goes through — a particle sorts by the
   * box it carries, exactly as a tile does — and the same per-level light map,
   * so a lit spark is lit by the room it is actually in.
   */
  private materialFor(z: number): THREE.MeshBasicMaterial {
    const existing = this.materials.get(z);
    if (existing) return existing;

    const material = new THREE.MeshBasicMaterial({
      map: this.atlas,
      side: THREE.DoubleSide,
      transparent: true,
      // Tested against the world so a wall in front hides a spark, but never
      // written, so two sparks in a plume do not carve each other up.
      depthWrite: false,
      depthTest: true,
      alphaTest: PARTICLE_ALPHA_CUTOFF,
    });
    const lightUniforms = this.lightUniformsFor(z);
    material.onBeforeCompile = (shader) => {
      injectWorldShader(shader, lightUniforms, noTintUniforms());
      injectParticleShader(shader);
    };
    material.customProgramCacheKey = () => PARTICLE_SHADER_CACHE_KEY;
    this.materials.set(z, material);
    return material;
  }

  /** @see ParticleSystem.setEmitters */
  setEmitters(specs: readonly ParticleEmitterSpec[]) {
    this.system.setEmitters(specs);
  }

  /** Advance the plumes and rewrite the buffers. True when anything is drawn. */
  update(dtMs: number, hideLevelsAbove: number | undefined): boolean {
    this.system.advance(dtMs);
    const drawn = this.writeQuads(hideLevelsAbove);
    this.mesh.visible = drawn > 0;
    return drawn > 0;
  }

  /** Whether anything is alive, so a caller can skip a frame it need not draw. */
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

  /**
   * Fill the buffers from the pool, skipping what the roof cut hides.
   *
   * The skip is here rather than in the simulation because a particle behind a
   * ceiling is still *there* — walking under a roof and back out should find the
   * fire still burning, not restarted.
   */
  private writeQuads(hideLevelsAbove: number | undefined): number {
    for (const bucket of this.buckets.values()) bucket.length = 0;

    for (let i = 0; i < this.system.count; i++) {
      const z = this.system.levelAt(i);
      if (hideLevelsAbove !== undefined && z > hideLevelsAbove) continue;
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
      // One group per level, pointing at that level's material.
      this.geometry.addGroup(groupStart, written, this.levels.length);
      this.levels.push(z);
    }

    this.mesh.material = this.levels.map((z) => this.materialFor(z));
    if (quad > 0) this.flushAttributes(quad);
    return quad;
  }

  /** One particle into slot `quad`. False when it is too faint to bother with. */
  private writeQuad(index: number, quad: number): boolean {
    const p = this.system.read(index, this.reading);
    const life = p.life;
    // The authored size, scaled by how much of the effect was left when this
    // spark was born. Rounded to a whole pixel by `circleSlice`, so a winding
    // -down plume steps through real circle sizes rather than smearing.
    const radius =
      (p.config.radiusFromPx +
        (p.config.radiusToPx - p.config.radiusFromPx) * life) *
      p.taper;
    const slice = circleSlice(radius);
    const alpha =
      p.config.alphaFrom + (p.config.alphaTo - p.config.alphaFrom) * life;
    if (alpha <= PARTICLE_ALPHA_CUTOFF) return false;

    // Snapped to whole world pixels, so a particle moves in pixel steps like
    // everything else on screen rather than sliding between them.
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

    // The cell the particle is standing over, not its fractional position: a
    // light map texel's centre is at the cell's integer coordinate (see
    // `uLightOrigin`), so a fractional value would land on a texel boundary and
    // a nearest-filtered sample would pick a neighbour at random.
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
      // Zero, so the shader's per-pixel-centre correction adds nothing and every
      // fragment of the particle reads the same texel.
      this.lightScales[lb] = 0;
      this.lightScales[lb + 1] = 0;
    }

    return true;
  }

  /** Upload only the prefix that changed. @see THREE.BufferAttribute.addUpdateRange */
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

  /** Every buffer a particle quad needs, allocated once and never resized. */
  private buildGeometry(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(this.uvs, 2));
    geo.setAttribute("aBox", new THREE.BufferAttribute(this.boxes, BOX_COMPONENTS));
    geo.setAttribute("aStack", new THREE.BufferAttribute(this.stacks, 1));
    geo.setAttribute(
      "aParticleColor",
      new THREE.BufferAttribute(this.colors, COLOR_COMPONENTS),
    );
    geo.setAttribute("aLightUv", new THREE.BufferAttribute(this.lightUvs, 2));
    geo.setAttribute(
      "aLightScale",
      new THREE.BufferAttribute(this.lightScales, 2),
    );
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
    // **Left wide open on purpose, and it must stay that way.** Groups do not
    // replace the draw range, they are intersected with it — a geometry pinned
    // to `setDrawRange(0, 0)` draws nothing however many groups it carries, and
    // that is exactly how the whole layer went silently blank. What bounds the
    // draw is the groups; `mesh.visible` is what covers the frame with none.
    geo.setDrawRange(0, Infinity);
    return geo;
  }
}

/** Distinct from the world's, because the source differs. @see WORLD_SHADER_CACHE_KEY */
const PARTICLE_SHADER_CACHE_KEY = `${WORLD_SHADER_CACHE_KEY}-particles-v1`;

/**
 * Add the per-particle colour to a shader already patched by
 * {@link injectWorldShader}.
 *
 * **Order matters, and this must run second.** Both patch `#include <common>`,
 * and replacing an include that has already been replaced hits the copy at the
 * head of the previous patch's text — so these declarations land in front of the
 * world shader's, which is exactly where a declaration belongs. The other two
 * anchors (`begin_vertex`, `color_fragment`) are ones the world shader does not
 * touch, so they hit the stock includes.
 */
function injectParticleShader(shader: {
  vertexShader: string;
  fragmentShader: string;
}) {
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      /* glsl */ `#include <common>
attribute vec4 aParticleColor;
varying vec4 vParticleColor;`,
    )
    .replace(
      "#include <begin_vertex>",
      /* glsl */ `#include <begin_vertex>
vParticleColor = aParticleColor;`,
    );

  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      /* glsl */ `#include <common>
varying vec4 vParticleColor;`,
    )
    // Before `<map_fragment>` multiplies the atlas in and before
    // `<alphatest_fragment>` reads the result, so the cutoff sees the particle's
    // own fade and the circle mask together.
    .replace(
      "#include <color_fragment>",
      /* glsl */ `#include <color_fragment>
diffuseColor *= vParticleColor;`,
    );
}
