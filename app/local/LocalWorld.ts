import { GameServer } from "../../server/GameServer";
import {
  GameSocket,
  SocketHub,
  type WorldContext,
} from "../../server/sockets";
import { DataStore } from "../lib/dataStore";
import { KEEPALIVE_INTERVAL_MS } from "../net/protocol";
import { ApiBlobs } from "./content";
import { idbCheckpoints, type Checkpoints } from "./checkpoints";
import { LocalStore } from "./LocalStore";

/**
 * The world, in a tab.
 *
 * `server/world.ts` is everything the platform used to do around `GameServer`
 * — the checkpoint loop, the alarm timer, the keepalive and the lifecycle —
 * and this is the same two hundred lines for a runtime that has no filesystem,
 * no signals and no second process. **`GameServer` itself is imported, not
 * reimplemented**, which is the whole point: `/admin/play` runs the world, so a
 * change to the simulation cannot be true there and false here.
 *
 * What is missing from the server's version is missing because it is about
 * being a server: there is no drain (a tab closing takes the world with it and
 * the checkpoint before it is two seconds old at worst), no snapshot (nothing
 * else can open this store anyway), and no re-seed (nothing deploys here).
 */
export class LocalWorld {
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private alarmTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  private constructor(
    readonly server: GameServer,
    readonly store: LocalStore,
    readonly hub: SocketHub,
    private readonly checkpointIntervalMs: number,
  ) {}

  /**
   * Open the world.
   *
   * No lock, and nothing to enforce one with — which is the one place the
   * "exactly one process may hold the database" rule does not reach, and does
   * not need to. Each tab has its own worker, its own store and its own world;
   * two of them are two worlds rather than two writers, so there is no board
   * blended from two timelines to prevent.
   */
  static async open({
    dataStore = new DataStore(new ApiBlobs()),
    checkpoints = idbCheckpoints(LOCAL_WORLD_DATABASE),
    checkpointIntervalMs = CHECKPOINT_INTERVAL_MS,
  }: {
    dataStore?: DataStore;
    checkpoints?: Checkpoints;
    checkpointIntervalMs?: number;
  } = {}): Promise<LocalWorld> {
    const store = new LocalStore(checkpoints);
    // Before anything reads it: the world prefers its own checkpoint to the
    // authored map, and a load that ran against an empty store would put
    // everybody back at spawn on every reload.
    await store.restore();

    const hub = new SocketHub();
    const context: WorldContext = {
      storage: store,
      getWebSockets: () => hub.all(),
      acceptWebSocket: (socket) => hub.accept(socket),
    };

    const server = new GameServer(context, { dataStore });
    const world = new LocalWorld(server, store, hub, checkpointIntervalMs);

    world.rearmAlarm(store.alarmAt());
    store.onAlarmChange = (atMs) => world.rearmAlarm(atMs);
    world.startCheckpointing();
    world.startKeepalive();
    return world;
  }

  /**
   * Commit whatever the tick has buffered, on a fixed cadence.
   *
   * The same two seconds the server uses, and it bounds the same loss: a tab
   * that is closed, crashes or is discarded gives no warning, so whatever has
   * not been written down by then is gone.
   */
  private startCheckpointing() {
    this.checkpointTimer = setInterval(() => {
      if (!this.store.dirty) return;
      void this.store.flush().catch((error: unknown) => {
        console.error("[local] checkpoint failed", error);
      });
    }, this.checkpointIntervalMs);
  }

  /**
   * Say nothing, out loud, on a fixed cadence.
   *
   * Nothing between these two halves is going to time a connection out, so this
   * is not load-bearing here — it is parity. The client's message handler has a
   * branch for a keepalive and it ought to be exercised by the path everybody
   * is about to start testing on, rather than only by the one in production.
   */
  private startKeepalive() {
    const frame = JSON.stringify({ type: "keepalive" });
    this.keepaliveTimer = setInterval(() => {
      if (this.stopped) return;
      for (const socket of this.hub.all()) socket.send(frame);
    }, KEEPALIVE_INTERVAL_MS);
  }

  /**
   * Point a timer at the next alarm.
   *
   * Clamped at zero rather than skipped when the deadline has already passed,
   * exactly as the server does it — and it matters more here, because a tab
   * that was closed overnight comes back with every respawn overdue.
   */
  private rearmAlarm(atMs: number | null) {
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    this.alarmTimer = null;
    if (atMs === null || this.stopped) return;

    this.alarmTimer = setTimeout(
      () => {
        this.alarmTimer = null;
        void this.server.alarm().catch((error: unknown) => {
          console.error("[local] alarm failed", error);
        });
      },
      Math.max(0, atMs - Date.now()),
    );
  }

  async join(socket: GameSocket, actorId: string): Promise<void> {
    await this.server.join(socket, actorId);
  }

  async message(socket: GameSocket, raw: string): Promise<void> {
    await this.server.webSocketMessage(socket, raw);
  }

  async leave(socket: GameSocket): Promise<void> {
    this.hub.drop(socket);
    await this.server.webSocketClose(socket);
  }

  /**
   * Destroy every position, kit, reward and mastery, and start again on the
   * authored map.
   *
   * `POST /api/reset` without the secret, because there is nobody to keep it
   * from: the world is this tab's and nobody else is standing in it. It is the
   * one control the local world needs that the online one hides — a testing
   * path whose only way back to a known state is clearing site data is a
   * testing path people stop using.
   *
   * Nobody is disconnected: `resetWorld` sends every connected socket a fresh
   * `hello`, so the page redraws into the new world without noticing a gap.
   */
  async reset(): Promise<void> {
    await this.server.resetWorld();
  }

  /** Stop the timers. The world goes with the tab; this is for tests. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    this.checkpointTimer = null;
    this.keepaliveTimer = null;
    this.alarmTimer = null;
    await this.store.flush();
  }
}

/** The IndexedDB database the world is written down in. */
export const LOCAL_WORLD_DATABASE = "stapes-local-world";

/** Milliseconds between checkpoints. The server's `CHECKPOINT_INTERVAL_MS`. */
const CHECKPOINT_INTERVAL_MS = 2000;
