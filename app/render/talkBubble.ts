import { tailPlacement, type TailLean } from "./speechBubble";

/** Where the talked-to body is in the canvas frame, in CSS pixels. */
export type TalkAnchor = { x: number; headY: number; feetY: number };

export type TalkBubbleSide = "above" | "below" | "none";

export type TalkBubblePlacement = {
  left: number;
  top: number;
  side: TalkBubbleSide;
  tail: { leftBrick: number; lean: TailLean } | null;
};

export type TalkBubbleRequest = {
  anchor: TalkAnchor | null;
  view: { width: number; height: number };
  /** The bubble's box, without its tail. */
  size: { width: number; height: number };
  /**
   * How tall the bubble will be once the stage has finished appearing. The
   * side is chosen for this height, so a bubble that grows as its lines type
   * does not start over the body and then move under it.
   */
  settledHeight?: number;
  brickPx: number;
  /** Kept clear between the bubble and every edge of the frame. */
  marginPx: number;
  /** From the body's head up to the tail's tip, which is where a name and a health bar sit. */
  liftPx: number;
  tailPx: number;
};

function snap(px: number, brickPx: number): number {
  return brickPx > 0 ? Math.round(px / brickPx) * brickPx : Math.round(px);
}

function clamp(value: number, lowest: number, highest: number): number {
  return Math.min(Math.max(lowest, highest), Math.max(lowest, value));
}

/**
 * The bubble hangs over the body it belongs to when it fits there, under it
 * when it only fits there, and otherwise anywhere inside the frame's margin
 * with no tail, since it then covers the body it would point at.
 */
export function placeTalkBubble(request: TalkBubbleRequest): TalkBubblePlacement {
  const { anchor, view, size, brickPx, marginPx, liftPx, tailPx } = request;
  const settled = Math.max(size.height, request.settledHeight ?? 0);
  const highestLeft = view.width - marginPx - size.width;
  const highestTop = view.height - marginPx - settled;
  if (!anchor) {
    return {
      left: snap(clamp((view.width - size.width) / 2, marginPx, highestLeft), brickPx),
      top: snap(clamp((view.height - size.height) / 2, marginPx, highestTop), brickPx),
      side: "none",
      tail: null,
    };
  }

  const left = snap(clamp(anchor.x - size.width / 2, marginPx, highestLeft), brickPx);
  const tail =
    brickPx > 0
      ? tailPlacement(Math.round(size.width / brickPx), (anchor.x - left) / brickPx)
      : null;

  const bottom = anchor.headY - liftPx - tailPx;
  if (bottom - settled >= marginPx) {
    return { left, top: snap(bottom - size.height, brickPx), side: "above", tail };
  }
  const above = bottom - settled;

  const below = anchor.feetY + tailPx;
  if (below <= highestTop) return { left, top: snap(below, brickPx), side: "below", tail };

  return { left, top: snap(clamp(above, marginPx, highestTop), brickPx), side: "none", tail: null };
}

/**
 * Carries the anchor from the renderer's frame to whatever positions the
 * bubble, without a React render per frame.
 */
export class TalkAnchorChannel {
  private listener: ((anchor: TalkAnchor | null) => void) | null = null;
  private last: TalkAnchor | null = null;

  readonly publish = (anchor: TalkAnchor | null) => {
    const last = this.last;
    if (
      anchor === last ||
      (anchor &&
        last &&
        anchor.x === last.x &&
        anchor.headY === last.headY &&
        anchor.feetY === last.feetY)
    ) {
      return;
    }
    this.last = anchor;
    this.listener?.(anchor);
  };

  listen(listener: (anchor: TalkAnchor | null) => void): () => void {
    this.listener = listener;
    listener(this.last);
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }
}
