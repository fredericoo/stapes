import { DataStore, type Blobs } from "../app/lib/storage.server";
import { flattenMap } from "../app/lib/mapData";
import { GameServer } from "./GameServer";
import { SqliteBlobs, DiskBlobs } from "./blobs";
import { WorldStore } from "./WorldStore";
import { GameSocket, SocketHub, type WorldContext } from "./sockets";
import { openWorldDatabaseExclusively } from "./lock";
import { seedFromDirectory } from "./seed";
import { KEEPALIVE_INTERVAL_MS } from "../app/net/protocol";
import type { Config } from "./config";
import type { Database } from "./db";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Everything the platform used to do around `GameServer`.
 *
 * A Durable Object was handed a storage engine, a socket registry, an alarm
 * clock and a lifecycle for free. None of that was ever the world's own logic,
 * which is why none of it lives in `GameServer` — it lives here, and it is
 * about two hundred lines.
 */
export class World {
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private alarmTimer: ReturnType<typeof setTimeout> | null = null;
  private draining = false;

  private constructor(
    readonly server: GameServer,
    readonly store: WorldStore,
    readonly hub: SocketHub,
    readonly blobs: DataStore,
    private readonly rawBlobs: Blobs,
    private readonly db: Database,
    private readonly config: Config,
  ) {}

  /**
   * Open the world, refusing to be the second process to do so.
   *
   * Order matters here. The database is taken exclusively *first*, so a second
   * container fails before it can read a board it has no right to; only then is
   * anything seeded or loaded.
   */
  static async open(config: Config): Promise<World> {
    const db = await openWorldDatabaseExclusively(config.databasePath);

    // Authored content lives on disk in development, so a tileset edited in an
    // external tool is live on the next request and the editor's Save lands in
    // `data/map.json` as a reviewable diff. Deployed, it lives in the database —
    // and seeds itself from the image on first boot, which is what makes a
    // fresh environment come up playable with no seed step in the pipeline.
    const blobs = config.deployed
      ? new SqliteBlobs(db)
      : new DiskBlobs(config.SEED_DIR);
    if (blobs instanceof SqliteBlobs && (await blobs.isEmpty())) {
      await seedFromDirectory(blobs, config.SEED_DIR);
    }

    const store = new WorldStore(db);
    const hub = new SocketHub();
    const context: WorldContext = {
      storage: store,
      getWebSockets: () => hub.all(),
      acceptWebSocket: (socket) => hub.accept(socket),
    };

    const server = new GameServer(context, { dataStore: new DataStore(blobs) });
    const world = new World(
      server,
      store,
      hub,
      new DataStore(blobs),
      blobs,
      db,
      config,
    );

    await store.loadAlarm();
    world.rearmAlarm(store.alarmAt());
    store.onAlarmChange = (atMs) => world.rearmAlarm(atMs);
    world.startCheckpointing();
    world.startKeepalive();
    return world;
  }

  /**
   * Commit whatever the tick has buffered, on a fixed cadence.
   *
   * The Durable Object wrote when it felt like it and relied on the platform to
   * make an unawaited `put` durable. Nothing does that here, so this is what
   * bounds the loss from a crash nothing gets to drain — two seconds by
   * default, against the thirty the actor flush used to allow.
   *
   * An idle world costs nothing: the store knows whether anything is dirty, and
   * a board nobody has touched is the same object with nothing to re-flatten.
   */
  private startCheckpointing() {
    this.checkpointTimer = setInterval(() => {
      if (!this.store.dirty) return;
      void this.store.flush().catch((error: unknown) => {
        console.error("[world] checkpoint failed", error);
      });
    }, this.config.CHECKPOINT_INTERVAL_MS);
  }

  /**
   * Say nothing, out loud, on a fixed cadence.
   *
   * **Lives here rather than in the tick, which is the entire point.** A world
   * at rest stops ticking, so anything hung off the tick goes quiet exactly
   * when a proxy is deciding whether this connection is still alive. A player
   * standing alone in a still world would be disconnected and reconnected
   * forever, paying a full `hello` — the whole map — each time.
   */
  private startKeepalive() {
    const frame = JSON.stringify({ type: "keepalive" });
    this.keepaliveTimer = setInterval(() => {
      if (this.draining) return;
      for (const socket of this.hub.all()) socket.send(frame);
    }, KEEPALIVE_INTERVAL_MS);
  }

  /**
   * Point a timer at the next alarm.
   *
   * `GameServer` schedules respawns by asking storage to wake it at a
   * wall-clock time — an API that existed because a hibernating object has no
   * timers of its own. A process that stays up does, so this is a `setTimeout`.
   *
   * Clamped at zero rather than skipped when the deadline has already passed: a
   * world restored from a checkpoint written an hour ago has every pending
   * respawn overdue, and they should all fire on the next turn of the loop
   * rather than never.
   */
  private rearmAlarm(atMs: number | null) {
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    this.alarmTimer = null;
    if (atMs === null || this.draining) return;

    this.alarmTimer = setTimeout(
      () => {
        this.alarmTimer = null;
        void this.server.alarm().catch((error: unknown) => {
          console.error("[world] alarm failed", error);
        });
      },
      Math.max(0, atMs - Date.now()),
    );
  }

  /** Attach a freshly upgraded connection to the world. */
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
   * Write a consistent snapshot of the database beside it.
   *
   * **This has to happen in here**, and that is not a preference. The world
   * holds its database with `PRAGMA locking_mode = EXCLUSIVE`, so no other
   * process can even open the file — a cron job running `sqlite3` against the
   * volume gets `database is locked` and a backup that has never worked. The
   * process holding the lock is the only one that can take the copy.
   *
   * `VACUUM INTO` rather than copying the file: it is consistent against a
   * database being written to, which this one is, and it leaves the WAL behind
   * rather than requiring the sidecars to travel too.
   */
  async snapshot(directory: string): Promise<string> {
    await mkdir(directory, { recursive: true });
    // Flushed first, so the snapshot includes the last couple of seconds of
    // play rather than everything up to the previous checkpoint.
    await this.store.flush();
    const path = join(directory, `stapes-${stamp()}.db`);
    await this.db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
    return path;
  }

  /**
   * Make the authored content match this image, and restart the world on it.
   *
   * The boot-time seed runs only against an empty store, so a deployment's
   * `data/` stops mattering the moment the first one has run — the live world
   * goes on serving whatever was last authored in it, however many merges
   * ago that was. This is the deliberate overwrite: copy the image's `data/`
   * over the store, then replace the running world with the copied map, on the
   * editor-save path — so players keep their kit, tags, masteries and
   * positions, and only the world around them changes.
   *
   * The map is read back out of the store rather than handed straight from
   * disk so that what the world starts on is provably what the store now
   * holds — the same file a crash would reload.
   */
  async reseed(): Promise<void> {
    await seedFromDirectory(this.rawBlobs, this.config.SEED_DIR);
    const map = await this.blobs.readMap();
    await this.server.replaceWorld(flattenMap(map), { keepPositions: true });
  }

  /** Whether the world is still accepting connections. Drives `/health`. */
  get accepting(): boolean {
    return !this.draining;
  }

  get playerCount(): number {
    return this.hub.size;
  }

  /**
   * Stop cleanly, losing nothing.
   *
   * The order is the whole of it:
   *
   * 1. Stop taking connections, so nobody joins a world that is going away.
   * 2. Tell everyone, before they are disconnected, so the client can say "the
   *    world is updating" rather than showing the face it shows for a crash.
   * 3. Commit. This is the only step that must not be skipped.
   * 4. Close every socket **explicitly**, with 1012 (Service Restart). Bun
   *    terminates connections without sending close frames when the process
   *    exits (oven-sh/bun#25722), and a client that never hears the close sits
   *    on a dead socket until its own timeout instead of reconnecting into the
   *    replacement.
   *
   * Budgeted well under the `stop_grace_period` in `docker-compose.yml`. The
   * one failure that loses data here is a `SIGKILL` arriving mid-flush, which
   * is why that grace period is generous and this is quick.
   */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.checkpointTimer = null;
    this.alarmTimer = null;
    this.keepaliveTimer = null;

    const notice = JSON.stringify({ type: "serverRestarting" });
    for (const socket of this.hub.all()) socket.send(notice);

    try {
      await this.store.flush();
    } catch (error) {
      console.error("[world] final checkpoint failed", error);
    }

    for (const socket of this.hub.all()) {
      socket.close(WEBSOCKET_SERVICE_RESTART, "restarting");
    }

    await this.db.close?.();
  }
}

/** A filename-safe UTC timestamp, so a listing sorts chronologically. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "Z");
}

/** RFC 6455's Service Restart. The client treats it as "reconnect promptly". */
export const WEBSOCKET_SERVICE_RESTART = 1012;
