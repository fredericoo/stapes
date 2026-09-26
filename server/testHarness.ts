import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataStore } from "../app/lib/dataStore";
import { openDatabase, type Database } from "./db";
import { SqliteBlobs } from "./blobs";
import { WorldStore } from "./WorldStore";
import { GameServer } from "./GameServer";
import { GameSocket, SocketHub, type WorldContext } from "./sockets";

const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSED = 3;

export interface TestSocket {
  send(data: string): void;
  discardPending(): void;
  addEventListener(
    type: "message",
    listener: (event: { data: string }) => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: "message", listener: (event: { data: string }) => void): void;
  readonly closeCode: number | null;
  readonly closeReason: string | null;
  readonly readyState: number;
  close(): void;
}

class Pair {
  private readonly listeners = new Set<(event: { data: string }) => void>();
  private readonly queue: string[] = [];
  private draining = false;
  private isClosed = false;
  private code: number | null = null;
  private reason: string | null = null;
  readonly server: GameSocket;
  onClientMessage: ((data: string) => void) | null = null;
  onClientClose: (() => void) | null = null;

  constructor() {
    const pair = this;
    this.server = new GameSocket({
      send(data: string) {
        pair.queue.push(data);
        pair.drain();
      },
      close(code?: number, reason?: string) {
        pair.isClosed = true;
        pair.code = code ?? null;
        pair.reason = reason ?? null;
      },
      get closed() {
        return pair.isClosed;
      },
    });
  }

  /**
   * Frames are queued and handed over only once a listener exists, as a browser
   * buffers them, so a frame sent during an awaited call is still there for
   * `await thing(); await nextMessage(ws)`. Order is preserved.
   */
  drain() {
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => {
      this.draining = false;
      while (this.queue.length > 0 && this.listeners.size > 0) {
        const data = this.queue.shift()!;
        for (const listener of [...this.listeners]) listener({ data });
      }
    });
  }

  discardPending() {
    this.queue.length = 0;
  }

  get closeCode(): number | null {
    return this.code;
  }

  get closeReason(): string | null {
    return this.reason;
  }

  client(): TestSocket {
    const pair = this;
    return {
      addEventListener(_type, listener, options) {
        if (!options?.once) {
          pair.listeners.add(listener);
        } else {
          const once = (event: { data: string }) => {
            pair.listeners.delete(once);
            listener(event);
          };
          pair.listeners.add(once);
        }
        pair.drain();
      },
      removeEventListener(_type, listener) {
        pair.listeners.delete(listener);
      },
      get closeCode() {
        return pair.code;
      },
      get closeReason() {
        return pair.reason;
      },
      get readyState() {
        return pair.isClosed ? WEBSOCKET_CLOSED : WEBSOCKET_OPEN;
      },
      discardPending() {
        pair.discardPending();
      },
      send(data: string) {
        pair.onClientMessage?.(data);
      },
      close() {
        if (pair.isClosed) return;
        pair.isClosed = true;
        pair.onClientClose?.();
      },
    };
  }
}

export class Harness {
  private alarmTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    readonly server: GameServer,
    readonly store: WorldStore,
    readonly hub: SocketHub,
    readonly blobs: SqliteBlobs,
    private db: Database,
    private readonly directory: string,
    private readonly names: Readonly<Record<string, string>>,
  ) {}

  static async create(names: Readonly<Record<string, string>> = {}): Promise<Harness> {
    const directory = await mkdtemp(join(tmpdir(), "stapes-world-"));
    const db = await openDatabase(join(directory, "stapes.db"));
    const blobs = new SqliteBlobs(db);
    const store = new WorldStore(db);
    const hub = new SocketHub();

    const harness = new Harness(
      buildServer(store, hub, blobs, names),
      store,
      hub,
      blobs,
      db,
      directory,
      names,
    );
    harness.startAlarms();
    return harness;
  }

  private startAlarms() {
    this.store.onAlarmChange = (atMs) => {
      if (this.alarmTimer) clearTimeout(this.alarmTimer);
      this.alarmTimer = null;
      if (atMs === null) return;
      this.alarmTimer = setTimeout(
        () => {
          this.alarmTimer = null;
          void this.server.alarm();
        },
        Math.max(0, atMs - Date.now()),
      );
    };
  }

  evict() {
    const internals = this.server as unknown as Record<string, unknown>;
    internals.session = null;
    internals.broadcastMap = null;
    internals.checkpointedMap = null;
  }

  async restart(): Promise<Harness> {
    await this.store.flush();
    await this.db.close?.();
    this.db = await openDatabase(join(this.directory, "stapes.db"));
    const blobs = new SqliteBlobs(this.db);
    const store = new WorldStore(this.db);
    const hub = new SocketHub();
    return new Harness(
      buildServer(store, hub, blobs, this.names),
      store,
      hub,
      blobs,
      this.db,
      this.directory,
      this.names,
    );
  }

  async query(sql: string): Promise<Record<string, unknown>[]> {
    await this.store.flush();
    const statement = await this.db.prepare(sql);
    return (await statement.all()) as Record<string, unknown>[];
  }

  async dispose() {
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    await this.db.close?.();
    await rm(this.directory, { recursive: true, force: true });
  }
}

function buildServer(
  store: WorldStore,
  hub: SocketHub,
  blobs: SqliteBlobs,
  names: Readonly<Record<string, string>>,
): GameServer {
  const context: WorldContext = {
    storage: store,
    getWebSockets: () => hub.all(),
    acceptWebSocket: (socket) => hub.accept(socket),
  };
  return new GameServer(context, {
    dataStore: new DataStore(blobs),
    nameOf: async (actorId) => names[actorId] ?? null,
  });
}

export { Pair };
