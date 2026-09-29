export type StoredWorld = {
  values: Map<string, string>;
  alarmAtMs: number | null;
};

export type CheckpointBatch = {
  writes: [string, string][];
  deletions: string[];
  alarmAtMs?: number | null;
};

export interface Checkpoints {
  load(): Promise<StoredWorld>;
  commit(batch: CheckpointBatch): Promise<void>;
  clear(): Promise<void>;
}

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
 * One transaction because a checkpoint is one: a reload that found the board
 * of one tick and the alarm of another would wake the world to refill a
 * spawn point that had already been refilled.
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

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result);
    source.onerror = () => reject(source.error ?? new Error("IndexedDB read failed"));
  });
}
