import { chunkifyMap, parseMap, serializeMap } from "../app/lib/mapData";
import { statusesById } from "../app/lib/status";
import { findStranded } from "../app/verify/stranded";
import { navigationLegs } from "../app/game/navigation";
import { mulberry32 } from "../app/editor/generator";
import { tilesByIdFromList } from "../app/lib/validation";
import { MAP_FILE_VERSION, coordKey, normalizeTileDef } from "../app/lib/types";
import type { Coord, Direction, MapFile, TileDef } from "../app/lib/types";

const HILLS = {
  seed: 0x51a9e5,

  /** The walled town, kept at level 0 together with `townMargin` cells around it. */
  town: { x0: -39, x1: 23, y0: -38, y1: 11 },
  townMargin: 8,

  /** A cell the reachability walk starts from. It has to be one a player can stand in. */
  start: { x: -8, y: 0 },

  maxLevel: 4,

  /** Cells per noise period: the relief itself, the warp that bends it, and how rugged a region is. */
  reliefScale: 26,
  warpScale: 48,
  warpReach: 14,
  ruggedScale: 95,

  /** The relief value where level 1 starts, and how many levels one unit of relief is worth in flat and in rugged country. */
  seaLevel: 0.03,
  gain: { flat: 3, rugged: 14 },

  /** Level ground kept beside anything that is not open country, wide enough for a ramp to stand on. */
  margin: 3,
  terraceWidth: 3,

  minRegionCells: 28,
  minPitCells: 40,

  /** The least walkable ground, on either side of a cliff, that is worth a ramp. Smaller pieces are levelled into what they were cut from. */
  minUsefulCells: 40,

  rampSpacing: 30,

  /** How many bridges to hang between hilltops, how long one may be, and how far apart they are kept. */
  bridges: 2,
  bridgeSpan: { min: 4, max: 11 },
  bridgeSpacing: 60,
} as const;

const FILL = "half-stone";
const RAMP = "ramp";
const DECK = "wooden-floor";
const RAIL = "fence";

/** What each kind of ground is edged with where it stops at a drop. */
const LEDGE: Record<string, string> = {
  "grass-2": "grass-ledge",
  "sand-dunes": "sand-ledge",
  snow: "snow-ledge",
};
const GROUND = new Set(Object.keys(LEDGE));
const COVER = new Set([
  "grass",
  "tree",
  "dead-tree",
  "small-bush",
  "picked-bush",
  "bush-3",
  "yellow-flowers",
  "red-flowers",
]);

const MAP_PATH = "data/map.json";
const TILES_PATH = "data/tiles.json";
const dryRun = process.argv.includes("--dry-run");

type Placed = { tileId: string; direction?: Direction; [field: string]: unknown };
type Flat = {
  version: typeof MAP_FILE_VERSION;
  levels: Record<string, Record<string, Placed[]>>;
};

const map: Flat = JSON.parse(await Bun.file(MAP_PATH).text());
const tiles: TileDef[] = (JSON.parse(await Bun.file(TILES_PATH).text()) as unknown[]).map((raw) =>
  normalizeTileDef(raw),
);
const tilesById = tilesByIdFromList(tiles);
const playerDef = tilesById["player"]!;

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

type Step = { dx: number; dy: number };
const STEP: Record<Direction, Step> = {
  n: { dx: 0, dy: -1 },
  e: { dx: 1, dy: 0 },
  s: { dx: 0, dy: 1 },
  w: { dx: -1, dy: 0 },
};
const DIRS: Direction[] = ["n", "e", "s", "w"];
const OPPOSITE: Record<Direction, Direction> = { n: "s", e: "w", s: "n", w: "e" };
const SIDEWAYS: Record<Direction, Direction> = { n: "e", e: "s", s: "w", w: "n" };

function neighbour(i: number, dir: Direction, steps = 1): number {
  const x = cellX(i) + STEP[dir].dx * steps;
  const y = cellY(i) + STEP[dir].dy * steps;
  return inBounds(x, y) ? idx(x, y) : -1;
}

function forWithin(i: number, radius: number, visit: (n: number) => void) {
  const x = cellX(i);
  const y = cellY(i);
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (inBounds(x + dx, y + dy)) visit(idx(x + dx, y + dy));
    }
  }
}

function toBoard(flat: Flat): MapFile {
  const levels: Flat["levels"] = {};
  for (const [z, cells] of Object.entries(flat.levels)) {
    const out: Record<string, Placed[]> = {};
    for (const [key, stack] of Object.entries(cells)) {
      const kept = stack.filter((placed) => tilesById[placed.tileId]?.kind !== "battler");
      if (kept.length > 0) out[key] = kept;
    }
    levels[z] = out;
  }
  return parseMap(serializeMap(chunkifyMap({ version: flat.version, levels } as never)));
}

const cellKey = (c: Coord) => `${c.x},${c.y},${c.z}`;

/**
 * `reachableCells` without its drops: a body can step off a ledge and fall, so
 * counting those legs would call a hilltop reachable when nothing leads up it.
 */
function reachableOnFoot(board: MapFile, start: Coord): Set<string> {
  const world = { board, traveller: playerDef, tilesById, statusDefs: {} };
  const seen = new Set<string>([cellKey(start)]);
  const queue: Coord[] = [start];
  for (let head = 0; head < queue.length; head++) {
    for (const leg of navigationLegs(world, queue[head]!)) {
      if (leg.kind === "walk" && leg.drop) continue;
      const key = cellKey(leg.to);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(leg.to);
    }
  }
  return seen;
}

function perlin(seed: number): (x: number, y: number) => number {
  const random = mulberry32(seed);
  const perm = new Uint8Array(512);
  const order = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  for (let i = 0; i < 512; i++) perm[i] = order[i & 255]!;

  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const dot = (hash: number, x: number, y: number) => {
    const angle = (hash & 15) * (Math.PI / 8);
    return Math.cos(angle) * x + Math.sin(angle) * y;
  };

  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const corner = (cx: number, cy: number) =>
      dot(perm[perm[(xi + cx) & 255]! + ((yi + cy) & 255)]!, xf - cx, yf - cy);
    const u = fade(xf);
    const v = fade(yf);
    return (
      lerp(lerp(corner(0, 0), corner(1, 0), u), lerp(corner(0, 1), corner(1, 1), u), v) * Math.SQRT2
    );
  };
}

function fbm(noise: (x: number, y: number) => number, x: number, y: number, octaves: number) {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let frequency = 1;
  for (let octave = 0; octave < octaves; octave++) {
    sum += noise(x * frequency, y * frequency) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / total;
}

/**
 * Relief sampled through a second noise field that displaces the sample point,
 * which bends the round blobs of plain fractal noise into ridges and spurs. A
 * third, much wider field sets how steep a region is, so the high ground
 * gathers into ranges with rolling country between them.
 */
function heightField(): Float32Array {
  const relief = perlin(HILLS.seed);
  const warpX = perlin(HILLS.seed ^ 0x9e3779b9);
  const warpY = perlin(HILLS.seed ^ 0x85ebca6b);
  const rugged = perlin(HILLS.seed ^ 0xc2b2ae35);

  const field = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = cellX(i);
    const y = cellY(i);
    const wx = fbm(warpX, x / HILLS.warpScale, y / HILLS.warpScale, 2) * HILLS.warpReach;
    const wy = fbm(warpY, x / HILLS.warpScale, y / HILLS.warpScale, 2) * HILLS.warpReach;
    const value = fbm(relief, (x + wx) / HILLS.reliefScale, (y + wy) / HILLS.reliefScale, 4);
    const steep = Math.min(
      1,
      Math.max(0, fbm(rugged, x / HILLS.ruggedScale, y / HILLS.ruggedScale, 2) + 0.5),
    );
    const gain = HILLS.gain.flat + (HILLS.gain.rugged - HILLS.gain.flat) * steep * steep;
    field[i] = (value - HILLS.seaLevel) * gain + 1;
  }
  return field;
}

const stackAt = (i: number): Placed[] => surface[coordKey(cellX(i), cellY(i))] ?? [];

const upperLevels = Object.keys(map.levels).filter((z) => Number(z) >= 1);
const ledges = new Set(Object.values(LEDGE));
if (
  Object.values(map.levels).some((cells) =>
    Object.values(cells).some((stack) => stack.some((placed) => ledges.has(placed.tileId))),
  )
) {
  console.error("raise:hills: this map already has its hills. Start from a map without them.");
  process.exit(1);
}

const raisable = new Uint8Array(N);
/** Cells a bridge may pass over: nothing built above them, outside the town, and nothing standing on them a deck one level up would cut through. */
const spannable = new Uint8Array(N);
for (let i = 0; i < N; i++) {
  const x = cellX(i);
  const y = cellY(i);
  const stack = stackAt(i);
  const plain =
    stack.length > 0 &&
    GROUND.has(stack[0]!.tileId) &&
    stack.every(
      (placed, at) =>
        Object.keys(placed).every((field) => field === "tileId") &&
        (at === 0 || COVER.has(placed.tileId)),
    );
  const inTown =
    x >= HILLS.town.x0 - HILLS.townMargin &&
    x <= HILLS.town.x1 + HILLS.townMargin &&
    y >= HILLS.town.y0 - HILLS.townMargin &&
    y <= HILLS.town.y1 + HILLS.townMargin;
  const builtOver = upperLevels.some((z) => map.levels[z]![coordKey(x, y)] !== undefined);
  raisable[i] = plain && !inTown && !builtOver ? 1 : 0;
  const low = stack.every((placed) => (tilesById[placed.tileId]?.height ?? 0) === 0);
  spannable[i] = raisable[i] || (stack.length > 0 && low && !inTown && !builtOver) ? 1 : 0;
}

const cap = new Uint8Array(N);
{
  const distance = new Int32Array(N).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < N; i++) {
    if (raisable[i]) continue;
    distance[i] = 0;
    queue.push(i);
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    forWithin(i, 1, (n) => {
      if (distance[n] !== -1) return;
      distance[n] = distance[i]! + 1;
      queue.push(n);
    });
  }
  for (let i = 0; i < N; i++) cap[i] = distance[i]! >= HILLS.margin ? HILLS.maxLevel : 0;
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
  return out;
}

const field = heightField();
const lift = new Uint8Array(N);

function terraces(): Uint8Array {
  const level = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    level[i] = Math.max(0, Math.min(cap[i]!, Math.max(lift[i]!, Math.floor(field[i]!))));
  }

  for (let l = 1; l <= HILLS.maxLevel; l++) {
    for (const pit of regions((i) => level[i]! < l)) {
      if (pit.length >= HILLS.minPitCells) continue;
      if (pit.some((i) => cap[i]! < l)) continue;
      for (const i of pit) level[i] = l;
    }
  }

  /**
   * Each level stands on a shelf of the level below at least `terraceWidth`
   * wide, which is what leaves room for a ramp at every cliff and keeps two
   * cliffs from stacking into one wall two levels tall.
   */
  for (let l = 2; l <= HILLS.maxLevel; l++) {
    const keep = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (level[i]! < l) continue;
      let wide = true;
      forWithin(i, HILLS.terraceWidth, (n) => {
        if (level[n]! < l - 1) wide = false;
      });
      keep[i] = wide ? 1 : 0;
    }
    for (let i = 0; i < N; i++) {
      if (level[i]! >= l && !keep[i]) level[i] = l - 1;
    }
  }

  for (let l = 1; l <= HILLS.maxLevel; l++) {
    for (const region of regions((i) => level[i]! >= l)) {
      if (region.length >= HILLS.minRegionCells) continue;
      for (const i of region) level[i] = l - 1;
    }
  }
  return level;
}

console.log("walking the map as it stands…");
const before = reachableOnFoot(toBoard(map), { ...HILLS.start, z: 0 });
const open = new Uint8Array(N);
for (let i = 0; i < N; i++) open[i] = before.has(`${cellX(i)},${cellY(i)},0`) ? 1 : 0;

function unionFind() {
  const parent = new Int32Array(N);
  for (let i = 0; i < N; i++) parent[i] = i;
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[i] !== root) {
      const next = parent[i]!;
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  return { find, union };
}

/** `low`, `high`: the two ramp cells; `foot`, `head`: the open cells it joins. `climbs` is the way up. */
type Ramp = {
  foot: number;
  low: number;
  high: number;
  head: number;
  climbs: Direction;
  rank: number;
};

function rampSites(level: Uint8Array): Ramp[] {
  const random = mulberry32(HILLS.seed ^ 0x27d4eb2f);
  const out: Array<Ramp & { order: number }> = [];
  for (let head = 0; head < N; head++) {
    const l = level[head]!;
    if (l === 0 || !open[head]) continue;
    for (const climbs of DIRS) {
      const down = OPPOSITE[climbs];
      const high = neighbour(head, down, 1);
      const low = neighbour(head, down, 2);
      const foot = neighbour(head, down, 3);
      if (high === -1 || low === -1 || foot === -1) continue;
      if (level[high] !== l - 1 || level[low] !== l - 1 || level[foot] !== l - 1) continue;
      if (!raisable[high] || !raisable[low] || !open[foot]) continue;

      const side = SIDEWAYS[climbs];
      /**
       * The upper ramp cell is a wall to anybody walking along the foot of the
       * cliff, and the lower one can be stepped over. So ground beside the
       * upper cell needs open ground beside the lower one to go round by.
       */
      const passable = [side, OPPOSITE[side]].every((d) => {
        const besideHigh = neighbour(high, d);
        const besideLow = neighbour(low, d);
        return (
          besideHigh === -1 || !open[besideHigh] || (besideLow !== -1 && open[besideLow] === 1)
        );
      });
      if (!passable) continue;
      const straight = [side, OPPOSITE[side]].every((d) => {
        const besideHead = neighbour(head, d);
        const besideHigh = neighbour(high, d);
        return (
          besideHead !== -1 &&
          besideHigh !== -1 &&
          level[besideHead] === l &&
          level[besideHigh] === l - 1
        );
      });
      /** South and east faces are the ones the projection shows, so a ramp there can be seen from below. */
      const faced = climbs === "n" || climbs === "w";
      const rank = (straight ? 0 : 2) + (faced ? 0 : 1);
      out.push({ foot, low, high, head, climbs, rank, order: random() });
    }
  }
  return out.sort((a, b) => a.rank - b.rank || a.order - b.order);
}

type Plan = {
  level: Uint8Array;
  ramps: Ramp[];
  severed: Array<[number, number]>;
  /** The walkable ground a cell shares its level with, by a cell that stands for it, and how many cells that is. */
  shelfOf: (i: number) => number;
  shelfCells: Int32Array;
};

function plan(): Plan {
  const level = terraces();
  const sites = rampSites(level);

  const joined = unionFind();
  const wasJoined = unionFind();
  const shelf = unionFind();
  for (let i = 0; i < N; i++) {
    if (!open[i]) continue;
    for (const dir of ["e", "s"] as const) {
      const n = neighbour(i, dir);
      if (n === -1 || !open[n]) continue;
      wasJoined.union(i, n);
      if (level[i] !== level[n]) continue;
      joined.union(i, n);
      shelf.union(i, n);
    }
  }
  const shelfCells = new Int32Array(N);
  for (let i = 0; i < N; i++) if (open[i]) shelfCells[shelf.find(i)]!++;
  const useful = (ramp: Ramp) =>
    shelfCells[shelf.find(ramp.foot)]! >= HILLS.minUsefulCells &&
    shelfCells[shelf.find(ramp.head)]! >= HILLS.minUsefulCells;

  const taken = new Uint8Array(N);
  const ramps: Ramp[] = [];
  const build = (ramp: Ramp) => {
    ramps.push(ramp);
    for (const i of [ramp.foot, ramp.low, ramp.high, ramp.head]) taken[i] = 1;
    joined.union(ramp.foot, ramp.head);
  };
  const free = (ramp: Ramp) =>
    useful(ramp) && !taken[ramp.foot] && !taken[ramp.low] && !taken[ramp.high] && !taken[ramp.head];

  for (const ramp of sites) {
    if (ramp.rank >= 2 || !free(ramp)) continue;
    const x = cellX(ramp.head);
    const y = cellY(ramp.head);
    const crowded = ramps.some(
      (other) =>
        Math.max(Math.abs(cellX(other.head) - x), Math.abs(cellY(other.head) - y)) <
        HILLS.rampSpacing,
    );
    if (!crowded) build(ramp);
  }
  for (const ramp of sites) {
    if (free(ramp) && joined.find(ramp.foot) !== joined.find(ramp.head)) build(ramp);
  }

  const severed: Array<[number, number]> = [];
  for (let i = 0; i < N; i++) {
    if (!open[i]) continue;
    for (const dir of ["e", "s"] as const) {
      const n = neighbour(i, dir);
      if (n === -1 || !open[n] || joined.find(i) === joined.find(n)) continue;
      if (wasJoined.find(i) === wasJoined.find(n)) severed.push([i, n]);
    }
  }
  return { level, ramps, severed, shelfOf: shelf.find, shelfCells };
}

/** The cells of every shelf too small for a ramp, by the cell that stands for the shelf. */
function smallShelves(attempt: Plan): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (let i = 0; i < N; i++) {
    if (!open[i]) continue;
    const shelf = attempt.shelfOf(i);
    if (attempt.shelfCells[shelf]! >= HILLS.minUsefulCells) continue;
    const cells = out.get(shelf);
    if (cells) cells.push(i);
    else out.set(shelf, [i]);
  }
  return out;
}

/**
 * Ground that used to be one piece and is now cut by a cliff no ramp crosses
 * is put back on one level, and the terraces are cut again. A piece too small
 * for a ramp joins the largest piece it was cut from, up or down; a lift the
 * terraces refuse would be asked for again for ever, so lifting stops after
 * `LIFT_ROUNDS` and everything left is lowered, which caps only ever do.
 */
const LIFT_ROUNDS = 6;

function settledPlan(): Plan {
  for (let round = 1; ; round++) {
    const attempt = plan();
    if (attempt.severed.length === 0) return attempt;
    console.log(`  round ${round}: ${attempt.severed.length} cliff edges no ramp can cross`);

    const small = smallShelves(attempt);
    const joins = new Map<number, { level: number; cells: number }>();
    const lower = (a: number, b: number) => {
      const floor = Math.min(attempt.level[a]!, attempt.level[b]!);
      for (const i of [a, b]) {
        forWithin(i, HILLS.terraceWidth, (n) => {
          cap[n] = Math.min(cap[n]!, floor);
        });
      }
    };

    for (const [a, b] of attempt.severed) {
      const sides = [
        [a, b],
        [b, a],
      ] as const;
      let merged = false;
      for (const [piece, other] of sides) {
        const shelf = attempt.shelfOf(piece);
        if (!small.has(shelf)) continue;
        merged = true;
        const cells = attempt.shelfCells[attempt.shelfOf(other)]!;
        if (cells > (joins.get(shelf)?.cells ?? -1)) {
          joins.set(shelf, { level: attempt.level[other]!, cells });
        }
      }
      if (!merged) lower(a, b);
    }

    for (const [shelf, join] of joins) {
      const cells = small.get(shelf)!;
      const from = attempt.level[shelf]!;
      if (join.level < from) {
        for (const i of cells) cap[i] = Math.min(cap[i]!, join.level);
      } else if (round <= LIFT_ROUNDS && cells.every((i) => cap[i]! >= join.level)) {
        for (const i of cells) lift[i] = join.level;
      } else {
        for (const i of cells) {
          forWithin(i, HILLS.terraceWidth, (n) => {
            cap[n] = Math.min(cap[n]!, from);
          });
        }
      }
    }
  }
}

/** `from` is the hilltop cell the deck leaves; the deck is the `length` cells beyond it, with a railed cell on either side of each. */
type Bridge = { from: number; across: Direction; length: number };

function bridgeCells(bridge: Bridge): Array<{ deck: number; rails: [number, number] }> {
  const side = SIDEWAYS[bridge.across];
  return Array.from({ length: bridge.length }, (_, step) => {
    const deck = neighbour(bridge.from, bridge.across, step + 1);
    return { deck, rails: [neighbour(deck, side), neighbour(deck, OPPOSITE[side])] };
  });
}

/**
 * A bridge joins two pieces of high ground that are worth a ramp each and are
 * not already one piece, in a straight line over lower ground. The ones that
 * cross something a hill could not be raised on, a path or a river, are taken
 * first, because that is where a player walking below sees one overhead.
 */
function bridgeSites({ level, ramps, shelfOf, shelfCells }: Plan): Bridge[] {
  const blocked = new Uint8Array(N);
  for (const ramp of ramps) blocked[ramp.low] = blocked[ramp.high] = 1;
  const under = (i: number, l: number) =>
    i !== -1 &&
    !blocked[i] &&
    spannable[i] === 1 &&
    level[i]! < l &&
    (level[i]! < l - 1 || raisable[i] === 1 || stackAt(i).length === 1);
  const worth = (i: number) => open[i] === 1 && shelfCells[shelfOf(i)]! >= HILLS.minUsefulCells;

  const random = mulberry32(HILLS.seed ^ 0x165667b1);
  const sites: Array<Bridge & { rank: number }> = [];
  for (let from = 0; from < N; from++) {
    const l = level[from]!;
    if (l === 0 || !worth(from)) continue;
    for (const across of ["e", "s"] as const) {
      for (let length = 1; length <= HILLS.bridgeSpan.max; length++) {
        const to = neighbour(from, across, length + 1);
        if (to === -1) break;
        const cells = bridgeCells({ from, across, length });
        if (
          !cells.every(({ deck, rails }) => under(deck, l) && rails.every((rail) => under(rail, l)))
        )
          break;
        if (level[to] !== l) continue;
        if (length < HILLS.bridgeSpan.min || !worth(to) || shelfOf(to) === shelfOf(from)) break;
        const crosses = cells.some(({ deck }) => !raisable[deck]);
        sites.push({ from, across, length, rank: (crosses ? 0 : 1) + random() });
        break;
      }
    }
  }
  sites.sort((a, b) => a.rank - b.rank);

  const out: Bridge[] = [];
  for (const site of sites) {
    if (out.length === HILLS.bridges) break;
    const far = out.every(
      (other) =>
        Math.max(
          Math.abs(cellX(other.from) - cellX(site.from)),
          Math.abs(cellY(other.from) - cellY(site.from)),
        ) >= HILLS.bridgeSpacing,
    );
    if (far) out.push(site);
  }
  return out;
}

/** `railed` are the cells of ground a bridge's rails now stand on, which nobody walks on any more. */
function build(
  level: Uint8Array,
  ramps: readonly Ramp[],
  bridges: readonly Bridge[],
): { flat: Flat; railed: Set<number> } {
  const railed = new Set<number>();
  const levels: Flat["levels"] = {};
  for (const [z, cells] of Object.entries(map.levels)) levels[z] = { ...cells };
  const cells = (z: number) => (levels[String(z)] ??= {});

  for (let i = 0; i < N; i++) {
    const l = level[i]!;
    if (l === 0) continue;
    const key = coordKey(cellX(i), cellY(i));
    const stack = stackAt(i);
    const ground = { tileId: stack[0]!.tileId };
    for (let z = 0; z < l; z++) cells(z)[key] = [ground, { tileId: FILL }, { tileId: FILL }];
    let atDrop = false;
    forWithin(i, 1, (n) => {
      if (level[n]! < l) atDrop = true;
    });
    cells(l)[key] = atDrop ? [ground, { tileId: LEDGE[ground.tileId]! }, ...stack.slice(1)] : stack;
  }

  for (const ramp of ramps) {
    const z = level[ramp.low]!;
    const direction = OPPOSITE[ramp.climbs];
    const ground = (i: number) => ({ tileId: stackAt(i)[0]!.tileId });
    cells(z)[coordKey(cellX(ramp.low), cellY(ramp.low))] = [
      ground(ramp.low),
      { tileId: RAMP, direction },
    ];
    cells(z)[coordKey(cellX(ramp.high), cellY(ramp.high))] = [
      ground(ramp.high),
      { tileId: FILL },
      { tileId: RAMP, direction },
    ];
  }

  const rampCells = new Set(ramps.flatMap((ramp) => [ramp.foot, ramp.low, ramp.high, ramp.head]));
  for (const bridge of bridges) {
    const z = level[bridge.from]!;
    for (const { deck, rails } of bridgeCells(bridge)) {
      for (const i of [deck, ...rails]) {
        const key = coordKey(cellX(i), cellY(i));
        cells(z)[key] = i === deck ? [{ tileId: DECK }] : [{ tileId: DECK }, { tileId: RAIL }];
        /** A tree one level down is as tall as the gap, and would stand through the deck. */
        if (level[i] !== z - 1 || !raisable[i]) continue;
        cells(z - 1)[key] = cells(z - 1)[key]!.filter((placed) => !COVER.has(placed.tileId));
      }
    }

    /**
     * `wooden-floor` is drawn short of the edge of its cell, so a deck that
     * stopped at the gap would end before the ground began. It runs one cell
     * onto the ground at each end, rails and all, as the bridge west of the
     * town stands on its banks.
     */
    const side = SIDEWAYS[bridge.across];
    for (const step of [0, bridge.length + 1]) {
      const landing = neighbour(bridge.from, bridge.across, step);
      for (const i of [landing, neighbour(landing, side), neighbour(landing, OPPOSITE[side])]) {
        if (i === -1 || level[i] !== z || !raisable[i]) continue;
        if (i !== landing && rampCells.has(i)) continue;
        const ground = { tileId: stackAt(i)[0]!.tileId };
        cells(z)[coordKey(cellX(i), cellY(i))] =
          i === landing ? [ground, { tileId: DECK }] : [ground, { tileId: DECK }, { tileId: RAIL }];
        if (i !== landing) railed.add(i);
      }
    }
  }
  return { flat: { version: map.version, levels }, railed };
}

console.log("cutting terraces and placing ramps…");
const settled = settledPlan();
const { level, ramps } = settled;
const bridges = bridgeSites(settled);
const { flat: raised, railed } = build(level, ramps, bridges);

console.log("walking the map with its hills…");
const after = reachableOnFoot(toBoard(raised), { ...HILLS.start, z: 0 });
const rampCell = new Uint8Array(N);
for (const ramp of ramps) rampCell[ramp.low] = rampCell[ramp.high] = 1;

const lost: string[] = [];
for (const key of before) {
  const [x, y, z] = key.split(",").map(Number) as [number, number, number];
  const lifted = z === 0 && inBounds(x, y) ? level[idx(x, y)]! : 0;
  if (z === 0 && inBounds(x, y) && (rampCell[idx(x, y)] || railed.has(idx(x, y)))) continue;
  if (!after.has(`${x},${y},${z + lifted}`)) lost.push(`${x},${y} L${z + lifted}`);
}

const count = (l: number) => level.reduce((n, at) => n + (at >= l ? 1 : 0), 0);
const land = raisable.reduce((n, at) => n + at, 0);
console.log(
  `open country ${land} cells; raised ${count(1)}` +
    Array.from({ length: HILLS.maxLevel - 1 }, (_, i) => `, level ${i + 2}+ ${count(i + 2)}`).join(
      "",
    ) +
    `; ${ramps.length} ramps`,
);
for (const bridge of bridges) {
  console.log(
    `bridge on level ${level[bridge.from]} from ${cellX(bridge.from)},${cellY(bridge.from)}, ${bridge.length} cells ${bridge.across}`,
  );
}
{
  const climbed = new Uint8Array(N);
  for (const ramp of ramps) climbed[ramp.head] = 1;
  const hills = regions((i) => level[i]! >= 1);
  const withRamp = hills.filter((hill) => hill.some((i) => climbed[i])).length;
  console.log(
    `${hills.length} hills: ${withRamp} with a ramp, ${hills.length - withRamp} with nothing but trees on top`,
  );
}
console.log(`on foot before ${before.size} cells, after ${after.size}`);

if (lost.length > 0) {
  console.error(`${lost.length} cells a player could walk to can no longer be walked to:`);
  for (const line of lost.slice(0, 40)) console.error(`  ${line}`);
  process.exit(1);
}

const statusDefs = statusesById(JSON.parse(await Bun.file("data/statuses.json").text()));
const strandedBefore = findStranded(toBoard(map), tilesById, statusDefs);
const strandedAfter = findStranded(toBoard(raised), tilesById, statusDefs);
if (strandedAfter.stranded > strandedBefore.stranded) {
  console.error(
    `${strandedAfter.stranded} cells can be dropped into and not left, against ${strandedBefore.stranded} before:`,
  );
  for (const region of strandedAfter.regions.slice(0, 20)) {
    const at = region.cells[0]!;
    console.error(`  ${region.cells.length} cells around ${at.x},${at.y} L${at.z}`);
  }
  process.exit(1);
}

if (dryRun) {
  console.log("--dry-run: data/map.json left as it was");
} else {
  await Bun.write(MAP_PATH, serializeMap(chunkifyMap(raised as never)));
  console.log(`wrote ${MAP_PATH}`);
}
