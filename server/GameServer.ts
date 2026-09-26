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
  INTEREST_REACH_CHUNKS,
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
import { NearIndex } from "./nearIndex";
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
import { battlerIssues } from "../app/lib/battler";
import { minutesOfDayAt, wrapMinutes, type MinutesOfDay } from "../app/lib/clock";
import { masteryXpBlockSchema, type MasteryXp } from "../app/lib/mastery";
import {
  changedCellsOnLevel,
  chunkIndexOf,
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
  CLOSE_WORLD_FULL,
  MAX_STEPS_AHEAD,
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

type TickPatch = Omit<Extract<ServerMessage, { type: "patch" }>, "type">;

type SharedPatch = Omit<TickPatch, "cells" | "names"> & { cells: ScopedCell[] };

const [GROUND_ONLY_HEAD, GROUND_ONLY_TAIL] = (() => {
  const empty: Extract<ServerMessage, { type: "patch" }> = {
    type: "patch",
    cells: [],
    events: [],
    hps: [],
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

function cellAfflictionKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

function parseCellAfflictionKey(key: string): { x: number; y: number; z: number } {
  const [x, y, z] = key.split(",").map(Number);
  return { x: x!, y: y!, z: z! };
}

function afflictionReading(entries: readonly CellAffliction[]): string {
  return entries
    .map((one) => `${one.tileId}:${one.defIds.join(",")}`)
    .sort()
    .join("|");
}

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

function wholePatch(patch: SharedPatch): TickPatch {
  return {
    ...patch,
    names: [],
    cells: patch.cells.map((scoped) => scoped.cell),
  };
}

function isEmptyPatch(
  patch: Omit<TickPatch, "cells" | "names"> & { cells: readonly unknown[] },
): boolean {
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

const NO_CHUNKS: ReadonlySet<string> = new Set();
const NO_ACTORS: ReadonlySet<string> = new Set();
const NO_SOCKETS: ReadonlySet<GameSocket> = new Set();

const CHECKPOINT_KEY = "world";

const CHUNK_KEY_PREFIX = "chunk:";

const CHUNKS_STREAMED_PER_TICK = 2;

function boardKey(levelKey: string, chunkKey: string): string {
  return `${CHUNK_KEY_PREFIX}${levelKey}:${chunkKey}`;
}

function parseBoardKey(key: string): { levelKey: string; chunkKey: string } | null {
  if (!key.startsWith(CHUNK_KEY_PREFIX)) return null;
  const rest = key.slice(CHUNK_KEY_PREFIX.length);
  const at = rest.indexOf(":");
  if (at < 0) return null;
  return { levelKey: rest.slice(0, at), chunkKey: rest.slice(at + 1) };
}

const RESPAWN_POINTS_KEY = "respawnPoints";

const RESPAWN_PENDING_KEY = "respawnPending";

const RESPAWN_RETRY_MS = 5_000;

function currentNames(actors: ActorSnapshot[]): NamePatch[] {
  const out: NamePatch[] = [];
  for (const actor of actors) {
    if (actor.name === null) continue;
    out.push({ actorId: actor.id, name: actor.name });
  }
  return out;
}

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

function currentCarriedLights(actors: ActorSnapshot[]): CarriedLightsPatch[] {
  const out: CarriedLightsPatch[] = [];
  for (const actor of actors) {
    if (actor.carriedLights.length === 0) continue;
    out.push({ actorId: actor.id, tileIds: actor.carriedLights });
  }
  return out;
}

function currentStatusIds(actors: ActorSnapshot[]): StatusIdsPatch[] {
  const out: StatusIdsPatch[] = [];
  for (const actor of actors) {
    if (actor.statuses.length === 0) continue;
    out.push({ actorId: actor.id, defIds: statusIdsOf(actor) });
  }
  return out;
}

function statusIdsOf(actor: ActorSnapshot): string[] {
  return actor.statuses.map((status) => status.defId).sort();
}

function currentPvp(actors: ActorSnapshot[]): PvpPatch[] {
  const out: PvpPatch[] = [];
  for (const actor of actors) {
    if (!actor.pvp) continue;
    out.push({ actorId: actor.id, on: true });
  }
  return out;
}

function currentExtractions(actors: ActorSnapshot[]): ExtractionPatch[] {
  const out: ExtractionPatch[] = [];
  for (const actor of actors) {
    if (!actor.extracting) continue;
    out.push({ actorId: actor.id, progress: progressOf(actor.extracting) });
  }
  return out;
}

function actorsInReach(
  session: GameSession,
  at: { x: number; y: number; z: number } | null,
  self: string,
): ActorSnapshot[] {
  if (!at) return session.actorSnapshotsWhere((id) => id === self);
  return session.actorSnapshotsWhere(
    (id, where) =>
      id === self || (withinBodyReach(at, where.x, where.y, where.z) && !session.hiddenOf(id)),
  );
}

function currentCastings(actors: ActorSnapshot[]): CastingPatch[] {
  const out: CastingPatch[] = [];
  for (const actor of actors) {
    if (!actor.casting) continue;
    out.push({ actorId: actor.id, progress: castProgressOf(actor.casting) });
  }
  return out;
}

function progressOf(
  running: NonNullable<ActorSnapshot["extracting"]>,
): NonNullable<ExtractionPatch["progress"]> {
  return {
    remainingMs: running.remainingMs,
    durationMs: running.durationMs,
  };
}

function castProgressOf(casting: CastProgress): CastProgress {
  return {
    remainingMs: casting.remainingMs,
    durationMs: casting.durationMs,
    slot: casting.slot,
    ...(casting.targetId ? { targetId: casting.targetId } : {}),
  };
}

export const CHAT_LOG_MAX_ROWS = 5_000;

const MAX_QUEUED_STEPS = MAX_STEPS_AHEAD;

const MAX_QUEUED_INTENTS = MAX_QUEUED_STEPS * 2;

const POSITION_KEY_PREFIX = "pos:";

const EQUIPMENT_KEY_PREFIX = "equip:";

const TAGS_KEY_PREFIX = "tags:";

const MASTERIES_KEY_PREFIX = "mast:";

const SPAWN_KEY_PREFIX = "spawn:";

const STATUSES_KEY_PREFIX = "status:";

const HP_KEY_PREFIX = "hp:";

const PVP_KEY_PREFIX = "pvp:";

const HIDDEN_KEY_PREFIX = "hidden:";

export const MAX_REMEMBERED_ACTORS = 1_000;

export const MAX_ONLINE_PLAYERS = 250;

const ACTOR_FLUSH_INTERVAL_MS = 30_000;

const TICK_FAILURE_LOG_INTERVAL = 300;

const MAX_TICK_BACKLOG_MS = TICK_MS * 3;

const TICK_POLL_MS = 1;

type SavedPosition = ActorPosition & { savedAt: number };

type SavedEquipment = { equipment: Equipment; savedAt: number };

type SavedTags = { tags: string[]; savedAt: number };

type SavedMasteries = { masteries: MasteryXp; savedAt: number };

type SavedSpawn = ActorPosition & { savedAt: number };

type SavedStatuses = { statuses: StatusInstance[]; savedAt: number };

type SavedHp = { hp: number | null; savedAt: number };

type SavedPvp = { on: boolean; savedAt: number };

type SavedHidden = { on: boolean; savedAt: number };

const savedStatusSchema = v.object({
  defId: v.pipe(v.string(), v.minLength(1)),
  durationMs: v.pipe(v.number(), v.finite(), v.minValue(0)),
  remainingMs: v.pipe(v.number(), v.finite(), v.minValue(0)),
  sinceEffectMs: v.pipe(v.number(), v.finite(), v.minValue(0)),
});

const savedStatusesSchema = v.array(savedStatusSchema);

type Attachment = { actorId: string; admin: boolean };

type WrittenActor = {
  position: ActorPosition | null;
  equipment: Equipment | null;
  tags: readonly string[] | null;
  masteries: MasteryXp | null;
  statuses: readonly StatusInstance[] | null;
  hp: number | null;
  pvp: boolean;
};

function samePosition(a: ActorPosition, b: ActorPosition): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z && a.direction === b.direction;
}

type QueuedStep = {
  seq: number;
  direction: Direction;
  preferDescend: boolean;
};

type QueuedIntent =
  | ({ kind: "step" } & QueuedStep)
  | { kind: "face"; direction: Direction }
  | { kind: "cast"; slot: CastSlot };

type QueuedAction = Exclude<QueuedIntent, { kind: "step" }>;

type Checkpoint = {
  map?: FlatMapFile;
  spawn: { x: number; y: number; z: number; stackIndex: number };
  seed?: number;
  dead?: string[];
};

/**
 * Compared by identity: motion state is mutated in place as it advances, so the
 * same object on two ticks is the same motion and a new object is a new one.
 */
type SentMotion = {
  walk: unknown;
  fall: unknown;
  slide: unknown;
  strike: unknown;
};

type Point = { x: number; y: number; z: number };

function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

type CellBody = { id: string; now: Point | null; was: Point | null };

type Reach = {
  entered: number[] | null;
  departed: string[] | null;
  held: ReadonlySet<string>;
  before: ReadonlySet<string>;
};

type CutMemo = {
  cut: number;
  at: Point | null;
  chunks: ReadonlySet<string>;
  known: ReadonlySet<string>;
};

class Fragments<T> {
  private readonly text: Array<string | undefined>;

  constructor(
    private readonly items: readonly T[],
    private readonly make?: (i: number) => T,
  ) {
    this.text = new Array(items.length);
  }

  at(i: number): string {
    return (this.text[i] ??= JSON.stringify(this.make ? this.make(i) : this.items[i]));
  }
}

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

function concealedFrom(frame: TickFrame, j: number, viewer: string): boolean {
  const { onlyTo, notTo } = frame.events;
  const only = onlyTo[j];
  return (only !== null && only !== viewer) || notTo[j] === viewer;
}

const CELL_TERRAIN = 0;
const CELL_ONE_BODY = 1;
const CELL_BODIES = 2;

const FOR_PLACE = 1;
const FOR_BODY = 2;

type TickFrame = {
  actors: ActorSnapshot[];
  patch: SharedPatch;
  chunkOf: string[];
  indexOf: Map<string, number>;
  grid: BodyGrid;
  bodies: Columns;
  hidden: Uint8Array;
  changed: { ids: string[]; index: Int32Array; was: Columns };
  cells: {
    kind: Uint8Array;
    at: Columns;
    cx: Int32Array;
    cy: Int32Array;
    bodiesHere: Uint8Array;
    anyBody: Uint8Array;
    owner: Array<string | null>;
    now: Columns;
    was: Columns;
    bodies: Array<CellBody[] | null>;
  };
  events: {
    kind: Uint8Array;
    cx: Int32Array;
    cy: Int32Array;
    chunk: Array<string | null>;
    actorId: Array<string | null>;
    actor: Int32Array;
    onlyTo: Array<string | null>;
    notTo: Array<string | null>;
  };
  concealing: boolean;
  entryActor: Record<EntryList, Int32Array>;
  near: {
    cells: NearIndex;
    everywhereCells: Int32Array;
    events: NearIndex;
    everywhereEvents: Int32Array;
    changed: NearIndex;
    cellStamp: Int32Array;
    eventStamp: Int32Array;
    changedStamp: Int32Array;
    mark: number;
  };
  json: {
    cells: Fragments<CellPatch>;
    bare: Fragments<CellPatch>;
    events: Fragments<MotionEvent>;
  } & { [L in EntryList]: Fragments<SharedPatch[L][number]> };
};

const ENTRY_LISTS = [
  "hps",
  "carriedLights",
  "statusIds",
  "pvp",
  "extractions",
  "castings",
] as const satisfies ReadonlyArray<keyof SharedPatch>;

type EntryList = (typeof ENTRY_LISTS)[number];

type Cut = {
  cells: Array<number | CellPatch>;
  events: Array<number | MotionEvent>;
  names: NamePatch[];
} & { [L in EntryList]: Array<number | SharedPatch[L][number]> };

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

function cellsJson(
  parts: ReadonlyArray<number | CellPatch>,
  cells: Fragments<CellPatch>,
  bare: Fragments<CellPatch>,
): string {
  if (parts.length === 0) return "[]";
  let out = "[";
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k]!;
    if (k > 0) out += ",";
    if (typeof part !== "number") out += JSON.stringify(part);
    else out += part >= 0 ? cells.at(part) : bare.at(-part - 1);
  }
  return `${out}]`;
}

function serializeCut(cut: Cut, frame: TickFrame): string {
  const { json } = frame;
  return (
    `{"type":"patch","cells":${cellsJson(cut.cells, json.cells, json.bare)}` +
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

function emptyCut(): Cut {
  return {
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
}

function isEmptyCut(cut: Cut): boolean {
  return (
    cut.cells.length === 0 &&
    cut.events.length === 0 &&
    ENTRY_LISTS.every((list) => cut[list].length === 0)
  );
}

export class GameServer {
  constructor(
    protected readonly ctx: WorldContext,
    protected readonly env: {
      dataStore: DataStore;
      nameOf?: (actorId: string) => Promise<string | null>;
      maxOnlinePlayers?: number;
    },
  ) {}

  private session: GameSession | null = null;
  private clockOffsetMinutes = 0;
  private tiles: TileDef[] = [];
  private statusDefs: Record<string, StatusDef> = {};
  private broadcastMap: MapFile | null = null;
  private sentMotion = new Map<string, SentMotion>();
  private readonly announcedActors = new Map<string, Set<string>>();
  private readonly bodiesAtLastCut = new Map<string, Point & { cut: number; hidden: boolean }>();
  private cutCount = 0;
  private readonly lastCut = new Map<string, CutMemo>();
  private readonly subscriptionsToCheck = new Set<string>();
  private readonly socketsByActor = new Map<string, Set<GameSocket>>();
  private readonly adminSockets = new Set<GameSocket>();
  private seatedSockets: ReadonlyArray<readonly [GameSocket, string]> | null = null;
  private joining: Promise<void> = Promise.resolve();
  private sentHp = new Map<string, { hp: number; maxHp: number; rating: number }>();
  private sentCarriedLights = new Map<string, string>();
  private sentStatusIds = new Map<string, { defIds: string[]; key: string }>();
  private sentPvp = new Map<string, boolean>();
  /**
   * These three are compared by identity: the runtime mutates one object in
   * place for a whole pull, wait or cast and replaces it only when one starts
   * or ends, so comparing the numbers would report a change every tick.
   */
  private sentExtractions = new Map<string, ActorSnapshot["extracting"]>();
  private sentNextBlow = new Map<string, Progress | null>();
  private sentCastings = new Map<string, ActorSnapshot["casting"]>();
  private sentAfflicted = new Map<string, string>();
  private burning = new Map<string, CellAffliction[]>();
  private events: MotionEvent[] = [];
  private readonly queuedIntents = new Map<string, QueuedIntent[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickDueAt = 0;
  private consecutiveTickFailures = 0;
  private loading: Promise<void> | null = null;
  private lastSaidAt = new Map<string, number>();
  private actorsSavedAt = 0;
  private checkpointedMap: MapFile | null = null;
  private writtenActors = new Map<string, WrittenActor>();
  private chatLogReady = false;
  private dead = new Set<string>();
  private pendingDeathWrites = new Map<string, Death>();
  private silenced = new Set<string>();
  private justDied: Death[] = [];
  private readonly spawns = new Map<string, ActorPosition>();
  private readonly subscribed = new Map<string, Set<string>>();
  private readonly subscriptionCentre = new WeakMap<Set<string>, string>();
  private readonly lingering = new Map<string, number>();
  private static readonly MAX_LINGER_MS = 15 * 60_000;
  private respawnPoints = new Map<string, SpawnPoint>();
  private respawnPointsByCell = new Map<string, SpawnPoint[]>();
  private respawnPending = new Map<string, number>();

  private store(): DataStore {
    return this.env.dataStore;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.session) return;
    this.loading ??= this.load();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  private async load() {
    const store = this.store();
    this.tiles = await store.readTiles();
    GameServer.warnUnloadableBattlers(this.tiles);
    this.statusDefs = statusesById(await store.readStatuses());

    const checkpoint = await this.ctx.storage.get<Checkpoint>(CHECKPOINT_KEY);
    const board = checkpoint ? await this.checkpointedBoard(checkpoint) : null;
    this.session = board
      ? new GameSession(board, this.tiles, {
          actorIds: [],
          spawnAt: checkpoint!.spawn,
          seed: checkpoint!.seed,
          statuses: this.statusDefs,
          clock: () => this.minutesOfDay(),
        })
      : new GameSession(await store.readMap(), this.tiles, {
          actorIds: [],
          statuses: this.statusDefs,
          clock: () => this.minutesOfDay(),
        });
    this.dead = new Set(board ? (checkpoint!.dead ?? []) : []);
    this.broadcastMap = this.session.getMap();
    /**
     * Not `this.session.getMap()`: constructing the session changes the board it
     * was given (adopting bodies, consuming the spawn marker, settling plates), so
     * the first flush has to write the whole board.
     */
    this.checkpointedMap = null;
    await this.restoreActors();
    await this.pruneRemembered();
    await this.loadRespawnState(board != null);
  }

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

  private async loadRespawnState(resumed: boolean) {
    const session = this.session;
    if (!session) return;
    const tilesById = tilesByIdFromList(this.tiles);

    const stored = resumed
      ? await this.ctx.storage.get<SpawnPoint[]>(RESPAWN_POINTS_KEY)
      : undefined;
    const points = (stored ?? findSpawnPoints(session.getMap(), tilesById))
      .filter((point) => {
        const def = tilesById[point.placed.tileId];
        return def != null && resolveRespawn(def) != null;
      })
      .map((point) => withMigratedItemIds(session.getMap(), point));
    this.setRespawnPoints(points);
    for (const point of this.respawnPoints.values()) {
      this.forgetDepartedItems(point);
    }
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

  private static warnUnloadableBattlers(tiles: readonly TileDef[]) {
    for (const def of tiles) {
      const issues = battlerIssues(def);
      if (issues.length === 0) continue;
      console.warn(
        `stapes: tile "${def.id}" is kind battler but its block does not parse, so it has no hit points or spells:\n  ${issues.join("\n  ")}`,
      );
    }
  }

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

  private scheduleRespawnAlarm() {
    if (this.respawnPending.size === 0) {
      this.ctx.storage.deleteAlarm().catch(GameServer.reportWriteFailure("respawn alarm clear"));
      return;
    }
    this.ctx.storage
      .setAlarm(Math.min(...this.respawnPending.values()))
      .catch(GameServer.reportWriteFailure("respawn alarm set"));
  }

  private armRespawn(point: SpawnPoint, nowMs: number) {
    if (this.respawnPending.has(point.key)) return;
    this.respawnPending.set(point.key, nowMs + rollRespawnDelayMs(point.respawn));
    this.persistRespawnPending();
    this.scheduleRespawnAlarm();
  }

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
      this.dead.delete(key);
      if (this.adoptSpawnedItem(point, outcome.itemId)) pointsDirty = true;
    }
    if (pointsDirty) this.persistRespawnPoints();
    this.collectTransitionEvents(session);
    if (dirty) {
      this.persistRespawnPending();
      this.scheduleRespawnAlarm();
    }
  }

  private adoptSpawnedItem(point: SpawnPoint, itemId: string | undefined) {
    const map = this.session?.getMap();
    if (!itemId || !map) return false;
    point.itemIds = [...presentItemIds(map, point), itemId];
    return true;
  }

  private sweepRespawnCells(cells: ScopedCell[]) {
    const session = this.session;
    if (!session || this.respawnPointsByCell.size === 0) return;
    const nowMs = Date.now();
    let pointsDirty = false;
    for (const { cell } of cells) {
      const points = this.respawnPointsByCell.get(cellKey(cell));
      if (!points) continue;
      for (const point of points) {
        if (this.forgetDepartedItems(point)) pointsDirty = true;
        if (this.respawnPending.has(point.key)) continue;
        if (isSpawnFilled(session.getMap(), point)) continue;
        this.armRespawn(point, nowMs);
      }
    }
    if (pointsDirty) this.persistRespawnPoints();
  }

  private forgetDepartedItems(point: SpawnPoint): boolean {
    const map = this.session?.getMap();
    if (!map || !point.itemIds) return false;
    const present = presentItemIds(map, point);
    /** `present` is a subset of `itemIds`, so equal lengths mean equal sets. */
    if (present.length === point.itemIds.length) return false;
    point.itemIds = present;
    return true;
  }

  async alarm() {
    await this.ensureLoaded();
    this.processDueRespawns(Date.now());
    this.wake();
  }

  private async restoreActors() {
    const live: string[] = [];
    for (const [, actorId] of this.seated()) live.push(actorId);
    this.session?.reapAbsentActors(live);
    for (const id of live) {
      if (this.dead.has(id)) {
        this.silenced.add(id);
        continue;
      }
      await this.seatActor(id);
    }
  }

  private async restoredActor(actorId: string) {
    const [at, carrying, tagged, earned, statuses, hp, pvp, hidden] = await Promise.all([
      this.lastPositionOf(actorId),
      this.lastEquipmentOf(actorId),
      this.lastTagsOf(actorId),
      this.lastMasteriesOf(actorId),
      this.lastStatusesOf(actorId),
      this.lastHpOf(actorId),
      this.lastPvpOf(actorId),
      this.lastHiddenOf(actorId),
    ]);
    return { at, carrying, tagged, earned, statuses, hp, pvp, hidden };
  }

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

  private async lastPvpOf(actorId: string): Promise<boolean | undefined> {
    const saved = await this.ctx.storage.get<SavedPvp>(this.pvpKey(actorId));
    return saved?.on;
  }

  private hiddenKey(actorId: string): string {
    return `${HIDDEN_KEY_PREFIX}${actorId}`;
  }

  private async lastHiddenOf(actorId: string): Promise<boolean> {
    if (!this.seatedAsAdmin(actorId)) return false;
    const saved = await this.ctx.storage.get<SavedHidden>(this.hiddenKey(actorId));
    return saved?.on === true;
  }

  private seatedAsAdmin(actorId: string): boolean {
    for (const ws of this.socketsOf(actorId)) {
      if ((ws.deserializeAttachment() as Attachment | null)?.admin) return true;
    }
    return false;
  }

  private setHidden(actorId: string, enabled: boolean) {
    const session = this.session!;
    if (session.hiddenOf(actorId) !== enabled && session.setHidden(enabled, actorId)) {
      this.ctx.storage
        .put(this.hiddenKey(actorId), { on: enabled, savedAt: Date.now() } satisfies SavedHidden)
        .catch(GameServer.reportWriteFailure("hidden write"));
      this.events.push({ kind: enabled ? "left" : "joined", actorId });
      this.tellAdminsPlayerCount({});
      this.wake();
    }
    this.sendToEverySocketOf(actorId, { type: "hidden", on: session.hiddenOf(actorId) });
  }

  private masteriesKey(actorId: string): string {
    return `${MASTERIES_KEY_PREFIX}${actorId}`;
  }

  private async lastMasteriesOf(actorId: string): Promise<MasteryXp | undefined> {
    const saved = await this.ctx.storage.get<SavedMasteries>(this.masteriesKey(actorId));
    if (!saved?.masteries) return undefined;
    const parsed = v.safeParse(masteryXpBlockSchema, saved.masteries);
    return parsed.success ? parsed.output : undefined;
  }

  private async lastStatusesOf(actorId: string): Promise<StatusInstance[] | undefined> {
    const saved = await this.ctx.storage.get<SavedStatuses>(this.statusesKey(actorId));
    if (!saved?.statuses) return undefined;
    const parsed = v.safeParse(savedStatusesSchema, saved.statuses);
    return parsed.success ? parsed.output : undefined;
  }

  private async lastHpOf(actorId: string): Promise<number | undefined> {
    const saved = await this.ctx.storage.get<SavedHp>(this.hpKey(actorId));
    if (saved?.hp == null || !Number.isFinite(saved.hp) || saved.hp < 1) {
      return undefined;
    }
    return Math.floor(saved.hp);
  }

  private async lastTagsOf(actorId: string): Promise<string[] | undefined> {
    const saved = await this.ctx.storage.get<SavedTags>(this.tagsKey(actorId));
    return saved?.tags;
  }

  private async lastEquipmentOf(actorId: string): Promise<Equipment | undefined> {
    const saved = await this.ctx.storage.get<SavedEquipment>(this.equipmentKey(actorId));
    if (!saved?.equipment) return undefined;
    return restoredEquipment(saved.equipment, tilesByIdFromList(this.tiles));
  }

  private async lastPositionOf(actorId: string): Promise<ActorPosition | undefined> {
    const saved = await this.ctx.storage.get<SavedPosition>(this.positionKey(actorId));
    if (!saved) return undefined;
    return { x: saved.x, y: saved.y, z: saved.z, direction: saved.direction };
  }

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

      if (!session.isResident(actorId)) {
        if (!written?.position || !samePosition(written.position, at)) {
          entries[this.positionKey(actorId)] = { ...at, savedAt };
        }
      }
      if (equipment && !session.isResident(actorId) && equipment !== written?.equipment) {
        entries[this.equipmentKey(actorId)] = { equipment, savedAt };
      }
      if (tags && tags.length > 0 && tags !== written?.tags) {
        entries[this.tagsKey(actorId)] = { tags: [...tags], savedAt };
      }
      if (masteries && masteries !== written?.masteries) {
        entries[this.masteriesKey(actorId)] = {
          masteries: { ...masteries },
          savedAt,
        };
      }
      if (!session.isResident(actorId)) {
        const lastStatuses = written?.statuses ?? null;
        const bothEmpty = (statuses?.length ?? 0) === 0 && (lastStatuses?.length ?? 0) === 0;
        if (!bothEmpty && statuses !== lastStatuses) {
          entries[this.statusesKey(actorId)] = {
            statuses: (statuses ?? []).map((status) => ({ ...status })),
            savedAt,
          };
        }
        if (hp !== (written?.hp ?? null)) {
          entries[this.hpKey(actorId)] = { hp, savedAt };
        }
        if (pvp !== (written?.pvp ?? false)) {
          entries[this.pvpKey(actorId)] = { on: pvp, savedAt };
        }
      }

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

    for (const [actorId, death] of this.pendingDeathWrites) {
      const spawn = this.spawns.get(actorId);
      if (spawn) entries[this.positionKey(actorId)] = { ...spawn, savedAt };
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
      entries[this.hpKey(actorId)] = { hp: null, savedAt };
      entries[this.statusesKey(actorId)] = { statuses: [], savedAt };
    }
    this.pendingDeathWrites.clear();

    const map = session.getMap();
    if (map !== this.checkpointedMap) {
      entries[CHECKPOINT_KEY] = {
        spawn: session.getSpawnPoint(),
        seed: session.getSeed(),
        dead: [...this.dead],
      };
      for (const chunk of changedChunks(this.checkpointedMap, map)) {
        entries[boardKey(chunk.levelKey, chunk.chunkKey)] = chunk.cells;
      }
      this.checkpointedMap = map;
    }

    if (Object.keys(entries).length === 0) return;

    this.ctx.storage
      .put(entries, { allowUnconfirmed: true })
      .catch(GameServer.reportWriteFailure("checkpoint write"));
  }

  private saveActorsIfDue() {
    const session = this.session;
    if (!session) return;
    const now = Date.now();
    if (now - this.actorsSavedAt < ACTOR_FLUSH_INTERVAL_MS) return;
    this.actorsSavedAt = now;
    this.saveActors(session.actorIds());
  }

  private async pruneRemembered() {
    await this.pruneOldest(POSITION_KEY_PREFIX);
    await this.pruneOldest(EQUIPMENT_KEY_PREFIX);
    await this.pruneOldest(TAGS_KEY_PREFIX);
    await this.pruneOldest(STATUSES_KEY_PREFIX);
    await this.pruneOldest(HP_KEY_PREFIX);
    await this.pruneOldest(MASTERIES_KEY_PREFIX);
    await this.pruneOldest(SPAWN_KEY_PREFIX);
  }

  private async pruneOldest(prefix: string) {
    const stored = await this.ctx.storage.list<{ savedAt: number }>({ prefix });
    if (stored.size <= MAX_REMEMBERED_ACTORS) return;

    const oldestFirst = [...stored].sort(([, a], [, b]) => a.savedAt - b.savedAt);
    const doomed = oldestFirst.slice(0, stored.size - MAX_REMEMBERED_ACTORS).map(([key]) => key);
    await this.ctx.storage.delete(doomed);
  }

  async join(socket: GameSocket, actorId: string, { admin }: { admin: boolean }): Promise<void> {
    const done = await this.joinTurn();
    try {
      if (socket.closed) return;
      if (!admin && !this.hasRoomFor(actorId)) {
        socket.close(CLOSE_WORLD_FULL, "world full");
        return;
      }
      await this.seatJoiner(socket, actorId, { admin });
    } finally {
      done();
    }
  }

  private async joinTurn(): Promise<() => void> {
    const ahead = this.joining;
    let done!: () => void;
    this.joining = new Promise<void>((resolve) => (done = resolve));
    await ahead;
    /**
     * A macrotask, not a microtask: a join does ~20ms of work without yielding,
     * and only a `setTimeout` lets the tick loop and socket reads run between
     * two joins.
     */
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return done;
  }

  private async seatJoiner(
    socket: GameSocket,
    actorId: string,
    { admin }: { admin: boolean },
  ): Promise<void> {
    this.displaceSockets(actorId);
    this.ctx.acceptWebSocket(socket);
    this.seat(socket, { actorId, admin });

    /**
     * Seated before loading, because loading reaps every checkpointed body with
     * no seated socket and would put this player back at spawn.
     */
    await this.ensureLoaded();

    await this.seatActor(actorId);
    if (!this.session!.hiddenOf(actorId)) this.events.push({ kind: "joined", actorId });

    this.sendHello(socket, actorId);
    this.tellAdminsPlayerCount({ told: socket });
    this.wake();
  }

  private seated(): ReadonlyArray<readonly [GameSocket, string]> {
    if (this.seatedSockets) return this.seatedSockets;
    const out: Array<readonly [GameSocket, string]> = [];
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment) out.push([ws, attachment.actorId]);
    }
    return (this.seatedSockets = out);
  }

  private socketsOf(actorId: string): ReadonlySet<GameSocket> {
    return this.socketsByActor.get(actorId) ?? NO_SOCKETS;
  }

  private seat(ws: GameSocket, attachment: Attachment) {
    ws.serializeAttachment(attachment satisfies Attachment);
    let sockets = this.socketsByActor.get(attachment.actorId);
    if (!sockets) this.socketsByActor.set(attachment.actorId, (sockets = new Set()));
    sockets.add(ws);
    if (attachment.admin) this.adminSockets.add(ws);
    this.seatedSockets = null;
  }

  private unseat(ws: GameSocket) {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) return;
    const sockets = this.socketsByActor.get(attachment.actorId);
    this.adminSockets.delete(ws);
    if (!sockets?.delete(ws)) return;
    if (sockets.size === 0) this.socketsByActor.delete(attachment.actorId);
    this.seatedSockets = null;
  }

  private hasRoomFor(actorId: string): boolean {
    const limit = this.env.maxOnlinePlayers ?? MAX_ONLINE_PLAYERS;
    return this.socketsByActor.has(actorId) || this.socketsByActor.size < limit;
  }

  private displaceSockets(actorId: string) {
    for (const ws of [...this.socketsOf(actorId)]) {
      this.unseat(ws);
      ws.serializeAttachment(null);
      ws.close(CLOSE_REPLACED, "replaced");
    }
  }

  private playerCount(excluding?: GameSocket): number {
    let count = 0;
    for (const [actorId, sockets] of this.socketsByActor) {
      if (excluding && sockets.size === 1 && sockets.has(excluding)) continue;
      if (this.session?.hiddenOf(actorId)) continue;
      count++;
    }
    return count;
  }

  private tellAdminsPlayerCount({ closing, told }: { closing?: GameSocket; told?: GameSocket }) {
    const payload = JSON.stringify({
      type: "players",
      playerCount: this.playerCount(closing),
    } satisfies ServerMessage);
    for (const ws of this.adminSockets) {
      if (ws === closing || ws === told) continue;
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (!attachment || this.silenced.has(attachment.actorId)) continue;
      try {
        ws.send(payload);
      } catch {}
    }
  }

  private sendHello(ws: GameSocket, actorId: string) {
    const session = this.session!;
    const attachment = ws.deserializeAttachment() as Attachment | null;
    const chunks = this.subscriptionFor(actorId);
    const actors = actorsInReach(session, session.actorPosition(actorId), actorId);
    const held = new Set(actors.map((actor) => actor.id));
    this.announcedActors.set(actorId, held);
    const rest: Omit<Extract<ServerMessage, { type: "hello" }>, "type" | "selfId" | "map"> = {
      actorIds: actors.map((actor) => actor.id),
      hps: currentHps(actors),
      names: currentNames(actors),
      carriedLights: currentCarriedLights(actors),
      statusIds: currentStatusIds(actors),
      pvp: currentPvp(actors),
      extractions: currentExtractions(actors),
      castings: currentCastings(actors),
      afflicted: session.afflictedPlacements().filter((one) => covers(chunks, one.x, one.y)),
      equipment: session.equipmentOf(actorId) ?? emptyEquipment(),
      tags: [...(session.tagsOf(actorId) ?? [])],
      spawnAt: this.spawnCellOf(actorId),
      extracting: session.extractionOf(actorId),
      nextBlow: this.rememberNextBlow(actorId),
      masteryXp: { ...session.masteryXpOf(actorId) },
      statuses: session.statusPatchesOf(actorId) ?? [],
      ...(attachment?.admin ? { playerCount: this.playerCount() } : {}),
      minutesOfDay: this.minutesOfDay(),
    };
    const map = mapOfInterestJson(session.getMap(), chunks, held);
    ws.send(
      `{"type":"hello","selfId":${JSON.stringify(actorId)},"map":${map},${JSON.stringify(rest).slice(1)}`,
    );
    if (session.hiddenOf(actorId)) {
      ws.send(JSON.stringify({ type: "hidden", on: true } satisfies ServerMessage));
    }
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

    if (message.type === "rebirth") {
      await this.rebirth(actorId);
      return;
    }

    if (!session.hasActor(actorId)) return;

    if (message.type === "say") {
      this.say(actorId, message.text);
      this.wake();
      return;
    }

    if (message.type === "step" || message.type === "face") {
      if (message.type === "step") this.queueStep(actorId, message);
      else this.queueAction(actorId, { kind: "face", direction: message.direction });
      this.wake();
      return;
    }

    if (message.type === "target") {
      session.setTarget(message.actorId, actorId);
    } else if (message.type === "cast") {
      this.queueAction(actorId, { kind: "cast", slot: message.slot });
    } else if (message.type === "cancelCast") {
      session.cancelCast(actorId);
    } else if (message.type === "pvp") {
      session.setPvp(message.enabled, actorId);
      this.saveActors([actorId], true);
    } else if (message.type === "hidden") {
      if (admin) this.setHidden(actorId, message.enabled);
    } else if (message.type === "attackMode") {
      session.setAttackMode(message.enabled, actorId);
    } else if (message.type === "pickUp") {
      session.pickUp(message.ref, actorId);
    } else if (message.type === "equip") {
      session.equip(message.ref, actorId);
    } else if (message.type === "moveItem") {
      session.moveItem(message.from, message.to, actorId);
    } else if (message.type === "consume") {
      session.consume(message.from, actorId);
    } else if (message.type === "talk") {
      session.talk(message.action, actorId);
    } else if (message.type === "craft") {
      session.craft(message.ref, message.recipe, actorId);
    } else if (message.type === "command") {
      if (admin) session.runCommand(message.text, actorId);
      else session.refuseCommand(actorId);
    } else if (message.type === "drop") {
      session.drop(message.from, message.to, actorId);
    } else {
      session.interact(message.ref, actorId);
    }

    this.flushEquipment();
    this.flushSounds();
    this.flushBlows();
    this.flushTags();
    this.flushConversations();
    this.flushExtracting();
    this.flushSpawnMarks();
    this.flushNextBlow();
    this.flushNotices();
    this.flushClock();
    this.flushMasteries();
    this.flushStatuses();
    this.wake();
  }

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

  private flushBlows() {
    const session = this.session;
    if (!session) return;
    this.collectDamageEvents(session);
    this.collectProjectileEvents(session);
    this.collectTransitionEvents(session);
  }

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

  private flushEquipment() {
    this.flushPerActor(
      (session) => session.drainEquipmentChanges(),
      (session, actorId) => {
        const equipment = session.equipmentOf(actorId);
        if (!equipment) return null;
        return {
          type: "equipment",
          equipment,
          spellCooldowns: session.spellCooldownsOf(actorId) ?? {},
        };
      },
    );
  }

  private flushExtracting() {
    this.flushPerActor(
      (session) => session.drainExtractionChanges(),
      (session, actorId) => ({
        type: "extracting",
        extracting: session.extractionOf(actorId),
      }),
    );
  }

  private rememberNextBlow(actorId: string): Progress | null {
    const now = this.session?.nextBlowOf(actorId) ?? null;
    this.sentNextBlow.set(actorId, now);
    return now;
  }

  private flushNextBlow() {
    const session = this.session;
    if (!session) return;
    const live = new Set<string>();
    for (const [ws, actorId] of this.seated()) {
      live.add(actorId);
      const now = session.nextBlowOf(actorId);
      if (this.sentNextBlow.has(actorId) && this.sentNextBlow.get(actorId) === now) {
        continue;
      }
      this.sentNextBlow.set(actorId, now);
      ws.send(
        JSON.stringify({
          type: "nextBlow",
          nextBlow: now ? { ...now } : null,
        } satisfies ServerMessage),
      );
    }
    for (const id of this.sentNextBlow.keys()) {
      if (!live.has(id)) this.sentNextBlow.delete(id);
    }
  }

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

  private flushConversations() {
    this.flushPerActor(
      (session) => session.drainConversationChanges(),
      (session, actorId) => ({
        type: "conversation",
        conversation: session.conversationOf(actorId),
      }),
    );
  }

  private flushNotices() {
    const session = this.session;
    if (!session) return;

    for (const [ws, actorId] of this.seated()) {
      for (const text of session.drainNotices(actorId)) {
        ws.send(JSON.stringify({ type: "notice", text } satisfies ServerMessage));
      }
    }
  }

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
      this.sendTo(actorId, { type: "spawnPoint", at: { ...at } });
    }
  }

  private spawnCellOf(actorId: string): { x: number; y: number; z: number } | null {
    const spawn = this.spawns.get(actorId);
    return spawn ? { x: spawn.x, y: spawn.y, z: spawn.z } : null;
  }

  private minutesOfDay(): MinutesOfDay {
    return wrapMinutes(minutesOfDayAt(Date.now()) + this.clockOffsetMinutes);
  }

  private flushClock() {
    const minutes = this.session?.drainClockSet();
    if (minutes === null || minutes === undefined) return;
    this.clockOffsetMinutes = minutes - minutesOfDayAt(Date.now());
    this.broadcast({ type: "clock", minutesOfDay: minutes });
  }

  private flushMasteries() {
    this.flushPerActor(
      (session) => session.drainMasteryChanges(),
      (session, actorId) => {
        const masteryXp = session.masteryXpOf(actorId);
        if (!masteryXp) return null;
        return { type: "masteries", masteryXp: { ...masteryXp } };
      },
    );
  }

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

  private queueStep(actorId: string, step: QueuedStep) {
    const queue = this.queuedIntents.get(actorId) ?? [];
    const waiting = queue.filter((intent) => intent.kind === "step").length;
    if (waiting >= MAX_QUEUED_STEPS || queue.length >= MAX_QUEUED_INTENTS) {
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

  private applyQueuedSteps() {
    const session = this.session;
    if (!session) return;

    for (const [actorId, queue] of this.queuedIntents) {
      /**
       * The owner can have died since queueing, and `noteDeaths`, which clears
       * the queue, runs after this in `tick`.
       */
      if (!session.hasActor(actorId)) {
        this.queuedIntents.delete(actorId);
        continue;
      }

      this.drainIntents(session, actorId, queue);
      if (queue.length === 0) this.queuedIntents.delete(actorId);
    }
  }

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
      if (outcome === "later") return;

      queue.shift();
      if (outcome === "refused") this.rejectStep(actorId, intent.seq);
    }
  }

  private rejectStep(actorId: string, seq: number) {
    this.sendTo(actorId, { type: "stepRejected", seq });
  }

  private sendTo(actorId: string, message: ServerMessage) {
    const payload = JSON.stringify(message);
    for (const ws of this.socketsOf(actorId)) {
      try {
        ws.send(payload);
      } catch {}
      return;
    }
  }

  private sendToEverySocketOf(actorId: string, message: ServerMessage) {
    const payload = JSON.stringify(message);
    for (const ws of this.socketsOf(actorId)) {
      try {
        ws.send(payload);
      } catch {}
    }
  }

  private say(actorId: string, raw: string) {
    const now = Date.now();
    const last = this.lastSaidAt.get(actorId);
    if (last !== undefined && now - last < CHAT_MIN_INTERVAL_MS) return;

    const text = sanitizeChatText(raw);
    if (!text) return;

    const actors = this.session!.actorSnapshots();
    const author = actors.find((actor) => actor.id === actorId);
    if (!author) return;

    this.lastSaidAt.set(actorId, now);
    if (author.hidden) {
      const said = {
        actorId,
        tileId: author.tileId,
        name: author.name,
        text,
        x: author.x,
        y: author.y,
        z: author.z,
        stackIndex: author.stackIndex,
      };
      this.sendToEverySocketOf(actorId, { type: "chat", ...said });
      this.logChat(now, actorId, said, text);
      return;
    }
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

  private broadcastSpeech(session: GameSession, actors: ActorSnapshot[]) {
    for (const bubble of session.drainSpeech()) {
      this.broadcastChat(actors, bubble);
    }
  }

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

  private broadcastChat(
    actors: ActorSnapshot[],
    at: {
      actorId: string;
      tileId: string;
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

  private sendToNearby(
    at: { x: number; y: number; z: number },
    actors: ActorSnapshot[],
    message: ServerMessage,
  ) {
    const whereById = new Map(actors.map((actor) => [actor.id, actor]));
    const payload = JSON.stringify(message);
    for (const [ws, actorId] of this.seated()) {
      const viewer = whereById.get(actorId);
      if (!viewer || viewer.z !== at.z) continue;
      if (!withinBodyReach(viewer, at.x, at.y, at.z)) continue;
      try {
        ws.send(payload);
      } catch {}
    }
  }

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
    this.unseat(ws);
    await this.ensureLoaded();

    if (this.hasSocket(attachment.actorId, ws)) return;

    this.forgetConnection(attachment.actorId);

    if (this.session?.inCombat(attachment.actorId)) {
      this.saveActors([attachment.actorId], true);
      this.session.standIdle(attachment.actorId);
      this.lingering.set(attachment.actorId, Date.now() + GameServer.MAX_LINGER_MS);
      this.wake();
      return;
    }

    this.leaveWorld(attachment.actorId, ws);
  }

  private forgetConnection(actorId: string) {
    this.subscribed.delete(actorId);
    this.announcedActors.delete(actorId);
    this.lastCut.delete(actorId);
    this.subscriptionsToCheck.delete(actorId);
    this.queuedIntents.delete(actorId);
    this.lastSaidAt.delete(actorId);
    this.silenced.delete(actorId);
  }

  private leaveWorld(actorId: string, closing?: GameSocket) {
    this.saveActors([actorId], true);
    const wasHidden = this.session?.hiddenOf(actorId) ?? false;
    this.session?.despawn(actorId);
    if (this.session) this.collectTransitionEvents(this.session);
    this.writtenActors.delete(actorId);
    this.sentMotion.delete(actorId);
    if (!wasHidden) this.events.push({ kind: "left", actorId });
    this.tellAdminsPlayerCount({ closing });
    this.wake();
  }

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

  private presentActorIds(): Set<string> {
    const ids = new Set(this.lingering.keys());
    for (const [, actorId] of this.seated()) ids.add(actorId);
    return ids;
  }

  async replaceWorld(flat: FlatMapFile, options: { keepPositions?: boolean } = {}): Promise<void> {
    const store = this.store();
    const tiles = await store.readTiles();
    const statusDefs = statusesById(await store.readStatuses());

    const map = chunkifyMap(flat);
    const session = new GameSession(map, tiles, {
      actorIds: [],
      statuses: statusDefs,
      clock: () => this.minutesOfDay(),
    });

    await store.writeMap(map);
    await this.ctx.storage.delete(CHECKPOINT_KEY);
    await this.deleteCheckpointedBoard();
    this.checkpointedMap = null;

    const carried = new Map<string, Equipment>();
    const taken = new Map<string, string[]>();
    const learnt = new Map<string, MasteryXp>();
    const running = new Map<string, readonly StatusInstance[]>();
    const health = new Map<string, number>();
    const standing = new Map<string, ActorPosition>();
    const fighting = new Set<string>();
    const present = this.presentActorIds();
    for (const actorId of present) {
      if (options.keepPositions) {
        const position = this.session?.actorPosition(actorId);
        if (position) standing.set(actorId, position);
      }
      const kit = this.session?.equipmentOf(actorId);
      if (kit) carried.set(actorId, kit);
      const tags = this.session?.tagsOf(actorId);
      if (tags?.length) taken.set(actorId, [...tags]);
      const masteries = this.session?.masteryXpOf(actorId);
      if (masteries) learnt.set(actorId, { ...masteries });
      const statuses = this.session?.statusesOf(actorId);
      if (statuses?.length) running.set(actorId, statuses);
      const hp = this.session?.storedHpOf(actorId);
      if (hp !== null && hp !== undefined) health.set(actorId, hp);
      if (this.session?.pvpOf(actorId)) fighting.add(actorId);
    }

    this.tiles = tiles;
    this.session = session;
    this.broadcastMap = this.session.getMap();
    this.setRespawnPoints(findSpawnPoints(session.getMap(), tilesByIdFromList(tiles)));
    this.respawnPending.clear();
    this.persistRespawnPoints();
    this.persistRespawnPending();
    this.scheduleRespawnAlarm();
    this.sentMotion.clear();
    this.announcedActors.clear();
    this.lastCut.clear();
    this.sentAfflicted.clear();
    this.sentHp.clear();
    this.writtenActors.clear();
    this.dead.clear();
    this.silenced.clear();
    this.spawns.clear();
    await this.deleteSavedSpawns();
    this.lastSaidAt.clear();
    this.queuedIntents.clear();
    this.events = [];

    const tilesById = tilesByIdFromList(tiles);
    for (const actorId of present) {
      const kit = carried.get(actorId);
      this.session.spawn(
        actorId,
        {
          name: (await this.env.nameOf?.(actorId)) ?? null,
          at: standing.get(actorId),
          carrying: kit ? restoredEquipment(kit, tilesById) : await this.lastEquipmentOf(actorId),
          tagged: taken.get(actorId) ?? (await this.lastTagsOf(actorId)),
          earned: learnt.get(actorId) ?? (await this.lastMasteriesOf(actorId)),
          statuses: running.get(actorId) ?? (await this.lastStatusesOf(actorId)),
          hp: health.get(actorId) ?? (await this.lastHpOf(actorId)),
          pvp: fighting.has(actorId) || (await this.lastPvpOf(actorId)),
          hidden: await this.lastHiddenOf(actorId),
        },
        { announce: false },
      );
    }
    for (const [ws, actorId] of this.seated()) this.sendHello(ws, actorId);
    this.wake();
  }

  async reloadContent(): Promise<void> {
    if (this.loading) await this.ensureLoaded();

    const session = this.session;
    if (!session) return;

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.saveActors(session.actorIds(), true);

    this.session = null;
    this.loading = null;
    await this.ensureLoaded();

    for (const [ws, actorId] of this.seated()) this.sendHello(ws, actorId);
    this.wake();
  }

  async resetWorld(): Promise<void> {
    /**
     * The tick and the session are dropped before the first await, so no flush
     * can write the live session back between the wipe and the reload.
     */
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.session = null;
    this.loading = null;

    this.ctx.storage.sql.exec("DROP TABLE IF EXISTS chat");
    this.chatLogReady = false;
    await this.ctx.storage.deleteAlarm();

    await this.ctx.storage.deleteAll();

    this.sentMotion.clear();
    this.announcedActors.clear();
    this.lastCut.clear();
    this.sentAfflicted.clear();
    this.sentHp.clear();
    this.sentCarriedLights.clear();
    this.sentStatusIds.clear();
    this.sentPvp.clear();
    this.queuedIntents.clear();
    this.lastSaidAt.clear();
    this.lingering.clear();
    this.events = [];
    this.justDied = [];
    this.writtenActors.clear();
    this.actorsSavedAt = 0;

    await this.ensureLoaded();
    for (const [ws, actorId] of this.seated()) this.sendHello(ws, actorId);
    this.wake();
  }

  private wake() {
    if (this.timer !== null) return;
    this.tickDueAt = performance.now() + TICK_MS;
    this.timer = setInterval(() => this.tickIfDue(), TICK_POLL_MS);
  }

  /**
   * Polled every `TICK_POLL_MS` against a timeline instead of `setInterval(…,
   * TICK_MS)`, because Bun's interval never makes up lost time and every long
   * tick would slow the world for good. A per-tick `setTimeout` measured slower
   * under load. If the tick replaced `this.timer`, the timeline is not this one's.
   */
  private tickIfDue() {
    if (performance.now() < this.tickDueAt) return;
    const timer = this.timer;
    this.tickSafely();
    if (this.timer !== timer) return;
    this.tickDueAt += TICK_MS;
    const now = performance.now();
    if (now - this.tickDueAt > MAX_TICK_BACKLOG_MS) this.tickDueAt = now;
  }

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

  private sleepIfIdle() {
    const session = this.session;
    if (!session || !session.isAtRest()) return;
    if (this.queuedIntents.size > 0) return;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.saveActors(session.actorIds(), true);
  }

  private tick() {
    const session = this.session;
    if (!session) return;

    session.tick(TICK_MS);
    this.applyQueuedSteps();
    this.processDueRespawns(Date.now());

    const actors = session.actorSnapshots();
    this.collectMotionEvents(actors);
    this.collectDamageEvents(session);
    this.collectProjectileEvents(session);
    this.collectTransitionEvents(session);
    this.collectTeleportEvents(session);
    this.collectSwingEvents(session);
    /**
     * In this order: `noteDeaths` reads `spawns`, which `flushSpawnMarks`
     * updates, and `releaseLingerers` must not drop a lingering body before
     * `noteDeaths` has recorded its death.
     */
    this.flushSpawnMarks();
    this.noteDeaths(session);
    this.releaseLingerers();
    this.broadcastSpeech(session, actors);
    this.broadcastNoise(session, actors);

    this.burning = afflictionsByCell(session.afflictedPlacements());
    const cells = this.diffCells(session.getMap());
    this.sweepRespawnCells(cells);
    const hps = this.diffHps(actors);
    const carriedLights = this.diffCarriedLights(actors);
    const statusIds = this.diffStatusIds(actors);
    const pvp = this.diffPvp(actors);
    const extractions = this.diffExtractions(actors);
    const castings = this.diffCastings(actors);
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
    /**
     * The shared baseline advances whatever each client was sent. A cell left out
     * of one client's patch reaches it when its chunk comes into reach and is
     * handed over whole, and that handover runs after the patch.
     */
    this.broadcastMap = session.getMap();
    this.events = [];

    this.streamEnteredChunks(moved);

    this.announceDeaths();

    this.flushEquipment();
    this.flushTags();
    this.flushConversations();
    this.flushExtracting();
    this.flushNextBlow();
    this.flushNotices();
    this.flushMasteries();
    this.flushStatuses();
    this.saveActorsIfDue();
    this.sleepIfIdle();
  }

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

  private noteDeaths(session: GameSession) {
    for (const death of session.drainDeaths()) {
      const actorId = death.id;
      this.dead.add(actorId);
      this.sentMotion.delete(actorId);
      this.sentHp.delete(actorId);
      this.queuedIntents.delete(actorId);
      this.writtenActors.delete(actorId);
      const point = this.respawnPoints.get(actorId);
      if (point) this.armRespawn(point, Date.now());

      const connected = this.hasSocket(actorId);
      if (!connected && !this.lingering.has(actorId)) continue;
      this.pendingDeathWrites.set(actorId, death);
      if (connected) this.justDied.push(death);
    }
    if (this.pendingDeathWrites.size > 0) {
      this.saveActors(session.actorIds(), false, "kits");
    }
  }

  private announceDeaths() {
    if (this.justDied.length === 0) return;
    for (const death of this.justDied) {
      this.sendTo(death.id, { type: "died", equipment: death.equipment });
      this.silenced.add(death.id);
    }
    this.justDied = [];
  }

  private async seatActor(actorId: string) {
    this.dead.delete(actorId);
    this.silenced.delete(actorId);
    await this.rememberSpawn(actorId);
    const spawn = this.spawns.get(actorId);
    this.session!.spawn(actorId, {
      name: (await this.env.nameOf?.(actorId)) ?? null,
      ...(await this.restoredActor(actorId)),
      ...(spawn ? { spawnAt: { x: spawn.x, y: spawn.y, z: spawn.z } } : {}),
    });
    this.collectTransitionEvents(this.session!);
  }

  private async rebirth(actorId: string) {
    if (!this.dead.has(actorId)) return;
    await this.seatActor(actorId);
    for (const ws of this.socketsOf(actorId)) this.sendHello(ws, actorId);
    this.wake();
  }

  private hasSocket(actorId: string, excluding?: GameSocket): boolean {
    for (const ws of this.socketsOf(actorId)) {
      if (ws !== excluding) return true;
    }
    return false;
  }

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

  private collectProjectileEvents(session: GameSession) {
    for (const flight of session.drainProjectiles()) {
      this.events.push({
        kind: "projectileFired",
        id: flight.id,
        tileId: flight.tileId,
        from: flight.from,
        to: flight.to,
        ...(flight.targetId ? { targetId: flight.targetId } : {}),
        hit: flight.hit,
      });
    }
  }

  private collectTransitionEvents(session: GameSession) {
    for (const note of session.drainTransitions()) {
      this.events.push({ kind: "tileTransition", ...note });
    }
  }

  private collectTeleportEvents(session: GameSession) {
    for (const actorId of session.drainTeleports()) {
      this.events.push({ kind: "teleported", actorId });
    }
  }

  private collectSwingEvents(session: GameSession) {
    for (const actorId of session.drainSwings()) {
      this.events.push({ kind: "swung", actorId });
    }
  }

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

  private diffHps(actors: ActorSnapshot[]): HpPatch[] {
    return this.diffPerActor(
      actors,
      this.sentHp,
      (actor) =>
        actor.hp === null || actor.maxHp === null
          ? undefined
          : { hp: actor.hp, maxHp: actor.maxHp, rating: actor.rating ?? 0 },
      (was, now) => was?.hp === now.hp && was.rating === now.rating,
      (actor, now) => ({
        actorId: actor.id,
        hp: now.hp,
        maxHp: now.maxHp,
        rating: now.rating,
      }),
    );
  }

  private diffCarriedLights(actors: ActorSnapshot[]): CarriedLightsPatch[] {
    return this.diffPerActor(
      actors,
      this.sentCarriedLights,
      (actor) => actor.carriedLights.join(","),
      (was, now) => (was ?? "") === now,
      (actor) => ({ actorId: actor.id, tileIds: actor.carriedLights }),
    );
  }

  private diffStatusIds(actors: ActorSnapshot[]): StatusIdsPatch[] {
    return this.diffPerActor(
      actors,
      this.sentStatusIds,
      (actor) => {
        const defIds = statusIdsOf(actor);
        return { defIds, key: defIds.join(",") };
      },
      (was, now) => (was?.key ?? "") === now.key,
      (actor, now) => ({ actorId: actor.id, defIds: now.defIds }),
    );
  }

  private diffPvp(actors: ActorSnapshot[]): PvpPatch[] {
    return this.diffPerActor(
      actors,
      this.sentPvp,
      (actor) => actor.pvp,
      (was, now) => (was ?? false) === now,
      (actor, now) => ({ actorId: actor.id, on: now }),
    );
  }

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

  private diffCells(next: MapFile): ScopedCell[] {
    const prev = this.broadcastMap;
    const burned = this.afflictionChanges();
    if (!prev) return [];

    const out: ScopedCell[] = [];
    if (prev !== next) {
      for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
        for (const key of changedCellsOnLevel(prev, next, z)) {
          const { x, y } = parseCoordKey(key);
          const before = getStack(prev, x, y, z);
          const stack = getStack(next, x, y, z);
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

  private cellPatch(x: number, y: number, z: number, stack: PlacedTile[]): CellPatch {
    const afflicted = this.burning.get(cellAfflictionKey(x, y, z));
    return afflicted ? { x, y, z, stack, afflicted } : { x, y, z, stack };
  }

  private subscriptionFor(actorId: string): Set<string> {
    const at = this.session?.actorPosition(actorId);
    const held = this.subscribed.get(actorId);
    if (!at) return held ?? interestChunks(0, 0);
    const chunks = interestChunks(at.x, at.y);
    this.subscribed.set(actorId, chunks);
    this.subscriptionCentre.set(chunks, chunkKeyFor(at.x, at.y));
    return chunks;
  }

  private streamEnteredChunks(moved: readonly string[]) {
    const session = this.session;
    if (!session) return;
    const map = session.getMap();
    let burningChunks: Set<string> | null = null;
    for (const id of moved) if (this.socketsByActor.has(id)) this.subscriptionsToCheck.add(id);
    for (const actorId of this.subscriptionsToCheck) {
      const before = this.subscribed.get(actorId);
      const at = this.socketsByActor.has(actorId) ? session.actorPosition(actorId) : null;
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
      const reached = new Set<string>();
      for (const chunk of before ?? []) if (now.has(chunk)) reached.add(chunk);
      for (const chunk of take) reached.add(chunk);
      this.subscribed.set(actorId, reached);
      if (sameChunks(reached, now)) {
        this.subscriptionCentre.set(reached, centre);
        this.subscriptionsToCheck.delete(actorId);
      }

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
      for (const ws of this.socketsOf(actorId)) {
        try {
          ws.send(payload);
        } catch {}
      }
    }
  }

  private burningChunks(): Set<string> {
    const out = new Set<string>();
    for (const key of this.burning.keys()) {
      const { x, y, z } = parseCellAfflictionKey(key);
      out.add(`${z}:${chunkKeyFor(x, y)}`);
    }
    return out;
  }

  private broadcastPatch(actors: ActorSnapshot[], patch: SharedPatch): readonly string[] {
    const frame = this.frameFor(actors, patch);
    let shared: string | null = null;
    const payloads = new Map<string, string | null>();
    for (const [ws, actorId] of this.seated()) {
      if (this.silenced.has(actorId)) continue;

      let payload = payloads.get(actorId);
      if (payload === undefined) {
        const mine = this.scopedPatchFor(actorId, frame);
        if (mine === null) {
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
      if (payload === null) continue;
      try {
        ws.send(payload);
      } catch {}
    }
    return frame.changed.ids;
  }

  private frameFor(actors: ActorSnapshot[], patch: SharedPatch): TickFrame {
    const cut = ++this.cutCount;
    const chunkOf = new Array<string>(actors.length);
    const indexOf = new Map<string, number>();
    const bodies = columns(actors.length);
    const hidden = new Uint8Array(actors.length);
    let anyHidden = false;
    let concealed: Set<string> | null = null;
    const changedIds: string[] = [];
    const changedIndex: number[] = [];
    const changedWas: Array<Point | null> = [];
    const before = new Map<string, Point | null>();
    for (let i = 0; i < actors.length; i++) {
      const actor = actors[i]!;
      chunkOf[i] = chunkKeyFor(actor.x, actor.y);
      indexOf.set(actor.id, i);
      setColumn(bodies, i, actor);
      const was = this.bodiesAtLastCut.get(actor.id);
      if (actor.hidden) {
        hidden[i] = 1;
        anyHidden = true;
      }
      if (actor.hidden || was?.hidden) (concealed ??= new Set()).add(actor.id);
      if (!was) {
        changedIds.push(actor.id);
        changedIndex.push(i);
        changedWas.push(null);
        before.set(actor.id, null);
        this.bodiesAtLastCut.set(actor.id, {
          x: actor.x,
          y: actor.y,
          z: actor.z,
          cut,
          hidden: actor.hidden,
        });
        continue;
      }
      was.cut = cut;
      const moved = was.x !== actor.x || was.y !== actor.y || was.z !== actor.z;
      if (!moved && was.hidden === actor.hidden) continue;
      const from = { x: was.x, y: was.y, z: was.z };
      changedIds.push(actor.id);
      changedIndex.push(i);
      changedWas.push(was.hidden ? null : from);
      if (moved) before.set(actor.id, from);
      was.x = actor.x;
      was.y = actor.y;
      was.z = actor.z;
      was.hidden = actor.hidden;
    }
    for (const [id, was] of this.bodiesAtLastCut) {
      if (was.cut === cut) continue;
      if (was.hidden) (concealed ??= new Set()).add(id);
      const from = { x: was.x, y: was.y, z: was.z };
      changedIds.push(id);
      changedIndex.push(-1);
      changedWas.push(was.hidden ? null : from);
      before.set(id, from);
      this.bodiesAtLastCut.delete(id);
    }
    const changedWasColumns = columns(changedIds.length);
    changedWas.forEach((was, c) => setColumn(changedWasColumns, c, was));

    const cellCount = patch.cells.length;
    const cells: TickFrame["cells"] = {
      kind: new Uint8Array(cellCount),
      at: columns(cellCount),
      cx: new Int32Array(cellCount),
      cy: new Int32Array(cellCount),
      bodiesHere: new Uint8Array(cellCount),
      anyBody: new Uint8Array(cellCount),
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
      const { x, y, z, stack } = scoped.cell;
      setColumn(cells.at, i, scoped.cell);
      cells.cx[i] = chunkIndexOf(x);
      cells.cy[i] = chunkIndexOf(y);
      let here = 1;
      for (const placed of stack) {
        if (!placed.owner) continue;
        cells.anyBody[i] = 1;
        const k = indexOf.get(placed.owner);
        const body = k === undefined ? undefined : actors[k]!;
        if (!body || body.x !== x || body.y !== y || body.z !== z) here = 0;
      }
      if (concealed !== null && here === 1) {
        for (const placed of stack) if (placed.owner && concealed.has(placed.owner)) here = 0;
        for (const id of scoped.bodies) if (concealed.has(id)) here = 0;
      }
      cells.bodiesHere[i] = here;
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
      cx: new Int32Array(eventCount),
      cy: new Int32Array(eventCount),
      chunk: new Array<string | null>(eventCount).fill(null),
      actorId: new Array<string | null>(eventCount).fill(null),
      actor: new Int32Array(eventCount).fill(-1),
      onlyTo: new Array<string | null>(eventCount).fill(null),
      notTo: new Array<string | null>(eventCount).fill(null),
    };
    let concealing = false;
    for (let j = 0; j < eventCount; j++) {
      const audience = audienceOf(patch.events[j]!);
      if (audience.kind === "cell") {
        events.kind[j] = FOR_PLACE;
        events.chunk[j] = chunkKeyFor(audience.x, audience.y);
        events.cx[j] = chunkIndexOf(audience.x);
        events.cy[j] = chunkIndexOf(audience.y);
      } else {
        events.kind[j] = FOR_BODY;
        events.actorId[j] = audience.actorId;
        events.actor[j] = indexOf.get(audience.actorId) ?? -1;
      }
      if (!anyHidden) continue;
      const event = patch.events[j]!;
      if (event.kind === "damage") {
        const k = indexOf.get(event.targetId);
        if (k !== undefined && hidden[k] === 1) {
          events.onlyTo[j] = event.targetId;
          concealing = true;
        }
      } else if (event.kind === "left" || event.kind === "joined") {
        events.notTo[j] = event.actorId;
        concealing = true;
      }
    }

    const actorOf = (entries: ReadonlyArray<{ actorId: string }>) =>
      Int32Array.from(entries, (entry) => indexOf.get(entry.actorId) ?? -1);

    const nearCells = new NearIndex();
    const everywhereCells: number[] = [];
    for (let i = 0; i < cellCount; i++) {
      const cellKind = cells.kind[i]!;
      if (cellKind === CELL_TERRAIN) {
        everywhereCells.push(i);
      } else if (cellKind === CELL_ONE_BODY) {
        if (cells.now.has[i] === 1) {
          nearCells.add(cells.now.x[i]!, cells.now.y[i]!, cells.now.z[i]!, i);
        }
        if (cells.was.has[i] === 1) {
          nearCells.add(cells.was.x[i]!, cells.was.y[i]!, cells.was.z[i]!, i);
        }
      } else {
        for (const body of cells.bodies[i]!) {
          if (body.now !== null) nearCells.add(body.now.x, body.now.y, body.now.z, i);
          if (body.was !== null) nearCells.add(body.was.x, body.was.y, body.was.z, i);
        }
      }
    }
    const nearEvents = new NearIndex();
    const everywhereEvents: number[] = [];
    for (let j = 0; j < eventCount; j++) {
      const k = events.actor[j]!;
      if (events.kind[j] === FOR_BODY && k >= 0) {
        nearEvents.add(bodies.x[k]!, bodies.y[k]!, bodies.z[k]!, j);
      } else {
        everywhereEvents.push(j);
      }
    }
    const nearChanged = new NearIndex();
    for (let c = 0; c < changedIds.length; c++) {
      const i = changedIndex[c]!;
      if (i >= 0) nearChanged.add(bodies.x[i]!, bodies.y[i]!, bodies.z[i]!, c);
      if (changedWasColumns.has[c] === 1) {
        nearChanged.add(
          changedWasColumns.x[c]!,
          changedWasColumns.y[c]!,
          changedWasColumns.z[c]!,
          c,
        );
      }
    }

    return {
      actors,
      patch,
      chunkOf,
      indexOf,
      grid: new BodyGrid(actors),
      bodies,
      hidden,
      changed: { ids: changedIds, index: Int32Array.from(changedIndex), was: changedWasColumns },
      cells,
      events,
      concealing,
      entryActor: {
        hps: actorOf(patch.hps),
        carriedLights: actorOf(patch.carriedLights),
        statusIds: actorOf(patch.statusIds),
        pvp: actorOf(patch.pvp),
        extractions: actorOf(patch.extractions),
        castings: actorOf(patch.castings),
      },
      near: {
        cells: nearCells.seal(),
        everywhereCells: Int32Array.from(everywhereCells),
        events: nearEvents.seal(),
        everywhereEvents: Int32Array.from(everywhereEvents),
        changed: nearChanged.seal(),
        cellStamp: new Int32Array(cellCount),
        eventStamp: new Int32Array(eventCount),
        changedStamp: new Int32Array(changedIds.length),
        mark: 0,
      },
      json: {
        cells: new Fragments(patch.cells.map((scoped) => scoped.cell)),
        bare: new Fragments(
          patch.cells.map((scoped) => scoped.cell),
          (i) => {
            const cell = patch.cells[i]!.cell;
            return { ...cell, stack: visibleStack(cell.stack, NO_ACTORS) };
          },
        ),
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

  private scopedPatchFor(actorId: string, frame: TickFrame): Cut | null {
    const { patch } = frame;
    const chunks = this.subscribed.get(actorId) ?? NO_CHUNKS;
    const known = this.announcedActors.get(actorId) ?? NO_ACTORS;
    const at = this.session?.actorPosition(actorId) ?? null;

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
    const self = stayed ? frame.indexOf.get(actorId) : undefined;
    const square =
      self !== undefined &&
      frame.bodies.x[self] === at!.x &&
      frame.bodies.y[self] === at!.y &&
      frame.bodies.z[self] === at!.z
        ? this.squareOf(chunks, at!)
        : null;
    const mark = square !== null ? ++frame.near.mark : 0;
    const { entered, departed, held, before } = stayed
      ? this.reachSinceLastCut(actorId, frame, at, chunks, known as Set<string>, mark)
      : this.reachFromScratch(actorId, frame, at, chunks, known);
    const lastAt = last === null ? undefined : last.at;
    if (memo) {
      memo.cut = this.cutCount;
      memo.at = at;
      memo.chunks = chunks;
      memo.known = held;
    } else {
      this.lastCut.set(actorId, { cut: this.cutCount, at, chunks, known: held });
    }

    if (square !== null) {
      return this.cutByDistance(
        actorId,
        frame,
        at!,
        square,
        mark,
        { entered, departed, held, before },
        chunks,
      );
    }

    const cut = emptyCut();
    let whole = entered === null && departed === null;

    const { kind, owner, now, was } = frame.cells;
    for (let i = 0; i < patch.cells.length; i++) {
      const cellKind = kind[i]!;
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
        (audience === FOR_PLACE
          ? chunks.has(events.chunk[j]!)
          : holdsBody(frame, events.actorId[j]!, events.actor[j]!, actorId, at, held)) &&
        !(frame.concealing && concealedFrom(frame, j, actorId));
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
    return this.withArrivals(cut, frame, entered, departed, held);
  }

  private withArrivals(
    cut: Cut,
    frame: TickFrame,
    entered: number[] | null,
    departed: string[] | null,
    held: ReadonlySet<string>,
  ): Cut {
    if (entered === null && departed === null) return cut;

    const arrivals = entered === null ? [] : entered.map((i) => frame.actors[i]!);
    cut.cells.push(...this.cellsOfChangedReach(arrivals, departed ?? [], held));
    /**
     * Arrivals first and departures last: a client ignores a `spawned` that
     * follows the same body's `walkStarted`, and an event after a `despawned`
     * undoes it.
     */
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
    cut.hps = [...currentHps(arrivals), ...cut.hps];
    cut.names = currentNames(arrivals);
    cut.carriedLights = [...currentCarriedLights(arrivals), ...cut.carriedLights];
    cut.statusIds = [...currentStatusIds(arrivals), ...cut.statusIds];
    cut.pvp = [...currentPvp(arrivals), ...cut.pvp];
    cut.extractions = [...currentExtractions(arrivals), ...cut.extractions];
    cut.castings = [...currentCastings(arrivals), ...cut.castings];
    return cut;
  }

  private squareOf(chunks: ReadonlySet<string>, at: Point): { cx: number; cy: number } | null {
    if (this.subscriptionCentre.get(chunks as Set<string>) !== chunkKeyFor(at.x, at.y)) {
      return null;
    }
    return { cx: chunkIndexOf(at.x), cy: chunkIndexOf(at.y) };
  }

  private cutByDistance(
    actorId: string,
    frame: TickFrame,
    at: Point,
    square: { cx: number; cy: number },
    mark: number,
    { entered, departed, held, before }: Reach,
    chunks: ReadonlySet<string>,
  ): Cut | null {
    const { patch, cells, events, bodies, hidden, near } = frame;
    const inSquare = (cx: number, cy: number) =>
      Math.abs(cx - square.cx) <= INTEREST_REACH_CHUNKS &&
      Math.abs(cy - square.cy) <= INTEREST_REACH_CHUNKS;
    const holds = (id: string, index: number) =>
      id === actorId ||
      (index >= 0 &&
        hidden[index] === 0 &&
        withinBodyReachOf(at.x, at.y, at.z, bodies.x[index]!, bodies.y[index]!, bodies.z[index]!));

    const cut = emptyCut();
    let whole = entered === null && departed === null;

    const cellStamp = near.cellStamp;
    let cellsNear = near.cells.markWithinReach(at.x, at.y, at.z, cellStamp, mark);
    for (const i of near.everywhereCells) {
      if (cellStamp[i] === mark) continue;
      cellStamp[i] = mark;
      cellsNear++;
    }
    if (cellsNear < patch.cells.length) whole = false;

    for (let i = 0; i < patch.cells.length; i++) {
      if (cellStamp[i] !== mark) continue;
      const cellKind = cells.kind[i]!;
      if (
        (cellKind === CELL_ONE_BODY &&
          cells.owner[i] !== actorId &&
          !mayHold(cells.now, cells.was, i, at, at)) ||
        (cellKind === CELL_BODIES && !this.mayConcern(cells.bodies[i]!, actorId, at, at))
      ) {
        whole = false;
        continue;
      }
      if (cells.bodiesHere[i] === 0) {
        const scoped = patch.cells[i]!;
        const mine = cellInScope(scoped, chunks, held, before);
        if (mine === scoped.cell) {
          cut.cells.push(i);
          continue;
        }
        whole = false;
        if (mine) cut.cells.push(mine);
        continue;
      }
      if (!inSquare(cells.cx[i]!, cells.cy[i]!)) {
        whole = false;
        continue;
      }
      if (
        cells.anyBody[i] === 0 ||
        withinBodyReachOf(at.x, at.y, at.z, cells.at.x[i]!, cells.at.y[i]!, cells.at.z[i]!)
      ) {
        cut.cells.push(i);
      } else {
        whole = false;
        cut.cells.push(-i - 1);
      }
    }

    const eventStamp = near.eventStamp;
    let eventsNear = near.events.markWithinReach(at.x, at.y, at.z, eventStamp, mark);
    for (const j of near.everywhereEvents) {
      if (eventStamp[j] === mark) continue;
      eventStamp[j] = mark;
      eventsNear++;
    }
    if (eventsNear < patch.events.length) whole = false;

    for (let j = 0; j < patch.events.length; j++) {
      if (eventStamp[j] !== mark) continue;
      const audience = events.kind[j]!;
      const reaches =
        (audience === FOR_PLACE
          ? inSquare(events.cx[j]!, events.cy[j]!)
          : holds(events.actorId[j]!, events.actor[j]!)) &&
        !(frame.concealing && concealedFrom(frame, j, actorId));
      if (reaches) cut.events.push(j);
      else whole = false;
    }

    for (const list of ENTRY_LISTS) {
      const entries = patch[list];
      const actorIndex = frame.entryActor[list];
      const mine = cut[list] as number[];
      for (let k = 0; k < entries.length; k++) {
        if (holds(entries[k]!.actorId, actorIndex[k]!)) mine.push(k);
        else whole = false;
      }
    }

    if (whole) return null;
    return this.withArrivals(cut, frame, entered, departed, held);
  }

  private reachSinceLastCut(
    actorId: string,
    frame: TickFrame,
    at: Point,
    chunks: ReadonlySet<string>,
    known: Set<string>,
    mark: number,
  ): Reach {
    const { actors, chunkOf, bodies, hidden } = frame;
    const { ids, index, was } = frame.changed;
    const whole = mark !== 0;
    const stamp = frame.near.changedStamp;
    if (whole) frame.near.changed.markWithinReach(at.x, at.y, at.z, stamp, mark);
    let entered: number[] | null = null;
    let departed: string[] | null = null;
    for (let c = 0; c < ids.length; c++) {
      if (whole && stamp[c] !== mark) continue;
      const id = ids[c]!;
      if (id === actorId) continue;
      const i = index[c]!;
      const isIn =
        i >= 0 &&
        hidden[i] === 0 &&
        withinBodyReachOf(at.x, at.y, at.z, bodies.x[i]!, bodies.y[i]!, bodies.z[i]!) &&
        (whole || chunks.has(chunkOf[i]!));
      const wasIn =
        was.has[c] === 1 &&
        withinBodyReachOf(at.x, at.y, at.z, was.x[c]!, was.y[c]!, was.z[c]!) &&
        (whole || known.has(id));
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
      before: departed === null ? NO_ACTORS : new Set(departed),
    };
  }

  private reachFromScratch(
    actorId: string,
    frame: TickFrame,
    at: Point | null,
    chunks: ReadonlySet<string>,
    known: ReadonlySet<string>,
  ): Reach {
    const { actors, chunkOf, bodies, hidden } = frame;
    const self = frame.indexOf.get(actorId);
    const whole = at !== null && this.squareOf(chunks, at) !== null;
    const inReach: number[] = [];
    if (at !== null) {
      for (const i of frame.grid.near(at)) {
        if (i === self) continue;
        if (hidden[i] === 1) continue;
        if (whole || chunks.has(chunkOf[i]!)) inReach.push(i);
      }
    }
    if (self !== undefined) inReach.push(self);

    let entered: number[] | null = null;
    for (const i of inReach) if (!known.has(actors[i]!.id)) (entered ??= []).push(i);
    const heldCount = self !== undefined ? inReach.length : inReach.length + 1;
    /** With no arrivals every held body is already known, so equal sizes mean nobody left. */
    if (entered === null && heldCount === known.size && known.has(actorId)) {
      return { entered: null, departed: null, held: known, before: known };
    }

    let departed: string[] | null = null;
    for (const id of known) {
      if (id === actorId) continue;
      const i = frame.indexOf.get(id);
      if (
        i !== undefined &&
        at !== null &&
        hidden[i] === 0 &&
        withinBodyReachOf(at.x, at.y, at.z, bodies.x[i]!, bodies.y[i]!, bodies.z[i]!) &&
        (whole || chunks.has(chunkOf[i]!))
      ) {
        continue;
      }
      (departed ??= []).push(id);
    }
    entered?.sort((a, b) => a - b);
    const held = known === NO_ACTORS ? new Set<string>() : (known as Set<string>);
    if (departed !== null) for (const id of departed) held.delete(id);
    if (entered !== null) for (const i of entered) held.add(actors[i]!.id);
    held.add(actorId);
    if (held !== known) this.announcedActors.set(actorId, held);
    return {
      entered,
      departed,
      held,
      before: departed === null ? NO_ACTORS : new Set(departed),
    };
  }

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
    const payload = JSON.stringify(message);
    const anySilenced = this.silenced.size > 0;
    for (const ws of this.ctx.getWebSockets()) {
      if (anySilenced && this.isSilenced(ws)) continue;
      try {
        ws.send(payload);
      } catch {}
    }
  }

  private isSilenced(ws: GameSocket): boolean {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    return attachment ? this.silenced.has(attachment.actorId) : false;
  }
}
