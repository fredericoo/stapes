import type { GameSocket, WorldContext } from "./sockets";
import * as v from "valibot";
import {
  GameSession,
  type ActorPosition,
  type ActorSnapshot,
  type Death,
} from "../app/game/GameSession";
import { TICK_MS } from "../app/game/constants";
import {
  BodyGrid,
  chunksEntered,
  covers,
  interestChunks,
  sameChunks,
  visibleStack,
  withinBodyReach,
  withinBodyReachOf,
} from "../app/net/interest";
import { audienceOf, cellInScope, type ScopedCell } from "../app/net/scope";
import { handoverCellsJson, mapOfInterestJson } from "./chunkJson";
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
import type { CastProgress, CastSlot } from "../app/game/casting";
import type { Progress } from "../app/game/progress";
import { resolveRespawn } from "../app/lib/interactions";
import { minutesOfDayAt, wrapMinutes, type MinutesOfDay } from "../app/lib/clock";
import { masteryXpBlockSchema, type MasteryXp } from "../app/lib/mastery";
import {
  changedCellsOnLevel,
  chunkKeyFor,
  changedChunks,
  chunkifyMap,
  getStack,
  mapFromChunks,
} from "../app/lib/mapData";
import type { DataStore } from "../app/lib/dataStore";
import { tilesByIdFromList } from "../app/lib/validation";
import { type StatusDef, statusesById } from "../app/lib/status";
import type { StatusInstance } from "../app/game/statuses";
import type {
  ChunkCells,
  Direction,
  FlatMapFile,
  MapFile,
  PlacedTile,
  TileDef,
} from "../app/lib/types";
import { MAX_LEVEL, MIN_LEVEL, parseCoordKey } from "../app/lib/types";
import { CHAT_MIN_INTERVAL_MS, sanitizeChatText } from "../app/net/chat";
import {
  CLOSE_REPLACED,
  parseClientMessage,
  type CarriedLightsPatch,
  type AfflictedPatch,
  type CellAffliction,
  type StatusIdsPatch,
  type PvpPatch,
  type CastingPatch,
  type ExtractionPatch,
  type CellPatch,
  type HpPatch,
  type NamePatch,
  type MotionEvent,
  type ServerMessage,
} from "../app/net/protocol";

/**
 * Everything in a tick's patch except the word "patch".
 *
 * Read off the message rather than written out again, so a field added to the
 * wire cannot be silently dropped by the scoping in between.
 */
type TickPatch = Omit<Extract<ServerMessage, { type: "patch" }>, "type">;

/**
 * The tick's patch before it is cut for anybody: the same fields, with the
 * cells still carrying what decides who they are news to.
 *
 * **Without the names**, which is the one field that has no shared form. Every
 * other list here is a diff of something that moved this tick and is the same
 * fact for everybody; a name is sent to one client because *that* client has
 * not met the body, so it only exists once the patch has been cut. @see
 * NamePatch
 */
type SharedPatch = Omit<TickPatch, "cells" | "names"> & { cells: ScopedCell[] };

/**
 * A patch that hands over ground and nothing else, as the two halves of its
 * JSON either side of the cells.
 *
 * Built from a typed patch rather than written out, so a field added to the
 * message is in here — empty — without anybody having to remember.
 */
const [GROUND_ONLY_HEAD, GROUND_ONLY_TAIL] = (() => {
  const empty: Extract<ServerMessage, { type: "patch" }> = {
    type: "patch",
    cells: [],
    events: [],
    hps: [],
    // Ground, and nothing standing on it: the bodies in handed-over cells are
    // stripped out, so there is nobody here to name.
    names: [],
    carriedLights: [],
    statusIds: [],
    pvp: [],
    extractions: [],
    castings: [],
  };
  const [head, tail] = JSON.stringify(empty).split('"cells":[]');
  return [`${head}"cells":[`, `]${tail}`];
})();

/** Which cell a burning placement is in, as a key. @see GameServer.sentAfflicted */
function cellAfflictionKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

function parseCellAfflictionKey(key: string): { x: number; y: number; z: number } {
  const [x, y, z] = key.split(",").map(Number);
  return { x: x!, y: y!, z: z! };
}

/** What a cell's fire reads as, for comparing one tick's against the last sent. */
function afflictionReading(entries: readonly CellAffliction[]): string {
  // Sorted, so two placements in one cell read the same whichever the index
  // happened to list first.
  return entries
    .map((one) => `${one.tileId}:${one.defIds.join(",")}`)
    .sort()
    .join("|");
}

/** The world's burning placements, grouped by the cell they are in. */
function afflictionsByCell(burning: readonly AfflictedPatch[]): Map<string, CellAffliction[]> {
  const out = new Map<string, CellAffliction[]>();
  for (const one of burning) {
    const key = cellAfflictionKey(one.x, one.y, one.z);
    let entries = out.get(key);
    if (!entries) out.set(key, (entries = []));
    entries.push({ tileId: one.tileId, defIds: one.defIds });
  }
  return out;
}

/**
 * The shared patch as the wire shape, for a client that takes all of it.
 *
 * Nameless, and it cannot be otherwise: a client takes the shared patch only
 * when nothing was cut for it, and an arrival is a cut. @see scopedPatchFor
 */
function wholePatch(patch: SharedPatch): TickPatch {
  return {
    ...patch,
    names: [],
    cells: patch.cells.map((scoped) => scoped.cell),
  };
}

/**
 * Is there anything in this for the client it was cut for?
 *
 * Structural in its cells so it answers for the shared patch as well, whose
 * cells are still carrying what decides who they are for.
 */
function isEmptyPatch(
  patch: Omit<TickPatch, "cells" | "names"> & { cells: readonly unknown[] },
): boolean {
  // Names are not asked about, and cannot change the answer: one is only ever
  // sent for a body that just entered this client's reach, and that body is a
  // `spawned` in `events` on the same patch.
  return (
    patch.cells.length === 0 &&
    patch.events.length === 0 &&
    patch.hps.length === 0 &&
    patch.carriedLights.length === 0 &&
    patch.statusIds.length === 0 &&
    patch.pvp.length === 0 &&
    patch.extractions.length === 0 &&
    patch.castings.length === 0
  );
}

/**
 * Did this cell change only by bodies moving through it?
 *
 * Placements are compared by reference, which is what the map's own diff does
 * one level up (`changedCellsOnLevel` compares stacks that way) and is sound
 * for the same reason: a board is copied on write, so an untouched placement is
 * the same object. Getting it wrong errs towards calling a change terrain,
 * which sends a cell that could have been dropped rather than dropping one that
 * should have been sent.
 */
function onlyBodiesMoved(before: PlacedTile[], after: PlacedTile[]): boolean {
  let i = 0;
  let j = 0;
  for (;;) {
    while (i < before.length && before[i]!.owner) i++;
    while (j < after.length && after[j]!.owner) j++;
    const endOfBefore = i >= before.length;
    const endOfAfter = j >= after.length;
    if (endOfBefore || endOfAfter) return endOfBefore && endOfAfter;
    if (before[i] !== after[j]) return false;
    i++;
    j++;
  }
}

/** Whose bodies stand in this cell, before or after. Almost always nobody. */
function bodiesIn(before: PlacedTile[], after: PlacedTile[]): string[] {
  let out: string[] | null = null;
  for (const stack of [before, after]) {
    for (const placed of stack) {
      if (!placed.owner) continue;
      out ??= [];
      if (!out.includes(placed.owner)) out.push(placed.owner);
    }
  }
  return out ?? NO_BODIES;
}

const NO_BODIES: string[] = [];

/** A client that has been handed no ground, and one that knows no bodies. */
const NO_CHUNKS: ReadonlySet<string> = new Set();
const NO_ACTORS: ReadonlySet<string> = new Set();
const NO_SOCKETS: ReadonlySet<GameSocket> = new Set();

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
/**
 * Chunks handed to one client per tick as they walk into reach.
 *
 * A chunk column of the den's caves is a few hundred cells, and handing a
 * whole leading edge over at once is the lump that made a previous attempt at
 * scoping measure *worse* than sending the world. Walking is five cells a
 * second and a chunk is sixteen across, so two a tick is minutes ahead of
 * need — this exists to spread the cost, not to ration it.
 */
const CHUNKS_STREAMED_PER_TICK = 2;

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
function parseBoardKey(key: string): { levelKey: string; chunkKey: string } | null {
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

/**
 * What to call everybody here who is a person, for a client that has never
 * been told.
 *
 * Only the named, which is only the players: a creature is named after its
 * tile off a catalogue the client already holds, so an entry per deer would be
 * a string for every body on the board saying what the tile id beside it
 * already says. @see NamePatch and `../app/game/displayName`
 */
function currentNames(actors: ActorSnapshot[]): NamePatch[] {
  const out: NamePatch[] = [];
  for (const actor of actors) {
    if (actor.name === null) continue;
    out.push({ actorId: actor.id, name: actor.name });
  }
  return out;
}

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
 * Who is fighting other players. @see currentCarriedLights for the omission rule.
 *
 * Only the bodies with it on, which is the omission rule read the same way: off
 * is what a client assumes about a body it has heard nothing about, and every
 * creature in the world is off.
 */
function currentPvp(actors: ActorSnapshot[]): PvpPatch[] {
  const out: PvpPatch[] = [];
  for (const actor of actors) {
    if (!actor.pvp) continue;
    out.push({ actorId: actor.id, on: true });
  }
  return out;
}

/** Everybody's pulls in progress. @see currentCarriedLights for the omission rule. */
function currentExtractions(actors: ActorSnapshot[]): ExtractionPatch[] {
  const out: ExtractionPatch[] = [];
  for (const actor of actors) {
    if (!actor.extracting) continue;
    out.push({ actorId: actor.id, progress: progressOf(actor.extracting) });
  }
  return out;
}

/**
 * The bodies close enough to this viewer to be worth telling them about, and
 * the viewer's own.
 *
 * Their own unconditionally, and not as a special case worth avoiding: the
 * reach is centred on that body, so the only way for it to be outside is for it
 * to be off the board — dead, or between a despawn and the respawn. A client
 * that was told its own body had gone out of reach would drop the entry its
 * camera, its kit panel and its own footwork all hang on.
 */
function actorsInReach(
  actors: ActorSnapshot[],
  at: { x: number; y: number; z: number } | null,
  self: string,
): ActorSnapshot[] {
  if (!at) return actors.filter((actor) => actor.id === self);
  return actors.filter(
    (actor) => actor.id === self || withinBodyReach(at, actor.x, actor.y, actor.z),
  );
}

/** Everybody's casts in progress. @see currentCarriedLights for the omission rule. */
function currentCastings(actors: ActorSnapshot[]): CastingPatch[] {
  const out: CastingPatch[] = [];
  for (const actor of actors) {
    if (!actor.casting) continue;
    out.push({ actorId: actor.id, progress: castProgressOf(actor.casting) });
  }
  return out;
}

/**
 * The two numbers of a pull, copied off the runtime's object.
 *
 * Copied because the object on the snapshot is the runtime's whole
 * `Extraction`, key included, and the key is sent to its owner alone.
 */
function progressOf(
  running: NonNullable<ActorSnapshot["extracting"]>,
): NonNullable<ExtractionPatch["progress"]> {
  return {
    remainingMs: running.remainingMs,
    durationMs: running.durationMs,
  };
}

/**
 * The two numbers of a cast and the button it came out of, copied off the
 * runtime's object on {@link progressOf}'s terms.
 */
function castProgressOf(casting: CastProgress): CastProgress {
  return {
    remainingMs: casting.remainingMs,
    durationMs: casting.durationMs,
    slot: casting.slot,
  };
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

/**
 * How long one actor's queue may get once turns and casts are counted too.
 *
 * Those only queue while a step is waiting, and {@link MAX_QUEUED_STEPS} keeps
 * that short, so an honest client has one or two of them here at most. The cap
 * is for the same reason that one exists: a client must not be able to make the
 * queue grow.
 */
const MAX_QUEUED_INTENTS = 8;

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
 * Key prefix under which one player's switch is kept. @see `../app/game/pvp`
 *
 * A row of its own beside the six above, and it is the kind of fact a tag is
 * rather than the kind a kit is: it records a decision the *player* made, so
 * nothing about the world it was made in can invalidate it and there is nothing
 * to check it against on the way back in. Only somebody who has turned it on
 * has a row — off is what an absent key means, and what every player who has
 * never touched it is.
 *
 * Written the moment it moves rather than on the flush behind everything else:
 * a switch somebody turned off and a crash a second later must not add up to a
 * player who comes back fightable.
 */
const PVP_KEY_PREFIX = "pvp:";

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

/**
 * Where somebody comes back into the world, kept against their death.
 *
 * Minted at their first sight of the world and moved from then on by whatever
 * they anchor themselves to — see `SetSpawnInteraction` and
 * {@link GameServer.flushSpawnMarks}. It was write-once until the respawn point
 * existed, and the shape did not have to change for that: what the row has
 * always held is the answer to one question, and the question did not change
 * either.
 */
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
 * Whether somebody was fighting other players, kept against their return.
 *
 * Nullable in the same sense {@link SavedHp} is not: `on` is written false as
 * well as true, because a row that could only ever be set would make turning
 * the switch off a thing that lasted until the next reconnect.
 */
type SavedPvp = { on: boolean; savedAt: number };

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

/**
 * What a connection carries, settled at the upgrade and never re-asked.
 *
 * Both halves come from the signed session cookie — see `server/index.ts`,
 * which looks the character up *for that account* and reads the role off the
 * same viewer. Neither is anything the page said about itself, which is what
 * makes them safe to hang here: once the socket is open there is no longer a
 * request to read a cookie off, so anything not settled by now cannot be.
 *
 * `admin` is the whole of who may run a command. It is a property of the
 * account rather than of the body, so it lives beside the actor id rather than
 * on the actor — a role is not a thing the checkpoint should ever hold, and
 * a body restored from one must not come back with a privilege in it.
 */
type Attachment = { actorId: string; admin: boolean };

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
  /** What the `pvp:` row was last told. False is also what an absent row means. */
  pvp: boolean;
};

/** Whether two positions describe the same standing place, facing the same way. */
function samePosition(a: ActorPosition, b: ActorPosition): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z && a.direction === b.direction;
}

/** A step a client says it has taken, waiting for this side to agree. */
type QueuedStep = {
  seq: number;
  direction: Direction;
  preferDescend: boolean;
};

/**
 * Something a client did, waiting its turn behind the steps it sent first.
 *
 * A turn and a cast are both done *from where a body stands and which way it
 * faces*, and a predicting client decides both from a cell its steps have
 * already reached. Honoured the moment they arrived, they overtook those steps:
 * a flame cast while walking was laid in front of a cell the caster had already
 * left, which is the cell they were walking into. Queued, they happen in the
 * order they were sent, which is the order the player saw them happen.
 */
type QueuedIntent =
  | ({ kind: "step" } & QueuedStep)
  | { kind: "face"; direction: Direction }
  | { kind: "cast"; slot: CastSlot };

/** A queued turn or cast — whatever is not a step. @see QueuedIntent */
type QueuedAction = Exclude<QueuedIntent, { kind: "step" }>;

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

/** A cell, as two cuts compare where a body stood. */
type Point = { x: number; y: number; z: number };

function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

/**
 * One body a changed cell names: where it stands now, and where it stood when
 * the last patch was cut. Null for a body that was not on the board at that
 * moment. @see GameServer.mayConcern
 */
type CellBody = { id: string; now: Point | null; was: Point | null };

/**
 * Who a client holds after a cut, and how that differs from before it.
 * @see GameServer.scopedPatchFor
 */
type Reach = {
  /** Bodies it holds now and did not, as indices into the tick's snapshots, in that order. */
  entered: number[] | null;
  /** Bodies it held and does not now. */
  departed: string[] | null;
  held: ReadonlySet<string>;
  /**
   * Asked beside `held` wherever what the client held before this cut
   * matters: between them the two answer "held, before or now", which is the
   * question a cell's bodies are asked. @see `../app/net/scope`'s `cellInScope`
   */
  before: ReadonlySet<string>;
};

/** What one client's last cut was worked out against. @see GameServer.lastCut */
type CutMemo = {
  /** Which cut, by {@link GameServer.cutCount}. */
  cut: number;
  at: Point | null;
  chunks: ReadonlySet<string>;
  known: ReadonlySet<string>;
};

/**
 * The JSON of each element of one list of the tick's shared patch, made the
 * first time any client is sent that element and never again that tick.
 * @see serializeCut
 */
class Fragments<T> {
  private readonly text: Array<string | undefined>;

  constructor(private readonly items: readonly T[]) {
    this.text = new Array(items.length);
  }

  at(i: number): string {
    return (this.text[i] ??= JSON.stringify(this.items[i]));
  }
}

/**
 * Positions, a column per axis, so a reach test is arithmetic on numbers
 * already to hand. `has` is 0 where there is no position to test. @see
 * withinBodyReachOf
 */
type Columns = { x: Int32Array; y: Int32Array; z: Int32Array; has: Uint8Array };

function columns(length: number): Columns {
  return {
    x: new Int32Array(length),
    y: new Int32Array(length),
    z: new Int32Array(length),
    has: new Uint8Array(length),
  };
}

function setColumn(into: Columns, i: number, at: Point | null) {
  if (at === null) return;
  into.x[i] = at.x;
  into.y[i] = at.y;
  into.z[i] = at.z;
  into.has[i] = 1;
}

/**
 * Could the body at `i` of these columns be one a client holds, or held at the
 * last cut? Held now only if it stands within reach of where the client
 * stands; held then only if it stood within reach of where the client stood
 * then. @see GameServer.mayConcern, which asks the same of several bodies.
 */
function mayHold(
  now: Columns,
  was: Columns,
  i: number,
  at: Point | null,
  lastAt: Point | null | undefined,
): boolean {
  if (
    at !== null &&
    now.has[i] === 1 &&
    withinBodyReachOf(at.x, at.y, at.z, now.x[i]!, now.y[i]!, now.z[i]!)
  ) {
    return true;
  }
  if (lastAt === undefined) return true;
  return (
    lastAt !== null &&
    was.has[i] === 1 &&
    withinBodyReachOf(lastAt.x, lastAt.y, lastAt.z, was.x[i]!, was.y[i]!, was.z[i]!)
  );
}

/**
 * Does this client hold the body with this id — the body at `index` in the
 * tick's snapshots, or -1 for one that is not on the board?
 *
 * `held.has(id)`, with the answer ruled out by distance first wherever it can
 * be: a client holds nothing but its own body and bodies within reach of where
 * it stands, so a body off the board or further off than that is not one it
 * holds.
 */
function holdsBody(
  frame: TickFrame,
  id: string,
  index: number,
  actorId: string,
  at: Point | null,
  held: ReadonlySet<string>,
): boolean {
  if (id === actorId) return held.has(id);
  if (index < 0 || at === null) return false;
  const { bodies } = frame;
  return (
    withinBodyReachOf(at.x, at.y, at.z, bodies.x[index]!, bodies.y[index]!, bodies.z[index]!) &&
    held.has(id)
  );
}

/** What changed in a cell, for deciding who it can be news to. @see TickFrame */
const CELL_TERRAIN = 0;
/** Only one body moved in it: the common case, asked about without a list. */
const CELL_ONE_BODY = 1;
/** Only bodies moved, and more than one did. */
const CELL_BODIES = 2;

/** Who an event is for, as {@link TickFrame} files it. @see Audience */
const FOR_EVERYBODY = 0;
const FOR_PLACE = 1;
const FOR_BODY = 2;

/**
 * Everything each client's cut of one tick is worked out against, computed
 * once for the tick rather than once per client. @see GameServer.broadcastPatch
 *
 * **Filed as columns of numbers, and that is the point of it.** Every client is
 * asked about every body that moved and every cell and event of the tick, which
 * with a thousand players is a couple of hundred thousand questions a tick. A
 * question that reads positions off snapshot objects of three or four different
 * shapes cost around a hundred nanoseconds; the same question asked of typed
 * columns costs a few.
 */
type TickFrame = {
  actors: ActorSnapshot[];
  patch: SharedPatch;
  /** Each body's chunk, as a subscription names it. */
  chunkOf: string[];
  /** Where each body is in `actors`, by id. */
  indexOf: Map<string, number>;
  grid: BodyGrid;
  /** Where each body in `actors` stands. */
  bodies: Columns;
  /**
   * Every body that moved, arrived or left since the last cut, in snapshot
   * order: its id, where it is in `actors` (-1 once it has left the board),
   * and where it stood at the last cut (nowhere, for an arrival).
   */
  changed: { ids: string[]; index: Int32Array; was: Columns };
  cells: {
    /** {@link CELL_TERRAIN}, {@link CELL_ONE_BODY} or {@link CELL_BODIES}. */
    kind: Uint8Array;
    /** For a cell one body moved in, whose body it is. */
    owner: Array<string | null>;
    /** For a cell one body moved in, where that body stands now and stood at the last cut. */
    now: Columns;
    was: Columns;
    /** For a cell several bodies moved in, the lot of them. */
    bodies: Array<CellBody[] | null>;
  };
  events: {
    /** {@link FOR_EVERYBODY}, {@link FOR_PLACE} or {@link FOR_BODY}. */
    kind: Uint8Array;
    /** The chunk an event addressed to a place happened in. */
    chunk: Array<string | null>;
    /** The body an event addressed to one is about, and where it is in `actors` (-1 if nowhere). */
    actorId: Array<string | null>;
    actor: Int32Array;
  };
  /** For each actor-keyed list, where the body each entry is about is in `actors`. */
  entryActor: Record<EntryList, Int32Array>;
  json: {
    cells: Fragments<CellPatch>;
    events: Fragments<MotionEvent>;
  } & { [L in EntryList]: Fragments<SharedPatch[L][number]> };
};

/** The lists of a patch that are keyed by a body and cut by who holds it. */
const ENTRY_LISTS = [
  "hps",
  "carriedLights",
  "statusIds",
  "pvp",
  "extractions",
  "castings",
] as const satisfies ReadonlyArray<keyof SharedPatch>;

type EntryList = (typeof ENTRY_LISTS)[number];

/**
 * One client's share of a tick, as the parts it is made of.
 *
 * A number is an element of the tick's shared patch, which every client sent
 * it is sent unchanged; an object is this client's own — an arrival and what
 * it brings, a departure, or a cell with a body taken out of it.
 */
type Cut = {
  cells: Array<number | CellPatch>;
  events: Array<number | MotionEvent>;
  names: NamePatch[];
} & { [L in EntryList]: Array<number | SharedPatch[L][number]> };

/** One list of a {@link Cut} as JSON, splicing in the shared text where it has any. */
function listJson<T>(parts: ReadonlyArray<number | T>, shared: Fragments<T>): string {
  if (parts.length === 0) return "[]";
  let out = "[";
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k]!;
    if (k > 0) out += ",";
    out += typeof part === "number" ? shared.at(part) : JSON.stringify(part);
  }
  return `${out}]`;
}

/**
 * A client's patch as the wire carries it.
 *
 * Exactly what `JSON.stringify` of the same patch spelled out as objects would
 * give, key for key — the lists in the order the message declares them —
 * assembled from text rather than from the objects. **Serializing each client's
 * patch whole was the other half of what a crowd cost:** once the patch is cut,
 * nearly every client in a spread-out world is sent a list of its own, and a
 * thousand `JSON.stringify` calls are a thousand walks over the same few dozen
 * objects. Here each shared object is walked once, the first time anybody is
 * sent it.
 */
function serializeCut(cut: Cut, frame: TickFrame): string {
  const { json } = frame;
  return (
    `{"type":"patch","cells":${listJson(cut.cells, json.cells)}` +
    `,"events":${listJson(cut.events, json.events)}` +
    `,"hps":${listJson(cut.hps, json.hps)}` +
    `,"names":${JSON.stringify(cut.names)}` +
    `,"carriedLights":${listJson(cut.carriedLights, json.carriedLights)}` +
    `,"statusIds":${listJson(cut.statusIds, json.statusIds)}` +
    `,"pvp":${listJson(cut.pvp, json.pvp)}` +
    `,"extractions":${listJson(cut.extractions, json.extractions)}` +
    `,"castings":${listJson(cut.castings, json.castings)}}`
  );
}

/** Is there anything in this cut for the client it was cut for? @see isEmptyPatch */
function isEmptyCut(cut: Cut): boolean {
  // Names are not asked about, on {@link isEmptyPatch}'s terms: one only ever
  // rides beside a `spawned`, which is an event.
  return (
    cut.cells.length === 0 &&
    cut.events.length === 0 &&
    ENTRY_LISTS.every((list) => cut[list].length === 0)
  );
}

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
   * base class supplied them. Renaming them would touch every `this.ctx.*` call
   * site below and the suite that guards them, and that suite is the only
   * reason to believe this file still works — which matters more than the names
   * do.
   *
   * `this.ctx.storage.*` is the bulk of what is left, at thirty-odd sites.
   * Sockets are down to two: {@link seated}, which every caller that wants the
   * actor behind a connection goes through, and {@link broadcast}, which is
   * deliberately not one of them.
   */
  constructor(
    protected readonly ctx: WorldContext,
    protected readonly env: {
      dataStore: DataStore;
      /**
       * What to call the body behind an actor id, or null for an id no account
       * owns — which is every creature on the map.
       *
       * Injected rather than imported because the world does not otherwise
       * know that accounts exist: `server/world.ts` hands it the character
       * table, and `server/testHarness.ts` hands it nothing, so the suite
       * builds worlds full of anonymous bodies exactly as it always did.
       */
      nameOf?: (actorId: string) => Promise<string | null>;
    },
  ) {}

  private session: GameSession | null = null;
  /**
   * How far `/time` has moved the world's clock from the wall clock, in
   * minutes.
   *
   * An offset rather than a stored hour, so the clock is still a pure function
   * of `Date.now()` and keeps running through hibernation exactly as before.
   * Held here rather than on the session, because a session is replaced on
   * eviction and on every content save, and the hour somebody chose should
   * outlive both. It does not outlive the process: nothing checkpoints it, so a
   * deploy puts the world back on the wall clock.
   */
  private clockOffsetMinutes = 0;
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
   * The bodies each client has been told about, by the actor id of the client.
   *
   * **A client's actor set is its `hello` plus what it is told afterwards**, and
   * what it was told afterwards used to be sockets opening and closing only.
   * Anything else a world adopts at runtime — a creature that respawned, one
   * somebody summoned with `/tile` — reached a client by accident: a
   * `walkStarted` for an unknown id is what quietly added it. So a body that
   * never moves never arrived. Its tile was drawn, because a body is a tile in a
   * stack and cell patches carry that, and everything keyed on the actor was
   * missing — no name over its head, no health bar, no Talk row. That is a
   * shopkeeper who cannot be spoken to until somebody reloads.
   *
   * **One set per client rather than one for the world**, because the answer is
   * now a different one for each of them: a client is told about the bodies
   * standing in the chunks it holds, and about no others. @see `../app/net/scope`
   *
   * Seeded where a `hello` goes out, because that message is the other way a
   * client learns a body exists, and diffed once per tick in
   * {@link scopedPatchFor}. Seeding it there rather than on the first tick is
   * what closes the window where a world loads, somebody summons something, and
   * the tick that would have announced it is also the tick that would have
   * seeded the set.
   *
   * A wake is the one case it is wrong about, and wrong in the safe direction:
   * the instance is rebuilt with this empty while the sockets it inherited were
   * helloed by an instance that is gone, so the next tick announces every body
   * in reach once. Each of those is one the client already holds, and it
   * ignores an id it is already holding.
   *
   * Nothing here needs clearing when a body dies or leaves: a body off the board
   * is in nobody's reach, so the next tick takes it out of every set that had
   * it, by the same rule that would have taken it out for walking away.
   */
  private readonly announcedActors = new Map<string, Set<string>>();
  /**
   * Where each body stood when the last patch was cut, by id, with the cut
   * that saw it there.
   *
   * **What lets a client be cut against what changed rather than against
   * everybody near it.** A client that has not moved holds exactly the bodies
   * it held last tick, except where a body moved, arrived or left — and those
   * are the few bodies whose entry here says something else. Asking only about
   * them is what keeps a crowd from costing the product of its two numbers:
   * with a thousand players on the shipped map, each holds a couple of hundred
   * bodies and a tick moves a few dozen. @see scopedPatchFor
   */
  private readonly bodiesAtLastCut = new Map<string, Point & { cut: number }>();
  /** How many patches have been cut, which is what stamps {@link bodiesAtLastCut}. */
  private cutCount = 0;
  /**
   * What each client's last cut was worked out against, by the actor id of the
   * client.
   *
   * A cut can be worked out from the last one only if that cut was the
   * previous tick's and left behind the very set of bodies the client holds now
   * — by identity, because `sendHello` replaces the set and a hello is the one
   * thing besides a cut that decides what a client holds. @see scopedPatchFor
   */
  private readonly lastCut = new Map<string, CutMemo>();
  /**
   * The clients whose subscription is still being handed over, and so are owed
   * ground next tick whether or not they move. @see streamEnteredChunks
   */
  private readonly subscriptionsToCheck = new Set<string>();
  /** The seated sockets, by the actor each is seated on. @see seat */
  private readonly socketsByActor = new Map<string, Set<GameSocket>>();
  /** {@link seated}'s answer, until somebody is seated or unseated. */
  private seatedSockets: ReadonlyArray<readonly [GameSocket, string]> | null = null;
  /**
   * The hit points each client has been told about, so an unchanged bar costs
   * nothing on the wire. Same discipline as {@link broadcastMap}: everyone is at
   * the same version, so one diff serves every socket.
   */
  private sentHp = new Map<string, { hp: number; maxHp: number; rating: number }>();
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
  /**
   * Last broadcast status ids per actor, with the joined string they are
   * compared by. Both, so the list is walked once a tick rather than twice.
   * @see diffStatusIds
   */
  private sentStatusIds = new Map<string, { defIds: string[]; key: string }>();
  /** Last broadcast switch per actor. @see diffPvp */
  private sentPvp = new Map<string, boolean>();
  /**
   * The pull each actor was last broadcast as making.
   *
   * Compared by identity, unlike its neighbours, because identity is exactly
   * the answer here: the runtime winds one object in place for the whole pull
   * and replaces it only when a pull starts or ends. Comparing the numbers
   * would see a change on every tick of every pull.
   *
   * Holds a null for a body that is not pulling, rather than no entry at all —
   * which reads the same to the compare, and means one entry per live actor on
   * the terms {@link sentPvp} and {@link sentCarriedLights} already hold one.
   * {@link diffPerActor} sweeps them all the same way. @see diffExtractions
   */
  private sentExtractions = new Map<string, ActorSnapshot["extracting"]>();
  /**
   * The wait each attached player was last *addressed* about.
   *
   * Compared by identity on {@link sentExtractions}' terms and for its reason —
   * the runtime winds one object in place and replaces it only when the wait
   * changes. Unlike its neighbours this one is not a broadcast: a fight outline
   * is drawn for one viewer, so the map holds only the players who have a
   * socket, and an entry is dropped when theirs goes. @see flushNextBlow
   */
  private sentNextBlow = new Map<string, Progress | null>();
  /**
   * The cast each actor was last broadcast as making, compared by identity on
   * {@link sentExtractions}' terms and for its reason. @see diffCastings
   */
  private sentCastings = new Map<string, ActorSnapshot["casting"]>();
  /**
   * What was last sent as burning in each cell, as a reading, keyed by
   * {@link cellAfflictionKey}. One map for the whole world rather than one per
   * client, like {@link sentStatusIds}: it decides which cells changed, and the
   * cell diff decides who hears about them. @see diffCells
   */
  private sentAfflicted = new Map<string, string>();
  /** What is burning in each cell this tick, read once per flush. @see cellPatch */
  private burning = new Map<string, CellAffliction[]>();
  private events: MotionEvent[] = [];
  /** Steps, turns and casts clients have sent, oldest first, per actor. */
  private readonly queuedIntents = new Map<string, QueuedIntent[]>();
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
  /**
   * The chunks each connected actor has been sent, by actor id.
   *
   * Keyed by actor rather than by socket because it is the body that stands
   * somewhere and is owed ground, and an actor has one socket at a time — see
   * {@link displaceSockets}. Dropped when that socket goes, in
   * {@link webSocketClose}.
   */
  private readonly subscribed = new Map<string, Set<string>>();
  /**
   * The chunk a subscription was last found complete around, keyed by the set
   * itself.
   *
   * What lets {@link streamEnteredChunks} skip a player who has not crossed a
   * chunk boundary, which is nearly every player on nearly every tick, instead
   * of building their whole square of chunk keys to learn nothing changed.
   * Keyed by the set rather than the actor because a subscription is only ever
   * replaced, never edited, so a set that is here is still exactly what it was
   * when it was checked — and a replacement is simply not found.
   */
  private readonly subscriptionCentre = new WeakMap<Set<string>, string>();
  /**
   * Players whose last socket closed while they were in combat, and whose body
   * is therefore still standing in the world.
   *
   * **Closing the tab is not a way out of a fight.** The body stays, idle and
   * hittable, until the combat minute runs out — then {@link releaseLingerers}
   * takes it off exactly as an ordinary close would have. Reconnecting in the
   * meantime is an ordinary join: `spawn` keeps the body already on the board,
   * so the returning player is back in it, mid-fight.
   *
   * Not checkpointed. A restart drops every socket anyway, and the load reaps
   * every body without one; a lingering body is reaped with them.
   *
   * Keyed to the wall-clock time the body goes whatever is happening — see
   * {@link GameServer.MAX_LINGER_MS}.
   */
  private readonly lingering = new Map<string, number>();
  /**
   * The longest a body stays after its last socket closes, in combat or not.
   *
   * An idle body cannot end a fight. A rat that cannot get through its armour,
   * or keeps missing, restarts the combat minute on every swing, and without
   * this the body would never leave. Fifteen minutes is long enough that no
   * real fight is escaped by closing the tab, and still bounds a stalemate.
   */
  private static readonly MAX_LINGER_MS = 15 * 60_000;
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
  private async checkpointedBoard(checkpoint: Checkpoint): Promise<MapFile | null> {
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

    const pending = await this.ctx.storage.get<Record<string, number>>(RESPAWN_PENDING_KEY);
    this.respawnPending = new Map(
      Object.entries(pending ?? {}).filter(([key]) => this.respawnPoints.has(key)),
    );

    const nowMs = Date.now();
    for (const point of this.respawnPoints.values()) {
      if (this.respawnPending.has(point.key)) continue;
      if (isSpawnFilled(session.getMap(), point)) continue;
      this.respawnPending.set(point.key, nowMs + rollRespawnDelayMs(point.respawn));
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
      this.ctx.storage.deleteAlarm().catch(GameServer.reportWriteFailure("respawn alarm clear"));
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
    // Collected here and not left to the tick, because the alarm grows
    // things back too, and the tick it wakes empties what is pending first.
    this.collectTransitionEvents(session);
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
  private sweepRespawnCells(cells: ScopedCell[]) {
    const session = this.session;
    if (!session || this.respawnPointsByCell.size === 0) return;
    const nowMs = Date.now();
    let pointsDirty = false;
    for (const { cell } of cells) {
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
    for (const [, actorId] of this.seated()) live.push(actorId);
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
    const [at, carrying, tagged, earned, statuses, hp, pvp] = await Promise.all([
      this.lastPositionOf(actorId),
      this.lastEquipmentOf(actorId),
      this.lastTagsOf(actorId),
      this.lastMasteriesOf(actorId),
      this.lastStatusesOf(actorId),
      this.lastHpOf(actorId),
      this.lastPvpOf(actorId),
    ]);
    return { at, carrying, tagged, earned, statuses, hp, pvp };
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
   * **Read once per connection, not once per death**, which is what lets a
   * death be written without awaiting anything. Two things can move the row
   * afterwards and neither breaks that: the world being replaced, which drops
   * the rows wholesale rather than editing them, and the player anchoring
   * themselves somewhere — and {@link flushSpawnMarks} writes that one *through*
   * this cache rather than behind it, so what is on the instance is never
   * behind what is in storage.
   *
   * The facing is the one a fresh body takes, rather than whichever way they
   * happened to be looking: this is a door, not a footprint. A mark moved later
   * keeps that facing for the same reason — see {@link flushSpawnMarks}.
   */
  private async rememberSpawn(actorId: string): Promise<void> {
    if (this.spawns.has(actorId)) return;

    const saved = await this.ctx.storage.get<SavedSpawn>(this.spawnKey(actorId));
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

  private pvpKey(actorId: string): string {
    return `${PVP_KEY_PREFIX}${actorId}`;
  }

  /** Whether this player was fighting other players, if the world remembers. */
  private async lastPvpOf(actorId: string): Promise<boolean | undefined> {
    const saved = await this.ctx.storage.get<SavedPvp>(this.pvpKey(actorId));
    return saved?.on;
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
  private async lastMasteriesOf(actorId: string): Promise<MasteryXp | undefined> {
    const saved = await this.ctx.storage.get<SavedMasteries>(this.masteriesKey(actorId));
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
  private async lastStatusesOf(actorId: string): Promise<StatusInstance[] | undefined> {
    const saved = await this.ctx.storage.get<SavedStatuses>(this.statusesKey(actorId));
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
  private async lastEquipmentOf(actorId: string): Promise<Equipment | undefined> {
    const saved = await this.ctx.storage.get<SavedEquipment>(this.equipmentKey(actorId));
    if (!saved?.equipment) return undefined;
    return restoredEquipment(saved.equipment, tilesByIdFromList(this.tiles));
  }

  /**
   * Where this actor was when the world last saw them, if it remembers.
   *
   * Undefined for somebody new, and undefined is exactly right: {@link spawn}
   * reads it as "no wish", and puts them in at the spawn point.
   */
  private async lastPositionOf(actorId: string): Promise<ActorPosition | undefined> {
    const saved = await this.ctx.storage.get<SavedPosition>(this.positionKey(actorId));
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
   *
   * @param only `"kits"` leaves out every actor whose kit, tags and masteries
   *   are what storage last had — the actors a board written in this batch
   *   cannot contradict. The others are written in full, as ever. It is what a
   *   death's batch needs and no more: see {@link noteDeaths}.
   */
  private saveActors(
    actorIds: Iterable<string>,
    force = false,
    only: "everything" | "kits" = "everything",
  ) {
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
      | SavedPvp
      | Checkpoint
      | ChunkCells
    > = {};
    for (const actorId of actorIds) {
      // What storage already believes, or nothing when the caller has asked for
      // this to be written whatever it says — see the `force` callers, which are
      // the two moments a stale `savedAt` would matter.
      const written = force ? undefined : this.writtenActors.get(actorId);
      const equipment = session.equipmentOf(actorId);
      const tags = session.tagsOf(actorId);
      const masteries = session.masteryXpOf(actorId);
      if (
        only === "kits" &&
        written !== undefined &&
        equipment === written.equipment &&
        tags === written.tags &&
        masteries === written.masteries
      ) {
        continue;
      }
      const at = session.actorPosition(actorId);
      if (!at) continue;
      const statuses = session.statusesOf(actorId);
      const hp = session.storedHpOf(actorId);
      const pvp = session.pvpOf(actorId);

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
      if (equipment && !session.isResident(actorId) && equipment !== written?.equipment) {
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
        const bothEmpty = (statuses?.length ?? 0) === 0 && (lastStatuses?.length ?? 0) === 0;
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
        // And by value again, on the `hp:` row's terms including the one that
        // matters: turning the switch *off* has to be written, or it would last
        // exactly until the next reconnect. Residents are excluded with the two
        // above — `mayHarm` answers on residency before it ever reads a
        // creature's flag. @see PVP_KEY_PREFIX
        if (pvp !== (written?.pvp ?? false)) {
          entries[this.pvpKey(actorId)] = { on: pvp, savedAt };
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
        pvp,
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

    const oldestFirst = [...stored].sort(([, a], [, b]) => a.savedAt - b.savedAt);
    const doomed = oldestFirst.slice(0, stored.size - MAX_REMEMBERED_ACTORS).map(([key]) => key);
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
  async join(socket: GameSocket, actorId: string, { admin }: { admin: boolean }): Promise<void> {
    this.displaceSockets(actorId);
    this.ctx.acceptWebSocket(socket);
    this.seat(socket, { actorId, admin });

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
   * Close every connection this actor already has, ahead of a new one.
   *
   * One connection per actor, and the newest wins: it is the tab somebody just
   * opened or reloaded. Identity is a cookie, so a second tab is the same
   * person, and it gets the body rather than sharing it.
   *
   * **The attachment is cleared before the close**, not left to the close
   * handler, which runs later. Until it does, `getWebSockets` still lists the
   * socket, and with an id on it the head count, {@link rebirth} and
   * {@link hasSocket} would all still take it for this actor. With none,
   * {@link dropSocket} ignores its close when it lands — correct, because the
   * actor has not gone anywhere.
   */
  /**
   * Every socket with an actor on it, and which actor that is.
   *
   * The attachment read and its cast were written out at twenty-odd call sites,
   * and every one of them had to remember the same thing: a socket can be
   * attached to nothing. One accepted and not yet seated is, and so is one
   * {@link displaceSockets} has just cleared ahead of a close. Skipping those
   * is all the copies ever did.
   *
   * Deliberately not used by {@link broadcast}, which is the one loop that must
   * *not* read an attachment. It walks every socket and asks who is behind one
   * only while somebody is silenced, because an attachment read per socket per
   * tick is a cost that loop cannot take on. @see isSilenced
   *
   * **Worked out when somebody is seated or unseated, not when it is asked.**
   * The broadcast and half a dozen flushes ask it on every tick, and each ask
   * copied the socket list and read every attachment on it — a walk of the
   * whole world per ask. The answer only changes at {@link seat} and
   * {@link unseat}, so that is where it is thrown away. In the order the hub
   * holds the sockets, as it always was.
   */
  private seated(): ReadonlyArray<readonly [GameSocket, string]> {
    if (this.seatedSockets) return this.seatedSockets;
    const out: Array<readonly [GameSocket, string]> = [];
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment) out.push([ws, attachment.actorId]);
    }
    return (this.seatedSockets = out);
  }

  /**
   * Every socket seated on one actor.
   *
   * Plural because it is: {@link displaceSockets} closes the old connection
   * from the new one's `join`, so for the length of that call a body has two.
   *
   * A lookup rather than a walk of every socket, which is what it was, and what
   * every refused step, death and spawn mark paid to find one socket.
   */
  private socketsOf(actorId: string): ReadonlySet<GameSocket> {
    return this.socketsByActor.get(actorId) ?? NO_SOCKETS;
  }

  /**
   * Put an actor on a socket: the attachment that says who it is, and the
   * index {@link socketsOf} and {@link seated} are answered from.
   */
  private seat(ws: GameSocket, attachment: Attachment) {
    ws.serializeAttachment(attachment satisfies Attachment);
    let sockets = this.socketsByActor.get(attachment.actorId);
    if (!sockets) this.socketsByActor.set(attachment.actorId, (sockets = new Set()));
    sockets.add(ws);
    this.seatedSockets = null;
  }

  /**
   * Take a socket out of the index, leaving its attachment for whoever is
   * about to read it — {@link dropSocket} still has to know who it was.
   *
   * Called at the two moments a socket stops being seated: a newer one
   * displacing it, and its close. Every close reaches here in the same breath
   * as the hub lets the socket go — `server/world.ts` drops it and calls
   * {@link webSocketClose} one after the other — so the index never holds a
   * socket the hub does not.
   */
  private unseat(ws: GameSocket) {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) return;
    const sockets = this.socketsByActor.get(attachment.actorId);
    if (!sockets?.delete(ws)) return;
    if (sockets.size === 0) this.socketsByActor.delete(attachment.actorId);
    this.seatedSockets = null;
  }

  private displaceSockets(actorId: string) {
    // A copy, because unseating each one edits the set being walked.
    for (const ws of [...this.socketsOf(actorId)]) {
      this.unseat(ws);
      ws.serializeAttachment(null);
      ws.close(CLOSE_REPLACED, "replaced");
    }
  }

  /**
   * How many people are in the world.
   *
   * Counted from the sockets' actor ids rather than from the session, because
   * the session's actors include the creatures living on the map and nothing
   * there tells a deer from a player.
   *
   * @param excluding the socket on its way out. A closing connection is still
   *   listed here, and the person it carried has already gone.
   */
  private playerCount(excluding?: GameSocket): number {
    const leaving = excluding?.deserializeAttachment() as Attachment | null | undefined;
    const theirs = leaving ? this.socketsByActor.get(leaving.actorId) : undefined;
    // An actor counts while it has a seated socket other than the one leaving.
    const gone = theirs?.size === 1 && theirs.has(excluding!) ? 1 : 0;
    return this.socketsByActor.size - gone;
  }

  private sendHello(ws: GameSocket, actorId: string) {
    const session = this.session!;
    // Recorded as this socket is told, so the stream below hands over what
    // comes into reach *after* this rather than replaying what is in it.
    const chunks = this.subscriptionFor(actorId);
    // The bodies near enough to be worth drawing, and no others: a client told
    // about a body it holds no cell for cannot draw it, and pays a sweep of its
    // whole board every frame looking for it. @see `../app/net/scope`
    const actors = actorsInReach(session.actorSnapshots(), session.actorPosition(actorId), actorId);
    // Everything named below is a body this socket now knows about, so none of
    // it is news to announce. @see announcedActors
    const held = new Set(actors.map((actor) => actor.id));
    this.announcedActors.set(actorId, held);
    // Everything after the map, in the order the message lists it. The map is
    // spliced in ahead of it from each chunk's kept text, which is the same
    // bytes `mapOfInterest` would have serialized to and a fraction of the
    // work: a `hello` is the largest thing the world sends, and one goes out
    // on every join and every rebirth. @see `./chunkJson`
    const rest: Omit<Extract<ServerMessage, { type: "hello" }>, "type" | "selfId" | "map"> = {
      actorIds: actors.map((actor) => actor.id),
      hps: currentHps(actors),
      // Everybody in reach who has a name, so a tag is right on the first
      // frame. Nothing after this corrects one — see {@link NamePatch} — so a
      // body missing from here is a body labelled `Nobody` until it leaves
      // this client's reach and comes back.
      names: currentNames(actors),
      carriedLights: currentCarriedLights(actors),
      statusIds: currentStatusIds(actors),
      // Beside the statuses and for their reason: somebody who can be fought has
      // to be marked on the first frame rather than the next time anybody
      // touches the switch. @see `../app/game/pvp`
      pvp: currentPvp(actors),
      extractions: currentExtractions(actors),
      // Beside the pulls and for their reason: somebody half way through a
      // flame when this client arrived has to have a bar on the first frame.
      castings: currentCastings(actors),
      // The fires in the ground this joiner is sent, and no others: the map
      // above has no room for them, and every change after this arrives on a
      // cell. @see `../app/net/protocol`'s `CellAffliction`
      afflicted: session.afflictedPlacements().filter((one) => covers(chunks, one.x, one.y)),
      // Theirs alone, and sent in full here for the same reason the map and the
      // hit points are: a joiner has nothing to patch against.
      equipment: session.equipmentOf(actorId) ?? emptyEquipment(),
      // Beside the kit, and needed before the first frame for a sharper reason:
      // a client with no tags offers every reward in the room, so a joiner
      // without this is shown chests it will be refused at.
      tags: [...(session.tagsOf(actorId) ?? [])],
      // Read off this instance's own cache rather than the session, because
      // this is the one fact on the wire the *server* owns outright — the
      // `spawn:` row is the record, and the session holds a copy of it only so
      // a press can tell whether it would change anything. Null only in the gap
      // after a world replacement, which drops the rows; every ordinary joiner
      // has been through {@link rememberSpawn} by now.
      spawnAt: this.spawnCellOf(actorId),
      // Beside the tags and for the same failure one step along: the body at
      // the far end is the one this player left, so a wait they started before
      // the tab closed is still running, and a joiner without this would be
      // shown resources it is about to be refused at.
      extracting: session.extractionOf(actorId),
      // Beside the pull and for its failure in a fight: the body at the far end
      // is the one this player left, so a wait they were part-way through is
      // still running, and a joiner without this would draw a breathing outline
      // round something it is about to hit.
      //
      // Recorded as sent, on the terms the chunk subscription above is recorded:
      // this *is* the first thing said about the wait, so a flush that did not
      // know it had gone out would follow the hello with a message repeating it.
      nextBlow: this.rememberNextBlow(actorId),
      // Theirs alone, beside the kit and the tags, and in full for the same
      // reason all three are: a joiner has nothing to patch against, and the
      // panel showing it is on screen before the first blow.
      masteryXp: { ...session.masteryXpOf(actorId) },
      // Theirs alone again, and in full on arrival for the reason all of these
      // are: there is nothing to patch against, and the lane that draws them is
      // on screen before the first berry.
      statuses: session.statusPatchesOf(actorId) ?? [],
      playerCount: this.playerCount(),
      // Read here rather than tracked: time of day is a function of the
      // server's clock, so it costs nothing to keep and cannot fall behind
      // while the object is hibernating.
      minutesOfDay: this.minutesOfDay(),
    };
    const map = mapOfInterestJson(session.getMap(), chunks, held);
    ws.send(
      `{"type":"hello","selfId":${JSON.stringify(actorId)},"map":${map},${JSON.stringify(rest).slice(1)}`,
    );
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
    const { actorId, admin } = attachment;

    // Ahead of the gate below, and the only message that is. That gate is "does
    // this actor have a runtime", and a death deletes it — so every other
    // message from a dead client is dropped there, which is exactly the point.
    // This one is the request to stop being dead, and asking it of the runtime
    // that no longer exists would make it unanswerable.
    if (message.type === "rebirth") {
      await this.rebirth(actorId);
      return;
    }

    if (!session.hasActor(actorId)) return;

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

    // **Walking and turning skip the flushes below.** They are most of what a
    // client sends — one message per cell walked — and a step is only queued
    // here: it is taken on the tick, which runs every one of those flushes
    // itself. A turn taken now changes a placement's facing, which reaches
    // clients as a cell in the tick's patch, and nothing a flush reports. Each
    // flush walks every socket, so running them per step made the cost of
    // walking grow with the square of the player count.
    if (message.type === "step" || message.type === "face") {
      if (message.type === "step") this.queueStep(actorId, message);
      else this.queueAction(actorId, { kind: "face", direction: message.direction });
      this.wake();
      return;
    }

    if (message.type === "target") {
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
      //
      // Behind any step this client sent before it, for the reason on
      // {@link QueuedIntent}: where a cast lands depends on where the caster is
      // standing, and the client cast from a cell its steps had already reached.
      this.queueAction(actorId, { kind: "cast", slot: message.slot });
    } else if (message.type === "cancelCast") {
      // Honoured now rather than queued, unlike the cast it stops: where a cast
      // lands depends on where the caster is standing, and stopping one does
      // not. A client only sends this once the broadcast has shown it its own
      // cast, so the cast is already running here rather than waiting behind
      // a step. The castings diff on the next flush is what tells everybody.
      session.cancelCast(actorId);
    } else if (message.type === "pvp") {
      // Honoured now rather than queued, unlike a cast: where a body stands has
      // nothing to do with it. Refused while the body is in a fight, and the
      // refusal is silent here — the client asked the same question before
      // sending, off the same `changeable` the snapshot carries, so a message
      // that arrives during a fight is a race rather than a press to explain.
      session.setPvp(message.enabled, actorId);
      // Written straight away rather than left to the periodic flush: a switch
      // somebody turned off and a crash a second later must not add up to a
      // player who comes back fightable.
      this.saveActors([actorId], true);
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
    } else if (message.type === "talk") {
      // Reach for an open, and that there is a button at that position for a
      // press — re-asked in the session on the terms a transmute's recipe
      // index is. Whatever it comes to, the `conversation` flush below tells
      // this socket the whole of where it now stands.
      session.talk(message.action, actorId);
    } else if (message.type === "transmute") {
      // Reach, the recipe existing, having the input, and having room for what
      // comes back — all re-asked in the session, on the same terms a reward
      // is. The client offered the row from these rules, on a board and a bag
      // that may both be a round trip old.
      session.transmute(message.ref, message.recipe, actorId);
    } else if (message.type === "command") {
      // **The one gate in the protocol that is about who is asking rather than
      // about the board.** Every other message is re-validated against the
      // world — reach, capacity, a cooldown — and a client that made one up
      // gets the same answer an honest one would. A command is not like that:
      // `/mastery sharp 100` is a legal request from an administrator and a
      // fabricated frame from everybody else, and only the account tells them
      // apart. It is read off the attachment rather than looked up, because the
      // cookie was read once at the upgrade and there is no request left here.
      //
      // Refused rather than dropped: a command is typed blind, so silence is
      // indistinguishable from a server that stopped listening. @see
      // `app/game/commands`, where the same argument is the reason every
      // refusal has a sentence.
      //
      // The flushes below are why this sits in the chain rather than returning
      // early like `say` does: a command answers with a notice and, depending
      // on the verb, a mastery block or a cell of the board — and all of them
      // go out on that tail.
      if (admin) session.runCommand(message.text, actorId);
      else session.refuseCommand(actorId);
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
    this.flushConversations();
    this.flushExtracting();
    // Before the notices, so a press that moved somebody's door is durable by
    // the time they are told it did.
    this.flushSpawnMarks();
    this.flushNextBlow();
    this.flushNotices();
    this.flushClock();
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
      this.sendToNearby({ x, y, z }, actors, {
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
    // A conjure lands on the cast, not on a tick, so its flame has to be
    // announced in the same flush as the blow it came with.
    this.collectTransitionEvents(session);
  }

  /**
   * Send one actor-shaped message to each player a queue names.
   *
   * Six flushes were this same dozen lines: drain a queue of actor ids, bail if
   * it is empty, then walk the attached sockets and send the one whose id is in
   * it. Only two things ever differed — which queue, and what to put on the
   * wire — so those are what a caller supplies.
   *
   * **A null message means the body is gone**, and that case is why this is a
   * builder rather than a message. An actor can die between the change being
   * queued and this running — the blow that taught them something was also the
   * one that killed them — and every copy of this loop had to remember to check
   * for it separately. Here there is one place to forget, and it does not.
   *
   * Addressed rather than broadcast, which is what all six have in common and
   * what keeps them cheap: a kit, a tag, an experience block and a status list
   * are facts about one player that nothing else on any client draws, so a room
   * of twenty people fighting is twenty small sends rather than twenty
   * serializations of everybody's.
   */
  private flushPerActor(
    drain: (session: GameSession) => readonly string[],
    message: (session: GameSession, actorId: string) => ServerMessage | null,
  ) {
    const session = this.session;
    if (!session) return;
    const changed = drain(session);
    if (changed.length === 0) return;

    const wanted = new Set(changed);
    for (const [ws, actorId] of this.seated()) {
      if (!wanted.has(actorId)) continue;
      const out = message(session, actorId);
      if (out) ws.send(JSON.stringify(out));
    }
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
    this.flushPerActor(
      (session) => session.drainEquipmentChanges(),
      (session, actorId) => {
        const equipment = session.equipmentOf(actorId);
        if (!equipment) return null;
        return {
          type: "equipment",
          equipment,
          // Beside the kit because it is the same fact about the same caster —
          // see `GameSession.spellCooldownsOf`. Empty for every body with no
          // spells of its own, which is almost every body.
          spellCooldowns: session.spellCooldownsOf(actorId) ?? {},
        };
      },
    );
  }

  /**
   * Tell whoever started or stopped a pull what they are now working.
   *
   * Beside {@link flushTags} and shaped exactly like it, because it is the same
   * kind of fact: per player, whole state, and only to the socket it is about.
   * A separate queue rather than a flag on that one, on the session's own
   * argument — a pull ends on a tick nothing else happened, and sharing a queue
   * would put a tag list on the wire every time somebody finished mining.
   */
  private flushExtracting() {
    this.flushPerActor(
      (session) => session.drainExtractionChanges(),
      // Null is the message here rather than the absence of one: it is how the
      // bar learns to go away.
      (session, actorId) => ({
        type: "extracting",
        extracting: session.extractionOf(actorId),
      }),
    );
  }

  /**
   * The wait to tell this player about, noted down as the thing they were last
   * told. @see flushNextBlow
   */
  private rememberNextBlow(actorId: string): Progress | null {
    const now = this.session?.nextBlowOf(actorId) ?? null;
    this.sentNextBlow.set(actorId, now);
    return now;
  }

  /**
   * Tell each player how long until their own next blow, when it changed.
   *
   * No queue behind it, unlike {@link flushExtracting}: a wait is a fact about
   * the *viewer* rather than about the world, so there is nobody to broadcast it
   * to and nothing to diff for anybody without a socket. Comparing what each
   * attached player was last told is the whole of it, and that comparison is an
   * identity check per socket per flush — see {@link sentNextBlow}.
   *
   * Two messages a wait in practice, which is the point: one when a windup is
   * armed or a blow is thrown, one when the body stops being engaged. What runs
   * in between is the client's own clock. @see `../app/game/progress`
   */
  private flushNextBlow() {
    const session = this.session;
    if (!session) return;
    const live = new Set<string>();
    for (const [ws, actorId] of this.seated()) {
      live.add(actorId);
      const now = session.nextBlowOf(actorId);
      // `has` before the compare, so the first flush after a hello says nothing:
      // the hello carried the wait, and an undefined that happened to match a
      // null would otherwise read as a change on the tick a fight ended.
      if (this.sentNextBlow.has(actorId) && this.sentNextBlow.get(actorId) === now) {
        continue;
      }
      this.sentNextBlow.set(actorId, now);
      ws.send(
        JSON.stringify({
          type: "nextBlow",
          // Copied on the way out, on {@link progressOf}'s terms: the object is
          // the runtime's own and it is about to be wound past what was sent.
          nextBlow: now ? { ...now } : null,
        } satisfies ServerMessage),
      );
    }
    for (const id of this.sentNextBlow.keys()) {
      if (!live.has(id)) this.sentNextBlow.delete(id);
    }
  }

  /**
   * Tell anybody whose tags changed what they have taken now.
   *
   * Its own drain and its own message, sent from the same places the kit is —
   * they change together today, and the two queues are what keeps that a fact
   * about rewards rather than an assumption in the plumbing.
   */
  private flushTags() {
    this.flushPerActor(
      (session) => session.drainTagChanges(),
      (session, actorId) => {
        const tags = session.tagsOf(actorId);
        if (!tags) return null;
        return { type: "tags", tags: [...tags] };
      },
    );
  }

  /**
   * Tell each player whose conversation changed where they now stand in it.
   *
   * A separate queue from {@link flushTags} rather than a flag on it, because
   * a conversation moves on ticks a tag never does.
   */
  private flushConversations() {
    this.flushPerActor(
      (session) => session.drainConversationChanges(),
      // Null is sent too — it is how the panel learns to close.
      (session, actorId) => ({
        type: "conversation",
        conversation: session.conversationOf(actorId),
      }),
    );
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

    for (const [ws, actorId] of this.seated()) {
      for (const text of session.drainNotices(actorId)) {
        ws.send(JSON.stringify({ type: "notice", text } satisfies ServerMessage));
      }
    }
  }

  /**
   * Move the doors of everybody who anchored themselves somewhere.
   *
   * **Through the cache rather than behind it.** {@link rememberSpawn} reads the
   * row once per connection and trusts what it holds from then on, so a write
   * that went only to storage would leave this instance putting people back at
   * the cell they started at for the rest of the world's life. Both move, in
   * that order, and the write is fire-and-forget on {@link rememberSpawn}'s own
   * terms: it has to be durable before a death that reads it, which is why it
   * is its own `put` rather than a place in the next flush, and there is nothing
   * useful to do about one that does not stick.
   *
   * **The facing does not move.** What the session offers is a cell, and the
   * direction on the row stays whatever a fresh body takes — a door is not a
   * footprint, and somebody who anchored themselves while walking north has said
   * nothing about which way they want to be looking when they come back.
   *
   * Nobody is told. The session already said the sentence to the player who
   * pressed it, and there is nothing on any client drawn from this.
   *
   * Drained both from the tick and from the message chain, because a `step`
   * block fires inside a tick and a pressed one arrives between two of them.
   * Empty on almost every call, which is the cost of asking twice.
   */
  private flushSpawnMarks() {
    const session = this.session;
    if (!session) return;

    for (const { actorId, at } of session.drainSpawnMarks()) {
      const spawn: ActorPosition = {
        x: at.x,
        y: at.y,
        z: at.z,
        direction: this.spawns.get(actorId)?.direction ?? DEFAULT_FACING,
      };
      this.spawns.set(actorId, spawn);
      this.ctx.storage
        .put(this.spawnKey(actorId), { ...spawn, savedAt: Date.now() })
        .catch(GameServer.reportWriteFailure("spawn write"));
      // **After the record has moved, never before.** What the client does with
      // this is draw one row grey, so a message that raced ahead of the write
      // would be a button claiming a mark that storage had not taken yet.
      // Addressed to the one socket it is about, on the terms a kit and a tag
      // are: nobody else's respawn point is drawn anywhere.
      this.sendTo(actorId, { type: "spawnPoint", at: { ...at } });
    }
  }

  /**
   * The cell this player comes back to, without the facing the row also holds.
   *
   * The facing is a fact about the body a rebirth mints and has no reader on
   * the client — see `SetSpawnInteraction`, where the same stripping happens on
   * the way into the session. Null for somebody this instance has not minted a
   * row for yet, which after a world replacement is everybody.
   */
  private spawnCellOf(actorId: string): { x: number; y: number; z: number } | null {
    const spawn = this.spawns.get(actorId);
    return spawn ? { x: spawn.x, y: spawn.y, z: spawn.z } : null;
  }

  /** The world's time of day right now: the wall clock, moved by `/time`. */
  private minutesOfDay(): MinutesOfDay {
    return wrapMinutes(minutesOfDayAt(Date.now()) + this.clockOffsetMinutes);
  }

  /**
   * Move the world's clock to the hour `/time` asked for, and tell everybody.
   *
   * Broadcast rather than addressed, because the hour is the world's: a client
   * anchors its clock once from `hello` and runs it forward from there, so one
   * that is not told keeps the old hour until it reconnects.
   */
  private flushClock() {
    const minutes = this.session?.drainClockSet();
    if (minutes === null || minutes === undefined) return;
    this.clockOffsetMinutes = minutes - minutesOfDayAt(Date.now());
    this.broadcast({ type: "clock", minutesOfDay: minutes });
  }

  /**
   * Tell anybody whose experience moved what they have learnt now.
   *
   * The busiest of these queues by a long way — roughly one message per landed
   * blow. @see flushPerActor for why that is affordable.
   */
  private flushMasteries() {
    this.flushPerActor(
      (session) => session.drainMasteryChanges(),
      (session, actorId) => {
        const masteryXp = session.masteryXpOf(actorId);
        if (!masteryXp) return null;
        // Copied on the way out, because what the session hands back is the
        // live block it goes on adding to.
        return { type: "masteries", masteryXp: { ...masteryXp } };
      },
    );
  }

  /**
   * Tell anybody whose statuses have moved what is running on them now.
   *
   * The only one of these queues that fills on its own: a kit, a tag and a
   * mastery all change because somebody did something, and this changes
   * because time passed. `GameSession` compares a **reading** rather
   * than the list, which is what keeps a status that runs for an hour to about
   * thirty-six hundred small sends instead of a hundred thousand.
   *
   * Addressed rather than broadcast, and that is not an economy here but a
   * correctness point: nothing draws another body's statuses, so nobody else has
   * any use for them.
   */
  private flushStatuses() {
    this.flushPerActor(
      (session) => session.drainStatusChanges(),
      (session, actorId) => {
        const statuses = session.statusPatchesOf(actorId);
        if (!statuses) return null;
        return { type: "statuses", statuses };
      },
    );
  }

  /**
   * Hold a step until the actor is free to take it.
   *
   * Never taken here, always on a tick — see {@link applyQueuedSteps} for why
   * the moment matters.
   */
  private queueStep(actorId: string, step: QueuedStep) {
    const queue = this.queuedIntents.get(actorId) ?? [];
    const waiting = queue.filter((intent) => intent.kind === "step").length;
    if (waiting >= MAX_QUEUED_STEPS || queue.length >= MAX_QUEUED_INTENTS) {
      // Further ahead than any honest client gets. Refusing the newest rather
      // than dropping the oldest keeps what is queued a contiguous run of steps,
      // which is the only thing the client can roll back cleanly.
      this.rejectStep(actorId, step.seq);
      return;
    }
    queue.push({
      kind: "step",
      seq: step.seq,
      direction: step.direction,
      preferDescend: step.preferDescend,
    });
    this.queuedIntents.set(actorId, queue);
  }

  /**
   * Turn or cast now, or behind the steps this client sent before it.
   *
   * Now whenever nothing is waiting, which is nearly always, so a turn on the
   * spot costs no tick. A body that is mid-step with nothing queued behind it is
   * already walking into the cell the client is drawing, and the session
   * resolves both a turn and a cast against that walk. @see GameSession's
   * `faceActor` and `casterPointOf`
   *
   * Past the cap it is dropped rather than refused: neither message has a reply
   * to carry a refusal in, and a client that far ahead is not an honest one.
   */
  private queueAction(actorId: string, action: QueuedAction) {
    const queue = this.queuedIntents.get(actorId);
    if (!queue) {
      this.applyAction(actorId, action);
      return;
    }
    if (queue.length >= MAX_QUEUED_INTENTS) return;
    queue.push(action);
  }

  private applyAction(actorId: string, action: QueuedAction) {
    const session = this.session;
    if (!session) return;
    if (action.kind === "face") session.faceActor(actorId, action.direction);
    else session.cast(action.slot, actorId);
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

    for (const [actorId, queue] of this.queuedIntents) {
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
        this.queuedIntents.delete(actorId);
        continue;
      }

      this.drainIntents(session, actorId, queue);
      if (queue.length === 0) this.queuedIntents.delete(actorId);
    }
  }

  /**
   * Take what one actor has waiting, in order, until a step has to wait.
   *
   * A turn or a cast never waits on its own account — it only waits for the
   * steps in front of it. So a cast queued behind a step is honoured in the same
   * pass that starts that step, cast from the cell the step is walking into,
   * which is where the client was standing when it pressed.
   */
  private drainIntents(session: GameSession, actorId: string, queue: QueuedIntent[]) {
    while (queue.length > 0) {
      const intent = queue[0]!;
      if (intent.kind !== "step") {
        queue.shift();
        this.applyAction(actorId, intent);
        continue;
      }

      const outcome = session.requestStep(actorId, intent.direction, {
        preferDescend: intent.preferDescend,
      });
      // Still walking off the last one. Everything behind it waits too —
      // steps are a sequence, and taking them out of order would walk the
      // actor somewhere neither side asked for. A step started just above
      // answers this for the next one, which is what holds it to the tick
      // that finishes the walk.
      if (outcome === "later") return;

      queue.shift();
      if (outcome === "refused") this.rejectStep(actorId, intent.seq);
    }
  }

  /** Tell one client a step it drew never happened. */
  private rejectStep(actorId: string, seq: number) {
    this.sendTo(actorId, { type: "stepRejected", seq });
  }

  /** Send to one actor's socket, if they still have one. */
  private sendTo(actorId: string, message: ServerMessage) {
    const payload = JSON.stringify(message);
    for (const ws of this.socketsOf(actorId)) {
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
      name: author.name,
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
      this.sendToNearby({ x, y, z }, actors, {
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
      /** What the speaker is called, or null for a creature. @see ChatBubble */
      name: string | null;
      text: string;
      x: number;
      y: number;
      z: number;
      stackIndex: number;
    },
  ) {
    const message: ServerMessage = { type: "chat", ...at };
    this.sendToNearby(at, actors, message);
    this.logChat(Date.now(), at.actorId, at, at.text);
  }

  /**
   * Send to everyone who could see the cell it happened in.
   *
   * **The level *and* the distance, and the second half was missing.** A bubble
   * and a noise are both drawn at a cell — they hang over the body that made
   * them — so a client that cannot see that cell draws nothing whatever it is
   * told. Scoping by storey alone meant every crunch, gulp, hiss and howl in
   * the world reached every client standing on that storey: measured on the den
   * with people in it, five of every six noises a client was sent were made
   * somewhere it could not see, and the other one was the only one it drew.
   *
   * The reach is the body reach, because that is the same question — a noise is
   * made by a body, and if you are too far away to be told the body is there
   * you are too far away to be told what it did. @see `../app/net/interest`
   *
   * Serialized once, not once per socket: the payload is the same for all of
   * them, and the only thing being decided per socket is whether it is theirs.
   */
  private sendToNearby(
    at: { x: number; y: number; z: number },
    actors: ActorSnapshot[],
    message: ServerMessage,
  ) {
    const whereById = new Map(actors.map((actor) => [actor.id, actor]));
    const payload = JSON.stringify(message);
    for (const [ws, actorId] of this.seated()) {
      const viewer = whereById.get(actorId);
      // The storey test stays as it was: a client takes one of these as already
      // theirs to draw, and a bubble from the floor below would be drawn
      // through it. The reach is what is new.
      if (!viewer || viewer.z !== at.z) continue;
      if (!withinBodyReach(viewer, at.x, at.y, at.z)) continue;
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
    sql.exec("DELETE FROM chat WHERE id <= (SELECT MAX(id) FROM chat) - ?", CHAT_LOG_MAX_ROWS);
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
    // Before anything is awaited, so no tick in between takes this socket for
    // one that is still seated. @see unseat
    this.unseat(ws);
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
    // {@link displaceSockets} now clears the old socket's attachment when the
    // new one joins, so that late close returns above. This stays as the check
    // that the actor has really gone, rather than trusting that it always will.
    if (this.hasSocket(attachment.actorId, ws)) return;

    this.forgetConnection(attachment.actorId);

    // **A body in a fight stays in it.** Otherwise closing the tab is the
    // best move in any losing fight. It stands idle — see `standIdle` for why
    // it does not go on swinging — until {@link releaseLingerers} sees the
    // combat minute run out and finishes what this close started.
    if (this.session?.inCombat(attachment.actorId)) {
      // Written now, as an ordinary close writes before its despawn: a restart
      // inside the minute reaps this body without ever releasing it, and
      // nothing else between here and there saves an actor. Left to the
      // periodic flush, the kit on disk could be half a minute behind the
      // board the drain checkpoints.
      this.saveActors([attachment.actorId], true);
      this.session.standIdle(attachment.actorId);
      this.lingering.set(attachment.actorId, Date.now() + GameServer.MAX_LINGER_MS);
      // The minute only runs down while the world ticks.
      this.wake();
      return;
    }

    this.leaveWorld(attachment.actorId, ws);
  }

  /**
   * Drop what only a connection had, whether or not the body goes with it.
   *
   * Split from {@link leaveWorld} because a player in combat loses their
   * connection at the close and their body a minute later, and everything here
   * belongs to the first of those.
   */
  private forgetConnection(actorId: string) {
    // What ground they had been sent, which is only true of a connection. A
    // returning tab is a fresh `hello` and a fresh subscription, so keeping it
    // would be a row per visitor the world has ever had.
    this.subscribed.delete(actorId);
    // And which bodies they had been told about, for the same reason and on the
    // same terms: it describes what one connection holds, and the `hello` that
    // opens the next one seeds it again.
    this.announcedActors.delete(actorId);
    this.lastCut.delete(actorId);
    this.subscriptionsToCheck.delete(actorId);
    // A step nobody is holding the key for any more.
    this.queuedIntents.delete(actorId);
    this.lastSaidAt.delete(actorId);
    // Their last socket has gone, so there is nothing left to be silent
    // towards. `dead` is deliberately *not* cleared beside it — that is the
    // record keeping them off the board, and closing a tab is not a way to come
    // back to life. This is only the sending rule, and it has nobody to apply
    // to; left behind, it would be a row per player the world has ever killed,
    // growing with visitors rather than with anything.
    this.silenced.delete(actorId);
  }

  /**
   * Take a player's body off the board, and tell the room they have gone.
   *
   * @param closing the socket whose close this is, when it is one — still
   *   listed while its close is handled, so {@link playerCount} is told to skip
   *   it. Absent when a lingering body leaves on a tick, long after the close.
   */
  private leaveWorld(actorId: string, closing?: GameSocket) {
    // Before the despawn, which is what takes their tile — and with it the only
    // record of where they were — off the board.
    //
    // Forced past the dirty check, and not because anything here is likely to be
    // stale: a skipped row keeps whatever `savedAt` it last had, and `savedAt`
    // is what {@link pruneOldest} ranks by. Somebody who stood still for an hour
    // and then left would otherwise be carrying an hour-old stamp into the queue
    // of who gets forgotten first, which is precisely backwards.
    this.saveActors([actorId], true);
    this.session?.despawn(actorId);
    // Collected now, because the tick this wakes empties what is pending
    // before it drains: the body's way out rides the patch that removes it.
    if (this.session) this.collectTransitionEvents(this.session);
    this.writtenActors.delete(actorId);
    this.sentMotion.delete(actorId);
    // Nothing to take out of {@link announcedActors}: the body is off the board
    // on the next tick's snapshot, so every client holding it is told once, by
    // the same rule that tells them about a body walking out of reach.
    // Sent when the body goes rather than when the socket did: a client drops
    // everything it knows about an actor on `left`, and a lingering body that
    // lost its name and health bar a minute early would be a body nobody could
    // tell was still there to be hit.
    this.events.push({
      kind: "left",
      actorId,
      playerCount: this.playerCount(closing),
    });
    // Their tile just left the board, so the removal has to reach everyone else.
    this.wake();
  }

  /**
   * Let lingering bodies go once their fight is over, and forget the ones
   * their players came back to.
   *
   * After {@link noteDeaths} in the tick, and it has to be: a lingering body
   * killed this tick is out of combat by virtue of having no runtime, and
   * releasing it first would take it out of {@link lingering} before the death
   * could see it there and write down what it was carrying.
   */
  private releaseLingerers() {
    const nowMs = Date.now();
    for (const [actorId, releaseAtMs] of this.lingering) {
      if (this.hasSocket(actorId)) {
        this.lingering.delete(actorId);
        continue;
      }
      const fighting = this.session?.inCombat(actorId) ?? false;
      if (fighting && nowMs < releaseAtMs) continue;
      this.lingering.delete(actorId);
      this.leaveWorld(actorId);
    }
  }

  /**
   * Everybody whose body belongs on the board: the connected, and the bodies
   * still standing in a fight their players have left.
   */
  private presentActorIds(): Set<string> {
    const ids = new Set(this.lingering.keys());
    for (const [, actorId] of this.seated()) ids.add(actorId);
    return ids;
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
  async replaceWorld(flat: FlatMapFile, options: { keepPositions?: boolean } = {}): Promise<void> {
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
    const fighting = new Set<string>();
    // Lingering bodies included: a save re-creates the world, not the people
    // in it, and a body still standing in a fight is somebody in it.
    const present = this.presentActorIds();
    for (const actorId of present) {
      // Where they are standing, if anybody asked for that to survive. Off the
      // runtime rather than the `pos:` rows because a flush is up to
      // `ACTOR_FLUSH_INTERVAL_MS` behind — the same staleness argument the kit
      // read above makes. A dead player has no runtime and lands nothing here,
      // which is right: `dead` is cleared below, and where a body that no
      // longer exists last stood is not a place anybody should come back to.
      if (options.keepPositions) {
        const position = this.session?.actorPosition(actorId);
        if (position) standing.set(actorId, position);
      }
      const kit = this.session?.equipmentOf(actorId);
      if (kit) carried.set(actorId, kit);
      // Read here rather than from storage alone, for the reason the kit is: a
      // reward taken since the last flush is on the runtime and nowhere else,
      // and the world it was taken in is about to be replaced.
      const tags = this.session?.tagsOf(actorId);
      if (tags?.length) taken.set(actorId, [...tags]);
      // And the masteries, for the same reason again and with the least to
      // argue about of the three: a save is a statement about the world, and
      // nothing an author writes in one has any bearing on what a player has
      // already learnt.
      const masteries = this.session?.masteryXpOf(actorId);
      if (masteries) learnt.set(actorId, { ...masteries });
      // And what is running on them, with what it has already done to them. A
      // save re-creates the world, not the people standing in it, and a berry
      // eaten four seconds before somebody hit save is on the runtime and
      // nowhere else. Dropping the pair would cure every poison in the world
      // and heal every wound, once per save — and the editor saves constantly.
      const statuses = this.session?.statusesOf(actorId);
      if (statuses?.length) running.set(actorId, statuses);
      const hp = this.session?.storedHpOf(actorId);
      if (hp !== null && hp !== undefined) health.set(actorId, hp);
      // And the switch, on the tags' argument rather than the kit's: it records
      // a decision the player made, and nothing an author writes into a map has
      // any bearing on it. Dropping it would put everybody back in the fighting
      // once per save — and the editor saves constantly.
      if (this.session?.pvpOf(actorId)) fighting.add(actorId);
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
    this.setRespawnPoints(findSpawnPoints(session.getMap(), tilesByIdFromList(tiles)));
    this.respawnPending.clear();
    this.persistRespawnPoints();
    this.persistRespawnPending();
    this.scheduleRespawnAlarm();
    this.sentMotion.clear();
    // Re-seeded by the `hello` every socket is about to be sent: these are the
    // old world's names, and the next one may reuse them for other bodies.
    this.announcedActors.clear();
    this.lastCut.clear();
    this.sentAfflicted.clear();
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
    this.queuedIntents.clear();
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
    for (const actorId of present) {
      const kit = carried.get(actorId);
      this.session.spawn(
        actorId,
        {
          // Asked of the character table rather than carried over from the
          // outgoing session, on the terms {@link seatActor} asks it: the table
          // is what owns a name, and reading it here means the one seating path
          // that does *not* go through `seatActor` cannot drift from it. A save
          // that dropped this left every player in the world labelled `Nobody`
          // until they reconnected.
          name: (await this.env.nameOf?.(actorId)) ?? null,
          // Honoured only if the cell still has room for them; `findEntryCell`
          // bubbles outward and gives up at the new spawn, so a position kept
          // across a deploy can never seat somebody inside a wall.
          at: standing.get(actorId),
          carrying: kit ? restoredEquipment(kit, tilesById) : await this.lastEquipmentOf(actorId),
          tagged: taken.get(actorId) ?? (await this.lastTagsOf(actorId)),
          earned: learnt.get(actorId) ?? (await this.lastMasteriesOf(actorId)),
          statuses: running.get(actorId) ?? (await this.lastStatusesOf(actorId)),
          hp: health.get(actorId) ?? (await this.lastHpOf(actorId)),
          pvp: fighting.has(actorId) || (await this.lastPvpOf(actorId)),
        },
        { announce: false },
      );
    }
    for (const [ws, actorId] of this.seated()) this.sendHello(ws, actorId);
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
    for (const [ws, actorId] of this.seated()) this.sendHello(ws, actorId);
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
    // Re-seeded by the `hello` every socket is about to be sent: these are the
    // old world's names, and the next one may reuse them for other bodies.
    this.announcedActors.clear();
    this.lastCut.clear();
    this.sentAfflicted.clear();
    this.sentHp.clear();
    this.sentCarriedLights.clear();
    this.sentStatusIds.clear();
    this.sentPvp.clear();
    this.queuedIntents.clear();
    this.lastSaidAt.clear();
    // Their bodies went with the board, and a reset seats nobody who has no
    // socket.
    this.lingering.clear();
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
    for (const [ws, actorId] of this.seated()) this.sendHello(ws, actorId);
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
        console.error(`[world] tick failed (${n} in a row, still ticking)`, error);
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
    if (this.queuedIntents.size > 0) return;
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
    this.collectTransitionEvents(session);
    this.collectTeleportEvents(session);
    this.collectSwingEvents(session);
    // **Before the deaths**, and that order is the whole of why this is not
    // simply left to the message chain: a `step` block and the blow that kills
    // you can land in one tick, and {@link noteDeaths} writes the position row
    // by reading {@link spawns}. Draining afterwards would put somebody back at
    // the door they had a moment before walking into the temple.
    this.flushSpawnMarks();
    this.noteDeaths(session);
    this.releaseLingerers();
    this.broadcastSpeech(session, actors);
    this.broadcastNoise(session, actors);

    // Before the cells are diffed, so a cell whose fire changed is among them
    // and every cell sent this flush carries what is burning in it.
    this.burning = afflictionsByCell(session.afflictedPlacements());
    const cells = this.diffCells(session.getMap());
    this.sweepRespawnCells(cells);
    const hps = this.diffHps(actors);
    const carriedLights = this.diffCarriedLights(actors);
    const statusIds = this.diffStatusIds(actors);
    const pvp = this.diffPvp(actors);
    const extractions = this.diffExtractions(actors);
    const castings = this.diffCastings(actors);
    // Sent even when the shared diff is empty, because a client whose
    // subscription moved this tick has bodies to be told about and the diff
    // above says nothing about them. {@link broadcastPatch} is what decides
    // whether any given socket has something to hear.
    const moved = this.broadcastPatch(actors, {
      cells,
      events: this.events,
      hps,
      carriedLights,
      statusIds,
      pvp,
      extractions,
      castings,
    });
    // Advanced whatever any one socket was sent, and that is the rule the
    // scoping rests on: this is the *shared* baseline, so a cell left out of
    // one client's patch must not be re-offered to everybody on the next. What
    // that client holds instead is its subscription, and a chunk coming back
    // into reach is handed over whole. @see `../app/net/scope`
    this.broadcastMap = session.getMap();
    this.events = [];

    // After the shared patch, and that ordering is the point: a chunk coming
    // into reach is handed over as it stands *now*, so it must not be followed
    // by a diff computed against a board this client had not been shown.
    this.streamEnteredChunks(moved);

    // After the patch, which is the whole of the ordering: that patch is the
    // last thing these sockets will hear, and this is what tells them so.
    this.announceDeaths();

    // A kit can change on a tick as well as on input: food rots on the world's
    // clock, not on anybody's keypress, and the alternative is finding out by
    // way of a panel that never updates.
    this.flushEquipment();
    this.flushTags();
    // On the tick as well as on input: a conversation ends when its partner
    // walks out of reach, which is a thing the world notices, not a message.
    this.flushConversations();
    this.flushExtracting();
    // The fight's own clock, on the tick above all: a wait runs down without
    // anybody pressing anything, and the outline drawn from it is the one thing
    // on a fighter's screen that has to keep up with it.
    this.flushNextBlow();
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
      // A body nobody has been told about is announced in {@link scopedPatchFor}
      // rather than here: whether it is news is a question with one answer per
      // client now, and this list is the one every client shares.
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
      this.queuedIntents.delete(actorId);
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
      //
      // A body left standing in a fight is somebody's too, with no socket: its
      // kit is on the floor now, and not writing that down would hand it back
      // to them on their next join as well.
      const connected = this.hasSocket(actorId);
      if (!connected && !this.lingering.has(actorId)) continue;
      this.pendingDeathWrites.set(actorId, death);
      // Only somebody connected is somebody to tell. See {@link tick} for why
      // the telling waits until after this tick's patch has gone out.
      if (connected) this.justDied.push(death);
    }
    // **Written here, rather than left to the next flush.** The board this tick
    // leaves behind no longer holds the body and does hold its kit, and the rows
    // saying so are the ones above; a flush that carried one without the other
    // would hand somebody back a sword that is also lying on the floor, or take
    // one that is lying nowhere. They go in one batch, and it is this one —
    // deferring it would leave a reload in the gap reading the pre-death kit,
    // and a reload is the very next thing a dead player does.
    //
    // **Everybody else's kit rides with them, and only their kit.** The board
    // in this batch is every chunk that moved since the last one, so it can
    // also be where somebody else's pickup landed — and a kit left out of the
    // batch that carries the board it was read off is the item existing twice.
    // What cannot contradict the board is left to the ordinary flush: a
    // position, a health bar and a status list are the same whenever they are
    // written. This used to force every row of every actor, which with a
    // thousand players was thousands of rows written for every death, most of
    // them saying what storage already had.
    if (this.pendingDeathWrites.size > 0) {
      this.saveActors(session.actorIds(), false, "kits");
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
    const spawn = this.spawns.get(actorId);
    this.session!.spawn(actorId, {
      // Read at every seating rather than remembered across them, and the cost
      // is one indexed lookup on a join. It is not a fact the checkpoint could
      // hold: a `name:` row beside the `pos:` row would be a second copy of
      // something the character table already owns, and the copy is what would
      // be read if the two ever disagreed. @see `./characters`
      name: (await this.env.nameOf?.(actorId)) ?? null,
      ...(await this.restoredActor(actorId)),
      // The cell alone, dropping the facing the row also carries: what the
      // session does with this is decide whether a press on a bed would change
      // anything, and a direction it can never be handed could only ever make
      // that comparison fail. Hence the seating happening after the remember,
      // which the order above was already load-bearing for.
      ...(spawn ? { spawnAt: { x: spawn.x, y: spawn.y, z: spawn.z } } : {}),
    });
    // A seat happens on a join, a wake or a rebirth, never inside a tick, and
    // the next tick empties whatever it finds pending before it drains: the
    // body's way in has to be collected here or it is never sent.
    this.collectTransitionEvents(this.session!);
  }

  /**
   * Answer "put me back in" from a dead player.
   *
   * Reloading the page does the same thing by way of {@link fetch}, and did it
   * first — this exists so that coming back does not mean losing the tab. What
   * it costs over a reload is one `hello`, which a reload was paying anyway.
   *
   * **Answered with a whole `hello`.** A silenced socket has been receiving
   * nothing for as long as its owner sat on the death screen, so its map is
   * arbitrarily stale and there is no diff that would catch it up.
   *
   * Ignored unless they are actually dead. A live player asking for this would
   * otherwise be handed a second seating — harmless in itself, since `spawn`
   * keeps the body already on the board, but the `hello` behind it would throw
   * away every step they had predicted.
   */
  private async rebirth(actorId: string) {
    if (!this.dead.has(actorId)) return;
    await this.seatActor(actorId);
    for (const ws of this.socketsOf(actorId)) this.sendHello(ws, actorId);
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
    for (const ws of this.socketsOf(actorId)) {
      if (ws !== excluding) return true;
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
   * has a start, a speed off the tile, and the name of the body being shot at —
   * which is enough to draw every frame of it, including the ones where that
   * body has moved, without being told any of them.
   */
  private collectProjectileEvents(session: GameSession) {
    for (const flight of session.drainProjectiles()) {
      this.events.push({
        kind: "projectileFired",
        id: flight.id,
        tileId: flight.tileId,
        from: flight.from,
        to: flight.to,
        // The body it was aimed at, so every receiver draws it following that
        // body rather than the point it was loosed at — see
        // `../app/game/projectile`'s `ProjectileFlight.targetId`.
        ...(flight.targetId ? { targetId: flight.targetId } : {}),
        hit: flight.hit,
      });
    }
  }

  /**
   * Turn this tick's tile transitions into events.
   *
   * Drained rather than diffed, on the terms a shot is: the cell patch in this
   * same frame says a flame is gone, and no pair of readings says whether it
   * burned out or was picked up. See `../app/lib/tileTransition`.
   */
  private collectTransitionEvents(session: GameSession) {
    for (const note of session.drainTransitions()) {
      this.events.push({ kind: "tileTransition", ...note });
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
   * Diff one reading per actor against what was last broadcast, and forget the
   * actors that have left.
   *
   * Six diffs were this same loop, ending in the same sweep: **an actor no
   * longer on the board is dropped from the map of what was sent.**
   *
   * That sweep is about memory rather than about the wire, and the comments
   * this replaces had it wrong. They claimed a returning player would otherwise
   * be diffed against the body they died in — back on their old hit points, or
   * carrying the lantern their corpse is still holding. It is not reachable:
   * {@link scopedPatchFor} puts a body nobody has been told about into
   * `entered` and announces it with its whole snapshot, never through a diff.
   * What the sweep buys is what {@link noteDeaths} says beside its own
   * `sentHp.delete` — or the map grows a row per body the world has ever
   * killed, and a world that respawns creatures kills a great many.
   *
   * `read` returning undefined leaves an actor out altogether, which is not the
   * same as having nothing to say about them: an actor left out is never added
   * to the live set, so the sweep forgets them exactly as it forgets a body that
   * has gone. That is what {@link diffHps} wants for a crate.
   *
   * `same` is handed `undefined` for a body nothing has been sent about yet, and
   * every caller decides for itself what that counts as. The defaults are not
   * cosmetic: a body that arrives carrying no lights and has never been
   * broadcast must read as unchanged, or every actor that ever walks into view
   * is announced as having put a torch down.
   */
  private diffPerActor<S, P>(
    actors: ActorSnapshot[],
    sent: Map<string, S>,
    read: (actor: ActorSnapshot) => S | undefined,
    same: (was: S | undefined, now: S) => boolean,
    patch: (actor: ActorSnapshot, now: S) => P,
  ): P[] {
    const out: P[] = [];
    const live = new Set<string>();
    for (const actor of actors) {
      const now = read(actor);
      if (now === undefined) continue;
      live.add(actor.id);
      if (same(sent.get(actor.id), now)) continue;
      sent.set(actor.id, now);
      out.push(patch(actor, now));
    }
    for (const id of sent.keys()) {
      if (!live.has(id)) sent.delete(id);
    }
    return out;
  }

  /**
   * Hit points that changed since the last broadcast.
   *
   * Only battlers are tracked, so a world of scenery costs one `null` check per
   * actor and leaves nothing behind. @see diffPerActor
   */
  private diffHps(actors: ActorSnapshot[]): HpPatch[] {
    return this.diffPerActor(
      actors,
      this.sentHp,
      // Undefined for anything that is not a battler, so a world of scenery
      // costs one check per actor and leaves no entries behind.
      (actor) =>
        actor.hp === null || actor.maxHp === null
          ? undefined
          : { hp: actor.hp, maxHp: actor.maxHp, rating: actor.rating ?? 0 },
      // Either number moving is worth a message, and the ⭐ is why this is a
      // pair rather than a single reading: a creature's never moves and a
      // player's moves without their hit points doing so. `maxHp` rides along
      // to be sent and is deliberately not compared.
      (was, now) => was?.hp === now.hp && was.rating === now.rating,
      (actor, now) => ({
        actorId: actor.id,
        hp: now.hp,
        maxHp: now.maxHp,
        rating: now.rating,
      }),
    );
  }

  /**
   * Carried lights that changed since the last broadcast.
   *
   * Almost always empty, and that is the shape to protect: this runs on every
   * tick of every world, and a torch is picked up once.
   *
   * A string rather than the array, because the question is "the same answer as
   * last time" and the array is rebuilt whenever a kit changes — comparing by
   * identity would re-broadcast a lantern every time somebody moved a sword
   * between two pockets.
   */
  private diffCarriedLights(actors: ActorSnapshot[]): CarriedLightsPatch[] {
    return this.diffPerActor(
      actors,
      this.sentCarriedLights,
      (actor) => actor.carriedLights.join(","),
      (was, now) => (was ?? "") === now,
      (actor) => ({ actorId: actor.id, tileIds: actor.carriedLights }),
    );
  }

  /**
   * Whose statuses have changed since the last patch, as ids.
   *
   * A diff of its own rather than a read of `drainStatusChanges`, and the two
   * must not be confused: that queue is drained to send the viewer their *own*
   * countdown, and reading it here would take the message out of their mouth.
   * This compares what was last broadcast instead.
   */
  private diffStatusIds(actors: ActorSnapshot[]): StatusIdsPatch[] {
    return this.diffPerActor(
      actors,
      this.sentStatusIds,
      // The ids and the string they are compared by, together, so the list is
      // walked once per actor per tick rather than once to compare and again
      // to send.
      (actor) => {
        const defIds = statusIdsOf(actor);
        return { defIds, key: defIds.join(",") };
      },
      (was, now) => (was?.key ?? "") === now.key,
      (actor, now) => ({ actorId: actor.id, defIds: now.defIds }),
    );
  }

  /**
   * Whose switch moved since the last patch. @see `../app/net/protocol`'s PvpPatch
   *
   * A diff on {@link diffStatusIds}' terms.
   */
  private diffPvp(actors: ActorSnapshot[]): PvpPatch[] {
    return this.diffPerActor(
      actors,
      this.sentPvp,
      (actor) => actor.pvp,
      (was, now) => (was ?? false) === now,
      (actor, now) => ({ actorId: actor.id, on: now }),
    );
  }

  /**
   * Whose pull started or ended since the last patch.
   *
   * Not a read of `drainExtractionChanges`, for the reason {@link diffStatusIds}
   * is not a read of `drainStatusChanges`: that queue is drained to send each
   * player their own pull, key and all, and reading it here would take the
   * message out of their mouth.
   *
   * A body that has left is forgotten without a patch, which is right rather
   * than merely cheap: its tile is off the board in the same frame's cells, so
   * there is nothing left to hang a bar on.
   */
  private diffExtractions(actors: ActorSnapshot[]): ExtractionPatch[] {
    return this.diffPerActor(
      actors,
      this.sentExtractions,
      (actor) => actor.extracting,
      (was, now) => (was ?? null) === now,
      (actor, now) => ({
        actorId: actor.id,
        progress: now ? progressOf(now) : null,
      }),
    );
  }

  /**
   * Whose cast started or ended since the last patch.
   *
   * {@link diffExtractions}' twin, down to the identity compare: the runtime
   * winds one object in place for the whole cast and replaces it only at the two
   * ends, so comparing the numbers would send a message every tick of every
   * spell in the world.
   */
  private diffCastings(actors: ActorSnapshot[]): CastingPatch[] {
    return this.diffPerActor(
      actors,
      this.sentCastings,
      (actor) => actor.casting,
      (was, now) => (was ?? null) === now,
      (actor, now) => ({
        actorId: actor.id,
        progress: now ? castProgressOf(now) : null,
      }),
    );
  }

  /**
   * Cells that changed since the last broadcast, and what changed in them.
   *
   * Chunk identity first (`changedCellsOnLevel`), so an unchanged floor costs a
   * reference compare rather than a walk of thousands of cells. This is the
   * whole reason the protocol stays cheap as the map grows.
   *
   * Each one is tagged with whether anything but a body moved and whose bodies
   * were involved, because that is what decides who it is news to — and it is
   * the same answer for every client, so it is worked out once here rather than
   * once per socket. @see `../app/net/scope`
   *
   * **A cell whose fire changed is a changed cell**, even when its stack is the
   * same object: it joins the diff as terrain, so it reaches every client
   * subscribed to its chunk and no other, by the same scoping a tile swap goes
   * through. That is the whole of how a burning placement is scoped — there is
   * no per-client record of what anybody was told. @see sentAfflicted
   */
  private diffCells(next: MapFile): ScopedCell[] {
    const prev = this.broadcastMap;
    const burned = this.afflictionChanges();
    // Nothing to diff against yet: every client is about to get a `hello`,
    // which carries the fires in its ground.
    if (!prev) return [];

    const out: ScopedCell[] = [];
    if (prev !== next) {
      for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
        for (const key of changedCellsOnLevel(prev, next, z)) {
          const { x, y } = parseCoordKey(key);
          const before = getStack(prev, x, y, z);
          const stack = getStack(next, x, y, z);
          // Already going out, and carrying what is burning in it.
          burned.delete(cellAfflictionKey(x, y, z));
          out.push({
            cell: this.cellPatch(x, y, z, stack),
            terrain: !onlyBodiesMoved(before, stack),
            bodies: bodiesIn(before, stack),
          });
        }
      }
    }
    for (const { x, y, z } of burned.values()) {
      out.push({
        cell: this.cellPatch(x, y, z, getStack(next, x, y, z)),
        terrain: true,
        bodies: [],
      });
    }
    return out;
  }

  /**
   * The cells whose fire is not what was last sent, and the record moved on to
   * match. Keyed by {@link cellAfflictionKey}, so the map diff can take out the
   * ones it is already sending.
   *
   * Almost always the first line: nothing burning, nothing sent.
   */
  private afflictionChanges(): Map<string, { x: number; y: number; z: number }> {
    const changed = new Map<string, { x: number; y: number; z: number }>();
    if (this.burning.size === 0 && this.sentAfflicted.size === 0) return changed;

    for (const [key, entries] of this.burning) {
      const reading = afflictionReading(entries);
      if (this.sentAfflicted.get(key) === reading) continue;
      this.sentAfflicted.set(key, reading);
      changed.set(key, parseCellAfflictionKey(key));
    }
    for (const key of this.sentAfflicted.keys()) {
      if (this.burning.has(key)) continue;
      this.sentAfflicted.delete(key);
      changed.set(key, parseCellAfflictionKey(key));
    }
    return changed;
  }

  /**
   * One cell as the wire carries it: its stack, and what is burning in it this
   * tick. Every cell the tick sends is built here, so no cell can reach a client
   * without its fire — which matters because a cell patch replaces what the
   * client held for the cell, fire included. @see CellPatch
   */
  private cellPatch(x: number, y: number, z: number, stack: PlacedTile[]): CellPatch {
    const afflicted = this.burning.get(cellAfflictionKey(x, y, z));
    return afflicted ? { x, y, z, stack, afflicted } : { x, y, z, stack };
  }

  /**
   * The chunks this actor is owed right now, recorded as their subscription.
   *
   * Computed from where their body is standing. A body that is not on the
   * board — dead, or between a despawn and a respawn — keeps whatever it had,
   * because the alternative is dropping the subscription and then handing the
   * whole thing back a tick later.
   */
  private subscriptionFor(actorId: string): Set<string> {
    const at = this.session?.actorPosition(actorId);
    const held = this.subscribed.get(actorId);
    if (!at) return held ?? interestChunks(0, 0);
    const chunks = interestChunks(at.x, at.y);
    this.subscribed.set(actorId, chunks);
    this.subscriptionCentre.set(chunks, chunkKeyFor(at.x, at.y));
    return chunks;
  }

  /**
   * Hand each connected client the ground that has come into reach.
   *
   * **Only what comes into reach, and never the tick's own changes** — those
   * go out with the tick's patch, cut to each client's subscription by
   * {@link broadcastPatch}. The two halves must not overlap: a chunk is handed
   * over as it stands *now*, so a diff computed against a board this client had
   * not been shown must not follow it.
   *
   * A budget per tick, nearest chunk first, because a chunk column of dense
   * cave is a few hundred cells and arriving all at once is the lump that made
   * a previous attempt at this measure *worse* than sending everything. At a
   * walking pace a player has a whole chunk to cross before any of the ground
   * ahead is on screen, so a handful a tick is far ahead of need.
   */
  private streamEnteredChunks(moved: readonly string[]) {
    const session = this.session;
    if (!session) return;
    const map = session.getMap();
    // Which chunks have anything burning in them, worked out the first time a
    // chunk is handed over this tick — which on most ticks is never.
    let burningChunks: Set<string> | null = null;
    // **Only whoever could be owed anything**: a client whose body moved, and
    // one still being handed ground it walked into. A subscription is a
    // function of where the body stands, so a client standing still with the
    // whole of its square already sent is owed nothing — and asking every
    // client where it was, every tick, to learn that was a cost per player per
    // tick for nothing. One set per actor rather than per socket: two tabs on
    // one body are owed the same ground, and computing it twice would not be
    // right.
    for (const id of moved) if (this.socketsByActor.has(id)) this.subscriptionsToCheck.add(id);
    for (const actorId of this.subscriptionsToCheck) {
      const before = this.subscribed.get(actorId);
      const at = this.socketsByActor.has(actorId) ? session.actorPosition(actorId) : null;
      // Gone, or dead: nothing to hand them. Coming back is a `hello`, which
      // sends a whole subscription of its own.
      if (!at) {
        this.subscriptionsToCheck.delete(actorId);
        continue;
      }
      const centre = chunkKeyFor(at.x, at.y);
      if (before && this.subscriptionCentre.get(before) === centre) {
        this.subscriptionsToCheck.delete(actorId);
        continue;
      }
      const now = interestChunks(at.x, at.y);
      if (sameChunks(before, now)) {
        this.subscriptionCentre.set(before!, centre);
        this.subscriptionsToCheck.delete(actorId);
        continue;
      }

      const entered = chunksEntered(before, now, at);
      const take = entered.slice(0, CHUNKS_STREAMED_PER_TICK);
      // The record advances only as far as what has actually been sent, so a
      // chunk the budget left behind is still owed next tick rather than
      // silently skipped. What has fallen out of reach is dropped from the
      // record but never taken back off the client — a cell it already holds is
      // correct, and unsending it would put a hole where it has just walked
      // from.
      const reached = new Set<string>();
      for (const chunk of before ?? []) if (now.has(chunk)) reached.add(chunk);
      for (const chunk of take) reached.add(chunk);
      this.subscribed.set(actorId, reached);
      if (sameChunks(reached, now)) {
        this.subscriptionCentre.set(reached, centre);
        this.subscriptionsToCheck.delete(actorId);
      }

      // Stripped of the bodies this client is not being told about, which is
      // every body in ground this far out: the handover reaches five chunks and
      // a body is announced at two and a half. @see `../app/net/interest`
      // With what is burning in them, which is how a fire in ground coming into
      // reach is told: the handover is the cell, and the fire is on the cell.
      //
      // Written from each chunk's kept text, which is the same bytes the cells
      // would have been as objects. @see `./chunkJson`
      burningChunks ??= this.burningChunks();
      const cells = handoverCellsJson(
        map,
        take,
        this.announcedActors.get(actorId) ?? NO_ACTORS,
        (x, y, z) => this.burning.get(cellAfflictionKey(x, y, z)),
        burningChunks,
      );
      if (cells === "") continue;
      const payload = `${GROUND_ONLY_HEAD}${cells}${GROUND_ONLY_TAIL}`;
      // To **every** socket this actor has open, unlike {@link sendTo}, which
      // answers one tab's own action and stops at the first socket. Ground
      // coming into reach is not an answer to anything — it is a fact about the
      // board that both tabs need, and a second tab that missed it would have a
      // hole in its map for as long as it stayed open.
      for (const ws of this.socketsOf(actorId)) {
        try {
          ws.send(payload);
        } catch {
          // Dropped by the runtime; webSocketClose cleans the actor up.
        }
      }
    }
  }

  /** The chunks with anything burning in them, as `z:chunk`. @see `./chunkJson` */
  private burningChunks(): Set<string> {
    const out = new Set<string>();
    for (const key of this.burning.keys()) {
      const { x, y, z } = parseCellAfflictionKey(key);
      out.add(`${z}:${chunkKeyFor(x, y)}`);
    }
    return out;
  }

  /**
   * The tick's patch, cut down to what each client is subscribed to, and sent.
   *
   * **A client hears about a chunk exactly while it is subscribed to it.** The
   * subscription already decided what map it was handed on join and what ground
   * it is handed as it walks (`../app/net/interest`); this is the other half of
   * the same rule, and until it existed the two disagreed — a join scaled with
   * the player and the tick stream scaled with everybody else. Twenty people in
   * twenty corners of the world each heard the other nineteen neighbourhoods
   * walk about, none of which they could see.
   *
   * **Serialization is shared wherever the patch survives the cut whole.**
   * That was the standing objection to doing this at all: one `JSON.stringify`
   * per tick regardless of player count is a real property, and spending it to
   * save bytes nobody was reading would be a poor trade. It is not spent in the
   * case it was written about — a world whose players are in one place all hold
   * the chunks the tick touched, {@link scopedPatchFor} hands each of them the
   * same object back, and one string goes to all of them. A client the patch
   * had to be cut for is sent text spliced from the same elements, each
   * serialized once for the tick. @see serializeCut
   *
   * Still one pass per *actor* rather than per socket: two tabs on one body are
   * owed the same message, and the set of bodies each client holds is advanced
   * here, so computing it twice would announce the same arrival twice.
   */
  private broadcastPatch(actors: ActorSnapshot[], patch: SharedPatch): readonly string[] {
    const frame = this.frameFor(actors, patch);
    let shared: string | null = null;
    const payloads = new Map<string, string | null>();
    for (const [ws, actorId] of this.seated()) {
      // The dead hear nothing more until they come back. @see silenced
      if (this.silenced.has(actorId)) continue;

      let payload = payloads.get(actorId);
      if (payload === undefined) {
        const mine = this.scopedPatchFor(actorId, frame);
        if (mine === null) {
          // Nothing was cut for this one, so it takes the shared string — which
          // is built at most once, and not at all if there is nothing in it.
          payload = isEmptyPatch(patch)
            ? null
            : (shared ??= JSON.stringify({
                type: "patch",
                ...wholePatch(patch),
              }));
        } else {
          payload = isEmptyCut(mine) ? null : serializeCut(mine, frame);
        }
        payloads.set(actorId, payload);
      }
      // Nothing this client is subscribed to changed, which is the ordinary
      // state of a world bigger than one room.
      if (payload === null) continue;
      try {
        ws.send(payload);
      } catch {
        // A socket that died between the tick and this send is dropped by the
        // runtime; webSocketClose will clean the actor up.
      }
    }
    // Whose bodies moved, arrived or left, which is who {@link
    // streamEnteredChunks} has to ask about next.
    return frame.changed.ids;
  }

  /**
   * What every client's cut of this tick is asked against, worked out once
   * for the tick: each body's chunk, which bodies moved since the last cut and
   * from where, the bodies each changed cell names, and who each event is for.
   *
   * Moves {@link bodiesAtLastCut} on to this tick as it goes, which is what
   * makes it a record of the *last* cut — so it is called exactly once per
   * broadcast, whether or not anybody is listening.
   */
  private frameFor(actors: ActorSnapshot[], patch: SharedPatch): TickFrame {
    const cut = ++this.cutCount;
    const chunkOf = new Array<string>(actors.length);
    const indexOf = new Map<string, number>();
    const bodies = columns(actors.length);
    const changedIds: string[] = [];
    const changedIndex: number[] = [];
    const changedWas: Array<Point | null> = [];
    // Where each body that moved stood at the last cut. A body that is not in
    // here stood where it stands.
    const before = new Map<string, Point | null>();
    for (let i = 0; i < actors.length; i++) {
      const actor = actors[i]!;
      chunkOf[i] = chunkKeyFor(actor.x, actor.y);
      indexOf.set(actor.id, i);
      setColumn(bodies, i, actor);
      const was = this.bodiesAtLastCut.get(actor.id);
      if (!was) {
        changedIds.push(actor.id);
        changedIndex.push(i);
        changedWas.push(null);
        before.set(actor.id, null);
        this.bodiesAtLastCut.set(actor.id, { x: actor.x, y: actor.y, z: actor.z, cut });
        continue;
      }
      was.cut = cut;
      if (was.x === actor.x && was.y === actor.y && was.z === actor.z) continue;
      const from = { x: was.x, y: was.y, z: was.z };
      changedIds.push(actor.id);
      changedIndex.push(i);
      changedWas.push(from);
      before.set(actor.id, from);
      was.x = actor.x;
      was.y = actor.y;
      was.z = actor.z;
    }
    // Whoever stood on the board at the last cut and does not now — killed, or
    // gone with the socket that drove them.
    for (const [id, was] of this.bodiesAtLastCut) {
      if (was.cut === cut) continue;
      const from = { x: was.x, y: was.y, z: was.z };
      changedIds.push(id);
      changedIndex.push(-1);
      changedWas.push(from);
      before.set(id, from);
      this.bodiesAtLastCut.delete(id);
    }
    const changedWasColumns = columns(changedIds.length);
    changedWas.forEach((was, c) => setColumn(changedWasColumns, c, was));

    const cellCount = patch.cells.length;
    const cells: TickFrame["cells"] = {
      kind: new Uint8Array(cellCount),
      owner: new Array<string | null>(cellCount).fill(null),
      now: columns(cellCount),
      was: columns(cellCount),
      bodies: new Array<CellBody[] | null>(cellCount).fill(null),
    };
    const bodyIn = (id: string): CellBody => {
      const i = indexOf.get(id);
      const now = i === undefined ? null : { x: actors[i]!.x, y: actors[i]!.y, z: actors[i]!.z };
      return { id, now, was: before.has(id) ? before.get(id)! : now };
    };
    for (let i = 0; i < cellCount; i++) {
      const scoped = patch.cells[i]!;
      if (scoped.terrain) {
        cells.kind[i] = CELL_TERRAIN;
      } else if (scoped.bodies.length === 1) {
        const body = bodyIn(scoped.bodies[0]!);
        cells.kind[i] = CELL_ONE_BODY;
        cells.owner[i] = body.id;
        setColumn(cells.now, i, body.now);
        setColumn(cells.was, i, body.was);
      } else {
        cells.kind[i] = CELL_BODIES;
        cells.bodies[i] = scoped.bodies.map(bodyIn);
      }
    }

    const eventCount = patch.events.length;
    const events: TickFrame["events"] = {
      kind: new Uint8Array(eventCount),
      chunk: new Array<string | null>(eventCount).fill(null),
      actorId: new Array<string | null>(eventCount).fill(null),
      actor: new Int32Array(eventCount).fill(-1),
    };
    for (let j = 0; j < eventCount; j++) {
      const audience = audienceOf(patch.events[j]!);
      if (audience.kind === "everybody") {
        events.kind[j] = FOR_EVERYBODY;
      } else if (audience.kind === "cell") {
        events.kind[j] = FOR_PLACE;
        events.chunk[j] = chunkKeyFor(audience.x, audience.y);
      } else {
        events.kind[j] = FOR_BODY;
        events.actorId[j] = audience.actorId;
        events.actor[j] = indexOf.get(audience.actorId) ?? -1;
      }
    }

    const actorOf = (entries: ReadonlyArray<{ actorId: string }>) =>
      Int32Array.from(entries, (entry) => indexOf.get(entry.actorId) ?? -1);

    return {
      actors,
      patch,
      chunkOf,
      indexOf,
      grid: new BodyGrid(actors),
      bodies,
      changed: { ids: changedIds, index: Int32Array.from(changedIndex), was: changedWasColumns },
      cells,
      events,
      entryActor: {
        hps: actorOf(patch.hps),
        carriedLights: actorOf(patch.carriedLights),
        statusIds: actorOf(patch.statusIds),
        pvp: actorOf(patch.pvp),
        extractions: actorOf(patch.extractions),
        castings: actorOf(patch.castings),
      },
      json: {
        cells: new Fragments(patch.cells.map((scoped) => scoped.cell)),
        events: new Fragments(patch.events),
        hps: new Fragments(patch.hps),
        carriedLights: new Fragments(patch.carriedLights),
        statusIds: new Fragments(patch.statusIds),
        pvp: new Fragments(patch.pvp),
        extractions: new Fragments(patch.extractions),
        castings: new Fragments(patch.castings),
      },
    };
  }

  /**
   * One client's share of the tick, and the record of what it now holds.
   *
   * Returns null when this client takes the whole of the patch, which is how
   * {@link broadcastPatch} tells that it may reuse the shared serialization.
   *
   * **The bodies are scoped as well as the cells, and that is the half with the
   * teeth.** Scoping cells alone reads as the cautious version and is the
   * broken one: a creature walking out of a client's subscription has its tile
   * patched out of the last cell that client holds, which on the far side is
   * indistinguishable from dying, so the client drops it — and when it walks
   * back in, nothing would ever mention it again. Its tile would be drawn and
   * nothing else: no name, no health bar, no Talk row.
   *
   * So a body coming into reach is announced with the whole of its state, which
   * is a `hello` for one body and closes the same hole a `hello` does. A body
   * going out of reach is announced too — the client cannot be left holding an
   * entry for a body it has no ground for, because locating one costs a sweep
   * of its whole board, every frame, for as long as the entry is there.
   *
   * **What a client holds is worked out from what changed, wherever that is
   * enough.** It used to be worked out from every body in the world on every
   * tick — a reach test per body per client, which is the product of the two
   * populations and was 116ms of a tick at a thousand players. A client that
   * stood still, against a subscription and a set of bodies the last cut left
   * behind, holds what it held except where a body moved, arrived or left
   * ({@link reachSinceLastCut}); anybody else is worked out from the bodies
   * near them ({@link reachFromScratch}). Both answer exactly what the whole
   * walk did. The cells and events are then asked about in the same spirit —
   * {@link mayConcern} and {@link holdsBody} rule out, by distance, what could
   * not be this client's before asking the sets that decide.
   */
  private scopedPatchFor(actorId: string, frame: TickFrame): Cut | null {
    const { actors, patch } = frame;
    // No record means this instance has never handed this socket any ground:
    // an inherited socket after a wake, whose `hello` was sent by an instance
    // that no longer exists. An empty subscription is the honest reading —
    // {@link streamEnteredChunks} hands the ground back over the next few ticks
    // and every body on it is announced as it arrives, which is what the old
    // instance's client is already holding.
    const chunks = this.subscribed.get(actorId) ?? NO_CHUNKS;
    const known = this.announcedActors.get(actorId) ?? NO_ACTORS;
    // Where this client is looking from. A body between a death and a respawn
    // has none, and is told about nobody until it does — it is being shown a
    // death screen.
    const at = this.session?.actorPosition(actorId) ?? null;

    // The last cut, when this one follows on from it: the previous tick's, and
    // leaving behind the very set this client holds now. A `hello` replaces
    // the set, which is what rules out a client whose bodies were decided by
    // something other than a cut.
    const memo = this.lastCut.get(actorId);
    const last =
      memo !== undefined &&
      memo.cut === this.cutCount - 1 &&
      memo.known === known &&
      known !== NO_ACTORS
        ? memo
        : null;
    const stayed =
      last !== null &&
      at !== null &&
      last.at !== null &&
      samePoint(last.at, at) &&
      last.chunks === chunks;
    const { entered, departed, held, before } = stayed
      ? this.reachSinceLastCut(actorId, frame, at, chunks, known as Set<string>)
      : this.reachFromScratch(actorId, frame, at, chunks, known);
    // Where the client stood at the last cut, read before the record moves on
    // to this one: it is what the cells below are asked against. @see mayConcern
    const lastAt = last === null ? undefined : last.at;
    if (memo) {
      memo.cut = this.cutCount;
      memo.at = at;
      memo.chunks = chunks;
      memo.known = held;
    } else {
      this.lastCut.set(actorId, { cut: this.cutCount, at, chunks, known: held });
    }

    const cut: Cut = {
      cells: [],
      events: [],
      names: [],
      hps: [],
      carriedLights: [],
      statusIds: [],
      pvp: [],
      extractions: [],
      castings: [],
    };
    // Whether this client takes every element unchanged, and nothing of its
    // own — in which case the shared string is what it is sent.
    let whole = entered === null && departed === null;

    const { kind, owner, now, was } = frame.cells;
    for (let i = 0; i < patch.cells.length; i++) {
      const cellKind = kind[i]!;
      // Only bodies moved here, and none of them is one this client holds or
      // held — so with them taken out, this is the cell it already has.
      if (
        (cellKind === CELL_ONE_BODY && owner[i] !== actorId && !mayHold(now, was, i, at, lastAt)) ||
        (cellKind === CELL_BODIES && !this.mayConcern(frame.cells.bodies[i]!, actorId, at, lastAt))
      ) {
        whole = false;
        continue;
      }
      const scoped = patch.cells[i]!;
      const mine = cellInScope(scoped, chunks, held, before);
      if (mine === scoped.cell) {
        cut.cells.push(i);
        continue;
      }
      whole = false;
      if (mine) cut.cells.push(mine);
    }

    const events = frame.events;
    for (let j = 0; j < patch.events.length; j++) {
      const audience = events.kind[j]!;
      const reaches =
        audience === FOR_EVERYBODY ||
        (audience === FOR_PLACE
          ? chunks.has(events.chunk[j]!)
          : holdsBody(frame, events.actorId[j]!, events.actor[j]!, actorId, at, held));
      if (reaches) cut.events.push(j);
      else whole = false;
    }

    for (const list of ENTRY_LISTS) {
      const entries = patch[list];
      const actorIndex = frame.entryActor[list];
      const mine = cut[list] as number[];
      for (let k = 0; k < entries.length; k++) {
        if (holdsBody(frame, entries[k]!.actorId, actorIndex[k]!, actorId, at, held)) {
          mine.push(k);
        } else {
          whole = false;
        }
      }
    }

    if (whole) return null;
    // Nobody came or went, so there is nothing of its own to add: the cut is
    // the elements it takes, and nearly every client on nearly every tick is
    // this.
    if (entered === null && departed === null) return cut;

    const arrivals = entered === null ? [] : entered.map((i) => actors[i]!);
    // An arrival brings its cell with it, and that is not the same fact as the
    // announcement beside it. While a body was out of reach this client heard
    // nothing about the cells it was standing in, and nothing re-hands that
    // ground — it never left the subscription. So a creature that wandered off
    // and came back was drawn where it used to be, facing the way it used to
    // face, for as long as it stood still. @see `../app/net/scope`
    cut.cells.push(...this.cellsOfChangedReach(arrivals, departed ?? [], held));
    // Arrivals first and departures last, and both orderings are load-bearing.
    // A `spawned` after the `walkStarted` of the body it announces is ignored
    // — the client already made the entry to write the walk into — and the
    // cell it carries is lost with it, which is the sweep this is all trying
    // to avoid. A `despawned` before an event about the same body would be
    // undone by it.
    cut.events = [
      ...arrivals.map((actor): MotionEvent => ({
        kind: "spawned",
        actorId: actor.id,
        at: {
          x: actor.x,
          y: actor.y,
          z: actor.z,
          stackIndex: actor.stackIndex,
        },
      })),
      ...cut.events,
      ...(departed ?? []).map((id): MotionEvent => ({ kind: "despawned", actorId: id })),
    ];
    // The arrival's state in full, ahead of the diffs: this client has nothing
    // to patch against for a body it has just been told about, exactly as a
    // joiner has nothing to patch a `hello` against. Where the same body is
    // also in the diff below, both readings are taken off this tick's snapshot
    // and say the same thing.
    cut.hps = [...currentHps(arrivals), ...cut.hps];
    // Arrivals only, and there is no diff half to concatenate: a name cannot
    // change, so the only reason to send one is a body this client has not
    // met. @see NamePatch
    cut.names = currentNames(arrivals);
    cut.carriedLights = [...currentCarriedLights(arrivals), ...cut.carriedLights];
    cut.statusIds = [...currentStatusIds(arrivals), ...cut.statusIds];
    cut.pvp = [...currentPvp(arrivals), ...cut.pvp];
    cut.extractions = [...currentExtractions(arrivals), ...cut.extractions];
    cut.castings = [...currentCastings(arrivals), ...cut.castings];
    return cut;
  }

  /**
   * Who a client that stood still holds now, from who it held at the last cut.
   *
   * Nothing about it moved — not where it stands, not its subscription, not
   * the set it was left holding — so the only bodies whose answer can have
   * changed are the ones that did: moved, arrived or left. Each is asked the
   * question the whole walk would have asked it, and the set is edited in
   * place, which is what keeps a set of two hundred bodies from being copied
   * because one of them stepped over the edge.
   *
   * Arrivals come out in snapshot order, as {@link reachFromScratch}'s do.
   * Departures come out in the order the set holds them.
   */
  private reachSinceLastCut(
    actorId: string,
    frame: TickFrame,
    at: Point,
    chunks: ReadonlySet<string>,
    known: Set<string>,
  ): Reach {
    const { actors, chunkOf, bodies } = frame;
    const { ids, index, was } = frame.changed;
    let entered: number[] | null = null;
    let departed: string[] | null = null;
    for (let c = 0; c < ids.length; c++) {
      const id = ids[c]!;
      if (id === actorId) continue;
      const i = index[c]!;
      const isIn =
        i >= 0 &&
        withinBodyReachOf(at.x, at.y, at.z, bodies.x[i]!, bodies.y[i]!, bodies.z[i]!) &&
        chunks.has(chunkOf[i]!);
      // Held at the last cut only if it stood within reach then, which rules
      // out most of the world before the set is asked.
      const wasIn =
        was.has[c] === 1 &&
        withinBodyReachOf(at.x, at.y, at.z, was.x[c]!, was.y[c]!, was.z[c]!) &&
        known.has(id);
      if (isIn === wasIn) continue;
      if (isIn) (entered ??= []).push(i);
      else (departed ??= []).push(id);
    }
    if (departed !== null) for (const id of departed) known.delete(id);
    if (entered !== null) for (const i of entered) known.add(actors[i]!.id);
    return {
      entered,
      departed,
      held: known,
      // The ones it held and has let go of are all the old set adds to the
      // new one, so they are all a cell has to be asked about beside it.
      before: departed === null ? NO_ACTORS : new Set(departed),
    };
  }

  /**
   * Who a client holds now, worked out afresh from the bodies near it.
   *
   * Every body in reach, and their own whether or not the board has one for
   * them — their own body is never something this client is told it has
   * stopped holding. @see actorsInReach
   *
   * The set is rebuilt only if it differs from what they held. Counted first,
   * because on most ticks nobody has come or gone and the set from last time is
   * still exactly right.
   */
  private reachFromScratch(
    actorId: string,
    frame: TickFrame,
    at: Point | null,
    chunks: ReadonlySet<string>,
    known: ReadonlySet<string>,
  ): Reach {
    const { actors, chunkOf } = frame;
    const self = frame.indexOf.get(actorId);
    const inReach: number[] = [];
    if (at !== null) {
      for (const i of frame.grid.near(at)) {
        // Their own is held however far the board has it from where they are
        // looking — which is nowhere, when it is off the board.
        if (i === self) continue;
        // A body announced on ground its client has not been handed is a body
        // that client can only find by searching its whole board. The reach is
        // well inside the subscription by construction (`interest.test.ts`
        // pins it), so this only ever bites while a client is still being
        // handed its ground.
        if (chunks.has(chunkOf[i]!)) inReach.push(i);
      }
    }
    if (self !== undefined) inReach.push(self);

    let entered: number[] | null = null;
    for (const i of inReach) if (!known.has(actors[i]!.id)) (entered ??= []).push(i);
    const heldCount = self !== undefined ? inReach.length : inReach.length + 1;
    // No arrivals means everybody held is already known, so equal sizes means
    // the two are the same set and nobody left.
    if (entered === null && heldCount === known.size && known.has(actorId)) {
      return { entered: null, departed: null, held: known, before: known };
    }

    // Snapshot order, which is the order a body's arrival is announced in.
    entered?.sort((a, b) => a - b);
    inReach.sort((a, b) => a - b);
    const next = new Set<string>();
    for (const i of inReach) next.add(actors[i]!.id);
    next.add(actorId);
    let departed: string[] | null = null;
    for (const id of known) if (!next.has(id)) (departed ??= []).push(id);
    this.announcedActors.set(actorId, next);
    return { entered, departed, held: next, before: known };
  }

  /**
   * Could a cell where only bodies moved be news to this client?
   *
   * It is only if one of those bodies is one it holds or held, and a body can
   * only be either if it stood within reach: now, of where the client stands
   * now, or at the last cut, of where the client stood then. So a cell whose
   * bodies all stand, and stood, further off than that is not news, and it is
   * ruled out without asking the sets — which is nearly every cell of a busy
   * tick, for nearly every client.
   *
   * `lastAt` is where the client stood at the last cut — null if it had no
   * body then — or undefined when the last cut is not one this one follows on
   * from. Then what the client held is not known to have been decided by
   * distance, and the answer is yes: the sets are asked, and they decide.
   */
  private mayConcern(
    bodies: readonly CellBody[],
    actorId: string,
    at: Point | null,
    lastAt: Point | null | undefined,
  ): boolean {
    for (const body of bodies) {
      if (body.id === actorId) return true;
      const now = body.now;
      if (now !== null && at !== null && withinBodyReach(at, now.x, now.y, now.z)) return true;
      if (lastAt === undefined) return true;
      const was = body.was;
      if (was !== null && lastAt !== null && withinBodyReach(lastAt, was.x, was.y, was.z)) {
        return true;
      }
    }
    return false;
  }

  /**
   * The cells of the bodies that came into this client's reach or went out of
   * it, as they stand, carrying only what that client holds.
   *
   * **Neither half falls out of the diff, and that is the whole reason this
   * exists.** A body crosses the boundary because *it* moved or because the
   * client did, and in the second case nothing about its cell changed on that
   * tick — so there is no patch to scope, nothing is sent, and the client is
   * left holding whatever it last heard:
   *
   * - **Coming in**, that is wherever the body was when it left, facing
   *   whichever way it faced. Nothing re-hands that ground, because the chunk
   *   never left the subscription. A creature that wandered off and came back
   *   was drawn where it used to be for as long as it stood still.
   * - **Going out**, that is a body tile in a cell nothing will ever rewrite.
   *   Too far away to draw and solid to `fitsTile`, so it refuses the player a
   *   step into a cell a creature left an hour ago.
   *
   * A body that has gone off the board entirely — killed — has no cell to send
   * here, and needs none: its death *is* a change to the cell it was standing
   * in, so it is in the diff, and `cellsInScope` keeps it for every client that
   * was holding it. @see `../app/net/scope`
   */
  private cellsOfChangedReach(
    arrivals: ActorSnapshot[],
    departed: string[],
    held: ReadonlySet<string>,
  ): CellPatch[] {
    const session = this.session;
    if (!session) return [];
    const map = session.getMap();
    const out: CellPatch[] = [];
    const at = (x: number, y: number, z: number) => {
      out.push(this.cellPatch(x, y, z, visibleStack(getStack(map, x, y, z), held)));
    };
    for (const actor of arrivals) at(actor.x, actor.y, actor.z);
    for (const id of departed) {
      const where = session.actorPosition(id);
      if (where) at(where.x, where.y, where.z);
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
