/**
 * How much a tick of the world costs, and how much of the board it moves.
 *
 * Runs the server's simulation headless — no sockets, no database — against
 * whatever `data/map.json` is, with a handful of players standing where the
 * scenario puts them, and reports the two numbers the server's loop is made
 * of: how long `GameSession.tick` takes, and how many bytes the patch it
 * produces would put on every socket. The diff and the serialization mirror
 * `GameServer.tick` (`changedCellsOnLevel` per level, then one
 * `JSON.stringify`), because measuring anything else has already sent one
 * round of this work the wrong way: the checkpoint's chunk diff reads 43x
 * worse than the wire's cell diff and is not what a client is sent.
 *
 *   bun scripts/bench-server.ts                 # every scenario, 30s each
 *   bun scripts/bench-server.ts --scenario den  # one of them
 *   bun scripts/bench-server.ts --seconds 10    # shorter
 *
 * Players stand still. The cost being chased is what the world does *on its
 * own* — creatures deciding and walking — as a function of where people are,
 * and a walking player would mix their own two cells a step into it.
 */
import { GameSession } from "../app/game/GameSession";
import { TICK_MS } from "../app/game/constants";
import type { ActorSnapshot } from "../app/game/GameSession";
import {
  changedCellsOnLevel,
  getStack,
  parseMap,
} from "../app/lib/mapData";
import { statusesById } from "../app/lib/status";
import { tilesByIdFromList } from "../app/lib/validation";
import {
  MAX_LEVEL,
  MIN_LEVEL,
  normalizeTileDef,
  parseCoordKey,
} from "../app/lib/types";
import type { Coord, MapFile, TileDef } from "../app/lib/types";
import type { CellPatch } from "../app/net/protocol";

const MAP_PATH = "data/map.json";
const TILES_PATH = "data/tiles.json";
const STATUSES_PATH = "data/statuses.json";

/** Simulated seconds per scenario unless `--seconds` says otherwise. */
const DEFAULT_SECONDS = 30;

/**
 * Where a player stands in each scenario, as the *authored* cell of a resident
 * near the spot — a creature's cell is a floor with room beside it, so
 * `spawn` lands the player next to it without anybody guessing coordinates.
 * `null` is the map's own spawn point.
 *
 * The den positions are one rat's authored cell on each cave floor and the
 * troll's, read off `data/map.json` when this was written. If the carve is
 * re-run they move; the scenario is still "a player on that floor".
 */
const SCENARIOS: Record<string, ReadonlyArray<Coord | null>> = {
  /** Nobody connected: brains frozen, the world at rest. The floor. */
  empty: [],
  /** One player at the authored spawn, on the surface. */
  town: [null],
  /** One player at the mouth of the den, on the road. */
  mouth: [{ x: 10, y: 20, z: 0 }],
  /** One player on the top cave floor. */
  den1: [{ x: -10, y: 23, z: -1 }],
  /** One player on the bottom cave floor, among the rats and well away from the troll. */
  den3: [{ x: -10, y: 19, z: -3 }],
  /** Six players spread over every floor of the world. */
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

/** Exactly `GameServer.diffCells`, which is the point. */
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

function countMoving(actors: readonly ActorSnapshot[]): number {
  let moving = 0;
  for (const actor of actors) {
    if (actor.walk || actor.fall || actor.slide) moving++;
  }
  return moving;
}

type Sample = { tickMs: number; wireMs: number; bytes: number; cells: number; moving: number };

type Report = {
  scenario: string;
  players: number;
  residents: number;
  /** How many times a rat got the better of a bench player. */
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

function runScenario(
  name: string,
  positions: ReadonlyArray<Coord | null>,
  map: MapFile,
  tiles: TileDef[],
  statuses: ReturnType<typeof statusesById>,
  seconds: number,
): Report {
  const session = new GameSession(map, tiles, { actorIds: [], statuses });
  positions.forEach((at, index) => {
    session.spawn(`bench:${index}`, at ? { at } : {});
  });
  const residents = session.actorSnapshots().length - positions.length;

  // Let the world open — plates settle, residents take their first decision —
  // before anything is counted, the way a real world has been running for a
  // while before anybody measures it.
  const warmupTicks = Math.round(2000 / TICK_MS);
  for (let i = 0; i < warmupTicks; i++) session.tick(TICK_MS);

  const ticks = Math.round((seconds * 1000) / TICK_MS);
  const samples: Sample[] = [];
  let deaths = 0;
  let broadcastMap = session.getMap();
  for (let i = 0; i < ticks; i++) {
    // A player the rats have killed comes straight back where they stood, the
    // way a rebirth would, so the scenario keeps measuring what it says it
    // does rather than a world nobody is watching. Hit points are clamped to
    // the body's maximum on read, so there is no making them unkillable.
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
        ? JSON.stringify({ type: "patch", cells, events: [], hps: [], carriedLights: [], statusIds: [] })
        : "";
    const t2 = performance.now();
    broadcastMap = next;
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

  const map = parseMap(await Bun.file(MAP_PATH).text());
  const tiles: TileDef[] = (JSON.parse(await Bun.file(TILES_PATH).text()) as unknown[]).map(
    (raw) => normalizeTileDef(raw),
  );
  // Resolved for the same reason the server resolves it once per load.
  tilesByIdFromList(tiles);
  const statuses = statusesById(JSON.parse(await Bun.file(STATUSES_PATH).text()) as unknown[]);

  const rows: Report[] = [];
  for (const [name, positions] of Object.entries(chosen)) {
    rows.push(runScenario(name, positions!, map, tiles, statuses, seconds));
  }

  const header = [
    "scenario",
    "players",
    "residents",
    "deaths",
    "tick p50",
    "tick p95",
    "tick worst",
    "wire p50",
    "cells/tick",
    "moving/tick",
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
        r.deaths,
        `${fmt(r.tickP50, 2)}ms`,
        `${fmt(r.tickP95, 2)}ms`,
        `${fmt(r.tickWorst, 2)}ms`,
        `${fmt(r.wireP50, 2)}ms`,
        fmt(r.cellsPerTick),
        fmt(r.movingPerTick),
        fmt(r.kbPerSecond),
        fmt(r.worstTickKb),
      ].join(" | ")} |`,
    );
  }
}

await main();
