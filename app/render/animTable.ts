import * as THREE from "three";
import {
  CELL_SIZE,
  cycleMs,
  type Frame,
  frameIndexAtTime,
  type TilesetDef,
} from "../lib/types";

/**
 * Every animation one level draws, as a texture its vertex shader can read.
 *
 * The point of it is that an animated tile no longer needs a mesh of its own.
 * Until this existed the renderer kept animated tiles out of the merged batch so
 * their UVs could be rewritten when the frame flipped, which costs one mesh and
 * one draw call *per placement* — fine for the handful of torches a map has, and
 * ruinous for water, which is terrain and arrives in hundreds. Here the frame is
 * a function the vertex shader evaluates instead: the quad carries a row index
 * and its own phase, and this table says where each frame of that row sits
 * relative to frame 0.
 *
 * One row per animation, one texel per frame, `RGBA32F`:
 *
 * - `xy` — the frame's offset from frame 0 in the atlas, in UV space. Added
 *   straight onto `vMapUv`, which is exact because every frame of one sprite has
 *   the same footprint (see {@link addAnimation}) so both corners shift alike.
 * - `z` — the millisecond this frame *ends* at, measured from the cycle's start.
 *   Cumulative rather than per-frame so the shader can find the live frame with
 *   a single comparison per texel and no running total.
 * - `w` — unused, and cheaper to leave than to pack around.
 *
 * Rows are ragged and the texture is not, so the short ones are padded with
 * copies of their last frame ending at the cycle length. That is what lets the
 * shader's loop be a plain walk to the width with no frame count to carry: the
 * clock is already taken modulo the cycle, so the comparison always succeeds on
 * or before the last real frame, and the padding is never reached.
 */
export class AnimationTable {
  /**
   * Keyed by the frame array's *identity*, which is sound because `getFrames`
   * hands back the array stored on the tile def rather than building one — so
   * two placements of a tile in the same variant are the same object, and two
   * different variants never are.
   */
  private readonly rows = new Map<Frame[], number>();
  private readonly order: { frames: Frame[]; tileset: TilesetDef }[] = [];
  private texture: THREE.DataTexture | null = null;

  get empty(): boolean {
    return this.order.length === 0;
  }

  /**
   * The row for these frames, adding it on first sight.
   *
   * Returns {@link NO_ANIMATION} for anything with fewer than two frames, and
   * for a sprite whose frames disagree about their footprint or their atlas.
   * Both of those are already impossible for a tile that animates today — the
   * old path rewrote UVs into geometry built once, which only works when the
   * rect never changes size — but they are impossible *implicitly*, and this
   * path would mis-draw rather than refuse. So it refuses, and the tile falls
   * back to standing still on frame 0 rather than smearing a neighbouring
   * sprite across itself.
   */
  add(frames: Frame[], tileset: TilesetDef): number {
    const existing = this.rows.get(frames);
    if (existing != null) return existing;
    if (!tableCanHold(frames)) return NO_ANIMATION;

    const row = this.order.length;
    this.rows.set(frames, row);
    this.order.push({ frames, tileset });
    // The next `bake` produces a wider or taller texture, so the one standing
    // is about to be replaced rather than reused.
    this.texture?.dispose();
    this.texture = null;
    return row;
  }

  /** Rows added so far, which is the baked texture's height. */
  get height(): number {
    return this.order.length;
  }

  /** Frames in the longest cycle, which is the baked texture's width. */
  get width(): number {
    let widest = 1;
    for (const { frames } of this.order) {
      if (frames.length > widest) widest = frames.length;
    }
    return widest;
  }

  /**
   * The texture, built on first ask and held until another animation arrives.
   *
   * A level's quads are all walked before anything draws, so this is baked once
   * per rebuild however many times it is read.
   */
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
        // Past the last real frame, keep repeating it: the clock is taken
        // modulo `total`, so the shader stops on a real frame before it can
        // read one of these.
        const frame = frames[Math.min(col, frames.length - 1)]!;
        if (col < frames.length) end += Math.max(1, frame.durationMs);
        const rect = frame.sprite.rect;
        const o = (row * w + col) * 4;
        data[o] = ((rect.x - first.x) * CELL_SIZE) / tileset.width;
        // Negative because the v axis is flipped when a rect becomes UVs — a
        // frame further *down* the sheet sits *lower* in v.
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

  /**
   * Whether anything in this table draws differently at `toMs` than at `fromMs`.
   *
   * What stops a world with a pond in it from rendering every frame for ever.
   * The clock moving is not the question — it moves every frame — the question
   * is whether it crossed a frame boundary, and between boundaries there is
   * nothing new to draw.
   *
   * One answer covers every placement however they are phased, because a phase
   * is always a whole number of frames (`cellPhaseMs` returns a frame's start):
   * shifting a cycle by one of its own boundaries lands its boundaries back on
   * the same set. So a cell is mid-frame exactly when every other cell of that
   * animation is, and asking about phase zero asks about all of them.
   */
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

/** What a quad carries when it does not animate. */
export const NO_ANIMATION = -1;

/**
 * Longest cycle the shader will walk, and therefore the table's widest row.
 *
 * The loop that finds the live frame needs a bound the compiler can see, so this
 * is a ceiling on the art rather than a tuning knob: the shader stops at the
 * live frame, so a shorter cycle costs proportionally less whatever this says.
 * Sixty-four frames at even a fast cadence is several seconds of animation, and
 * nothing authored comes close — the longest today is fourteen.
 */
export const ANIM_MAX_FRAMES = 64;

/**
 * Whether this animation can be drawn from the table at all.
 *
 * Asked by the renderers *before* they build a quad, not only by
 * {@link AnimationTable.add} afterwards, and that ordering is the point: the
 * answer decides whether the quad is built at frame 0 for the shader to move or
 * at the live frame for `updateAnimations` to move, and a quad built for the
 * wrong one is either frozen or offset. One predicate, asked once, so the two
 * cannot disagree.
 */
export function tableCanHold(frames: Frame[]): boolean {
  return (
    frames.length >= 2 &&
    frames.length <= ANIM_MAX_FRAMES &&
    uniformFootprint(frames)
  );
}

/**
 * Whether every frame draws the same size from the same sheet.
 *
 * Both halves matter for different reasons. A frame of a different *size* would
 * need the quad's geometry to change, and the whole point here is that it does
 * not. A frame from a different *sheet* would need a different texture, and a
 * merged batch is one texture by construction — the quad would sample whichever
 * sheet its neighbours happened to put it in.
 */
function uniformFootprint(frames: Frame[]): boolean {
  const first = frames[0]!.sprite;
  return frames.every(
    (f) =>
      f.sprite.rect.w === first.rect.w &&
      f.sprite.rect.h === first.rect.h &&
      f.sprite.base.x === first.base.x &&
      f.sprite.base.y === first.base.y &&
      f.sprite.tilesetId === first.tilesetId,
  );
}
