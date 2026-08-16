import { DurableObject } from "cloudflare:workers";
import {
  GameSession,
  type ActorPosition,
  type ActorSnapshot,
} from "../app/game/GameSession";
import { TICK_MS, WALK_DURATION_MS } from "../app/game/constants";
import { cellKey } from "../app/game/pressurePlates";
import {
  findSpawnPoints,
  isSpawnFilled,
  rollRespawnDelayMs,
  type SpawnPoint,
} from "../app/game/respawn";
import {
  type Equipment,
  emptyEquipment,
  restoredEquipment,
} from "../app/game/equipment";
import { resolveRespawn } from "../app/lib/interactions";
import { minutesOfDayAt } from "../app/lib/clock";
import {
  changedCellsOnLevel,
  chunkifyMap,
  flattenMap,
  getStack,
} from "../app/lib/mapData";
import { dataStoreFor, type DataStore } from "../app/lib/storage.server";
import { tilesByIdFromList } from "../app/lib/validation";
import type {
  Direction,
  FlatMapFile,
  MapFile,
  TileDef,
} from "../app/lib/types";
import { MAX_LEVEL, MIN_LEVEL, parseCoordKey } from "../app/lib/types";
import { CHAT_MIN_INTERVAL_MS, sanitizeChatText } from "../app/net/chat";
import {
  parseClientMessage,
  type CarriedLightsPatch,
  type CellPatch,
  type HpPatch,
  type MotionEvent,
  type ServerMessage,
} from "../app/net/protocol";

/** Key under which the running world is checkpointed when it goes idle. */
const CHECKPOINT_KEY = "world";

/**
 * Key under which the world's spawn points are kept.
 *
 * Stored rather than re-derived because only a *fresh* world can answer the
 * question: deriving spawn points needs a map every one of them is filled in,
 * and a resumed checkpoint is missing exactly the placements that have died —
 * the ones a derivation would silently forget. Written when a world first
 * loads from the authored map and whenever the editor saves one; read on every
 * resume.
 */
const RESPAWN_POINTS_KEY = "respawnPoints";

/**
 * Key under which pending respawn deadlines are kept, as spawn-point key →
 * epoch ms.
 *
 * Wall-clock and durable where decay's deadlines are simulated and in-memory,
 * because the two make opposite promises: decay swears a world nobody visits
 * does not age, respawn swears a world nobody visits *recovers*. A deadline
 * that only advanced while somebody was connected would leave a cleared camp
 * cleared until someone stood around waiting for it — the alarm below is what
 * lets the world repopulate in its sleep.
 */
const RESPAWN_PENDING_KEY = "respawnPending";

/**
 * How long a blocked respawn waits before trying its cell again.
 *
 * Blocked means the authored placement no longer fits — somebody has stacked a
 * crate to the ceiling, say. Unlike a blocked decay this is retried rather
 * than abandoned: a mess left un-tidied is a smaller wrong than a monster that
 * never comes back.
 */
const RESPAWN_RETRY_MS = 5_000;

/** Everybody's hit points right now, for a client that has nothing to diff. */
function currentHps(actors: ActorSnapshot[]): HpPatch[] {
  const out: HpPatch[] = [];
  for (const actor of actors) {
    if (actor.hp === null || actor.maxHp === null) continue;
    out.push({ actorId: actor.id, hp: actor.hp, maxHp: actor.maxHp });
  }
  return out;
}

/**
 * Everybody's carried lights right now, for a client that has nothing to diff.
 *
 * Only the actors carrying one, which is almost nobody: an empty list is the
 * absence of an entry, and saying so for every deer in the world would be the
 * one part of `hello` that grew with the population for no reason.
 */
function currentCarriedLights(actors: ActorSnapshot[]): CarriedLightsPatch[] {
  const out: CarriedLightsPatch[] = [];
  for (const actor of actors) {
    if (actor.carriedLights.length === 0) continue;
    out.push({ actorId: actor.id, tileIds: actor.carriedLights });
  }
  return out;
}

/**
 * How many messages the log keeps.
 *
 * Nothing reads this table yet, which is exactly why it needs a ceiling: an
 * append-only store with no reader and no deletion path is the one thing in this
 * object that grows without bound, and a Durable Object's disk is finite. Pruned
 * on insert rather than on a timer so it cannot be forgotten when a reader
 * finally arrives.
 */
export const CHAT_LOG_MAX_ROWS = 5_000;

/**
 * How many un-taken steps one actor may have waiting.
 *
 * A predicting client is half a round trip ahead of this object by design, so
 * its next intent routinely arrives while the last one is still being walked —
 * without somewhere to put it, every step would be refused and the world would
 * be unwalkable. Two deep, so a pair of intents bunched by jitter into the same
 * tick both survive.
 *
 * It is not a speed control and does not need to be: steps are only ever taken
 * by an idle actor, so a client flooding this queue still walks at one cell per
 * {@link WALK_DURATION_MS}. The cap is here so a client cannot make the queue
 * itself grow.
 */
const MAX_QUEUED_STEPS = 2;

/** Key prefix under which one actor's last known position is kept. */
const POSITION_KEY_PREFIX = "pos:";

/**
 * Key prefix under which one actor's last known kit is kept.
 *
 * Its own key rather than a field on the position, because the two are not the
 * same fact and are not always both there: a creature has a position and no kit,
 * and the ceiling below prunes them independently.
 */
const EQUIPMENT_KEY_PREFIX = "equip:";

/**
 * How many actors the world remembers the whereabouts of.
 *
 * One entry per player who has ever connected — it grows with *visitors*, not
 * with activity, which is a slow leak rather than a fast one and therefore the
 * kind that is still there in a year. Identity is a cookie anybody can mint, so
 * the ceiling is a defence as well as housekeeping. Least-recently-saved goes
 * first: the entries being dropped are the ones whose owner has not been seen
 * in longest, which is the closest thing here to "will not be missed".
 */
export const MAX_REMEMBERED_ACTORS = 1_000;

/**
 * How often positions are written out while the world is being played.
 *
 * The floor on how much a crash can cost somebody, and the whole reason this is
 * not simply left to the idle checkpoint: a busy world never settles, so an
 * object that died mid-session would hand everybody back the position they had
 * when the room was last empty. Five seconds is a couple of rooms' walking.
 */
const ACTOR_FLUSH_INTERVAL_MS = 5_000;

/**
 * Where somebody was standing, kept against their return.
 *
 * `savedAt` is here for the ceiling rather than for gameplay — see
 * {@link MAX_REMEMBERED_ACTORS}.
 */
type SavedPosition = ActorPosition & { savedAt: number };

/**
 * What somebody was carrying, kept against their return.
 *
 * Written wherever a position is, and that pairing is deliberate rather than
 * convenient: the two are one answer to "who was here and what did they have",
 * and saving them at different moments would be the way to lose one without the
 * other.
 *
 * **And in the same batch as the board.** Picking something up takes it off the
 * map and puts it in a bag, so a kit made durable against a map that was not
 * would come back to a floor still holding the very thing it claims. That is an
 * item existing twice, which is a bug with no natural ceiling, so the checkpoint
 * rides along in {@link GameServer.saveActors} rather than waiting for the world
 * to settle. It costs a map serialization per flush in a world where something
 * is happening — and nothing at all in one where the map has not changed, which
 * copy-on-write makes a reference compare.
 */
type SavedEquipment = { equipment: Equipment; savedAt: number };

type Attachment = { actorId: string };

/** A step a client says it has taken, waiting for this side to agree. */
type QueuedStep = {
  seq: number;
  direction: Direction;
  preferDescend: boolean;
};

/**
 * A world that has already been run.
 *
 * The spawn point travels with the map because it cannot be recovered from it:
 * starting a session consumes the authored `player` tile that marks it, so a
 * checkpointed map has no marker left to read.
 */
type Checkpoint = {
  map: FlatMapFile;
  spawn: { x: number; y: number; z: number; stackIndex: number };
  /**
   * The world's dice, mid-roll. Travels for the same reason the spawn point
   * does — it cannot be recovered from the map — and resuming without it would
   * have every wake replay the wander the world had already played.
   *
   * Optional because checkpoints written before brains existed do not carry
   * one; those worlds simply start rolling from the default.
   */
  seed?: number;
  /**
   * Whose bodies were killed and must not be handed back.
   *
   * Carried for the same reason the spawn point is — it cannot be recovered from
   * the map, because the whole evidence of a death is a tile that is *not*
   * there. Without it the first hibernation wake would look at a dead player's
   * still-open socket, find them missing from the board, and seat them again:
   * every death undone by an eviction nobody noticed.
   *
   * Optional because checkpoints written before combat existed have none.
   */
  dead?: string[];
};

/**
 * What the last broadcast told clients about one actor's motion, so a started
 * walk is announced once rather than every tick it is still running.
 *
 * Compared by object identity: motion state is mutated in place as it advances,
 * so a new object *is* a new motion.
 */
type SentMotion = {
  walk: unknown;
  fall: unknown;
  slide: unknown;
};

/**
 * The authoritative game world.
 *
 * One instance, addressed by name — the world is the coordination atom here, so
 * a single Durable Object is the model rather than the usual global-DO
 * anti-pattern. It does mean concurrent players are capped by what one object
 * can tick.
 */
export class GameServer extends DurableObject<Env> {
  private session: GameSession | null = null;
  private tiles: TileDef[] = [];
  /** Map identity the last broadcast was diffed against. */
  private broadcastMap: MapFile | null = null;
  private sentMotion = new Map<string, SentMotion>();
  /**
   * The hit points each client has been told about, so an unchanged bar costs
   * nothing on the wire. Same discipline as {@link broadcastMap}: everyone is at
   * the same version, so one diff serves every socket.
   */
  private sentHp = new Map<string, number>();
  /**
   * The carried lights each client has been told about, joined into one string
   * per actor.
   *
   * A string rather than the array, because what is compared here is "is this
   * the same answer as last time" and the arrays are rebuilt whenever a kit
   * changes. Comparing by identity would re-broadcast a lantern every time
   * somebody moved a sword between two pockets.
   */
  private sentCarriedLights = new Map<string, string>();
  private events: MotionEvent[] = [];
  /** Steps clients say they have taken, oldest first, per actor. */
  private readonly queuedSteps = new Map<string, QueuedStep[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private loading: Promise<void> | null = null;
  /** Where `data/` is served in dev, told to us by whoever called in. */
  private dataOrigin: string | null = null;
  /** When each actor last said something, for the rate limit. */
  private lastSaidAt = new Map<string, number>();
  /** When positions were last written out. See {@link saveActorsIfDue}. */
  private actorsSavedAt = 0;
  /**
   * The map the last checkpoint was taken of, by identity.
   *
   * The map is copy-on-write, so a world nobody has touched is the same object
   * and there is nothing to re-flatten — which is what keeps a five-second flush
   * from serializing thousands of cells for a room where everyone is standing
   * still. Sound because storage writes are ordered: a later batch cannot be
   * durable while the batch holding the map it was read against is not.
   */
  private checkpointedMap: MapFile | null = null;
  /** Whether the chat table has been created in this instance's lifetime. */
  private chatLogReady = false;
  /**
   * Actors whose bodies were killed, and who are therefore not to be given
   * another one.
   *
   * There is no respawn, so a dead player sits there connected and inert until
   * they reload — and reloading is what clears them from here, because a fresh
   * socket is a fresh body by definition. Checkpointed, so an eviction in the
   * meantime does not quietly resurrect them.
   */
  private dead = new Set<string>();
  /** Where the world grows things back, by spawn-point key. */
  private respawnPoints = new Map<string, SpawnPoint>();
  /**
   * Object spawn points by their authored cell, for the changed-cell sweep.
   *
   * Objects only: a creature's disappearance is a death and arrives through
   * {@link noteDeaths}, while an object's is a pickup and arrives as nothing
   * but a changed cell. Indexed so a busy tick pays per changed cell rather
   * than per spawn point.
   */
  private respawnPointsByCell = new Map<string, SpawnPoint[]>();
  /** Spawn points waiting to refill, as key → wall-clock deadline. */
  private respawnPending = new Map<string, number>();

  /**
   * Find authored content.
   *
   * The origin is remembered from whoever called in, because in dev the answer
   * is only knowable from a request: under `pnpm dev` the file middleware lives
   * on the Vite server's own origin, and the object has no way to name it.
   * Without it the object fell back to R2 while every loader read `data/` on
   * disk, so it ran the world against whatever a past `pnpm seed` left in the
   * bucket. `pnpm dev:worker` sets `DATA_ORIGIN`, which takes priority, and
   * production ignores both and takes R2.
   *
   * Both ways in carry it — {@link replaceWorld} from the editor's save, and
   * the socket handshake from `workers/app.ts`. The save alone was not enough:
   * it only holds for as long as this object stays in memory, so the first
   * reload after an eviction went back to the bucket. That is a divergence
   * nothing announces — the map comes from the checkpoint and is current, while
   * the tile defs are a seed old, so an object authored since is on the board
   * and inert, its interactions belonging to a tile this side has never heard
   * of.
   *
   * The handshake origin is the host the client reached, so it is only ever
   * consulted in dev — `workers/app.ts` does not send it otherwise, and
   * {@link dataStoreFor} would ignore it in a production build regardless.
   */
  private store(): DataStore {
    return dataStoreFor(this.env, this.dataOrigin ?? undefined);
  }

  /**
   * Bring the world into memory, once.
   *
   * Prefers the checkpoint over R2: the checkpoint holds where everyone was
   * standing when the world last went quiet, and restoring from the authored
   * map instead would teleport a room full of idle players back to spawn just
   * because the object was evicted.
   */
  private async ensureLoaded(): Promise<void> {
    if (this.session) return;
    this.loading ??= this.load();
    try {
      await this.loading;
    } finally {
      // Cleared even when the load threw. A rejected promise left in place is
      // handed to every later caller for as long as this object stays in
      // memory, so a world that failed to load once goes on failing long after
      // whatever broke it was put right — the retry never happens.
      this.loading = null;
    }
  }

  private async load() {
    const store = this.store();
    this.tiles = await store.readTiles();

    const checkpoint = await this.ctx.storage.get<Checkpoint>(CHECKPOINT_KEY);
    // No actors either way: connections spawn their own. On a fresh world the
    // authored `player` tile is only the marker saying where, and starting the
    // session consumes it.
    this.session = checkpoint
      ? new GameSession(
          chunkifyMap(checkpoint.map),
          this.tiles,
          [],
          checkpoint.spawn,
          checkpoint.seed,
        )
      : new GameSession(await store.readMap(), this.tiles, []);
    this.dead = new Set(checkpoint?.dead ?? []);
    this.broadcastMap = this.session.getMap();
    await this.restoreActors();
    await this.pruneRemembered();
    await this.loadRespawnState(checkpoint != null);
  }

  /**
   * Bring the spawn points and their deadlines into memory, and make sure
   * every empty point owes something.
   *
   * A fresh world derives its points from the map it just opened — the one
   * map every point is guaranteed filled in — and writes them down; a resumed
   * one reads them back, because its own map is missing exactly the placements
   * that died. A resumed world written before respawn existed has nothing
   * stored and derives from the live map as the best available truth: points
   * whose tenant was already dead are lost until the next editor save, but
   * nothing is ever invented, which is the failure mode that matters — a
   * misderived point would grow a duplicate.
   *
   * The arming pass at the end is what makes the whole system self-healing: a
   * death or pickup whose deadline never reached storage — the object was
   * evicted in between — reads here as "empty, owing nothing" and is simply
   * armed afresh, at the cost of one extra wait.
   */
  private async loadRespawnState(resumed: boolean) {
    const session = this.session;
    if (!session) return;
    const tilesById = tilesByIdFromList(this.tiles);

    const stored = resumed
      ? await this.ctx.storage.get<SpawnPoint[]>(RESPAWN_POINTS_KEY)
      : undefined;
    // A stored point whose tile has left the catalogue, or stopped respawning,
    // is the author changing their mind — honoured here because the registry
    // outlives the tiles it was derived against.
    const points = (
      stored ?? findSpawnPoints(session.getMap(), tilesById)
    ).filter((point) => {
      const def = tilesById[point.placed.tileId];
      return def != null && resolveRespawn(def) != null;
    });
    this.setRespawnPoints(points);
    if (!stored) this.persistRespawnPoints();

    const pending = await this.ctx.storage.get<Record<string, number>>(
      RESPAWN_PENDING_KEY,
    );
    this.respawnPending = new Map(
      Object.entries(pending ?? {}).filter(([key]) =>
        this.respawnPoints.has(key),
      ),
    );

    const nowMs = Date.now();
    for (const point of this.respawnPoints.values()) {
      if (this.respawnPending.has(point.key)) continue;
      if (isSpawnFilled(session.getMap(), point)) continue;
      this.respawnPending.set(
        point.key,
        nowMs + rollRespawnDelayMs(point.respawn),
      );
    }
    this.persistRespawnPending();
    this.scheduleRespawnAlarm();
  }

  /** Adopt a fresh registry, rebuilding the per-cell index beside it. */
  private setRespawnPoints(points: SpawnPoint[]) {
    this.respawnPoints = new Map(points.map((point) => [point.key, point]));
    this.respawnPointsByCell = new Map();
    for (const point of points) {
      if (point.ownerId) continue;
      const key = cellKey(point.cell);
      const list = this.respawnPointsByCell.get(key) ?? [];
      list.push(point);
      this.respawnPointsByCell.set(key, list);
    }
  }

  private persistRespawnPoints() {
    this.ctx.storage
      .put(RESPAWN_POINTS_KEY, [...this.respawnPoints.values()], {
        allowUnconfirmed: true,
      })
      .catch(() => {});
  }

  private persistRespawnPending() {
    this.ctx.storage
      .put(RESPAWN_PENDING_KEY, Object.fromEntries(this.respawnPending), {
        allowUnconfirmed: true,
      })
      .catch(() => {});
  }

  /**
   * Keep the Durable Object alarm pointed at the soonest deadline.
   *
   * The alarm is what divorces respawn from the tick loop: it fires with the
   * world hibernated and nobody connected, which is exactly when a wall-clock
   * promise has to be kept. While the world *is* ticking the tick gets there
   * first and the alarm wakes to nothing owed, which is harmless.
   */
  private scheduleRespawnAlarm() {
    if (this.respawnPending.size === 0) {
      this.ctx.storage.deleteAlarm().catch(() => {});
      return;
    }
    this.ctx.storage
      .setAlarm(Math.min(...this.respawnPending.values()))
      .catch(() => {});
  }

  /**
   * Start a deadline for an emptied spawn point, if none is running.
   *
   * The wait is drawn when the point empties and kept — same discipline as a
   * decay lifetime, and for the same reason: re-rolling on every look would
   * let a busy cell keep re-drawing its future.
   */
  private armRespawn(point: SpawnPoint, nowMs: number) {
    if (this.respawnPending.has(point.key)) return;
    this.respawnPending.set(point.key, nowMs + rollRespawnDelayMs(point.respawn));
    this.persistRespawnPending();
    this.scheduleRespawnAlarm();
  }

  /**
   * Refill every spawn point whose time has come.
   *
   * Runs on the tick while the world is awake and from {@link alarm} while it
   * is not; both paths are idempotent because a settled debt leaves the
   * pending map. A refused refill — the cell no longer has room — is pushed
   * back {@link RESPAWN_RETRY_MS} rather than dropped.
   */
  private processDueRespawns(nowMs: number) {
    const session = this.session;
    if (!session || this.respawnPending.size === 0) return;

    let dirty = false;
    for (const [key, dueAtMs] of this.respawnPending) {
      if (dueAtMs > nowMs) continue;
      dirty = true;
      const point = this.respawnPoints.get(key);
      if (!point) {
        this.respawnPending.delete(key);
        continue;
      }
      if (session.respawnAt(point)) {
        this.respawnPending.delete(key);
        // The old death is spent the moment a new body exists. Left in place
        // it would only be a leak — nothing seats a creature by id — but the
        // set is checkpointed, and a record that no longer records anything
        // has no business surviving the world that wrote it.
        this.dead.delete(key);
      } else {
        this.respawnPending.set(key, nowMs + RESPAWN_RETRY_MS);
      }
    }
    if (dirty) {
      this.persistRespawnPending();
      this.scheduleRespawnAlarm();
    }
  }

  /**
   * Notice objects that have left their authored cell.
   *
   * Creatures announce their deaths; a picked-up sword announces nothing but a
   * changed cell, so the cells this tick changed are checked against the
   * object spawn points that live in them. Bounded by the tick's own diff —
   * a quiet tick checks nothing.
   */
  private sweepRespawnCells(cells: CellPatch[]) {
    const session = this.session;
    if (!session || this.respawnPointsByCell.size === 0) return;
    const nowMs = Date.now();
    for (const cell of cells) {
      const points = this.respawnPointsByCell.get(cellKey(cell));
      if (!points) continue;
      for (const point of points) {
        if (this.respawnPending.has(point.key)) continue;
        if (isSpawnFilled(session.getMap(), point)) continue;
        this.armRespawn(point, nowMs);
      }
    }
  }

  /**
   * The wall-clock half of respawn: fires at the soonest deadline, however
   * long the world has been asleep.
   *
   * Waking the tick loop is deliberate rather than lazy — the loop already
   * knows how to diff the board, broadcast the patch, settle plates under
   * whatever just appeared and checkpoint the result, and a world with nobody
   * in it settles and goes straight back to sleep.
   */
  async alarm() {
    await this.ensureLoaded();
    this.processDueRespawns(Date.now());
    this.wake();
  }

  /**
   * Re-seat the actors whose sockets survived eviction, and clear out the rest.
   *
   * Hibernation drops in-memory state but not the connections, so after a wake
   * the sockets are still there and their ids are on the attachments. A
   * checkpointed map also still holds everyone's *tile*, so `spawn` re-seats
   * them on the body they already have rather than minting a second.
   *
   * Anyone in the map without a socket is gone for good — their connection died
   * while the object was evicted, so no close ever ran. Their body is reaped
   * here; nothing else would ever remove it.
   *
   * The remembered position is consulted for the same reason it is on a fresh
   * join, and it is not redundant with the checkpoint: a socket can outlive the
   * world its owner's body was in — the editor's save replaces the map and
   * drops the checkpoint — and without this those players would come back from
   * the next wake standing at spawn.
   */
  private async restoreActors() {
    const live: string[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment) live.push(attachment.actorId);
    }
    this.session?.reapAbsentActors(live);
    for (const id of live) {
      // A socket belonging to somebody who died stays open and stays empty.
      // Seating them here is exactly the resurrection the checkpointed set of
      // the dead exists to prevent.
      if (this.dead.has(id)) continue;
      this.session?.spawn(
        id,
        await this.lastPositionOf(id),
        await this.lastEquipmentOf(id),
      );
    }
  }

  private positionKey(actorId: string): string {
    return `${POSITION_KEY_PREFIX}${actorId}`;
  }

  private equipmentKey(actorId: string): string {
    return `${EQUIPMENT_KEY_PREFIX}${actorId}`;
  }

  /**
   * What this actor had on them when the world last saw them, if it remembers.
   *
   * Checked against the tiles this world has *now* rather than trusted: what was
   * written is a kit from some earlier version of the authored content, and a
   * sword that has since become a prop is a memory the board no longer agrees
   * with. Undefined for somebody new, which {@link GameSession.spawn} reads as
   * "give them the starting kit".
   */
  private async lastEquipmentOf(
    actorId: string,
  ): Promise<Equipment | undefined> {
    const saved = await this.ctx.storage.get<SavedEquipment>(
      this.equipmentKey(actorId),
    );
    if (!saved?.equipment) return undefined;
    return restoredEquipment(saved.equipment, tilesByIdFromList(this.tiles));
  }

  /**
   * Where this actor was when the world last saw them, if it remembers.
   *
   * Undefined for somebody new, and undefined is exactly right: {@link spawn}
   * reads it as "no wish", and puts them in at the spawn point.
   */
  private async lastPositionOf(
    actorId: string,
  ): Promise<ActorPosition | undefined> {
    const saved = await this.ctx.storage.get<SavedPosition>(
      this.positionKey(actorId),
    );
    if (!saved) return undefined;
    return { x: saved.x, y: saved.y, z: saved.z, direction: saved.direction };
  }

  /**
   * Write down where everybody is, what they are carrying and the board they
   * are standing on — in one batch, without the tick waiting on it.
   *
   * **One batch is the point**, not an economy. A kit and the map are two halves
   * of the same fact once picking something up moves it between them, and making
   * one durable without the other is how an item comes to exist twice.
   *
   * `allowUnconfirmed` is the other load-bearing part. A Durable Object normally
   * holds every outgoing message until the writes that preceded it are durable,
   * so that nobody can observe state that a failed write would roll back — and
   * that is the right default for anything the world's consistency rests on.
   * This is not that: what is written here is *behind* what has already been
   * broadcast either way, so gating output on it would buy nothing and cost the
   * whole world's latency thirty times a second. What matters is that these
   * entries land together, which one `put` guarantees regardless.
   *
   * The rejection is swallowed for the same reason: there is nothing useful to
   * do about a position that did not stick, and an unhandled rejection here
   * would take the world down over it.
   */
  private saveActors(actorIds: Iterable<string>) {
    const session = this.session;
    if (!session) return;

    const savedAt = Date.now();
    const entries: Record<string, SavedPosition | SavedEquipment | Checkpoint> =
      {};
    for (const actorId of actorIds) {
      const at = session.actorPosition(actorId);
      if (!at) continue;
      entries[this.positionKey(actorId)] = { ...at, savedAt };
      // In the same write as the position, so the two facts about a player
      // cannot land in different storage batches and disagree about which
      // moment they describe.
      //
      // Only a kit with something in it. Every deer in the world has an empty
      // one, and a key per creature per world would be the ceiling below spent
      // on remembering that a deer is still carrying nothing.
      const equipment = session.equipmentOf(actorId);
      if (equipment?.weapon || equipment?.bag) {
        entries[this.equipmentKey(actorId)] = { equipment, savedAt };
      }
    }

    // The board, in the same batch as the kits read off it. **This is what
    // stops an item existing twice.** Picking something up takes it off the map
    // and puts it in a bag, so a kit made durable against a map that was not
    // would come back to a floor still holding the thing it claims. One write,
    // one moment, and the two cannot disagree.
    const map = session.getMap();
    if (map !== this.checkpointedMap) {
      entries[CHECKPOINT_KEY] = {
        map: flattenMap(map),
        spawn: session.getSpawnPoint(),
        seed: session.getSeed(),
        dead: [...this.dead],
      };
      this.checkpointedMap = map;
    }

    if (Object.keys(entries).length === 0) return;

    this.ctx.storage.put(entries, { allowUnconfirmed: true }).catch(() => {});
  }

  /**
   * Save everyone, at most once every {@link ACTOR_FLUSH_INTERVAL_MS}.
   *
   * Throttled rather than per-tick because the position of a walking actor
   * changes on a tick that already has a diff and a broadcast to pay for, and
   * writing it there would put a storage call on the busiest frames to record
   * something that will be superseded 200ms later.
   */
  private saveActorsIfDue() {
    const session = this.session;
    if (!session) return;
    const now = Date.now();
    if (now - this.actorsSavedAt < ACTOR_FLUSH_INTERVAL_MS) return;
    // Stamped whether or not anything was written, so an empty world costs one
    // comparison per tick rather than a walk of its actor table.
    this.actorsSavedAt = now;
    this.saveActors(session.actorIds());
  }

  /**
   * Drop what the world remembers about the people it has not seen in longest.
   *
   * On load, because that is the one moment this object is already doing async
   * I/O with nothing waiting on a tick — and it runs once per instance rather
   * than once per wake, since an object that is already in memory does not
   * reload.
   *
   * Each prefix is capped on its own rather than the two being reconciled. They
   * hold different populations — everybody has a position and only players have
   * a kit — so pairing them would mean deciding what a kit with no position
   * means, for a saving that is one comparison.
   */
  private async pruneRemembered() {
    await this.pruneOldest(POSITION_KEY_PREFIX);
    await this.pruneOldest(EQUIPMENT_KEY_PREFIX);
  }

  /**
   * Keep the {@link MAX_REMEMBERED_ACTORS} most recently saved of one prefix.
   *
   * Least-recently-saved goes first: the entries being dropped belong to whoever
   * has not been seen in longest, which is the closest thing here to "will not
   * be missed".
   */
  private async pruneOldest(prefix: string) {
    const stored = await this.ctx.storage.list<{ savedAt: number }>({ prefix });
    if (stored.size <= MAX_REMEMBERED_ACTORS) return;

    const oldestFirst = [...stored].sort(
      ([, a], [, b]) => a.savedAt - b.savedAt,
    );
    const doomed = oldestFirst
      .slice(0, stored.size - MAX_REMEMBERED_ACTORS)
      .map(([key]) => key);
    await this.ctx.storage.delete(doomed);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }
    const params = new URL(request.url).searchParams;
    const actorId = params.get("actor");
    if (!actorId) return new Response("Missing actor", { status: 400 });

    // Before the world is loaded, which is the whole point of taking it here: a
    // socket is what wakes an evicted object, and loading without an origin
    // reads authored content out of R2 instead of off disk. See {@link store}.
    const dataOrigin = params.get("dataOrigin");
    if (dataOrigin) this.dataOrigin = dataOrigin;

    const pair = new WebSocketPair();
    const [client, server] = [pair[0]!, pair[1]!];
    // acceptWebSocket rather than accept(): lets the object be evicted while
    // connections stay open, which is what makes an idle world free.
    //
    // Accepted *before* the world is loaded, and the order matters. This
    // request is usually what wakes an evicted object, and loading reaps any
    // actor in the checkpoint with no socket — so loading first would find this
    // actor connectionless, throw away the body the checkpoint was keeping for
    // them, and put them back at spawn. Every reconnect after a hibernation
    // would silently lose its position. Messages arriving in the gap are safe:
    // `webSocketMessage` loads for itself.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ actorId } satisfies Attachment);

    await this.ensureLoaded();

    const session = this.session!;
    // A new socket is a reload, and a reload is how somebody comes back from
    // being killed: there is no respawn, so this is the only thing that hands a
    // dead actor a body again.
    this.dead.delete(actorId);
    // Rejoining with the same id keeps the actor already on the board; the
    // remembered position is for somebody whose body is gone — they left, or
    // their connection died while this object was evicted and they were reaped.
    session.spawn(
      actorId,
      await this.lastPositionOf(actorId),
      await this.lastEquipmentOf(actorId),
    );
    this.events.push({
      kind: "joined",
      actorId,
      playerCount: this.playerCount(),
    });

    this.sendHello(server, actorId);
    // A join moves the board, so it has to be broadcast even if nobody is
    // pressing anything.
    this.wake();

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * How many people are in the world.
   *
   * Distinct actor ids rather than sockets: identity is a cookie, so two tabs
   * are one person with one body on the board, and counting connections would
   * put them on the bar twice. Counted from the sockets rather than from the
   * session, because the session's actors include the creatures living on the
   * map and nothing there tells a deer from a player.
   *
   * @param excluding the socket on its way out. A closing connection is still
   *   listed here, and the person it carried has already gone — though their id
   *   stays counted if they still have another tab open.
   */
  private playerCount(excluding?: WebSocket): number {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === excluding) continue;
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment) ids.add(attachment.actorId);
    }
    return ids.size;
  }

  /**
   * Whether this actor is still connected by some other socket.
   *
   * The closing socket is still listed by `getWebSockets` while its close is
   * being handled — same as in {@link playerCount} — so it has to be excluded
   * by identity rather than by its attachment, which is indistinguishable from
   * the ones that are staying.
   */
  private hasOtherSocket(closing: WebSocket, actorId: string): boolean {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === closing) continue;
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment?.actorId === actorId) return true;
    }
    return false;
  }

  private sendHello(ws: WebSocket, actorId: string) {
    const session = this.session!;
    const actors = session.actorSnapshots();
    const message: ServerMessage = {
      type: "hello",
      selfId: actorId,
      map: flattenMap(session.getMap()),
      actorIds: session.actorIds(),
      hps: currentHps(actors),
      carriedLights: currentCarriedLights(actors),
      // Theirs alone, and sent in full here for the same reason the map and the
      // hit points are: a joiner has nothing to patch against.
      equipment: session.equipmentOf(actorId) ?? emptyEquipment(),
      playerCount: this.playerCount(),
      // Read here rather than tracked: time of day is a function of the
      // server's clock, so it costs nothing to keep and cannot fall behind
      // while the object is hibernating.
      minutesOfDay: minutesOfDayAt(Date.now()),
    };
    ws.send(JSON.stringify(message));
    // This socket is now current as of the map it was just sent, but the
    // broadcast diff is shared — so leave broadcastMap alone and let the next
    // patch be a no-op for them rather than replaying it.
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string") return;
    await this.ensureLoaded();

    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) return;

    const message = parseClientMessage(raw);
    if (!message) return;

    const session = this.session!;
    const { actorId } = attachment;
    if (!session.actorIds().includes(actorId)) return;

    if (message.type === "say") {
      // Sent inline rather than queued into `events`, which is patch-scoped and
      // shared by everyone.
      //
      // This used to return without waking, on the grounds that talking does
      // not move the board — true of the words, and no longer true of what
      // hearing them can start. A brain gets one turn to notice an utterance, so
      // an idle world has to tick at least once more or the call is simply never
      // heard. The cost that comment was guarding against does not follow: what
      // holds the loop open is one brain tick, not the five seconds the bubble
      // hangs there, and `sleepIfIdle` puts the world straight back under.
      this.say(actorId, message.text);
      this.wake();
      return;
    }

    if (message.type === "step") {
      this.queueStep(actorId, message);
    } else if (message.type === "face") {
      session.faceActor(actorId, message.direction);
    } else if (message.type === "target") {
      // Not validated here beyond the schema. Whether the named actor exists,
      // is a battler, or is anywhere near is re-asked on every swing — it has to
      // be, because all three change while both parties walk around.
      session.setTarget(message.actorId, actorId);
    } else if (message.type === "attackMode") {
      // The wake below matters more here than for a target: a world at rest
      // stays at rest while somebody merely points at a deer, and turning this
      // on beside them is exactly the moment the clock has to start again.
      session.setAttackMode(message.enabled, actorId);
    } else if (message.type === "pickUp") {
      // Re-validated against the board and against the actor's own kit, on the
      // same terms as any other affordance: the client offered the row from
      // these rules, but it decided on a map that may be a round trip old and a
      // bag that may have filled up since.
      session.pickUp(message.ref, actorId);
    } else if (message.type === "moveItem") {
      // Every rule asked again here, reach above all: a ground endpoint names a
      // container the client had a panel open on, and the panel may have been
      // open while its owner walked away from it. The client offered the drag
      // from these same rules, and is still not trusted with the answer.
      session.moveItem(message.from, message.to, actorId);
    } else if (message.type === "drop") {
      // Range, sight and room in the stack, all re-asked. The client drew a
      // ghost from these same rules, but it drew it on a board that may be a
      // round trip old — and somebody else may have filled that cell since.
      session.drop(message.from, message.to, actorId);
    } else {
      // Re-validated against the board rather than trusted: the client decided
      // to offer this affordance from the same rules, but it decided on a map
      // that may be a round trip old.
      session.interact(message.ref, actorId);
    }

    this.flushEquipment();
    this.wake();
  }

  /**
   * Tell anybody whose kit changed what they are carrying now.
   *
   * One message per affected socket rather than a field on the broadcast patch,
   * and that is what keeps the patch cheap: a patch is diffed once and
   * serialized once for everybody, which only works because everybody is being
   * told the same thing. Equipment differs per player, so folding it in would
   * turn one serialization per tick into one per player — for something nobody
   * else can see, since there is no paperdoll.
   *
   * Called wherever a kit can change rather than only on the tick, because a
   * pickup happens *between* ticks: it is input, and the world may be asleep
   * when it arrives. Draining is idempotent, so calling it twice costs a set
   * lookup and sends nothing.
   */
  private flushEquipment() {
    const session = this.session;
    if (!session) return;
    const changed = session.drainEquipmentChanges();
    if (changed.length === 0) return;

    const wanted = new Set(changed);
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (!attachment || !wanted.has(attachment.actorId)) continue;
      const equipment = session.equipmentOf(attachment.actorId);
      // Gone between the change and the flush — a body that died still had its
      // kit changed, and there is nobody left to tell.
      if (!equipment) continue;
      ws.send(JSON.stringify({ type: "equipment", equipment } satisfies ServerMessage));
    }
  }

  /**
   * Hold a step until the actor is free to take it.
   *
   * Never taken here, always on a tick — see {@link applyQueuedSteps} for why
   * the moment matters.
   */
  private queueStep(actorId: string, step: QueuedStep) {
    const queue = this.queuedSteps.get(actorId) ?? [];
    if (queue.length >= MAX_QUEUED_STEPS) {
      // Further ahead than any honest client gets. Refusing the newest rather
      // than dropping the oldest keeps what is queued a contiguous run of steps,
      // which is the only thing the client can roll back cleanly.
      this.rejectStep(actorId, step.seq);
      return;
    }
    queue.push(step);
    this.queuedSteps.set(actorId, queue);
  }

  /**
   * Take the steps clients are waiting on, at the one moment in the tick where
   * taking them costs nothing.
   *
   * Immediately after the simulation, because that is where a walk that just
   * finished releases its actor. Held input has always started the next step
   * inside the same tick that committed the last one, and a queued step has to
   * land in that same slot: leave it until the following tick and every step
   * pays a tick of dead time, the server falls a tick further behind its client
   * with each cell walked, and the drift shows up as the client's prediction
   * running away.
   *
   * Before {@link collectMotionEvents}, so a walk started here is announced in
   * the patch this tick is already sending.
   */
  private applyQueuedSteps() {
    const session = this.session;
    if (!session) return;

    for (const [actorId, queue] of this.queuedSteps) {
      while (queue.length > 0) {
        const step = queue[0]!;
        const outcome = session.requestStep(actorId, step.direction, {
          preferDescend: step.preferDescend,
        });
        // Still walking off the last one. Everything behind it waits too —
        // steps are a sequence, and taking them out of order would walk the
        // actor somewhere neither side asked for.
        if (outcome === "later") break;

        queue.shift();
        if (outcome === "refused") this.rejectStep(actorId, step.seq);
        // Started: the actor is now busy, so anything left waits for the tick
        // that finishes this walk.
        if (outcome === "started") break;
      }
      if (queue.length === 0) this.queuedSteps.delete(actorId);
    }
  }

  /** Tell one client a step it drew never happened. */
  private rejectStep(actorId: string, seq: number) {
    this.sendTo(actorId, { type: "stepRejected", seq });
  }

  /** Send to one actor's socket, if they still have one. */
  private sendTo(actorId: string, message: ServerMessage) {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment?.actorId !== actorId) continue;
      try {
        ws.send(payload);
      } catch {
        // Died between the check and the send; webSocketClose will tidy up.
      }
      return;
    }
  }

  /**
   * Say something, to the people standing on the same floor.
   *
   * Every drop here is silent. A refused message has no honest thing to tell the
   * sender — the rate limit is a defence rather than a rule anybody agreed to,
   * and "your text became empty after stripping" is not worth a round trip — so
   * the field simply clears and nothing appears.
   */
  private say(actorId: string, raw: string) {
    const now = Date.now();
    const last = this.lastSaidAt.get(actorId);
    if (last !== undefined && now - last < CHAT_MIN_INTERVAL_MS) return;

    const text = sanitizeChatText(raw);
    if (!text) return;

    // One call, and the location memo behind it means this is a cell lookup per
    // actor rather than a sweep — the same discipline the tick loop uses.
    const actors = this.session!.actorSnapshots();
    const author = actors.find((actor) => actor.id === actorId);
    if (!author) return;

    this.lastSaidAt.set(actorId, now);
    // The simulation hears the same sanitised line the room does, and hears it
    // before it is broadcast so that a creature answering on the very next tick
    // cannot have its reply overtake the call that caused it.
    this.session!.hear(actorId, text);
    this.broadcastChat(actors, {
      actorId,
      tileId: author.tileId,
      text,
      x: author.x,
      y: author.y,
      z: author.z,
      stackIndex: author.stackIndex,
    });
  }

  /**
   * Say the things creatures said this tick.
   *
   * Drained after {@link GameSession.tick}, then sent on exactly the path a
   * player's message takes — the sanitising and the per-cell cap happened
   * already, the first inside the session and the second on every client, so
   * this only has to fan out and log. No rate limit: an NPC's speech is authored
   * and deterministic, and its `onEnter` fires once per entry rather than as
   * fast as a socket can type.
   */
  private broadcastSpeech(session: GameSession, actors: ActorSnapshot[]) {
    for (const bubble of session.drainSpeech()) {
      this.broadcastChat(actors, bubble);
    }
  }

  /**
   * Fan one bubble out to its level and keep it.
   *
   * The tail shared by a player saying something and a creature saying
   * something: by here the text is settled and where it hangs is decided, and
   * all that is left is who hears it and writing it down.
   */
  private broadcastChat(
    actors: ActorSnapshot[],
    at: {
      actorId: string;
      tileId: string;
      text: string;
      x: number;
      y: number;
      z: number;
      stackIndex: number;
    },
  ) {
    const message: ServerMessage = { type: "chat", ...at };
    this.sendToLevel(at.z, actors, message);
    this.logChat(Date.now(), at.actorId, at, at.text);
  }

  /**
   * Send to everyone standing on one level.
   *
   * Serialized once for the level, not once per socket: the payload is the same
   * for all of them, and the only thing being decided per socket is whether it
   * is theirs to receive.
   */
  private sendToLevel(
    z: number,
    actors: ActorSnapshot[],
    message: ServerMessage,
  ) {
    const levelById = new Map(actors.map((actor) => [actor.id, actor.z]));
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (!attachment) continue;
      if (levelById.get(attachment.actorId) !== z) continue;
      try {
        ws.send(payload);
      } catch {
        // Died between the check and the send; webSocketClose will tidy up.
      }
    }
  }

  /**
   * Keep what was said.
   *
   * Write-only for now — there is no log on screen and nothing queries this. It
   * exists so the history is not lost before anything wants it, which makes the
   * row cap the load-bearing part rather than an afterthought.
   */
  private logChat(
    atMs: number,
    actorId: string,
    at: { x: number; y: number; z: number },
    text: string,
  ) {
    const sql = this.ctx.storage.sql;
    if (!this.chatLogReady) {
      sql.exec(
        `CREATE TABLE IF NOT EXISTS chat (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at INTEGER NOT NULL,
          actor TEXT NOT NULL,
          x INTEGER NOT NULL,
          y INTEGER NOT NULL,
          z INTEGER NOT NULL,
          text TEXT NOT NULL
        )`,
      );
      this.chatLogReady = true;
    }
    sql.exec(
      "INSERT INTO chat (at, actor, x, y, z, text) VALUES (?, ?, ?, ?, ?, ?)",
      atMs,
      actorId,
      at.x,
      at.y,
      at.z,
      text,
    );
    sql.exec(
      "DELETE FROM chat WHERE id <= (SELECT MAX(id) FROM chat) - ?",
      CHAT_LOG_MAX_ROWS,
    );
  }

  async webSocketClose(ws: WebSocket) {
    await this.dropSocket(ws);
  }

  async webSocketError(ws: WebSocket) {
    await this.dropSocket(ws);
  }

  private async dropSocket(ws: WebSocket) {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) return;
    await this.ensureLoaded();

    // Somebody is still driving this actor, so nothing here applies to them:
    // their body stays, their queued steps stay, and nobody is told they left.
    //
    // **This is what a reload looks like from in here.** A closing socket is
    // not the same event as a person leaving, and the two come apart in the one
    // moment that matters most: a browser opening its new connection before the
    // old one's close has been delivered. Despawning on the socket rather than
    // on the actor took the body out from under the connection that had just
    // replaced it — leaving a client that was told it had a body, watching a
    // world it was no longer in, with every message it sent dropped by the
    // `actorIds` gate in {@link webSocketMessage}. There is no recovery from
    // that short of another reload, which races exactly the same way.
    //
    // Two tabs are the ordinary version of the same thing: identity is a
    // cookie, so they are one person with one body, and shutting one must not
    // take the body away from the other.
    if (this.hasOtherSocket(ws, attachment.actorId)) return;

    // Before the despawn, which is what takes their tile — and with it the only
    // record of where they were — off the board.
    this.saveActors([attachment.actorId]);
    this.session?.despawn(attachment.actorId);
    this.sentMotion.delete(attachment.actorId);
    this.queuedSteps.delete(attachment.actorId);
    this.lastSaidAt.delete(attachment.actorId);
    this.events.push({
      kind: "left",
      actorId: attachment.actorId,
      playerCount: this.playerCount(ws),
    });
    // Their tile just left the board, so the removal has to reach everyone else.
    this.wake();
  }

  /**
   * Replace the world and start a fresh game. Called by the map editor's save.
   *
   * The map persisted is the one the editor sent, never the running one: the
   * running map carries an `owner` on every actor's tile, and those have no
   * business in an authored file.
   *
   * `dataOrigin` is the editor's own origin — see {@link store} for why the
   * object cannot work that out for itself in dev.
   *
   * **Nothing is persisted until the new world has been proved to start, and
   * the running one is never loaded to get here.** Both halves of that are
   * load-bearing, and the order they used to be in cost a live world.
   *
   * A map with no `player` tile has no spawn point, so `new GameSession` throws
   * on it. That used to happen *after* the map had been written and the
   * checkpoint deleted — so one save of a map whose marker had been erased
   * persisted the unstartable map and destroyed the only startable copy left.
   * From then on every load threw, and because this method began by loading,
   * the editor could no longer save the very fix that would have repaired it:
   * placing the marker back required a world that could not come up. The world
   * was unreachable and the one tool that could mend it was locked behind it.
   *
   * So the session is built first, from the incoming map, and storage is only
   * touched once it exists. A bad save now fails having changed nothing, and
   * the save path stays usable on a world too broken to load — which is exactly
   * when it is needed. Nothing here reads the old session: the tiles are re-read
   * and every actor is re-seated below, so loading it was only ever a way for
   * its failures to become this one's.
   */
  async replaceWorld(flat: FlatMapFile, dataOrigin?: string): Promise<void> {
    if (dataOrigin) this.dataOrigin = dataOrigin;
    const store = this.store();
    const tiles = await store.readTiles();

    const map = chunkifyMap(flat);
    // Throws for a map that cannot start — before a single byte is written.
    const session = new GameSession(map, tiles, []);

    await store.writeMap(map);
    await this.ctx.storage.delete(CHECKPOINT_KEY);

    // Read off the outgoing session, and read *here* — this is the last moment
    // it exists, and it holds the only copy of anybody's kit that is newer than
    // the last five-second flush. A player who picked something up four seconds
    // before somebody hit save is carrying it only in memory.
    const carried = new Map<string, Equipment>();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (!attachment) continue;
      const kit = this.session?.equipmentOf(attachment.actorId);
      if (kit) carried.set(attachment.actorId, kit);
    }

    this.tiles = tiles;
    this.session = session;
    this.broadcastMap = this.session.getMap();
    // A save is a fresh statement of what belongs where, so the registry is
    // re-derived wholesale and every running deadline with it: the point a
    // deadline was counting toward may no longer exist, and one that does
    // exist again — the author placed the creature back by hand — owes
    // nothing. Read off the new session rather than the incoming file so the
    // creature identities are the adopted ones.
    this.setRespawnPoints(
      findSpawnPoints(session.getMap(), tilesByIdFromList(tiles)),
    );
    this.respawnPending.clear();
    this.persistRespawnPoints();
    this.persistRespawnPending();
    this.scheduleRespawnAlarm();
    this.sentMotion.clear();
    this.sentHp.clear();
    // A new world is a clean slate for the dead as much as for the living:
    // everyone still connected is seated in it below, so holding a grudge from
    // the world that no longer exists would leave somebody permanently absent
    // from one they never died in.
    this.dead.clear();
    this.lastSaidAt.clear();
    // Every queued step was aimed at a board that no longer exists. They are
    // dropped rather than refused: the `hello` below resets each client's
    // prediction wholesale, so there is nothing left to roll back.
    this.queuedSteps.clear();
    this.events = [];

    // Everyone still connected re-enters the new world at its spawn point,
    // carrying what they were carrying.
    //
    // **A save re-creates the world, not the people in it.** Items on the floor
    // coming back is the whole point of authoring them there — the map is the
    // map, and saving it is how an author puts a sword back. What is in
    // somebody's bag is not the map: nobody authored it, it is not in the file
    // that was just written, and there is nothing in a save that says anything
    // about it. Seating them with the starting kit read the one as the other and
    // emptied every connected player's pockets, and the flush five seconds later
    // wrote that emptiness over the only record of what they had.
    //
    // Checked against the new tiles on the way in, on the same terms
    // {@link lastEquipmentOf} checks a remembered one: the save may have brought
    // a new catalogue with it, and a sword that has become a prop in it is a kit
    // this world no longer agrees with. Storage is the fallback for the world
    // that was too broken to have a session at all.
    const tilesById = tilesByIdFromList(tiles);
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (!attachment) continue;
      const kit = carried.get(attachment.actorId);
      this.session.spawn(
        attachment.actorId,
        undefined,
        kit
          ? restoredEquipment(kit, tilesById)
          : await this.lastEquipmentOf(attachment.actorId),
      );
    }
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment) this.sendHello(ws, attachment.actorId);
    }
    this.wake();
  }

  /**
   * Start ticking, if it is not already.
   *
   * `setInterval` blocks hibernation, which is exactly why it only runs while
   * there is something to simulate — see {@link sleepIfIdle}.
   */
  private wake() {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /**
   * Stop ticking once the world settles, and checkpoint where everyone is.
   *
   * The checkpoint is what makes hibernation invisible: without it an evicted
   * object would reload the authored map and drop every actor back at spawn.
   */
  private sleepIfIdle() {
    const session = this.session;
    if (!session || !session.isAtRest()) return;
    // A world with steps still waiting is not at rest, whatever the board says:
    // stopping the tick loop here would leave them unclaimed until the next
    // message woke it, and the actor would stand still through a held key.
    if (this.queuedSteps.size > 0) return;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // The last thing that happens before this object may be evicted, and the
    // only chance to record the people whose sockets will not survive it: a
    // connection that dies during hibernation runs no close, so the wake reaps
    // its body without ever hearing about it.
    this.saveActors(session.actorIds());
  }

  private tick() {
    const session = this.session;
    if (!session) return;

    session.tick(TICK_MS);
    this.applyQueuedSteps();
    // Before the diff below, so a refill rides the same patch as everything
    // else this tick did.
    this.processDueRespawns(Date.now());

    const actors = session.actorSnapshots();
    this.collectMotionEvents(actors);
    this.collectDamageEvents(session);
    this.noteDeaths(session);
    this.broadcastSpeech(session, actors);

    const cells = this.diffCells(session.getMap());
    this.sweepRespawnCells(cells);
    const hps = this.diffHps(actors);
    const carriedLights = this.diffCarriedLights(actors);
    if (
      cells.length > 0 ||
      this.events.length > 0 ||
      hps.length > 0 ||
      carriedLights.length > 0
    ) {
      this.broadcast({
        type: "patch",
        cells,
        events: this.events,
        hps,
        carriedLights,
      });
      this.broadcastMap = session.getMap();
      this.events = [];
    }

    // A kit can change on a tick as well as on input — nothing does that yet,
    // but a brain that picks something up will, and the alternative is finding
    // out by way of a panel that never updates.
    this.flushEquipment();
    this.saveActorsIfDue();
    this.sleepIfIdle();
  }

  /**
   * Turn newly-started motion into events.
   *
   * Identity, not equality: `walk` is mutated in place as it advances, so the
   * same object across two ticks is the same walk and must not be announced
   * twice.
   */
  private collectMotionEvents(actors: ActorSnapshot[]) {
    const live = new Set<string>();
    for (const actor of actors) {
      live.add(actor.id);
      const sent = this.sentMotion.get(actor.id);

      if (actor.walk && actor.walk !== sent?.walk) {
        this.events.push({
          kind: "walkStarted",
          actorId: actor.id,
          from: actor.walk.from,
          to: actor.walk.to,
          direction: actor.walk.direction,
        });
      }
      if (actor.fall && actor.fall !== sent?.fall) {
        this.events.push({
          kind: "fallStarted",
          actorId: actor.id,
          feetAbs: actor.fall.feetAbs,
          landingAbs: actor.fall.landingAbs,
        });
      }
      if (actor.slide && actor.slide !== sent?.slide) {
        this.events.push({
          kind: "slideStarted",
          actorId: actor.id,
          object: actor.slide.object,
          from: actor.slide.from,
        });
      }

      this.sentMotion.set(actor.id, {
        walk: actor.walk,
        fall: actor.fall,
        slide: actor.slide,
      });
    }
    for (const id of this.sentMotion.keys()) {
      if (!live.has(id)) this.sentMotion.delete(id);
    }
  }

  /**
   * Note whoever was killed, and stop holding anything on their behalf.
   *
   * No event goes out: the cell patch that removes their tile is the whole of
   * the news, and every client already draws an actor by finding their body on
   * the board. What this is for is the *server's* own state — a queued step
   * aimed by a body that no longer exists, and above all the record that keeps
   * them off the board across a wake.
   *
   * Creatures land in the set too, harmlessly: nothing ever spawns one by id, so
   * their entry is inert. Filtering them out would mean asking the session which
   * of its actors was wildlife, to save a handful of strings.
   */
  private noteDeaths(session: GameSession) {
    for (const actorId of session.drainDeaths()) {
      this.dead.add(actorId);
      this.sentMotion.delete(actorId);
      this.sentHp.delete(actorId);
      this.queuedSteps.delete(actorId);
      // A dead resident with a spawn point is not gone, only owed: the clock
      // on its return starts with the death itself.
      const point = this.respawnPoints.get(actorId);
      if (point) this.armRespawn(point, Date.now());
    }
  }

  /**
   * Turn this tick's blows into events.
   *
   * Drained rather than diffed, unlike hit points: a blow is not recoverable
   * from two readings of a health bar — three hits in one tick leave one new
   * total and owe three numbers.
   */
  private collectDamageEvents(session: GameSession) {
    for (const hit of session.drainDamage()) {
      this.events.push({
        kind: "damage",
        id: hit.id,
        targetId: hit.targetId,
        amount: hit.amount,
        x: hit.x,
        y: hit.y,
        z: hit.z,
        stackIndex: hit.stackIndex,
      });
    }
  }

  /**
   * Hit points that changed since the last broadcast.
   *
   * Only battlers are tracked, so a world of scenery costs one `null` check per
   * actor. An actor who has left is forgotten here too — otherwise their entry
   * would sit in the map forever, and a returning player would silently inherit
   * the reading their previous body died on.
   */
  private diffHps(actors: ActorSnapshot[]): HpPatch[] {
    const out: HpPatch[] = [];
    const live = new Set<string>();
    for (const actor of actors) {
      if (actor.hp === null || actor.maxHp === null) continue;
      live.add(actor.id);
      if (this.sentHp.get(actor.id) === actor.hp) continue;
      this.sentHp.set(actor.id, actor.hp);
      out.push({ actorId: actor.id, hp: actor.hp, maxHp: actor.maxHp });
    }
    for (const id of this.sentHp.keys()) {
      if (!live.has(id)) this.sentHp.delete(id);
    }
    return out;
  }

  /**
   * Carried lights that changed since the last broadcast.
   *
   * Almost always empty, and that is the shape to protect: this runs on every
   * tick of every world, and a torch is picked up once. Forgetting an actor who
   * has left matters here for the same reason it does for hit points — a
   * returning player with a fresh kit would otherwise be diffed against the
   * lantern their last body was holding, and the room would stay lit by nothing.
   */
  private diffCarriedLights(actors: ActorSnapshot[]): CarriedLightsPatch[] {
    const out: CarriedLightsPatch[] = [];
    const live = new Set<string>();
    for (const actor of actors) {
      live.add(actor.id);
      const joined = actor.carriedLights.join(",");
      if ((this.sentCarriedLights.get(actor.id) ?? "") === joined) continue;
      this.sentCarriedLights.set(actor.id, joined);
      out.push({ actorId: actor.id, tileIds: actor.carriedLights });
    }
    for (const id of this.sentCarriedLights.keys()) {
      if (!live.has(id)) this.sentCarriedLights.delete(id);
    }
    return out;
  }

  /**
   * Cells that changed since the last broadcast.
   *
   * Chunk identity first (`changedCellsOnLevel`), so an unchanged floor costs a
   * reference compare rather than a walk of thousands of cells. This is the
   * whole reason the protocol stays cheap as the map grows.
   */
  private diffCells(next: MapFile): CellPatch[] {
    const prev = this.broadcastMap;
    if (!prev || prev === next) return [];

    const out: CellPatch[] = [];
    for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
      for (const key of changedCellsOnLevel(prev, next, z)) {
        const { x, y } = parseCoordKey(key);
        out.push({ x, y, z, stack: getStack(next, x, y, z) });
      }
    }
    return out;
  }

  private broadcast(message: ServerMessage) {
    // One serialization for everyone: every socket is at the same map version,
    // which is what makes the per-tick cost independent of player count.
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // A socket that died between the tick and this send is dropped by the
        // runtime; webSocketClose will clean the actor up.
      }
    }
  }
}
