import { PNG } from "pngjs";
import type { Projection, Vec3 } from "./limb-caster";
import { paletteRgba } from "./tileset-output";

const SUPERSAMPLE = 3;
const MARCH_STEP_PX = 1 / 32;

/**
 * What a model is made of at a point: `sample` answers with whatever `shade`
 * needs to choose a palette index, usually the part and its surface normal,
 * or null where the point is empty. Points are in pixels of the model's own
 * cell, `z` up, multiplied by the `scale` the cast was asked for.
 */
export type Model<H> = {
  sample: (p: Vec3, scale: number) => H | null;
  shade: (hit: H) => number;
};

/**
 * Casts any model through the game's projection, the way `limb-caster` casts
 * capsules: a point at height `z` is drawn `z` pixels up and to the left of
 * where it stands, so the ray through a pixel walks down from `topPx`. A pixel
 * is drawn when at least half its samples meet the model, with the palette
 * index most of them chose. `scale` casts it that many times larger, which is
 * how to look at the shape before it is reduced to pixels.
 */
export function castModel<H>(model: Model<H>, projection: Projection, scale = 1): Int16Array {
  const size = projection.spritePx * scale;
  const ground = projection.groundPx * scale;
  const top = projection.topPx * scale;
  const out = new Int16Array(size * size).fill(-1);
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      const votes = new Map<number, number>();
      let hits = 0;
      for (let j = 0; j < SUPERSAMPLE; j++) {
        for (let i = 0; i < SUPERSAMPLE; i++) {
          const su = u + (i + 0.5) / SUPERSAMPLE;
          const sv = v + (j + 0.5) / SUPERSAMPLE;
          for (let z = top; z >= 0; z -= MARCH_STEP_PX * scale) {
            const hit = model.sample([su - ground + z, sv - ground + z, z], scale);
            if (!hit) continue;
            hits++;
            const index = model.shade(hit);
            votes.set(index, (votes.get(index) ?? 0) + 1);
            break;
          }
        }
      }
      if (hits * 2 < SUPERSAMPLE * SUPERSAMPLE) continue;
      out[v * size + u] = [...votes].sort((a, b) => b[1] - a[1])[0]![0];
    }
  }
  return out;
}

/** A dark edge below whatever was cast, as the hand-drawn food has. */
export function outlineBelow(pixels: Int16Array, size: number, index: number): Int16Array {
  const out = pixels.slice();
  for (let v = 1; v < size; v++) {
    for (let u = 0; u < size; u++) {
      if (pixels[v * size + u]! < 0 && pixels[(v - 1) * size + u]! >= 0) out[v * size + u] = index;
    }
  }
  return out;
}

/** Writes a cast as a PNG on a flat backdrop, for looking at rather than for the game. */
export async function writeCast(file: string, pixels: Int16Array, size: number) {
  const png = new PNG({ width: size, height: size });
  const backdrop = [35, 144, 99, 255];
  for (let i = 0; i < pixels.length; i++) {
    const colour = pixels[i]! >= 0 ? paletteRgba(pixels[i]!) : backdrop;
    for (let c = 0; c < 4; c++) png.data[i * 4 + c] = colour[c]!;
  }
  await Bun.write(file, PNG.sync.write(png));
}
