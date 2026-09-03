/**
 * Carves a multi-floor cave system into `data/map.json`.
 *
 *   bun scripts/carve-caves.ts            # carve, then check what was carved
 *   bun scripts/carve-caves.ts --verify   # only check what is already there
 *
 * Written for the animal den under the forest at the town's south gate, and
 * parameterised rather than hard-coded so the next cave system is a change to
 * {@link SYSTEM} rather than a second copy of this file. Everything it needs to
 * know is up there: where the way in is, how many floors, how many animals, how
 * dense the rock starts.
 *
 * ## How it decides where to dig
 *
 * - **The footprint is whatever is left.** A cell is a candidate if the surface
 *   above it stops daylight and it is not near a cave somebody has already
 *   authored. That mask is the shape of the map's coastline and of the existing
 *   dungeons, so a system is asymmetric before a single cell is carved — no
 *   bounding box is ever given to it.
 * - **A density field varies the cave from place to place.** Value noise picks
 *   the automaton's starting rock fraction per region, so one part of a floor
 *   comes out as open cavern and another as a warren of narrow passages.
 * - **Regions are joined by digging, not by filling.** What the automaton
 *   leaves separate is connected by tunnelling the shortest legal route between
 *   the two, which is where the long corridors between cave systems come from.
 *
 * ## Two rules it exists to keep
 *
 * **Rock is only ever a shell around what was carved.** Filling the footprint
 * instead is tens of thousands of quads nobody will see the inside of, and at
 * the size of the animal den that is the difference between a map that draws
 * inside its budget and one that does not.
 *
 * **Nothing is written until the whole system has been walked.** Floors are
 * decided, then the ramps and holes between them, and only then is the system
 * flooded from its mouth across every floor at once — anything that flood does
 * not reach is filled back in before a tile is placed. Punching a hole through
 * a floor for a ramp can cut a wing off it, and finding that out afterwards
 * means a cave with rooms nobody can enter.
 *
 * Everything is a pure function of {@link SYSTEM}'s seeds, so a re-run
 * reproduces the same caves rather than reshuffling the map.
 */
import {
  chunkifyMap,
  getStack as getMapStack,
  listCoords,
  parseMap,
  replaceStack,
  serializeMap,
} from "../app/lib/mapData";
import { canWalk, listStandingSurfaces } from "../app/game/movement";
import { isSkyExposed, stackOcclusion } from "../app/lib/lighting";
import { computeLightingFlood } from "../app/lib/lightingFlood";
import { fitsHeightAtElevation, tilesByIdFromList } from "../app/lib/validation";
import {
  HEIGHT_PER_LEVEL,
  MAX_LEVEL,
  MAX_LIGHT_LEVEL,
  MIN_LEVEL,
  coordKey,
  normalizeTileDef,
  resolveLightPassing,
} from "../app/lib/types";
import type { Direction, PlacedTile, TileDef } from "../app/lib/types";

// ---------------------------------------------------------------------------
// The cave system to carve
// ---------------------------------------------------------------------------

type Placed = { tileId: string; direction?: Direction; description?: string };

/**
 * Everything about *this* cave system, as opposed to how caves are made.
 *
 * The knobs worth reaching for first are `rockChance` — how much of a floor is
 * stone, and the difference between halls and warrens — and `population`, which
 * is measured in server ticks as much as in danger: every creature is a brain
 * the simulation steps five times a second.
 */
const SYSTEM = {
  /** Floors, top to bottom. One seed each: change one and only that floor moves. */
  levels: [-1, -2, -3] as const,
  seeds: [0x5ea11ce, 0x7b04e57, 0xcabe770] as const,

  /**
   * The mouth: a notch in the ground a few steps down the road out of the
   * town's south gate, which is at (2..3, 11).
   *
   * The surface cell is left *empty* — a hole — with a ramp on the floor below
   * it, so walking in off the road takes you down the slope. That hole is the
   * one place daylight reaches the caves, which is what a cave mouth should
   * look like.
   */
  mouth: { x: 10, y: 20 },
  /** Which way you walk in. The ramp climbs back out the opposite way. */
  mouthDescent: "s" as Direction,

  /**
   * The automaton's starting rock fraction, at its most open and most solid.
   *
   * Picked per cell from the density field rather than fixed, which is the
   * whole of why one part of a floor is a hall and another is a warren. Below
   * about 0.46 the smoothing has nothing to bite on and a floor comes out as
   * one enormous room with islands in it; above about 0.70 it closes into rock
   * that the tunnels then have to cross in long straight lines.
   */
  rockChance: { open: 0.5, dense: 0.66 },

  /** Ramps between each pair of floors, and the cells kept between two of them. */
  rampsPerTransition: 14,
  rampSpacing: 14,

  /**
   * Holes with no floor at all, per floor, top to bottom. The bottom floor gets
   * none: there is nothing under it to drop into.
   */
  pitsPerFloor: [10, 10, 0],

  /**
   * Rats thicken with depth, wolves start on the second floor, the troll is
   * alone at the bottom.
   *
   * **This is a tick budget as much as a difficulty.** Every creature is a
   * brain the simulation steps five times a second, and that step is the whole
   * of the spike in a tick: measured at ~0.037ms each, against a 33ms tick that
   * already spends ~3.4ms on everything else. A hundred and fifty of them cost
   * ~9ms p95 and ~13ms at worst on a developer machine, which leaves the
   * production box its own factor of two. Twice this many measured ~12/20ms and
   * is where it stops being comfortable.
   *
   * One animal per ~130 cells of floor, which reads as sparse and is meant to:
   * a den you walk through for a while before something finds you.
   */
  population: [
    { rat: 32, wolf: 0, "cave-troll": 0 },
    { rat: 40, wolf: 11, "cave-troll": 0 },
    { rat: 50, wolf: 20, "cave-troll": 1 },
  ] as ReadonlyArray<Readonly<Record<string, number>>>,

  /**
   * One crystal per this many cells of floor.
   *
   * Sparse on purpose twice over: they are the only light down here, so the
   * point is that most of it is dark — bring a torch — and every one of them is
   * a spherical flood the light baker pays for on any change to the map.
   */
  cellsPerCrystal: 190,
} as const;

// ---------------------------------------------------------------------------
// How caves are made
// ---------------------------------------------------------------------------

/**
 * Solid rock: two `half-stone` is exactly a level, which seals it for both
 * light and movement.
 *
 * No `dirt` underneath, unlike the older cave under the north of the map. That
 * third tile is a floor waiting for whoever carves the wall away later, and it
 * is also a third more quads on every wall cell — fourteen thousand of them in
 * the animal den. Carving a wall here means painting a floor first.
 */
const ROCK: Placed[] = [{ tileId: "half-stone" }, { tileId: "half-stone" }];
const CAVE_FLOOR: Placed[] = [{ tileId: "dirt" }];

/**
 * What a carve is allowed to overwrite.
 *
 * Everything else underground — a cellar floor, a torch, the portal in the
 * sunken glade — is somebody's work, and a generator that walks over it is a
 * generator nobody runs twice. Conflicts are reported rather than resolved.
 */
const OVERWRITABLE = new Set(["dirt", "half-stone", "grass-2", "grass"]);

/**
 * Cells kept between a new cave and one that is already there.
 *
 * Three rather than one because the wall shell is two thick: at any less the
 * two systems share a wall, and the first stray carve opens the animal den into
 * somebody's cellar.
 */
const EXISTING_CAVE_BUFFER = 3;

/** Rock shell around the carved space. Two, so no cave ever backs onto a void. */
const WALL_SHELL = 2;

/**
 * How far from the caves the daylight lid is laid.
 *
 * `MAX_LIGHT_LEVEL`, because that is exactly how far the sky flood carries:
 * past it the spill has decayed to nothing and there is nothing to shut out.
 *
 * **A wall around a cave does not keep daylight out of it, and this is why.**
 * Every column the surface does not seal — a pond, and the whole of the void
 * past the coastline — takes the sky shaft all the way down, and the flood is
 * three-dimensional. Light walks sideways through the void at ground level,
 * *down* an empty column beside the cave, and back in three levels below the
 * surface, going round the wall rather than through it. Half of the animal
 * den's floor was daylit at noon before this existed, brightest at the coast
 * and fading inland over about a dozen cells, which is that leak's fingerprint.
 */
const DAYLIGHT_LID_REACH = MAX_LIGHT_LEVEL;

/** Cells a region must have before it is worth tunnelling to. */
const MIN_REGION_CELLS = 24;

/** How often a tunnel opens a cell to one side, so it is not a ruled line. */
const TUNNEL_BULGE_CHANCE = 0.4;

/** Cells across one lobe of the density field. */
const DENSITY_FIELD_SCALE = 22;

/** Smoothing passes. Five is where the outlines stop changing much. */
const SMOOTH_PASSES = 5;

/** A cell with at least this many rock neighbours (of 8) becomes rock. */
const ROCK_CROWDING = 5;

/**
 * A cell with no more than this many rock cells in its 5×5 becomes rock, for
 * the first passes only — the rule that puts pillars and islands in open
 * country instead of leaving it blank.
 */
const OPEN_SPRAWL = 4;
const SPRAWL_PASSES = 4;

/**
 * How much daylight a carved cell may catch before it counts as a leak.
 *
 * Not zero, and the reason is the map rather than the caves: some of the older
 * rooms underground are lit from above on purpose — the sunken glade is open to
 * the sky, and there is a pond over the city dungeon put there as a skylight —
 * and light spreads out of them for `MAX_LIGHT_LEVEL` cells whatever is built
 * next door. A tenth of full daylight at the far edge of that is a glow at the
 * boundary of somebody else's lit room. Anything brighter is a hole, and the
 * check says so.
 */
const DIM_ENOUGH = 64;

/** Cells between two pits, and the clearance a pit keeps from any ramp. */
const PIT_SPACING = 14;
const PIT_RAMP_CLEARANCE = 4;

/** Cells between any two creatures, so a floor is not one solid ambush. */
const CREATURE_SPACING = 4;
/** Cells kept clear of creatures around the mouth and around every ramp. */
const ARRIVAL_SAFE_RADIUS = 5;

/** Rock neighbours (of 8) a cell needs before a crystal will grow there. */
const CRYSTAL_NOOK_ROCK = 5;
/** Cells between crystals, so the lit pools stay separate. */
const CRYSTAL_SPACING = 8;
/** How far from a hole its marker crystal may stand and still light it. */
const CRYSTAL_HOLE_REACH = 2;

/**
 * The crystals, split by whether they reach the ceiling.
 *
 * A tile as tall as a level tops out exactly on the floor plane of the level
 * above, and `surfaceTileAt` walks up from the bottom and takes the first stack
 * that surfaces there — so on a tie the lower one answers. Both of these are
 * `walkable: false`, so one standing under an open cell makes that cell
 * unwalkable: a tall crystal on the top floor put a hole in the forest that
 * could not be walked across. They only grow where the roof is stone. See
 * `docs/notes.md`, "A level is four height units, and a body is three".
 */
const TALL_CRYSTAL_TILES = ["arcane-crystal-1", "arcane-crystal-2"];
const LOW_CRYSTAL_TILES = ["arcane-crystal-3"];

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const MAP_PATH = "data/map.json";
const TILES_PATH = "data/tiles.json";
const verifyOnly = process.argv.includes("--verify");

type Flat = { version: 1; levels: Record<string, Record<string, Placed[]>> };
const map: Flat = JSON.parse(await Bun.file(MAP_PATH).text());
const tiles: TileDef[] = (
  JSON.parse(await Bun.file(TILES_PATH).text()) as unknown[]
).map((raw) => normalizeTileDef(raw));
const tilesById = tilesByIdFromList(tiles);

const level = (z: number) => (map.levels[String(z)] ??= {});
const getStack = (z: number, x: number, y: number): Placed[] =>
  level(z)[coordKey(x, y)] ?? [];
const setStack = (z: number, x: number, y: number, stack: Placed[]) => {
  if (stack.length === 0) delete level(z)[coordKey(x, y)];
  else level(z)[coordKey(x, y)] = stack;
};

type Cell = { x: number; y: number };
const STEP: Record<Direction, Cell> = {
  n: { x: 0, y: -1 },
  e: { x: 1, y: 0 },
  s: { x: 0, y: 1 },
  w: { x: -1, y: 0 },
};
const DIRS: Direction[] = ["n", "e", "s", "w"];
/** Walking `dir` up a ramp needs the ramp facing the way you came from. */
const RAMP_FACING: Record<Direction, Direction> = { n: "s", e: "w", s: "n", w: "e" };
const OPPOSITE = RAMP_FACING;

/** Deterministic PRNG — a cave system is a pure function of its seeds. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// One indexing scheme over the whole map, so a cell index means the same thing
// on every floor and a column can be asked about from any of them.
const surfaceKeys = Object.keys(map.levels["0"] ?? {});
let X0 = Infinity;
let X1 = -Infinity;
let Y0 = Infinity;
let Y1 = -Infinity;
for (const key of surfaceKeys) {
  const [x, y] = key.split(",").map(Number) as [number, number];
  X0 = Math.min(X0, x);
  X1 = Math.max(X1, x);
  Y0 = Math.min(Y0, y);
  Y1 = Math.max(Y1, y);
}
const W = X1 - X0 + 1;
const H = Y1 - Y0 + 1;

const idx = (x: number, y: number) => (y - Y0) * W + (x - X0);
const cellX = (i: number) => (i % W) + X0;
const cellY = (i: number) => Math.floor(i / W) + Y0;
const at = (i: number): Cell => ({ x: cellX(i), y: cellY(i) });
const inBounds = (x: number, y: number) => x >= X0 && x <= X1 && y >= Y0 && y <= Y1;
const chebyshev = (a: Cell, b: Cell) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

type Mask = Uint8Array;
const newMask = () => new Uint8Array(W * H);

/** Grow a mask by `radius` cells in the eight directions. */
function dilate(mask: Mask, radius: number): Mask {
  let current = mask;
  for (let step = 0; step < radius; step++) {
    const next = new Uint8Array(current);
    for (let i = 0; i < current.length; i++) {
      if (!current[i]) continue;
      const here = at(i);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (inBounds(here.x + dx, here.y + dy)) next[idx(here.x + dx, here.y + dy)] = 1;
        }
      }
    }
    current = next;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Candidate space
// ---------------------------------------------------------------------------

/**
 * Columns whose surface stops daylight on its way down.
 *
 * Two ways to stop it, and the gap between them is the trap. A bare floor —
 * grass, dirt, cobblestone — hard-seals the shaft: height 0, so no opacity, and
 * `lightingFlood` treats a height-0 floor as a lid the sky flood may not cross.
 * A full block — a tree, a wall — stops it because nothing gets through solid.
 *
 * **Anything in between leaks, and most of the map's surface is in between.**
 * A bush, a sign, a fence, a chair on the grass is half a level tall, which
 * makes the cell half opaque, which disqualifies it from the hard seal and
 * lets the shaft down through it at half strength. The flood then spreads that
 * through the cave. A pond leaks for the plainer reason that water passes
 * light. So both are kept out of the footprint, and a cave simply does not run
 * under them.
 */
const SEALED_ROOF: Mask = (() => {
  const mask = newMask();
  for (const key of surfaceKeys) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    const stack = (map.levels["0"]![key] ?? []) as PlacedTile[];
    const { opacity, sealsLevel } = stackOcclusion(stack, tilesById);
    // Either a bare floor, which hard-seals the shaft, or a full block, which
    // stops it outright. Anything between the two leaks — see the note above.
    // `lightingFlood` spells the first half of this as `opacity <
    // TRANSMISSION_EPSILON`; a stack of height-0 tiles sums to exactly zero.
    if ((sealsLevel && opacity === 0) || opacity >= 1) {
      mask[idx(x, y)] = 1;
    }
  }
  return mask;
})();

/** A cell of an existing cave: underground, and not solid rock. */
function isExistingOpen(z: number, x: number, y: number): boolean {
  const stack = getStack(z, x, y);
  if (stack.length === 0) return false;
  return !stack.some((t) => t.tileId === "half-stone");
}

/**
 * Columns far enough inside the map for the lid to be able to protect them.
 *
 * Outside the map's own content the light bake has nothing to occlude with, so
 * its domain margin is open air at every depth and lit to the top of the scale.
 * A lid cannot be laid out there — there is no map to lay it on — so the caves
 * keep {@link DAYLIGHT_LID_REACH} cells back from the edge instead, which is
 * exactly the distance at which that margin's spill has decayed to nothing.
 */
const INSIDE_THE_MAP: Mask = (() => {
  const mask = newMask();
  for (let i = 0; i < mask.length; i++) {
    const here = at(i);
    const fromEdge = Math.min(
      here.x - X0,
      X1 - here.x,
      here.y - Y0,
      Y1 - here.y,
    );
    mask[i] = fromEdge >= DAYLIGHT_LID_REACH ? 1 : 0;
  }
  return mask;
})();

/** Where a floor may be carved: roofed, inside the map, and clear of anybody else's cave. */
function candidatesFor(z: number, roof: Mask): Mask {
  const existing = newMask();
  for (const key of Object.keys(level(z))) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    if (inBounds(x, y) && isExistingOpen(z, x, y)) existing[idx(x, y)] = 1;
  }
  const keepOut = dilate(existing, EXISTING_CAVE_BUFFER);

  const out = newMask();
  for (let i = 0; i < out.length; i++) {
    if (roof[i] && INSIDE_THE_MAP[i] && !keepOut[i]) out[i] = 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The automaton
// ---------------------------------------------------------------------------

/**
 * Smooth value noise in [0, 1], for the density field.
 *
 * Lattice values from the seeded PRNG, smoothstepped between — enough structure
 * to give a floor regions with a character of their own, and not worth a
 * gradient noise for.
 */
function densityField(seed: number): Float32Array {
  const random = mulberry32(seed);
  const lw = Math.ceil(W / DENSITY_FIELD_SCALE) + 2;
  const lh = Math.ceil(H / DENSITY_FIELD_SCALE) + 2;
  const lattice = new Float32Array(lw * lh);
  for (let i = 0; i < lattice.length; i++) lattice[i] = random();

  const smooth = (t: number) => t * t * (3 - 2 * t);
  const field = new Float32Array(W * H);
  for (let gy = 0; gy < H; gy++) {
    for (let gx = 0; gx < W; gx++) {
      const fx = gx / DENSITY_FIELD_SCALE;
      const fy = gy / DENSITY_FIELD_SCALE;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = smooth(fx - x0);
      const ty = smooth(fy - y0);
      const lat = (ax: number, ay: number) => lattice[ay * lw + ax]!;
      const top = lat(x0, y0) * (1 - tx) + lat(x0 + 1, y0) * tx;
      const bottom = lat(x0, y0 + 1) * (1 - tx) + lat(x0 + 1, y0 + 1) * tx;
      field[gy * W + gx] = top * (1 - ty) + bottom * ty;
    }
  }
  return field;
}

function rockAround(rock: Mask, x: number, y: number, span: number): number {
  let n = 0;
  for (let dy = -span; dy <= span; dy++) {
    for (let dx = -span; dx <= span; dx++) {
      if (dx === 0 && dy === 0) continue;
      // Off the candidate space counts as rock: a cave does not open onto it.
      if (!inBounds(x + dx, y + dy) || rock[idx(x + dx, y + dy)]) n++;
    }
  }
  return n;
}

/** Cellular-automata cave over `candidates`, everything else rock. */
function generateCave(seed: number, candidates: Mask): Mask {
  const random = mulberry32(seed);
  const density = densityField(seed ^ 0xf1e1d);
  const span = SYSTEM.rockChance.dense - SYSTEM.rockChance.open;
  let rock = newMask();
  for (let i = 0; i < rock.length; i++) {
    if (!candidates[i]) {
      rock[i] = 1;
      continue;
    }
    rock[i] = random() < SYSTEM.rockChance.open + density[i]! * span ? 1 : 0;
  }

  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const next = newMask();
    for (let i = 0; i < rock.length; i++) {
      if (!candidates[i]) {
        next[i] = 1;
        continue;
      }
      const here = at(i);
      const crowded = rockAround(rock, here.x, here.y, 1) >= ROCK_CROWDING;
      const sprawling =
        pass < SPRAWL_PASSES && rockAround(rock, here.x, here.y, 2) <= OPEN_SPRAWL;
      next[i] = crowded || sprawling ? 1 : 0;
    }
    rock = next;
  }
  return rock;
}

/** Four-connected open regions, largest first. */
function regionsOf(rock: Mask): number[][] {
  const seen = new Uint8Array(rock.length);
  const out: number[][] = [];
  for (let start = 0; start < rock.length; start++) {
    if (rock[start] || seen[start]) continue;
    const region: number[] = [start];
    seen[start] = 1;
    for (let head = 0; head < region.length; head++) {
      const here = at(region[head]!);
      for (const dir of DIRS) {
        const nx = here.x + STEP[dir].x;
        const ny = here.y + STEP[dir].y;
        if (!inBounds(nx, ny)) continue;
        const n = idx(nx, ny);
        if (rock[n] || seen[n]) continue;
        seen[n] = 1;
        region.push(n);
      }
    }
    out.push(region);
  }
  return out.sort((a, b) => b.length - a.length);
}

/** Shortest route from a region to the main body, through anything candidate. */
function routeThroughRock(
  from: readonly number[],
  target: Uint8Array,
  candidates: Mask,
): number[] | null {
  const cameFrom = new Int32Array(candidates.length).fill(-1);
  const seen = new Uint8Array(candidates.length);
  const queue: number[] = [];
  for (const i of from) {
    seen[i] = 1;
    queue.push(i);
  }
  // The neighbour order is shuffled per node, which costs nothing and is the
  // difference between a corridor and a ruled line: every shortest path is the
  // same length, and this picks a different one of them each time.
  const random = mulberry32(Math.imul(from[0]!, 2654435761));

  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head]!;
    if (target[cell]) {
      const path: number[] = [];
      for (let step = cell; step !== -1; step = cameFrom[step]!) path.push(step);
      return path;
    }
    const here = at(cell);
    for (const dir of shuffled(DIRS, random)) {
      const nx = here.x + STEP[dir].x;
      const ny = here.y + STEP[dir].y;
      if (!inBounds(nx, ny)) continue;
      const n = idx(nx, ny);
      if (seen[n] || !candidates[n]) continue;
      seen[n] = 1;
      cameFrom[n] = cell;
      queue.push(n);
    }
  }
  return null;
}

/**
 * Join every region worth keeping to the one holding `anchor`, by digging.
 *
 * The route runs through the *candidate* space rather than through open cells —
 * a tunnel is allowed to cross solid rock, which is the whole point of one — so
 * this succeeds wherever the candidate space is connected at all. Regions it
 * cannot reach, and regions too small to be worth a corridor, are filled in.
 */
function connectRegions(rock: Mask, candidates: Mask, anchor: number) {
  for (;;) {
    const regions = regionsOf(rock);
    const main = regions.find((r) => r.includes(anchor)) ?? regions[0];
    if (!main) return;
    const mainSet = new Uint8Array(rock.length);
    for (const i of main) mainSet[i] = 1;

    const next = regions
      .filter((r) => r !== main && r.length >= MIN_REGION_CELLS)
      .sort((a, b) => b.length - a.length)[0];
    if (!next) break;

    const path = routeThroughRock(next, mainSet, candidates);
    if (!path) {
      // Nothing legal joins it up; it is a pocket, not a wing.
      for (const i of next) rock[i] = 1;
      continue;
    }
    // Carved a cell at a time with the odd bulge, so a corridor reads as
    // something water made rather than as something surveyed.
    const widen = mulberry32(Math.imul(path.length, 2246822519));
    for (const i of path) {
      rock[i] = 0;
      if (widen() >= TUNNEL_BULGE_CHANCE) continue;
      const dir = DIRS[Math.floor(widen() * DIRS.length)]!;
      const bulge = { x: cellX(i) + STEP[dir].x, y: cellY(i) + STEP[dir].y };
      if (inBounds(bulge.x, bulge.y) && candidates[idx(bulge.x, bulge.y)]) {
        rock[idx(bulge.x, bulge.y)] = 0;
      }
    }
  }

  // Whatever is still separate at this point is small or unreachable.
  const regions = regionsOf(rock);
  const main = regions.find((r) => r.includes(anchor)) ?? regions[0] ?? [];
  const keep = new Uint8Array(rock.length);
  for (const i of main) keep[i] = 1;
  for (let i = 0; i < rock.length; i++) if (!rock[i] && !keep[i]) rock[i] = 1;
}

/** Open a cell and its four neighbours, so an anchor is never a pocket. */
function carveRoom(rock: Mask, candidates: Mask, cell: Cell) {
  rock[idx(cell.x, cell.y)] = 0;
  candidates[idx(cell.x, cell.y)] = 1;
  for (const dir of DIRS) {
    const n = { x: cell.x + STEP[dir].x, y: cell.y + STEP[dir].y };
    if (inBounds(n.x, n.y) && candidates[idx(n.x, n.y)]) rock[idx(n.x, n.y)] = 0;
  }
}

// ---------------------------------------------------------------------------
// Carving
// ---------------------------------------------------------------------------

type Floor = { z: number; rock: Mask; open: Mask };
/**
 * A slope from one floor up to the next.
 *
 * The shape is forced by the rules rather than chosen. A ramp is two units tall
 * and two units is exactly `MAX_CLIMB_HEIGHT`, so a body climbs a level in two
 * steps: floor, ramp, the floor above. Standing on the ramp puts a three-high
 * body's head a unit *into* the level above, so the cell over the ramp has to be
 * empty — a floor plate there is a ceiling and `fitsHeightAtElevation` refuses
 * it. That empty cell is the hole you step into from above, which is the same
 * slope seen from the other end.
 */
type Ramp = { z: number; cell: number; ascend: Direction };
type Prop = { z: number; cell: number; tileId: string };

type Carved = {
  floors: Floor[];
  ramps: Ramp[];
  /** `z:cell` of every hole: the mouth of a ramp, and every pit. */
  rampHoles: Set<string>;
  pits: Set<string>;
  crystals: Prop[];
  creatures: Prop[];
  trimmed: number;
};

function carveSystem(): Carved {
  const mouthFoot = {
    x: SYSTEM.mouth.x + STEP[SYSTEM.mouthDescent].x,
    y: SYSTEM.mouth.y + STEP[SYSTEM.mouthDescent].y,
  };

  const floors: Floor[] = SYSTEM.levels.map((z, i) => {
    const candidates = candidatesFor(z, SEALED_ROOF);
    const rock = generateCave(SYSTEM.seeds[i]!, candidates);
    carveRoom(rock, candidates, mouthFoot);
    connectRegions(rock, candidates, idx(mouthFoot.x, mouthFoot.y));
    const open = newMask();
    for (let c = 0; c < rock.length; c++) open[c] = rock[c] ? 0 : 1;
    return { z, rock, open };
  });
  const floorAt = (z: number) => floors.find((f) => f.z === z);

  // --- ramps, one floor to the next ---------------------------------------
  const ramps: Ramp[] = [];
  for (let i = 1; i < floors.length; i++) {
    const lower = floors[i]!;
    const upper = floors[i - 1]!;
    const random = mulberry32(SYSTEM.seeds[i]! ^ 0x2a3b);

    const options: Ramp[] = [];
    for (let c = 0; c < lower.open.length; c++) {
      if (!lower.open[c]) continue;
      const here = at(c);
      for (const ascend of DIRS) {
        const out = { x: here.x + STEP[ascend].x, y: here.y + STEP[ascend].y };
        const back = { x: here.x - STEP[ascend].x, y: here.y - STEP[ascend].y };
        if (!inBounds(out.x, out.y) || !inBounds(back.x, back.y)) continue;
        // You climb out onto the floor above, and reach the ramp along this one.
        if (!upper.open[idx(out.x, out.y)]) continue;
        if (!lower.open[idx(back.x, back.y)]) continue;
        options.push({ z: lower.z, cell: c, ascend });
      }
    }

    let placed = 0;
    for (const option of shuffled(options, random)) {
      if (placed >= SYSTEM.rampsPerTransition) break;
      const clear = ramps.every(
        (r) => chebyshev(at(option.cell), at(r.cell)) >= SYSTEM.rampSpacing,
      );
      if (!clear) continue;
      ramps.push(option);
      placed++;
    }
  }

  // The mouth is a ramp like any other, with the surface as its upper floor.
  ramps.push({
    z: SYSTEM.levels[0]!,
    cell: idx(SYSTEM.mouth.x, SYSTEM.mouth.y),
    ascend: OPPOSITE[SYSTEM.mouthDescent],
  });

  const rampHoles = new Set(ramps.map((r) => `${r.z + 1}:${r.cell}`));
  // The cell over a ramp stops being floor; the ramp itself is still walked on.
  for (const ramp of ramps) floorAt(ramp.z + 1)?.open.fill(0, ramp.cell, ramp.cell + 1);

  // --- pits ----------------------------------------------------------------
  const pits = new Set<string>();
  for (let i = 0; i < floors.length; i++) {
    const floor = floors[i]!;
    const below = floors[i + 1];
    const wanted = SYSTEM.pitsPerFloor[i] ?? 0;
    if (!below || wanted === 0) continue;

    const random = mulberry32(SYSTEM.seeds[i]! ^ 0x91700);
    const cells: number[] = [];
    for (let c = 0; c < floor.open.length; c++) if (floor.open[c]) cells.push(c);

    const chosen: Cell[] = [];
    for (const c of shuffled(cells, random)) {
      if (chosen.length >= wanted) break;
      const here = at(c);
      if (!below.open[c]) continue;
      // Only in the middle of a chamber, so a hole is never the one way past.
      const roomy = DIRS.every((dir) => {
        const n = { x: here.x + STEP[dir].x, y: here.y + STEP[dir].y };
        return inBounds(n.x, n.y) && floor.open[idx(n.x, n.y)];
      });
      if (!roomy) continue;
      const nearRamp = ramps.some(
        (r) => Math.abs(r.z - floor.z) <= 1 && chebyshev(here, at(r.cell)) < PIT_RAMP_CLEARANCE,
      );
      if (nearRamp) continue;
      if (chosen.some((p) => chebyshev(p, here) < PIT_SPACING)) continue;
      chosen.push(here);
    }
    for (const cell of chosen) {
      pits.add(`${floor.z}:${idx(cell.x, cell.y)}`);
      floor.open[idx(cell.x, cell.y)] = 0;
    }
  }

  // --- walk it before writing it -------------------------------------------
  for (const ramp of ramps) floorAt(ramp.z)!.open[ramp.cell] = 1;
  const rampAt = new Map(ramps.map((r) => [`${r.z}:${r.cell}`, r] as const));

  /**
   * Every cell a body can reach from the foot of the entrance slope, across
   * every floor at once.
   *
   * The graph is the movement rules in miniature: neighbours on a floor, a ramp
   * up to the floor above and back down through its hole, and a pit as a
   * one-way drop. `--verify` checks the same thing afterwards with the game's
   * own `canWalk`; this exists so the answer is known while it can still be
   * acted on.
   */
  const reached = (() => {
    const start = `${SYSTEM.levels[0]}:${idx(mouthFoot.x, mouthFoot.y)}`;
    const seen = new Set([start]);
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      const [zRaw, cRaw] = queue[head]!.split(":");
      const z = Number(zRaw);
      const cell = Number(cRaw);
      const floor = floorAt(z);
      if (!floor) continue;
      const here = at(cell);
      const visit = (key: string) => {
        if (seen.has(key)) return;
        seen.add(key);
        queue.push(key);
      };

      for (const dir of DIRS) {
        const n = { x: here.x + STEP[dir].x, y: here.y + STEP[dir].y };
        if (!inBounds(n.x, n.y)) continue;
        const nc = idx(n.x, n.y);
        if (floor.open[nc]) {
          visit(`${z}:${nc}`);
          continue;
        }
        // A hole in this floor: the head of a ramp, or a drop to the one below.
        if (rampHoles.has(`${z}:${nc}`)) visit(`${z - 1}:${nc}`);
        else if (pits.has(`${z}:${nc}`) && floorAt(z - 1)?.open[nc]) visit(`${z - 1}:${nc}`);
      }

      // Standing on a ramp, the way up is the one direction it faces.
      const ramp = rampAt.get(`${z}:${cell}`);
      if (ramp) {
        const out = { x: here.x + STEP[ramp.ascend].x, y: here.y + STEP[ramp.ascend].y };
        if (inBounds(out.x, out.y) && floorAt(z + 1)?.open[idx(out.x, out.y)]) {
          visit(`${z + 1}:${idx(out.x, out.y)}`);
        }
      }
    }
    return seen;
  })();

  let trimmed = 0;
  for (const floor of floors) {
    for (let c = 0; c < floor.open.length; c++) {
      if (!floor.open[c] || reached.has(`${floor.z}:${c}`)) continue;
      floor.open[c] = 0;
      floor.rock[c] = 1;
      trimmed++;
    }
  }

  // A ramp the trim stranded, or whose landing it took away, is not a way
  // anywhere any more.
  for (const ramp of [...ramps]) {
    const out = {
      x: cellX(ramp.cell) + STEP[ramp.ascend].x,
      y: cellY(ramp.cell) + STEP[ramp.ascend].y,
    };
    const landing =
      ramp.z + 1 > SYSTEM.levels[0]!
        ? true // the mouth lands on the surface, which the trim cannot touch
        : floorAt(ramp.z + 1)?.open[idx(out.x, out.y)] === 1;
    if (reached.has(`${ramp.z}:${ramp.cell}`) && landing) continue;
    ramps.splice(ramps.indexOf(ramp), 1);
    rampAt.delete(`${ramp.z}:${ramp.cell}`);
    rampHoles.delete(`${ramp.z + 1}:${ramp.cell}`);
  }
  for (const key of [...pits]) {
    const [z, cell] = key.split(":").map(Number) as [number, number];
    const reachable = DIRS.some((dir) => {
      const n = { x: cellX(cell) + STEP[dir].x, y: cellY(cell) + STEP[dir].y };
      return inBounds(n.x, n.y) && floorAt(z)?.open[idx(n.x, n.y)];
    });
    if (!reachable) pits.delete(key);
  }

  // --- crystals and animals ------------------------------------------------
  const crystals: Prop[] = [];
  const creatures: Prop[] = [];
  /** Cells now filled by something a body cannot walk through. */
  const filled = new Set<string>();
  /** Cells a ramp climbs out onto: blocking one strands the ramp. */
  const landings = new Set(
    ramps.map((r) => {
      const out = {
        x: cellX(r.cell) + STEP[r.ascend].x,
        y: cellY(r.cell) + STEP[r.ascend].y,
      };
      return `${r.z + 1}:${idx(out.x, out.y)}`;
    }),
  );

  for (let i = 0; i < floors.length; i++) {
    const floor = floors[i]!;
    const upper = floors[i - 1];
    const random = mulberry32(SYSTEM.seeds[i]! ^ 0xd3c0);

    const standable: number[] = [];
    for (let c = 0; c < floor.open.length; c++) {
      if (!floor.open[c]) continue;
      if (rampAt.has(`${floor.z}:${c}`)) continue;
      if (landings.has(`${floor.z}:${c}`)) continue;
      standable.push(c);
    }

    const holesHere = [...pits, ...rampHoles]
      .filter((key) => key.startsWith(`${floor.z}:`))
      .map((key) => at(Number(key.split(":")[1])));

    const nooks = shuffled(
      standable.filter(
        (c) => rockAround(floor.rock, cellX(c), cellY(c), 1) >= CRYSTAL_NOOK_ROCK,
      ),
      random,
    );
    const chosen: number[] = [];
    const take = (c: number) => {
      if (chosen.includes(c) || wouldPinch(floor, c)) return;
      chosen.push(c);
      floor.open[c] = 0;
      filled.add(`${floor.z}:${c}`);
    };

    // One beside every hole first, so a way down is always something you can see.
    for (const c of nooks) {
      if (!holesHere.some((h) => chebyshev(h, at(c)) <= CRYSTAL_HOLE_REACH)) continue;
      take(c);
    }
    const target = Math.round(standable.length / SYSTEM.cellsPerCrystal);
    for (const c of nooks) {
      if (chosen.length >= target) break;
      if (chosen.some((other) => chebyshev(at(other), at(c)) < CRYSTAL_SPACING)) continue;
      take(c);
    }
    for (const c of chosen) {
      // A tall crystal needs stone overhead — see TALL_CRYSTAL_TILES.
      const kinds = upper?.rock[c] === 1 ? TALL_CRYSTAL_TILES : LOW_CRYSTAL_TILES;
      crystals.push({ z: floor.z, cell: c, tileId: kinds[Math.floor(random() * kinds.length)]! });
    }

    const arrivals = ramps
      .filter((r) => Math.abs(r.z - floor.z) <= 1)
      .map((r) => at(r.cell));
    const habitable = standable.filter(
      (c) =>
        !filled.has(`${floor.z}:${c}`) &&
        arrivals.every((a) => chebyshev(a, at(c)) >= ARRIVAL_SAFE_RADIUS),
    );

    /**
     * The troll takes the cell furthest from the mouth on its floor, and
     * everything else is scattered. Distance is the only ordering that makes a
     * boss feel like the bottom of a den rather than like the second room.
     */
    const byRemoteness = habitable
      .slice()
      .sort(
        (a, b) =>
          Math.abs(cellX(b) - SYSTEM.mouth.x) +
          Math.abs(cellY(b) - SYSTEM.mouth.y) -
          (Math.abs(cellX(a) - SYSTEM.mouth.x) + Math.abs(cellY(a) - SYSTEM.mouth.y)),
      );
    const scattered = shuffled(habitable, random);
    const roster: Array<{ tileId: string; homes: number[] }> = [];
    for (const [tileId, count] of Object.entries(SYSTEM.population[i] ?? {})) {
      const homes = tileId === "cave-troll" ? byRemoteness : scattered;
      for (let n = 0; n < count; n++) roster.push({ tileId, homes });
    }
    // Trolls first, so the one remote cell goes to the thing that wants it.
    roster.sort((a, b) => (a.tileId === "cave-troll" ? -1 : b.tileId === "cave-troll" ? 1 : 0));

    const taken: Cell[] = [];
    for (const { tileId, homes } of roster) {
      const home = homes.find(
        (c) =>
          !filled.has(`${floor.z}:${c}`) &&
          taken.every((t) => chebyshev(t, at(c)) >= CREATURE_SPACING),
      );
      if (home == null) {
        console.warn(`no room left for a ${tileId} on L${floor.z}`);
        continue;
      }
      taken.push(at(home));
      filled.add(`${floor.z}:${home}`);
      creatures.push({ z: floor.z, cell: home, tileId });
    }
  }

  return { floors, ramps, rampHoles, pits, crystals, creatures, trimmed };
}

/**
 * Would putting something solid here cut the floor in two?
 *
 * A local test rather than a flood: the open cells in the ring around it have to
 * form one contiguous arc, or the cell is the join between two of them. It is
 * conservative — it refuses some cells that would have been fine — which is the
 * right way round for a wall nobody can walk through.
 */
function wouldPinch(floor: Floor, cell: number): boolean {
  const here = at(cell);
  const ring = (
    [
      [0, -1],
      [1, -1],
      [1, 0],
      [1, 1],
      [0, 1],
      [-1, 1],
      [-1, 0],
      [-1, -1],
    ] as const
  ).map(([dx, dy]) => {
    const n = { x: here.x + dx, y: here.y + dy };
    return inBounds(n.x, n.y) && floor.open[idx(n.x, n.y)] === 1;
  });
  let runs = 0;
  for (let i = 0; i < ring.length; i++) {
    if (ring[i] && !ring[(i + ring.length - 1) % ring.length]) runs++;
  }
  return runs > 1;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function writeSystem(carved: Carved) {
  const placed = { floor: 0, rock: 0, lid: 0, ramps: 0, holes: 0, crystals: 0, creatures: 0 };
  const conflicts: string[] = [];

  /** Carve a cell, unless somebody authored something there worth keeping. */
  const carve = (z: number, cell: number, stack: Placed[]) => {
    const here = at(cell);
    const existing = getStack(z, here.x, here.y);
    if (existing.some((t) => !OVERWRITABLE.has(t.tileId))) {
      conflicts.push(`${here.x},${here.y} L${z}: ${existing.map((t) => t.tileId).join("+")}`);
      return;
    }
    setStack(z, here.x, here.y, stack);
  };

  for (const floor of carved.floors) {
    for (let c = 0; c < floor.open.length; c++) {
      if (!floor.open[c]) continue;
      carve(floor.z, c, CAVE_FLOOR.map((t) => ({ ...t })));
      placed.floor++;
    }

    // The shell: rock within reach of anything carved, and only where the map
    // is empty. A cell that already holds something is either rock already or
    // somebody else's, and either way it is not ours to write.
    const shell = dilate(floor.open, WALL_SHELL);
    for (let c = 0; c < shell.length; c++) {
      if (!shell[c] || floor.open[c]) continue;
      if (carved.rampHoles.has(`${floor.z}:${c}`) || carved.pits.has(`${floor.z}:${c}`)) continue;
      const here = at(c);
      if (getStack(floor.z, here.x, here.y).length > 0) continue;
      setStack(floor.z, here.x, here.y, ROCK.map((t) => ({ ...t })));
      placed.rock++;
    }
  }

  // Holes, emptied after the shell so nothing fills them back in.
  for (const key of [...carved.pits, ...carved.rampHoles]) {
    const [z, cell] = key.split(":").map(Number) as [number, number];
    const here = at(cell);
    setStack(z, here.x, here.y, []);
    placed.holes++;
  }

  for (const ramp of carved.ramps) {
    carve(ramp.z, ramp.cell, [
      ...CAVE_FLOOR,
      { tileId: "ramp", direction: RAMP_FACING[ramp.ascend] },
    ]);
    placed.ramps++;
  }
  for (const crystal of carved.crystals) {
    carve(crystal.z, crystal.cell, [...CAVE_FLOOR, { tileId: crystal.tileId }]);
    placed.crystals++;
  }
  for (const creature of carved.creatures) {
    carve(creature.z, creature.cell, [
      ...CAVE_FLOOR,
      { tileId: creature.tileId, direction: "s" },
    ]);
    placed.creatures++;
  }

  /**
   * The lid: rock in the empty columns daylight comes down, at the topmost
   * level the caves use.
   *
   * One level is enough for all of them. The shaft is per column and stops
   * dead at the first full block, so a lid at the top floor leaves every level
   * under it with no sky of its own — and with no lit cell underground
   * anywhere, there is nothing left to spill sideways either. See
   * {@link DAYLIGHT_LID_REACH}.
   *
   * Only *empty* columns are lidded. A pond over the older dungeon is a
   * skylight somebody authored, and its floor is already down there sealing
   * it; putting rock under it would take the daylight out of a room that is
   * meant to have some.
   */
  const nearCaves = dilate(
    (() => {
      const carvedMask = newMask();
      for (const floor of carved.floors) {
        for (let c = 0; c < floor.open.length; c++) if (floor.open[c]) carvedMask[c] = 1;
      }
      return carvedMask;
    })(),
    DAYLIGHT_LID_REACH,
  );
  const lidLevel = SYSTEM.levels[0]!;
  for (let c = 0; c < SEALED_ROOF.length; c++) {
    if (SEALED_ROOF[c] || !nearCaves[c]) continue;
    const here = at(c);
    if (getStack(lidLevel, here.x, here.y).length > 0) continue;
    setStack(lidLevel, here.x, here.y, ROCK.map((t) => ({ ...t })));
    placed.lid++;
  }

  // The surface: the mouth itself is a hole, with stone around the sides so it
  // reads as cut into the ground rather than as a tile somebody forgot.
  const surfaceGround = (x: number, y: number): Placed[] => {
    const ground = getStack(0, x, y).filter(
      (t) => t.tileId === "grass" || t.tileId === "grass-2" || t.tileId === "dirt",
    );
    return ground.length ? ground : [{ tileId: "grass-2" }];
  };
  const approach = {
    x: SYSTEM.mouth.x - STEP[SYSTEM.mouthDescent].x,
    y: SYSTEM.mouth.y - STEP[SYSTEM.mouthDescent].y,
  };
  setStack(0, approach.x, approach.y, surfaceGround(approach.x, approach.y));
  for (const [dx, dy] of [
    [-1, -1],
    [-1, 0],
    [-1, 1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
  ] as const) {
    const x = SYSTEM.mouth.x + dx;
    const y = SYSTEM.mouth.y + dy;
    setStack(0, x, y, [...surfaceGround(x, y), { tileId: "stone-wall" }]);
  }

  return { placed, conflicts };
}

// ---------------------------------------------------------------------------
// Checking, by the game's own rules
// ---------------------------------------------------------------------------

/**
 * Walk the written map with `canWalk` and the real `player` tile.
 *
 * The generator's own reachability model above is a sketch of the movement
 * rules; this is the rules. Ramps, two-unit climbs, holes, headroom and the
 * tie between a full-height tile and the floor above it are all decided by the
 * code that decides them in play, against the file as it will be shipped.
 *
 * Creatures are lifted off the board first. A wolf is `walkable: false` and
 * would read as a wall in a corridor it is about to wander out of, which would
 * make this report rooms as sealed that are nothing of the sort.
 */
function checkWritten(carved?: Carved): string[] {
  const problems: string[] = [];
  let live = parseMap(serializeMap(chunkifyMap(map as never)));
  const playerDef = tilesById["player"]!;

  /**
   * The cells this run carved, so the check is about them and not about the
   * caves that were already down there.
   *
   * Without a carve to ask, `--verify` falls back to "underground floor" — a
   * looser net that also picks up the cellars and the older dungeon, whose
   * problems are somebody else's and are reported all the same.
   */
  const ours = carved
    ? new Set(
        carved.floors.flatMap((floor) => {
          const cells: string[] = [];
          for (let c = 0; c < floor.open.length; c++) {
            if (floor.open[c]) cells.push(`${cellX(c)},${cellY(c)},${floor.z}`);
          }
          return cells;
        }),
      )
    : null;

  const denCells = new Set<string>();
  const props = new Set<string>();
  const bodies: Array<{ x: number; y: number; z: number; def: TileDef }> = [];
  for (const z of SYSTEM.levels) {
    for (const { x, y, stack } of listCoords(live, z)) {
      if (stack.some((p) => p.tileId === "half-stone")) continue;
      if (!stack.some((p) => p.tileId === "dirt")) continue;
      if (ours && !ours.has(`${x},${y},${z}`)) continue;
      denCells.add(`${x},${y},${z}`);
      for (const placed of stack) {
        const def = tilesById[placed.tileId];
        if (!def) continue;
        if (def.kind === "battler") bodies.push({ x, y, z, def });
        else if (def.walkable === false) props.add(`${x},${y},${z}`);
      }
    }
  }

  // Daylight, before the creatures come off — occlusion does not care.
  const occlusion = new Map<string, ReturnType<typeof stackOcclusion>>();
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { x, y, stack } of listCoords(live, z)) {
      occlusion.set(`${z}:${coordKey(x, y)}`, stackOcclusion(stack, tilesById));
    }
  }
  for (const cell of denCells) {
    const [x, y, z] = cell.split(",").map(Number) as [number, number, number];
    if (!isSkyExposed(x, y, z, occlusion)) continue;
    if (x === SYSTEM.mouth.x && y === SYSTEM.mouth.y) continue;
    problems.push(`open sky over ${x},${y} on L${z}`);
  }

  /**
   * Daylight, as the baker actually spreads it — which is not the same question
   * as whether the column is open.
   *
   * `isSkyExposed` asks about the shaft straight up. The flood also walks light
   * sideways and down, so a cave can be lit at noon by a hole a dozen cells away
   * and three levels up, with nothing wrong at the cell itself. This is the
   * check that catches that, and it is why the mouth is the only opening the
   * caves have.
   */
  const flood = computeLightingFlood(live, tilesById);
  let daylit = 0;
  let worst = { sky: 0, at: "" };
  for (const cell of denCells) {
    const [x, y, z] = cell.split(",").map(Number) as [number, number, number];
    // The mouth is meant to let the day in, and to spill a little way inside.
    const fromMouth = Math.max(
      Math.abs(x - SYSTEM.mouth.x),
      Math.abs(y - SYSTEM.mouth.y),
    );
    if (fromMouth <= MAX_LIGHT_LEVEL) continue;
    const lv = flood.levels.get(z);
    if (!lv) continue;
    const lx = x - lv.x0;
    const ly = y - lv.y0;
    if (lx < 0 || ly < 0 || lx >= lv.w || ly >= lv.h) continue;
    const sky = lv.sky[ly * lv.w + lx]!;
    if (sky === 0) continue;
    daylit++;
    if (sky > worst.sky) worst = { sky, at: `${x},${y} L${z}` };
  }
  if (daylit > 0) {
    console.log(
      `${daylit} carved cells catch some daylight away from the mouth,` +
        ` the brightest ${worst.sky}/255 at ${worst.at}`,
    );
  }
  if (worst.sky > DIM_ENOUGH) {
    problems.push(
      `daylight reaches ${worst.at} at ${worst.sky}/255, which is a hole rather than a glow`,
    );
  }

  for (const body of bodies) {
    const room = fitsHeightAtElevation(
      live,
      body.x,
      body.y,
      body.z * HEIGHT_PER_LEVEL,
      body.def.height,
      tilesById,
      { throughPlayers: true },
    );
    if (!room.ok && room.reason?.includes("ceiling")) {
      problems.push(`${body.def.id} at ${body.x},${body.y} L${body.z} has no headroom`);
    }
  }

  // Off the board they come.
  for (const z of SYSTEM.levels) {
    for (const { x, y, stack } of listCoords(live, z)) {
      const kept = stack.filter((p) => tilesById[p.tileId]?.kind !== "battler");
      if (kept.length === stack.length) continue;
      live = replaceStack(live, x, y, z, kept);
    }
  }

  /** Where a body's feet come to rest in this column, arriving at `feetAbs`. */
  const settle = (x: number, y: number, feetAbs: number) => {
    const surfaces = listStandingSurfaces(live, x, y, tilesById);
    return (
      surfaces.find((s) => s.abs === feetAbs) ??
      surfaces.filter((s) => s.abs < feetAbs).sort((a, b) => b.abs - a.abs)[0] ??
      null
    );
  };
  const feetAt = (x: number, y: number, z: number) =>
    listStandingSurfaces(live, x, y, tilesById).find((s) => s.z === z)?.abs ??
    z * HEIGHT_PER_LEVEL;

  const approach = {
    x: SYSTEM.mouth.x - STEP[SYSTEM.mouthDescent].x,
    y: SYSTEM.mouth.y - STEP[SYSTEM.mouthDescent].y,
  };
  const start = settle(approach.x, approach.y, 0);
  if (!start) {
    problems.push("nowhere to stand on the approach to the mouth");
    return problems;
  }

  const seen = new Set([`${approach.x},${approach.y},${start.z}`]);
  const queue = [{ x: approach.x, y: approach.y, z: start.z }];
  for (let head = 0; head < queue.length; head++) {
    const from = queue[head]!;
    const stackIndex = getMapStack(live, from.x, from.y, from.z).length;
    for (const direction of DIRS) {
      const step = canWalk(live, { ...from, stackIndex }, direction, playerDef, tilesById);
      if (!step.ok) continue;
      // A step into open air commits to the level it left and gravity finishes
      // it, which is what makes a hole a route rather than a wall.
      const landed = settle(step.to.x, step.to.y, feetAt(step.to.x, step.to.y, step.to.z));
      if (!landed) continue;
      const key = `${step.to.x},${step.to.y},${landed.z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ x: step.to.x, y: step.to.y, z: landed.z });
    }
  }

  let stranded = 0;
  for (const cell of denCells) {
    if (seen.has(cell) || props.has(cell)) continue;
    stranded++;
  }
  if (stranded > 0) problems.push(`${stranded} carved cells cannot be walked to`);

  for (const body of bodies) {
    if (seen.has(`${body.x},${body.y},${body.z}`)) continue;
    problems.push(`${body.def.id} at ${body.x},${body.y} L${body.z} is walled in`);
  }

  for (const z of SYSTEM.levels) {
    for (const { x, y, stack } of listCoords(live, z)) {
      if (!stack.some((p) => p.tileId === "ramp")) continue;
      const onRamp = settle(x, y, z * HEIGHT_PER_LEVEL + 2);
      if (!onRamp || onRamp.abs !== z * HEIGHT_PER_LEVEL + 2) {
        problems.push(`ramp at ${x},${y} L${z} is not stood on`);
        continue;
      }
      const stackIndex = getMapStack(live, x, y, onRamp.z).length;
      const climbs = DIRS.some((direction) => {
        const step = canWalk(
          live,
          { x, y, z: onRamp.z, stackIndex },
          direction,
          playerDef,
          tilesById,
        );
        return step.ok && feetAt(step.to.x, step.to.y, step.to.z) > onRamp.abs;
      });
      if (!climbs) problems.push(`ramp at ${x},${y} L${z} climbs nowhere`);
      if (!seen.has(`${x},${y},${onRamp.z}`)) {
        problems.push(`ramp at ${x},${y} L${z} cannot be walked to`);
      }
    }
  }

  const walked = SYSTEM.levels.map(
    (z) => `L${z} ${[...seen].filter((k) => k.endsWith(`,${z}`)).length}`,
  );
  console.log(`carved ${denCells.size} cells; walked to ${walked.join(", ")}`);
  return problems;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

let carved: Carved | undefined;
if (!verifyOnly) {
  carved = carveSystem();
  const { placed, conflicts } = writeSystem(carved);
  await Bun.write(MAP_PATH, serializeMap(chunkifyMap(map as never)));
  console.log("carved", { ...placed, trimmedAfterWalking: carved.trimmed });
  for (const floor of carved.floors) {
    let open = 0;
    for (let c = 0; c < floor.open.length; c++) if (floor.open[c]) open++;
    console.log(
      `L${floor.z}: ${open} open cells,`,
      `${carved.ramps.filter((r) => r.z === floor.z).length} ramps,`,
      `${[...carved.pits].filter((k) => k.startsWith(`${floor.z}:`)).length} pits`,
    );
  }
  if (conflicts.length) {
    console.warn(`refused to overwrite ${conflicts.length} authored cells:`);
    console.warn(conflicts.slice(0, 10).join("\n"));
  }
}

const problems = checkWritten(carved);
if (problems.length === 0) {
  console.log("checked against the game's own movement rules: no problems");
} else {
  console.error(`${problems.length} problems:`);
  console.error(problems.slice(0, 40).join("\n"));
  if (problems.length > 40) console.error(`… and ${problems.length - 40} more`);
  process.exit(1);
}
