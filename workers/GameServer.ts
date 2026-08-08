import { DurableObject } from "cloudflare:workers";
import { GameSession, type ActorSnapshot } from "../app/game/GameSession";
import { TICK_MS } from "../app/game/constants";
import { minutesOfDayAt } from "../app/lib/clock";
import {
  changedCellsOnLevel,
  chunkifyMap,
  flattenMap,
  getStack,
} from "../app/lib/mapData";
import { dataStoreFor, type DataStore } from "../app/lib/storage.server";
import type { FlatMapFile, MapFile, TileDef } from "../app/lib/types";
import { MAX_LEVEL, MIN_LEVEL, parseCoordKey } from "../app/lib/types";
import {
  parseClientMessage,
  type CellPatch,
  type MotionEvent,
  type ServerMessage,
} from "../app/net/protocol";

/** Key under which the running world is checkpointed when it goes idle. */
const CHECKPOINT_KEY = "world";

type Attachment = { actorId: string };

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
  private events: MotionEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private loading: Promise<void> | null = null;
  /** Where `data/` is served in dev, told to us by whoever called in. */
  private dataOrigin: string | null = null;

  /**
   * Find authored content.
   *
   * The origin is remembered from {@link replaceWorld} because in dev the
   * answer is only knowable from a request: under `pnpm dev` the file
   * middleware lives on the Vite server's own origin, and the object has no way
   * to name it. Without it the object fell back to R2 while every loader read
   * `data/` on disk, so an editor save landed in a bucket nobody reads and the
   * map came back unchanged. `pnpm dev:worker` sets `DATA_ORIGIN`, which takes
   * priority, and production ignores both and takes R2.
   *
   * Only the save tells us, not the socket handshake: the handshake's origin is
   * whatever host the client reached, which is no basis for deciding where to
   * fetch content from, and under Vite there are no sockets to serve anyway.
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
    await this.loading;
    this.loading = null;
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
        )
      : new GameSession(await store.readMap(), this.tiles, []);
    this.broadcastMap = this.session.getMap();
    this.restoreActors();
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
   */
  private restoreActors() {
    const live: string[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment) live.push(attachment.actorId);
    }
    this.session?.reapAbsentActors(live);
    for (const id of live) this.session?.spawn(id);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }
    const actorId = new URL(request.url).searchParams.get("actor");
    if (!actorId) return new Response("Missing actor", { status: 400 });

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
    // Rejoining with the same id keeps the actor already on the board.
    session.spawn(actorId);
    this.events.push({ kind: "joined", actorId });

    this.sendHello(server, actorId);
    // A join moves the board, so it has to be broadcast even if nobody is
    // pressing anything.
    this.wake();

    return new Response(null, { status: 101, webSocket: client });
  }

  private sendHello(ws: WebSocket, actorId: string) {
    const session = this.session!;
    const message: ServerMessage = {
      type: "hello",
      selfId: actorId,
      map: flattenMap(session.getMap()),
      actorIds: session.actorIds(),
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

    if (message.type === "input") {
      session.setInput(
        {
          directions: message.directions,
          faceOnly: message.faceOnly,
          preferDescend: message.preferDescend,
        },
        actorId,
      );
    } else {
      // Re-validated against the board rather than trusted: the client decided
      // to offer this affordance from the same rules, but it decided on a map
      // that may be a round trip old.
      session.interact(message.ref, actorId);
    }

    this.wake();
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

    this.session?.despawn(attachment.actorId);
    this.sentMotion.delete(attachment.actorId);
    this.events.push({ kind: "left", actorId: attachment.actorId });
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
   */
  async replaceWorld(flat: FlatMapFile, dataOrigin?: string): Promise<void> {
    if (dataOrigin) this.dataOrigin = dataOrigin;
    await this.ensureLoaded();
    const store = this.store();
    await store.writeMap(chunkifyMap(flat));
    await this.ctx.storage.delete(CHECKPOINT_KEY);

    this.tiles = await store.readTiles();
    this.session = new GameSession(chunkifyMap(flat), this.tiles, []);
    this.broadcastMap = this.session.getMap();
    this.sentMotion.clear();
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
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    void this.ctx.storage.put(CHECKPOINT_KEY, {
      map: flattenMap(session.getMap()),
      spawn: session.getSpawnPoint(),
    } satisfies Checkpoint);
  }

  private tick() {
    const session = this.session;
    if (!session) return;

    session.tick(TICK_MS);

    const actors = session.actorSnapshots();
    this.collectMotionEvents(actors);

    const cells = this.diffCells(session.getMap());
    if (cells.length > 0 || this.events.length > 0) {
      this.broadcast({ type: "patch", cells, events: this.events });
      this.broadcastMap = session.getMap();
      this.events = [];
    }

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
