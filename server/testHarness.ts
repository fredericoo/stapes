import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataStore } from "../app/lib/storage.server";
import { openDatabase, type Database } from "./db";
import { SqliteBlobs } from "./blobs";
import { WorldStore } from "./WorldStore";
import { GameServer } from "./GameServer";
import { GameSocket, SocketHub, type WorldContext } from "./sockets";

/**
 * Harness for `GameServer.test.ts`: a real database file in a temporary
 * directory rather than a stub, and a local socket pair whose client half
 * exposes the `addEventListener("message")` shape the suite waits on.
 */

/** `WebSocket.OPEN` and `WebSocket.CLOSED`, without needing the global. */
const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSED = 3;

/** The client end of a connection, shaped like the browser's `WebSocket`. */
export interface TestSocket {
  send(data: string): void;
  /** Forget anything sent but not yet taken, so what follows is only what is next. */
  discardPending(): void;
  addEventListener(
    type: "message",
    listener: (event: { data: string }) => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: "message", listener: (event: { data: string }) => void): void;
  readonly closeCode: number | null;
  readonly closeReason: string | null;
  /**
   * `WebSocket.OPEN` until this half closes. `RemoteSession.sendRaw` drops
   * anything sent on a socket that is not open, so a client without this never
   * speaks.
   */
  readonly readyState: number;
  close(): void;
}

class Pair {
  private readonly listeners = new Set<(event: { data: string }) => void>();
  /** Frames the world has sent that nobody has taken yet. */
  private readonly queue: string[] = [];
  private draining = false;
  private isClosed = false;
  private code: number | null = null;
  private reason: string | null = null;
  readonly server: GameSocket;
  /** Wired by the suite's `connect`, so the client half can talk back. */
  onClientMessage: ((data: string) => void) | null = null;
  /**
   * Wired alongside it. A tab closing is a different event from a person
   * leaving (`dropSocket` distinguishes them), so the client half's `close`
   * has to reach the world.
   */
  onClientClose: (() => void) | null = null;

  constructor() {
    // `pair` rather than `this`: the transport is an object literal, and a
    // getter written inside one is about the literal.
    const pair = this;
    this.server = new GameSocket({
      send(data: string) {
        // Queued, not delivered to current listeners; see `drain`.
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
   * Hand queued frames to whoever is listening, oldest first.
   *
   * A browser buffers frames as they arrive and gives them to the page when it
   * next runs, so a frame sent during a call the test awaited is still there
   * once the test attaches its listener. Delivering straight to whoever happens
   * to be listening drops it instead, and `await thing(); await
   * nextMessage(ws)` — which most of this suite is built from — fails for a
   * reason that has nothing to do with the world.
   *
   * Order is preserved, which the death tests depend on: the patch that empties
   * somebody has to reach them before the death that follows it.
   *
   * A test that wants to watch only what comes *next* says so with
   * {@link discardPending}.
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

  /** Forget anything sent but not yet taken. See `record` in the suite. */
  discardPending() {
    this.queue.length = 0;
  }

  get closeCode(): number | null {
    return this.code;
  }

  get closeReason(): string | null {
    return this.reason;
  }

  /** The browser-shaped half the suite listens on. */
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
        // Whatever arrived while nothing was listening is still waiting.
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

/** One world, plus everything needed to talk to it. */
export class Harness {
  private alarmTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    readonly server: GameServer,
    readonly store: WorldStore,
    readonly hub: SocketHub,
    readonly blobs: SqliteBlobs,
    private db: Database,
    private readonly directory: string,
  ) {}

  static async create(): Promise<Harness> {
    const directory = await mkdtemp(join(tmpdir(), "stapes-world-"));
    const db = await openDatabase(join(directory, "stapes.db"));
    const blobs = new SqliteBlobs(db);
    const store = new WorldStore(db);
    const hub = new SocketHub();

    const harness = new Harness(
      buildServer(store, hub, blobs),
      store,
      hub,
      blobs,
      db,
      directory,
    );
    harness.startAlarms();
    return harness;
  }

  /**
   * Fire the world's alarm when it comes due.
   *
   * `GameServer` schedules a refill by asking storage to wake it at a
   * wall-clock time; if nobody is listening the deadline passes and every
   * respawn test measures nothing. `server/world.ts` does the same thing in
   * production, and this is the same few lines rather than a stub.
   */
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

  /**
   * Throw away the world in memory without touching storage or sockets, which
   * is what a process restart does, and a restart happens on every deploy.
   */
  evict() {
    const internals = this.server as unknown as Record<string, unknown>;
    internals.session = null;
    internals.broadcastMap = null;
    internals.checkpointedMap = null;
  }

  /** Restart the process, as far as the world can tell. */
  async restart(): Promise<Harness> {
    await this.store.flush();
    await this.db.close?.();
    this.db = await openDatabase(join(this.directory, "stapes.db"));
    const blobs = new SqliteBlobs(this.db);
    const store = new WorldStore(this.db);
    const hub = new SocketHub();
    return new Harness(
      buildServer(store, hub, blobs),
      store,
      hub,
      blobs,
      this.db,
      this.directory,
    );
  }

  /**
   * Read rows straight out of the database. `WorldStore.sql.exec` queues
   * statements for the next batch and cannot answer a read, so reads come
   * through here, flushing first: what the tests ask about is what has been
   * written.
   */
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
): GameServer {
  const context: WorldContext = {
    storage: store,
    getWebSockets: () => hub.all(),
    acceptWebSocket: (socket) => hub.accept(socket),
  };
  return new GameServer(context, { dataStore: new DataStore(blobs) });
}

export { Pair };
