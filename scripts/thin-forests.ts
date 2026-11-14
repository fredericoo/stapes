import { chunkifyMap, parseMap, serializeMap } from "../app/lib/mapData";
import { statusesById } from "../app/lib/status";
import { findStranded } from "../app/verify/stranded";
import { navigationLegs } from "../app/game/navigation";
import { fbm, randomAt } from "../app/editor/generator";
import { tilesByIdFromList } from "../app/lib/validation";
import { normalizeTileDef } from "../app/lib/types";
import type { StatusDef } from "../app/lib/status";
import type { Coord, Direction, MapFile, TileDef } from "../app/lib/types";

const THINNING = {
  seed: 0x7e1d9,

  /** The walled town and its margin keep the trees they were planted with. */
  town: { x0: -47, x1: 31, y0: -46, y1: 19 },

  /** A cell the walk starts from. It has to be one a player can stand in. */
  start: { x: -8, y: 0, z: 0 },

  /**
   * How deep into a stand of trees the thinning reaches, counted in cells from
   * the nearest open ground, and the score a tree at each depth has to beat to
   * be felled. The score is noise, so felled trees come in glades and bays
   * rather than as a random speckle.
   */
  maxDepth: 3,
  threshold: [0, 0.4, 0.52, 0.62],

  /** Cells per noise period for the bays the edge is cut back in, and how much a single tree may stray from its neighbours. */
  bayScale: 7,
  jitter: 0.36,

  /** A tree with fewer trees than this around it is a lone tree in a field, not the edge of a stand, and is left. */
  minStandNeighbours: 3,

  /** Pairs of cells sampled for the detour figure, and the straight-line distance between them. */
  detourSamples: 400,
  detourDistance: { min: 20, max: 50 },
} as const;

const TREES = new Set(["tree", "snowy-pine"]);
/** Ground no body stands in, so it is never the open side of an edge. */
const NOT_GROUND = new Set(["water", "deep-water", "swamp", "mud", "ice", "shore-foam"]);
const NEIGHBOURS_8 = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
] as const;

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

function toBoard(flat: Flat, keepBodies: boolean): MapFile {
  const levels: Flat["levels"] = {};
  for (const [z, cells] of Object.entries(flat.levels)) {
    const out: Record<string, Placed[]> = {};
    for (const [key, stack] of Object.entries(cells)) {
      const kept = keepBodies
        ? stack
        : stack.filter((placed) => tilesById[placed.tileId]?.kind !== "battler");
      if (kept.length > 0) out[key] = kept;
    }
    levels[z] = out;
  }
  return parseMap(serializeMap(chunkifyMap({ version: flat.version, levels } as never)));
}

type Walk = { cells: Coord[]; index: Map<string, number>; next: number[][] };

/**
 * Every cell a player gets to on foot, with the legs between them. Drops off a
 * ledge are left out: a body can fall off any cliff, so counting them would call
 * a hilltop reachable when nothing leads up it.
 */
function walkOnFoot(): Walk {
  const world = { board: toBoard(map, false), traveller: playerDef, tilesById, statusDefs };
  const start = THINNING.start;
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

/** Reachable cells a body can leave by one way only: the far end of every blind alley. */
function deadEnds(walk: Walk): number {
  return walk.next.filter((out) => new Set(out).size === 1).length;
}

function stepsFrom(walk: Walk, from: number): Int32Array {
  const steps = new Int32Array(walk.cells.length).fill(-1);
  steps[from] = 0;
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head]!;
    for (const to of walk.next[at]!) {
      if (steps[to] !== -1) continue;
      steps[to] = steps[at]! + 1;
      queue.push(to);
    }
  }
  return steps;
}

/**
 * How much further than the straight line a walk between two surface cells is,
 * as the median over pairs drawn the same way before and after. It is what a
 * player means by "nothing connects": a place in plain sight that takes a
 * long way round to reach.
 */
function medianDetour(walk: Walk, pairs: Array<[Coord, Coord]>): number {
  const ratios: number[] = [];
  for (const [a, b] of pairs) {
    const from = walk.index.get(keyOf(a.x, a.y, a.z));
    const to = walk.index.get(keyOf(b.x, b.y, b.z));
    if (from === undefined || to === undefined) continue;
    const steps = stepsFrom(walk, from)[to]!;
    if (steps < 0) continue;
    ratios.push(steps / (Math.abs(a.x - b.x) + Math.abs(a.y - b.y)));
  }
  ratios.sort((p, q) => p - q);
  return ratios[Math.floor(ratios.length / 2)] ?? Number.NaN;
}

function samplePairs(walk: Walk): Array<[Coord, Coord]> {
  const surface = walk.cells.filter((c) => c.z === 0);
  const pairs: Array<[Coord, Coord]> = [];
  const { min, max } = THINNING.detourDistance;
  for (let i = 0; pairs.length < THINNING.detourSamples; i++) {
    const a = surface[Math.floor(randomAt(i, 0, THINNING.seed) * surface.length)]!;
    const b = surface[Math.floor(randomAt(i, 1, THINNING.seed) * surface.length)]!;
    const distance = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    if (distance >= min && distance <= max) pairs.push([a, b]);
  }
  return pairs;
}

function inTown(x: number, y: number): boolean {
  const { x0, x1, y0, y1 } = THINNING.town;
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

function isTree(z: number, x: number, y: number): boolean {
  return stackAt(z, x, y).some((placed) => TREES.has(placed.tileId));
}

/**
 * Ground a body could stand on once the trees beside it are gone: something on
 * this level, nothing on the level above, and nothing in the stack that blocks
 * a step or is water.
 */
function isOpenGround(z: number, x: number, y: number): boolean {
  const stack = stackAt(z, x, y);
  if (stack.length === 0 || stackAt(z + 1, x, y).length > 0) return false;
  return stack.every(
    (placed) => !NOT_GROUND.has(placed.tileId) && tilesById[placed.tileId]?.walkable !== false,
  );
}

type Cell = { x: number; y: number; z: number };

/** Each tree's distance in cells from the nearest open ground on its own level, up to `maxDepth`. */
function treeDepths(): Map<string, { cell: Cell; depth: number }> {
  const depths = new Map<string, { cell: Cell; depth: number }>();
  let frontier: Cell[] = [];
  for (const [zKey, cells] of Object.entries(map.levels)) {
    const z = Number(zKey);
    for (const key of Object.keys(cells)) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      if (isOpenGround(z, x, y)) frontier.push({ x, y, z });
    }
  }
  for (let depth = 1; depth <= THINNING.maxDepth; depth++) {
    const reached: Cell[] = [];
    for (const { x, y, z } of frontier) {
      for (const [dx, dy] of NEIGHBOURS_8) {
        const cell = { x: x + dx, y: y + dy, z };
        const key = keyOf(cell.x, cell.y, z);
        if (depths.has(key) || !isTree(z, cell.x, cell.y)) continue;
        depths.set(key, { cell, depth });
        reached.push(cell);
      }
    }
    frontier = reached;
  }
  return depths;
}

function standNeighbours({ x, y, z }: Cell): number {
  return NEIGHBOURS_8.filter(([dx, dy]) => isTree(z, x + dx, y + dy)).length;
}

function fellingScore({ x, y }: Cell): number {
  const bay = fbm(x, y, THINNING.seed, THINNING.bayScale, 2);
  const stray = (randomAt(x, y, THINNING.seed ^ 0x51) - 0.5) * THINNING.jitter;
  return bay + stray;
}

function withoutTree(stack: readonly Placed[]): Placed[] {
  return stack.filter((placed) => !TREES.has(placed.tileId));
}

/**
 * A felled cell stays felled only if it is part of a 2×2 square of open ground,
 * the rule the forest generator's `widenToTwo` holds a wood to. A gap one cell
 * wide is drawn over by the tree south of it, so it is somewhere a player can
 * walk and cannot see. Replanting one can break another's square, so it runs
 * until nothing changes.
 */
function replantNarrowGaps(felled: Map<string, { cell: Cell; tree: Placed[] }>): number {
  let replanted = 0;
  const squareOpen = (z: number, x: number, y: number) =>
    isOpenGround(z, x, y) &&
    isOpenGround(z, x + 1, y) &&
    isOpenGround(z, x, y + 1) &&
    isOpenGround(z, x + 1, y + 1);
  for (let changed = true; changed;) {
    changed = false;
    for (const [key, { cell, tree }] of felled) {
      const { x, y, z } = cell;
      const inSquare =
        squareOpen(z, x, y) ||
        squareOpen(z, x - 1, y) ||
        squareOpen(z, x, y - 1) ||
        squareOpen(z, x - 1, y - 1);
      if (inSquare) continue;
      map.levels[String(z)]![`${x},${y}`] = tree;
      felled.delete(key);
      replanted++;
      changed = true;
    }
  }
  return replanted;
}

const MAX_STRANDED_ROUNDS = 20;
const NEIGHBOURS_4 = [
  [0, -1],
  [-1, 0],
  [1, 0],
  [0, 1],
] as const;

/**
 * Opening a hilltop can give a player a ledge to drop off into a hollow that
 * the trees around it close. The hollow is opened rather than the hilltop
 * closed again: a tree beside a stranded cell is felled, which leads out of it
 * on its own level. Where there is no such tree, the felled trees around it
 * are planted again.
 */
function freeStranded(
  felled: Map<string, { cell: Cell; tree: Placed[] }>,
  allowed: number,
): { opened: number; replanted: number; stranded: number } {
  let opened = 0;
  let replanted = 0;
  for (let round = 0; round < MAX_STRANDED_ROUNDS; round++) {
    const report = findStranded(toBoard(map, true), tilesById, statusDefs);
    if (report.stranded <= allowed) return { opened, replanted, stranded: report.stranded };
    const cells = report.regions.flatMap((region) => region.cells);
    const walls = cells.flatMap(({ x, y, z }) =>
      NEIGHBOURS_4.map(([dx, dy]) => ({ x: x + dx, y: y + dy, z })).filter(
        (c) => isTree(c.z, c.x, c.y) && !inTown(c.x, c.y),
      ),
    );
    for (const cell of walls) {
      const stack = stackAt(cell.z, cell.x, cell.y);
      if (!stack.some((placed) => TREES.has(placed.tileId))) continue;
      felled.set(keyOf(cell.x, cell.y, cell.z), { cell, tree: stack });
      map.levels[String(cell.z)]![`${cell.x},${cell.y}`] = withoutTree(stack);
      opened++;
    }
    if (walls.length > 0) continue;
    const entrances = report.regions.flatMap((region) => region.entrances.map((e) => e.from));
    for (const { x, y, z } of entrances) {
      for (const [dx, dy] of [[0, 0] as const, ...NEIGHBOURS_8]) {
        const key = keyOf(x + dx, y + dy, z);
        const tree = felled.get(key);
        if (!tree) continue;
        map.levels[String(z)]![`${x + dx},${y + dy}`] = tree.tree;
        felled.delete(key);
        replanted++;
      }
    }
  }
  const stranded = findStranded(toBoard(map, true), tilesById, statusDefs).stranded;
  return { opened, replanted, stranded };
}

console.log("walking the map before…");
const before = walkOnFoot();
const pairs = samplePairs(before);
const strandedBefore = findStranded(toBoard(map, true), tilesById, statusDefs).stranded;

const felled = new Map<string, { cell: Cell; tree: Placed[] }>();
const depths = treeDepths();
const toFell = [...depths].filter(
  ([, { cell, depth }]) =>
    !inTown(cell.x, cell.y) &&
    standNeighbours(cell) >= THINNING.minStandNeighbours &&
    fellingScore(cell) >= THINNING.threshold[depth]!,
);
for (const [key, { cell }] of toFell) {
  const stack = stackAt(cell.z, cell.x, cell.y);
  felled.set(key, { cell, tree: stack });
  map.levels[String(cell.z)]![`${cell.x},${cell.y}`] = withoutTree(stack);
}
const proposed = felled.size;
const replanted = replantNarrowGaps(felled);
const freed = freeStranded(felled, strandedBefore);

console.log("walking the map after…");
const after = walkOnFoot();
const strandedAfter = freed.stranded;

const totalTrees = Object.values(map.levels)
  .flatMap((cells) => Object.values(cells))
  .filter((stack) => stack.some((placed) => TREES.has(placed.tileId))).length;
const edgeTrees = [...depths.values()].filter(({ cell }) => !inTown(cell.x, cell.y)).length;

console.log(
  `felled ${felled.size} trees (${proposed} chosen, ${replanted} replanted to keep gaps two wide, ${freed.replanted} to strand nobody; ${freed.opened} more felled to open hollows a ledge drops into) of ${edgeTrees} within ${THINNING.maxDepth} cells of open ground; ${totalTrees} trees left`,
);
console.log(`reachable on foot: ${before.cells.length} → ${after.cells.length}`);
console.log(`dead ends: ${deadEnds(before)} → ${deadEnds(after)}`);
console.log(
  `median detour over ${pairs.length} surface pairs: ${medianDetour(before, pairs).toFixed(2)} → ${medianDetour(after, pairs).toFixed(2)}`,
);
console.log(`stranded: ${strandedBefore} → ${strandedAfter}`);

if (strandedAfter > strandedBefore) {
  console.error("thin:forests: the thinned map strands cells the old one did not; not written");
  process.exit(1);
}
if (dryRun) {
  console.log("--dry-run: data/map.json left as it was");
} else {
  await Bun.write(MAP_PATH, serializeMap(chunkifyMap(map as never)));
  console.log(`wrote ${MAP_PATH}`);
}
