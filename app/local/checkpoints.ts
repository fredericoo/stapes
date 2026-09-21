/**
 * Where the world in this tab is written down between visits.
 *
 * The server checkpoints into SQLite; this is the same idea with the same
 * shape, against the only durable store a tab has. It is deliberately a
 * key/value blob store and nothing cleverer: `LocalStore` already holds the
 * whole world in memory, so all this has to do is survive a reload.
 *
 * **Every failure here is survivable and none of them stop the world.** A
 * private window, a blocked origin or a full quota all end in the same place —
 * the world runs in memory and is gone when the tab is — and that is a
 * perfectly good `/admin/play`. A page that refused to start because it could
 * not save would be strictly worse than one that forgets.
 */

/** The world as it was last written down. */
export type StoredWorld = {
  /** Values by key, as the JSON text `LocalStore` keeps them in. */
  values: Map<string, string>;
  alarmAtMs: number | null;
};

/** One checkpoint: what changed since the last one. */
export type CheckpointBatch = {
  writes: [string, string][];
  deletions: string[];
  /** Absent when the alarm did not move; `null` when it was cleared. */
  alarmAtMs?: number | null;
};

export interface Checkpoints {
  load(): Promise<StoredWorld>;
  commit(batch: CheckpointBatch): Promise<void>;
  /** Forget everything. The local half of `POST /api/reset`. */
  clear(): Promise<void>;
}

/** A world that is only ever in memory. Used where IndexedDB is not. */
export function memoryCheckpoints(): Checkpoints {
  return {
    load: () => Promise.resolve({ values: new Map(), alarmAtMs: null }),
    commit: () => Promise.resolve(),
    clear: () => Promise.resolve(),
  };
}

const VALUES_STORE = "kv";
const META_STORE = "meta";
const ALARM_KEY = "alarm";

/**
 * The world in IndexedDB.
 *
 * Two object stores rather than one with a reserved key: the alarm is not a
 * world key, and giving it a key in the same space means `list({ prefix: "" })`
 * would one day hand `GameServer` something that is not a checkpoint.
 *
 * Opened lazily and re-opened never. If the open fails — and it does, in a
 * private window — every call falls back to the in-memory behaviour above
 * rather than rejecting, so the caller has nothing to handle.
 */
export function idbCheckpoints(databaseName: string): Checkpoints {
  let opening: Promise<IDBDatabase | null> | null = null;

  const open = (): Promise<IDBDatabase | null> => {
    opening ??= new Promise<IDBDatabase | null>((resolve) => {
      if (typeof indexedDB === "undefined") return resolve(null);
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(databaseName, 1);
      } catch {
        return resolve(null);
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(VALUES_STORE)) {
          db.createObjectStore(VALUES_STORE);
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      // A second tab holding an older version open. Nothing is waited for: the
      // world runs in memory instead.
      request.onblocked = () => resolve(null);
    });
    return opening;
  };

  return {
    async load(): Promise<StoredWorld> {
      const db = await open();
      if (!db) return { values: new Map(), alarmAtMs: null };
      try {
        const transaction = db.transaction([VALUES_STORE, META_STORE], "readonly");
        const [keys, values, alarm] = await Promise.all([
          request(transaction.objectStore(VALUES_STORE).getAllKeys()),
          request(transaction.objectStore(VALUES_STORE).getAll()),
          request(transaction.objectStore(META_STORE).get(ALARM_KEY)),
        ]);
        const out = new Map<string, string>();
        keys.forEach((key, index) => {
          const value = values[index];
          if (typeof key === "string" && typeof value === "string") {
            out.set(key, value);
          }
        });
        return {
          values: out,
          alarmAtMs: typeof alarm === "number" ? alarm : null,
        };
      } catch (error) {
        console.error("[local] could not read the stored world", error);
        return { values: new Map(), alarmAtMs: null };
      }
    },

    async commit(batch: CheckpointBatch): Promise<void> {
      const db = await open();
      if (!db) return;
      await write(db, (transaction) => {
        const values = transaction.objectStore(VALUES_STORE);
        for (const [key, value] of batch.writes) values.put(value, key);
        for (const key of batch.deletions) values.delete(key);
        if (batch.alarmAtMs === undefined) return;
        const meta = transaction.objectStore(META_STORE);
        if (batch.alarmAtMs === null) meta.delete(ALARM_KEY);
        else meta.put(batch.alarmAtMs, ALARM_KEY);
      });
    },

    async clear(): Promise<void> {
      const db = await open();
      if (!db) return;
      await write(db, (transaction) => {
        transaction.objectStore(VALUES_STORE).clear();
        transaction.objectStore(META_STORE).clear();
      });
    },
  };
}

/**
 * Run one write transaction across both stores, and swallow what goes wrong.
 *
 * One transaction because a checkpoint is one: a reload that found the board of
 * one tick and the alarm of another would wake the world to refill a spawn
 * point that had already been refilled.
 */
function write(db: IDBDatabase, body: (transaction: IDBTransaction) => void): Promise<void> {
  return new Promise((resolve) => {
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction([VALUES_STORE, META_STORE], "readwrite");
    } catch (error) {
      console.error("[local] could not write the world down", error);
      return resolve();
    }
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => {
      console.error("[local] checkpoint failed", transaction.error);
      resolve();
    };
    try {
      body(transaction);
    } catch (error) {
      console.error("[local] checkpoint failed", error);
      transaction.abort();
    }
  });
}

/** An `IDBRequest` as a promise. Rejects, so the caller above can report once. */
function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result);
    source.onerror = () => reject(source.error ?? new Error("IndexedDB read failed"));
  });
}
