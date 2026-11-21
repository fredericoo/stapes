import { pileMax, resolveContainer } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { getStack, setStacks, type StackEdit } from "../lib/mapData";
import type { Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL, MAX_LEVEL, MIN_LEVEL, physicalHeight } from "../lib/types";
import { canReplaceStack } from "../lib/validation";
import {
  MAX_FOOTPRINT,
  type Bounds,
  type GeneratedPlan,
  type Rect,
  boundsOf,
  mulberry32,
  placed,
} from "./generator";
import {
  MIN_FOOTPRINT,
  WINDOW_MIN_FROM_DOOR,
  measureSite,
  resolveRoofOrientation,
  roofEdits,
  roofLevelsFor,
  windowDirectionFor,
  windowsAlong,
  type RoofColour,
  type RoofOrientationSetting,
  type RoofPitch,
} from "./house";

export const FLOOR_USES = ["empty", "house", "inn", "pub", "shop", "library", "storage"] as const;

export type FloorUse = (typeof FLOOR_USES)[number];

export const ACCESS = ["stairs", "ladder"] as const;

export type Access = (typeof ACCESS)[number];

export const ROOM_RANGE = { min: 1, max: 8 } as const;

/**
 * One storey. `access` is how it is joined to the storey nearer the ground,
 * so the ground floor's is never read. `doors` are cells; each becomes a door
 * in the nearest stretch of outer wall that is not a corner.
 */
export type FloorSpec = {
  name: string;
  use: FloorUse;
  seed: number;
  rooms: number;
  /** Whether the doorway in each wall between rooms holds a door. */
  roomDoors: boolean;
  /** Whether the containers among the furniture are stocked with items. */
  stocked: boolean;
  access: Access;
  doors: ReadonlyArray<{ x: number; y: number }>;
  wallTileId: string;
  floorTileId: string;
  windowTileId: string | null;
  windowSpacing: number;
  doorTileId: string;
};

export type RoofSpec = {
  orientation: RoofOrientationSetting;
  colour: RoofColour;
  pitch: RoofPitch;
};

/** `floors` count up from the ground and `cellars` down from it, each in order. */
export type BuildingSpec = {
  floors: readonly FloorSpec[];
  cellars: readonly FloorSpec[];
  roof: RoofSpec | null;
};

const STAIRS_TILE_ID = "stone-stairs";
const LADDER_UP_TILE_ID = "ladder-up";
const LADDER_TOP_TILE_ID = "ladder-top";

const FLOOR = 0;
const WALL = 1;
const DOOR = 2;
const WINDOW = 3;
const STAIR = 4;
const HOLE = 5;
const LADDER_UP = 6;
const LADDER_TOP = 7;
const FURNITURE = 8;
const RAIL = 9;
const ROOM_DOOR = 10;

const RAIL_TILE_ID = "fence";

const DELTA: Record<Direction, readonly [number, number]> = {
  n: [0, -1],
  e: [1, 0],
  s: [0, 1],
  w: [-1, 0],
};
const OPPOSITE: Record<Direction, Direction> = { n: "s", e: "w", s: "n", w: "e" };
const SIDES: readonly Direction[] = ["s", "e", "w", "n"];

type Room = { minX: number; maxX: number; minY: number; maxY: number };

type Storey = {
  spec: FloorSpec;
  level: number;
  underground: boolean;
  kinds: Uint8Array;
  /** Cells that have to stay bare floor: inside a door, either side of a doorway, at the foot and head of a stair. */
  keep: Uint8Array;
  facing: Map<number, Direction>;
  furniture: Map<number, PlacedTile[]>;
  rooms: Room[];
};

type Grid = { bounds: Bounds; width: number; depth: number };

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function passable(kind: number): boolean {
  return kind === FLOOR || kind === LADDER_UP || kind === LADDER_TOP || kind === ROOM_DOOR;
}

/** Whether every cell a body can stand on in this storey can be walked to from every other. */
function connected(grid: Grid, storey: Storey): boolean {
  const { kinds } = storey;
  let start = -1;
  let total = 0;
  for (let i = 0; i < kinds.length; i++) {
    if (!passable(kinds[i]!)) continue;
    total++;
    if (start < 0) start = i;
  }
  if (total === 0) return true;
  const seen = new Uint8Array(kinds.length);
  const queue = [start];
  seen[start] = 1;
  let found = 1;
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head]!;
    const x = at % grid.width;
    const y = (at - x) / grid.width;
    for (const [dx, dy] of Object.values(DELTA)) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.depth) continue;
      const next = ny * grid.width + nx;
      if (seen[next] || !passable(kinds[next]!)) continue;
      seen[next] = 1;
      found++;
      queue.push(next);
    }
  }
  return found === total;
}

function newStorey(grid: Grid, spec: FloorSpec, level: number, underground: boolean): Storey {
  const kinds = new Uint8Array(grid.width * grid.depth);
  for (let y = 0; y < grid.depth; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (x === 0 || y === 0 || x === grid.width - 1 || y === grid.depth - 1) {
        kinds[y * grid.width + x] = WALL;
      }
    }
  }
  return {
    spec,
    level,
    underground,
    kinds,
    keep: new Uint8Array(kinds.length),
    facing: new Map(),
    furniture: new Map(),
    rooms: [{ minX: 1, maxX: grid.width - 2, minY: 1, maxY: grid.depth - 2 }],
  };
}

/** The cell of outer wall nearest a point, corners left out, and the side of the house it is on. */
function doorSpot(grid: Grid, x: number, y: number): { x: number; y: number; wall: Direction } {
  const clamp = (v: number, hi: number) => Math.min(hi - 1, Math.max(1, v));
  const spots = SIDES.map((wall) => {
    const along = wall === "n" || wall === "s";
    const sx = along ? clamp(x, grid.width - 1) : wall === "w" ? 0 : grid.width - 1;
    const sy = along ? (wall === "n" ? 0 : grid.depth - 1) : clamp(y, grid.depth - 1);
    return { x: sx, y: sy, wall, far: Math.abs(sx - x) + Math.abs(sy - y) };
  });
  return spots.reduce((best, spot) => (spot.far < best.far ? spot : best));
}

function placeDoors(grid: Grid, storey: Storey) {
  for (const point of storey.spec.doors) {
    const spot = doorSpot(grid, point.x - grid.bounds.minX, point.y - grid.bounds.minY);
    const at = spot.y * grid.width + spot.x;
    storey.kinds[at] = DOOR;
    storey.facing.set(at, spot.wall);
    const [dx, dy] = DELTA[OPPOSITE[spot.wall]];
    storey.keep[(spot.y + dy) * grid.width + spot.x + dx] = 1;
  }
}

function wallNeighbours(grid: Grid, storey: Storey, at: number): number {
  const x = at % grid.width;
  const y = (at - x) / grid.width;
  let count = 0;
  for (const [dx, dy] of Object.values(DELTA)) {
    const kind = storey.kinds[(y + dy) * grid.width + x + dx];
    if (kind === WALL || kind === WINDOW) count++;
  }
  return count;
}

function bare(storey: Storey, at: number): boolean {
  return storey.kinds[at] === FLOOR && !storey.keep[at];
}

/**
 * A flight is three cells: the step before it and the stair itself on the
 * lower storey, and on the upper one a hole over the stair with the landing
 * beyond it, which is what `docs/notes.md` asks of any ramp between levels.
 * Flights against a wall are tried first.
 */
function placeStairs(grid: Grid, lower: Storey, upper: Storey, random: () => number): boolean {
  const options: Array<{
    at: number;
    foot: number;
    head: number;
    climb: Direction;
    walls: number;
  }> = [];
  for (let y = 1; y < grid.depth - 1; y++) {
    for (let x = 1; x < grid.width - 1; x++) {
      const at = y * grid.width + x;
      if (!bare(lower, at) || !bare(upper, at)) continue;
      for (const climb of SIDES) {
        const [dx, dy] = DELTA[climb];
        const foot = (y - dy) * grid.width + x - dx;
        const head = (y + dy) * grid.width + x + dx;
        if (lower.kinds[foot] !== FLOOR || upper.kinds[head] !== FLOOR) continue;
        options.push({
          at,
          foot,
          head,
          climb,
          walls: wallNeighbours(grid, lower, at) + wallNeighbours(grid, upper, at),
        });
      }
    }
  }
  const ordered = shuffled(options, random).sort((a, b) => b.walls - a.walls);
  for (const option of ordered) {
    lower.kinds[option.at] = STAIR;
    upper.kinds[option.at] = HOLE;
    if (connected(grid, lower) && connected(grid, upper)) {
      lower.facing.set(option.at, OPPOSITE[option.climb]);
      lower.keep[option.foot] = 1;
      upper.keep[option.head] = 1;
      railHole(grid, upper, option.at, option.climb);
      return true;
    }
    lower.kinds[option.at] = FLOOR;
    upper.kinds[option.at] = FLOOR;
  }
  return false;
}

/**
 * Rails the hole over a flight on every side but its landing, so the only
 * way into it is the way down the stairs. The three cells beside the hole
 * come first, since a body moves in four directions; the two corners then
 * join them into one run where there is room. A rail that would cut floor
 * off, or stand in a cell that has to stay bare, is left out.
 */
function railHole(grid: Grid, upper: Storey, hole: number, climb: Direction) {
  const [cx, cy] = DELTA[climb];
  const x = hole % grid.width;
  const y = (hole - x) / grid.width;
  const cell = (along: number, across: number) =>
    (y + cy * along + cx * across) * grid.width + x + cx * along - cy * across;
  for (const at of [cell(-1, 0), cell(0, 1), cell(0, -1), cell(-1, 1), cell(-1, -1)]) {
    if (!bare(upper, at)) continue;
    upper.kinds[at] = RAIL;
    if (!connected(grid, upper)) upper.kinds[at] = FLOOR;
  }
}

/** A ladder is one cell on both storeys and can stand inside a door, since a body walks through it. */
function placeLadder(grid: Grid, lower: Storey, upper: Storey, random: () => number): boolean {
  const options: Array<{ at: number; rank: number }> = [];
  for (let at = 0; at < lower.kinds.length; at++) {
    if (lower.kinds[at] !== FLOOR || upper.kinds[at] !== FLOOR) continue;
    const kept = lower.keep[at]! + upper.keep[at]!;
    options.push({
      at,
      rank: wallNeighbours(grid, lower, at) + wallNeighbours(grid, upper, at) - kept * 8,
    });
  }
  const best = shuffled(options, random).sort((a, b) => b.rank - a.rank)[0];
  if (!best) return false;
  lower.kinds[best.at] = LADDER_UP;
  upper.kinds[best.at] = LADDER_TOP;
  lower.keep[best.at] = 1;
  upper.keep[best.at] = 1;
  return true;
}

const MIN_ROOM_SIDE = 2;

/**
 * Splits the largest room that can be split with a wall and a doorway until
 * the storey has the rooms it asks for or none can be split. A wall never
 * crosses a kept cell and a split that would cut any floor off is undone, so
 * fewer rooms than asked is the outcome on a small or crowded storey.
 */
function partition(grid: Grid, storey: Storey, random: () => number) {
  const area = (r: Room) => (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1);
  const index = (x: number, y: number) => y * grid.width + x;

  const split = (room: Room): [Room, Room] | null => {
    const wide = room.maxX - room.minX + 1;
    const deep = room.maxY - room.minY + 1;
    const axes = wide >= deep ? (["x", "y"] as const) : (["y", "x"] as const);
    for (const axis of axes) {
      const lo = (axis === "x" ? room.minX : room.minY) + MIN_ROOM_SIDE;
      const hi = (axis === "x" ? room.maxX : room.maxY) - MIN_ROOM_SIDE;
      const lines: number[] = [];
      for (let line = lo; line <= hi; line++) lines.push(line);
      for (const line of shuffled(lines, random)) {
        const cells: number[] = [];
        if (axis === "x") for (let y = room.minY; y <= room.maxY; y++) cells.push(index(line, y));
        else for (let x = room.minX; x <= room.maxX; x++) cells.push(index(x, line));
        if (!cells.every((at) => bare(storey, at))) continue;
        const step = axis === "x" ? 1 : grid.width;
        for (const doorway of shuffled(cells, random)) {
          if (storey.kinds[doorway - step] !== FLOOR || storey.kinds[doorway + step] !== FLOOR) {
            continue;
          }
          for (const at of cells) if (at !== doorway) storey.kinds[at] = WALL;
          if (connected(grid, storey)) {
            if (storey.spec.roomDoors) {
              storey.kinds[doorway] = ROOM_DOOR;
              storey.facing.set(doorway, axis === "x" ? "e" : "s");
            }
            storey.keep[doorway] = 1;
            storey.keep[doorway - step] = 1;
            storey.keep[doorway + step] = 1;
            return axis === "x"
              ? [
                  { ...room, maxX: line - 1 },
                  { ...room, minX: line + 1 },
                ]
              : [
                  { ...room, maxY: line - 1 },
                  { ...room, minY: line + 1 },
                ];
          }
          for (const at of cells) storey.kinds[at] = FLOOR;
        }
      }
    }
    return null;
  };

  while (storey.rooms.length < storey.spec.rooms) {
    const bySize = [...storey.rooms].sort((a, b) => area(b) - area(a));
    let done = false;
    for (const room of bySize) {
      const halves = split(room);
      if (!halves) continue;
      storey.rooms = storey.rooms.flatMap((r) => (r === room ? halves : [r]));
      done = true;
      break;
    }
    if (!done) return;
  }
}

function placeWindows(grid: Grid, storey: Storey) {
  if (!storey.spec.windowTileId || storey.underground) return;
  const { bounds } = grid;
  const doorsOn = (wall: Direction) =>
    [...storey.facing.entries()]
      .filter(([at, facing]) => storey.kinds[at] === DOOR && facing === wall)
      .map(([at]) =>
        wall === "n" || wall === "s" ? at % grid.width : Math.floor(at / grid.width),
      );
  for (const wall of SIDES) {
    const along = wall === "n" || wall === "s";
    const doors = doorsOn(wall);
    const spots = along
      ? windowsAlong(bounds.minX, bounds.maxX, null, storey.spec.windowSpacing).map(
          (x) => x - bounds.minX,
        )
      : windowsAlong(bounds.minY, bounds.maxY, null, storey.spec.windowSpacing).map(
          (y) => y - bounds.minY,
        );
    const [dx, dy] = DELTA[OPPOSITE[wall]];
    for (const spot of spots) {
      if (doors.some((door) => Math.abs(door - spot) < WINDOW_MIN_FROM_DOOR)) continue;
      const x = along ? spot : wall === "w" ? 0 : grid.width - 1;
      const y = along ? (wall === "n" ? 0 : grid.depth - 1) : spot;
      const at = y * grid.width + x;
      if (storey.kinds[at] !== WALL) continue;
      if (storey.kinds[(y + dy) * grid.width + x + dx] === WALL) continue;
      storey.kinds[at] = WINDOW;
      storey.facing.set(at, windowDirectionFor(wall));
    }
  }
}

type Furnisher = {
  random: () => number;
  /** Puts a stack on a bare cell unless that cuts some floor off from the rest. */
  put(x: number, y: number, stack: PlacedTile[]): boolean;
  /** Puts stacks on several cells or on none of them. */
  putAll(cells: ReadonlyArray<{ x: number; y: number; stack: PlacedTile[] }>): boolean;
  /** Bare cells of a room beside a wall, in a random order. */
  wallCells(room: Room): Array<{ x: number; y: number; wall: Direction; walls: Direction[] }>;
  /** Bare cells of a room with no wall beside them, in a random order. */
  openCells(room: Room): Array<{ x: number; y: number }>;
  tile(id: string, direction?: Direction): PlacedTile;
  /** Whether a cell and the eight round it hold no furniture. */
  clear(x: number, y: number): boolean;
  tables: Array<{ x: number; y: number }>;
  level: number;
};

function alongWalls(f: Furnisher, room: Room, share: number, ids: readonly string[]) {
  const cells = f.wallCells(room);
  const count = Math.round(cells.length * share);
  let put = 0;
  for (const cell of cells) {
    if (put >= count) break;
    const id = ids[Math.floor(f.random() * ids.length)]!;
    if (f.put(cell.x, cell.y, [f.tile(id, OPPOSITE[cell.wall])])) put++;
  }
}

const TABLE_GAP = { x: 5, y: 3 };

/**
 * A table in open floor with a seat on either side, each facing it. Sets
 * keep `TABLE_GAP` between their tables, which leaves a cell to walk
 * between two sets side by side and two rows between sets in a column.
 */
function tableSet(f: Furnisher, room: Room, seat: string, lit: boolean): boolean {
  for (const cell of [...f.openCells(room), ...f.wallCells(room)]) {
    const crowded = f.tables.some(
      (t) => Math.abs(t.x - cell.x) < TABLE_GAP.x && Math.abs(t.y - cell.y) < TABLE_GAP.y,
    );
    if (crowded || !f.clear(cell.x, cell.y)) continue;
    const top = lit ? [f.tile("table"), f.tile("candle")] : [f.tile("table")];
    if (!f.put(cell.x, cell.y, top)) continue;
    f.put(cell.x - 1, cell.y, [f.tile(seat, "e")]);
    f.put(cell.x + 1, cell.y, [f.tile(seat, "w")]);
    f.tables.push(cell);
    return true;
  }
  return false;
}

/** What one cell of a heap of stores holds, bottom first; a box carries a second thing and nothing else does. */
const STORES: ReadonlyArray<readonly string[]> = [
  ["barrel"],
  ["barrel"],
  ["wooden-box"],
  ["wooden-box", "wooden-box"],
  ["wooden-box", "sack"],
  ["sack"],
  ["sack"],
  ["crate-chest"],
];

const HEAP_CELLS = 5;

/**
 * Stores in heaps rather than rows: each heap starts in a corner, or against
 * a wall where the corners are taken, and spreads to cells beside it until
 * it has its share. `share` is of the room's floor.
 */
function heaps(f: Furnisher, room: Room, share: number) {
  const area = (room.maxX - room.minX + 1) * (room.maxY - room.minY + 1);
  let left = Math.max(1, Math.round(area * share));
  const inRoom = (x: number, y: number) =>
    x >= room.minX && x <= room.maxX && y >= room.minY && y <= room.maxY;
  const starts = f.wallCells(room).sort((a, b) => b.walls.length - a.walls.length);
  for (const start of starts) {
    if (left <= 0) return;
    let size = Math.min(left, 1 + Math.floor(f.random() * HEAP_CELLS));
    const frontier = [{ x: start.x, y: start.y }];
    while (size > 0 && frontier.length > 0) {
      const [cell] = frontier.splice(Math.floor(f.random() * frontier.length), 1);
      const stack = STORES[Math.floor(f.random() * STORES.length)]!;
      if (
        !f.put(
          cell!.x,
          cell!.y,
          stack.map((id) => f.tile(id)),
        )
      )
        continue;
      size--;
      left--;
      for (const [dx, dy] of Object.values(DELTA)) {
        if (inRoom(cell!.x + dx, cell!.y + dy)) frontier.push({ x: cell!.x + dx, y: cell!.y + dy });
      }
    }
  }
}

/**
 * A bed is two cells, its anchor to the south. Both cells carry a `span`
 * with the same id, which has to differ from every other bed's, so it is
 * made from the anchor's cell and level.
 */
function bed(f: Furnisher, room: Room): boolean {
  for (const cell of f.wallCells(room)) {
    if (!cell.walls.includes("n")) continue;
    const id = `bed${cell.x}_${cell.y}_${f.level}`;
    const part = (dy: number) => ({ ...f.tile("bed", "s"), span: { id, dx: 0, dy } });
    const done = f.putAll([
      { x: cell.x, y: cell.y, stack: [part(1)] },
      { x: cell.x, y: cell.y + 1, stack: [part(0)] },
    ]);
    if (done) return true;
  }
  return false;
}

const COUNTER_ROOM = { width: 3, depth: 5 };

/**
 * A counter across the room with a way round its east end, the goods against
 * the north wall behind it and a row between the two for whoever serves.
 */
function counter(f: Furnisher, room: Room, goods: readonly string[]): boolean {
  if (room.maxY - room.minY + 1 < COUNTER_ROOM.depth) return false;
  if (room.maxX - room.minX + 1 < COUNTER_ROOM.width) return false;
  const y = room.minY + 2;
  const cells = [];
  for (let x = room.minX; x < room.maxX; x++) cells.push({ x, y, stack: [f.tile("counter-top")] });
  if (!f.putAll(cells)) return false;
  alongWalls(f, { ...room, maxY: room.minY }, 0.7, goods);
  return true;
}

const SHELVES = ["bookshelf", "bookshelf-sparse", "bookshelf-tomes"];

function largest(rooms: readonly Room[]): Room {
  const area = (r: Room) => (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1);
  return rooms.reduce((best, room) => (area(room) > area(best) ? room : best));
}

function tablesFor(room: Room): number {
  return Math.max(1, Math.floor(((room.maxX - room.minX + 1) * (room.maxY - room.minY + 1)) / 20));
}

const FURNISH: Record<FloorUse, (f: Furnisher, rooms: readonly Room[]) => void> = {
  empty: () => {},
  house(f, rooms) {
    const living = largest(rooms);
    tableSet(f, living, "chair", true);
    if (rooms.length === 1) bed(f, living);
    alongWalls(f, living, 0.1, ["bookshelf", "bookshelf-sparse"]);
    heaps(f, living, 0.04);
    for (const room of rooms) {
      if (room === living) continue;
      bed(f, room);
      heaps(f, room, 0.05);
    }
  },
  inn(f, rooms) {
    for (const room of rooms) {
      const beds = Math.max(1, Math.floor((room.maxX - room.minX + 1) / 2));
      for (let i = 0; i < beds; i++) bed(f, room);
      alongWalls(f, room, 0.08, ["crate-chest", "candle"]);
    }
  },
  pub(f, rooms) {
    const bar = largest(rooms);
    const served = counter(f, bar, ["barrel"]);
    const seating = served ? { ...bar, minY: bar.minY + 3 } : bar;
    for (let i = 0; i < tablesFor(seating); i++) tableSet(f, seating, "stool", i === 0);
    for (const room of rooms) if (room !== bar) heaps(f, room, 0.3);
  },
  shop(f, rooms) {
    const front = largest(rooms);
    const served = counter(f, front, SHELVES);
    const shopFloor = served ? { ...front, minY: front.minY + 3 } : front;
    alongWalls(f, shopFloor, 0.25, SHELVES);
    heaps(f, shopFloor, 0.06);
    for (const room of rooms) if (room !== front) heaps(f, room, 0.3);
  },
  library(f, rooms) {
    for (const room of rooms) {
      alongWalls(f, room, 0.7, SHELVES);
      tableSet(f, room, "chair", true);
    }
  },
  storage(f, rooms) {
    for (const room of rooms) heaps(f, room, 0.3);
  },
};

/** What the containers of a storey are stocked from, by its use: an item and the most of it one slot holds. */
const STOCK: Record<FloorUse, ReadonlyArray<readonly [string, number]>> = {
  empty: [],
  house: [
    ["bread", 2],
    ["cheese", 2],
    ["apple", 4],
    ["berry", 6],
    ["empty-bottle", 2],
    ["cloth-tunic", 1],
    ["worn-boots", 1],
    ["gold", 12],
  ],
  inn: [
    ["bread", 3],
    ["ale", 2],
    ["cheese", 2],
    ["cloth-tunic", 1],
    ["hand-lantern", 1],
    ["gold", 8],
  ],
  pub: [
    ["ale", 4],
    ["ale", 4],
    ["bread", 3],
    ["cheese", 3],
    ["cooked-meat", 2],
    ["empty-bottle", 6],
  ],
  shop: [
    ["empty-bottle", 6],
    ["hand-lantern", 1],
    ["cloth-tunic", 1],
    ["leather-cap", 1],
    ["worn-boots", 1],
    ["apple", 6],
    ["bread", 3],
    ["gold", 20],
  ],
  library: [
    ["rune-blank-bone", 3],
    ["empty-bottle", 2],
    ["hand-lantern", 1],
    ["gold", 6],
  ],
  storage: [
    ["apple", 8],
    ["berry", 12],
    ["bread", 3],
    ["cheese", 4],
    ["ale", 4],
    ["empty-bottle", 8],
  ],
};

const STOCK_SHARE = { min: 0.25, spread: 0.35 };

/**
 * Stocks a storey's containers from its use's list: a share of all their
 * slots is filled, each item going to a container picked at random among
 * those with a slot free, so the same seed stocks the same shelves. An item
 * carries no id; the world gives it one when it loads the map, as it does
 * for every item placed without one.
 */
function stock(storey: Storey, tilesById: Record<string, TileDef>, random: () => number) {
  const list = STOCK[storey.spec.use].filter(([id]) => tilesById[id]);
  if (!storey.spec.stocked || list.length === 0) return;
  const holders: Array<{ at: number; index: number; free: number; contents: ItemInstance[] }> = [];
  for (const at of [...storey.furniture.keys()].sort((a, b) => a - b)) {
    storey.furniture.get(at)!.forEach((placement, index) => {
      const def = tilesById[placement.tileId];
      const container = def ? resolveContainer(def) : null;
      if (container) holders.push({ at, index, free: container.size, contents: [] });
    });
  }
  const slots = holders.reduce((sum, holder) => sum + holder.free, 0);
  const share = STOCK_SHARE.min + random() * STOCK_SHARE.spread;
  for (let n = Math.round(slots * share); n > 0; n--) {
    const open = holders.filter((holder) => holder.free > 0);
    if (open.length === 0) break;
    const holder = open[Math.floor(random() * open.length)]!;
    const [tileId, most] = list[Math.floor(random() * list.length)]!;
    const count = 1 + Math.floor(random() * Math.min(most, pileMax(tilesById[tileId]!)));
    holder.contents.push(count > 1 ? { id: "", tileId, count } : { id: "", tileId });
    holder.free--;
  }
  for (const holder of holders) {
    if (holder.contents.length === 0) continue;
    const stack = storey.furniture.get(holder.at)!;
    storey.furniture.set(
      holder.at,
      stack.map((p, i) => (i === holder.index ? { ...p, contents: holder.contents } : p)),
    );
  }
}

function furnish(
  grid: Grid,
  storey: Storey,
  tilesById: Record<string, TileDef>,
  random: () => number,
) {
  if (storey.spec.use === "empty") return;
  const index = (x: number, y: number) => y * grid.width + x;
  const within = (room: Room, test: (x: number, y: number) => boolean) => {
    const out: Array<{ x: number; y: number }> = [];
    for (let y = room.minY; y <= room.maxY; y++) {
      for (let x = room.minX; x <= room.maxX; x++) {
        if (bare(storey, index(x, y)) && test(x, y)) out.push({ x, y });
      }
    }
    return shuffled(out, random);
  };
  const wallsOf = (x: number, y: number): Direction[] =>
    SIDES.filter((side) => {
      const kind = storey.kinds[index(x + DELTA[side][0], y + DELTA[side][1])];
      return kind === WALL || kind === WINDOW;
    });
  const putAll: Furnisher["putAll"] = (cells) => {
    if (!cells.every((c) => bare(storey, index(c.x, c.y)))) return false;
    for (const c of cells) storey.kinds[index(c.x, c.y)] = FURNITURE;
    if (!connected(grid, storey)) {
      for (const c of cells) storey.kinds[index(c.x, c.y)] = FLOOR;
      return false;
    }
    for (const c of cells) storey.furniture.set(index(c.x, c.y), c.stack);
    return true;
  };
  const furnisher: Furnisher = {
    random,
    level: storey.level,
    putAll,
    put: (x, y, stack) => putAll([{ x, y, stack }]),
    wallCells: (room) =>
      within(room, (x, y) => wallsOf(x, y).length > 0).map((c) => {
        const walls = wallsOf(c.x, c.y);
        return { ...c, wall: walls[0]!, walls };
      }),
    openCells: (room) => within(room, (x, y) => wallsOf(x, y).length === 0),
    tile: (id, direction) => placed(id, tilesById, direction),
    tables: [],
    clear: (x, y) => {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (storey.kinds[index(x + dx, y + dy)] === FURNITURE) return false;
        }
      }
      return true;
    },
  };
  FURNISH[storey.spec.use](furnisher, storey.rooms);
  if (storey.underground || storey.spec.use === "storage") {
    for (const cell of furnisher.wallCells(largest(storey.rooms))) {
      if (furnisher.put(cell.x, cell.y, [furnisher.tile("lantern")])) break;
    }
  }
  stock(storey, tilesById, random);
}

function storeyEdits(
  grid: Grid,
  storey: Storey,
  tilesById: Record<string, TileDef>,
  under: (x: number, y: number) => readonly PlacedTile[],
): StackEdit[] {
  const { spec, level: z } = storey;
  const floor = placed(spec.floorTileId, tilesById);
  const innerId = `${spec.floorTileId}-inner`;
  /**
   * A floor autotile draws a cut edge towards a cell with no floor, which
   * leaves a rail beside a hole standing on air and shows the ground under
   * the boards. Its `-inner` tile is the part the edge cuts away, so every
   * cell round a hole gets one over its floor.
   */
  const besideHole = (gx: number, gy: number) => {
    if (!tilesById[innerId]) return false;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = gx + dx;
        const ny = gy + dy;
        if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.depth) continue;
        if (storey.kinds[ny * grid.width + nx] === HOLE) return true;
      }
    }
    return false;
  };
  const edits: StackEdit[] = [];
  for (let gy = 0; gy < grid.depth; gy++) {
    for (let gx = 0; gx < grid.width; gx++) {
      const at = gy * grid.width + gx;
      const x = grid.bounds.minX + gx;
      const y = grid.bounds.minY + gy;
      const kind = storey.kinds[at]!;
      if (kind === HOLE) {
        edits.push({ x, y, z, stack: [] });
        continue;
      }
      const facing = storey.facing.get(at);
      const on: PlacedTile[] =
        kind === WALL
          ? [placed(spec.wallTileId, tilesById)]
          : kind === DOOR || kind === ROOM_DOOR
            ? [placed(spec.doorTileId, tilesById, facing)]
            : kind === WINDOW
              ? [placed(spec.windowTileId!, tilesById, facing)]
              : kind === STAIR
                ? [placed(STAIRS_TILE_ID, tilesById, facing)]
                : kind === LADDER_UP
                  ? [placed(LADDER_UP_TILE_ID, tilesById)]
                  : kind === LADDER_TOP
                    ? [placed(LADDER_TOP_TILE_ID, tilesById)]
                    : kind === RAIL
                      ? [{ tileId: RAIL_TILE_ID }]
                      : (storey.furniture.get(at) ?? []);
      const boards = besideHole(gx, gy) ? [{ ...floor }, { tileId: innerId }] : [{ ...floor }];
      edits.push({ x, y, z, stack: [...under(x, y).map((p) => ({ ...p })), ...boards, ...on] });
    }
  }
  return edits;
}

/**
 * Plans a building of any number of floors and cellars on one footprint.
 * Every storey is joined to the one under it, by the stairs or ladder it asks
 * for, or by a ladder where a flight of stairs does not fit; a building where
 * not even a ladder fits is refused. Ways up are placed before rooms and
 * furniture, which then keep clear of them.
 */
export function planBuilding(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  rect: Rect,
  z: number,
  spec: BuildingSpec,
): GeneratedPlan {
  const bounds = boundsOf(rect);
  const width = bounds.maxX - bounds.minX + 1;
  const depth = bounds.maxY - bounds.minY + 1;
  if (width < MIN_FOOTPRINT || depth < MIN_FOOTPRINT) {
    return { ok: false, reason: `A house is at least ${MIN_FOOTPRINT}×${MIN_FOOTPRINT} cells` };
  }
  if (width > MAX_FOOTPRINT || depth > MAX_FOOTPRINT) {
    return { ok: false, reason: `A house is at most ${MAX_FOOTPRINT}×${MAX_FOOTPRINT} cells` };
  }
  const ground = spec.floors[0];
  if (!ground) return { ok: false, reason: "A house needs at least one floor" };

  const roofBase = z + spec.floors.length;
  const orientation = spec.roof
    ? resolveRoofOrientation(spec.roof.orientation, width, depth)
    : "vertical";
  const roofSpan = orientation === "vertical" ? width : depth;
  const topLevel = spec.roof
    ? roofBase + roofLevelsFor(roofSpan, spec.roof.pitch) - 1
    : roofBase - 1;
  if (topLevel > MAX_LEVEL) return { ok: false, reason: `The building would pass z${MAX_LEVEL}` };
  if (z - spec.cellars.length < MIN_LEVEL) {
    return { ok: false, reason: `The cellars would pass z${MIN_LEVEL}` };
  }

  const site = measureSite(map, bounds, z, tilesById);
  if (!site.ok) return site;
  const heightOf = (id: string) => {
    const def = tilesById[id];
    return def ? physicalHeight(def) : 0;
  };
  const storeyHeight = site.height + heightOf(ground.floorTileId) + heightOf(ground.wallTileId);
  if (storeyHeight > HEIGHT_PER_LEVEL) {
    return {
      ok: false,
      reason: `The site stands ${site.height} units and a storey on it would be ${storeyHeight}, past the ${HEIGHT_PER_LEVEL} a level holds`,
    };
  }

  const grid: Grid = { bounds, width, depth };
  const storeys = [
    ...spec.cellars.map((cellar, i) => newStorey(grid, cellar, z - 1 - i, true)).reverse(),
    ...spec.floors.map((floor, i) => newStorey(grid, floor, z + i, false)),
  ];
  for (const storey of storeys) if (!storey.underground) placeDoors(grid, storey);

  for (let i = 0; i + 1 < storeys.length; i++) {
    const lower = storeys[i]!;
    const upper = storeys[i + 1]!;
    const owner = lower.underground ? lower : upper;
    const random = mulberry32(owner.spec.seed);
    const joined =
      (owner.spec.access === "stairs" && placeStairs(grid, lower, upper, random)) ||
      placeLadder(grid, lower, upper, random);
    if (!joined) {
      return {
        ok: false,
        reason: `There is no room for a way between ${lower.spec.name} and ${upper.spec.name}. Make the house larger.`,
      };
    }
  }

  const edits: StackEdit[] = [];
  for (const storey of storeys) {
    const random = mulberry32(storey.spec.seed ^ 0x9e3779b9);
    partition(grid, storey, random);
    placeWindows(grid, storey);
    furnish(grid, storey, tilesById, random);
    edits.push(
      ...storeyEdits(
        grid,
        storey,
        tilesById,
        storey.level === z ? (x, y) => getStack(map, x, y, z) : () => [],
      ),
    );
  }
  if (spec.roof) {
    edits.push(
      ...roofEdits(
        bounds,
        roofBase,
        { roofColour: spec.roof.colour, roofPitch: spec.roof.pitch },
        orientation,
        tilesById,
      ),
    );
  }

  for (const edit of edits) {
    if (edit.z > z && edit.stack.length > 0 && getStack(map, edit.x, edit.y, edit.z).length > 0) {
      return { ok: false, reason: `Something is already at ${edit.x},${edit.y} on z${edit.z}` };
    }
  }
  const built = setStacks(map, edits);
  for (const edit of edits) {
    const check = canReplaceStack(built, edit.x, edit.y, edit.z, edit.stack, tilesById);
    if (!check.ok) return { ok: false, reason: `${check.reason} at ${edit.x},${edit.y}` };
  }
  return { ok: true, edits };
}
