import { DataStore, type Blobs } from "../app/lib/dataStore";
import { flattenMap } from "../app/lib/mapData";
import { GameServer, type CharacterSheet } from "./GameServer";
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
import { Deaths, type DeathRecord } from "./deaths";
import { Realm, type Contender, type RealmState } from "./realm";
import { TickMeter } from "./tickMeter";
import { FrameLog } from "./frameLog";
import {
  ALERT_TITLES,
  AlertBook,
  frameFinding,
  tickFindings,
  type Finding,
  type FrameTally,
} from "./alerts";
import { fireRoutine } from "./routine";
import { discordAnnouncer, logAnnouncer, type Announce } from "./discord";
import { TICK_LOG_INTERVAL_MS, TICK_LOG_KEPT_MS, TickLog } from "./tickLog";
import { generationalName } from "../app/lib/characterName";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const DEATH_LIST_LIMIT = 500;

const REALM_REFRESH_MS = 30_000;

const ROUTINE_SAMPLE_SPAN_MS = 30 * 60_000;

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
  private realmTimer: ReturnType<typeof setInterval> | null = null;
  private tickLogTimer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private readonly adminSockets = new WeakSet<GameSocket>();
  private readonly characterOf = new WeakMap<GameSocket, string>();
  private readonly alerts = new AlertBook();
  private readonly announce: Announce;

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
    readonly tickLog: TickLog,
    readonly frameLog: FrameLog,
    private readonly tickMeter: TickMeter,
    private readonly realm: Realm,
    private readonly rawBlobs: Blobs,
    private readonly db: Database,
    private readonly config: Config,
  ) {
    this.announce = config.DISCORD_ALERTS_WEBHOOK_URL
      ? discordAnnouncer(config.DISCORD_ALERTS_WEBHOOK_URL)
      : logAnnouncer;
  }

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

    const deaths = new Deaths(db);
    const tickMeter = new TickMeter();
    const server = new GameServer(context, {
      dataStore: new DataStore(blobs),
      nameOf: (actorId) => characters.nameOf(actorId),
      appearanceOf: (actorId) => characters.appearanceOf(actorId),
      deathsOf: (actorId) => deaths.countOf(actorId),
      tickMeter,
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
      deaths,
      new TickLog(db),
      new FrameLog(db),
      tickMeter,
      await Realm.load(db, store),
      blobs,
      db,
      config,
    );

    await store.loadAlarm();
    world.rearmAlarm(store.alarmAt());
    store.onAlarmChange = (atMs) => world.rearmAlarm(atMs);
    world.startCheckpointing();
    world.startKeepalive();
    await world.refreshRealm();
    world.startRealmRefresh();
    await world.frameLog.load(Date.now());
    world.startTickLog();
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

  private startRealmRefresh() {
    this.realmTimer = setInterval(() => {
      void this.refreshRealm().catch((error: unknown) => {
        console.error("[world] realm refresh failed", error);
      });
    }, REALM_REFRESH_MS);
  }

  private startTickLog() {
    this.tickLogTimer = setInterval(() => {
      void this.logTicks()
        .then(() => this.checkAlerts())
        .catch((error: unknown) => {
          console.error("[world] tick log failed", error);
        });
    }, TICK_LOG_INTERVAL_MS);
  }

  /** Writes nothing for an interval in which no tick ran, which is a world asleep. */
  async logTicks(now = Date.now()): Promise<void> {
    const window = this.tickMeter.drain();
    if (!window) return;
    await this.tickLog.add({
      ...window,
      at: now,
      players: this.playerCount,
      rssMb: Math.round(process.memoryUsage.rss() / 1_048_576),
    });
    await this.tickLog.prune(now - TICK_LOG_KEPT_MS);
  }

  /** Announces a rule when it starts firing and when it stops, and says nothing in between. */
  async checkAlerts(now = Date.now()): Promise<void> {
    const { current, baseline } = this.frameLog.tallies(now);
    const frames = frameFinding(current, baseline);
    const findings = [
      ...tickFindings(await this.tickLog.since(now - TICK_LOG_INTERVAL_MS * 5), now),
      ...(frames ? [frames] : []),
    ];
    const tallies = { current, baseline };
    const { started, cleared } = this.alerts.update(findings, now);
    const link = `${this.config.PUBLIC_ORIGIN}/admin/perf`;
    for (const finding of started) {
      const session = await this.investigate(finding, tallies, now);
      await this.announce({
        title: ALERT_TITLES[finding.rule],
        lines: [
          finding.summary,
          ...finding.detail,
          ...(session ? [`Claude Code is looking into it: ${session}`] : []),
          this.config.PUBLIC_ORIGIN,
        ],
        tone: "alert",
        link,
      });
    }
    for (const rule of cleared) {
      await this.announce({
        title: `Resolved: ${ALERT_TITLES[rule]}`,
        lines: [this.config.PUBLIC_ORIGIN],
        tone: "resolved",
        link,
      });
    }
  }

  /** Hands the finding and the samples around it to a Claude Code session, when a routine is configured. */
  private async investigate(
    finding: Finding,
    frames: { current: FrameTally; baseline: FrameTally },
    now: number,
  ): Promise<string | null> {
    const { CLAUDE_ROUTINE_FIRE_URL: fireUrl, CLAUDE_ROUTINE_TOKEN: token } = this.config;
    if (!fireUrl || !token) return null;
    const samples = await this.tickLog.since(now - ROUTINE_SAMPLE_SPAN_MS);
    const text = [
      `Alert: ${ALERT_TITLES[finding.rule]} (${finding.rule})`,
      `World: ${this.config.PUBLIC_ORIGIN}`,
      `At: ${new Date(now).toISOString()}`,
      finding.summary,
      ...finding.detail,
      "",
      `Frame tallies: ${JSON.stringify(frames)}`,
      "",
      `Tick samples, one a minute, oldest first (GET /api/perf/ticks has more):`,
      ...samples.map((sample) => JSON.stringify(sample)),
    ].join("\n");
    return fireRoutine({ fireUrl, token }, text);
  }

  async testAlert(): Promise<void> {
    await this.announce({
      title: "Test alert",
      lines: ["Sent by hand to check that alerts arrive.", this.config.PUBLIC_ORIGIN],
      tone: "test",
    });
  }

  get realmState(): RealmState {
    return this.realm.state;
  }

  async refreshRealm(): Promise<void> {
    const [roster, ratings, { deaths }] = await Promise.all([
      this.characters.roster(),
      this.server.ratings(),
      this.deaths.counts(),
    ]);
    const contenders: Contender[] = [];
    for (const { character } of roster) {
      if (!character) continue;
      const rating = ratings.get(character.id);
      if (rating === undefined) continue;
      contenders.push({
        characterId: character.id,
        name: generationalName(character.name, 1 + (deaths.get(character.id) ?? 0)),
        rating,
        createdAt: character.createdAt,
      });
    }
    this.realm.settle(contenders, Date.now());
    this.server.crown(this.realm.kingId);
  }

  async resetWorld(): Promise<void> {
    await this.server.resetWorld();
    this.realm.forget();
    await this.refreshRealm();
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
    { admin, accountId }: { admin: boolean; accountId?: string },
  ): Promise<void> {
    if (admin) this.adminSockets.add(socket);
    this.characterOf.set(socket, characterId);
    await this.server.join(socket, characterId, { admin, accountId });
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

  async player(characterId: string): Promise<{
    player: PlayerEntry;
    sheet: CharacterSheet;
    deaths: DeathRecord[];
    kills: DeathRecord[];
  } | null> {
    const entry = await this.characters.rosterEntry(characterId);
    if (!entry) return null;
    const [ratings, sheet, counts, deaths, kills] = await Promise.all([
      this.server.ratings(),
      this.server.characterSheet(characterId),
      this.deaths.counts(),
      this.deaths.of(characterId, DEATH_LIST_LIMIT),
      this.deaths.killsBy(characterId, DEATH_LIST_LIMIT),
    ]);
    return {
      player: {
        ...entry,
        online: this.server.onlineActorIds().includes(characterId),
        rating: ratings.get(characterId) ?? null,
        deaths: counts.deaths.get(characterId) ?? 0,
        kills: counts.kills.get(characterId) ?? 0,
      },
      sheet,
      deaths,
      kills,
    };
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
    if (this.realmTimer) clearInterval(this.realmTimer);
    if (this.tickLogTimer) clearInterval(this.tickLogTimer);
    this.tickLogTimer = null;
    this.checkpointTimer = null;
    this.realmTimer = null;
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
