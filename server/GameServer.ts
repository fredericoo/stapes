import type { GameSocket, WorldContext } from "./sockets";
import * as v from "valibot";
import {
  GameSession,
  type ActorPosition,
  type ActorSnapshot,
  type Death,
} from "../app/game/GameSession";
import { TICK_MS, WALK_DURATION_MS } from "../app/game/constants";
import { cellKey } from "../app/game/pressurePlates";
import {
  findSpawnPoints,
  isSpawnFilled,
  presentItemIds,
  rollRespawnDelayMs,
  type SpawnPoint,
  withMigratedItemIds,
} from "../app/game/respawn";
import {
  type Equipment,
  emptyEquipment,
  restoredEquipment,
  wornInstances,
} from "../app/game/equipment";
import { DEFAULT_FACING } from "../app/game/actors";
import { resolveRespawn } from "../app/lib/interactions";
import { minutesOfDayAt } from "../app/lib/clock";
import { masteryXpBlockSchema, type MasteryXp } from "../app/lib/mastery";
import {
  changedCellsOnLevel,
  changedChunks,
  chunkifyMap,
  flattenMap,
  getStack,
  mapFromChunks,
} from "../app/lib/mapData";
import type { DataStore } from "../app/lib/storage.server";
import { tilesByIdFromList } from "../app/lib/validation";
import { type StatusDef, statusesById } from "../app/lib/status";
import type { StatusInstance } from "../app/game/statuses";
import type {
  ChunkCells,
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
  type StatusIdsPatch,
  type CellPatch,
  type HpPatch,
  type MotionEvent,
  type ServerMessage,
} from "../app/net/protocol";

/** Key under which the running world is checkpointed when it goes idle. */
const CHECKPOINT_KEY = "world";

/**
 * Key prefix under which one chunk of the checkpointed board is kept, as
 * `chunk:<level>:<chunkKey>`.
 *
 * A key per chunk rather than the whole map in one value, for two reasons that
 * are really the same reason.
 *
 * **There is a ceiling, and the map was growing toward it.** A Durable Object's
 * storage refuses a value over about two megabytes — `SQLITE_TOOBIG` — and the
 * whole-map checkpoint was a single value that grew with the world. Today's map
 * serializes to a few hundred kilobytes, so a world six or eight times its size
 * would have started failing, and failing *silently*: the write is fire-and-
 * forget, so nothing would have said so, and every player would simply have been
 * handed back wherever they stood at the last checkpoint small enough to land. A
 * chunk is at most {@link CHUNK_SIZE}² cells and cannot approach the limit, so
 * the ceiling now scales with the world instead of standing across it.
 *
 * **And the map is already chunked copy-on-write.** A flush that re-serialized
 * every cell in the world every five seconds was doing it to record that
 * somebody had walked two tiles; {@link changedChunks} turns that into the one
 * chunk they walked through.
 */
const CHUNK_KEY_PREFIX = "chunk:";

/** Where one chunk of the board is kept. */
function boardKey(levelKey: string, chunkKey: string): string {
  return `${CHUNK_KEY_PREFIX}${levelKey}:${chunkKey}`;
}

/**
 * Read a board key back, or null if it is not one.
 *
 * Both halves are keyed by strings that cannot contain a colon — a level key is
 * a signed integer and a chunk key is a pair of them — so the first colon after
 * the prefix is the only separator there can be.
 */
function parseBoardKey(
  key: string,
): { levelKey: string; chunkKey: string } | null {
  if (!key.startsWith(CHUNK_KEY_PREFIX)) return null;
  const rest = key.slice(CHUNK_KEY_PREFIX.length);
  const at = rest.indexOf(":");
  if (at < 0) return null;
  return { levelKey: rest.slice(0, at), chunkKey: rest.slice(at + 1) };
}

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
    out.push({
      actorId: actor.id,
      hp: actor.hp,
      maxHp: actor.maxHp,
      rating: actor.rating ?? 0,
    });
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

/** Everybody's statuses, as ids. @see currentCarriedLights for the omission rule. */
function currentStatusIds(actors: ActorSnapshot[]): StatusIdsPatch[] {
  const out: StatusIdsPatch[] = [];
  for (const actor of actors) {
    if (actor.statuses.length === 0) continue;
    out.push({ actorId: actor.id, defIds: statusIdsOf(actor) });
  }
  return out;
}

/**
 * The ids a body is under, and nothing else about them.
 *
 * **The countdown is dropped on purpose**, which is what keeps this broadcast
 * the same bytes for everybody — see `StatusIdsPatch`. Sorted, so two orderings
 * of one set of statuses do not read as a change and send a patch that says
 * nothing.
 */
function statusIdsOf(actor: ActorSnapshot): string[] {
  return actor.statuses.map((status) => status.defId).sort();
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
 * same fact: a kit changes without the body moving and the body moves without
 * the kit changing, so {@link GameServer.saveActors} dirties them separately —
 * and the ceiling below prunes them independently as well.
 */
const EQUIPMENT_KEY_PREFIX = "equip:";

/**
 * Key prefix under which one actor's taken rewards are kept.
 *
 * A third key rather than a field on the kit, though the two are written
 * together and almost always change together. What they mean is different in
 * kind: a kit is a list of things that must still exist in the world to be worth
 * restoring, and a tag is a record that something already happened, which stays
 * true however the authored content moves. `restoredEquipment` exists precisely
 * to check the one against the world; a tag must never be checked against
 * anything, or a chest whose sword was renamed becomes a chest you can open
 * again.
 */
const TAGS_KEY_PREFIX = "tags:";

/**
 * Key prefix under which one actor's earned masteries are kept.
 *
 * The third and last thing a world owes a returning player, and a fourth key
 * rather than a field on any of the others for the same reason they are separate
 * from each other: it is a different kind of fact with a different population.
 * Every body has a position, only players have a kit, and only players who have
 * been in a fight have any of this.
 *
 * Like a tag and unlike a kit, **it is never checked against the authored
 * world** — what it records is that something already happened. Unlike a tag, it
 * is checked for *shape*, because it is arithmetic rather than a list of strings
 * and a malformed figure would propagate through every fight the player has from
 * then on rather than failing where it was read.
 */
const MASTERIES_KEY_PREFIX = "mast:";

/**
/**
 * Key prefix under which one player's spawn point is kept — where a death puts
 * them back.
 *
 * Written once, when the world first sees them, and never again: this is where
 * somebody *entered*, which is a different fact from where they are
 * ({@link POSITION_KEY_PREFIX}) and does not move when they do. Today every row
 * under here holds the same coordinates, because a map has one authored `player`
 * marker — the point of keeping it per player is that a death does not have to
 * ask the map a question the map has already been re-authored out of, and that
 * the day a world has two front doors nothing above this line changes.
 *
 * Dropped wholesale by {@link replaceWorld}, which is the one thing that can
 * move the marker: a save is a fresh statement of where the world begins, and a
 * remembered spawn pointing into the old one would put somebody back through a
 * door that is no longer there.
 */
const SPAWN_KEY_PREFIX = "spawn:";

/**
 * Key prefix under which one actor's running statuses are kept.
 *
 * The whole of what makes a status effect a status effect rather than a timer:
 * logging off must neither cancel it nor advance it, so what is left of it has to
 * outlive the connection. Its own key beside the four before it, and a different
 * population again — only somebody who has eaten or been bitten has any.
 *
 * Validated for **shape** on the way back in, like the masteries and unlike the
 * tags: it is arithmetic a tick will act on, and a malformed remainder would run
 * through every payout from then on rather than failing where it was read. The
 * ids in it are *not* checked against the catalogue here — `advanceStatuses`
 * drops one whose def has gone, which is the same check in the one place that
 * can also do something about it.
 */
const STATUSES_KEY_PREFIX = "status:";

/**
 * Key prefix under which one actor's hit points are kept.
 *
 * Hit points used to be rebuilt from the tile on every load, on the grounds that
 * a world nobody is looking at owes no continuity. Statuses broke that: a heal
 * that runs for half an hour is undone by a reconnect, and a poison is cured by
 * one, so the feature would have been decorative in exactly the case it was
 * written for.
 *
 * Written **only when they are not full**, which is what keeps the cost
 * proportional to injury rather than to visitors: a body at its maximum needs no
 * memory, because the tile says so again next load.
 */
const HP_KEY_PREFIX = "hp:";

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
 * How often what has changed is written out while the world is being played.
 *
 * The ceiling on how much a crash can cost somebody, and the whole reason this
 * is not simply left to the idle checkpoint: **a world with anybody in it never
 * settles.** `GameSession.isAtRest` stays false for as long as a player is
 * present and any creature has a brain wanting a turn, so an object that died
 * mid-session would hand everybody back the position they had when the room was
 * last empty — which on a busy world is hours ago, not minutes.
 *
 * Thirty seconds rather than the five it began at. Five was chosen when a flush
 * wrote every actor unconditionally, so the interval was the only thing holding
 * the write rate down, and it was holding it down at roughly thirteen thousand
 * rows an hour for a single connected player — enough to exhaust a day's free
 * tier in one sitting, which is exactly how this was found. Now that
 * {@link GameServer.saveActors} writes only what has actually moved, the
 * interval is free to be what it should always have been: a statement about how
 * much progress is acceptable to lose, and nothing about cost.
 *
 * Thirty seconds of walking and fighting is the exposure, and it is bounded on
 * both ends by things that do not wait for it — a socket closing saves before
 * the body goes, and a world settling saves before it may be evicted. What is
 * left is the genuinely unannounced death: a crash, an eviction, or a deploy.
 */
const ACTOR_FLUSH_INTERVAL_MS = 30_000;

/** How often a repeating tick failure is reported. See {@link GameServer.tickSafely}. */
const TICK_FAILURE_LOG_INTERVAL = 300;

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

/** Which rewards somebody has taken, kept against their return. */
type SavedTags = { tags: string[]; savedAt: number };

/** What somebody has learnt, kept against their return. */
type SavedMasteries = { masteries: MasteryXp; savedAt: number };

/** Where somebody came into the world, kept against their death. */
type SavedSpawn = ActorPosition & { savedAt: number };

/** What was still running on somebody, frozen for as long as they are away. */
type SavedStatuses = { statuses: StatusInstance[]; savedAt: number };

/**
 * What health somebody was on.
 *
 * **Nullable, and the null is what makes the row correctable.** Null means "at
 * their maximum", which is also what an absent key means — but a row that has to
 * be *overwritten* with that is the only way to retract a number written while
 * they were hurt. See {@link GameServer.saveActors}.
 */
type SavedHp = { hp: number | null; savedAt: number };

/**
 * One stored status, checked rather than trusted.
 *
 * Every field is arithmetic a tick will act on, so a malformed one has to fail
 * here rather than propagate. `defId` is deliberately *not* checked against the
 * catalogue: `advanceStatuses` drops a status whose def has gone, which is the
 * same test in the one place that can also stop applying it.
 */
const savedStatusSchema = v.object({
  defId: v.pipe(v.string(), v.minLength(1)),
  durationMs: v.pipe(v.number(), v.finite(), v.minValue(0)),
  remainingMs: v.pipe(v.number(), v.finite(), v.minValue(0)),
  sinceEffectMs: v.pipe(v.number(), v.finite(), v.minValue(0)),
});

const savedStatusesSchema = v.array(savedStatusSchema);

type Attachment = { actorId: string };

/**
 * What was last written down about one actor, so a flush can skip the rows that
 * still say what storage already says.
 *
 * Compared by identity for the three that are *replaced* rather than edited —
 * `GameSession` swaps in a new kit, a new tag list and a new experience block
 * on every change, exactly as it swaps in a new map — which makes an unchanged
 * one a reference compare rather than a walk. The same discipline
 * {@link GameServer.checkpointedMap} already applies to the board, and it is
 * sound for the same reason: storage writes are ordered, so a later batch
 * cannot be durable while the batch it was diffed against is not.
 *
 * The position is the exception and is compared by value, because
 * `actorPosition` builds a fresh object per call — there is no identity to
 * compare, and four numbers is cheaper than making one.
 *
 * Per instance, never restored. An object that has just loaded has written
 * nothing down in its own lifetime and therefore writes everybody out once, on
 * exactly the terms {@link load} leaves `checkpointedMap` null for: it costs one
 * full flush per instance, and it is what heals a row that has drifted for any
 * reason at all.
 */
type WrittenActor = {
  position: ActorPosition | null;
  equipment: Equipment | null;
  tags: readonly string[] | null;
  masteries: MasteryXp | null;
  /**
   * Null means "never told", which is not the same as an empty list: the
   * difference is whether there is a stale row out there to correct. See
   * {@link GameServer.saveActors}.
   */
  statuses: readonly StatusInstance[] | null;
  hp: number | null;
};

/** Whether two positions describe the same standing place, facing the same way. */
function samePosition(a: ActorPosition, b: ActorPosition): boolean {
  return (
    a.x === b.x && a.y === b.y && a.z === b.z && a.direction === b.direction
  );
}

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
  /**
   * The whole board, as worlds checkpointed before {@link CHUNK_KEY_PREFIX}
   * existed carry it.
   *
   * Read but never written. A world resumed through this field is written back
   * out in chunks by its first flush, and the field goes with it — so this is
   * the migration, and it costs one extra load of the shape that already
   * worked.
   *
   * @deprecated The board lives under {@link CHUNK_KEY_PREFIX}.
   */
  map?: FlatMapFile;
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
  strike: unknown;
};

/**
 * The authoritative game world.
 *
 * One instance, addressed by name — the world is the coordination atom here, so
 * a single Durable Object is the model rather than the usual global-DO
 * anti-pattern. It does mean concurrent players are capped by what one object
 * can tick.
 */
export class GameServer {
  /**
   * Named `ctx` and `env` because that is what they were called when a platform
   * base class supplied them. Several hundred `this.ctx.storage.*` and
   * `this.ctx.getWebSockets()` call sites below are unchanged as a result, and
   * so is the suite that guards them — which matters more than the names do,
   * since that suite is the only reason to believe this file still works.
   */
  constructor(
    protected readonly ctx: WorldContext,
    protected readonly env: { dataStore: DataStore },
  ) {}

  private session: GameSession | null = null;
  private tiles: TileDef[] = [];
  /**
   * The status catalogue, compiled. Empty until {@link load} runs, which is the
   * same state the tiles are in and means the same thing: a world nothing has
   * been read into yet.
   */
  private statusDefs: Record<string, StatusDef> = {};
  /** Map identity the last broadcast was diffed against. */
  private broadcastMap: MapFile | null = null;
  private sentMotion = new Map<string, SentMotion>();
  /**
   * The hit points each client has been told about, so an unchanged bar costs
   * nothing on the wire. Same discipline as {@link broadcastMap}: everyone is at
   * the same version, so one diff serves every socket.
   */
  private sentHp = new Map<string, { hp: number; rating: number }>();
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
  /** Last broadcast status ids per actor, joined. @see diffStatusIds */
  private sentStatusIds = new Map<string, string>();
  private events: MotionEvent[] = [];
  /** Steps clients say they have taken, oldest first, per actor. */
  private readonly queuedSteps = new Map<string, QueuedStep[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Consecutive throwing ticks, for the rate-limited report. See {@link tickSafely}. */
  private consecutiveTickFailures = 0;
  private loading: Promise<void> | null = null;
  /** Where `data/` is served in dev, told to us by whoever called in. */
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
  /** What storage was last told about each actor. See {@link WrittenActor}. */
  private writtenActors = new Map<string, WrittenActor>();
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
   * What each newly-dead player must be handed back, until the batch that also
   * carries the board they died on has written it.
   *
   * Their rows cannot be built by {@link saveActors}' own loop, which reads the
   * session: a dead actor has no position and no runtime, so the loop skips them
   * entirely — and it was *only* the loop that skipped, while the board below it
   * was written regardless. That is how a sword picked up and carried into a
   * losing fight ended up neither in its owner's kit nor on the floor it had
   * been taken from. See {@link noteDeaths}.
   */
  private pendingDeathWrites = new Map<string, Death>();
  /**
   * Sockets the world has stopped talking to: connected, but with nobody at
   * this end to talk *about*.
   *
   * A dead player sits there with an open socket and no body, and every patch
   * sent to them is a report on a board they cannot touch. Worse than wasted:
   * the screen behind the death message would go on moving, which reads as a
   * world you are still in. So the sends stop at the death and start again at
   * the {@link ClientMessage} `rebirth`.
   *
   * A subset of {@link dead} rather than the same thing. That set holds every
   * body the world has taken off the board, wildlife included, and a rat has no
   * socket to fall silent on — so silencing off `dead` would mean asking, per
   * broadcast, which of thousands of dead deer had a connection. This holds the
   * handful that do.
   *
   * Not checkpointed, and not because it does not matter across an eviction: it
   * is derivable there, from `dead` — which *is* checkpointed — intersected
   * with the sockets that survived. {@link restoreActors} does exactly that.
   */
  private silenced = new Set<string>();
  /**
   * Who died on the tick currently being broadcast, and what they still own.
   *
   * Held for the length of one tick, between {@link noteDeaths} filling it and
   * the end of {@link tick} draining it, and the gap between those two is the
   * whole reason it exists: the patch that goes out in between is the *last*
   * thing these sockets hear, and it has to reach them. Silencing at the death
   * itself would take away the one frame that shows them what happened —
   * their body gone from the cell, and their kit lying in it.
   */
  private justDied: Death[] = [];
  /**
   * Where each connected player came in, so a death can put them back there
   * without waiting on storage.
   *
   * Held in memory because {@link saveActors} is synchronous and a death is
   * written from inside it: reading the row there would make the one write that
   * must not be deferred an awaited one. Every path that seats a player fills
   * this — the join and the restore — and only a seated player can die, so the
   * lookup cannot miss.
   */
  private readonly spawns = new Map<string, ActorPosition>();
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
   * Handed in whole, which is all this needs to be now. It used to work out an
   * origin and remember it, because the Worker had no filesystem: a dev build
   * reached `data/` over HTTP through a middleware whose address only a request
   * could reveal, and a Durable Object has no request of its own — so the
   * origin was threaded through the socket handshake and the editor's save, and
   * getting that wrong ran the world against a stale bucket while every loader
   * read the disk. This process opens the directory.
   */
  private store(): DataStore {
    return this.env.dataStore;
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
    // Beside the tiles because it is the same kind of thing: authored content
    // the world reads and never writes. Resolved once per load — `statusesById`
    // compiles every formula in it, which is exactly the work that must not
    // happen on a tick.
    this.statusDefs = statusesById(await store.readStatuses());

    const checkpoint = await this.ctx.storage.get<Checkpoint>(CHECKPOINT_KEY);
    const board = checkpoint ? await this.checkpointedBoard(checkpoint) : null;
    // No actors either way: connections spawn their own. On a fresh world the
    // authored `player` tile is only the marker saying where, and starting the
    // session consumes it.
    this.session = board
      ? new GameSession(board, this.tiles, {
          actorIds: [],
          spawnAt: checkpoint!.spawn,
          seed: checkpoint!.seed,
          statuses: this.statusDefs,
        })
      : new GameSession(await store.readMap(), this.tiles, {
          actorIds: [],
          statuses: this.statusDefs,
        });
    // Only from a checkpoint we could actually resume. A world falling back to
    // the authored map is a world nobody has died in yet, and carrying a grudge
    // across that would leave somebody absent from a board they are standing on.
    this.dead = new Set(board ? (checkpoint!.dead ?? []) : []);
    this.broadcastMap = this.session.getMap();
    // Deliberately not `this.checkpointedMap = this.session.getMap()`, which
    // would look like the obvious saving. Constructing a session *changes* the
    // board it was handed — it adopts resident bodies, consumes the spawn marker
    // and settles every plate — so the map in memory is already not the one in
    // storage. Leaving this null makes the first flush write the board out
    // whole, once per instance, and that is also what heals a world whose
    // stored chunks have drifted for any reason at all.
    this.checkpointedMap = null;
    await this.restoreActors();
    await this.pruneRemembered();
    await this.loadRespawnState(board != null);
  }

  /**
   * Reassemble the checkpointed board, or null if there is nothing to resume.
   *
   * Null rather than an empty map for the case where the metadata is there and
   * the chunks are not — and the distinction is the whole point of this
   * existing, because an empty board does not announce itself. A resumed world
   * is handed its spawn point rather than reading it off the map, so
   * `GameSession` starts perfectly happily on nothing at all: players would join
   * a void, standing on no terrain, in a world that looks to every other part of
   * this object like it is working. Falling back to the authored map costs
   * everybody their position once and leaves a world that is actually there.
   */
  private async checkpointedBoard(
    checkpoint: Checkpoint,
  ): Promise<MapFile | null> {
    if (checkpoint.map) return chunkifyMap(checkpoint.map);

    const stored = await this.ctx.storage.list<ChunkCells>({
      prefix: CHUNK_KEY_PREFIX,
    });
    const chunks = [];
    for (const [key, cells] of stored) {
      const parsed = parseBoardKey(key);
      if (parsed) chunks.push({ ...parsed, cells });
    }
    if (chunks.length === 0) return null;
    return mapFromChunks(chunks);
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
    const points = (stored ?? findSpawnPoints(session.getMap(), tilesById))
      .filter((point) => {
        const def = tilesById[point.placed.tileId];
        return def != null && resolveRespawn(def) != null;
      })
      // The one-time migration for points stored before identities were
      // tracked. Points derived fresh already carry theirs and pass through.
      .map((point) => withMigratedItemIds(session.getMap(), point));
    this.setRespawnPoints(points);
    // And forget whatever left its cell while the world was asleep, which no
    // changed-cell sweep was awake to notice.
    for (const point of this.respawnPoints.values()) {
      this.forgetDepartedItems(point);
    }
    // Written back on a resume too, now that a point carries state the stored
    // copy can be behind on: the pass above is only a migration if it sticks.
    this.persistRespawnPoints();

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

  /**
   * Say that a fire-and-forget write did not land.
   *
   * Every write in this object is deliberately not waited on — see
   * {@link saveActors} — and none of them has a recovery worth writing, so the
   * only honest thing to do with a rejection is make sure somebody can find out
   * about it. Swallowing them is how a world comes to quietly stop remembering
   * things.
   */
  private static reportWriteFailure(what: string) {
    return (error: unknown) => {
      console.error(`stapes: ${what} failed`, error);
    };
  }

  private persistRespawnPoints() {
    this.ctx.storage
      .put(RESPAWN_POINTS_KEY, [...this.respawnPoints.values()], {
        allowUnconfirmed: true,
      })
      .catch(GameServer.reportWriteFailure("respawn points write"));
  }

  private persistRespawnPending() {
    this.ctx.storage
      .put(RESPAWN_PENDING_KEY, Object.fromEntries(this.respawnPending), {
        allowUnconfirmed: true,
      })
      .catch(GameServer.reportWriteFailure("respawn deadlines write"));
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
      this.ctx.storage
        .deleteAlarm()
        .catch(GameServer.reportWriteFailure("respawn alarm clear"));
      return;
    }
    this.ctx.storage
      .setAlarm(Math.min(...this.respawnPending.values()))
      .catch(GameServer.reportWriteFailure("respawn alarm set"));
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
    let pointsDirty = false;
    for (const [key, dueAtMs] of this.respawnPending) {
      if (dueAtMs > nowMs) continue;
      dirty = true;
      const point = this.respawnPoints.get(key);
      if (!point) {
        this.respawnPending.delete(key);
        continue;
      }
      const outcome = session.respawnAt(point);
      if (outcome.kind === "blocked") {
        this.respawnPending.set(key, nowMs + RESPAWN_RETRY_MS);
        continue;
      }
      this.respawnPending.delete(key);
      // The old death is spent the moment a new body exists. Left in place
      // it would only be a leak — nothing seats a creature by id — but the
      // set is checkpointed, and a record that no longer records anything
      // has no business surviving the world that wrote it.
      this.dead.delete(key);
      if (this.adoptSpawnedItem(point, outcome.itemId)) pointsDirty = true;
    }
    if (pointsDirty) this.persistRespawnPoints();
    if (dirty) {
      this.persistRespawnPending();
      this.scheduleRespawnAlarm();
    }
  }

  /**
   * Put what just grew on the point's books, and take off whatever is no longer
   * standing there.
   *
   * The one place an id is ever *added* to a point. Everywhere else prunes, so
   * a point can only come to be watching something by having grown it — which
   * is what makes an emptied point stay owed no matter what is dropped into its
   * cell afterwards. See {@link SpawnPoint.itemIds}.
   *
   * Nothing to do when nothing grew, which covers a point found already filled
   * and every object that is not an item.
   */
  private adoptSpawnedItem(point: SpawnPoint, itemId: string | undefined) {
    const map = this.session?.getMap();
    if (!itemId || !map) return false;
    point.itemIds = [...presentItemIds(map, point), itemId];
    return true;
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
    let pointsDirty = false;
    for (const cell of cells) {
      const points = this.respawnPointsByCell.get(cellKey(cell));
      if (!points) continue;
      for (const point of points) {
        // Before the filled test rather than after, and before the pending
        // check rather than behind it: this is the moment the departure is
        // visible, and a point that is already owed still has to forget what
        // left it, or dropping the berry back would pay a debt it did not.
        if (this.forgetDepartedItems(point)) pointsDirty = true;
        if (this.respawnPending.has(point.key)) continue;
        if (isSpawnFilled(session.getMap(), point)) continue;
        this.armRespawn(point, nowMs);
      }
    }
    if (pointsDirty) this.persistRespawnPoints();
  }

  /**
   * Take off a point's books everything that is no longer standing in its cell.
   *
   * The counterpart to {@link adoptSpawnedItem}, and the half that runs
   * constantly. Reports whether anything was struck off, so a quiet cell —
   * which is nearly all of them — costs one stack read and no write.
   */
  private forgetDepartedItems(point: SpawnPoint): boolean {
    const map = this.session?.getMap();
    if (!map || !point.itemIds) return false;
    const present = presentItemIds(map, point);
    // Present is always a subset of what was owed, so equal lengths are equal
    // sets and there is nothing to rewrite.
    if (present.length === point.itemIds.length) return false;
    point.itemIds = present;
    return true;
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
      //
      // It stays *silent* too, and that is what this rebuilds: the set of
      // sockets the world is not talking to is derived rather than stored, and
      // this is the one moment it can be — everybody dead with a connection is
      // exactly the intersection being walked here. Missing it would have an
      // eviction quietly resume the patch stream to a screen still saying you
      // are dead.
      if (this.dead.has(id)) {
        this.silenced.add(id);
        continue;
      }
      // Note this seats rather than joins: nobody arrived, and the door is
      // remembered here because a player restored across a wake can die without
      // ever running {@link fetch} again.
      await this.seatActor(id);
    }
  }

  /**
   * Everything the world remembers about one person, fetched together.
   *
   * One helper rather than six awaits at each of the three places somebody is
   * seated, because the list only ever grows and the three had already drifted
   * into three different lengths once. Whatever is here is what `spawn` is
   * handed, and an absent key is `undefined`, which every field reads as "give
   * them the default".
   */
  private async restoredActor(actorId: string) {
    const [at, carrying, tagged, earned, statuses, hp] = await Promise.all([
      this.lastPositionOf(actorId),
      this.lastEquipmentOf(actorId),
      this.lastTagsOf(actorId),
      this.lastMasteriesOf(actorId),
      this.lastStatusesOf(actorId),
      this.lastHpOf(actorId),
    ]);
    return { at, carrying, tagged, earned, statuses, hp };
  }

  /**
   * Forget the checkpointed board entirely.
   *
   * Every key, not the ones the incoming map happens to reuse: a new world is
   * usually a different shape, and a chunk of the old one left behind under a
   * key the new one never writes would be resumed as part of it — a corner of a
   * map nobody authored, sitting there until somebody edited that exact chunk.
   */
  /**
   * Forget where everybody came in.
   *
   * Only {@link replaceWorld} calls this, and only because a save can move the
   * authored marker. Written as a sweep rather than a per-player delete for the
   * reason {@link deleteCheckpointedBoard} is: the rows that matter belong to
   * people who are not here, and there is no list of them but the prefix.
   */
  private async deleteSavedSpawns() {
    const stored = await this.ctx.storage.list({ prefix: SPAWN_KEY_PREFIX });
    if (stored.size === 0) return;
    await this.ctx.storage.delete([...stored.keys()]);
  }

  private async deleteCheckpointedBoard() {
    const stored = await this.ctx.storage.list({ prefix: CHUNK_KEY_PREFIX });
    if (stored.size === 0) return;
    await this.ctx.storage.delete([...stored.keys()]);
  }

  private spawnKey(actorId: string): string {
    return `${SPAWN_KEY_PREFIX}${actorId}`;
  }

  /**
   * Where this player comes back in, minting it the first time the world sees
   * them.
   *
   * **Read once per connection, not once per death.** The row is written the
   * moment somebody is created and never rewritten, so the only thing that can
   * change it is the world being replaced — which drops the rows rather than
   * editing them. Caching it on the instance is therefore not a staleness risk;
   * it is the whole reason a death can be written without awaiting anything.
   *
   * The facing is the one a fresh body takes, rather than whichever way they
   * happened to be looking: this is a door, not a footprint.
   */
  private async rememberSpawn(actorId: string): Promise<void> {
    if (this.spawns.has(actorId)) return;

    const saved = await this.ctx.storage.get<SavedSpawn>(
      this.spawnKey(actorId),
    );
    if (saved) {
      this.spawns.set(actorId, {
        x: saved.x,
        y: saved.y,
        z: saved.z,
        direction: saved.direction,
      });
      return;
    }

    const { x, y, z } = this.session!.getSpawnPoint();
    const spawn: ActorPosition = { x, y, z, direction: DEFAULT_FACING };
    this.spawns.set(actorId, spawn);
    // Its own write rather than a place in the next flush: it is written once
    // per player ever, and it has to be durable before the death that reads it —
    // which can be seconds away and is not obliged to wait for a flush.
    this.ctx.storage
      .put(this.spawnKey(actorId), { ...spawn, savedAt: Date.now() })
      .catch(GameServer.reportWriteFailure("spawn write"));
  }

  private positionKey(actorId: string): string {
    return `${POSITION_KEY_PREFIX}${actorId}`;
  }

  private equipmentKey(actorId: string): string {
    return `${EQUIPMENT_KEY_PREFIX}${actorId}`;
  }

  private tagsKey(actorId: string): string {
    return `${TAGS_KEY_PREFIX}${actorId}`;
  }

  private statusesKey(actorId: string): string {
    return `${STATUSES_KEY_PREFIX}${actorId}`;
  }

  private hpKey(actorId: string): string {
    return `${HP_KEY_PREFIX}${actorId}`;
  }

  private masteriesKey(actorId: string): string {
    return `${MASTERIES_KEY_PREFIX}${actorId}`;
  }

  /**
   * What this actor has learnt, if the world remembers.
   *
   * Parsed rather than trusted. This is the one number in a player's save that
   * is *arithmetic* — everything downstream divides by it, scales by it and
   * compares against it — so a block written by an older build with a mastery
   * that has since been renamed, or by a bug, must not reach a fight. A block
   * that does not parse reads as nothing, which loses that player their progress
   * and is still the better answer than a NaN spreading through every swing they
   * make from then on.
   *
   * Undefined for somebody new, which {@link GameSession.spawn} reads as "seed
   * them from the body they arrive in".
   */
  private async lastMasteriesOf(
    actorId: string,
  ): Promise<MasteryXp | undefined> {
    const saved = await this.ctx.storage.get<SavedMasteries>(
      this.masteriesKey(actorId),
    );
    if (!saved?.masteries) return undefined;
    const parsed = v.safeParse(masteryXpBlockSchema, saved.masteries);
    return parsed.success ? parsed.output : undefined;
  }

  /**
   * What was still running on this actor when the world last saw them.
   *
   * Handed back **unadvanced**: the whole contract is that a status neither ends
   * nor progresses while nobody is driving the body. Undefined for somebody the
   * world has nothing on, which {@link GameSession.spawn} reads as "under
   * nothing".
   *
   * A block that does not validate is dropped whole rather than filtered, on the
   * terms a malformed mastery block is: half a remembered condition is a worse
   * answer than none, and none is one a player can act on.
   */
  private async lastStatusesOf(
    actorId: string,
  ): Promise<StatusInstance[] | undefined> {
    const saved = await this.ctx.storage.get<SavedStatuses>(
      this.statusesKey(actorId),
    );
    if (!saved?.statuses) return undefined;
    const parsed = v.safeParse(savedStatusesSchema, saved.statuses);
    return parsed.success ? parsed.output : undefined;
  }

  /**
   * What health this actor was on, if the world remembers them being hurt.
   *
   * Undefined means full, which is both the common case and the honest reading:
   * nothing is written for a body at its maximum, so an absent key and a healthy
   * body are the same fact.
   */
  private async lastHpOf(actorId: string): Promise<number | undefined> {
    const saved = await this.ctx.storage.get<SavedHp>(this.hpKey(actorId));
    // A stored null is a body that healed to full, and reads exactly as an
    // absent key does: undefined, which `spawn` takes as "ask the tile".
    if (saved?.hp == null || !Number.isFinite(saved.hp) || saved.hp < 1) {
      return undefined;
    }
    return Math.floor(saved.hp);
  }

  /**
   * Which rewards this actor has already taken, if the world remembers.
   *
   * Handed to the session as it was written, unlike a kit: see
   * {@link TAGS_KEY_PREFIX} for why a tag is not checked against the world.
   * Undefined for somebody new, who is owed everything.
   */
  private async lastTagsOf(actorId: string): Promise<string[] | undefined> {
    const saved = await this.ctx.storage.get<SavedTags>(this.tagsKey(actorId));
    return saved?.tags;
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
  private saveActors(actorIds: Iterable<string>, force = false) {
    const session = this.session;
    if (!session) return;

    const savedAt = Date.now();
    const entries: Record<
      string,
      | SavedPosition
      | SavedEquipment
      | SavedTags
      | SavedMasteries
      | SavedStatuses
      | SavedHp
      | Checkpoint
      | ChunkCells
    > = {};
    for (const actorId of actorIds) {
      const at = session.actorPosition(actorId);
      if (!at) continue;
      // What storage already believes, or nothing when the caller has asked for
      // this to be written whatever it says — see the `force` callers, which are
      // the two moments a stale `savedAt` would matter.
      const written = force ? undefined : this.writtenActors.get(actorId);
      const equipment = session.equipmentOf(actorId);
      const tags = session.tagsOf(actorId);
      const masteries = session.masteryXpOf(actorId);
      const statuses = session.statusesOf(actorId);
      const hp = session.storedHpOf(actorId);

      // **A resident's position is never written, because nothing ever reads
      // it.** Every caller of {@link lastPositionOf} is asking on behalf of a
      // socket — `restoreActors` walks `getWebSockets`, and so do the join and
      // the replacement — because a player's tile is consumed at spawn and the
      // board no longer says where they were. A creature is the opposite: it is
      // adopted *out of* the board, so the checkpointed chunks already hold its
      // position and a `pos:` row beside them is a second copy nobody consults.
      //
      // This was the bulk of the write rate rather than a tidy-up. Twelve of the
      // eighteen-odd rows a flush wrote on today's map were creatures recording
      // where they stood for no reader at all.
      if (!session.isResident(actorId)) {
        if (!written?.position || !samePosition(written.position, at)) {
          entries[this.positionKey(actorId)] = { ...at, savedAt };
        }
      }
      // In the same write as the position, so the two facts about a player
      // cannot land in different storage batches and disagree about which
      // moment they describe. Skipping an unchanged one does not weaken that:
      // what makes the pair disagree is one of them moving without the other,
      // and a kit that has not changed cannot be the one that moved.
      //
      // **A resident's kit is never written, on exactly the grounds its position
      // is not: nothing ever reads it.** A creature is adopted out of the board
      // and rolls its kit as it is adopted (`../app/game/battlerKit`), so a
      // stored row would be a copy that the next wake overwrites with a fresh
      // roll before anybody could consult it. That test, and not emptiness, is
      // what keeps the row ceiling below from being spent on a key per creature
      // per world — which is just as well, because the day a rat could be
      // authored carrying meat is the day emptiness stopped standing in for it.
      //
      // **And an empty kit is written like any other.** Every other row here can
      // be skipped while empty because an absent key and an empty value mean the
      // same thing for ever; this one is the opposite, and for a sharper reason
      // than the `status:` row below. Dropping your last item puts it on the
      // floor, and the board written in this very batch says so — so a kit row
      // skipped for being empty leaves storage claiming the bag is on your back
      // while the floor holds it. That is the item existing twice this paired
      // write exists to prevent, and it is what a `weapon || offhand || bag`
      // guard did to anybody who emptied their pockets. Naming no slot at all
      // is also the last way to leave the off hand out of one.
      if (
        equipment &&
        !session.isResident(actorId) &&
        equipment !== written?.equipment
      ) {
        entries[this.equipmentKey(actorId)] = { equipment, savedAt };
      }
      // In the same batch again, and here the pairing is not merely tidy: the
      // items of a reward land in the kit and its tag lands here, so a batch
      // that carried one without the other would either hand somebody a second
      // copy of the reward or charge them for one they never got.
      //
      // Only a non-empty list, on the same terms the kit is: everybody starts
      // with none, and a key per creature per world would spend the ceiling
      // below on remembering that a deer has opened no chests.
      //
      // And the pairing survives the skip for a sharper reason than the kit's:
      // taking a reward is what puts items in the bag *and* the tag in this
      // list, so the one event that must not split the two changes both, and
      // both are therefore dirty in the same flush.
      if (tags && tags.length > 0 && tags !== written?.tags) {
        entries[this.tagsKey(actorId)] = { tags: [...tags], savedAt };
      }
      // And in the same batch a third time. Nothing pairs this with the kit the
      // way the kit is paired with the board — you cannot learn a mastery out of
      // a chest — but a player's continuity is one fact in three parts, and
      // splitting the moments they were written is how somebody comes back with
      // the sword and not the skill to swing it.
      //
      // Null until something has asked, which for a player who has not fought is
      // the common case: their masteries are still exactly what the tile says,
      // and the tile will say it again next time.
      if (masteries && masteries !== written?.masteries) {
        entries[this.masteriesKey(actorId)] = {
          masteries: { ...masteries },
          savedAt,
        };
      }
      // And in the same batch a fourth and fifth time, where the pairing matters
      // more than it does anywhere above: a status that heals *moves hit points*,
      // so a remembered condition made durable against health that was not —  or
      // the other way round — comes back either having healed twice or not at
      // all. One write, one moment.
      //
      // **Written when they change, and changing to nothing counts.** Every
      // other row here can be skipped while empty because an absent key and an
      // empty value mean the same thing for ever. These two are the opposite: a
      // `status:` row left behind when the last one ran out is a status that
      // comes back from the dead on the next reconnect, and an `hp:` row left
      // behind after somebody healed to full un-heals them. Skipping the empty
      // case is what a `length > 0` guard alone would do, and it was wrong.
      //
      // Residents are excluded outright, on exactly the grounds their position
      // is: `spawn` refuses restored statuses for a body that lives in the map,
      // so nothing would ever read either row.
      if (!session.isResident(actorId)) {
        const lastStatuses = written?.statuses ?? null;
        const bothEmpty =
          (statuses?.length ?? 0) === 0 && (lastStatuses?.length ?? 0) === 0;
        // Identity, like the kit and the tags: `advanceStatuses` replaces the
        // list wholesale, so a fresh array *is* a tick having passed.
        if (!bothEmpty && statuses !== lastStatuses) {
          entries[this.statusesKey(actorId)] = {
            statuses: (statuses ?? []).map((status) => ({ ...status })),
            savedAt,
          };
        }
        // By value rather than identity, since it is a number: null is a body at
        // its maximum, which is the common case and needs no memory of its own.
        if (hp !== (written?.hp ?? null)) {
          entries[this.hpKey(actorId)] = { hp, savedAt };
        }
      }

      // Remembered as of this batch rather than as of a confirmation, on the
      // same terms the batch itself is fire-and-forget: a write that does not
      // stick leaves this instance believing storage is ahead of where it is,
      // and the next instance — which remembers nothing — writes it out again.
      this.writtenActors.set(actorId, {
        position: at,
        equipment,
        tags,
        masteries,
        statuses,
        hp,
      });
    }

    // The dead, whom the loop above cannot reach: `actorPosition` is null for a
    // body that is off the board, and the runtime that held its kit is gone.
    // Their facts were captured at the death instead — see {@link Death} — and
    // are written here so they land in the same batch as the board that killed
    // them, which is the whole point of doing it from inside this function.
    //
    // Forced past the dirty check, and unconditionally rather than only when
    // something changed: what these rows record is a body ceasing to exist, and
    // there is nothing to compare that against.
    for (const [actorId, death] of this.pendingDeathWrites) {
      // **The spawn point, not the cell they fell in.** Their position row is
      // overwritten rather than left alone, because leaving it is what put
      // people back wherever the last flush caught them — up to a whole
      // {@link ACTOR_FLUSH_INTERVAL_MS} of walking ago.
      const spawn = this.spawns.get(actorId);
      if (spawn) entries[this.positionKey(actorId)] = { ...spawn, savedAt };
      // A fresh kit, not the emptied one: what they were carrying is on the
      // floor where they died and is theirs again if they walk back for it, but
      // coming back with no bag at all would leave them unable to pick it up.
      // This is the same kit the world hands somebody who has never been here —
      // which, as far as their pockets are concerned, is what they now are.
      //
      // Written rather than deleted, though "give them the starting kit" is
      // exactly what a missing row means to {@link GameSession.spawn}: a delete
      // cannot ride in this `put`, and a second call is a second moment at which
      // the board and the kit can disagree. The refused-drop case is the one
      // exception — nothing reached the floor, so they still own all of it.
      // Every slot, read off the one list of them: a hand-written triple here is
      // the shape the off hand has already been left out of once.
      const stillOwned = wornInstances(death.equipment).length > 0;
      entries[this.equipmentKey(actorId)] = {
        equipment: stillOwned ? death.equipment : session.startingKit(),
        savedAt,
      };
      if (death.tags.length > 0) {
        entries[this.tagsKey(actorId)] = { tags: [...death.tags], savedAt };
      }
      if (death.masteryXp) {
        entries[this.masteriesKey(actorId)] = {
          masteries: { ...death.masteryXp },
          savedAt,
        };
      }
      // **Reset, not remembered — and unconditionally, like the kit above.**
      // These are the two rows a death would otherwise leave exactly as they
      // were, because the loop above skips a body with no position and this one
      // never touched them. What storage holds at that moment is whatever the
      // last flush caught: a fraction of a health bar, and whatever was eating
      // through it. Coming back on three hit points still poisoned is coming
      // back to die again, and by a debt run up by a body that no longer
      // exists.
      //
      // The rule underneath is that a rebirth is a fresh `player` body and not
      // a repaired corpse. Position, kit and these two are all there is to that
      // body; the tags and the masteries are the person rather than the body,
      // which is why they ride across a death and these do not.
      //
      // A stored null and an empty list rather than two deletes, on exactly the
      // grounds the kit is written rather than deleted: a delete cannot ride in
      // this `put`, and a second call is a second moment at which these and the
      // board can disagree. Both read back as "nothing to restore" — see
      // {@link lastHpOf}, which takes a stored null and an absent key as the
      // same fact, and {@link GameSession.spawn}, which takes an empty list as
      // under nothing.
      entries[this.hpKey(actorId)] = { hp: null, savedAt };
      entries[this.statusesKey(actorId)] = { statuses: [], savedAt };
    }
    this.pendingDeathWrites.clear();

    // The board, in the same batch as the kits read off it. **This is what
    // stops an item existing twice.** Picking something up takes it off the map
    // and puts it in a bag, so a kit made durable against a map that was not
    // would come back to a floor still holding the thing it claims. One write,
    // one moment, and the two cannot disagree.
    const map = session.getMap();
    if (map !== this.checkpointedMap) {
      entries[CHECKPOINT_KEY] = {
        spawn: session.getSpawnPoint(),
        seed: session.getSeed(),
        dead: [...this.dead],
      };
      // Only the chunks that moved, and *in the same batch* — the atomicity
      // above is between a kit and the board it was read off, and a board split
      // across keys is still one board as long as it is one write.
      //
      // A chunk that has emptied is written as an empty record rather than
      // deleted, which is what keeps that true: a delete cannot ride in a `put`,
      // and a separate call is a second moment at which half the board can be
      // durable.
      for (const chunk of changedChunks(this.checkpointedMap, map)) {
        entries[boardKey(chunk.levelKey, chunk.chunkKey)] = chunk.cells;
      }
      this.checkpointedMap = map;
    }

    if (Object.keys(entries).length === 0) return;

    // Logged rather than swallowed. There is still nothing useful to *do* about
    // a write that did not stick — the world has already broadcast what it
    // records, and throwing here would take the whole object down over a
    // position — but a checkpoint failing quietly is how a world comes to hand
    // everybody back where they stood an hour ago with nothing anywhere saying
    // why. Observability is on, so this reaches the logs.
    this.ctx.storage
      .put(entries, { allowUnconfirmed: true })
      .catch(GameServer.reportWriteFailure("checkpoint write"));
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
    await this.pruneOldest(TAGS_KEY_PREFIX);
    await this.pruneOldest(STATUSES_KEY_PREFIX);
    await this.pruneOldest(HP_KEY_PREFIX);
    await this.pruneOldest(MASTERIES_KEY_PREFIX);
    await this.pruneOldest(SPAWN_KEY_PREFIX);
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

  /**
   * Seat somebody who has just connected.
   *
   * Was a `fetch` returning a 101 with a socket attached, because a Durable
   * Object could only be reached by request. The upgrade is the HTTP layer's
   * business now — `server/index.ts` does it — and what is left here is the
   * part that was always about the world.
   *
   * **The socket is registered before the world is loaded, and the order still
   * matters.** Loading reaps any actor in the checkpoint with no connection, so
   * loading first would find this actor connectionless, throw away the body the
   * checkpoint was keeping for them, and put them back at spawn. Messages
   * arriving in the gap are safe: {@link webSocketMessage} loads for itself.
   */
  async join(socket: GameSocket, actorId: string): Promise<void> {
    this.ctx.acceptWebSocket(socket);
    socket.serializeAttachment({ actorId } satisfies Attachment);

    await this.ensureLoaded();

    // A new socket is a reload, and a reload is still a way back from being
    // killed — it was the only one before the death screen's button, and it
    // stays honest beside it: whatever state a tab has got itself into, opening
    // the page again hands you a body.
    await this.seatActor(actorId);
    this.events.push({
      kind: "joined",
      actorId,
      playerCount: this.playerCount(),
    });

    this.sendHello(socket, actorId);
    // A join moves the board, so it has to be broadcast even if nobody is
    // pressing anything.
    this.wake();
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
  private playerCount(excluding?: GameSocket): number {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === excluding) continue;
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment) ids.add(attachment.actorId);
    }
    return ids.size;
  }

  private sendHello(ws: GameSocket, actorId: string) {
    const session = this.session!;
    const actors = session.actorSnapshots();
    const message: ServerMessage = {
      type: "hello",
      selfId: actorId,
      map: flattenMap(session.getMap()),
      actorIds: session.actorIds(),
      hps: currentHps(actors),
      carriedLights: currentCarriedLights(actors),
      statusIds: currentStatusIds(actors),
      // Theirs alone, and sent in full here for the same reason the map and the
      // hit points are: a joiner has nothing to patch against.
      equipment: session.equipmentOf(actorId) ?? emptyEquipment(),
      // Beside the kit, and needed before the first frame for a sharper reason:
      // a client with no tags offers every reward in the room, so a joiner
      // without this is shown chests it will be refused at.
      tags: [...(session.tagsOf(actorId) ?? [])],
      // Beside the tags and for the same failure one step along: the body at
      // the far end is the one this player left, so a wait they started before
      // the tab closed is still running, and a joiner without this would be
      // shown resources it is about to be refused at.
      extractCooling: [...session.extractCoolingOf(actorId)],
      // Theirs alone, beside the kit and the tags, and in full for the same
      // reason all three are: a joiner has nothing to patch against, and the
      // panel showing it is on screen before the first blow.
      masteryXp: { ...(session.masteryXpOf(actorId) ?? {}) },
      // Theirs alone again, and in full on arrival for the reason all of these
      // are: there is nothing to patch against, and the lane that draws them is
      // on screen before the first berry.
      statuses: session.statusPatchesOf(actorId) ?? [],
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

  async webSocketMessage(ws: GameSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string") return;
    await this.ensureLoaded();

    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) return;

    const message = parseClientMessage(raw);
    if (!message) return;

    const session = this.session!;
    const { actorId } = attachment;

    // Ahead of the gate below, and the only message that is. That gate is "does
    // this actor have a runtime", and a death deletes it — so every other
    // message from a dead client is dropped there, which is exactly the point.
    // This one is the request to stop being dead, and asking it of the runtime
    // that no longer exists would make it unanswerable.
    if (message.type === "rebirth") {
      await this.rebirth(actorId);
      return;
    }

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
    } else if (message.type === "cast") {
      // Re-asked in full on this side, on exactly the terms a swing's cooldown
      // is: the client dimmed the button from these same rules, but it dimmed it
      // against a kit and a target that may both be a round trip old — and a
      // client that made the message up gets the same answer. The equipment
      // message flushed below is the only confirmation there is, which is why
      // this sits in the chain rather than returning early.
      session.cast(message.square, actorId);
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
    } else if (message.type === "equip") {
      // Re-validated on the same terms a pickup is, plus the one rule that is
      // this message's own: the slot has to still be empty. The client offered
      // "Wield" against a hand that may have filled since.
      session.equip(message.ref, actorId);
    } else if (message.type === "moveItem") {
      // Every rule asked again here, reach above all: a ground endpoint names a
      // container the client had a panel open on, and the panel may have been
      // open while its owner walked away from it. The client offered the drag
      // from these same rules, and is still not trusted with the answer.
      session.moveItem(message.from, message.to, actorId);
    } else if (message.type === "consume") {
      // Both arms re-validated in the session on the same terms as a pickup or
      // a move: the client offered "Eat" from these rules, on a board a round
      // trip old, and is not trusted with the answer.
      session.consume(message.from, actorId);
    } else if (message.type === "transmute") {
      // Reach, the recipe existing, having the input, and having room for what
      // comes back — all re-asked in the session, on the same terms a reward
      // is. The client offered the row from these rules, on a board and a bag
      // that may both be a round trip old.
      session.transmute(message.ref, message.recipe, actorId);
    } else if (message.type === "command") {
      // Nothing is checked here beyond the schema, and nothing about the sender
      // either: every command in the game is an admin command with no admin —
      // see `app/game/commands`. The flushes below are why this sits in the
      // chain rather than returning early like `say` does: a command answers
      // with a notice and, depending on the verb, a mastery block or a cell of
      // the board — and all of them go out on that tail.
      session.runCommand(message.text, actorId);
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
    this.flushSounds();
    this.flushBlows();
    this.flushTags();
    this.flushExtractCooling();
    this.flushNotices();
    this.flushMasteries();
    // Eating happens between ticks, and the world may be asleep when it does —
    // the same reason the kit is flushed here rather than only on the loop.
    this.flushStatuses();
    this.wake();
  }

  /**
   * Send anything a message caused to be heard, before the next tick swallows
   * it.
   *
   * Input arrives *between* ticks, and {@link GameSession.tick} empties both
   * pages at its top — so a crunch recorded by a consume would be cleared
   * before the tick's own drain ever saw it, and nobody would hear a thing.
   * Drained here instead, onto the identical fan-out, for the same reason
   * {@link flushEquipment} exists beside it: a kit and a crunch both change on
   * input rather than on the clock.
   *
   * Both channels rather than only noise, though only noise can reach it today.
   * A message that makes somebody speak is an obvious next thing to want, and a
   * flush that quietly covered one of the two would be a trap laid for it.
   *
   * Draining is idempotent, so a message that made no sound costs two empty
   * arrays and sends nothing.
   */
  private flushSounds() {
    const session = this.session;
    if (!session) return;
    const said = session.drainSpeech();
    const made = session.drainNoise();
    if (said.length === 0 && made.length === 0) return;
    const actors = session.actorSnapshots();
    for (const bubble of said) this.broadcastChat(actors, bubble);
    for (const noise of made) {
      const { id, text, x, y, z, stackIndex } = noise;
      this.sendToLevel(z, actors, {
        type: "noise",
        id,
        text,
        x,
        y,
        z,
        stackIndex,
      });
    }
  }

  /**
   * Send anything a message caused to be *seen*, before the next tick swallows
   * it.
   *
   * The twin of {@link flushSounds}, on the same argument and closing the same
   * hole one page over: input arrives *between* ticks and
   * {@link GameSession.tick} empties every page at its top, so a receipt or a
   * flight recorded by a cast is cleared before the tick's own collection ever
   * sees it. A swing never had this problem because a swing happens *inside* the
   * tick; a cast is a message.
   *
   * **This is what a bolt fired and nobody saw.** Both pages, and both of them
   * genuinely reachable from input now: the number floating off whoever the
   * bolt landed on, and the mote in the air on its way there. A flush that
   * covered one of the two would be exactly the trap {@link flushSounds} says
   * it is refusing to lay.
   *
   * Onto `events` rather than straight down a socket, because that is where the
   * tick's own collection puts them and they have to arrive in one order — the
   * wake below starts the loop that broadcasts them. Draining is idempotent, so
   * a message that hit nobody costs two empty arrays and sends nothing.
   */
  private flushBlows() {
    const session = this.session;
    if (!session) return;
    this.collectDamageEvents(session);
    this.collectProjectileEvents(session);
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
   * Tell anybody whose tags changed what they have taken now.
   *
   * Its own drain and its own message, sent from the same places the kit is —
   * they change together today, and the two queues are what keeps that a fact
   * about rewards rather than an assumption in the plumbing.
   */
  /**
   * Tell whoever's waits changed which resources they may not work yet.
   *
   * Beside {@link flushTags} and shaped exactly like it, because it is the same
   * kind of fact: per player, whole state, and only to the socket it is about.
   * A separate queue rather than a flag on that one, on the session's own
   * argument — a wait ends on a tick nothing else happened, and sharing a queue
   * would put a tag list on the wire every time a bush came ready.
   */
  private flushExtractCooling() {
    const session = this.session;
    if (!session) return;
    const changed = session.drainExtractCoolingChanges();
    if (changed.length === 0) return;

    const wanted = new Set(changed);
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (!attachment || !wanted.has(attachment.actorId)) continue;
      ws.send(
        JSON.stringify({
          type: "extractCooling",
          cooling: [...session.extractCoolingOf(attachment.actorId)],
        } satisfies ServerMessage),
      );
    }
  }

  private flushTags() {
    const session = this.session;
    if (!session) return;
    const changed = session.drainTagChanges();
    if (changed.length === 0) return;

    const wanted = new Set(changed);
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (!attachment || !wanted.has(attachment.actorId)) continue;
      const tags = session.tagsOf(attachment.actorId);
      // Gone between the change and the flush, exactly as a kit can be.
      if (!tags) continue;
      ws.send(
        JSON.stringify({
          type: "tags",
          tags: [...tags],
        } satisfies ServerMessage),
      );
    }
  }

  /**
   * Say whatever the board has to say to the people it happened to.
   *
   * Drained per socket rather than in one sweep, because the queue is keyed by
   * actor and there is nothing useful to do with a line for somebody who is not
   * here: `GameSession` holds it, and they read it when they come back.
   *
   * Several lines can be waiting for one player — a chest opened on the same
   * tick something else spoke — so this sends each in turn rather than joining
   * them. The client's stack is what decides how many of them are readable; see
   * `app/render/notifications.ts`.
   */
  private flushNotices() {
    const session = this.session;
    if (!session) return;

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (!attachment) continue;
      for (const text of session.drainNotices(attachment.actorId)) {
        ws.send(JSON.stringify({ type: "notice", text } satisfies ServerMessage));
      }
    }
  }

  /**
   * Tell anybody whose experience moved what they have learnt now.
   *
   * The busiest of the three by a long way — roughly one message per landed
   * blow, to one socket — and cheap for the same reason the others are: it is
   * addressed rather than broadcast, so a room of twenty people fighting is
   * twenty small sends rather than twenty serializations of everybody's.
   *
   * Copied on the way out, because what the session hands back is the live block
   * it goes on adding to.
   */
  private flushMasteries() {
    const session = this.session;
    if (!session) return;
    const changed = session.drainMasteryChanges();
    if (changed.length === 0) return;

    const wanted = new Set(changed);
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (!attachment || !wanted.has(attachment.actorId)) continue;
      const masteryXp = session.masteryXpOf(attachment.actorId);
      // Gone between the change and the flush — the blow that taught them
      // something was also the one that killed them.
      if (!masteryXp) continue;
      ws.send(
        JSON.stringify({
          type: "masteries",
          masteryXp: { ...masteryXp },
        } satisfies ServerMessage),
      );
    }
  }

  /**
   * Tell anybody whose statuses have moved what is running on them now.
   *
   * The fourth of these, and the only one whose queue fills on its own: a kit,
   * a tag and a mastery all change because somebody did something, and this
   * changes because time passed. `GameSession` compares a **reading** rather
   * than the list, which is what keeps a status that runs for an hour to about
   * thirty-six hundred small sends instead of a hundred thousand.
   *
   * Addressed rather than broadcast, and that is not an economy here but a
   * correctness point: nothing draws another body's statuses, so nobody else has
   * any use for them.
   */
  private flushStatuses() {
    const session = this.session;
    if (!session) return;
    const changed = session.drainStatusChanges();
    if (changed.length === 0) return;

    const wanted = new Set(changed);
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (!attachment || !wanted.has(attachment.actorId)) continue;
      const statuses = session.statusPatchesOf(attachment.actorId);
      // Gone between the change and the flush — the poison that ticked was also
      // the one that killed them.
      if (!statuses) continue;
      ws.send(JSON.stringify({ type: "statuses", statuses } satisfies ServerMessage));
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
      // **A queued step can outlive the body that asked for it.** The step is
      // taken from the wire on one tick and applied on the next, and in between
      // its owner can die — walking into a fire is exactly that, with a step
      // still queued behind the one that killed them. `noteDeaths` clears the
      // queue, but it runs *after* this in `tick`, so by the time it would have
      // tidied up this loop has already asked the session for an actor that is
      // no longer in it.
      //
      // Dropping the queue is the whole correction: steps address a body, and
      // there is no longer a body to move.
      if (!session.hasActor(actorId)) {
        this.queuedSteps.delete(actorId);
        continue;
      }

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
   * Make the noises anything made, to the floor they were made on.
   *
   * Beside {@link broadcastSpeech} and deliberately not folded into it: what
   * goes out is a different message carrying different fields, because a noise
   * has no speaker to name. Not logged either — the chat log is a record of
   * what people *said*, and a hiss is not testimony.
   */
  private broadcastNoise(session: GameSession, actors: ActorSnapshot[]) {
    for (const noise of session.drainNoise()) {
      const { id, text, x, y, z, stackIndex } = noise;
      this.sendToLevel(z, actors, {
        type: "noise",
        id,
        text,
        x,
        y,
        z,
        stackIndex,
      });
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

  async webSocketClose(ws: GameSocket) {
    await this.dropSocket(ws);
  }

  async webSocketError(ws: GameSocket) {
    await this.dropSocket(ws);
  }

  private async dropSocket(ws: GameSocket) {
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
    if (this.hasSocket(attachment.actorId, ws)) return;

    // Before the despawn, which is what takes their tile — and with it the only
    // record of where they were — off the board.
    //
    // Forced past the dirty check, and not because anything here is likely to be
    // stale: a skipped row keeps whatever `savedAt` it last had, and `savedAt`
    // is what {@link pruneOldest} ranks by. Somebody who stood still for an hour
    // and then left would otherwise be carrying an hour-old stamp into the queue
    // of who gets forgotten first, which is precisely backwards.
    this.saveActors([attachment.actorId], true);
    this.session?.despawn(attachment.actorId);
    this.writtenActors.delete(attachment.actorId);
    this.sentMotion.delete(attachment.actorId);
    this.queuedSteps.delete(attachment.actorId);
    this.lastSaidAt.delete(attachment.actorId);
    // Their last socket has gone, so there is nothing left to be silent
    // towards. `dead` is deliberately *not* cleared beside it — that is the
    // record keeping them off the board, and closing a tab is not a way to come
    // back to life. This is only the sending rule, and it has nobody to apply
    // to; left behind, it would be a row per player the world has ever killed,
    // growing with visitors rather than with anything.
    this.silenced.delete(attachment.actorId);
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
   *
   * `keepPositions` re-seats everyone where they were standing instead of at
   * the new world's spawn. It is what a *deploy* wants — the map changed under
   * people who were just playing, and marching them all to spawn makes every
   * merge to main an event — and it is safe against the map having changed
   * shape, because a remembered cell is a wish: {@link findEntryCell} bubbles
   * outward from it and falls back to spawn when nothing nearby fits. The
   * editor's save deliberately does not pass it, so an author watching their
   * own edit still sees the world start over.
   */
  async replaceWorld(
    flat: FlatMapFile,
    options: { keepPositions?: boolean } = {},
  ): Promise<void> {
    const store = this.store();
    const tiles = await store.readTiles();
    // Re-read rather than reused, on exactly the terms the tiles are: a save is
    // the repair path, and it must not depend on the state of the world it is
    // replacing.
    const statusDefs = statusesById(await store.readStatuses());

    const map = chunkifyMap(flat);
    // Throws for a map that cannot start — before a single byte is written.
    const session = new GameSession(map, tiles, {
      actorIds: [],
      statuses: statusDefs,
    });

    await store.writeMap(map);
    await this.ctx.storage.delete(CHECKPOINT_KEY);
    await this.deleteCheckpointedBoard();
    // The new board shares chunk keys with the old one but none of its chunk
    // *objects*, so a diff against the world that was just thrown away would be
    // sound but pointless — and leaving a stale baseline here would be neither.
    // Null makes the first flush write the whole new board out.
    this.checkpointedMap = null;

    // Read off the outgoing session, and read *here* — this is the last moment
    // it exists, and it holds the only copy of anybody's kit that is newer than
    // the last five-second flush. A player who picked something up four seconds
    // before somebody hit save is carrying it only in memory.
    const carried = new Map<string, Equipment>();
    const taken = new Map<string, string[]>();
    const learnt = new Map<string, MasteryXp>();
    const running = new Map<string, readonly StatusInstance[]>();
    const health = new Map<string, number>();
    const standing = new Map<string, ActorPosition>();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (!attachment) continue;
      // Where they are standing, if anybody asked for that to survive. Off the
      // runtime rather than the `pos:` rows because a flush is up to
      // `ACTOR_FLUSH_INTERVAL_MS` behind — the same staleness argument the kit
      // read above makes. A dead player has no runtime and lands nothing here,
      // which is right: `dead` is cleared below, and where a body that no
      // longer exists last stood is not a place anybody should come back to.
      if (options.keepPositions) {
        const position = this.session?.actorPosition(attachment.actorId);
        if (position) standing.set(attachment.actorId, position);
      }
      const kit = this.session?.equipmentOf(attachment.actorId);
      if (kit) carried.set(attachment.actorId, kit);
      // Read here rather than from storage alone, for the reason the kit is: a
      // reward taken since the last flush is on the runtime and nowhere else,
      // and the world it was taken in is about to be replaced.
      const tags = this.session?.tagsOf(attachment.actorId);
      if (tags?.length) taken.set(attachment.actorId, [...tags]);
      // And the masteries, for the same reason again and with the least to
      // argue about of the three: a save is a statement about the world, and
      // nothing an author writes in one has any bearing on what a player has
      // already learnt.
      const masteries = this.session?.masteryXpOf(attachment.actorId);
      if (masteries) learnt.set(attachment.actorId, { ...masteries });
      // And what is running on them, with what it has already done to them. A
      // save re-creates the world, not the people standing in it, and a berry
      // eaten four seconds before somebody hit save is on the runtime and
      // nowhere else. Dropping the pair would cure every poison in the world
      // and heal every wound, once per save — and the editor saves constantly.
      const statuses = this.session?.statusesOf(attachment.actorId);
      if (statuses?.length) running.set(attachment.actorId, statuses);
      const hp = this.session?.storedHpOf(attachment.actorId);
      if (hp !== null && hp !== undefined) health.set(attachment.actorId, hp);
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
    // Everybody is about to be re-seated in the new world, so every
    // position this instance believed it had written is now a claim about a
    // board that no longer exists. Cleared rather than corrected: the next flush
    // then writes each of them once, which is the same self-healing pass
    // `checkpointedMap = null` above buys for the board.
    this.writtenActors.clear();
    // A new world is a clean slate for the dead as much as for the living:
    // everyone still connected is seated in it below, so holding a grudge from
    // the world that no longer exists would leave somebody permanently absent
    // from one they never died in.
    this.dead.clear();
    // And with nobody dead there is nobody to be silent towards. Cleared beside
    // the set it is derived from, so the two cannot disagree: the `hello` below
    // reaches every socket, and a stale entry here would leave one of them
    // reading it and then never hearing another word.
    this.silenced.clear();
    // The marker may have moved — a save is a fresh statement of where the world
    // begins — so every remembered door is now a claim about a building that no
    // longer stands. Dropped rather than corrected, on the terms
    // `checkpointedMap = null` above is: the next join re-derives each one from
    // the map that actually exists.
    this.spawns.clear();
    await this.deleteSavedSpawns();
    this.lastSaidAt.clear();
    // Every queued step was aimed at a board that no longer exists. They are
    // dropped rather than refused: the `hello` below resets each client's
    // prediction wholesale, so there is nothing left to roll back.
    this.queuedSteps.clear();
    this.events = [];

    // Everyone still connected re-enters the new world — at its spawn point,
    // or where they were standing when `keepPositions` asks for that —
    // carrying what they were carrying and everything they have already taken.
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
    // Their tags travel for the same reason and with less to argue about: a tag
    // records something that happened to the *player*, so a new map has nothing
    // to say about it at all. Dropping them would refill every reward in the
    // world for everybody standing in it, once per save — and the editor saves
    // constantly.
    //
    // The kit is checked against the new tiles on the way in, on the same terms
    // {@link lastEquipmentOf} checks a remembered one: the save may have brought
    // a new catalogue with it, and a sword that has become a prop in it is a kit
    // this world no longer agrees with. A tag is never checked against anything
    // — see {@link TAGS_KEY_PREFIX}. Storage is the fallback for the world that
    // was too broken to have a session at all.
    const tilesById = tilesByIdFromList(tiles);
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (!attachment) continue;
      const kit = carried.get(attachment.actorId);
      this.session.spawn(attachment.actorId, {
        // Honoured only if the cell still has room for them; `findEntryCell`
        // bubbles outward and gives up at the new spawn, so a position kept
        // across a deploy can never seat somebody inside a wall.
        at: standing.get(attachment.actorId),
        carrying: kit
          ? restoredEquipment(kit, tilesById)
          : await this.lastEquipmentOf(attachment.actorId),
        tagged:
          taken.get(attachment.actorId) ??
          (await this.lastTagsOf(attachment.actorId)),
        earned:
          learnt.get(attachment.actorId) ??
          (await this.lastMasteriesOf(attachment.actorId)),
        statuses:
          running.get(attachment.actorId) ??
          (await this.lastStatusesOf(attachment.actorId)),
        hp: health.get(attachment.actorId) ?? (await this.lastHpOf(attachment.actorId)),
      });
    }
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment) this.sendHello(ws, attachment.actorId);
    }
    this.wake();
  }

  /**
   * Pick up authored content that has just been written, without disturbing the
   * world it describes.
   *
   * **A tile save used to reach the store and stop there.** {@link load} reads
   * the catalogue once per world — it is guarded on there being no session — so
   * an author who edited a stone's cooldown, a sword's damage or a status's
   * duration changed what the *next* world would be built from and nothing
   * about the one they were standing in. The map editor never had this problem
   * because saving a map goes through {@link replaceWorld}, which re-reads both
   * catalogues on its way past; the tile editor had no equivalent.
   *
   * It was invisible until a number a player *watches* changed. An arcane
   * stone's cooldown is the first of those: the server went on spending the old
   * one while the reloaded browser drew the bar against the new one, so it sat
   * pinned at full and looked frozen rather than merely stale.
   *
   * ## It is an eviction, on purpose
   *
   * Checkpoint, drop the session, load again. That is precisely what
   * hibernation already does to this object, which is why it is the shape to
   * borrow rather than a re-seating written specially: everybody's position,
   * kit, tags, experience, statuses and hit points survive a wake because a
   * great deal of care was taken to make them, and {@link restoreActors} at the
   * end of {@link load} re-seats every socket that is still open. Nothing here
   * has to know that list exists.
   *
   * **Not {@link replaceWorld}**, which is about a new *board*: it deletes the
   * checkpoint, re-derives the spawn registry and drops every pending respawn,
   * none of which a content save has any business doing — the board has not
   * moved, only what the tiles on it mean. And not {@link resetWorld}, which is
   * destructive by design.
   *
   * The forced save is what makes the drop safe, and it is forced for the reason
   * a death's is: the board and every kit read off it go into one batch, so
   * there is no moment at which a reload could pick up one without the other.
   * The tick stops first, before the write, on {@link resetWorld}'s grounds —
   * a flush landing between the checkpoint and the drop would be writing a world
   * that is on its way out.
   *
   * A world that is not loaded needs nothing: the next {@link load} reads the
   * files that were just written, which is the whole of what this does.
   */
  async reloadContent(): Promise<void> {
    // A load already in flight is reading the catalogue this save supersedes.
    // Waited for rather than returned past: the world it brings up is then
    // reloaded again below, against the files as they are now. Returning
    // instead would drop the second of two quick saves, and the editor is a
    // place where two quick saves happen.
    if (this.loading) await this.ensureLoaded();

    const session = this.session;
    if (!session) return;

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Everybody and the board, in one batch, before either can move again.
    this.saveActors(session.actorIds(), true);

    this.session = null;
    // A load in flight was reading the catalogue that has just been superseded.
    // Left in place, `ensureLoaded` below would await it and adopt its result —
    // the same trap `resetWorld` clears this for.
    this.loading = null;
    await this.ensureLoaded();

    // **And everybody is told, which a wake from hibernation deliberately does
    // not do.** A wake resumes the same board against the same catalogue, so a
    // client's copy is still true and the patch stream picks up where it left
    // off. This is the opposite case: the tiles have changed meaning, the new
    // session re-settled the board on its way up, and `broadcastMap` was reset
    // to that settled board — so nothing would ever be diffed out, and every
    // client would go on drawing a world the server has already moved on from.
    // {@link replaceWorld} sends a `hello` for exactly this reason, and this is
    // the same reason.
    //
    // What it cannot fix is the client's own catalogue, which reaches a browser
    // only when the page loads. An author still reloads to see their new art;
    // what they no longer have to do is reload to make the *world* obey them.
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment) this.sendHello(ws, attachment.actorId);
    }
    this.wake();
  }

  /**
   * Throw the world away — the board, the people in it, and every last thing
   * this object remembers about anybody — and start again from the authored
   * files.
   *
   * **This is not a bigger {@link replaceWorld}, and the difference is the
   * point.** A save is a statement about the *world*: it re-creates the map and
   * carries every player's kit, tags and masteries across, deliberately,
   * because nothing an author writes in a map has any bearing on what a player
   * is holding or has learnt. Every other mechanism here pulls the same way —
   * a checkpoint is preferred to the authored map so an eviction does not
   * teleport a room full of people, and a tag is never checked against the
   * world so a re-authored chest cannot be refilled underneath somebody.
   *
   * That is all correct until the thing that has to go *is* what the object
   * remembers, at which point there is no route to it. Seeding the bucket
   * cannot reach it, a save carries it forward, and an eviction preserves it.
   * A player whose stored state disagrees with the content it was written
   * against — a mastery block, a tag naming a reward that has been
   * re-authored, a kit of tiles that have changed meaning — stays that way
   * through everything, and there is no repair short of not remembering them.
   *
   * So: `data/` is the source of truth in the repo, R2 is the source of truth
   * in production, and this object is the source of truth for the running
   * world. Nothing reconciles the three. This is the reconciliation, and it is
   * destructive by design — every position, kit, tag and mastery in the world
   * is dropped, and everyone still connected re-enters as somebody this world
   * has never met.
   */
  async resetWorld(): Promise<void> {

    // The tick and the session go together, and *before the first await*.
    // A flush is the one thing here that writes the world back out, and one
    // landing between the wipe and the reload would restore the very checkpoint
    // being deleted — `saveActors` reads the live session and puts it straight
    // back. Dropping both in the same synchronous run leaves no moment at which
    // that can happen: `saveActors` returns immediately on a null session, and
    // nothing else writes the board.
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.session = null;
    // A load in flight was reading the world that is about to stop existing.
    // Left in place, `ensureLoaded` below would await it and adopt its result.
    this.loading = null;

    // The chat log is not a key. `deleteAll` empties the key-value side, and a
    // table made through `storage.sql` stands through it holding what a world
    // that no longer exists said — so it goes by name. Before the wipe rather
    // than after, on the principle that a statement against the database is
    // safest while the database is indisputably there; both orders work today.
    this.ctx.storage.sql.exec("DROP TABLE IF EXISTS chat");
    this.chatLogReady = false;
    // A respawn deadline outliving the world it was owed to would wake a fresh
    // object to refill a spawn point that means nothing in it. Explicitly,
    // rather than trusting the wipe to have taken it along with the keys.
    await this.ctx.storage.deleteAlarm();

    await this.ctx.storage.deleteAll();

    // Only what {@link load} does not write for itself. It re-reads the tiles,
    // builds the session, and rebuilds the board, the dead and the respawn
    // registry from what is now an empty store — what it has no opinion about
    // is the per-client bookkeeping, which describes a world these clients are
    // about to stop being in.
    this.sentMotion.clear();
    this.sentHp.clear();
    this.sentCarriedLights.clear();
    this.sentStatusIds.clear();
    this.queuedSteps.clear();
    this.lastSaidAt.clear();
    this.events = [];
    // A death still waiting to be announced belongs to the world being thrown
    // away, and the `hello` below is about to seat its owner as a stranger.
    // Announcing it after that would put a death screen over a body that is
    // standing at spawn. `silenced` needs no line of its own: `restoreActors`
    // rebuilds it from the checkpointed dead, and the wipe left none.
    this.justDied = [];
    // Storage is empty as of the wipe above, so anything this instance believed
    // it had written down is now a belief about rows that are gone.
    this.writtenActors.clear();
    // So the first tick of the new world flushes rather than waiting out the
    // rest of an interval that was being counted for the old one.
    this.actorsSavedAt = 0;

    // Reads the authored map and tiles back out of `data/`, and — with every
    // per-actor key gone — seats everybody still connected as a stranger: at
    // the spawn point, with the starting kit, no rewards taken, and exactly the
    // masteries their tile says they have.
    await this.ensureLoaded();
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
    this.timer = setInterval(() => this.tickSafely(), TICK_MS);
  }

  /**
   * Run a tick, and survive one that throws.
   *
   * **A platform used to do this.** An exception inside a Durable Object's
   * timer was caught by the runtime and cost that tick; the same exception
   * inside `setInterval` here is an uncaught exception, which ends the process
   * — so one bad tick disconnected everybody, lost up to a checkpoint interval,
   * and handed the whole world to the restart policy. A queued step belonging
   * to somebody who had just walked into a fire was enough to do it.
   *
   * Ticking continues afterwards, deliberately. A world frozen at the moment it
   * first went wrong is worse than one that skips a frame and says so: the skip
   * is visible in the log and survivable, where the freeze looks like a running
   * world to every socket watching it.
   *
   * The repeat counter is because a fault in the simulation is rarely a one-off
   * — at thirty ticks a second, an unguarded log would bury the first and most
   * useful report under thousands of copies within a minute.
   */
  private tickSafely() {
    try {
      this.tick();
      this.consecutiveTickFailures = 0;
    } catch (error) {
      this.consecutiveTickFailures += 1;
      const n = this.consecutiveTickFailures;
      if (n === 1 || n % TICK_FAILURE_LOG_INTERVAL === 0) {
        console.error(
          `[world] tick failed (${n} in a row, still ticking)`,
          error,
        );
      }
    }
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
    //
    // Forced, for the reason the close is and one more: this is where a world
    // goes quiet, so it is the one flush whose cost does not repeat, and paying
    // it in full leaves every stamp honest for whatever prunes them next.
    this.saveActors(session.actorIds(), true);
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
    this.collectProjectileEvents(session);
    this.collectTeleportEvents(session);
    this.collectSwingEvents(session);
    this.noteDeaths(session);
    this.broadcastSpeech(session, actors);
    this.broadcastNoise(session, actors);

    const cells = this.diffCells(session.getMap());
    this.sweepRespawnCells(cells);
    const hps = this.diffHps(actors);
    const carriedLights = this.diffCarriedLights(actors);
    const statusIds = this.diffStatusIds(actors);
    if (
      cells.length > 0 ||
      this.events.length > 0 ||
      hps.length > 0 ||
      carriedLights.length > 0 ||
      statusIds.length > 0
    ) {
      this.broadcast({
        type: "patch",
        cells,
        events: this.events,
        hps,
        carriedLights,
        statusIds,
      });
      this.broadcastMap = session.getMap();
      this.events = [];
    }

    // After the patch, which is the whole of the ordering: that patch is the
    // last thing these sockets will hear, and this is what tells them so.
    this.announceDeaths();

    // A kit can change on a tick as well as on input: food rots on the world's
    // clock, not on anybody's keypress, and the alternative is finding out by
    // way of a panel that never updates.
    this.flushEquipment();
    this.flushTags();
    this.flushExtractCooling();
    // Beside the tag, because it describes the same act — and on the tick as
    // well as on input for the same reason the kit is: nothing guarantees which
    // of the two got there first.
    this.flushNotices();
    // Unlike the two above, this one really does move on a tick: experience is
    // earned by swinging, and swinging is something the world does to itself.
    this.flushMasteries();
    // And this one moves on *every* tick by construction, which is precisely why
    // the session compares a reading rather than a list before queueing.
    this.flushStatuses();
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
          count: actor.slide.count,
        });
      }
      if (actor.strike && actor.strike !== sent?.strike) {
        this.events.push({
          kind: "strikeStarted",
          actorId: actor.id,
          strike: actor.strike.kind,
          dx: actor.strike.dx,
          dy: actor.strike.dy,
          dElev: actor.strike.dElev,
        });
      }

      this.sentMotion.set(actor.id, {
        walk: actor.walk,
        fall: actor.fall,
        slide: actor.slide,
        strike: actor.strike,
      });
    }
    for (const id of this.sentMotion.keys()) {
      if (!live.has(id)) this.sentMotion.delete(id);
    }
  }

  /**
   * Note whoever was killed, stop holding anything on their behalf, and write
   * down what is left of them.
   *
   * No event goes out: the cell patch that removes their tile is the whole of
   * the news, and every client already draws an actor by finding their body on
   * the board. What this is for is the *server's* own state — a queued step
   * aimed by a body that no longer exists, the record that keeps them off the
   * board across a wake, and the one chance to make a death durable.
   *
   * **A death is the moment the session stops being able to answer for
   * somebody.** Everything a reload hands back — where they were, what they
   * carried, what they had learned — is read from storage, and the runtime
   * holding it is deleted here. So the facts ride in on the {@link Death} and go
   * straight into a forced batch beside the board they belong to.
   *
   * Creatures land in the set too, harmlessly: nothing ever spawns one by id, so
   * their entry is inert. Filtering them out would mean asking the session which
   * of its actors was wildlife, to save a handful of strings. They are kept out
   * of the *write*, though, where a row per rat is not a handful of anything.
   */
  private noteDeaths(session: GameSession) {
    for (const death of session.drainDeaths()) {
      const actorId = death.id;
      this.dead.add(actorId);
      this.sentMotion.delete(actorId);
      this.sentHp.delete(actorId);
      this.queuedSteps.delete(actorId);
      // Or the map grows a row per body the world has ever killed, and a world
      // that respawns creatures kills a great many.
      this.writtenActors.delete(actorId);
      // A dead resident with a spawn point is not gone, only owed: the clock
      // on its return starts with the death itself.
      const point = this.respawnPoints.get(actorId);
      if (point) this.armRespawn(point, Date.now());

      // Only somebody who can come back. A socket is the exact test: a dead
      // player sits there connected until they reload, and a creature has never
      // had one — so this is "is there anyone to hand this to" without asking
      // the session, whose runtime for them is already gone. Without the test a
      // world that respawns wildlife would write a position and a kit per rat.
      if (!this.hasSocket(actorId)) continue;
      this.pendingDeathWrites.set(actorId, death);
      // The same test decides both: somebody with a socket is somebody to write
      // down *and* somebody to tell. See {@link tick} for why the telling waits
      // until after this tick's patch has gone out.
      this.justDied.push(death);
    }
    // **Forced, here, rather than left to the next flush.** The board this tick
    // leaves behind no longer holds the body and does hold its kit, and the rows
    // saying so are the ones above; a flush that carried one without the other
    // would hand somebody back a sword that is also lying on the floor, or take
    // one that is lying nowhere. They go in one batch, and it is this one —
    // deferring it would leave a reload in the gap reading the pre-death kit,
    // and a reload is the very next thing a dead player does.
    if (this.pendingDeathWrites.size > 0) {
      this.saveActors(session.actorIds(), true);
    }
  }

  /**
   * Tell whoever just died that they did, and stop talking to them.
   *
   * The order inside is the point. The `died` message goes out first and the
   * silence starts after it, so the message itself is not the first thing
   * dropped by the rule it announces.
   *
   * Carries the kit the {@link Death} recorded rather than asking the session
   * for it, because the session cannot answer: the runtime holding it was
   * deleted by the same call that filled this list. Normally empty — the pile
   * is on the floor — and the whole kit when the cell refused it, which is the
   * one case where the dead still own what they were carrying and must not be
   * shown an empty bag.
   */
  private announceDeaths() {
    if (this.justDied.length === 0) return;
    for (const death of this.justDied) {
      this.sendTo(death.id, { type: "died", equipment: death.equipment });
      this.silenced.add(death.id);
    }
    this.justDied = [];
  }

  /**
   * Put somebody back in the world with a body.
   *
   * The one path onto the board for a player, taken by all three ways of
   * getting there: a fresh socket, a wake that found one still open, and a
   * {@link rebirth} asked for from the death screen. Written once because the
   * order in it is load-bearing — the door has to be remembered before the
   * seating, since a death arriving in the gap has nowhere to put them back —
   * and three copies of an order is three chances to get it wrong.
   *
   * Clearing the death is not merely tidying: {@link dead} is what
   * {@link restoreActors} consults to leave a dead player's socket empty across
   * a wake, so a seating that left it set would be undone by the next eviction.
   *
   * Rejoining with the same id keeps the actor already on the board; the
   * remembered position is for somebody whose body is gone — they left, or
   * their connection died while this object was evicted and they were reaped.
   */
  private async seatActor(actorId: string) {
    this.dead.delete(actorId);
    this.silenced.delete(actorId);
    await this.rememberSpawn(actorId);
    this.session!.spawn(actorId, await this.restoredActor(actorId));
  }

  /**
   * Answer "put me back in" from a dead player.
   *
   * Reloading the page does the same thing by way of {@link fetch}, and did it
   * first — this exists so that coming back does not mean losing the tab. What
   * it costs over a reload is one `hello`, which a reload was paying anyway.
   *
   * **Answered with a whole `hello`, to every socket this player has.** A
   * silenced socket has been receiving nothing for as long as its owner sat on
   * the death screen, so its map is arbitrarily stale and there is no diff that
   * would catch it up. And two tabs are one person with one body: they died
   * together, so they come back together, rather than leaving the second one
   * watching a frozen board it will never be sent a patch for.
   *
   * Ignored unless they are actually dead. A live player asking for this would
   * otherwise be handed a second seating — harmless in itself, since `spawn`
   * keeps the body already on the board, but the `hello` behind it would throw
   * away every step they had predicted.
   */
  private async rebirth(actorId: string) {
    if (!this.dead.has(actorId)) return;
    await this.seatActor(actorId);
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment?.actorId !== actorId) continue;
      this.sendHello(ws, actorId);
    }
    // A body appearing moves the board, so it has to be broadcast even though
    // nobody pressed anything.
    this.wake();
  }

  /**
   * Whether anybody is still connected as this actor.
   *
   * @param excluding a socket on its way out. A closing connection is still
   *   listed by `getWebSockets` while its close is being handled — same as in
   *   {@link playerCount} — so it has to be excluded by identity rather than by
   *   its attachment, which is indistinguishable from the ones that are staying.
   */
  private hasSocket(actorId: string, excluding?: GameSocket): boolean {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === excluding) continue;
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment?.actorId === actorId) return true;
    }
    return false;
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
        outcome: hit.outcome,
        amount: hit.amount,
        x: hit.x,
        y: hit.y,
        z: hit.z,
        stackIndex: hit.stackIndex,
      });
    }
  }

  /**
   * Turn this tick's shots into events.
   *
   * Drained rather than diffed on exactly the terms a blow is, and for one more
   * reason: an arrow leaves nothing on the board at all. It is on no cell, it
   * displaces nothing, and the two bodies it was measured between may both have
   * moved by the time it lands — so there is no pair of readings anything could
   * recover it from.
   *
   * The whole flight is sent in one event and never touched again. There is no
   * per-tick position stream for the same reason a walk has none: the receiver
   * has two fixed points and a duration, which is enough to draw every frame of
   * it without being told any of them.
   */
  private collectProjectileEvents(session: GameSession) {
    for (const flight of session.drainProjectiles()) {
      this.events.push({
        kind: "projectileFired",
        id: flight.id,
        tileId: flight.tileId,
        from: flight.from,
        to: flight.to,
        durationMs: flight.durationMs,
      });
    }
  }

  /**
   * Turn this tick's trips into events.
   *
   * Drained rather than diffed, on the same terms a blow is: a teleport leaves
   * no state behind to compare two readings of, and the body simply being
   * somewhere else is exactly what the cell patches already say. The event says
   * the one thing they cannot — that a client's own guess about that body is
   * void.
   */
  private collectTeleportEvents(session: GameSession) {
    for (const actorId of session.drainTeleports()) {
      this.events.push({ kind: "teleported", actorId });
    }
  }

  /**
   * Turn this tick's blows into the plant each one costs.
   *
   * Drained rather than diffed, on the same terms a teleport is: what the
   * client needs is that a recovery *started*, and a number winding down cannot
   * say that — a body that swung again a tick early reads identically to one
   * that never stopped.
   *
   * The event is only ever acted on by the body that threw the blow, which is
   * why it carries nothing else: everybody else's footwork arrives already
   * gated, as `walkStarted` or as nothing at all.
   */
  private collectSwingEvents(session: GameSession) {
    for (const actorId of session.drainSwings()) {
      this.events.push({ kind: "swung", actorId });
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
      // Either number moving is worth a message, and the ⭐ is why this is a
      // pair rather than a single reading: a creature's never moves and a
      // player's moves without their hit points doing so.
      const rating = actor.rating ?? 0;
      const sent = this.sentHp.get(actor.id);
      if (sent?.hp === actor.hp && sent.rating === rating) continue;
      this.sentHp.set(actor.id, { hp: actor.hp, rating });
      out.push({
        actorId: actor.id,
        hp: actor.hp,
        maxHp: actor.maxHp,
        rating,
      });
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
   * Whose statuses have changed since the last patch, as ids.
   *
   * A diff of its own rather than a read of `drainStatusChanges`, and the two
   * must not be confused: that queue is drained to send the viewer their *own*
   * countdown, and reading it here would take the message out of their mouth.
   * This compares what was last broadcast, on exactly the terms
   * {@link diffCarriedLights} does — including forgetting a body that has left,
   * so a returning one is diffed against nothing rather than against whatever
   * its last life was under.
   */
  private diffStatusIds(actors: ActorSnapshot[]): StatusIdsPatch[] {
    const out: StatusIdsPatch[] = [];
    const live = new Set<string>();
    for (const actor of actors) {
      live.add(actor.id);
      const defIds = statusIdsOf(actor);
      const joined = defIds.join(",");
      if ((this.sentStatusIds.get(actor.id) ?? "") === joined) continue;
      this.sentStatusIds.set(actor.id, joined);
      out.push({ actorId: actor.id, defIds });
    }
    for (const id of this.sentStatusIds.keys()) {
      if (!live.has(id)) this.sentStatusIds.delete(id);
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
    // Read once rather than per socket, and skipped entirely while nobody is
    // dead — which is the normal state of a world. An attachment read is a
    // deserialization, and paying one per socket per tick to answer a question
    // whose answer is almost always "no" is the kind of cost this loop cannot
    // acquire.
    const anySilenced = this.silenced.size > 0;
    for (const ws of this.ctx.getWebSockets()) {
      if (anySilenced && this.isSilenced(ws)) continue;
      try {
        ws.send(payload);
      } catch {
        // A socket that died between the tick and this send is dropped by the
        // runtime; webSocketClose will clean the actor up.
      }
    }
  }

  /** Whether this socket belongs to somebody the world has stopped telling. */
  private isSilenced(ws: GameSocket): boolean {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    return attachment ? this.silenced.has(attachment.actorId) : false;
  }
}
