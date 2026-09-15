/**
 * PROTOTYPE — does an occlusion-shaped subscription fly?
 *
 * Measures `app/net/visibleSet.ts` against the chunk square it would replace,
 * on the real `data/map.json`, from the same positions `bench-server.ts` uses.
 * Three questions, and they are the three that decide whether this is worth
 * building for real:
 *
 * 1. **What does it cost to compute?** It has to run every time somebody
 *    changes cell, which is five times a second per player. The number to beat
 *    is roughly "not visible against a 3.4ms brain round".
 * 2. **How much less is a client sent?** Both the join and the per-tick
 *    patch — and per-tick is the interesting one, because that is the number
 *    that repeats.
 * 3. **How much does a player actually learn?** How many of the world's bodies
 *    a client can see, against how many it hears about today. That is the whole
 *    reason for doing this, and it is the one the other two are paying for.
 *
 *   bun scripts/bench-occlusion.ts
 *   bun scripts/bench-occlusion.ts --scenario den3
 *   bun scripts/bench-occlusion.ts --seconds 10
 */
import { GameSession } from "../app/game/GameSession";
import { TICK_MS } from "../app/game/constants";
import { hasLineOfSight } from "../app/game/sight";
import {
  changedCellsOnLevel,
  chunkKeyFor,
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
import { interestChunks, mapOfInterest } from "../app/net/interest";
import {
  cellKey3,
  groundFor,
  nearVisible,
  visibleFrom,
} from "../app/net/visibleSet";

const MAP_PATH = "data/map.json";
const TILES_PATH = "data/tiles.json";
const STATUSES_PATH = "data/statuses.json";
const DEFAULT_SECONDS = 20;
/** Lateral reach under test; the whole point is that it is a knob. */
const REACH = Number(process.argv[process.argv.indexOf("--reach") + 1] || 0) || undefined;

/** The same places `bench-server.ts` stands its players. */
const SCENARIOS: Record<string, Coord | null> = {
  town: null,
  mouth: { x: 10, y: 20, z: 0 },
  den1: { x: -10, y: 23, z: -1 },
  den3: { x: -10, y: 19, z: -3 },
};

function argValue(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

/** Exactly `GameServer.diffCells`. */
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

function bytes(cells: CellPatch[]): number {
  return cells.length === 0 ? 0 : JSON.stringify({ type: "patch", cells }).length;
}

type Row = {
  scenario: string;
  /** How long one visible-set computation takes. */
  computeP50: number;
  computeP95: number;
  /** Cells the flood walked, and cells the ray was asked about. */
  flooded: number;
  probed: number;
  fillMs: number;
  floodMs: number;
  rayMs: number;
  /** Cells the client would hold at join, each way. */
  joinChunk: number;
  joinSight: number;
  /** Per-tick patch, each way, in bytes per second. */
  wireChunkKb: number;
  wireSightKb: number;
  /** Bodies in the world, and how many this player can actually see. */
  bodies: number;
  bodiesVisible: number;
};

function runScenario(
  name: string,
  at: Coord | null,
  map: MapFile,
  tiles: TileDef[],
  tilesById: Record<string, TileDef>,
  statuses: ReturnType<typeof statusesById>,
  seconds: number,
): Row {
  const session = new GameSession(map, tiles, { actorIds: [], statuses });
  session.spawn("bench:0", at ? { at } : {});

  for (let i = 0; i < Math.round(2000 / TICK_MS); i++) session.tick(TICK_MS);

  const where = () => {
    const self = session.actorSnapshots().find((a) => a.id === "bench:0");
    return self ? { x: self.x, y: self.y, z: self.z } : (at ?? { x: 0, y: 0, z: 0 });
  };

  // --- what a join costs, each way -----------------------------------------
  const start = where();
  const chunkJoin = mapOfInterest(session.getMap(), interestChunks(start.x, start.y));
  let joinChunk = 0;
  for (const cells of Object.values(chunkJoin.levels)) {
    joinChunk += Object.keys(cells).length;
  }
  const firstSet = visibleFrom(session.getMap(), tilesById, start, REACH);
  const joinSight = groundFor(session.getMap(), tilesById, firstSet.visible).size;

  // --- the per-tick loop ----------------------------------------------------
  const ticks = Math.round((seconds * 1000) / TICK_MS);
  const computeTimes: number[] = [];
  let floodedTotal = 0;
  let probedTotal = 0;
  let fillMsTotal = 0;
  let floodMsTotal = 0;
  let rayMsTotal = 0;
  let chunkBytes = 0;
  let sightBytes = 0;
  let bodiesTotal = 0;
  let bodiesVisibleTotal = 0;
  let broadcastMap = session.getMap();
  let visible = firstSet.visible;
  let lastCell = cellKey3(start.x, start.y, start.z);

  for (let i = 0; i < ticks; i++) {
    if (!session.actorSnapshots().some((a) => a.id === "bench:0")) {
      session.spawn("bench:0", at ? { at } : {});
    }
    session.tick(TICK_MS);
    const next = session.getMap();
    const me = where();

    // Recomputed only when the body changes cell, which is what a real
    // subscription would do — the set is a function of where you are standing.
    const cell = cellKey3(me.x, me.y, me.z);
    if (cell !== lastCell || i === 0) {
      lastCell = cell;
      const t0 = performance.now();
      const set = visibleFrom(next, tilesById, me, REACH);
      computeTimes.push(performance.now() - t0);
      floodedTotal += set.flooded;
      probedTotal += set.probed;
      fillMsTotal += set.fillMs;
      floodMsTotal += set.floodMs;
      rayMsTotal += set.rayMs;
      visible = set.visible;
    }

    const cells = diffCells(broadcastMap, next);
    broadcastMap = next;
    if (cells.length > 0) {
      const chunks = interestChunks(me.x, me.y);
      chunkBytes += bytes(cells.filter((c) => chunks.has(chunkKeyFor(c.x, c.y))));
      sightBytes += bytes(cells.filter((c) => nearVisible(visible, c.x, c.y, c.z)));
    }

    // Bodies: everything with an owner, against what this player could see.
    const actors = session.actorSnapshots().filter((a) => a.id !== "bench:0");
    bodiesTotal += actors.length;
    bodiesVisibleTotal += actors.filter((a) =>
      hasLineOfSight(next, tilesById, me, { x: a.x, y: a.y, z: a.z }),
    ).length;
  }

  const sorted = computeTimes.sort((a, b) => a - b);
  const recomputes = Math.max(1, computeTimes.length);
  return {
    scenario: name,
    computeP50: percentile(sorted, 0.5),
    computeP95: percentile(sorted, 0.95),
    flooded: floodedTotal / recomputes,
    probed: probedTotal / recomputes,
    fillMs: fillMsTotal / recomputes,
    floodMs: floodMsTotal / recomputes,
    rayMs: rayMsTotal / recomputes,
    joinChunk,
    joinSight,
    wireChunkKb: chunkBytes / 1024 / seconds,
    wireSightKb: sightBytes / 1024 / seconds,
    bodies: bodiesTotal / ticks,
    bodiesVisible: bodiesVisibleTotal / ticks,
  };
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

function pct(part: number, whole: number): string {
  return whole === 0 ? "—" : `${((part / whole) * 100).toFixed(0)}%`;
}

async function main() {
  const seconds = Number(argValue("--seconds") ?? DEFAULT_SECONDS);
  const only = argValue("--scenario");
  const chosen = only ? { [only]: SCENARIOS[only] } : SCENARIOS;
  if (only && !(only in SCENARIOS)) {
    throw new Error(`no scenario "${only}"; one of ${Object.keys(SCENARIOS).join(", ")}`);
  }

  const map = parseMap(await Bun.file(MAP_PATH).text());
  const tiles: TileDef[] = (
    JSON.parse(await Bun.file(TILES_PATH).text()) as unknown[]
  ).map((raw) => normalizeTileDef(raw));
  const tilesById = tilesByIdFromList(tiles);
  const statuses = statusesById(
    JSON.parse(await Bun.file(STATUSES_PATH).text()) as unknown[],
  );

  const rows: Row[] = [];
  for (const [name, at] of Object.entries(chosen)) {
    rows.push(runScenario(name, at ?? null, map, tiles, tilesById, statuses, seconds));
  }

  console.log(
    "\nscene   fill+flood+ray    flood/probe      join cells (chunk → sight)     patch KB/s (chunk → sight)   bodies seen",
  );
  console.log("".padEnd(118, "-"));
  for (const r of rows) {
    console.log(
      [
        r.scenario.padEnd(7),
        `${fmt(r.fillMs, 1)}+${fmt(r.floodMs, 1)}+${fmt(r.rayMs, 1)}ms`.padEnd(18),
        `${fmt(r.flooded, 0)}/${fmt(r.probed, 0)}`.padEnd(16),
        `${r.joinChunk} → ${r.joinSight} (${pct(r.joinSight, r.joinChunk)})`.padEnd(31),
        `${fmt(r.wireChunkKb, 2)} → ${fmt(r.wireSightKb, 2)} (${pct(r.wireSightKb, r.wireChunkKb)})`.padEnd(29),
        `${fmt(r.bodiesVisible, 1)}/${fmt(r.bodies, 1)} (${pct(r.bodiesVisible, r.bodies)})`,
      ].join(" "),
    );
  }
  console.log();
}

await main();
