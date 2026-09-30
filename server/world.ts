import { DataStore, type Blobs } from "../app/lib/dataStore";
import { flattenMap } from "../app/lib/mapData";
import { GameServer } from "./GameServer";
import { SqliteBlobs, DiskBlobs } from "./blobs";
import { WorldStore } from "./WorldStore";
import { GameSocket, SocketHub, type WorldContext } from "./sockets";
import { openWorldDatabaseExclusively } from "./lock";
import { seedFromDirectory } from "./seed";
import { createAuth, seedAdmin, type Auth } from "./auth";
import { resolveAuthSecret } from "./authSecret";
import { Characters, type RosterEntry } from "./characters";
import { Maintenance, type MaintenanceState } from "./maintenance";
import { CLOSE_MAINTENANCE, KEEPALIVE_INTERVAL_MS } from "../app/net/protocol";
import type { Config } from "./config";
import type { Database } from "./db";
import { Feedback } from "./feedback";
import { Deaths } from "./deaths";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export type PlayerEntry = RosterEntry & {
  online: boolean;
  rating: number | null;
  deaths: number;
  kills: number;
};

export class World {
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private alarmTimer: ReturnType<typeof setTimeout> | null = null;
  private draining = false;
  private readonly adminSockets = new WeakSet<GameSocket>();
  private readonly characterOf = new WeakMap<GameSocket, string>();

  private constructor(
    readonly server: GameServer,
    readonly store: WorldStore,
    readonly hub: SocketHub,
    readonly blobs: DataStore,
    readonly auth: Auth,
    readonly characters: Characters,
    readonly maintenance: Maintenance,
    readonly feedback: Feedback,
    readonly deaths: Deaths,
    private readonly rawBlobs: Blobs,
    private readonly db: Database,
    private readonly config: Config,
  ) {}

  static async open(config: Config): Promise<World> {
    const db = await openWorldDatabaseExclusively(config.databasePath);

    const blobs = config.deployed ? new SqliteBlobs(db) : new DiskBlobs(config.SEED_DIR);
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

    const auth = createAuth(db, config, await resolveAuthSecret(db, config.AUTH_SECRET));
    const characters = new Characters(db);
    await seedAdmin(auth, db);

    const server = new GameServer(context, {
      dataStore: new DataStore(blobs),
      nameOf: (actorId) => characters.nameOf(actorId),
    });
    const world = new World(
      server,
      store,
      hub,
      new DataStore(blobs),
      auth,
      characters,
      await Maintenance.load(db),
      new Feedback(db),
      new Deaths(db),
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

  private startCheckpointing() {
    this.checkpointTimer = setInterval(() => {
      if (!this.store.dirty) return;
      void this.store.flush().catch((error: unknown) => {
        console.error("[world] checkpoint failed", error);
      });
    }, this.config.CHECKPOINT_INTERVAL_MS);
  }

  /**
   * On its own timer rather than the tick, because a world at rest stops
   * ticking and a silent connection is dropped by the proxy in front of it.
   */
  private startKeepalive() {
    const frame = JSON.stringify({ type: "keepalive" });
    this.keepaliveTimer = setInterval(() => {
      if (this.draining) return;
      for (const socket of this.hub.all()) socket.send(frame);
    }, KEEPALIVE_INTERVAL_MS);
  }

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

  async join(
    socket: GameSocket,
    characterId: string,
    { admin }: { admin: boolean },
  ): Promise<void> {
    if (admin) this.adminSockets.add(socket);
    this.characterOf.set(socket, characterId);
    await this.server.join(socket, characterId, { admin });
    if (!socket.closed) await this.characters.markSeen(characterId, Date.now());
  }

  async players(): Promise<PlayerEntry[]> {
    const [roster, ratings, { deaths, kills }] = await Promise.all([
      this.characters.roster(),
      this.server.ratings(),
      this.deaths.counts(),
    ]);
    const online = new Set(this.server.onlineActorIds());
    return roster.map((entry) => ({
      ...entry,
      online: entry.character !== null && online.has(entry.character.id),
      rating: entry.character ? (ratings.get(entry.character.id) ?? null) : null,
      deaths: entry.character ? (deaths.get(entry.character.id) ?? 0) : 0,
      kills: entry.character ? (kills.get(entry.character.id) ?? 0) : 0,
    }));
  }

  async beginMaintenance(message: string | null): Promise<MaintenanceState> {
    const state = await this.maintenance.begin(message);
    for (const socket of this.hub.all()) {
      if (this.adminSockets.has(socket)) continue;
      socket.close(CLOSE_MAINTENANCE, "maintenance");
    }
    return state;
  }

  async endMaintenance(): Promise<void> {
    await this.maintenance.end();
  }

  async message(socket: GameSocket, raw: string): Promise<void> {
    await this.server.webSocketMessage(socket, raw);
  }

  async leave(socket: GameSocket): Promise<void> {
    this.hub.drop(socket);
    await this.server.webSocketClose(socket);
    const characterId = this.characterOf.get(socket);
    if (characterId && !this.draining) await this.characters.markSeen(characterId, Date.now());
  }

  async snapshot(directory: string): Promise<string> {
    await mkdir(directory, { recursive: true });
    await this.store.flush();
    const path = join(directory, `stapes-${stamp()}.db`);
    await this.db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
    return path;
  }

  async reseed(): Promise<void> {
    await seedFromDirectory(this.rawBlobs, this.config.SEED_DIR);
    const map = await this.blobs.readMap();
    await this.server.replaceWorld(flattenMap(map), { keepPositions: true });
  }

  get accepting(): boolean {
    return !this.draining;
  }

  get playerCount(): number {
    return this.hub.size;
  }

  /**
   * A socket that closes during a drain finds the database already shut, so the
   * last-seen time of everyone still connected is written before that.
   */
  private async markEveryoneSeen() {
    const at = Date.now();
    for (const socket of this.hub.all()) {
      const characterId = this.characterOf.get(socket);
      if (!characterId) continue;
      try {
        await this.characters.markSeen(characterId, at);
      } catch (error) {
        console.error("[world] last-seen write failed", error);
      }
    }
  }

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

    await this.markEveryoneSeen();

    for (const socket of this.hub.all()) {
      socket.close(WEBSOCKET_SERVICE_RESTART, "restarting");
    }

    await this.db.close?.();
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "Z");
}

export const WEBSOCKET_SERVICE_RESTART = 1012;
