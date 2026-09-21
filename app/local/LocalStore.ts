import { type CheckpointBatch, type Checkpoints, memoryCheckpoints } from "./checkpoints";

/**
 * Durable Object storage again, this time in a tab.
 *
 * `server/WorldStore.ts` is the same interface over Turso, and the two are
 * deliberately the same shape: `GameServer` reads and writes through
 * `ctx.storage`, and the whole point of `/admin/play` is that the world running
 * in the browser is the world, not a re-implementation of it. Every difference
 * below is one the runtime forced.
 *
 * **The memory map is the world, and the checkpoint is a copy of it.** The
 * server buffers writes because its source of truth is a file it must not touch
 * on a tick; here the source of truth is already in memory, so a write lands
 * immediately and {@link flush} only has to tell the tab's storage what moved.
 * That removes the tombstone bookkeeping the server needs — a deleted key is
 * deleted — and leaves the dirty set, which is what a checkpoint is.
 *
 * **Values are JSON text rather than objects**, exactly as the server stores
 * them. Not a detail: `GameServer` hands over structures it goes on mutating —
 * the live board among them — and a store that kept the reference would
 * checkpoint whatever those had become by the time it got around to writing,
 * which is a board from one tick and actors from another.
 */
export class LocalStore {
  /** The world, by key, as JSON text. */
  private readonly values = new Map<string, string>();
  /** Keys written since the last checkpoint. */
  private readonly written = new Set<string>();
  /** Keys deleted since the last checkpoint. Disjoint from {@link written}. */
  private readonly deleted = new Set<string>();
  private alarmAtMs: number | null = null;
  private alarmDirty = false;
  /** Guards against two checkpoints overlapping. @see WorldStore.flush */
  private flushing: Promise<void> | null = null;

  /** Told whenever the alarm moves, so a timer can be re-armed. @see LocalWorld */
  onAlarmChange: ((atMs: number | null) => void) | null = null;

  constructor(private readonly checkpoints: Checkpoints = memoryCheckpoints()) {}

  /**
   * The chat log's escape hatch, and the one place this is honestly not the
   * server.
   *
   * `GameServer.logChat` writes chat into a table of its own and nothing ever
   * reads it back — not the client, not the world, not a later load. On the
   * server it is a record somebody could open the database and read; in a tab
   * there is nobody to read it and no database to open, so the statements go
   * nowhere. Speech still reaches everyone it should: that is the broadcast,
   * which has nothing to do with this.
   */
  readonly sql = {
    exec: (_query: string, ..._bindings: unknown[]): void => {},
  };

  /** Bring back whatever the last visit wrote down. Before the world loads. */
  async restore(): Promise<void> {
    const stored = await this.checkpoints.load();
    for (const [key, value] of stored.values) this.values.set(key, value);
    this.alarmAtMs = stored.alarmAtMs;
  }

  get<T>(key: string): Promise<T | undefined> {
    const raw = this.values.get(key);
    return Promise.resolve(raw === undefined ? undefined : (decode(raw) as T));
  }

  /**
   * Every key under a prefix, in key order.
   *
   * Sorted because the server's is — it reads out of an indexed range scan —
   * and `pruneOldest` walks the result expecting the oldest first.
   */
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

  /**
   * Forget the entire world.
   *
   * Committed immediately rather than left for the next checkpoint, on the
   * server's terms: the one caller is `GameServer.resetWorld`, which is
   * destructive by intent and awaits it, and a reset that a reload could undo
   * is not a reset.
   */
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

  /** When the alarm is due, or null. Read by {@link LocalWorld}'s timer. */
  alarmAt(): number | null {
    return this.alarmAtMs;
  }

  /** Whether anything is waiting to be written down. */
  get dirty(): boolean {
    return this.written.size > 0 || this.deleted.size > 0 || this.alarmDirty;
  }

  /**
   * Write down what has moved since the last time.
   *
   * The batch is taken before the first await, so writes made while a
   * checkpoint is in flight belong to the next one rather than being lost.
   * Overlapping calls are serialised for the same reason the server's are: two
   * commits carrying interleaved views of one board is the corruption a
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

  /** Wait for an in-flight checkpoint without starting one. */
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
