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
  clamp01,
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
  stepTowards,
  widenToTwo,
} from "./generator";

export type CaveShape = "caverns" | "veins" | "tunnels";

export const CAVE_SHAPES: Array<{ id: CaveShape; label: string; hint: string }> = [
  { id: "caverns", label: "Caverns", hint: "Rounded halls with pillars — eroded" },
  { id: "veins", label: "Veins", hint: "Long sinuous passages — water-cut" },
  { id: "tunnels", label: "Tunnels", hint: "Even corridors from the middle — dug" },
];

export type CaveConfig = {
  generator: "cave";
  seed: number;
  shape: CaveShape;
  density: number;
  wallTileId: string;
  ledgeTileId: string | null;
  ledgeChance: number;
  floorTileId: string;
  accentFloorTileId: string | null;
  accentCoverage: number;
  waterTileId: string | null;
  waterCoverage: number;
  scatter: ScatterRule[];
};

export const CAVE_DENSITY_RANGE = { min: 0, max: 100 } as const;

export const MIN_CAVE_FOOTPRINT = 6;

const BORDER = 1;

const CAVERN_ROCK_CHANCE = { open: 0.44, dense: 0.7 } as const;

const CAVERN_DENSITY_SWING = 0.08;

const DENSITY_FIELD_SCALE = 18;

const SMOOTH_PASSES = 5;

const ROCK_CROWDING = 5;

const OPEN_SPRAWL = 4;
const SPRAWL_PASSES = 4;

const VEIN_SCALE = 26;
const VEIN_OCTAVES = 3;

const VEIN_BAND = { wide: 0.13, narrow: 0.05 } as const;

const TUNNEL_OPEN_SHARE = { loose: 0.45, tight: 0.16 } as const;

const TUNNEL_STRAY_CHANCE = 0.3;

const TUNNEL_BRANCH_CHANCE = 0.03;

const TUNNEL_MAX_DIGGERS = 10;
const CELLS_PER_DIGGER = 350;

const TUNNEL_MAX_STEPS = 6000;

const MIN_REGION_CELLS = 10;

const JOIN_ATTEMPTS = 4;

const CONNECTION_DEPTH = 6;

const STEPS = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
] as const;

const ACCENT_FIELD_SCALE = 7;
const ACCENT_OCTAVES = 2;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

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

function rockAround(g: CellGrid, x: number, y: number, radius: number): number {
  let rock = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
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
  const target = Math.round(area * lerp(TUNNEL_OPEN_SHARE.loose, TUNNEL_OPEN_SHARE.tight, t));
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

  for (const connection of connections) {
    openConnection(grid, bounds, connection, CONNECTION_DEPTH);
  }

  /**
   * Widening and joining each undo a little of the other: widening a
   * corridor to two cells can pinch it shut, and the corridor bored to
   * replace it can meet its region at an angle that widening then pinches in
   * turn. So they alternate rather than each running once.
   */
  for (let attempt = 0; attempt < JOIN_ATTEMPTS; attempt++) {
    widenToTwo(grid);
    if (regionsOf(grid).length <= 1) return grid;
    joinRegions(grid, box, config.seed + attempt, {
      minRegionCells: MIN_REGION_CELLS,
      tooSmall: "fill",
    });
  }

  widenToTwo(grid);
  const regions = regionsOf(grid);
  for (const region of regions.slice(1)) {
    for (const i of region) grid.cells[i] = 0;
  }
  return grid;
}

export function erodeWithWater(grid: CellGrid, bounds: Bounds, config: CaveConfig): Set<number> {
  const water = planWater(grid, inner(bounds), config.seed ^ 0x7a7e2, config.waterCoverage);
  for (const i of water) {
    setOpen(grid, gridX(grid, i), gridY(grid, i), true);
  }
  return water;
}

/**
 * The shell is never an edge: a low wall there would be a hole in the
 * block-out, and what is beyond it is usually nothing the map draws at all.
 */
function isCaveEdge(g: CellGrid, bounds: Bounds, x: number, y: number): boolean {
  if (x === bounds.minX || x === bounds.maxX) return false;
  if (y === bounds.minY || y === bounds.maxY) return false;
  return STEPS.some(({ dx, dy }) => isOpen(g, x + dx, y + dy));
}

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

  const water = config.waterTileId ? erodeWithWater(grid, bounds, config) : new Set<number>();
  cutFords(grid, water);

  const dry = openCells(grid).filter((c) => !water.has(gridIndex(grid, c.x, c.y)));
  const accentDef = config.accentFloorTileId ? tilesById[config.accentFloorTileId] : undefined;
  const floorHeight = physicalHeight(floorDef) + (accentDef ? physicalHeight(accentDef) : 0);
  const scatter = planScatter(dry, config.scatter, config.seed ^ 0x5ca77e2, floorHeight, tilesById);

  const accentCoverage = clamp01(config.accentCoverage / 100);
  const floorFor = (x: number, y: number): PlacedTile[] => {
    const base = placed(config.floorTileId, tilesById);
    if (!config.accentFloorTileId || accentCoverage <= 0) return [base];
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
