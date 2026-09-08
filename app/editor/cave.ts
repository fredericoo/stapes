/**
 * The cave generator: a rectangle of solid rock with a cave carved out of it.
 *
 * The order is the whole design. **Block out, carve, widen, join, decorate** —
 * and the three middle steps are separate because each of them can undo the
 * one before it. Carving leaves passages a single cell wide, which the camera
 * hides; widening them closes some off entirely; joining what is left is
 * therefore the last thing that touches the shape, and everything after it
 * only puts things on a floor that is already final.
 *
 * See `docs/notes.md`, "A cave is rock you take away from".
 */

import { getStack, isPlayerBody, setStacks, type StackEdit } from "../lib/mapData";
import type { MapFile, PlacedTile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL, physicalHeight, resolveActor } from "../lib/types";
import { canReplaceStack } from "../lib/validation";
import {
  HALF_LEVEL,
  MAX_FOOTPRINT,
  type Bounds,
  type CellGrid,
  type Connection,
  type GeneratedPlan,
  type Rect,
  type ScatterRule,
  boundsOf,
  columnOf,
  connectionsAlongBorder,
  countOpen,
  cutFords,
  fbm,
  joinRegions,
  gridIndex,
  gridX,
  gridY,
  isJoinableGround,
  isOpen,
  mulberry32,
  newGrid,
  openCells,
  openConnection,
  placed,
  planScatter,
  planWater,
  randomAt,
  regionsOf,
  setOpen,
  widenToTwo,
} from "./generator";

/**
 * How the rock is carved. Three shapes because they are three different
 * places, not three settings of one:
 *
 * - **Caverns** is a cellular automaton, the same one `scripts/carve-caves.ts`
 *   digs the animal den with. Rounded halls with pillars and islands in them,
 *   joined by whatever the smoothing happened to leave. It reads as eroded.
 * - **Veins** thresholds a band around the middle of a noise field, which is a
 *   contour line and so comes out as long sinuous passages that wander and
 *   branch and rarely open out. It reads as water-cut.
 * - **Tunnels** sends diggers out from the middle. Everything is connected
 *   because everything was walked to, and the corridors are straighter and
 *   more even than either of the others. It reads as dug.
 */
export type CaveShape = "caverns" | "veins" | "tunnels";

export const CAVE_SHAPES: Array<{ id: CaveShape; label: string; hint: string }> = [
  { id: "caverns", label: "Caverns", hint: "Rounded halls with pillars — eroded" },
  { id: "veins", label: "Veins", hint: "Long sinuous passages — water-cut" },
  { id: "tunnels", label: "Tunnels", hint: "Even corridors from the middle — dug" },
];

export type CaveConfig = {
  generator: "cave";
  /** Change it and the same rectangle carves a different cave. */
  seed: number;
  shape: CaveShape;
  /** 0–100. How much rock the carve leaves: open halls at 0, a warren at 100. */
  density: number;
  /** What the rock is. A column of it fills the level exactly. */
  wallTileId: string;
  /**
   * The low wall taken instead, here and there, where rock meets floor.
   * `null` keeps every wall full height.
   */
  ledgeTileId: string | null;
  /** 0–100. How often an edge of the cave takes the low wall. */
  ledgeChance: number;
  /** Laid under every cell you can stand on. */
  floorTileId: string;
  /** A second floor drawn in patches over the first. `null` for one floor. */
  accentFloorTileId: string | null;
  /** 0–100. Roughly the share of the floor the patches cover. */
  accentCoverage: number;
  /** `null` for a dry cave. */
  waterTileId: string | null;
  /** 0–100. Share of the floor under water, mostly as streams. */
  waterCoverage: number;
  scatter: ScatterRule[];
};

/** How solid the carve may be asked to leave the rock. */
export const CAVE_DENSITY_RANGE = { min: 0, max: 100 } as const;

/**
 * The smallest cave worth generating: a ring of rock, and inside it enough
 * room for the two-wide rule to have somewhere to put a passage.
 */
export const MIN_CAVE_FOOTPRINT = 6;

/** Cells of rock kept around the carve, so the block-out is a closed shell. */
const BORDER = 1;

// --- Caverns ---------------------------------------------------------------

/**
 * The automaton's starting rock fraction, at its most open and most solid.
 *
 * Below about 0.44 the smoothing has nothing to bite on and the whole
 * rectangle comes out as one room; above about 0.70 it closes into rock that
 * nothing but the joining pass then crosses.
 */
const CAVERN_ROCK_CHANCE = { open: 0.44, dense: 0.7 } as const;

/**
 * How far the density field moves the starting fraction either side of that.
 *
 * This is the difference between a cave and a texture: with one fraction over
 * the whole rectangle every part of it comes out equally porous, and varying
 * it by region is what makes one end a hall and the other a warren.
 */
const CAVERN_DENSITY_SWING = 0.08;

/** Cells across one lobe of the density field. */
const DENSITY_FIELD_SCALE = 18;

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

// --- Veins -----------------------------------------------------------------

/** Cells across one lobe of the vein field. Long, because veins are long. */
const VEIN_SCALE = 26;
const VEIN_OCTAVES = 3;

/**
 * Half-width of the band kept open around the middle of the field, at its
 * widest and narrowest. The field is three octaves of value noise, which
 * clusters hard around 0.5 — a tenth either side is already a broad passage.
 */
const VEIN_BAND = { wide: 0.13, narrow: 0.05 } as const;

// --- Tunnels ---------------------------------------------------------------

/** Share of the rectangle the diggers try to open, at density 0 and at 100. */
const TUNNEL_OPEN_SHARE = { loose: 0.45, tight: 0.16 } as const;

/**
 * Chance a digger wanders instead of heading for its mark.
 *
 * **A digger has to be going somewhere, or it never leaves.** A walk that
 * turns at random is a walk that stays where it started: at this rectangle's
 * size it opens a third of the cells and every one of them is in the same
 * corner. Giving each digger a point to reach and letting it stray on the way
 * is what turns the same number of steps into corridors that cross the
 * rectangle — and the straying is what keeps them from being ruled lines.
 */
const TUNNEL_STRAY_CHANCE = 0.3;

/** Chance a digger leaves a second one behind it at a step. */
const TUNNEL_BRANCH_CHANCE = 0.03;

/** Diggers at once, and cells of rectangle per digger the walk starts with. */
const TUNNEL_MAX_DIGGERS = 10;
const CELLS_PER_DIGGER = 350;

/** Steps before the walk is given up on, however much is still solid. */
const TUNNEL_MAX_STEPS = 6000;

// --- Joining up ------------------------------------------------------------

/**
 * Cells a region needs before it is joined rather than filled back in.
 *
 * Four is the smallest a region can be once the two-wide rule has run, and a
 * cave whose far end is a 2×2 closet reached down a long bored corridor is
 * worse than one without it.
 */
const MIN_REGION_CELLS = 10;

/** Rounds of widening and joining before the leftovers are filled in instead. */
const JOIN_ATTEMPTS = 4;

/**
 * How far in a way-in from the neighbouring cave is cut before it gives up and
 * leaves the rest to {@link joinRegions}.
 *
 * Six, so that a stub which meets nothing is twelve cells and comfortably over
 * {@link MIN_REGION_CELLS} — under it the way in would be filled back in as
 * not worth reaching, which is the opposite of what it is for.
 */
const CONNECTION_DEPTH = 6;

const STEPS = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
] as const;

/** Cells across one patch of the alternative floor. */
const ACCENT_FIELD_SCALE = 7;
const ACCENT_OCTAVES = 2;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** The area a shape may carve into: everything but the rock shell. */
function inner(bounds: Bounds): Bounds {
  return {
    minX: bounds.minX + BORDER,
    maxX: bounds.maxX - BORDER,
    minY: bounds.minY + BORDER,
    maxY: bounds.maxY - BORDER,
  };
}

function carveCaverns(g: CellGrid, box: Bounds, config: CaveConfig): void {
  const t = clamp01(config.density / 100);
  const base = lerp(CAVERN_ROCK_CHANCE.open, CAVERN_ROCK_CHANCE.dense, t);

  for (let y = box.minY; y <= box.maxY; y++) {
    for (let x = box.minX; x <= box.maxX; x++) {
      const field = fbm(x, y, config.seed ^ 0x51ce, DENSITY_FIELD_SCALE, 2);
      const rockChance = base + (field - 0.5) * 2 * CAVERN_DENSITY_SWING;
      setOpen(g, x, y, randomAt(x, y, config.seed) >= rockChance);
    }
  }

  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const next = new Uint8Array(g.cells);
    for (let y = box.minY; y <= box.maxY; y++) {
      for (let x = box.minX; x <= box.maxX; x++) {
        const rock =
          rockAround(g, x, y, 1) >= ROCK_CROWDING ||
          (pass < SPRAWL_PASSES && rockAround(g, x, y, 2) <= OPEN_SPRAWL);
        next[gridIndex(g, x, y)] = rock ? 0 : 1;
      }
    }
    g.cells.set(next);
  }
}

/** Rock cells in the square of `radius` around (x, y), the centre excluded. */
function rockAround(g: CellGrid, x: number, y: number, radius: number): number {
  let rock = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      // Off the grid counts as rock, which is what keeps the shell solid.
      if (!isOpen(g, x + dx, y + dy)) rock++;
    }
  }
  return rock;
}

function carveVeins(g: CellGrid, box: Bounds, config: CaveConfig): void {
  const t = clamp01(config.density / 100);
  const band = lerp(VEIN_BAND.wide, VEIN_BAND.narrow, t);
  for (let y = box.minY; y <= box.maxY; y++) {
    for (let x = box.minX; x <= box.maxX; x++) {
      const field = fbm(x, y, config.seed, VEIN_SCALE, VEIN_OCTAVES);
      setOpen(g, x, y, Math.abs(field - 0.5) < band);
    }
  }
}

function carveTunnels(g: CellGrid, box: Bounds, config: CaveConfig): void {
  const t = clamp01(config.density / 100);
  const area = (box.maxX - box.minX + 1) * (box.maxY - box.minY + 1);
  const target = Math.round(
    area * lerp(TUNNEL_OPEN_SHARE.loose, TUNNEL_OPEN_SHARE.tight, t),
  );
  const random = mulberry32(config.seed >>> 0);
  const somewhere = () => ({
    x: box.minX + Math.floor(random() * (box.maxX - box.minX + 1)),
    y: box.minY + Math.floor(random() * (box.maxY - box.minY + 1)),
  });

  type Digger = { x: number; y: number; mark: { x: number; y: number } };
  const diggerCount = Math.min(
    TUNNEL_MAX_DIGGERS,
    Math.max(2, Math.round(area / CELLS_PER_DIGGER)),
  );
  let diggers: Digger[] = [];
  for (let i = 0; i < diggerCount; i++) {
    diggers.push({ ...somewhere(), mark: somewhere() });
  }

  // The brush is 2x2 rather than one cell, so a corridor is already wide
  // enough for the camera before the widening pass ever sees it.
  let open = 0;
  const dig = (x: number, y: number) => {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const cx = Math.min(box.maxX, Math.max(box.minX, x + dx));
        const cy = Math.min(box.maxY, Math.max(box.minY, y + dy));
        if (!isOpen(g, cx, cy)) open++;
        setOpen(g, cx, cy, true);
      }
    }
  };

  for (let step = 0; step < TUNNEL_MAX_STEPS && open < target; step++) {
    const next: Digger[] = [];
    for (const digger of diggers) {
      dig(digger.x, digger.y);
      if (digger.x === digger.mark.x && digger.y === digger.mark.y) {
        digger.mark = somewhere();
      }
      const stray = random() < TUNNEL_STRAY_CHANCE;
      const towards = stray
        ? STEPS[Math.floor(random() * STEPS.length)]!
        : stepTowards(digger, digger.mark, random);
      digger.x = Math.min(box.maxX, Math.max(box.minX, digger.x + towards.dx));
      digger.y = Math.min(box.maxY, Math.max(box.minY, digger.y + towards.dy));
      next.push(digger);
      if (random() < TUNNEL_BRANCH_CHANCE && next.length < TUNNEL_MAX_DIGGERS) {
        next.push({ x: digger.x, y: digger.y, mark: somewhere() });
      }
    }
    diggers = next;
  }
}

/**
 * One orthogonal step from `from` towards `to`.
 *
 * The axis is picked in proportion to how far there is left to go on each, so
 * a digger with twice as far to travel east as south goes east twice as often
 * — which is a rough diagonal rather than the L that taking the longer axis
 * every time produces.
 */
function stepTowards(
  from: { x: number; y: number },
  to: { x: number; y: number },
  random: () => number,
): { dx: number; dy: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const horizontal =
    Math.abs(dx) + Math.abs(dy) === 0
      ? random() < 0.5
      : random() * (Math.abs(dx) + Math.abs(dy)) < Math.abs(dx);
  if (horizontal) return { dx: Math.sign(dx) || 1, dy: 0 };
  return { dx: 0, dy: Math.sign(dy) || 1 };
}

/** The grid a shape leaves once it has been widened and joined up. */
export function carveCave(
  bounds: Bounds,
  config: CaveConfig,
  connections: readonly Connection[] = [],
): CellGrid {
  const grid = newGrid(bounds);
  const box = inner(bounds);
  if (box.minX > box.maxX || box.minY > box.maxY) return grid;

  if (config.shape === "caverns") carveCaverns(grid, box, config);
  else if (config.shape === "veins") carveVeins(grid, box, config);
  else carveTunnels(grid, box, config);

  // Ways in are cut before the widening, so they are held to the same rules as
  // the rest of the cave and so joining can reach them.
  for (const connection of connections) {
    openConnection(grid, bounds, connection, CONNECTION_DEPTH);
  }

  // Widening and joining each undo a little of the other: widening a corridor
  // to two cells can pinch it shut, and the corridor bored to replace it can
  // meet its region at an angle that widening then pinches in turn. So they
  // alternate until the cave is one piece rather than running once each.
  for (let attempt = 0; attempt < JOIN_ATTEMPTS; attempt++) {
    widenToTwo(grid);
    if (regionsOf(grid).length <= 1) return grid;
    joinRegions(grid, box, config.seed + attempt, MIN_REGION_CELLS);
  }

  // Still in pieces after all that, which a handful of seeds in a few hundred
  // are: keep the largest and fill the rest back in. A cave with a room nobody
  // can walk to is worse than a slightly smaller cave.
  widenToTwo(grid);
  const regions = regionsOf(grid);
  for (const region of regions.slice(1)) {
    for (const i of region) grid.cells[i] = 0;
  }
  return grid;
}

/**
 * Cut the water's channel through the cave, and through the rock around it.
 *
 * The water is planned over the whole inside of the rectangle rather than over
 * the floor already carved, so a stream that runs into rock takes the rock
 * out. That is the order water and stone actually happen in, and without it
 * the streams read as puddles sitting in rooms somebody else dug. The shell is
 * never eroded: {@link inner} is what the water is clamped to.
 */
export function erodeWithWater(
  grid: CellGrid,
  bounds: Bounds,
  config: CaveConfig,
): Set<number> {
  const water = planWater(
    grid,
    inner(bounds),
    config.seed ^ 0x7a7e2,
    config.waterCoverage,
  );
  for (const i of water) {
    setOpen(grid, gridX(grid, i), gridY(grid, i), true);
  }
  return water;
}

/** Rock that touches the cave, and so is a wall somebody will stand next to. */
function isCaveEdge(g: CellGrid, bounds: Bounds, x: number, y: number): boolean {
  // The shell is never an edge: a low wall there is a hole in the block-out,
  // and what you would see over it is whatever the map has outside — usually
  // nothing at all.
  if (x === bounds.minX || x === bounds.maxX) return false;
  if (y === bounds.minY || y === bounds.maxY) return false;
  return STEPS.some(({ dx, dy }) => isOpen(g, x + dx, y + dy));
}

/**
 * The whole cave as one list of stack edits, or the reason it cannot be built.
 *
 * The block-out **replaces** what is on the level inside the rectangle rather
 * than stacking on it, which is the difference between this and the house: a
 * house is put on a site, and a cave is what is left of one. Dragging one over
 * work already there takes it out, and takes one press of undo to get back.
 */
export function planCave(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  rect: Rect,
  z: number,
  config: CaveConfig,
): GeneratedPlan {
  const bounds = boundsOf(rect);
  const width = bounds.maxX - bounds.minX + 1;
  const depth = bounds.maxY - bounds.minY + 1;

  if (width < MIN_CAVE_FOOTPRINT || depth < MIN_CAVE_FOOTPRINT) {
    return {
      ok: false,
      reason: `A cave is at least ${MIN_CAVE_FOOTPRINT}×${MIN_CAVE_FOOTPRINT} cells`,
    };
  }
  if (width > MAX_FOOTPRINT || depth > MAX_FOOTPRINT) {
    return {
      ok: false,
      reason: `A cave is at most ${MAX_FOOTPRINT}×${MAX_FOOTPRINT} cells`,
    };
  }

  const floorDef = tilesById[config.floorTileId];
  if (!floorDef) {
    return { ok: false, reason: `There is no tile called ${config.floorTileId}` };
  }

  // **The floor is laid under the rock as well as under the cave.** Carving a
  // wall away later then leaves ground rather than a hole, which is what makes
  // a generated cave something you can keep editing by hand. It costs a quad
  // per wall cell; `scripts/carve-caves.ts` makes the opposite trade at the
  // scale of the animal den, where those quads run to five figures.
  const floorUnder = placed(config.floorTileId, tilesById);
  const rockHeight = HEIGHT_PER_LEVEL - physicalHeight(floorDef);
  const ledgeHeight = HALF_LEVEL - physicalHeight(floorDef);
  if (rockHeight <= 0) {
    return {
      ok: false,
      reason: `${floorDef.name} stands ${physicalHeight(floorDef)} units, leaving no room for rock in the ${HEIGHT_PER_LEVEL} a level holds`,
    };
  }

  const wall = columnOf(config.wallTileId, rockHeight, tilesById);
  if (!wall.ok) return wall;
  const ledge =
    config.ledgeTileId && ledgeHeight > 0
      ? columnOf(config.ledgeTileId, ledgeHeight, tilesById)
      : null;
  if (ledge && !ledge.ok) return ledge;

  for (let y = bounds.minY; y <= bounds.maxY; y++) {
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      for (const p of getStack(map, x, y, z)) {
        const def = tilesById[p.tileId];
        if (isPlayerBody(p) || (def && resolveActor(def))) {
          return { ok: false, reason: `Somebody is standing at ${x},${y}` };
        }
      }
    }
  }

  // **Where the rectangle meets a floor of its own kind, it opens on to it.**
  // That is what lets a big cave be dragged as several rectangles: land the new
  // one a couple of cells over the old one, and the wall between them is
  // notched through rather than doubled. The accent floor counts, since it is
  // the same ground.
  const ourFloors = [config.floorTileId, config.accentFloorTileId].filter(
    (id): id is string => id !== null,
  );
  const connections = connectionsAlongBorder(
    bounds,
    isJoinableGround(map, tilesById, z, ourFloors),
  );

  const grid = carveCave(bounds, config, connections);
  if (countOpen(grid) === 0) {
    return {
      ok: false,
      reason: "The cave came out solid — lower the density or drag a bigger rectangle",
    };
  }

  const water = config.waterTileId
    ? erodeWithWater(grid, bounds, config)
    : new Set<number>();
  cutFords(grid, water);

  const dry = openCells(grid).filter((c) => !water.has(gridIndex(grid, c.x, c.y)));
  // The tallest the floor gets anywhere, since the alternative floor is laid
  // on top of the base one: a prop has to fit on the deepest cell, not the
  // shallowest, or the plan is refused on the patches after it is drawn.
  const accentDef = config.accentFloorTileId
    ? tilesById[config.accentFloorTileId]
    : undefined;
  const floorHeight =
    physicalHeight(floorDef) + (accentDef ? physicalHeight(accentDef) : 0);
  const scatter = planScatter(
    dry,
    config.scatter,
    config.seed ^ 0x5ca77e2,
    floorHeight,
    tilesById,
  );

  const accentCoverage = clamp01(config.accentCoverage / 100);
  /**
   * The floor of one cell: the base floor, and the alternative floor **on top
   * of it** where the patches fall.
   *
   * On top rather than instead of, because the base floor is what the cell
   * stands on and the alternative is a covering laid over it — a scatter of
   * pebbles over dirt is dirt with pebbles on it, and swapping the two leaves
   * the patch reading as a hole in the ground the base floor was.
   */
  const floorFor = (x: number, y: number): PlacedTile[] => {
    const base = placed(config.floorTileId, tilesById);
    if (!config.accentFloorTileId || accentCoverage <= 0) return [base];
    // A field rather than white noise: the alternative floor is meant to read
    // as patches of a different ground, and per-cell randomness reads as dirt.
    const field = fbm(x, y, config.seed ^ 0xacce27, ACCENT_FIELD_SCALE, ACCENT_OCTAVES);
    if (field >= accentCoverage) return [base];
    return [base, placed(config.accentFloorTileId, tilesById)];
  };

  const edits: StackEdit[] = [];
  for (let y = bounds.minY; y <= bounds.maxY; y++) {
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      if (!isOpen(grid, x, y)) {
        const low =
          ledge?.ok &&
          isCaveEdge(grid, bounds, x, y) &&
          randomAt(x, y, config.seed ^ 0x1ed6e) * 100 < config.ledgeChance;
        const column = low ? ledge.stack : wall.stack;
        edits.push({
          x,
          y,
          z,
          stack: [{ ...floorUnder }, ...column.map((p) => ({ ...p }))],
        });
        continue;
      }

      const stack: PlacedTile[] = floorFor(x, y);
      if (config.waterTileId && water.has(gridIndex(grid, x, y))) {
        stack.push(placed(config.waterTileId, tilesById));
      } else {
        const prop = scatter.get(`${x},${y}`);
        if (prop) stack.push(placed(prop, tilesById));
      }
      edits.push({ x, y, z, stack });
    }
  }

  const built = setStacks(map, edits);
  for (const edit of edits) {
    const check = canReplaceStack(built, edit.x, edit.y, edit.z, edit.stack, tilesById);
    if (!check.ok) {
      return { ok: false, reason: `${check.reason} at ${edit.x},${edit.y}` };
    }
  }

  return { ok: true, edits };
}
