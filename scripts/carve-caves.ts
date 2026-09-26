import { MAP_FILE_VERSION } from "../app/lib/types";
import {
  chunkifyMap,
  getStack as getMapStack,
  listCoords,
  parseMap,
  removeTileAt,
  replaceStack,
  serializeMap,
} from "../app/lib/mapData";
import { canTeleportFrom, teleportFits } from "../app/game/affordances";
import { canWalk, listStandingSurfaces } from "../app/game/movement";
import { findPlayers } from "../app/game/player";
import { resolveSwitch, resolveTeleport } from "../app/lib/interactions";
import { mulberry32 } from "../app/editor/generator";
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
  resolveIntangible,
} from "../app/lib/types";
import type { Direction, PlacedTile, TileDef } from "../app/lib/types";

type Placed = { tileId: string; direction?: Direction; description?: string };

const SYSTEM = {
  levels: [-1, -2, -3] as const,
  seeds: [0x5ea11ce, 0x7b04e57, 0xcabe770] as const,

  mouth: { x: 10, y: 20 },
  mouthDescent: "s" as Direction,

  rockChance: { open: 0.5, dense: 0.66 },

  rampsPerTransition: 14,
  rampSpacing: 14,

  pitsPerFloor: [10, 10, 0],

  population: [
    { rat: 32, wolf: 0, "cave-troll": 0 },
    { rat: 40, wolf: 11, "cave-troll": 0 },
    { rat: 50, wolf: 20, "cave-troll": 1 },
  ] as ReadonlyArray<Readonly<Record<string, number>>>,

  cellsPerCrystal: 190,
} as const;

/**
 * Holes in the surface drawn with the `hole` tile: a shaft beside a ladder, and
 * a hole in a house floor over its cellar. Daylight through them is meant, as it
 * is through the mouth, so the sky checks treat them as openings too.
 */
const AUTHORED_HOLES = [
  { x: -2, y: 31 },
  { x: 55, y: -12 },
] as const;

const ROCK: Placed[] = [{ tileId: "half-stone" }, { tileId: "half-stone" }];
const CAVE_FLOOR: Placed[] = [{ tileId: "dirt" }];

const OVERWRITABLE = new Set(["dirt", "half-stone", "grass-2", "grass"]);

const EXISTING_CAVE_BUFFER = 3;

const WALL_SHELL = 2;

const DAYLIGHT_LID_REACH = MAX_LIGHT_LEVEL;

const MIN_REGION_CELLS = 24;

const TUNNEL_BULGE_CHANCE = 0.4;

const DENSITY_FIELD_SCALE = 22;

const SMOOTH_PASSES = 5;

const ROCK_CROWDING = 5;

const OPEN_SPRAWL = 4;
const SPRAWL_PASSES = 4;

const DIM_ENOUGH = 64;

const PIT_SPACING = 14;
const PIT_RAMP_CLEARANCE = 4;

const CREATURE_SPACING = 4;
const ARRIVAL_SAFE_RADIUS = 5;

const CRYSTAL_NOOK_ROCK = 5;
const CRYSTAL_SPACING = 8;
const CRYSTAL_HOLE_REACH = 2;

/**
 * A level-tall tile tops out on the floor plane above, and `surfaceTileAt` takes
 * the lower stack on that tie, so an unwalkable tall crystal makes the cell
 * above it unwalkable. Tall crystals only go where the roof is rock.
 */
const TALL_CRYSTAL_TILES = ["arcane-crystal-1", "arcane-crystal-2"];
const LOW_CRYSTAL_TILES = ["arcane-crystal-3"];

const MAP_PATH = "data/map.json";
const TILES_PATH = "data/tiles.json";
const verifyOnly = process.argv.includes("--verify");

type Flat = {
  version: typeof MAP_FILE_VERSION;
  levels: Record<string, Record<string, Placed[]>>;
};
const map: Flat = JSON.parse(await Bun.file(MAP_PATH).text());
const tiles: TileDef[] = (JSON.parse(await Bun.file(TILES_PATH).text()) as unknown[]).map((raw) =>
  normalizeTileDef(raw),
);
const tilesById = tilesByIdFromList(tiles);

const level = (z: number) => (map.levels[String(z)] ??= {});
const getStack = (z: number, x: number, y: number): Placed[] => level(z)[coordKey(x, y)] ?? [];
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
const RAMP_FACING: Record<Direction, Direction> = { n: "s", e: "w", s: "n", w: "e" };
const OPPOSITE = RAMP_FACING;

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

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
const chebyshev = (a: Cell, b: Cell) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

type Mask = Uint8Array;
const newMask = () => new Uint8Array(W * H);

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

const SEALED_ROOF: Mask = (() => {
  const mask = newMask();
  for (const key of surfaceKeys) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    const stack = (map.levels["0"]![key] ?? []) as PlacedTile[];
    const { opacity, sealsLevel } = stackOcclusion(stack, tilesById);
    /**
     * A bare floor (opacity 0) hard-seals the sky shaft and a full block stops
     * it. Anything between, such as a bush or a pond, lets daylight through at
     * partial strength, so no cave is carved under it.
     */
    if ((sealsLevel && opacity === 0) || opacity >= 1) {
      mask[idx(x, y)] = 1;
    }
  }
  return mask;
})();

function isExistingOpen(z: number, x: number, y: number): boolean {
  const stack = getStack(z, x, y);
  if (stack.length === 0) return false;
  return !stack.some((t) => t.tileId === "half-stone");
}

const INSIDE_THE_MAP: Mask = (() => {
  const mask = newMask();
  for (let i = 0; i < mask.length; i++) {
    const here = at(i);
    const fromEdge = Math.min(here.x - X0, X1 - here.x, here.y - Y0, Y1 - here.y);
    mask[i] = fromEdge >= DAYLIGHT_LID_REACH ? 1 : 0;
  }
  return mask;
})();

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
      if (!inBounds(x + dx, y + dy) || rock[idx(x + dx, y + dy)]) n++;
    }
  }
  return n;
}

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
      const sprawling = pass < SPRAWL_PASSES && rockAround(rock, here.x, here.y, 2) <= OPEN_SPRAWL;
      next[i] = crowded || sprawling ? 1 : 0;
    }
    rock = next;
  }
  return rock;
}

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
      for (const i of next) rock[i] = 1;
      continue;
    }
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

  const regions = regionsOf(rock);
  const main = regions.find((r) => r.includes(anchor)) ?? regions[0] ?? [];
  const keep = new Uint8Array(rock.length);
  for (const i of main) keep[i] = 1;
  for (let i = 0; i < rock.length; i++) if (!rock[i] && !keep[i]) rock[i] = 1;
}

function carveRoom(rock: Mask, candidates: Mask, cell: Cell) {
  rock[idx(cell.x, cell.y)] = 0;
  candidates[idx(cell.x, cell.y)] = 1;
  for (const dir of DIRS) {
    const n = { x: cell.x + STEP[dir].x, y: cell.y + STEP[dir].y };
    if (inBounds(n.x, n.y) && candidates[idx(n.x, n.y)]) rock[idx(n.x, n.y)] = 0;
  }
}

type Floor = { z: number; rock: Mask; open: Mask };
type Ramp = { z: number; cell: number; ascend: Direction };
type Prop = { z: number; cell: number; tileId: string };

type Carved = {
  floors: Floor[];
  ramps: Ramp[];
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

  ramps.push({
    z: SYSTEM.levels[0]!,
    cell: idx(SYSTEM.mouth.x, SYSTEM.mouth.y),
    ascend: OPPOSITE[SYSTEM.mouthDescent],
  });

  const rampHoles = new Set(ramps.map((r) => `${r.z + 1}:${r.cell}`));
  /**
   * A three-high body standing on a two-high ramp reaches a unit into the level
   * above, so the cell over every ramp must be empty: it becomes the hole.
   */
  for (const ramp of ramps) floorAt(ramp.z + 1)?.open.fill(0, ramp.cell, ramp.cell + 1);

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

  for (const ramp of ramps) floorAt(ramp.z)!.open[ramp.cell] = 1;
  const rampAt = new Map(ramps.map((r) => [`${r.z}:${r.cell}`, r] as const));

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
        if (rampHoles.has(`${z}:${nc}`)) visit(`${z - 1}:${nc}`);
        else if (pits.has(`${z}:${nc}`) && floorAt(z - 1)?.open[nc]) visit(`${z - 1}:${nc}`);
      }

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

  for (const ramp of [...ramps]) {
    const out = {
      x: cellX(ramp.cell) + STEP[ramp.ascend].x,
      y: cellY(ramp.cell) + STEP[ramp.ascend].y,
    };
    const landing =
      ramp.z + 1 > SYSTEM.levels[0]! ? true : floorAt(ramp.z + 1)?.open[idx(out.x, out.y)] === 1;
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

  const crystals: Prop[] = [];
  const creatures: Prop[] = [];
  const filled = new Set<string>();
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
      standable.filter((c) => rockAround(floor.rock, cellX(c), cellY(c), 1) >= CRYSTAL_NOOK_ROCK),
      random,
    );
    const chosen: number[] = [];
    const take = (c: number) => {
      if (chosen.includes(c) || wouldPinch(floor, c)) return;
      chosen.push(c);
      floor.open[c] = 0;
      filled.add(`${floor.z}:${c}`);
    };

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
      const kinds = upper?.rock[c] === 1 ? TALL_CRYSTAL_TILES : LOW_CRYSTAL_TILES;
      crystals.push({ z: floor.z, cell: c, tileId: kinds[Math.floor(random() * kinds.length)]! });
    }

    const arrivals = ramps.filter((r) => Math.abs(r.z - floor.z) <= 1).map((r) => at(r.cell));
    const habitable = standable.filter(
      (c) =>
        !filled.has(`${floor.z}:${c}`) &&
        arrivals.every((a) => chebyshev(a, at(c)) >= ARRIVAL_SAFE_RADIUS),
    );

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

function writeSystem(carved: Carved) {
  const placed = { floor: 0, rock: 0, lid: 0, ramps: 0, holes: 0, crystals: 0, creatures: 0 };
  const conflicts: string[] = [];

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
      carve(
        floor.z,
        c,
        CAVE_FLOOR.map((t) => ({ ...t })),
      );
      placed.floor++;
    }

    const shell = dilate(floor.open, WALL_SHELL);
    for (let c = 0; c < shell.length; c++) {
      if (!shell[c] || floor.open[c]) continue;
      if (carved.rampHoles.has(`${floor.z}:${c}`) || carved.pits.has(`${floor.z}:${c}`)) continue;
      const here = at(c);
      if (getStack(floor.z, here.x, here.y).length > 0) continue;
      setStack(
        floor.z,
        here.x,
        here.y,
        ROCK.map((t) => ({ ...t })),
      );
      placed.rock++;
    }
  }

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
    carve(creature.z, creature.cell, [...CAVE_FLOOR, { tileId: creature.tileId, direction: "s" }]);
    placed.creatures++;
  }

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
    setStack(
      lidLevel,
      here.x,
      here.y,
      ROCK.map((t) => ({ ...t })),
    );
    placed.lid++;
  }

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

function checkWritten(carved?: Carved): string[] {
  const problems: string[] = [];
  let live = parseMap(serializeMap(chunkifyMap(map as never)));
  const playerDef = tilesById["player"]!;

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

  const occlusion = new Map<string, ReturnType<typeof stackOcclusion>>();
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { x, y, stack } of listCoords(live, z)) {
      occlusion.set(`${z}:${coordKey(x, y)}`, stackOcclusion(stack, tilesById));
    }
  }
  const openings: readonly Cell[] = [SYSTEM.mouth, ...AUTHORED_HOLES];
  for (const cell of denCells) {
    const [x, y, z] = cell.split(",").map(Number) as [number, number, number];
    if (!isSkyExposed(x, y, z, occlusion)) continue;
    if (openings.some((o) => o.x === x && o.y === y)) continue;
    problems.push(`open sky over ${x},${y} on L${z}`);
  }

  const flood = computeLightingFlood(live, tilesById);
  let daylit = 0;
  let worst = { sky: 0, at: "" };
  for (const cell of denCells) {
    const [x, y, z] = cell.split(",").map(Number) as [number, number, number];
    if (openings.some((o) => chebyshev(o, { x, y }) <= MAX_LIGHT_LEVEL)) continue;
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
      `${daylit} carved cells catch some daylight away from the openings,` +
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

  const spawns = findPlayers(live);
  for (const spawn of spawns) {
    live = removeTileAt(live, spawn.x, spawn.y, spawn.z, spawn.stackIndex);
  }

  for (const z of SYSTEM.levels) {
    for (const { x, y, stack } of listCoords(live, z)) {
      const kept = stack.filter((p) => tilesById[p.tileId]?.kind !== "battler");
      if (kept.length === stack.length) continue;
      live = replaceStack(live, x, y, z, kept);
    }
  }

  /**
   * Whoever walks up to a closed door can open it, so the walk sees every
   * switch that turns its tile into an intangible one as already thrown.
   */
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { x, y, stack } of listCoords(live, z)) {
      let opened = false;
      const next = stack.map((placed) => {
        const def = tilesById[placed.tileId];
        const target = def && tilesById[resolveSwitch(def)?.targetTileId ?? ""];
        if (!target || !resolveIntangible(target)) return placed;
        opened = true;
        return { ...placed, tileId: target.id };
      });
      if (opened) live = replaceStack(live, x, y, z, next);
    }
  }

  const settle = (x: number, y: number, feetAbs: number) => {
    const surfaces = listStandingSurfaces(live, x, y, tilesById);
    return (
      surfaces.find((s) => s.abs === feetAbs) ??
      surfaces.filter((s) => s.abs < feetAbs).sort((a, b) => b.abs - a.abs)[0] ??
      null
    );
  };
  const feetAt = (x: number, y: number, z: number) =>
    listStandingSurfaces(live, x, y, tilesById).find((s) => s.z === z)?.abs ?? z * HEIGHT_PER_LEVEL;

  const approach = {
    x: SYSTEM.mouth.x - STEP[SYSTEM.mouthDescent].x,
    y: SYSTEM.mouth.y - STEP[SYSTEM.mouthDescent].y,
  };
  const start = settle(approach.x, approach.y, 0);
  if (!start) {
    problems.push("nowhere to stand on the approach to the mouth");
    return problems;
  }

  const seen = new Set<string>();
  const queue: Array<{ x: number; y: number; z: number }> = [];
  const arrive = (x: number, y: number, z: number) => {
    const landed = settle(x, y, feetAt(x, y, z));
    if (!landed || seen.has(`${x},${y},${landed.z}`)) return;
    seen.add(`${x},${y},${landed.z}`);
    queue.push({ x, y, z: landed.z });
  };
  arrive(approach.x, approach.y, start.z);
  for (const spawn of spawns) arrive(spawn.x, spawn.y, spawn.z);

  for (let head = 0; head < queue.length; head++) {
    const from = queue[head]!;
    const stack = getMapStack(live, from.x, from.y, from.z);
    for (const direction of DIRS) {
      const step = canWalk(
        live,
        { ...from, stackIndex: stack.length },
        direction,
        playerDef,
        tilesById,
      );
      if (step.ok) arrive(step.to.x, step.to.y, step.to.z);
    }
    stack.forEach((placed, stackIndex) => {
      const teleport = resolveTeleport(placed, tilesById[placed.tileId], from);
      if (!teleport) return;
      const usable =
        teleport.trigger === "step"
          ? teleportFits(live, tilesById, playerDef, teleport.to)
          : canTeleportFrom(live, tilesById, from, { ...from, stackIndex }, playerDef);
      if (usable) arrive(teleport.to.x, teleport.to.y, teleport.to.z);
    });
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
