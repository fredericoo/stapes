type Clock = {
  fromSnapshot: number;
  localMs: number;
  seen: boolean;
};

export class SmoothedRemaining {
  private readonly clocks = new Map<string, Clock>();

  beginFrame(dtMs: number) {
    for (const clock of this.clocks.values()) {
      clock.seen = false;
      if (dtMs > 0) clock.localMs = Math.max(0, clock.localMs - dtMs);
    }
  }

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

  endFrame() {
    for (const [key, clock] of this.clocks) {
      if (!clock.seen) this.clocks.delete(key);
    }
  }

  get size(): number {
    return this.clocks.size;
  }

  clear() {
    this.clocks.clear();
  }
}

export function taperKey(actorId: string, defId: string): string {
  return `${actorId}:${defId}`;
}
