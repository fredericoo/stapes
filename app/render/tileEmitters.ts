import { type RoofCut, cutHides } from "../lib/levelVisibility";
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

/**
 * Slack cells around the camera's reach, for plumes just out of frame.
 *
 * A plume is anchored to its cell but is not *drawn* there: a particle rises,
 * and rising is up-and-left on screen, so an emitter a little below the bottom
 * edge can put sparks inside it. Too small and a plume pops into existence at
 * the edge of the screen instead of drifting in; too large and the pool is spent
 * on smoke nobody can see.
 *
 * A little wider than `LIGHT_WINDOW_MARGIN`, because light stops at its radius
 * and a particle travels. Six cells is 48 world pixels, which is 24 height units
 * of rise — more than any plume worth authoring climbs before it fades.
 */
export const PARTICLE_WINDOW_MARGIN = 6;

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
 * ## The window is per level, and that is the whole point of taking level 0
 *
 * The obvious thing to hand this is the rect the light bake crops to, and it is
 * the wrong one. That rect is the **union across every level**, because a light
 * on any storey can reach the cells you are looking at; the projection shifts
 * level `z` by exactly `z` cells, so unioning seventeen levels grows it by eight
 * cells on each side before its own margin. Against a 23-cell viewport that is
 * a window over four times the visible area, and every emitter inside it spends
 * the shared pool and has quads written for sparks nobody can see.
 *
 * A plume is not a light: it is on one known level, so it gets that level's own
 * rect — the level-0 rect shifted by `z`, which is one add per level rather than
 * anything per emitter.
 *
 * @param window The visible cell rect **at level 0**, with no apron of its own.
 * {@link PARTICLE_WINDOW_MARGIN} is added here so this module owns the whole
 * rule and a test can assert it.
 * @param cut The roof-cut. A plume on a cut cell is dropped by
 * `./particleLayer` *after* it has been simulated and written, so dropping the
 * emitter here spends nothing on it at all.
 */
export function appendVisibleTileEmitters(
  byLevel: ReadonlyMap<number, readonly ParticleEmitterSpec[]>,
  window: WorldRect,
  cut: RoofCut | undefined,
  into: ParticleEmitterSpec[],
): ParticleEmitterSpec[] {
  let taken = 0;
  for (const [z, emitters] of byLevel) {
    // This level's own reach, from the level-0 rect. Computed per level and not
    // per emitter, which is what makes it free.
    const x0 = window.x0 + z - PARTICLE_WINDOW_MARGIN;
    const x1 = window.x1 + z + PARTICLE_WINDOW_MARGIN;
    const y0 = window.y0 + z - PARTICLE_WINDOW_MARGIN;
    const y1 = window.y1 + z + PARTICLE_WINDOW_MARGIN;
    for (const spec of emitters) {
      // The emitter's *cell*, not its anchor. A plume hangs from the middle of
      // its cell (`cx` is `x + 0.5`), and comparing that against an integer cell
      // rect drops the whole eastern and southern edge of the window — every
      // emitter there sits half a cell past its own bound.
      const cx = Math.floor(spec.cx);
      const cy = Math.floor(spec.cy);
      if (cx < x0 || cx > x1) continue;
      if (cy < y0 || cy > y1) continue;
      // After the rect and not before it: the cut is a set lookup per emitter
      // and the rect is four compares, so the cheap test culls the many and
      // this one answers for the few left on screen.
      if (cutHides(cut, cx, cy, z)) continue;
      // Counted over the board's own, never over the caller's: the cap is about
      // how many chimneys are worth reconciling, and a room full of burning rats
      // is not a reason to stop drawing the chimney.
      if (++taken > MAX_VISIBLE_TILE_EMITTERS) return into;
      into.push(spec);
    }
  }
  return into;
}
