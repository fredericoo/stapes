import { chunkifyMap, parseMap, serializeMap } from "../app/lib/mapData";
import { reachableCells } from "../app/game/navigation";
import { findPlayers } from "../app/game/player";
import { mulberry32 } from "../app/editor/generator";
import { tilesByIdFromList } from "../app/lib/validation";
import { normalizeTileDef } from "../app/lib/types";
import type { Direction, MapFile, TileDef } from "../app/lib/types";

const MUSHROOMS = {
  seed: 0x5b0e7,

  /** Cave floor per cluster, by whether the cave is under the surface or inside a hill. */
  cellsPerCluster: { underground: 260, hill: 60 },
  clusterSpacing: 8,
  /** A cave this big has at least one cluster however few its share works out to. */
  leastCaveCells: 20,
  /** A cluster is its own cell and up to this many of the four beside it, each a patch of one to three mushrooms. */
  clusterExtra: 1,

  /** How far from a wisp a mushroom grows, which is everywhere inside its flower ring and a cell beyond it. */
  ringReach: 3.5,
  perRing: { min: 3, max: 5 },

  /** The share of mushrooms that are the poisonous blue kind. */
  poisonShare: 0.3,
} as const;

const PATCH = "mushroom-patch";
const POISON_PATCH = "blue-mushroom-patch";
/** Anything a previous run put down, in any state, so a second run refuses rather than doubling up. */
const MUSHROOM_IDS = new Set([
  "mushroom",
  "blue-mushroom",
  PATCH,
  POISON_PATCH,
  `picked-${PATCH}`,
  `picked-${POISON_PATCH}`,
]);
const CAVE_FLOOR = "dirt";
const CAVE_WALLS = new Set([
  "cave-wall",
  "cave-wall-grey",
  "cave-wall-sloped",
  "cave-wall-sloped-grey",
]);
/** How near a cave wall a bare dirt floor has to be to count as cave, which keeps cellars and paths out. */
const WALL_REACH = 2;
const WISPS = new Set(["ember-wisp", "tide-wisp", "moss-wisp"]);
const GRASS = [["grass-2"], ["grass-2", "grass"]].map((ids) => ids.join("+"));

const MAP_PATH = "data/map.json";
const dryRun = process.argv.includes("--dry-run");

type Placed = { tileId: string; direction?: Direction; [field: string]: unknown };
type Flat = { version: number; levels: Record<string, Record<string, Placed[]>> };

const map: Flat = JSON.parse(await Bun.file(MAP_PATH).text());
const tiles: TileDef[] = (JSON.parse(await Bun.file("data/tiles.json").text()) as unknown[]).map(
  (raw) => normalizeTileDef(raw),
);
const tilesById = tilesByIdFromList(tiles);
if (![...MUSHROOM_IDS].every((id) => tilesById[id])) {
  console.error(`grow:mushrooms: a mushroom tile is missing. Run generate:mushrooms first.`);
  process.exit(1);
}
const everyStack = Object.values(map.levels).flatMap((cells) => Object.values(cells));
if (everyStack.some((stack) => stack.some((p) => MUSHROOM_IDS.has(p.tileId)))) {
  console.error(
    "grow:mushrooms: this map already has its mushrooms. Start from a map without them.",
  );
  process.exit(1);
}

const stackAt = (z: number, x: number, y: number): Placed[] =>
  map.levels[String(z)]?.[`${x},${y}`] ?? [];
const idsOf = (stack: readonly Placed[]) => stack.map((p) => p.tileId).join("+");

/** Every cell a player can get to from wherever the map puts one, with the bodies taken off the board. */
function reachable(): Set<string> {
  const toBoard = (flat: Flat): MapFile => parseMap(serializeMap(chunkifyMap(flat as never)));
  const starts = findPlayers(toBoard(map)).map(({ x, y, z }) => ({ x, y, z }));
  const levels: Flat["levels"] = {};
  for (const [z, cells] of Object.entries(map.levels)) {
    const out: Record<string, Placed[]> = {};
    for (const [key, stack] of Object.entries(cells)) {
      const kept = stack.filter((placed) => tilesById[placed.tileId]?.kind !== "battler");
      if (kept.length > 0) out[key] = kept;
    }
    levels[z] = out;
  }
  const board = toBoard({ version: map.version, levels });
  const world = { board, traveller: tilesById["player"]!, tilesById, statusDefs: {} };
  const seen = new Set<string>();
  for (const { x, y, z } of reachableCells(world, starts).values()) seen.add(`${x},${y},${z}`);
  return seen;
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

type Cell = { x: number; y: number; z: number };
const key = (c: Cell) => `${c.x},${c.y},${c.z}`;

console.log("walking the map…");
const walkable = reachable();
const random = mulberry32(MUSHROOMS.seed);
const chosen: Cell[] = [];

/** Cave a body walks through: a dirt floor near a cave wall, whatever stands on it. */
function inCave(c: Cell): boolean {
  if (stackAt(c.z, c.x, c.y)[0]?.tileId !== CAVE_FLOOR || !walkable.has(key(c))) return false;
  for (let dy = -WALL_REACH; dy <= WALL_REACH; dy++) {
    for (let dx = -WALL_REACH; dx <= WALL_REACH; dx++) {
      if (stackAt(c.z, c.x + dx, c.y + dy).some((p) => CAVE_WALLS.has(p.tileId))) return true;
    }
  }
  return false;
}

/** Cave floor with nothing on it, which is the only place a mushroom grows. */
function caveFloor(c: Cell): boolean {
  return idsOf(stackAt(c.z, c.x, c.y)) === CAVE_FLOOR && inCave(c);
}

/**
 * The bare floor of each cave on one level, so every cave gets its own share.
 * Caves are joined through anything standing on the floor, since a ramp or a
 * crystal between two cells does not make them two caves.
 */
function caves(z: number, cells: Record<string, Placed[]>): Cell[][] {
  const floor = new Set<string>();
  for (const k of Object.keys(cells)) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    if (inCave({ x, y, z })) floor.add(k);
  }
  const seen = new Set<string>();
  const out: Cell[][] = [];
  for (const start of floor) {
    if (seen.has(start)) continue;
    seen.add(start);
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      const [x, y] = queue[head]!.split(",").map(Number) as [number, number];
      for (const n of [`${x + 1},${y}`, `${x - 1},${y}`, `${x},${y + 1}`, `${x},${y - 1}`]) {
        if (!floor.has(n) || seen.has(n)) continue;
        seen.add(n);
        queue.push(n);
      }
    }
    out.push(
      queue
        .map((k) => {
          const [x, y] = k.split(",").map(Number) as [number, number];
          return { x, y, z };
        })
        .filter(caveFloor),
    );
  }
  return out;
}

const report: string[] = [];
for (const [zKey, cells] of Object.entries(map.levels)) {
  const z = Number(zKey);
  const per = z < 0 ? MUSHROOMS.cellsPerCluster.underground : MUSHROOMS.cellsPerCluster.hill;
  const pieces = caves(z, cells);
  let clusters = 0;
  for (const floor of pieces) {
    const least = floor.length >= MUSHROOMS.leastCaveCells ? 1 : 0;
    const wanted = Math.max(least, Math.round(floor.length / per));
    const centres: Cell[] = [];
    for (const c of shuffled(floor, random)) {
      if (centres.length >= wanted) break;
      const crowded = centres.some(
        (o) => Math.max(Math.abs(o.x - c.x), Math.abs(o.y - c.y)) < MUSHROOMS.clusterSpacing,
      );
      if (crowded) continue;
      centres.push(c);
      const beside = shuffled(
        [
          { x: c.x + 1, y: c.y, z },
          { x: c.x - 1, y: c.y, z },
          { x: c.x, y: c.y + 1, z },
          { x: c.x, y: c.y - 1, z },
        ].filter(caveFloor),
        random,
      );
      const extra = Math.floor(random() * (MUSHROOMS.clusterExtra + 1));
      chosen.push(c, ...beside.slice(0, extra));
    }
    clusters += centres.length;
  }
  if (pieces.length > 0) {
    report.push(`L${z}: ${clusters} clusters in ${pieces.length} stretches of cave floor`);
  }
}

let rings = 0;
for (const [zKey, cells] of Object.entries(map.levels)) {
  const z = Number(zKey);
  for (const [k, stack] of Object.entries(cells)) {
    if (!stack.some((p) => WISPS.has(p.tileId))) continue;
    const [wx, wy] = k.split(",").map(Number) as [number, number];
    const reach = Math.ceil(MUSHROOMS.ringReach);
    const spots: Cell[] = [];
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const c = { x: wx + dx, y: wy + dy, z };
        if ((dx === 0 && dy === 0) || Math.hypot(dx, dy) > MUSHROOMS.ringReach) continue;
        if (!GRASS.includes(idsOf(stackAt(z, c.x, c.y))) || !walkable.has(key(c))) continue;
        spots.push(c);
      }
    }
    const count =
      MUSHROOMS.perRing.min +
      Math.floor(random() * (MUSHROOMS.perRing.max - MUSHROOMS.perRing.min + 1));
    for (const c of shuffled(spots, random).slice(0, count)) chosen.push(c);
    rings++;
  }
}

/** A stream of its own, so the mix of kinds moves no mushroom. */
const kinds = mulberry32(MUSHROOMS.seed ^ 0xb1e);
let poisonous = 0;
for (const c of chosen) {
  const poison = kinds() < MUSHROOMS.poisonShare;
  if (poison) poisonous++;
  map.levels[String(c.z)]![`${c.x},${c.y}`]!.push({ tileId: poison ? POISON_PATCH : PATCH });
}

for (const line of report) console.log(line);
console.log(`${rings} flower rings`);
console.log(`${chosen.length} patches in all, ${poisonous} of them poisonous`);

if (dryRun) {
  console.log("--dry-run: data/map.json left as it was");
} else {
  await Bun.write(MAP_PATH, serializeMap(chunkifyMap(map as never)));
  console.log(`wrote ${MAP_PATH}`);
}
