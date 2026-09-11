/**
 * Something a body is part-way through, as two numbers.
 *
 * **A third module because two of them needed the same words.** A pull and a
 * cast are different things — one is worked out of a placement and named by a
 * key, the other is a stone answering — and neither could take this type from
 * the other without `./casting` and `./extract` importing each other. What they
 * genuinely share is the shape of the clock: how much is left, and what that is
 * a remainder *of*.
 *
 * **Both halves travel, always.** The remainder alone says how much longer; the
 * duration beside it says how far through that is, which is the difference
 * between a bar and a spinner — and a client that never saw the thing start
 * cannot work the second number out from the first. That is exactly the pairing
 * `../net/protocol`'s `StatusPatch` makes and for the same reason.
 *
 * **Wound in place, never replaced.** One object is the runtime's and the one
 * handed out, so a tick advancing it costs no allocation and leaves the value's
 * identity alone. Identity is what the broadcast is diffed on and what gates the
 * renderer's interaction list, so a fresh object per tick would be a message per
 * tick and a list rebuilt thirty times a second for something that changes twice.
 */
export type Progress = {
  /** How much is left to do. Wound to zero, never below. */
  remainingMs: number;
  /** How long the whole of it takes, so a bar knows what it is a fraction of. */
  durationMs: number;
};

/**
 * How much of it is done, from 0 to 1.
 *
 * Clamped at both ends because the wire does not clamp the remainder against the
 * duration, and the two are wound on different clocks — the server's tick and
 * the client's frame. Something authored at zero is finished rather than a
 * division by zero.
 */
export function progressFraction(progress: Progress): number {
  if (progress.durationMs <= 0) return 1;
  const done = 1 - progress.remainingMs / progress.durationMs;
  return Math.max(0, Math.min(1, done));
}

/** Take a frame off, floored at zero. */
export function windProgress(progress: Progress, dtMs: number) {
  progress.remainingMs = Math.max(0, progress.remainingMs - dtMs);
}
