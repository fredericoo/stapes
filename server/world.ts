import { DataStore, type Blobs } from "../app/lib/dataStore";
import { GameServer, type CharacterSheet } from "./GameServer";
import { SqliteBlobs, DiskBlobs } from "./blobs";
import { WorldStore } from "./WorldStore";
import { GameSocket, SocketHub, type WorldContext } from "./sockets";
import { openWorldDatabaseExclusively } from "./lock";
import { seedIfChanged } from "./seed";
import {
  AUTHORED_MAP_KEY,
  buildWorldMapApart,
  readPrebuiltMap,
  readPrebuiltStart,
  prebuildWorldMapApart,
  builderSourceHash,
  hashOf,
  type AuthoredMap,
} from "./worldMap";
import { StackPool } from "../app/lib/stackPool";
import { parseSharedMap } from "../app/lib/mapData";
import { createAuth, seedAdmin, type Auth } from "./auth";
import { resolveAuthSecret } from "./authSecret";
import { Characters, type RosterEntry } from "./characters";
import { Maintenance, type MaintenanceState } from "./maintenance";
import { CLOSE_MAINTENANCE, KEEPALIVE_INTERVAL_MS } from "../app/net/protocol";
import type { Config } from "./config";
import type { Database } from "./db";
import { Feedback } from "./feedback";
import { Deaths, type DeathRecord } from "./deaths";
import { leadersOf, type Contender, type RealmState } from "./realm";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const DEATH_LIST_LIMIT = 500;

const REALM_REFRESH_MS = 30_000;

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
  private draining = false;
  private restartAtMs: number | null = null;
  private realm: RealmState = { leaders: [] };
  private readonly adminSockets = new WeakSet<GameSocket>();
  private readonly characterOf = new WeakMap<GameSocket, string>();
  /** Builds run one at a time, so two saves cannot write the map out of order. */
  private building: Promise<unknown> = Promise.resolve();

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

    const blobs = config.deployed
      ? new SqliteBlobs(db)
      : new DiskBlobs(config.SEED_DIR, { "world.json": config.SEED_TREE });
    if (blobs instanceof SqliteBlobs) await seedIfChanged(blobs, config.SEED_DIR, config.SEED_TREE);

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
    const server = new GameServer(context, {
      dataStore: new DataStore(blobs),
      nameOf: (actorId) => characters.nameOf(actorId),
      appearanceOf: (actorId) => characters.appearanceOf(actorId),
      weather: config.WEATHER,
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
      blobs,
      db,
      config,
    );

    await world.buildAuthoredMap(undefined, { fresh: true });
    await store.loadAlarm();
    world.rearmAlarm(store.alarmAt());
    store.onAlarmChange = (atMs) => world.rearmAlarm(atMs);
    world.startCheckpointing();
    world.startKeepalive();
    await world.refreshRealm();
    world.startRealmRefresh();
    return world;
  }

  private startCheckpointing() {
    this.checkpointTimer = setInterval(() => {
      this.server.settleResidency();
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

  get realmState(): RealmState {
    return this.realm;
  }

  async refreshRealm(): Promise<void> {
    const [roster, ratings] = await Promise.all([this.characters.roster(), this.server.ratings()]);
    const contenders: Contender[] = [];
    for (const { character } of roster) {
      if (!character) continue;
      const rating = ratings.get(character.id);
      if (rating === undefined) continue;
      contenders.push({
        characterId: character.id,
        name: character.name,
        rating,
        createdAt: character.createdAt,
      });
    }
    this.realm = { leaders: leadersOf(contenders) };
  }

  async resetWorld(): Promise<void> {
    await this.server.resetWorld();
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
    if (this.restartAtMs !== null) socket.send(restartNotice(this.restartAtMs - Date.now()));
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

  /**
   * A new image seeds itself at start, so on a deploy this finds nothing left
   * to do. On disk the store is the directory, so there is nothing to copy.
   */
  async reseed(): Promise<void> {
    const seeded =
      !(this.rawBlobs instanceof SqliteBlobs) ||
      (await seedIfChanged(this.rawBlobs, this.config.SEED_DIR, this.config.SEED_TREE));
    const replaced = await this.buildAuthoredMap();
    if (seeded && !replaced) await this.server.reloadContent();
  }

  /**
   * Replaces the board with the map the world's tree builds. At start
   * (`fresh`) it always does, so a world never plays a board it saved: what
   * players left lying about, picked or opened goes back to the tree's on
   * every start. Otherwise it builds only when the tree, the tile catalogue or
   * the builder's source changed, and replaces the board only when the map came
   * out different. Players keep their kit, and their positions unless the
   * world is marked to forget them.
   *
   * `proposed` is a tree to save: it is stored only once its map has started a
   * world, so a tree that cannot start one never becomes the tree the next
   * start builds. Returns whether the board was replaced.
   */
  buildAuthoredMap(
    proposed?: string,
    { fresh = false }: { fresh?: boolean } = {},
  ): Promise<boolean> {
    const next = this.building.then(() => this.buildAuthoredMapNow(proposed, fresh));
    this.building = next.catch(() => false);
    return next;
  }

  private async buildAuthoredMapNow(
    proposed: string | undefined,
    fresh: boolean,
  ): Promise<boolean> {
    const tree = proposed ?? (await this.blobs.readTreeText());
    if (tree === null) return false;
    const tiles = (await this.blobs.readTilesText()) ?? "[]";
    const inputs = hashOf(tree, tiles, await builderSourceHash());
    const recorded = await this.store.get<AuthoredMap>(AUTHORED_MAP_KEY);
    const unchanged = recorded?.inputs === inputs;
    let replaced = false;
    if (!fresh && unchanged) {
      if (proposed !== undefined) await this.blobs.writeTreeText(proposed);
      return false;
    }
    const prepared = proposed === undefined ? await this.preparedStart(inputs) : null;
    if (prepared) {
      console.log("[world] read the map and the starting rows prepared from the tree");
      if (recorded?.map !== prepared.hash) {
        /** Stored first and let go of, so the map text and the new board are never held together. */
        await this.blobs.writeMapFile(prepared.mapPath, () => readFile(prepared.mapPath, "utf8"));
      }
      if (fresh || recorded?.map !== prepared.hash) {
        await this.server.replaceWorld(prepared.start, { keepPositions: true });
        replaced = true;
      }
      await this.store.put(AUTHORED_MAP_KEY, { inputs, map: prepared.hash } satisfies AuthoredMap);
    } else {
      const stored = unchanged && proposed === undefined ? await this.blobs.readMapText() : null;
      const built =
        stored === null
          ? await this.buildMap(tree, tiles, inputs)
          : { hash: hashOf(stored), text: stored };
      if (fresh || recorded?.map !== built.hash) {
        await this.server.replaceWorld(parseSharedMap(built.text, new StackPool()), {
          keepPositions: true,
          text: built.text,
        });
        replaced = true;
      }
      await this.store.put(AUTHORED_MAP_KEY, { inputs, map: built.hash } satisfies AuthoredMap);
    }
    if (proposed !== undefined) await this.blobs.writeTreeText(proposed);
    await this.store.flush();
    return replaced;
  }

  /**
   * The rows to start the world from: the image's, or on a dev server, whose
   * store is the seed directory itself, ones it prepares beside its database
   * so a restart streams them instead of parsing the whole map.
   */
  private async preparedStart(inputs: string) {
    const { SEED_DIR, SEED_TREE, DATA_DIR } = this.config;
    const traits = await this.blobs.readTraits();
    const fromImage = await readPrebuiltStart(SEED_DIR, SEED_TREE, inputs, traits);
    if (fromImage || this.rawBlobs instanceof SqliteBlobs) return fromImage;
    const cached = await readPrebuiltStart(DATA_DIR, SEED_TREE, inputs, traits);
    if (cached) return cached;
    const started = performance.now();
    for (const problem of await prebuildWorldMapApart(SEED_DIR, SEED_TREE, DATA_DIR)) {
      console.warn(`[world] ${problem.key} was left out of the map: ${problem.reason}`);
    }
    console.log(
      `[world] prepared the map from its tree in ${Math.round(performance.now() - started)} ms`,
    );
    return readPrebuiltStart(DATA_DIR, SEED_TREE, inputs, traits);
  }

  /** A map the image built from the same inputs is used instead of building it here. */
  private async buildMap(
    tree: string,
    tiles: string,
    inputs: string,
  ): Promise<{ hash: string; text: string }> {
    const started = performance.now();
    const prebuilt = await readPrebuiltMap(this.config.SEED_DIR, this.config.SEED_TREE, inputs);
    let text: string;
    if (prebuilt === null) {
      const built = await buildWorldMapApart(tree, tiles, join(this.config.DATA_DIR, "builds"));
      for (const problem of built.problems) {
        console.warn(`[world] ${problem.key} was left out of the map: ${problem.reason}`);
      }
      text = built.text;
    } else {
      text = prebuilt;
    }
    console.log(
      `[world] ${prebuilt === null ? "built the map from its tree" : "read the map the image built"} in ${Math.round(performance.now() - started)} ms`,
    );
    return { hash: hashOf(text), text };
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

  /**
   * The world keeps running through the notice, so what players do in those
   * seconds is saved by the drain that follows.
   */
  async drainAfterNotice(): Promise<void> {
    const noticeMs = this.config.restartNoticeMs;
    if (noticeMs > 0 && this.hub.size > 0 && !this.draining && this.restartAtMs === null) {
      this.restartAtMs = Date.now() + noticeMs;
      const notice = restartNotice(noticeMs);
      for (const socket of this.hub.all()) socket.send(notice);
      await new Promise((resolve) => setTimeout(resolve, noticeMs));
    }
    await this.drain();
  }

  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    if (this.realmTimer) clearInterval(this.realmTimer);
    this.checkpointTimer = null;
    this.realmTimer = null;
    this.alarmTimer = null;
    this.keepaliveTimer = null;

    const notice = JSON.stringify({ type: "serverRestarting" });
    for (const socket of this.hub.all()) socket.send(notice);

    /**
     * `GameServer` writes actors and the board to the store every thirty
     * seconds, so a flush alone commits a world up to that much out of date.
     */
    try {
      this.server.saveEveryActor();
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

function restartNotice(inMs: number): string {
  return JSON.stringify({ type: "serverRestarting", inMs: Math.max(0, Math.round(inMs)) });
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "Z");
}

export const WEBSOCKET_SERVICE_RESTART = 1012;
