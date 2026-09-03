import type { WorldRect } from "../lib/lightingChunks";
import type { ParticleEmitterSpec } from "./particles";

/**
 * Which of the board's own plumes are worth simulating this frame.
 *
 * Separated from `./WorldRenderer` for the reason `./particles` is separated
 * from `./particleLayer`: what this decides is arithmetic — a rect test, a
 * ceiling, a cap — and arithmetic can be asserted in a test rather than
 * eyeballed against a canvas. Nothing in here knows what THREE is.
 *
 * The index it reads is the whole board, built alongside the geometry and
 * maintained by the same three functions. Culling is the per-frame half,
 * because where the camera is changes on every step and what is on the board
 * does not.
 */

/**
 * Most tile plumes handed to the particle system in one frame.
 *
 * **Not the budget — the pool is** (`MAX_LIVE_PARTICLES`), and a world that puts
 * more emitters on screen than this already has more sparks than it can draw.
 * This bounds the per-frame reconcile instead: `setEmitters` is a map lookup and
 * a compare per plume, which is nothing at a dozen and is worth capping before
 * somebody authors a pollen that every blade of grass gives off.
 *
 * Truncation is arbitrary rather than nearest-first, and the consequence is
 * stated plainly: past this many emitting tiles in one window, which of them
 * smoke changes as you walk. A sort would fix that and costs more, every frame,
 * for a case that is already a content mistake.
 */
export const MAX_VISIBLE_TILE_EMITTERS = 128;

/** The id one placement's plume is reconciled by. @see tileInstanceKey */
export function tileEmitterId(instanceKey: string): string {
  return `tile:${instanceKey}`;
}

/** The prefix every plume given off by one cell shares. */
export function tileEmitterPrefix(z: number, x: number, y: number): string {
  return `tile:${z}:${x},${y}:`;
}

/**
 * Append the board's visible plumes to a list that already holds the caller's.
 *
 * **Appended rather than merged, and the order is load-bearing.** The particle
 * pool is a fixed size and emission is served in emitter order, so whatever came
 * first wins the last slot in a full pool. A status is something happening to
 * somebody and a chimney is scenery, so a crowded board thins its smoke rather
 * than dropping the fire on the rat.
 *
 * Written into a caller-owned array rather than returned fresh, because this
 * runs on every frame that has a plume in it and an array per frame at 120fps is
 * a collection in the middle of the frame budget for a list three entries long.
 *
 * @param ceiling The roof-cut. A particle above it is hidden by
 * `./particleLayer` *after* it has been simulated and written, so dropping the
 * emitter here spends nothing on it at all.
 */
export function appendVisibleTileEmitters(
  byLevel: ReadonlyMap<number, readonly ParticleEmitterSpec[]>,
  window: WorldRect,
  ceiling: number | undefined,
  into: ParticleEmitterSpec[],
): ParticleEmitterSpec[] {
  let taken = 0;
  for (const [z, emitters] of byLevel) {
    if (ceiling !== undefined && z > ceiling) continue;
    for (const spec of emitters) {
      // The window the light bake uses: a plume that has drifted a cell off
      // screen is still worth emitting, one two rooms away is not.
      if (spec.cx < window.x0 || spec.cx > window.x1) continue;
      if (spec.cy < window.y0 || spec.cy > window.y1) continue;
      // Counted over the board's own, never over the caller's: the cap is about
      // how many chimneys are worth reconciling, and a room full of burning rats
      // is not a reason to stop drawing the chimney.
      if (++taken > MAX_VISIBLE_TILE_EMITTERS) return into;
      into.push(spec);
    }
  }
  return into;
}
