import type { Coord, Direction, FlatMapFile, PlacedTile } from "../../app/lib/types";
import { MAP_FILE_VERSION, coordKey } from "../../app/lib/types";
import {
  CREATURE_TILES,
  GROUND_STACK,
  NPC_TILES,
  ROCK,
  classify,
  waterStack,
  type Ground,
  type Part,
  type WallTile,
} from "./catalogue";
import type { ItemType } from "./itemTypes";
import type { OtbmTile } from "./otbm";
import type { Spawn } from "./spawns";

/** Rookgaard's temple, where a new character arrives. It becomes (0, 0) on level 0. */
export const TEMPLE = { x: 32097, y: 32219, z: 7 } as const;

/** Tibia counts floors down from 0 at the top to 15, with the ground at 7. */
const SURFACE = 7;

/** Rookgaard is an island: the translation takes the land joined to the temple and this much sea. */
const SEA_MARGIN = 20;

/** Caves and upper floors are taken where they lie within this many cells of the island's land. */
const FOOTPRINT_MARGIN = 4;

/**
 * Tibia fills everything underground that is not a cave with solid earth. Only
 * the earth touching a cave is kept, as rock: it walls the cave in, which is
 * all the rest of it did, without writing out an island's worth of stone.
 */
const ROCK_SHELL = 1;

/**
 * A gable rises a level for every cell it steps in, so a hall twelve cells
 * across would carry a roof six storeys tall and hide the street behind it.
 * Anything wider than this is roofed as parallel gables instead.
 */
const MAX_GABLE_SPAN = 8;

/**
 * Tibia's Rookgaard holds about 800 monsters, for a world built for hundreds of
 * players. A creature here thinks every round while a player is within its
 * brain's reach on the plan, on any level, and Rookgaard stacks six floors of
 * caves under its woods: one player there kept 200 of them awake, and six
 * spread over the island took a tick's p95 to 65ms against 33
 * (`bun run bench:server`). One monster of each kind in this many is put down,
 * which brought that to 30ms.
 */
const MONSTERS_PER_KEPT = 2;

const ROOF_COLOURS = [
  { eave: "roof-1", ridge: "roof-3" },
  { eave: "roof-2", ridge: "roof-5" },
  { eave: "roof-4", ridge: "roof-6" },
] as const;

const FLOORS = new Set(["grass-2", "dirt", "mud", "wooden-floor"]);
const OPEN_FLOOR = new Set(["grass-2", "grass", "dirt", "mud", "cobblestone", "wooden-floor"]);
const WALLISH = new Set([
  "sw2",
  "brick-wall",
  "window-1",
  "door-closed",
  "door-open",
  "half-stone",
]);
const OPENINGS = new Set(["window-1", "door-closed", "door-open"]);

const HOLE_VARIANT: Record<string, string> = {
  "grass-2": "grass",
  "wooden-floor": "wood",
  dirt: "dirt",
  mud: "dirt",
};

/** When a Tibia tile holds several objects, the one that says most about the place is kept. */
const THING_RANK: Record<string, number> = {
  tree: 6,
  "wooden-shelf": 5,
  lamppost: 5,
  barrel: 4,
  anvil: 4,
  table: 4,
  "counter-top": 4,
  "wooden-box": 4,
  "rock-pillar": 3,
  "half-stone": 3,
  fence: 3,
  "half-wall": 3,
  bush: 2,
  "small-bush": 1,
  chair: 1,
  stool: 1,
  flame: 1,
};

const OPPOSITE: Record<Direction, Direction> = { n: "s", e: "w", s: "n", w: "e" };
const STEP: Record<Direction, { x: number; y: number }> = {
  n: { x: 0, y: -1 },
  e: { x: 1, y: 0 },
  s: { x: 0, y: 1 },
  w: { x: -1, y: 0 },
};
const SIDES = [STEP.n, STEP.e, STEP.s, STEP.w];

export type TibiaSource = {
  tiles: readonly OtbmTile[];
  types: Map<number, ItemType>;
  spawns: readonly Spawn[];
};

/** The tiles whose number says whether a translation went right, counted on the finished map. */
const COUNTED = {
  stairs: ["stone-stairs", "ramp"],
  ladders: ["ladder-up"],
  holes: ["hole"],
  portals: ["portal"],
  signs: ["sign"],
  torches: ["torch"],
} as const;

export type Report = {
  cellsByLevel: Record<string, number>;
  unknownItems: Map<string, number>;
  counts: Record<keyof typeof COUNTED, number>;
  creatures: Map<string, number>;
  unplacedSpawns: string[];
  unmappedSpawns: Map<string, number>;
  thinnedSpawns: number;
};

type Runs = "horizontal" | "vertical" | null;

type Reading = {
  ground: Ground | null;
  descent: boolean;
  ropeSpot: boolean;
  coast: boolean;
  rock: boolean;
  wall: WallTile | null;
  wallRuns: Runs;
  door: { open: boolean } | null;
  window: boolean;
  stairs: { climb: Direction; tileId: "stone-stairs" | "ramp" } | null;
  ladder: boolean;
  grate: boolean;
  portal: Coord | null;
  raisedFloor: boolean;
  roof: "tiled" | "flat" | null;
  things: PlacedTile[][];
  sign: string | null;
  flowers: boolean;
  hangings: { tileId: "torch" | "sign"; text?: string }[];
};

type Cell = { x: number; y: number; z: number };

type Read = { cell: Cell; reading: Reading };

export function toCell(x: number, y: number, z: number): Cell {
  return { x: x - TEMPLE.x, y: y - TEMPLE.y, z: SURFACE - z };
}

class Board {
  readonly levels = new Map<number, Map<string, PlacedTile[]>>();

  get(x: number, y: number, z: number): PlacedTile[] | undefined {
    return this.levels.get(z)?.get(coordKey(x, y));
  }

  set(x: number, y: number, z: number, stack: PlacedTile[]): void {
    let level = this.levels.get(z);
    if (!level) this.levels.set(z, (level = new Map()));
    if (stack.length === 0) level.delete(coordKey(x, y));
    else level.set(coordKey(x, y), stack);
  }

  delete(x: number, y: number, z: number): void {
    this.levels.get(z)?.delete(coordKey(x, y));
  }

  *cells(): Generator<Cell & { stack: PlacedTile[] }> {
    for (const [z, cells] of this.levels) {
      for (const [key, stack] of cells) {
        const [x, y] = key.split(",").map(Number) as [number, number];
        yield { x, y, z, stack };
      }
    }
  }

  /**
   * The floor a ladder top or a hole is laid on. The Tibia tile there is the
   * hole itself and has no floor of its own, so it borrows the commonest one
   * around it.
   */
  floorAround(x: number, y: number, z: number): PlacedTile[] {
    const counts = new Map<string, number>();
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const stack = this.get(x + dx, y + dy, z);
        const bottom = stack?.[0]?.tileId;
        if (!bottom || !FLOORS.has(bottom) || stack!.some((p) => p.tileId === "water")) continue;
        counts.set(bottom, (counts.get(bottom) ?? 0) + 1);
      }
    }
    const best = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "wooden-floor";
    return [{ tileId: best }];
  }

  /** What a stair, ladder or portal is laid on: the floor already here, or the one around it. */
  floorAt(x: number, y: number, z: number): PlacedTile[] {
    const bottom = this.get(x, y, z)?.[0];
    return bottom ? [bottom] : this.floorAround(x, y, z);
  }

  toMapFile(): FlatMapFile {
    const levels: FlatMapFile["levels"] = {};
    for (const [z, cells] of [...this.levels].sort((a, b) => a[0] - b[0])) {
      if (cells.size === 0) continue;
      levels[String(z)] = Object.fromEntries(cells);
    }
    return { version: MAP_FILE_VERSION, levels };
  }
}

function isOpenFloor(stack: PlacedTile[] | undefined): stack is PlacedTile[] {
  return !!stack && stack.length > 0 && stack.every((p) => OPEN_FLOOR.has(p.tileId));
}

function isWallish(stack: PlacedTile[] | undefined): boolean {
  return stack?.some((p) => WALLISH.has(p.tileId)) ?? false;
}

function isRock(stack: PlacedTile[] | undefined): boolean {
  return stack?.length === ROCK.length && stack[0]!.tileId === ROCK[0]!.tileId;
}

function emptyReading(): Reading {
  return {
    ground: null,
    descent: false,
    ropeSpot: false,
    coast: false,
    rock: false,
    wall: null,
    wallRuns: null,
    door: null,
    window: false,
    stairs: null,
    ladder: false,
    grate: false,
    portal: null,
    raisedFloor: false,
    roof: null,
    things: [],
    sign: null,
    flowers: false,
    hangings: [],
  };
}

/** Everything on one Tibia tile, sorted by what it will become. */
function readTile(tile: OtbmTile, partOf: (id: number) => Part, report: Report): Reading {
  const reading = emptyReading();
  for (const item of tile.items) {
    const part = partOf(item.id);
    switch (part.kind) {
      case "ground":
        reading.ground ??= part.ground;
        break;
      case "descent":
        reading.descent = true;
        break;
      case "ropeSpot":
        reading.ropeSpot = true;
        reading.ground ??= "dirt";
        break;
      case "coast":
        reading.coast = true;
        break;
      case "rock":
        reading.rock = true;
        break;
      case "wall":
        reading.wall ??= part.tileId;
        reading.wallRuns ??= part.runs;
        break;
      case "door":
        reading.door ??= { open: part.open };
        reading.wallRuns ??= part.runs;
        break;
      case "window":
        reading.window = true;
        reading.wallRuns ??= part.runs;
        break;
      case "stairs":
        reading.stairs ??= { climb: part.climb, tileId: part.tileId };
        break;
      case "ladder":
        reading.ladder = true;
        break;
      case "grate":
        reading.grate = true;
        break;
      case "portal":
        if (item.teleport) {
          reading.portal ??= toCell(item.teleport.x, item.teleport.y, item.teleport.z);
        }
        break;
      case "raisedFloor":
        reading.raisedFloor = true;
        break;
      case "roof":
        reading.roof ??= part.tiled ? "tiled" : "flat";
        break;
      case "thing":
        reading.things.push(part.stack);
        break;
      case "sign":
        reading.sign ??= item.text ?? "";
        break;
      case "flowers":
        reading.flowers = true;
        break;
      case "hanging":
        reading.hangings.push({ tileId: part.tileId, text: item.text });
        break;
      case "unknown": {
        const label = `${item.id} ${part.name || "(unnamed)"}`;
        report.unknownItems.set(label, (report.unknownItems.get(label) ?? 0) + 1);
        break;
      }
      case "ignore":
        break;
    }
  }
  return reading;
}

/** A Tibia tile as a stack of ours: its floor, then at most one thing standing on it. */
function stackOf(reading: Reading, level: number): PlacedTile[] {
  const ground = reading.ground;
  let base: PlacedTile[] =
    ground === "water" || ground === "bridge"
      ? waterStack(level, ground === "bridge")
      : ground && ground in GROUND_STACK
        ? GROUND_STACK[ground as keyof typeof GROUND_STACK].map((p) => ({ ...p }))
        : [];
  if (reading.coast && ground !== "water" && ground !== "bridge") base = waterStack(level);
  if (reading.raisedFloor) base = [{ tileId: "wooden-floor" }];
  if (ground === "rock" || reading.rock) return [...base, ...ROCK.map((p) => ({ ...p }))];

  const out = [...base];
  if (reading.flowers && !reading.wall && !reading.door && !reading.window) {
    out.push({ tileId: "grass" });
  }
  if (reading.wall) return [...out, { tileId: reading.wall }];
  if (reading.door) return [...out, { tileId: reading.door.open ? "door-open" : "door-closed" }];
  if (reading.window) return [...out, { tileId: "window-1" }];
  if (reading.raisedFloor) return [...out, { tileId: "fence" }];

  let thing: PlacedTile[] | null = null;
  for (const candidate of reading.things) {
    const rank = THING_RANK[candidate[0]!.tileId] ?? 0;
    if (!thing || rank > (THING_RANK[thing[0]!.tileId] ?? 0)) thing = candidate;
  }
  if (thing) return [...out, ...thing.map((p) => ({ ...p }))];
  if (reading.sign !== null) {
    const sign: PlacedTile = { tileId: "sign", direction: "s" };
    if (reading.sign) sign.inscription = reading.sign;
    return [...out, sign];
  }
  return out;
}

type Island = {
  land: Set<string>;
  footprint: Set<string>;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
};

/** The surface joined to the temple without crossing water, which is Rookgaard and no other island. */
function findIsland(
  surfaceAt: (x: number, y: number) => OtbmTile | undefined,
  isWater: (tile: OtbmTile) => boolean,
): Island {
  const land = new Set<string>();
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  const queue: [number, number][] = [[TEMPLE.x, TEMPLE.y]];
  while (queue.length > 0) {
    const [x, y] = queue.pop()!;
    const key = `${x},${y}`;
    if (land.has(key)) continue;
    const tile = surfaceAt(x, y);
    if (!tile || isWater(tile)) continue;
    land.add(key);
    bounds.minX = Math.min(bounds.minX, x);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxY = Math.max(bounds.maxY, y);
    for (const side of SIDES) queue.push([x + side.x, y + side.y]);
  }

  const footprint = new Set<string>();
  for (const key of land) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    for (let dy = -FOOTPRINT_MARGIN; dy <= FOOTPRINT_MARGIN; dy++) {
      for (let dx = -FOOTPRINT_MARGIN; dx <= FOOTPRINT_MARGIN; dx++) {
        footprint.add(`${x + dx},${y + dy}`);
      }
    }
  }
  return { land, footprint, bounds };
}

export function translate(source: TibiaSource): { map: FlatMapFile; report: Report } {
  const report: Report = {
    cellsByLevel: {},
    unknownItems: new Map(),
    counts: { stairs: 0, ladders: 0, holes: 0, portals: 0, signs: 0, torches: 0 },
    creatures: new Map(),
    unplacedSpawns: [],
    unmappedSpawns: new Map(),
    thinnedSpawns: 0,
  };

  const tibia = new Map<string, OtbmTile>();
  for (const tile of source.tiles) tibia.set(`${tile.x},${tile.y},${tile.z}`, tile);
  const surfaceAt = (x: number, y: number) => tibia.get(`${x},${y},${SURFACE}`);

  const parts = new Map<number, Part>();
  const partOf = (id: number): Part => {
    let part = parts.get(id);
    if (!part) parts.set(id, (part = classify(source.types.get(id))));
    return part;
  };
  const isWater = (tile: OtbmTile) => {
    const part = tile.items[0] && partOf(tile.items[0].id);
    return part?.kind === "ground" && part.ground === "water";
  };

  const island = findIsland(surfaceAt, isWater);
  const board = new Board();
  const reads: Read[] = [];
  const earth: Cell[] = [];
  const roofs = new Map<string, "tiled" | "flat">();

  const { minX, maxX, minY, maxY } = island.bounds;
  for (let y = minY - SEA_MARGIN; y <= maxY + SEA_MARGIN; y++) {
    for (let x = minX - SEA_MARGIN; x <= maxX + SEA_MARGIN; x++) {
      const tile = surfaceAt(x, y);
      const cell = toCell(x, y, SURFACE);
      if (!tile || !(island.land.has(`${x},${y}`) || isWater(tile))) {
        board.set(cell.x, cell.y, cell.z, waterStack(cell.z));
        continue;
      }
      const reading = readTile(tile, partOf, report);
      reads.push({ cell, reading });
      board.set(cell.x, cell.y, cell.z, stackOf(reading, cell.z));
    }
  }

  for (const tile of source.tiles) {
    if (tile.z === SURFACE || !island.footprint.has(`${tile.x},${tile.y}`)) continue;
    const reading = readTile(tile, partOf, report);
    const cell = toCell(tile.x, tile.y, tile.z);
    reads.push({ cell, reading });
    const holdsSomething =
      reading.wall ||
      reading.door ||
      reading.window ||
      reading.rock ||
      reading.things.length > 0 ||
      reading.stairs ||
      reading.ladder ||
      reading.portal ||
      reading.sign !== null;
    if (reading.ground === "earth" && !holdsSomething) {
      earth.push(cell);
    } else if (reading.roof && reading.ground === null && !holdsSomething) {
      board.set(cell.x, cell.y, cell.z, [{ tileId: "plaster" }]);
      roofs.set(`${cell.x},${cell.y},${cell.z}`, reading.roof);
    } else {
      board.set(cell.x, cell.y, cell.z, stackOf(reading, cell.z));
    }
  }

  openDescents(board, reads);
  joinLadders(board, reads);
  climbStairs(board, reads);
  placePortals(board, reads);
  pitchRoofs(board, roofs);
  faceOpenings(board);
  hangOnWalls(board, reads);
  shellCaves(board, earth);
  placeSpawns(board, source.spawns, island, report);

  const arrival = toCell(TEMPLE.x, TEMPLE.y, TEMPLE.z);
  const altar = board.get(arrival.x, arrival.y, arrival.z) ?? [];
  board.set(arrival.x, arrival.y, arrival.z, [...altar, { tileId: "player", direction: "s" }]);

  for (const [z, cells] of board.levels) {
    report.cellsByLevel[String(z)] = cells.size;
    for (const stack of cells.values()) {
      for (const [name, tileIds] of Object.entries(COUNTED)) {
        const counted = stack.filter((p) => (tileIds as readonly string[]).includes(p.tileId));
        report.counts[name as keyof typeof COUNTED] += counted.length;
      }
    }
  }
  return { map: board.toMapFile(), report };
}

/** A hole, trapdoor or stair down in Tibia drops you a floor. Whatever climbs back up replaces it later. */
function openDescents(board: Board, reads: readonly Read[]): void {
  for (const { cell, reading } of reads) {
    if (!reading.descent) continue;
    const floor = board.floorAround(cell.x, cell.y, cell.z)[0]!.tileId;
    board.set(cell.x, cell.y, cell.z, [{ tileId: "hole", variant: HOLE_VARIANT[floor] ?? "dirt" }]);
  }
}

/**
 * Tibia climbs a ladder or a rope up through a hole, and goes down a sewer
 * grate onto a ladder. Ours go straight up and down between a `ladder-up` and a
 * `ladder-top` in the same column, so both ends are written here whichever one
 * Tibia marked.
 */
function joinLadders(board: Board, reads: readonly Read[]): void {
  const top = (x: number, y: number, z: number) => {
    const floor = (board.get(x, y, z) ?? []).filter((p) => p.tileId !== "hole");
    const base =
      floor.length > 0 && floor[0]!.tileId !== "plaster" ? [floor[0]!] : board.floorAround(x, y, z);
    board.set(x, y, z, [...base, { tileId: "ladder-top" }]);
  };
  const bottom = (x: number, y: number, z: number) => {
    board.set(x, y, z, [...board.floorAt(x, y, z), { tileId: "ladder-up" }]);
  };
  for (const { cell, reading } of reads) {
    if (reading.ladder || reading.ropeSpot) {
      bottom(cell.x, cell.y, cell.z);
      top(cell.x, cell.y, cell.z + 1);
    }
    if (reading.grate) {
      top(cell.x, cell.y, cell.z);
      bottom(cell.x, cell.y, cell.z - 1);
    }
  }
}

/**
 * Stairs here are half a level tall and a body on them has its head in the
 * level above, so the cell over a staircase is emptied (see "A ramp between two
 * levels needs a hole above it" in `docs/notes.md`). A flat roof slab where the
 * stairs come out is two units up, too high a step, so it becomes floor.
 */
function climbStairs(board: Board, reads: readonly Read[]): void {
  for (const { cell, reading } of reads) {
    if (!reading.stairs) continue;
    const { climb, tileId } = reading.stairs;
    board.set(cell.x, cell.y, cell.z, [
      ...board.floorAt(cell.x, cell.y, cell.z),
      { tileId, direction: OPPOSITE[climb] },
    ]);
    board.delete(cell.x, cell.y, cell.z + 1);
    const landing = { x: cell.x + STEP[climb].x, y: cell.y + STEP[climb].y, z: cell.z + 1 };
    if (board.get(landing.x, landing.y, landing.z)?.[0]?.tileId === "plaster") {
      board.set(
        landing.x,
        landing.y,
        landing.z,
        board.floorAround(landing.x, landing.y, landing.z),
      );
    }
  }
}

function placePortals(board: Board, reads: readonly Read[]): void {
  for (const { cell, reading } of reads) {
    if (!reading.portal) continue;
    board.set(cell.x, cell.y, cell.z, [
      ...board.floorAt(cell.x, cell.y, cell.z),
      { tileId: "portal", teleportTo: reading.portal },
    ]);
  }
}

/**
 * Tibia roofs are flat floors laid one storey up. Each connected patch of them
 * becomes a pitched roof in the grammar `planHouse` builds, one level per cell
 * stepped in across the patch's short axis, row by row so a patch that is not
 * a rectangle still gets eaves on its own edges. A patch somebody can climb
 * onto stays flat: a ladder or a staircase came out on it, so it is a terrace.
 */
function pitchRoofs(board: Board, roofs: Map<string, "tiled" | "flat">): void {
  const seen = new Set<string>();
  for (const start of roofs.keys()) {
    if (seen.has(start)) continue;
    const cells: Cell[] = [];
    const queue = [start];
    seen.add(start);
    while (queue.length > 0) {
      const [x, y, z] = queue.pop()!.split(",").map(Number) as [number, number, number];
      cells.push({ x, y, z });
      for (const side of SIDES) {
        const next = `${x + side.x},${y + side.y},${z}`;
        if (roofs.has(next) && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    if (cells.some(({ x, y, z }) => board.get(x, y, z)?.[0]?.tileId !== "plaster")) continue;

    const xs = cells.map(({ x }) => x);
    const ys = cells.map(({ y }) => y);
    const width = Math.max(...xs) - Math.min(...xs) + 1;
    const depth = Math.max(...ys) - Math.min(...ys) + 1;
    const northSouth = depth >= width;
    const first = cells[0]!;
    const tiled = cells.some(({ x, y, z }) => roofs.get(`${x},${y},${z}`) === "tiled");
    const colour = tiled
      ? ROOF_COLOURS[0]
      : ROOF_COLOURS[(((first.x * 31 + first.y * 17) % 3) + 3) % 3]!;
    const inPatch = new Set(cells.map(({ x, y }) => `${x},${y}`));
    const acrossMin = northSouth ? Math.min(...xs) : Math.min(...ys);
    const span = northSouth ? width : depth;
    const gables = Math.ceil(span / MAX_GABLE_SPAN);
    const gableOf = (at: number) => Math.floor(((at - acrossMin) * gables) / span);

    for (const { x, y, z: level } of cells) {
      const along = northSouth ? x : y;
      const gable = gableOf(along);
      const has = (at: number) =>
        gableOf(at) === gable && inPatch.has(northSouth ? `${at},${y}` : `${x},${at}`);
      let lo = along;
      while (has(lo - 1)) lo--;
      let hi = along;
      while (has(hi + 1)) hi++;
      const inset = Math.min(along - lo, hi - along);
      const column: PlacedTile[][] = [];
      for (let step = 0; step < inset; step++) {
        column.push([{ tileId: "plaster" }, { tileId: "plaster" }]);
      }
      if (along - lo === inset && hi - along === inset) {
        column.push([{ tileId: colour.ridge, direction: northSouth ? "s" : "e" }]);
      } else if (along - lo === inset) {
        column.push([{ tileId: colour.eave, direction: northSouth ? "e" : "s" }]);
      } else {
        column.push([{ tileId: colour.eave, direction: northSouth ? "w" : "n" }]);
      }
      board.delete(x, y, level);
      for (let step = 0; step < column.length; step++) {
        if (step > 0 && board.get(x, y, level + step)) break;
        board.set(x, y, level + step, column[step]!);
      }
    }
  }
}

/**
 * A door or window faces along the wall it is set in, the convention
 * `window-1` is authored with: south for a wall running east-west, east for
 * one running north-south.
 */
function faceOpenings(board: Board): void {
  for (const { x, y, z, stack } of board.cells()) {
    const top = stack.at(-1)!;
    if (!OPENINGS.has(top.tileId)) continue;
    const eastWest = isWallish(board.get(x - 1, y, z)) || isWallish(board.get(x + 1, y, z));
    const northSouth = isWallish(board.get(x, y - 1, z)) || isWallish(board.get(x, y + 1, z));
    top.direction = northSouth && !eastWest ? "e" : "s";
  }
}

/**
 * Tibia hangs a lamp or a blackboard on the wall tile itself, on the face the
 * camera sees. Ours stand in the cell in front of that face, which is south of
 * a wall running east-west and east of one running north-south.
 */
function hangOnWalls(board: Board, reads: readonly Read[]): void {
  for (const { cell, reading } of reads) {
    const hanging = reading.hangings[0];
    if (!hanging) continue;
    const runs =
      reading.wallRuns ??
      (isOpenFloor(board.get(cell.x, cell.y + 1, cell.z)) ? "horizontal" : "vertical");
    const facing: Direction = runs === "horizontal" ? "s" : "e";
    const to = { x: cell.x + STEP[facing].x, y: cell.y + STEP[facing].y };
    const floor = board.get(to.x, to.y, cell.z);
    if (!isOpenFloor(floor)) continue;
    const placed: PlacedTile = { tileId: hanging.tileId, direction: facing };
    if (hanging.tileId === "sign" && hanging.text) placed.inscription = hanging.text;
    board.set(to.x, to.y, cell.z, [...floor, placed]);
  }
}

function shellCaves(board: Board, earth: readonly Cell[]): void {
  for (const { x, y, z } of earth) {
    let touchesCave = false;
    for (let dy = -ROCK_SHELL; dy <= ROCK_SHELL && !touchesCave; dy++) {
      for (let dx = -ROCK_SHELL; dx <= ROCK_SHELL && !touchesCave; dx++) {
        const stack = board.get(x + dx, y + dy, z);
        if (stack && !isRock(stack)) touchesCave = true;
      }
    }
    if (touchesCave)
      board.set(
        x,
        y,
        z,
        ROCK.map((p) => ({ ...p })),
      );
  }
}

function placeSpawns(board: Board, spawns: readonly Spawn[], island: Island, report: Report): void {
  const here = spawns
    .filter((spawn) => island.footprint.has(`${spawn.x},${spawn.y}`))
    .sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x);
  const seenOfKind = new Map<string, number>();
  for (const spawn of here) {
    if (spawn.kind === "monster") {
      const seen = seenOfKind.get(spawn.name) ?? 0;
      seenOfKind.set(spawn.name, seen + 1);
      if (seen % MONSTERS_PER_KEPT !== 0) {
        report.thinnedSpawns++;
        continue;
      }
    }
    const tileId =
      spawn.kind === "npc" ? NPC_TILES[spawn.name] : CREATURE_TILES[spawn.name.toLowerCase()];
    if (!tileId) {
      if (spawn.kind === "monster") {
        report.unmappedSpawns.set(spawn.name, (report.unmappedSpawns.get(spawn.name) ?? 0) + 1);
      }
      continue;
    }
    const cell = toCell(spawn.x, spawn.y, spawn.z);
    const floor = board.get(cell.x, cell.y, cell.z);
    if (!isOpenFloor(floor)) {
      report.unplacedSpawns.push(`${spawn.name} at ${cell.x},${cell.y} L${cell.z}`);
      continue;
    }
    const body: PlacedTile = { tileId };
    if (spawn.kind === "npc") body.direction = "s";
    board.set(cell.x, cell.y, cell.z, [...floor, body]);
    report.creatures.set(tileId, (report.creatures.get(tileId) ?? 0) + 1);
  }
}
