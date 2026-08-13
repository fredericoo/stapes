import { DurableObject } from "cloudflare:workers";
import {
  GameSession,
  type ActorPosition,
  type ActorSnapshot,
} from "../app/game/GameSession";
import { TICK_MS, WALK_DURATION_MS } from "../app/game/constants";
import { type Equipment, emptyEquipment } from "../app/game/equipment";
import { minutesOfDayAt } from "../app/lib/clock";
import {
  changedCellsOnLevel,
  chunkifyMap,
  flattenMap,
  getStack,
} from "../app/lib/mapData";
import { dataStoreFor, type DataStore } from "../app/lib/storage.server";
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
  type CellPatch,
  type HpPatch,
  type MotionEvent,
  type ServerMessage,
} from "../app/net/protocol";

/** Key under which the running world is checkpointed when it goes idle. */
const CHECKPOINT_KEY = "world";

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
 * How many actors the world remembers the whereabouts of.
 *
 * One entry per player who has ever connected — it grows with *visitors*, not
 * with activity, which is a slow leak rather than a fast one and therefore the
 * kind that is still there in a year. Identity is a cookie anybody can mint, so
 * the ceiling is a defence as well as housekeeping. Least-recently-saved goes
 * first: the entries being dropped are the ones whose owner has not been seen
 * in longest, which is the closest thing here to "will not be missed".
 */
export const MAX_SAVED_POSITIONS = 1_000;

/**
 * How often positions are written out while the world is being played.
 *
 * The floor on how much a crash can cost somebody, and the whole reason this is
 * not simply left to the idle checkpoint: a busy world never settles, so an
 * object that died mid-session would hand everybody back the position they had
 * when the room was last empty. Five seconds is a couple of rooms' walking.
 */
const POSITION_FLUSH_INTERVAL_MS = 5_000;

/**
 * Where somebody was standing, kept against their return.
 *
 * `savedAt` is here for the ceiling rather than for gameplay — see
 * {@link MAX_SAVED_POSITIONS}.
 */
type SavedPosition = ActorPosition & { savedAt: number };

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
  private events: MotionEvent[] = [];
  /** Steps clients say they have taken, oldest first, per actor. */
  private readonly queuedSteps = new Map<string, QueuedStep[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private loading: Promise<void> | null = null;
  /** Where `data/` is served in dev, told to us by whoever called in. */
  private dataOrigin: string | null = null;
  /** When each actor last said something, for the rate limit. */
  private lastSaidAt = new Map<string, number>();
  /** When positions were last written out. See {@link savePositionsIfDue}. */
  private positionsSavedAt = 0;
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
    await this.prunePositions();
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
      this.session?.spawn(id, await this.lastPositionOf(id));
    }
  }

  private positionKey(actorId: string): string {
    return `${POSITION_KEY_PREFIX}${actorId}`;
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
   * Write down where some actors are standing, without the tick waiting on it.
   *
   * `allowUnconfirmed` is the load-bearing part. A Durable Object normally
   * holds every outgoing message until the writes that preceded it are durable,
   * so that nobody can observe state that a failed write would roll back — and
   * that is the right default for anything the world's consistency rests on.
   * This is not that. A position is a convenience, and the failure it guards
   * against is losing a few seconds of walking on a crash that has already lost
   * the tick. Paying for it with the whole world's broadcast latency, thirty
   * times a second, would be the wrong trade in the one place this object
   * cannot afford one.
   *
   * The rejection is swallowed for the same reason: there is nothing useful to
   * do about a position that did not stick, and an unhandled rejection here
   * would take the world down over it.
   */
  private savePositions(actorIds: Iterable<string>) {
    const session = this.session;
    if (!session) return;

    const savedAt = Date.now();
    const entries: Record<string, SavedPosition> = {};
    for (const actorId of actorIds) {
      const at = session.actorPosition(actorId);
      if (!at) continue;
      entries[this.positionKey(actorId)] = { ...at, savedAt };
    }
    if (Object.keys(entries).length === 0) return;

    this.ctx.storage.put(entries, { allowUnconfirmed: true }).catch(() => {});
  }

  /**
   * Save everyone, at most once every {@link POSITION_FLUSH_INTERVAL_MS}.
   *
   * Throttled rather than per-tick because the position of a walking actor
   * changes on a tick that already has a diff and a broadcast to pay for, and
   * writing it there would put a storage call on the busiest frames to record
   * something that will be superseded 200ms later.
   */
  private savePositionsIfDue() {
    const session = this.session;
    if (!session) return;
    const now = Date.now();
    if (now - this.positionsSavedAt < POSITION_FLUSH_INTERVAL_MS) return;
    // Stamped whether or not anything was written, so an empty world costs one
    // comparison per tick rather than a walk of its actor table.
    this.positionsSavedAt = now;
    this.savePositions(session.actorIds());
  }

  /**
   * Drop the positions of people the world has not seen in longest.
   *
   * On load, because that is the one moment this object is already doing async
   * I/O with nothing waiting on a tick — and it runs once per instance rather
   * than once per wake, since an object that is already in memory does not
   * reload.
   */
  private async prunePositions() {
    const stored = await this.ctx.storage.list<SavedPosition>({
      prefix: POSITION_KEY_PREFIX,
    });
    if (stored.size <= MAX_SAVED_POSITIONS) return;

    const oldestFirst = [...stored].sort(
      ([, a], [, b]) => a.savedAt - b.savedAt,
    );
    const doomed = oldestFirst
      .slice(0, stored.size - MAX_SAVED_POSITIONS)
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
    session.spawn(actorId, await this.lastPositionOf(actorId));
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

  private sendHello(ws: WebSocket, actorId: string) {
    const session = this.session!;
    const message: ServerMessage = {
      type: "hello",
      selfId: actorId,
      map: flattenMap(session.getMap()),
      actorIds: session.actorIds(),
      hps: currentHps(session.actorSnapshots()),
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
    } else {
      // Re-validated against the board rather than trusted: the client decided
      // to offer this affordance from the same rules, but it decided on a map
      // that may be a round trip old.
      session.interact(message.ref, actorId);
    }

    this.wake();
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

    // Before the despawn, which is what takes their tile — and with it the only
    // record of where they were — off the board.
    this.savePositions([attachment.actorId]);
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

    this.tiles = tiles;
    this.session = session;
    this.broadcastMap = this.session.getMap();
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

    // Everyone still connected re-enters the new world at its spawn point.
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (!attachment) continue;
      this.session.spawn(attachment.actorId);
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
    this.savePositions(session.actorIds());
    void this.ctx.storage.put(CHECKPOINT_KEY, {
      map: flattenMap(session.getMap()),
      spawn: session.getSpawnPoint(),
      seed: session.getSeed(),
      dead: [...this.dead],
    } satisfies Checkpoint);
  }

  private tick() {
    const session = this.session;
    if (!session) return;

    session.tick(TICK_MS);
    this.applyQueuedSteps();

    const actors = session.actorSnapshots();
    this.collectMotionEvents(actors);
    this.collectDamageEvents(session);
    this.noteDeaths(session);
    this.broadcastSpeech(session, actors);

    const cells = this.diffCells(session.getMap());
    const hps = this.diffHps(actors);
    if (cells.length > 0 || this.events.length > 0 || hps.length > 0) {
      this.broadcast({ type: "patch", cells, events: this.events, hps });
      this.broadcastMap = session.getMap();
      this.events = [];
    }

    this.savePositionsIfDue();
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
