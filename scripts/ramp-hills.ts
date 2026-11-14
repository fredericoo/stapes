import { chunkifyMap, parseMap, serializeMap } from "../app/lib/mapData";
import { statusesById } from "../app/lib/status";
import { findStranded } from "../app/verify/stranded";
import { navigationLegs } from "../app/game/navigation";
import { tilesByIdFromList } from "../app/lib/validation";
import { normalizeTileDef } from "../app/lib/types";
import type { StatusDef } from "../app/lib/status";
import type { Coord, Direction, MapFile, TileDef } from "../app/lib/types";

const RAMPS = {
  /** A cell the walk starts from. It has to be one a player can stand in. */
  start: { x: -8, y: 0, z: 0 },

  /** The least open ground on a hilltop worth a ramp, the bar `raise:hills` set. */
  minUsefulCells: 40,
  /** A hilltop this many times `minUsefulCells` gets a second ramp, on another face. */
  cellsPerRamp: 160,
  /** Ramps on one hilltop are kept at least this far apart. */
  rampSpacing: 20,
  /** A hilltop reached by one round's ramps can lead to one above it, so rounds run until none is added. */
  maxRounds: 6,

  /**
   * A shortcut is a ramp up a cliff a player can already get to the top of, laid
   * where the walk round from the foot to the top is at least `shortcutSteps`.
   * Shortcuts are kept `shortcutSpacing` from each other and `rampSpacing` from
   * any ramp already on the map.
   */
  shortcutSteps: 40,
  shortcutSpacing: 25,
} as const;

const RAMP = "ramp";
const FILL = "half-stone";
const WALL = "hill-wall";
const GROUND = new Set(["grass-2", "sand-dunes", "snow"]);
/** What a ramp's head may land on: the hilltops over the caves are topped with `dirt`. */
const HEAD_GROUND = new Set([...GROUND, "dirt"]);
/** The ground each brink is cut from, so the head of a ramp lands on a full block. */
const BRINK_GROUND: Record<string, string> = {
  "grass-brink": "grass-2",
  "sand-brink": "sand-dunes",
  "snow-brink": "snow",
};
/** Small things on a hilltop that a body walks over and a ramp head may replace. */
const COVER = new Set(["grass", "yellow-flowers", "red-flowers"]);
const NOT_GROUND = new Set(["water", "deep-water", "swamp", "mud", "ice", "shore-foam"]);

type Step = { dx: number; dy: number };
const STEP: Record<Direction, Step> = {
  n: { dx: 0, dy: -1 },
  e: { dx: 1, dy: 0 },
  s: { dx: 0, dy: 1 },
  w: { dx: -1, dy: 0 },
};
/** South and east first: those are the faces the projection shows, so a ramp there can be seen. */
const OUTWARD: Direction[] = ["s", "e", "w", "n"];

const MAP_PATH = "data/map.json";
const dryRun = process.argv.includes("--dry-run");

type Placed = { tileId: string; direction?: Direction; [field: string]: unknown };
type Flat = { version: number; levels: Record<string, Record<string, Placed[]>> };

const map: Flat = JSON.parse(await Bun.file(MAP_PATH).text());
const tiles: TileDef[] = (JSON.parse(await Bun.file("data/tiles.json").text()) as unknown[]).map(
  (raw) => normalizeTileDef(raw),
);
const tilesById = tilesByIdFromList(tiles);
const statusDefs: Record<string, StatusDef> = statusesById(
  JSON.parse(await Bun.file("data/statuses.json").text()),
);
const playerDef = tilesById["player"]!;

const keyOf = (x: number, y: number, z: number) => `${x},${y},${z}`;
const stackAt = (z: number, x: number, y: number): Placed[] =>
  map.levels[String(z)]?.[`${x},${y}`] ?? [];
const setStack = (z: number, x: number, y: number, stack: Placed[]) => {
  map.levels[String(z)] ??= {};
  map.levels[String(z)]![`${x},${y}`] = stack;
};

function toBoard(keepBodies: boolean): MapFile {
  const levels: Flat["levels"] = {};
  for (const [z, cells] of Object.entries(map.levels)) {
    const out: Record<string, Placed[]> = {};
    for (const [key, stack] of Object.entries(cells)) {
      const kept = keepBodies
        ? stack
        : stack.filter((placed) => tilesById[placed.tileId]?.kind !== "battler");
      if (kept.length > 0) out[key] = kept;
    }
    levels[z] = out;
  }
  return parseMap(serializeMap(chunkifyMap({ version: map.version, levels } as never)));
}

type Walk = { cells: Coord[]; index: Map<string, number>; next: number[][] };

/** Cells reachable on foot, drops left out as `raise:hills` leaves them out, with the legs between them. */
function walkGraph(): Walk {
  const world = { board: toBoard(false), traveller: playerDef, tilesById, statusDefs };
  const start = RAMPS.start;
  const cells: Coord[] = [start];
  const index = new Map([[keyOf(start.x, start.y, start.z), 0]]);
  const next: number[][] = [];
  for (let at = 0; at < cells.length; at++) {
    const out: number[] = [];
    for (const leg of navigationLegs(world, cells[at]!)) {
      if (leg.kind === "walk" && leg.drop) continue;
      const key = keyOf(leg.to.x, leg.to.y, leg.to.z);
      let to = index.get(key);
      if (to === undefined) {
        to = cells.length;
        index.set(key, to);
        cells.push(leg.to);
      }
      out.push(to);
    }
    next.push(out);
  }
  return { cells, index, next };
}

function walkOnFoot(): Set<string> {
  return new Set(walkGraph().index.keys());
}

function stepsBetween(walk: Walk, from: number, to: number): number {
  const steps = new Int32Array(walk.cells.length).fill(-1);
  steps[from] = 0;
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head]!;
    if (at === to) return steps[at]!;
    for (const step of walk.next[at]!) {
      if (steps[step] !== -1) continue;
      steps[step] = steps[at]! + 1;
      queue.push(step);
    }
  }
  return -1;
}

/** Raised ground a body could stand on: on a cliff, nothing above it, nothing in the way. */
function isHilltop(z: number, x: number, y: number): boolean {
  if (z < 1 || stackAt(z + 1, x, y).length > 0) return false;
  if (stackAt(z - 1, x, y).at(-1)?.tileId !== WALL) return false;
  const stack = stackAt(z, x, y);
  return (
    stack.length > 0 &&
    stack.every(
      (placed) => !NOT_GROUND.has(placed.tileId) && tilesById[placed.tileId]?.walkable !== false,
    )
  );
}

type Cell = { x: number; y: number; z: number };

/** Hilltops nobody can walk onto, each as the cells of open ground on it. */
function unreachedHilltops(reached: Set<string>): Cell[][] {
  const seen = new Set<string>();
  const out: Cell[][] = [];
  for (const [zKey, cells] of Object.entries(map.levels)) {
    const z = Number(zKey);
    for (const key of Object.keys(cells)) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      const id = keyOf(x, y, z);
      if (seen.has(id) || reached.has(id) || !isHilltop(z, x, y)) continue;
      seen.add(id);
      const region: Cell[] = [{ x, y, z }];
      for (let head = 0; head < region.length; head++) {
        const at = region[head]!;
        for (const { dx, dy } of Object.values(STEP)) {
          const next = keyOf(at.x + dx, at.y + dy, z);
          if (seen.has(next) || reached.has(next)) continue;
          if (!isHilltop(z, at.x + dx, at.y + dy)) continue;
          seen.add(next);
          region.push({ x: at.x + dx, y: at.y + dy, z });
        }
      }
      if (region.length >= RAMPS.minUsefulCells) out.push(region);
    }
  }
  return out;
}

/** What a ramp is laid over and clears away: trees and bushes at the foot of a cliff included. */
const CLEARED = new Set([...COVER, "tree", "small-bush", "bush-3", "picked-bush"]);

const isPlainGround = (stack: readonly Placed[]) =>
  stack.length >= 1 &&
  GROUND.has(stack[0]!.tileId) &&
  stack.slice(1).every((placed) => CLEARED.has(placed.tileId));

type Site = { head: Cell; outward: Direction; ground: string };

/**
 * Four cells in a line, as `raise:hills` lays them: the head, a hilltop cell
 * whose cliff below becomes a full block; two ramp cells on plain ground at
 * the cliff's foot with nothing over them; and a foot a player already walks
 * to, or a tree or bush beside ground they walk to, which the ramp clears. The
 * head's own ground has to be plain or a brink, and nothing stands on it.
 */
function footReached(foot: { x: number; y: number }, z: number, reached: Set<string>): boolean {
  if (reached.has(keyOf(foot.x, foot.y, z))) return true;
  if (!isPlainGround(stackAt(z, foot.x, foot.y)) || stackAt(z + 1, foot.x, foot.y).length > 0) {
    return false;
  }
  return Object.values(STEP).some(({ dx, dy }) => reached.has(keyOf(foot.x + dx, foot.y + dy, z)));
}

function siteAt(head: Cell, outward: Direction, reached: Set<string>): Site | null {
  const { dx, dy } = STEP[outward];
  const z = head.z - 1;
  const cell = (n: number) => ({ x: head.x + dx * n, y: head.y + dy * n });
  const cliff = stackAt(z, head.x, head.y);
  if (cliff.length !== 2 || cliff[1]!.tileId !== WALL || !GROUND.has(cliff[0]!.tileId)) return null;
  const top = stackAt(head.z, head.x, head.y).filter((placed) => !COVER.has(placed.tileId));
  const topId = top[0]?.tileId ?? "";
  if (top.length !== 1 || !(HEAD_GROUND.has(topId) || BRINK_GROUND[topId])) return null;
  for (const n of [1, 2]) {
    const { x, y } = cell(n);
    if (!isPlainGround(stackAt(z, x, y)) || stackAt(z + 1, x, y).length > 0) return null;
  }
  return footReached(cell(3), z, reached) ? { head, outward, ground: cliff[0]!.tileId } : null;
}

const isBare = (stack: readonly Placed[]) => stack.every((placed) => !CLEARED.has(placed.tileId));

function build({ head, outward, ground }: Site): () => void {
  const { dx, dy } = STEP[outward];
  const z = head.z - 1;
  const at = (n: number) => ({ x: head.x + dx * n, y: head.y + dy * n });
  const saved = [0, 1, 2, 3].map((n) => ({ ...at(n), stack: stackAt(z, at(n).x, at(n).y) }));
  const groundAt = (n: number) => ({ tileId: saved[n]!.stack[0]!.tileId });
  const savedTop = stackAt(head.z, head.x, head.y);
  const topId = savedTop.find((placed) => !COVER.has(placed.tileId))!.tileId;

  setStack(z, head.x, head.y, [{ tileId: ground }, { tileId: FILL }, { tileId: FILL }]);
  setStack(z, at(1).x, at(1).y, [
    groundAt(1),
    { tileId: FILL },
    { tileId: RAMP, direction: outward },
  ]);
  setStack(z, at(2).x, at(2).y, [groundAt(2), { tileId: RAMP, direction: outward }]);
  if (!isBare(saved[3]!.stack)) setStack(z, at(3).x, at(3).y, [groundAt(3)]);
  setStack(head.z, head.x, head.y, [{ tileId: BRINK_GROUND[topId] ?? topId }]);

  return () => {
    for (const { x, y, stack } of saved) setStack(z, x, y, stack);
    setStack(head.z, head.x, head.y, savedTop);
  };
}

/** The sites for one hilltop, one per `cellsPerRamp` cells of it, spread `rampSpacing` apart. */
function sitesFor(region: Cell[], reached: Set<string>): Site[] {
  const wanted = Math.max(1, Math.floor(region.length / RAMPS.cellsPerRamp));
  const chosen: Site[] = [];
  for (const outward of OUTWARD) {
    for (const head of region) {
      if (chosen.length >= wanted) return chosen;
      const site = siteAt(head, outward, reached);
      if (!site) continue;
      const crowded = chosen.some(
        (other) =>
          Math.abs(other.head.x - head.x) + Math.abs(other.head.y - head.y) < RAMPS.rampSpacing,
      );
      if (!crowded) chosen.push(site);
    }
  }
  return chosen;
}

console.log("walking the map…");
let reached = walkOnFoot();
const reachedBefore = reached.size;
const strandedBefore = findStranded(toBoard(true), tilesById, statusDefs).stranded;
const unreachedBefore = unreachedHilltops(reached);
const built: Site[] = [];

/**
 * Each site is tried on its own and kept only if it opens at least
 * `minUsefulCells` new ground. A ramp onto a strip of hilltop that trees cut off
 * from the rest reaches its own head and little else, and the next round
 * would lay another beside it. A ramp that lets a player onto a ledge with
 * no way back is undone as well.
 */
for (let round = 0; round < RAMPS.maxRounds; round++) {
  const sites = unreachedHilltops(reached).flatMap((region) => sitesFor(region, reached));
  let kept = 0;
  for (const site of sites) {
    const undo = build(site);
    const after = walkOnFoot();
    const stranded = findStranded(toBoard(true), tilesById, statusDefs).stranded;
    if (after.size - reached.size < RAMPS.minUsefulCells || stranded > strandedBefore) {
      undo();
      continue;
    }
    reached = after;
    built.push(site);
    kept++;
  }
  console.log(`round ${round + 1}: ${kept} of ${sites.length} sites kept`);
  if (kept === 0) break;
}

function rampCells(): Cell[] {
  const out: Cell[] = [];
  for (const [zKey, cells] of Object.entries(map.levels)) {
    for (const [key, stack] of Object.entries(cells)) {
      if (!stack.some((placed) => placed.tileId === RAMP)) continue;
      const [x, y] = key.split(",").map(Number) as [number, number];
      out.push({ x, y, z: Number(zKey) });
    }
  }
  return out;
}

const apart = (a: Cell, b: Cell, spacing: number) =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y) >= spacing;

type Shortcut = { site: Site; steps: number };

/** Every site up a cliff whose top a player reaches already, with the walk round from its foot. */
function shortcutCandidates(walk: Walk): Shortcut[] {
  const reachedNow = new Set(walk.index.keys());
  const ramps = rampCells();
  const out: Shortcut[] = [];
  for (const head of walk.cells) {
    if (!isHilltop(head.z, head.x, head.y)) continue;
    if (!ramps.every((ramp) => apart(ramp, head, RAMPS.rampSpacing))) continue;
    for (const outward of OUTWARD) {
      const site = siteAt(head, outward, reachedNow);
      const { dx, dy } = STEP[outward];
      const foot = walk.index.get(keyOf(head.x + dx * 3, head.y + dy * 3, head.z - 1));
      if (!site || foot === undefined) continue;
      const top = walk.index.get(keyOf(head.x, head.y, head.z))!;
      out.push({ site, steps: stepsBetween(walk, foot, top) });
    }
  }
  return out;
}

/**
 * The longest walks round go first, and each shortcut keeps its distance from
 * the ones already taken, which stands in for walking the map again after
 * each: two ramps up the same stretch of cliff save the second walk nothing.
 */
const shortcuts: Shortcut[] = [];
const candidates = shortcutCandidates(walkGraph()).sort((a, b) => b.steps - a.steps);
for (const candidate of candidates) {
  if (candidate.steps < RAMPS.shortcutSteps) break;
  const head = candidate.site.head;
  if (!shortcuts.every((taken) => apart(taken.site.head, head, RAMPS.shortcutSpacing))) continue;
  const undo = build(candidate.site);
  if (findStranded(toBoard(true), tilesById, statusDefs).stranded > strandedBefore) {
    undo();
    continue;
  }
  shortcuts.push(candidate);
}
reached = walkOnFoot();

const strandedAfter = findStranded(toBoard(true), tilesById, statusDefs).stranded;
const unreachedAfter = unreachedHilltops(reached);
const cells = (regions: Cell[][]) => regions.reduce((n, region) => n + region.length, 0);

for (const { head, outward } of built) {
  console.log(`  ramp up to L${head.z} at (${head.x}, ${head.y}), climbing from the ${outward}`);
}
console.log(`${built.length} ramps onto hilltops nobody could climb to`);
for (const { site, steps } of shortcuts) {
  const { head, outward } = site;
  console.log(
    `  shortcut up to L${head.z} at (${head.x}, ${head.y}), climbing from the ${outward}: ${steps} steps round → 3`,
  );
}
console.log(`${shortcuts.length} shortcuts`);
console.log(`reachable on foot: ${reachedBefore} → ${reached.size}`);
console.log(
  `hilltops of ${RAMPS.minUsefulCells}+ open cells nobody can climb to: ${unreachedBefore.length} (${cells(unreachedBefore)} cells) → ${unreachedAfter.length} (${cells(unreachedAfter)} cells)`,
);
console.log(`stranded: ${strandedBefore} → ${strandedAfter}`);

if (strandedAfter > strandedBefore) {
  console.error("ramp:hills: the new ramps strand cells the old map did not; not written");
  process.exit(1);
}
if (dryRun) {
  console.log("--dry-run: data/map.json left as it was");
} else {
  await Bun.write(MAP_PATH, serializeMap(chunkifyMap(map as never)));
  console.log(`wrote ${MAP_PATH}`);
}
