import type { PlacedTile } from "../../app/lib/types";
import { Board, tile } from "./board";
import { N4, N8 } from "./grid";
import { OPPOSITE, SIDEWAYS, STEP, TALL_FALL_STOREYS, type Plan } from "./plan";
import { Ground, type Island } from "./terrain";

type Kind = "grass" | "sand" | "snow" | "basalt";

const KIND: Record<number, Kind> = {
  [Ground.Grass]: "grass",
  [Ground.Woods]: "grass",
  [Ground.DeepWoods]: "grass",
  [Ground.Bog]: "grass",
  [Ground.Lake]: "grass",
  [Ground.River]: "grass",
  [Ground.Beach]: "sand",
  [Ground.Shallows]: "sand",
  [Ground.Desert]: "sand",
  [Ground.Basalt]: "basalt",
  [Ground.Lava]: "basalt",
  [Ground.Snow]: "snow",
  [Ground.Rock]: "snow",
};

const BASE: Record<Kind, string> = {
  grass: "grass-2",
  sand: "sand-dunes",
  snow: "snow",
  basalt: "sand-dunes",
};
const WALL: Record<Kind, string> = {
  grass: "hill-wall",
  sand: "hill-wall-sandstone",
  snow: "hill-wall-frost",
  basalt: "hill-wall-basalt",
};
const BRINK: Record<Kind, string> = {
  grass: "grass-brink",
  sand: "sand-brink",
  snow: "snow-brink",
  basalt: "basalt-brink",
};

/** What a ramp is made of on each ground: the slope, and the half-height block the top half of the climb stands on. */
const RAMP: Record<Kind, { slope: string; block: string }> = {
  grass: { slope: "ramp", block: "half-stone" },
  sand: { slope: "ramp", block: "half-stone" },
  snow: { slope: "snowy-ramp", block: "frosted-half-stone" },
  basalt: { slope: "ramp", block: "half-stone" },
};

/**
 * What a raised column is filled with under its wall. Basalt is a layer over
 * sand, so without it in the wall cells the basalt at a cliff's foot draws its
 * sandy autotile edge against every one of them.
 */
const UNDER_WALL: Record<Kind, string[]> = {
  grass: ["grass-2"],
  sand: ["sand-dunes"],
  snow: ["snow"],
  basalt: ["sand-dunes", "basalt"],
};

const KINDS: readonly Kind[] = ["grass", "sand", "snow", "basalt"];
/** How far out a river looks for the land it runs through, past the cells its own banks may have changed. */
const BANK_RING_INNER_CELLS = 2;
const BANK_RING_OUTER_CELLS = 5;
const bankKinds = new WeakMap<Island, Uint8Array>();

const isRiverWater = (g: number) => g === Ground.River || g === Ground.Lake;

/**
 * The kind of land each river and lake cell runs through: the kind most of
 * the dry land in a ring round its stretch had before the rivers were cut,
 * so a river through the snow has snow banks rather than a strip of meadow.
 * A stretch is the river and lake on one level. Mud and water draw an edge
 * in the ground under them towards a cell of another ground, so where a
 * river changed ground within one level the cells at the change would be
 * pulled to both and show a line of one; at a drop to another level nothing
 * joins across, so a river changes ground only where it falls.
 */
function bankKindsOf(island: Island): Uint8Array {
  const known = bankKinds.get(island);
  if (known) return known;
  const { width: w, height: h, ground, level } = island;
  const out = new Uint8Array(w * h);
  const seen = new Uint8Array(w * h);
  const counts = new Int32Array(KINDS.length);
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || !isRiverWater(ground[start]!)) continue;
    const stretch = [start];
    seen[start] = 1;
    counts.fill(0);
    for (let k = 0; k < stretch.length; k++) {
      const i = stretch[k]!;
      countRing(island, i, counts);
      forNeighbours(w, h, i, N4, (j) => {
        if (seen[j] || !isRiverWater(ground[j]!) || level[j] !== level[i]) return;
        seen[j] = 1;
        stretch.push(j);
      });
    }
    let best = 0;
    for (let k = 1; k < KINDS.length; k++) if (counts[k]! > counts[best]!) best = k;
    for (const i of stretch) out[i] = best;
  }
  bankKinds.set(island, out);
  return out;
}

function countRing(island: Island, i: number, counts: Int32Array) {
  const { width: w, height: h, biome } = island;
  const x = i % w;
  const y = (i - x) / w;
  for (let dy = -BANK_RING_OUTER_CELLS; dy <= BANK_RING_OUTER_CELLS; dy++) {
    for (let dx = -BANK_RING_OUTER_CELLS; dx <= BANK_RING_OUTER_CELLS; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      const inside = Math.max(Math.abs(dx), Math.abs(dy)) <= BANK_RING_INNER_CELLS;
      if (inside || nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const g = biome[ny * w + nx]!;
      if (isRiverWater(g) || g === Ground.DeepSea || g === Ground.Shallows) continue;
      const kind = KIND[g];
      /** A lava field stands on sand, so a river through one runs on sand, as `verify landscape` reads it. */
      if (kind) counts[KINDS.indexOf(kind === "basalt" ? "sand" : kind)]!++;
    }
  }
}

export const kindAt = (island: Island, i: number): Kind =>
  isRiverWater(island.ground[i]!)
    ? KINDS[bankKindsOf(island)[i]!]!
    : (KIND[island.ground[i]!] ?? "grass");

/** River water over the ground it runs through: on grass a bed of dirt, so no grass shows round the water. */
function riverStack(kind: Kind): PlacedTile[] {
  return kind === "grass"
    ? [tile("grass-2"), tile("dirt"), tile("water")]
    : [tile(BASE[kind]), tile("water")];
}

/**
 * The storeys of a raised column where a neighbour's ground lies, which are
 * the only storeys whose wall needs ground under it: there the ground or brink
 * beside it would otherwise draw its edge against the wall. A wall stacked on
 * another wall stands on rock, and ground under it shows through the dents in
 * the wall's foot.
 */
function storeysWithFoot(island: Island, i: number): Set<number> {
  const feet = new Set<number>();
  forNeighbours(island.width, island.height, i, N8, (j) => feet.add(island.level[j]!));
  return feet;
}

/** The shallow edge of a lake, which is a shore and has no bank. */
function shoreStack(kind: Kind): PlacedTile[] {
  return kind === "grass"
    ? [tile("grass-2"), tile("dirt"), tile("water")]
    : [tile(BASE[kind]), tile("water")];
}
export const baseTile = (island: Island, i: number) => BASE[kindAt(island, i)];

/**
 * Lays the ground: a filled column under every raised cell, its top cut to a
 * brink where the wall below it has open air beside it (`docs/terrain.md`),
 * water and its beds, the sea ring with foam along the sand, then the ramps,
 * bridges and roads the plan placed.
 */
export function writeTerrain(island: Island, plan: Plan): Board {
  const { width: w, height: h, level, ground } = island;
  const n = w * h;
  const beach = island.place("wreckBeach");
  const board = new Board(w, h, -beach.x, -beach.y);
  const heads = new Set(plan.ramps.map((r) => r.head));
  const lakeDepth = depthIn(island, (i) => ground[i] === Ground.Lake);
  const shore = shoreOf(island);
  const lavaNear = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (ground[i] !== Ground.Lava) continue;
    forNeighbours(w, h, i, N8, (j) => {
      if (ground[j] !== Ground.Lava) lavaNear[j] = 1;
    });
  }

  const besideGrass = new Uint8Array(n);
  const besideShallows = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    forNeighbours(w, h, i, N8, (j) => {
      if (KIND[ground[j]!] === "grass" && level[j]! >= 0) besideGrass[i] = 1;
      if (ground[j] === Ground.Shallows) besideShallows[i] = 1;
    });
  }

  for (let i = 0; i < n; i++) {
    const L = level[i]!;
    if (L < 0) continue;
    const x = i % w;
    const y = (i - x) / w;
    const g = ground[i]!;
    if (g === Ground.DeepSea || g === Ground.Shallows) {
      board.set(x, y, 0, seaStack(island, i));
      continue;
    }
    if (
      besideShallows[i] &&
      L === 0 &&
      KIND[g] === "grass" &&
      g !== Ground.River &&
      g !== Ground.Lake
    )
      ground[i] = Ground.Beach;
    if (g === Ground.Basalt && besideGrass[i]) ground[i] = Ground.Desert;
    const kind = kindAt(island, i);
    const base = BASE[kind];
    const feet = storeysWithFoot(island, i);
    for (let z = 0; z < L; z++) {
      const wall = [tile(WALL[kind])];
      board.set(
        x,
        y,
        z,
        heads.has(i) && z === L - 1
          ? [tile(base), tile(RAMP[kind].block), tile(RAMP[kind].block)]
          : feet.has(z)
            ? [...UNDER_WALL[kind].map((id) => tile(id)), ...wall]
            : wall,
      );
    }
    let drop = false;
    forNeighbours(w, h, i, N8, (j) => {
      if (level[j]! < L) drop = true;
    });
    const edge = drop && !heads.has(i) && L > 0;
    const ground0 = edge ? BRINK[kind] : base;
    let top: PlacedTile[];
    switch (ground[i]) {
      case Ground.River:
        top = besideShore(island, shore, i) ? shoreStack(kind) : riverStack(kind);
        break;
      case Ground.Lake:
        top = lakeDepth[i]! <= 1 ? shoreStack(kind) : [tile("water"), tile("deep-water")];
        break;
      case Ground.Bog:
        top = bogPond(island, i)
          ? [tile("grass-2"), tile("dirt"), tile("mud"), tile("water"), tile("swamp")]
          : [tile(ground0), tile("mud")];
        break;
      case Ground.Lava:
        top = [tile("sand-dunes"), tile("basalt"), tile("lava-crust"), tile("lava")];
        break;
      case Ground.Basalt:
        top = edge
          ? [tile(ground0)]
          : lavaNear[i]
            ? [tile("sand-dunes"), tile("basalt"), tile("lava-crust")]
            : [tile("sand-dunes"), tile("basalt")];
        break;
      default:
        top = [tile(ground0)];
    }
    board.set(x, y, L, top);
  }

  bedRivers(island, board);

  for (const r of plan.ramps) {
    const z = level[r.low]!;
    const direction = OPPOSITE[r.climbs];
    const lx = r.low % w;
    const hx = r.high % w;
    /** Both cells take the high one's ground, so a ramp on the edge of the snow is not half of each. */
    const { slope, block } = RAMP[kindAt(island, r.high)];
    board.set(lx, Math.floor(r.low / w), z, [
      tile(baseTile(island, r.low)),
      tile(slope, direction),
    ]);
    board.set(hx, Math.floor(r.high / w), z, [
      tile(baseTile(island, r.high)),
      tile(block),
      tile(slope, direction),
    ]);
  }

  for (let i = 0; i < n; i++) {
    if (!plan.road[i] || plan.reserved[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    const stack = board.get(x, y, level[i]!);
    if (!stack || !(stack.length === 1 || (stack.length === 2 && isBank(stack)))) continue;
    board.set(x, y, level[i]!, [tile(baseTile(island, i)), tile("dirt")]);
  }

  for (const bridge of plan.bridges) {
    const side = SIDEWAYS[bridge.across];
    for (const c of bridge.cells) {
      for (const o of [0, 1, -1]) {
        const x = (c % w) + STEP[side][0] * o;
        const y = Math.floor(c / w) + STEP[side][1] * o;
        const under = board.get(x, y, bridge.level) ?? [];
        const kept = under.filter((p) => p.tileId !== "dirt" || ground[y * w + x] === Ground.River);
        board.set(
          x,
          y,
          bridge.level,
          o === 0
            ? [...kept, tile("wooden-floor")]
            : [...kept, tile("wooden-floor"), tile("fence")],
        );
      }
    }
  }
  widenPlunges(island, plan, board);
  placeWaterfalls(island, board);
  return board;
}

/**
 * A fall stands in the lower cell, against the face of the cliff it comes
 * down, and only a cliff's south and east faces are drawn: water leaving a
 * cliff north or west goes over an edge nobody can see.
 */
const FALLS = [
  { dx: 0, dy: -1, segments: ["waterfall-base", "waterfall-middle", "waterfall-top"] },
  {
    dx: -1,
    dy: 0,
    segments: ["waterfall-east-base", "waterfall-east-middle", "waterfall-east-top"],
  },
] as const;

/** Two segments are one storey: a base and a top for one, with middles between them for every storey more. */
const SEGMENTS_PER_STOREY = 2;

function fallSegments(fall: (typeof FALLS)[number], storeys: number): PlacedTile[] {
  const [base, middle, top] = fall.segments;
  const middles = Array.from({ length: storeys * SEGMENTS_PER_STOREY - 2 }, () => tile(middle));
  return [tile(base), ...middles, tile(top)];
}

const FALLING_WATER = new Set([Ground.River, Ground.Lake]);

/**
 * A fall is as many storeys as the cliff it comes down: one everywhere but
 * the tall fall off the snow (`raiseTallFall`). A cell is given one fall at
 * most: a river turning a corner over a cliff would otherwise stack two.
 */
function placeWaterfalls(island: Island, board: Board) {
  const { width: w, height: h, level, ground } = island;
  for (let j = 0; j < w * h; j++) {
    if (!FALLING_WATER.has(ground[j]!)) continue;
    const x = j % w;
    const y = (j - x) / w;
    const z = level[j]!;
    const fall = FALLS.find((f) => fallHeight(island, x + f.dx, y + f.dy, z) > 0);
    const pool = board.get(x, y, z);
    if (!fall || pool?.at(-1)?.tileId !== "water") continue;
    const segments = fallSegments(fall, fallHeight(island, x + fall.dx, y + fall.dy, z));
    board.set(x, y, z, [...pool, ...segments.slice(0, SEGMENTS_PER_STOREY)]);
    /** A stack may not reach past its own storey, so a taller fall goes on in the empty cells above the pool, a storey's worth in each. */
    for (let k = SEGMENTS_PER_STOREY; k < segments.length; k += SEGMENTS_PER_STOREY) {
      board.set(x, y, z + k / SEGMENTS_PER_STOREY, segments.slice(k, k + SEGMENTS_PER_STOREY));
    }
  }
}

/**
 * A river two or three cells wide that narrows as it reaches a cliff drops
 * from its whole width, so a dry cell under the edge, beside the pool a fall
 * lands in, is made pool too and gets its own fall. Otherwise water stands at
 * the top of the cliff with nothing coming down from it.
 */
function widenPlunges(island: Island, plan: Plan, board: Board) {
  const { width: w, height: h, level, ground } = island;
  for (let pass = 0; pass < WIDEST_RIVER_CELLS - 1; pass++) {
    for (let j = 0; j < w * h; j++) {
      if (FALLING_WATER.has(ground[j]!) || plan.road[j] || plan.reserved[j] || plan.siteOf[j])
        continue;
      const x = j % w;
      const y = (j - x) / w;
      const z = level[j]!;
      if (board.get(x, y, z)?.length !== 1) continue;
      if (!FALLS.some((f) => riverAbove(island, x + f.dx, y + f.dy, z))) continue;
      const pool = besidePool(island, board, j);
      if (!pool) continue;
      ground[j] = Ground.River;
      board.set(
        x,
        y,
        z,
        pool.map((p) => ({ ...p })),
      );
    }
  }
}

/** The widest river the terrain cuts; a pool is widened at most this far, so it cannot run along a lake's cliff edge. */
const WIDEST_RIVER_CELLS = 3;

function riverAbove(island: Island, x: number, y: number, z: number): boolean {
  if (x < 0 || y < 0 || x >= island.width || y >= island.height) return false;
  const i = y * island.width + x;
  const storeys = island.level[i]! - z;
  return island.ground[i] === Ground.River && storeys >= 1 && storeys <= TALL_FALL_STOREYS;
}

function besidePool(island: Island, board: Board, j: number): PlacedTile[] | undefined {
  const { width: w, height: h, level, ground } = island;
  let pool: PlacedTile[] | undefined;
  forNeighbours(w, h, j, N4, (k) => {
    if (pool || !FALLING_WATER.has(ground[k]!) || level[k] !== level[j]) return;
    const stack = board.get(k % w, Math.floor(k / w), level[k]!);
    if (stack?.at(-1)?.tileId === "water") pool = stack;
  });
  return pool;
}

/** Whether the cell at `x, y` holds water one storey above `z`. */
/** How many storeys water at `x`, `y` falls to reach `z`, or 0 when nothing falls from there. */
function fallHeight(island: Island, x: number, y: number, z: number): number {
  if (x < 0 || y < 0 || x >= island.width || y >= island.height) return 0;
  const i = y * island.width + x;
  if (!FALLING_WATER.has(island.ground[i]!)) return 0;
  const storeys = island.level[i]! - z;
  return storeys >= 1 && storeys <= TALL_FALL_STOREYS ? storeys : 0;
}

/** The stack of a bare cell of the ground `island` has at `i`, as the terrain lays it away from any edge. */
export function plainGround(island: Island, i: number): PlacedTile[] {
  const base = tile(baseTile(island, i));
  switch (island.ground[i]) {
    case Ground.Bog:
      return [base, tile("mud")];
    case Ground.Basalt:
      return [tile("sand-dunes"), tile("basalt")];
    default:
      return [base];
  }
}

const isBank = (stack: readonly PlacedTile[]) => stack.length === 2 && stack[1]?.tileId === "dirt";

/**
 * A bed of dirt under every river on grass and a cell of dirt on every side
 * of it, level with it, so the water lies in a sandy bed rather than cut into
 * the meadow. Dirt rather than mud: mud is dark against the grass and slows
 * whoever walks on it. A pond too small to be open water is treated as river;
 * open water, and the water beside it, is a shore and gets no bank.
 * `harmoniseGround` can turn a river's ground to grass after the terrain is
 * laid, so this runs again after it, when a bank may already have grown
 * something: anything in `grown` there gives way to the dirt. Returns how
 * many cells it changed.
 */
export function bedRivers(
  island: Island,
  board: Board,
  grown: ReadonlySet<string> = new Set(),
): number {
  const { width: w, height: h, level, ground } = island;
  const shore = shoreOf(island, board);
  let changed = 0;
  for (let i = 0; i < w * h; i++) {
    if (!isRiverWater(ground[i]!)) continue;
    const stack = board.get(i % w, Math.floor(i / w), level[i]!);
    if (!stack) continue;
    if (!besideShore(island, shore, i))
      changed += bedAndBank(island, board, grown, shore, i, stack);
  }
  return changed;
}

function bedAndBank(
  island: Island,
  board: Board,
  grown: ReadonlySet<string>,
  shore: Uint8Array,
  i: number,
  stack: PlacedTile[],
): number {
  const { width: w, height: h, level, ground } = island;
  if (stack[0]?.tileId !== "grass-2") return 0;
  let changed = 0;
  if (stack[1]?.tileId === "water") {
    stack.splice(1, 0, tile("dirt"));
    changed++;
  }
  const z = level[i]!;
  forNeighbours(w, h, i, N8, (j) => {
    if (level[j] !== z || isRiverWater(ground[j]!) || besideShore(island, shore, j)) return;
    const bank = board.get(j % w, Math.floor(j / w), z);
    if (bank?.[0]?.tileId !== "grass-2") return;
    if (besideOtherGround(island, board, j)) return;
    if (isBank(bank) || !bank.slice(1).every((p) => grown.has(p.tileId) && !p.span)) return;
    bank.splice(1, bank.length - 1, tile("dirt"));
    changed++;
  });
  return changed;
}

/**
 * A cell with ground of another kind beside it, where the land changes
 * ground at the river. Dirt joins sand but not snow, and a bank there would
 * be pulled to both grounds by `harmoniseGround`, so it keeps the land's own
 * ground.
 */
function besideOtherGround(island: Island, board: Board, i: number): boolean {
  const { width: w, height: h, level } = island;
  const z = level[i]!;
  const own = board.get(i % w, Math.floor(i / w), z)?.[0]?.tileId;
  let other = false;
  forNeighbours(w, h, i, N8, (j) => {
    const base = board.get(j % w, Math.floor(j / w), z)?.[0]?.tileId;
    if (level[j] === z && base && FULL_GROUNDS.has(base) && base !== own) other = true;
  });
  return other;
}

const FULL_GROUNDS = new Set(["grass-2", "snow", "sand-dunes"]);

/** A river's bank stops this far from a shore, so a river's mouth opens onto the beach as a lake's edge does. */
const SHORE_CLEAR_CELLS = 2;

/** A cell this near the shore of the sea or a lake, where a bank would be on the shore. */
function besideShore(island: Island, shore: Uint8Array, i: number): boolean {
  const { width: w, height: h } = island;
  const x = i % w;
  const y = (i - x) / w;
  for (let dy = -SHORE_CLEAR_CELLS; dy <= SHORE_CLEAR_CELLS; dy++) {
    for (let dx = -SHORE_CLEAR_CELLS; dx <= SHORE_CLEAR_CELLS; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && shore[ny * w + nx]) return true;
    }
  }
  return false;
}

const FALL_SEGMENTS: ReadonlySet<string> = new Set(FALLS.flatMap((f) => f.segments));

/**
 * A cell shut in by cliff on every side but one, where a fall comes down,
 * cannot be left: a fall is not walked through and the cliffs are a storey
 * up. It is raised into the cliff, given the column of the lowest cliff
 * beside it. Returns how many cells it raised.
 */
export function raiseFallPockets(island: Island, board: Board): number {
  const { width: w, height: h, level, ground } = island;
  let raised = 0;
  for (let j = 0; j < w * h; j++) {
    const z = level[j]!;
    const x = j % w;
    const y = (j - x) / w;
    if (!board.get(x, y, z)?.length) continue;
    const cliff = shutInBesideFall(island, board, j);
    if (cliff === null) continue;
    for (let at = z; at <= level[cliff]!; at++) {
      const column = board.get(cliff % w, Math.floor(cliff / w), at);
      board.set(
        x,
        y,
        at,
        (column ?? []).map((p) => ({ ...p })),
      );
    }
    level[j] = level[cliff]!;
    ground[j] = ground[cliff]!;
    raised++;
  }
  return raised;
}

/** The lowest cliff beside `j` when every side of it is a cliff or a fall and one is a fall, else null. */
function shutInBesideFall(island: Island, board: Board, j: number): number | null {
  const { width: w, height: h, level } = island;
  const z = level[j]!;
  let cliff: number | null = null;
  let fall = false;
  let open = false;
  forNeighbours(w, h, j, N4, (k) => {
    if (level[k]! > z) {
      if (cliff === null || level[k]! < level[cliff]!) cliff = k;
      return;
    }
    const side = level[k] === z ? board.get(k % w, Math.floor(k / w), z) : undefined;
    if (side?.some((p) => FALL_SEGMENTS.has(p.tileId))) fall = true;
    else open = true;
  });
  return fall && !open ? cliff : null;
}

/**
 * Where two river cells meet only at a corner, the cell beside both that is
 * open ground is made river, with the stack of the cell it joins. A site
 * levelled over a river, or a lake drawn after it, can leave such a corner
 * after the terrain's own pass. Returns how many cells it joined.
 */
export function joinRiverCorners(island: Island, board: Board, grown: ReadonlySet<string>): number {
  const { width: w, height: h, ground } = island;
  let joined = 0;
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!isRiverWater(ground[i]!)) continue;
      for (const dx of [-1, 1]) joined += joinCorner(island, board, grown, i, x + dx);
    }
  }
  return joined;
}

function joinCorner(
  island: Island,
  board: Board,
  grown: ReadonlySet<string>,
  i: number,
  nx: number,
): number {
  const { width: w, level, ground } = island;
  const x = i % w;
  const y = (i - x) / w;
  if (nx < 0 || nx >= w) return 0;
  const j = (y + 1) * w + nx;
  const sides = [y * w + nx, (y + 1) * w + x];
  if (!isRiverWater(ground[j]!) || sides.some((k) => isRiverWater(ground[k]!))) return 0;
  const from = board.get(x, y, level[i]!);
  if (!from?.some((p) => p.tileId === "water")) return 0;
  for (const k of sides) {
    if (level[k] !== level[i] && level[k] !== level[j]) continue;
    const stack = board.get(k % w, Math.floor(k / w), level[k]!);
    if (
      !stack?.[0] ||
      !stack.slice(1).every((p) => p.tileId === "dirt" || (grown.has(p.tileId) && !p.span))
    )
      continue;
    ground[k] = Ground.River;
    board.set(
      k % w,
      Math.floor(k / w),
      level[k]!,
      from.map((p) => ({ ...p })),
    );
    return 1;
  }
  return 0;
}

/** Water at least this wide both ways is a lake or the sea, since the widest river cut is three cells; `app/verify/landscape.ts` draws the same line. */
const OPEN_WATER_CELLS = 4;

const isOpenWet = (g: number) =>
  g === Ground.River || g === Ground.Lake || g === Ground.Shallows || g === Ground.DeepSea;

/**
 * Open water and the water beside it: the sea, the lakes, and the mouths of
 * the rivers that run into them, which are shores. With `board`, it reads
 * the water laid on the board, as `verify landscape` does, which also counts
 * the harbour's flooded streets; without, the water the ground plan has.
 * The sea is laid at level 0 whatever level the ground plan gave it.
 */
export function shoreOf(island: Island, board?: Board): Uint8Array {
  const { width: w, height: h, ground, level } = island;
  const wet = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (board ? laidWet(board, i % w, Math.floor(i / w), level[i]!) : isOpenWet(ground[i]!))
      wet[i] = 1;
  }
  const open = new Uint8Array(w * h);
  for (let y = 0; y + OPEN_WATER_CELLS <= h; y++) {
    for (let x = 0; x + OPEN_WATER_CELLS <= w; x++) {
      if (!blockIsWet(wet, w, x, y)) continue;
      for (let dy = 0; dy < OPEN_WATER_CELLS; dy++)
        for (let dx = 0; dx < OPEN_WATER_CELLS; dx++) open[(y + dy) * w + x + dx] = 1;
    }
  }
  const shore = open.slice();
  for (let i = 0; i < w * h; i++) {
    if (!open[i]) continue;
    forNeighbours(w, h, i, N8, (j) => {
      if (wet[j]) shore[j] = 1;
    });
  }
  return shore;
}

const SEA_LEVEL = 0;

function laidWet(board: Board, x: number, y: number, z: number): boolean {
  return [z, SEA_LEVEL].some((at) => {
    const stack = board.get(x, y, at);
    return (
      !!stack?.some((p) => p.tileId === "water" || p.tileId === "deep-water") &&
      !stack.some((p) => p.tileId === "swamp")
    );
  });
}

function blockIsWet(wet: Uint8Array, w: number, x: number, y: number): boolean {
  for (let dy = 0; dy < OPEN_WATER_CELLS; dy++)
    for (let dx = 0; dx < OPEN_WATER_CELLS; dx++) if (!wet[(y + dy) * w + x + dx]) return false;
  return true;
}

/** Open sea is bare `deep-water`; the cells next to the shallows have `water` under it, and the shallows foam where they meet dry sand. */
function seaStack(island: Island, i: number): PlacedTile[] {
  const { width: w, height: h, ground } = island;
  if (ground[i] === Ground.DeepSea) {
    let besideShallows = false;
    forNeighbours(w, h, i, N8, (j) => {
      if (ground[j] === Ground.Shallows) besideShallows = true;
    });
    return besideShallows ? [tile("water"), tile("deep-water")] : [tile("deep-water")];
  }
  let besideSand = false;
  forNeighbours(w, h, i, N4, (j) => {
    const g = ground[j]!;
    if (g === Ground.Beach || g === Ground.Desert) besideSand = true;
  });
  return besideSand
    ? [tile("sand-dunes"), tile("water"), tile("shore-foam")]
    : [tile("sand-dunes"), tile("water")];
}

/** Open water in the bog lies in pools a few cells across, between banks of mud. */
function bogPond(island: Island, i: number): boolean {
  const x = i % island.width;
  const y = (i - x) / island.width;
  return Math.sin(x * 0.37) + Math.sin(y * 0.31) + Math.sin((x + y) * 0.23 + 1.7) > -0.4;
}

export function forNeighbours(
  w: number,
  h: number,
  i: number,
  offsets: ReadonlyArray<readonly [number, number]>,
  visit: (j: number) => void,
) {
  const x = i % w;
  const y = (i - x) / w;
  for (const [dx, dy] of offsets) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < w && ny < h) visit(ny * w + nx);
  }
}

/** How many steps in from the edge of the region each of its cells is, by four-way flood. */
function depthIn(island: Island, inside: (i: number) => boolean): Uint8Array {
  const { width: w, height: h } = island;
  const n = w * h;
  const depth = new Uint8Array(n);
  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!inside(i)) continue;
    let edge = false;
    forNeighbours(w, h, i, N4, (j) => {
      if (!inside(j)) edge = true;
    });
    if (edge) {
      depth[i] = 1;
      queue.push(i);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    forNeighbours(w, h, i, N4, (j) => {
      if (inside(j) && !depth[j]) {
        depth[j] = Math.min(255, depth[i]! + 1);
        queue.push(j);
      }
    });
  }
  return depth;
}
