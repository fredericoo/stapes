import { chunkifyMap, listCoords, parseMap, presentLevels, serializeMap } from "../app/lib/mapData";
import { listStandingSurfaces } from "../app/game/movement";
import { reachableCells } from "../app/game/navigation";
import { findPlayers } from "../app/game/player";
import { mulberry32 } from "../app/editor/generator";
import { isSkyExposed, stackOcclusion } from "../app/lib/lighting";
import { computeLightingFlood } from "../app/lib/lightingFlood";
import { statusesById } from "../app/lib/status";
import { fitsHeightAtElevation, tilesByIdFromList } from "../app/lib/validation";
import { findStranded } from "../app/verify/stranded";
import { HEIGHT_PER_LEVEL, MAX_LIGHT_LEVEL, coordKey, normalizeTileDef } from "../app/lib/types";
import type { Direction, MapFile, TileDef } from "../app/lib/types";

const CAVES = {
  seed: 0xb47ca5e,

  /** The most caves to dig, largest pocket of rock first. */
  count: 6,
  /** A pocket with fewer open cells than this once its walls are roughened is left solid. */
  minCells: 14,

  /** The chance that a cell on the edge of a pocket stays rock, which is what makes a cave of a rectangle. */
  roughness: 0.4,

  /** The longest tunnel from a cave to the cliff face it opens onto. */
  mouthReach: 8,

  cellsPerStalagmite: 9,
  stalagmiteSpacing: 2,
  /** Each cave draws its own share of grey stalagmites from this range, so no two caves are mixed alike. */
  greyShare: { min: 0.15, max: 0.85 },

  cellsPerBat: 18,
  maxBatsPerCave: 3,
  batSpacing: 3,
  /** Bats keep this far from the inside end of the tunnel, so nobody is bitten on the threshold. */
  batMouthClearance: 3,
} as const;

/** What `raise:hills` fills a hill with below its top: the ground tile and two half levels of rock. */
const FILL = "half-stone";
const FLOOR = "dirt";
const WALL = "cave-wall-sloped";
const STALAGMITE = "stalagmite";
const STALAGMITE_GREY = "stalagmite-grey";
const STALAGMITES = new Set([STALAGMITE, STALAGMITE_GREY]);
const BAT = "bat";

/** Light from the sky above this, in a cell farther than `MAX_LIGHT_LEVEL` from a mouth, is a hole rather than a glow. */
const DIM_ENOUGH = 64;

const MAP_PATH = "data/map.json";
const TILES_PATH = "data/tiles.json";
const dryRun = process.argv.includes("--dry-run");

type Placed = { tileId: string; direction?: Direction; [field: string]: unknown };
type Flat = { version: number; levels: Record<string, Record<string, Placed[]>> };

const map: Flat = JSON.parse(await Bun.file(MAP_PATH).text());
const tiles: TileDef[] = (JSON.parse(await Bun.file(TILES_PATH).text()) as unknown[]).map((raw) =>
  normalizeTileDef(raw),
);
const tilesById = tilesByIdFromList(tiles);
const playerDef = tilesById["player"]!;
const statusDefs = statusesById(JSON.parse(await Bun.file("data/statuses.json").text()));
if (![...STALAGMITES].every((id) => tilesById[id])) {
  console.error(
    `carve:hill-caves: no ${STALAGMITE} or ${STALAGMITE_GREY} tile. Run generate:stalagmites first.`,
  );
  process.exit(1);
}

const surface = map.levels["0"] ?? {};
let X0 = Infinity;
let X1 = -Infinity;
let Y0 = Infinity;
let Y1 = -Infinity;
for (const key of Object.keys(surface)) {
  const [x, y] = key.split(",").map(Number) as [number, number];
  X0 = Math.min(X0, x);
  X1 = Math.max(X1, x);
  Y0 = Math.min(Y0, y);
  Y1 = Math.max(Y1, y);
}
const W = X1 - X0 + 1;
const H = Y1 - Y0 + 1;
const N = W * H;
const idx = (x: number, y: number) => (y - Y0) * W + (x - X0);
const cellX = (i: number) => (i % W) + X0;
const cellY = (i: number) => Math.floor(i / W) + Y0;
const inBounds = (x: number, y: number) => x >= X0 && x <= X1 && y >= Y0 && y <= Y1;
const chebyshev = (a: number, b: number) =>
  Math.max(Math.abs(cellX(a) - cellX(b)), Math.abs(cellY(a) - cellY(b)));

const STEP: Record<Direction, { dx: number; dy: number }> = {
  n: { dx: 0, dy: -1 },
  e: { dx: 1, dy: 0 },
  s: { dx: 0, dy: 1 },
  w: { dx: -1, dy: 0 },
};
const DIRS: Direction[] = ["n", "e", "s", "w"];
const SIDEWAYS: Record<Direction, Direction> = { n: "e", e: "s", s: "w", w: "n" };
const OPPOSITE: Record<Direction, Direction> = { n: "s", e: "w", s: "n", w: "e" };
const RING = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
] as const;

function neighbour(i: number, dir: Direction, steps = 1): number {
  const x = cellX(i) + STEP[dir].dx * steps;
  const y = cellY(i) + STEP[dir].dy * steps;
  return inBounds(x, y) ? idx(x, y) : -1;
}

function ring(i: number): number[] {
  return RING.map(([dx, dy]) =>
    inBounds(cellX(i) + dx, cellY(i) + dy) ? idx(cellX(i) + dx, cellY(i) + dy) : -1,
  );
}

const level = (z: number) => (map.levels[String(z)] ??= {});
const stackAt = (z: number, i: number): Placed[] => level(z)[coordKey(cellX(i), cellY(i))] ?? [];
const setStack = (z: number, i: number, stack: Placed[]) => {
  level(z)[coordKey(cellX(i), cellY(i))] = stack;
};

/** A cell of hill that is rock all through: exactly what `raise:hills` wrote, with nothing added since. */
function solid(z: number, i: number): boolean {
  if (i === -1) return false;
  const stack = stackAt(z, i);
  return (
    stack.length === 3 &&
    stack[1]!.tileId === FILL &&
    stack[2]!.tileId === FILL &&
    stack.every((placed) => Object.keys(placed).length === 1)
  );
}

if (
  Object.values(map.levels).some((cells) =>
    Object.values(cells).some((s) => s.some((p) => STALAGMITES.has(p.tileId))),
  )
) {
  console.error(
    "carve:hill-caves: this map already has its hill caves. Start from a map without them.",
  );
  process.exit(1);
}

function toBoard(flat: Flat): MapFile {
  return parseMap(serializeMap(chunkifyMap(flat as never)));
}

/** The board with every body taken off it, since a bat in a tunnel is not a wall. */
function withoutBodies(flat: Flat): MapFile {
  const levels: Flat["levels"] = {};
  for (const [z, cells] of Object.entries(flat.levels)) {
    const out: Record<string, Placed[]> = {};
    for (const [key, stack] of Object.entries(cells)) {
      const kept = stack.filter((placed) => tilesById[placed.tileId]?.kind !== "battler");
      if (kept.length > 0) out[key] = kept;
    }
    levels[z] = out;
  }
  return toBoard({ version: flat.version, levels });
}

/** Every cell a player can get to from wherever the map puts one, by the same graph the game routes on. */
function walk(flat: Flat): Set<string> {
  const starts = findPlayers(toBoard(flat)).map(({ x, y, z }) => ({ x, y, z }));
  const board = withoutBodies(flat);
  const world = { board, traveller: playerDef, tilesById, statusDefs: {} };
  const seen = new Set<string>();
  for (const { x, y, z } of reachableCells(world, starts).values()) seen.add(`${x},${y},${z}`);
  return seen;
}

function regions(member: (i: number) => boolean): number[][] {
  const seen = new Uint8Array(N);
  const out: number[][] = [];
  for (let start = 0; start < N; start++) {
    if (seen[start] || !member(start)) continue;
    const region = [start];
    seen[start] = 1;
    for (let head = 0; head < region.length; head++) {
      for (const dir of DIRS) {
        const n = neighbour(region[head]!, dir);
        if (n === -1 || seen[n] || !member(n)) continue;
        seen[n] = 1;
        region.push(n);
      }
    }
    out.push(region);
  }
  return out.sort((a, b) => b.length - a.length);
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** `tunnel` runs from the cell beside the cave to the cell in the cliff face; `outside` is the ground it opens onto. */
type Mouth = { tunnel: number[]; outside: number; heading: Direction };
type Cave = { z: number; cells: number[]; mouth: Mouth; stalagmites: number[]; bats: number[] };

console.log("walking the map as it stands…");
const before = walk(map);

/**
 * A cave is dug only where the level above is rock as well, so its roof is a
 * full block and no daylight comes down through a bush or a tree on the
 * hilltop. Every cell of it also has rock all round it on its own level, so
 * there is a wall between the cave and the open air wherever there is no mouth.
 */
function pocketsOn(z: number): number[][] {
  const room = (i: number) => solid(z, i) && solid(z + 1, i) && ring(i).every((n) => solid(z, n));
  return regions(room);
}

function roughen(pocket: readonly number[], random: () => number): number[] {
  const inPocket = new Set(pocket);
  const open = new Set(pocket);
  for (const i of pocket) {
    const edge = DIRS.some((dir) => !inPocket.has(neighbour(i, dir)));
    if (edge && random() < CAVES.roughness) open.delete(i);
  }
  /** One pass of the usual cave smoothing: a cell crowded by rock fills in, and a lone pillar of rock is cleared. */
  const smoothed = new Set<number>();
  for (const i of pocket) {
    const rock = ring(i).filter((n) => !open.has(n)).length;
    if (open.has(i) ? rock < 6 : rock <= 2) smoothed.add(i);
  }
  return regions((i) => smoothed.has(i))[0] ?? [];
}

/**
 * The shortest straight tunnel from the cave to a cliff face with ground a
 * player can already walk to outside it. A mouth facing south or east is in
 * the face the projection shows, so a player walking past can see it.
 */
function findMouth(z: number, cells: readonly number[], taken: Uint8Array): Mouth | null {
  const inCave = new Set(cells);
  let best: (Mouth & { rank: number }) | null = null;
  for (const from of cells) {
    for (const heading of DIRS) {
      const tunnel: number[] = [];
      for (let step = 1; step <= CAVES.mouthReach + 1; step++) {
        const at = neighbour(from, heading, step);
        if (at === -1 || inCave.has(at) || taken[at]) break;
        if (solid(z, at)) {
          const side = SIDEWAYS[heading];
          if (
            ![side, OPPOSITE[side]].every(
              (d) => solid(z, neighbour(at, d)) || inCave.has(neighbour(at, d)),
            )
          )
            break;
          tunnel.push(at);
          continue;
        }
        const ground = stackAt(z, at);
        const plain = !ground.some((p) => p.tileId === "ramp" || p.tileId === "fence");
        if (tunnel.length > 0 && plain && before.has(`${cellX(at)},${cellY(at)},${z}`)) {
          const rank = tunnel.length + (heading === "s" || heading === "e" ? 0 : 4);
          if (!best || rank < best.rank) best = { tunnel, outside: at, heading, rank };
        }
        break;
      }
    }
  }
  return best && { tunnel: best.tunnel, outside: best.outside, heading: best.heading };
}

function rockAround(open: Set<number>, i: number): number {
  return ring(i).filter((n) => !open.has(n)).length;
}

/**
 * A sprite is lit from the cells it is drawn over, and the projection draws a
 * stalagmite leaning over the cells north and west of its own. Against a wall
 * on those sides it is drawn over rock, which takes no light, and shows as a
 * black shape however bright the floor in front of it is.
 */
function openBehind(open: Set<number>, i: number): boolean {
  const north = neighbour(i, "n");
  return [north, neighbour(i, "w"), north === -1 ? -1 : neighbour(north, "w")].every((n) =>
    open.has(n),
  );
}

/** Whether filling `i` would split the open cells round it into two pieces. */
function wouldPinch(open: Set<number>, i: number): boolean {
  const around = ring(i).map((n) => open.has(n));
  let runs = 0;
  for (let k = 0; k < around.length; k++) {
    if (around[k] && !around[(k + around.length - 1) % around.length]) runs++;
  }
  return runs > 1;
}

function furnish(z: number, cells: number[], mouth: Mouth, random: () => number): Cave {
  const open = new Set([...cells, ...mouth.tunnel]);
  const threshold = mouth.tunnel[0]!;
  const stalagmites: number[] = [];
  const wanted = Math.round(cells.length / CAVES.cellsPerStalagmite);
  for (const i of shuffled(cells, random)) {
    if (stalagmites.length >= wanted) break;
    if (chebyshev(i, threshold) <= 1) continue;
    if (!openBehind(open, i) || rockAround(open, i) < 2 || wouldPinch(open, i)) continue;
    if (stalagmites.some((s) => chebyshev(s, i) < CAVES.stalagmiteSpacing)) continue;
    stalagmites.push(i);
    open.delete(i);
  }

  const bats: number[] = [];
  const wantedBats = Math.max(
    1,
    Math.min(CAVES.maxBatsPerCave, Math.round(cells.length / CAVES.cellsPerBat)),
  );
  for (const i of shuffled(cells, random)) {
    if (bats.length >= wantedBats) break;
    if (!open.has(i) || chebyshev(i, threshold) < CAVES.batMouthClearance) continue;
    if (bats.some((b) => chebyshev(b, i) < CAVES.batSpacing)) continue;
    bats.push(i);
  }
  return { z, cells, mouth, stalagmites, bats };
}

function dig(): Cave[] {
  const random = mulberry32(CAVES.seed);
  const taken = new Uint8Array(N);
  const caves: Cave[] = [];
  const levels = Object.keys(map.levels)
    .map(Number)
    .filter((z) => z >= 0)
    .sort((a, b) => a - b);
  const pockets = levels.flatMap((z) => pocketsOn(z).map((cells) => ({ z, cells })));
  pockets.sort((a, b) => b.cells.length - a.cells.length);

  for (const pocket of pockets) {
    if (caves.length >= CAVES.count) break;
    if (pocket.cells.length < CAVES.minCells) continue;
    const cells = roughen(pocket.cells, random);
    if (cells.length < CAVES.minCells) continue;
    const mouth = findMouth(pocket.z, cells, taken);
    if (!mouth) {
      console.log(
        `  no cliff face to open the pocket at ${cellX(cells[0]!)},${cellY(cells[0]!)} L${pocket.z} onto`,
      );
      continue;
    }
    for (const i of [...cells, ...mouth.tunnel]) taken[i] = 1;
    caves.push(furnish(pocket.z, cells, mouth, random));
  }
  return caves;
}

/**
 * Rock left round a cave is drawn as cave wall where it is inside the hill,
 * and stays the hill's own fill wherever it is also the outside of the hill,
 * so a cliff face looks the same from outside whether there is a cave behind
 * it or not.
 */
function write(caves: readonly Cave[]) {
  /** A stream of its own, so choosing tones moves no cave, stalagmite or bat. */
  const tones = mulberry32(CAVES.seed ^ 0x9e7);
  for (const cave of caves) {
    const grey = CAVES.greyShare.min + tones() * (CAVES.greyShare.max - CAVES.greyShare.min);
    const dug = new Set([...cave.cells, ...cave.mouth.tunnel]);
    for (const i of dug) setStack(cave.z, i, [{ tileId: FLOOR }]);
    for (const i of cave.stalagmites)
      setStack(cave.z, i, [
        { tileId: FLOOR },
        { tileId: tones() < grey ? STALAGMITE_GREY : STALAGMITE },
      ]);
    for (const i of cave.bats)
      setStack(cave.z, i, [{ tileId: FLOOR }, { tileId: BAT, direction: "s" }]);

    const shell = new Set<number>();
    for (const i of dug)
      for (const n of ring(i)) if (n !== -1 && !dug.has(n) && solid(cave.z, n)) shell.add(n);
    for (const i of shell) {
      const inside = ring(i).every((n) => dug.has(n) || solid(cave.z, n) || shell.has(n));
      if (inside) setStack(cave.z, i, [{ tileId: FLOOR }, { tileId: WALL }]);
    }
  }
}

function check(caves: readonly Cave[], carved: Flat): string[] {
  const problems: string[] = [];
  const board = toBoard(carved);
  const empty = withoutBodies(carved);
  const after = walk(carved);

  for (const key of before)
    if (!after.has(key)) problems.push(`${key} could be walked to before and cannot now`);

  for (const cave of caves) {
    for (const i of [...cave.cells, ...cave.mouth.tunnel]) {
      if (cave.stalagmites.includes(i)) continue;
      const x = cellX(i);
      const y = cellY(i);
      const standable = listStandingSurfaces(board, x, y, tilesById).some(
        (s) =>
          s.z === cave.z &&
          fitsHeightAtElevation(board, x, y, s.abs, playerDef.height, tilesById, {
            throughPlayers: true,
          }).ok,
      );
      if (cave.bats.includes(i)) {
        const room = fitsHeightAtElevation(
          empty,
          x,
          y,
          cave.z * HEIGHT_PER_LEVEL,
          tilesById[BAT]!.height,
          tilesById,
          {
            throughPlayers: true,
          },
        );
        if (!room.ok) problems.push(`bat at ${x},${y} L${cave.z} has no room: ${room.reason}`);
      } else if (!standable) {
        problems.push(`nobody can stand at ${x},${y} L${cave.z}`);
      }
      if (!after.has(`${x},${y},${cave.z}`)) {
        problems.push(`${x},${y} L${cave.z} cannot be walked to`);
      }
    }
  }

  const occlusion = new Map<string, ReturnType<typeof stackOcclusion>>();
  for (const z of presentLevels(board)) {
    for (const { x, y, stack } of listCoords(board, z)) {
      occlusion.set(`${z}:${coordKey(x, y)}`, stackOcclusion(stack, tilesById));
    }
  }
  const flood = computeLightingFlood(board, tilesById);
  for (const cave of caves) {
    for (const i of cave.cells) {
      if (isSkyExposed(cellX(i), cellY(i), cave.z, occlusion))
        problems.push(`open sky over ${cellX(i)},${cellY(i)} L${cave.z}`);
    }
    const lv = flood.levels.get(cave.z);
    if (!lv) continue;
    let brightest = 0;
    for (const i of cave.cells) {
      if (chebyshev(i, cave.mouth.outside) <= MAX_LIGHT_LEVEL) continue;
      const lx = cellX(i) - lv.x0;
      const ly = cellY(i) - lv.y0;
      if (lx < 0 || ly < 0 || lx >= lv.w || ly >= lv.h) continue;
      brightest = Math.max(brightest, lv.sky[ly * lv.w + lx]!);
    }
    if (brightest > DIM_ENOUGH) {
      problems.push(
        `daylight reaches the back of the cave by ${cellX(cave.mouth.outside)},${cellY(cave.mouth.outside)} at ${brightest}/255`,
      );
    }
  }

  const strandedBefore = findStranded(toBoard(map), tilesById, statusDefs);
  const strandedAfter = findStranded(board, tilesById, statusDefs);
  if (strandedAfter.stranded > strandedBefore.stranded) {
    problems.push(
      `${strandedAfter.stranded} cells can be dropped into and not left, against ${strandedBefore.stranded} before`,
    );
  }
  return problems;
}

console.log("digging…");
const caves = dig();
const carved: Flat = { version: map.version, levels: {} };
for (const [z, cells] of Object.entries(map.levels)) carved.levels[z] = { ...cells };
const original = map.levels;
map.levels = carved.levels;
write(caves);
map.levels = original;

for (const cave of caves) {
  const out = cave.mouth.outside;
  console.log(
    `cave on L${cave.z}: ${cave.cells.length} cells, mouth at ${cellX(out)},${cellY(out)} facing ${cave.mouth.heading}` +
      ` through ${cave.mouth.tunnel.length} cells of tunnel, ${cave.stalagmites.length} stalagmites, ${cave.bats.length} bats`,
  );
}

console.log("walking the map with its caves…");
const problems = check(caves, carved);
if (problems.length > 0) {
  console.error(`${problems.length} problems:`);
  for (const line of problems.slice(0, 40)) console.error(`  ${line}`);
  process.exit(1);
}
console.log("checked against the game's own movement rules and the light baker: no problems");

if (dryRun) {
  console.log("--dry-run: data/map.json left as it was");
} else {
  await Bun.write(MAP_PATH, serializeMap(chunkifyMap(carved as never)));
  console.log(`wrote ${MAP_PATH}`);
}
