import * as THREE from "three";
import { CELL_SIZE, cycleMs, type Frame, frameIndexAtTime, type TilesetDef } from "../lib/types";

export class AnimationTable {
  private readonly rows = new Map<Frame[], number>();
  private readonly order: { frames: Frame[]; tileset: TilesetDef }[] = [];
  private texture: THREE.DataTexture | null = null;

  get empty(): boolean {
    return this.order.length === 0;
  }

  add(frames: Frame[], tileset: TilesetDef): number {
    const existing = this.rows.get(frames);
    if (existing != null) return existing;
    if (!tableCanHold(frames)) return NO_ANIMATION;

    const row = this.order.length;
    this.rows.set(frames, row);
    this.order.push({ frames, tileset });
    this.texture?.dispose();
    this.texture = null;
    return row;
  }

  get height(): number {
    return this.order.length;
  }

  get width(): number {
    let widest = 1;
    for (const { frames } of this.order) {
      if (frames.length > widest) widest = frames.length;
    }
    return widest;
  }

  bake(): THREE.DataTexture {
    if (this.texture) return this.texture;
    const w = this.width;
    const h = Math.max(1, this.height);
    const data = new Float32Array(w * h * 4);

    this.order.forEach(({ frames, tileset }, row) => {
      const total = cycleMs(frames);
      const first = frames[0]!.sprite.rect;
      let end = 0;
      for (let col = 0; col < w; col++) {
        const frame = frames[Math.min(col, frames.length - 1)]!;
        if (col < frames.length) end += Math.max(1, frame.durationMs);
        const rect = frame.sprite.rect;
        const o = (row * w + col) * 4;
        data[o] = ((rect.x - first.x) * CELL_SIZE) / tileset.width;
        /**
         * Negative: the v axis is flipped when a rect becomes UVs, so a frame
         * further down the sheet sits lower in v.
         */
        data[o + 1] = -((rect.y - first.y) * CELL_SIZE) / tileset.height;
        data[o + 2] = col < frames.length ? end : total;
      }
    });

    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.texture = tex;
    return tex;
  }

  crossedFrame(fromMs: number, toMs: number): boolean {
    for (const { frames } of this.order) {
      if (frameIndexAtTime(frames, fromMs) !== frameIndexAtTime(frames, toMs)) {
        return true;
      }
    }
    return false;
  }

  dispose() {
    this.texture?.dispose();
    this.texture = null;
  }
}

export const NO_ANIMATION = -1;

export const ANIM_MAX_FRAMES = 64;

export function tableCanHold(frames: Frame[]): boolean {
  return frames.length >= 2 && frames.length <= ANIM_MAX_FRAMES && uniformFootprint(frames);
}

export function uniformFootprint(frames: Frame[]): boolean {
  const first = frames[0]!.sprite;
  return frames.every(
    (f) =>
      f.sprite.rect.w === first.rect.w &&
      f.sprite.rect.h === first.rect.h &&
      f.sprite.base.x === first.base.x &&
      f.sprite.base.y === first.base.y,
  );
}

/**
 * Walks the row until the texel's z (that frame's cumulative end time) passes
 * the clock; the last column repeats the cycle length so the loop always stops
 * before reading past the row's real frames.
 */
export const ANIM_GLSL_FUNCTION = `
uniform sampler2D uAnimTable;
uniform vec2 uAnimSize;
uniform float uAnimClockMs;
uniform float uAnimEnabled;
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
}`;
