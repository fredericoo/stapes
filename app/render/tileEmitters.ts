import type { MinutesOfDay } from "../lib/clock";
import { inHourSpan } from "../lib/particleRule";
import type { WorldRect } from "../lib/lightingChunks";
import type { ParticleEmitterSpec } from "./particles";

export const MAX_VISIBLE_TILE_EMITTERS = 128;

export const PARTICLE_WINDOW_MARGIN = 6;

export type CellHidden = (x: number, y: number, z: number) => boolean;

export function tileEmitterId(instanceKey: string): string {
  return `tile:${instanceKey}`;
}

export function tileEmitterPrefix(z: number, x: number, y: number): string {
  return `tile:${z}:${x},${y}:`;
}

/**
 * Emitters without a rule are taken first, so a forest of thinned-out emitters
 * cannot use up the cap before a torch is reached.
 */
export function appendVisibleTileEmitters(
  byLevel: ReadonlyMap<number, readonly ParticleEmitterSpec[]>,
  window: WorldRect,
  hidden: CellHidden | undefined,
  into: ParticleEmitterSpec[],
  minutesOfDay: MinutesOfDay,
): ParticleEmitterSpec[] {
  let taken = 0;
  for (const sparse of [false, true]) {
    for (const [z, emitters] of byLevel) {
      const x0 = window.x0 + z - PARTICLE_WINDOW_MARGIN;
      const x1 = window.x1 + z + PARTICLE_WINDOW_MARGIN;
      const y0 = window.y0 + z - PARTICLE_WINDOW_MARGIN;
      const y1 = window.y1 + z + PARTICLE_WINDOW_MARGIN;
      for (const spec of emitters) {
        if ((spec.sparse !== undefined) !== sparse) continue;
        const cx = Math.floor(spec.cx);
        const cy = Math.floor(spec.cy);
        if (cx < x0 || cx > x1) continue;
        if (cy < y0 || cy > y1) continue;
        if (!inHourSpan(spec.sparse?.hours, minutesOfDay)) continue;
        if (hidden?.(cx, cy, z)) continue;
        if (++taken > MAX_VISIBLE_TILE_EMITTERS) return into;
        into.push(spec);
      }
    }
  }
  return into;
}
