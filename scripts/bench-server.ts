import { GameSession } from "../app/game/GameSession";
import { TICK_MS } from "../app/game/constants";
import type { ActorSnapshot } from "../app/game/GameSession";
import { changedCellsOnLevel, getStack, parseMap } from "../app/lib/mapData";
import { statusesById } from "../app/lib/status";
import { tilesByIdFromList } from "../app/lib/validation";
import { MAX_LEVEL, MIN_LEVEL, normalizeTileDef, parseCoordKey } from "../app/lib/types";
import type { Coord, MapFile, TileDef } from "../app/lib/types";
import type { CellPatch } from "../app/net/protocol";

const MAP_PATH = "data/map.json";
const TILES_PATH = "data/tiles.json";
const STATUSES_PATH = "data/statuses.json";

const DEFAULT_SECONDS = 30;

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

  const warmupTicks = Math.round(2000 / TICK_MS);
  for (let i = 0; i < warmupTicks; i++) session.tick(TICK_MS);

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
  const tiles: TileDef[] = (JSON.parse(await Bun.file(TILES_PATH).text()) as unknown[]).map((raw) =>
    normalizeTileDef(raw),
  );
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
