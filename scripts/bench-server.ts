import { listResidentBodies } from "../app/game/actors";
import { GameSession } from "../app/game/GameSession";
import { TICK_MS } from "../app/game/constants";
import type { ActorSnapshot } from "../app/game/GameSession";
import { Rng } from "../app/game/rng";
import { changedCellsOnLevel, getStack, parseMap, setStacks } from "../app/lib/mapData";
import type { StackEdit } from "../app/lib/mapData";
import { statusesById } from "../app/lib/status";
import { canPlace, tilesByIdFromList } from "../app/lib/validation";
import { MAX_LEVEL, MIN_LEVEL, normalizeTileDef, parseCoordKey } from "../app/lib/types";
import type { Coord, MapFile, PlacedTile, TileDef } from "../app/lib/types";
import type { CellPatch } from "../app/net/protocol";

const MAP_PATH = "data/map.json";
const TILES_PATH = "data/tiles.json";
const STATUSES_PATH = "data/statuses.json";

const DEFAULT_SECONDS = 30;

const SCALE_SEED = 1;
const SCALE_SPREAD_CELLS = 6;
const SCALE_ATTEMPTS = 40;

const SCENARIOS: Record<string, ReadonlyArray<Coord | null>> = {
  empty: [],
  town: [null],
  mouth: [{ x: 10, y: 20, z: 0 }],
  den1: [{ x: -10, y: 23, z: -1 }],
  den3: [{ x: -10, y: 19, z: -3 }],
  spread: [
    null,
    { x: 10, y: 20, z: 0 },
    { x: -10, y: 23, z: -1 },
    { x: -14, y: 5, z: -2 },
    { x: -10, y: 19, z: -3 },
    { x: -14, y: 72, z: -3 },
  ],
};

function argValue(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const at = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[at]!;
}

function diffCells(prev: MapFile, next: MapFile): CellPatch[] {
  if (prev === next) return [];
  const out: CellPatch[] = [];
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const key of changedCellsOnLevel(prev, next, z)) {
      const { x, y } = parseCoordKey(key);
      out.push({ x, y, z, stack: getStack(next, x, y, z) });
    }
  }
  return out;
}

function tileIdsOf(stack: readonly PlacedTile[]): string {
  return stack.map((placed) => placed.tileId).join(" ");
}

/**
 * A copy goes on a nearby cell of the same level whose stack is exactly the
 * floor the original stands on, so every kind lives on the ground its author
 * put it on rather than in a wall or a pond.
 */
function scaleResidents(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  scale: number,
): { map: MapFile; unplaced: number } {
  if (scale === 1) return { map, unplaced: 0 };
  const rng = new Rng(SCALE_SEED);
  const taken = new Set<string>();
  const edits: StackEdit[] = [];
  let unplaced = 0;
  for (const body of listResidentBodies(map, tilesById)) {
    const def = tilesById[body.placed.tileId]!;
    const floor = tileIdsOf(
      getStack(map, body.x, body.y, body.z).filter((_, index) => index !== body.stackIndex),
    );
    if (!floor) {
      unplaced += scale - 1;
      continue;
    }
    for (let copy = 1; copy < scale; copy++) {
      let placed = false;
      for (let attempt = 0; attempt < SCALE_ATTEMPTS && !placed; attempt++) {
        const x = body.x + rng.int(SCALE_SPREAD_CELLS * 2 + 1) - SCALE_SPREAD_CELLS;
        const y = body.y + rng.int(SCALE_SPREAD_CELLS * 2 + 1) - SCALE_SPREAD_CELLS;
        const cell = `${x},${y},${body.z}`;
        const stack = getStack(map, x, y, body.z);
        if (taken.has(cell) || tileIdsOf(stack) !== floor) continue;
        if (!canPlace(map, x, y, body.z, def, tilesById).ok) continue;
        taken.add(cell);
        edits.push({ x, y, z: body.z, stack: [...stack, { ...body.placed }] });
        placed = true;
      }
      if (!placed) unplaced++;
    }
  }
  return { map: setStacks(map, edits), unplaced };
}

function countMoving(actors: readonly ActorSnapshot[]): number {
  let moving = 0;
  for (const actor of actors) {
    if (actor.walk || actor.fall || actor.slide) moving++;
  }
  return moving;
}

type BrainWork = { rounds: number; awake: number; routes: number; failedRoutes: number };

type Internals = Record<string, unknown> & {
  actors: Map<string, { resident: boolean; brainAttentive: boolean }>;
};

function afterEachCall(owner: Internals, name: string, then: (result: unknown) => void) {
  const original = owner[name];
  if (typeof original !== "function") throw new Error(`GameSession has no ${name} to count`);
  owner[name] = function (this: unknown, ...args: unknown[]) {
    const result = (original as (...a: unknown[]) => unknown).apply(this, args);
    then(result);
    return result;
  };
}

/**
 * Counted through two of the session's private methods, by name, the way
 * `bench:crowd` times its phases, so a rename throws here rather than
 * reporting zeros.
 */
function countBrainWork(session: GameSession): BrainWork {
  const work: BrainWork = { rounds: 0, awake: 0, routes: 0, failedRoutes: 0 };
  const internals = session as unknown as Internals;
  afterEachCall(internals, "planBrainRound", () => {
    work.rounds++;
    for (const actor of internals.actors.values()) {
      if (actor.resident && actor.brainAttentive) work.awake++;
    }
  });
  afterEachCall(internals, "routeStep", (direction) => {
    work.routes++;
    if (direction === null) work.failedRoutes++;
  });
  return work;
}

type Sample = { tickMs: number; wireMs: number; bytes: number; cells: number; moving: number };

type Report = {
  scenario: string;
  players: number;
  residents: number;
  awake: number;
  routesPerTick: number;
  failedRoutesPerTick: number;
  deaths: number;
  tickP50: number;
  tickP95: number;
  tickWorst: number;
  wireP50: number;
  cellsPerTick: number;
  movingPerTick: number;
  kbPerSecond: number;
  worstTickKb: number;
};

/**
 * A `WeakRef`'s target stays alive until the event loop gets control back, and
 * a microtask does not give it back. A loop that never yields keeps alive every
 * chunk and level `mapData` copied, and full collections grow to seconds.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function runScenario(
  name: string,
  positions: ReadonlyArray<Coord | null>,
  map: MapFile,
  tiles: TileDef[],
  statuses: ReturnType<typeof statusesById>,
  seconds: number,
): Promise<Report> {
  const session = new GameSession(map, tiles, { actorIds: [], statuses });
  positions.forEach((at, index) => {
    session.spawn(`bench:${index}`, at ? { at } : {});
  });
  const residents = session.actorSnapshots().length - positions.length;
  const work = countBrainWork(session);

  const warmupTicks = Math.round(2000 / TICK_MS);
  for (let i = 0; i < warmupTicks; i++) {
    session.tick(TICK_MS);
    await yieldToEventLoop();
  }
  Object.assign(work, { rounds: 0, awake: 0, routes: 0, failedRoutes: 0 });

  const ticks = Math.round((seconds * 1000) / TICK_MS);
  const samples: Sample[] = [];
  let deaths = 0;
  let broadcastMap = session.getMap();
  for (let i = 0; i < ticks; i++) {
    positions.forEach((at, index) => {
      const id = `bench:${index}`;
      if (session.actorSnapshots().some((actor) => actor.id === id)) return;
      deaths++;
      session.spawn(id, at ? { at } : {});
    });
    const t0 = performance.now();
    session.tick(TICK_MS);
    const actors = session.actorSnapshots();
    const t1 = performance.now();
    const next = session.getMap();
    const cells = diffCells(broadcastMap, next);
    const payload =
      cells.length > 0
        ? JSON.stringify({
            type: "patch",
            cells,
            events: [],
            hps: [],
            carriedLights: [],
            statusIds: [],
          })
        : "";
    const t2 = performance.now();
    broadcastMap = next;
    await yieldToEventLoop();
    samples.push({
      tickMs: t1 - t0,
      wireMs: t2 - t1,
      bytes: payload.length,
      cells: cells.length,
      moving: countMoving(actors),
    });
  }

  const tickTimes = samples.map((s) => s.tickMs).sort((a, b) => a - b);
  const wireTimes = samples.map((s) => s.wireMs).sort((a, b) => a - b);
  const totalBytes = samples.reduce((sum, s) => sum + s.bytes, 0);
  return {
    scenario: name,
    players: positions.length,
    residents,
    awake: work.rounds > 0 ? work.awake / work.rounds : 0,
    routesPerTick: work.routes / ticks,
    failedRoutesPerTick: work.failedRoutes / ticks,
    deaths,
    tickP50: percentile(tickTimes, 0.5),
    tickP95: percentile(tickTimes, 0.95),
    tickWorst: tickTimes[tickTimes.length - 1] ?? 0,
    wireP50: percentile(wireTimes, 0.5),
    cellsPerTick: samples.reduce((sum, s) => sum + s.cells, 0) / samples.length,
    movingPerTick: samples.reduce((sum, s) => sum + s.moving, 0) / samples.length,
    kbPerSecond: totalBytes / 1024 / seconds,
    worstTickKb: Math.max(...samples.map((s) => s.bytes)) / 1024,
  };
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

async function main() {
  const seconds = Number(argValue("--seconds") ?? DEFAULT_SECONDS);
  const only = argValue("--scenario");
  const chosen = only ? { [only]: SCENARIOS[only] } : SCENARIOS;
  if (only && !SCENARIOS[only]) {
    throw new Error(`no scenario "${only}"; one of ${Object.keys(SCENARIOS).join(", ")}`);
  }

  const scale = Number(argValue("--scale") ?? 1);
  if (!Number.isInteger(scale) || scale < 1) {
    throw new Error(`--scale takes a whole number from 1, not "${argValue("--scale")}"`);
  }

  const tiles: TileDef[] = (JSON.parse(await Bun.file(TILES_PATH).text()) as unknown[]).map((raw) =>
    normalizeTileDef(raw),
  );
  const tilesById = tilesByIdFromList(tiles);
  const scaled = scaleResidents(parseMap(await Bun.file(MAP_PATH).text()), tilesById, scale);
  const map = scaled.map;
  if (scaled.unplaced > 0) {
    console.error(
      `--scale ${scale}: ${scaled.unplaced} copies found no free cell and were left out`,
    );
  }
  const statuses = statusesById(JSON.parse(await Bun.file(STATUSES_PATH).text()) as unknown[]);

  const rows: Report[] = [];
  for (const [name, positions] of Object.entries(chosen)) {
    rows.push(await runScenario(name, positions!, map, tiles, statuses, seconds));
  }

  const header = [
    "scenario",
    "players",
    "residents",
    "awake",
    "deaths",
    "tick p50",
    "tick p95",
    "tick worst",
    "wire p50",
    "cells/tick",
    "moving/tick",
    "routes/tick",
    "failed routes/tick",
    "KB/s",
    "worst tick KB",
  ];
  console.log(`| ${header.join(" | ")} |`);
  console.log(`|${header.map(() => "---").join("|")}|`);
  for (const r of rows) {
    console.log(
      `| ${[
        r.scenario,
        r.players,
        r.residents,
        fmt(r.awake, 0),
        r.deaths,
        `${fmt(r.tickP50, 2)}ms`,
        `${fmt(r.tickP95, 2)}ms`,
        `${fmt(r.tickWorst, 2)}ms`,
        `${fmt(r.wireP50, 2)}ms`,
        fmt(r.cellsPerTick),
        fmt(r.movingPerTick),
        fmt(r.routesPerTick),
        fmt(r.failedRoutesPerTick),
        fmt(r.kbPerSecond),
        fmt(r.worstTickKb),
      ].join(" | ")} |`,
    );
  }
}

await main();
