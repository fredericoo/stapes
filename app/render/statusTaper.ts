/**
 * A status's remaining time, smoothed between the moments anybody says what it
 * is.
 *
 * ## Why this exists
 *
 * A wind-down is drawn from how long a status has left, and online that figure
 * arrives about **once a second**: the server compares statuses at whole-second
 * grain (`statusReading`) and only sends when that reading changes, which is
 * exactly right for a countdown badge and far too coarse for a fade. Driven
 * straight off the wire, a four-second taper is four steps.
 *
 * So the number is carried forward locally between messages and re-anchored
 * whenever a new one arrives. Nothing here is authoritative and nothing here is
 * corrected: it is the same bargain the rest of this feature is under — the
 * effects are client-side, and a fade that is a few milliseconds ahead of the
 * server is not a thing anybody can see or act on.
 *
 * A local session does not need this and is not harmed by it. There the figure
 * moves every tick, so each read re-anchors and the carried value is never used.
 *
 * ## Why a class and not a map in the renderer
 *
 * Because the interesting part is the bookkeeping — re-anchor, carry, forget —
 * and that is arithmetic over a string key, which is testable without a canvas.
 * The renderer's job is to know which statuses are on screen; this one's is to
 * remember what it was told about them.
 */

/** One tracked status: what the wire last said, and where local time has got to. */
type Clock = {
  /** The last figure a snapshot carried, so a new one can be recognised. */
  fromSnapshot: number;
  /** What it has been carried down to since. */
  localMs: number;
  /** Whether this was read during the frame in progress. @see endFrame */
  seen: boolean;
};

export class SmoothedRemaining {
  private readonly clocks = new Map<string, Clock>();

  /**
   * Carry every tracked status forward by a frame.
   *
   * Called once before the frame's reads rather than inside them, so a status
   * read twice in one frame cannot be aged twice.
   */
  beginFrame(dtMs: number) {
    for (const clock of this.clocks.values()) {
      clock.seen = false;
      if (dtMs > 0) clock.localMs = Math.max(0, clock.localMs - dtMs);
    }
  }

  /**
   * What this status has left, smoothed.
   *
   * Re-anchors whenever the snapshot's figure differs from the one it was last
   * anchored to — which is every message online, and every tick locally.
   *
   * **The anchor is compared against the snapshot's own previous value, not
   * against the local one**, and it has to be: the local value is drifting away
   * by design, so comparing to it would re-anchor on every single frame and
   * throw away the smoothing this exists to provide.
   */
  read(key: string, snapshotRemainingMs: number): number {
    const existing = this.clocks.get(key);
    if (!existing || existing.fromSnapshot !== snapshotRemainingMs) {
      this.clocks.set(key, {
        fromSnapshot: snapshotRemainingMs,
        localMs: snapshotRemainingMs,
        seen: true,
      });
      return snapshotRemainingMs;
    }
    existing.seen = true;
    return existing.localMs;
  }

  /** Forget every status that was not read this frame. */
  endFrame() {
    for (const [key, clock] of this.clocks) {
      if (!clock.seen) this.clocks.delete(key);
    }
  }

  /** How many statuses are being carried. For tests and for sanity. */
  get size(): number {
    return this.clocks.size;
  }

  clear() {
    this.clocks.clear();
  }
}

/** How a status running on a body is addressed. One per bearer per def. */
export function taperKey(actorId: string, defId: string): string {
  return `${actorId}:${defId}`;
}
