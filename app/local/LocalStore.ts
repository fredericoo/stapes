import { type CheckpointBatch, type Checkpoints, memoryCheckpoints } from "./checkpoints";

export class LocalStore {
  private readonly values = new Map<string, string>();
  private readonly written = new Set<string>();
  private readonly deleted = new Set<string>();
  private alarmAtMs: number | null = null;
  private alarmDirty = false;
  private flushing: Promise<void> | null = null;

  onAlarmChange: ((atMs: number | null) => void) | null = null;

  constructor(private readonly checkpoints: Checkpoints = memoryCheckpoints()) {}

  readonly sql = {
    exec: (_query: string, ..._bindings: unknown[]): void => {},
  };

  async restore(): Promise<void> {
    const stored = await this.checkpoints.load();
    for (const [key, value] of stored.values) this.values.set(key, value);
    this.alarmAtMs = stored.alarmAtMs;
  }

  get<T>(key: string): Promise<T | undefined> {
    const raw = this.values.get(key);
    return Promise.resolve(raw === undefined ? undefined : (decode(raw) as T));
  }

  /** Sorted because the server's is — `pruneOldest` walks the result expecting the oldest first. */
  list<T>(options: { prefix: string }): Promise<Map<string, T>> {
    const keys = [...this.values.keys()].filter((key) => key.startsWith(options.prefix)).sort();
    const out = new Map<string, T>();
    for (const key of keys) out.set(key, decode(this.values.get(key)!) as T);
    return Promise.resolve(out);
  }

  put(key: string, value: unknown, options?: unknown): Promise<void>;
  put(entries: Record<string, unknown>, options?: unknown): Promise<void>;
  put(
    keyOrEntries: string | Record<string, unknown>,
    valueOrOptions?: unknown,
    _options?: unknown,
  ): Promise<void> {
    if (typeof keyOrEntries === "string") {
      this.write(keyOrEntries, valueOrOptions);
    } else {
      for (const [key, value] of Object.entries(keyOrEntries)) {
        this.write(key, value);
      }
    }
    return Promise.resolve();
  }

  private write(key: string, value: unknown) {
    this.values.set(key, encode(value));
    this.deleted.delete(key);
    this.written.add(key);
  }

  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    const keys = typeof keyOrKeys === "string" ? [keyOrKeys] : keyOrKeys;
    let removed = 0;
    for (const key of keys) {
      if (this.values.delete(key)) removed += 1;
      this.written.delete(key);
      this.deleted.add(key);
    }
    return Promise.resolve(typeof keyOrKeys === "string" ? removed > 0 : removed);
  }

  async deleteAll(): Promise<void> {
    await this.settle();
    this.values.clear();
    this.written.clear();
    this.deleted.clear();
    this.alarmAtMs = null;
    this.alarmDirty = false;
    await this.checkpoints.clear();
  }

  setAlarm(atMs: number): Promise<void> {
    this.alarmAtMs = atMs;
    this.alarmDirty = true;
    this.onAlarmChange?.(atMs);
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    this.alarmAtMs = null;
    this.alarmDirty = true;
    this.onAlarmChange?.(null);
    return Promise.resolve();
  }

  alarmAt(): number | null {
    return this.alarmAtMs;
  }

  get dirty(): boolean {
    return this.written.size > 0 || this.deleted.size > 0 || this.alarmDirty;
  }

  /**
   * The batch is taken before the first await, so writes made while a
   * checkpoint is in flight belong to the next one rather than being lost.
   * Overlapping calls are serialised for the same reason the server's are:
   * two commits carrying interleaved views of one board is the corruption a
   * checkpoint exists to prevent.
   */
  async flush(): Promise<void> {
    if (this.flushing) {
      await this.flushing;
      if (!this.dirty) return;
    }
    if (!this.dirty) return;

    const batch: CheckpointBatch = {
      writes: [...this.written].map((key) => [key, this.values.get(key)!]),
      deletions: [...this.deleted],
      ...(this.alarmDirty ? { alarmAtMs: this.alarmAtMs } : {}),
    };
    this.written.clear();
    this.deleted.clear();
    this.alarmDirty = false;

    this.flushing = this.checkpoints.commit(batch).finally(() => {
      this.flushing = null;
    });
    await this.flushing;
  }

  private async settle(): Promise<void> {
    while (this.flushing) await this.flushing;
  }
}

function encode(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function decode(text: string): unknown {
  return JSON.parse(text);
}
