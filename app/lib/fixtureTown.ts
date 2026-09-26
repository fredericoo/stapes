import { chunkifyMap } from "./mapData";
import { MAP_FILE_VERSION, coordKey, levelKey } from "./types";
import type { FlatMapFile, MapFile, PlacedTile } from "./types";

const TOWN_HALF_SPAN = 56;

const BLOCK_SIZE = 16;

const HOUSE_MARGIN = 3;

const HOUSE_WALL_LEVELS = 2;

const ROOF_LEVEL = HOUSE_WALL_LEVELS + 1;

const CAVE_HALF_SPAN = 18;

const CAVE_LEVEL = -1;

const FOREST_DEPTH = 4;

const TORCH_EVERY_NTH_HOUSE = 3;

const FOREST_CLEARANCE = 4;

const TREE_SPACING = 2;

const SQUARE_HALF_SPAN = BLOCK_SIZE / 2;

const SPAWN_CREATURES: ReadonlyArray<{ x: number; y: number; tileId: string }> = [
  { x: 4, y: 2, tileId: "deer" },
  { x: -5, y: 3, tileId: "deer" },
  { x: 2, y: -4, tileId: "cat" },
  { x: -3, y: -5, tileId: "cat" },
];

type Cells = Map<string, PlacedTile[]>;

function levelOf(levels: Map<number, Cells>, z: number): Cells {
  let level = levels.get(z);
  if (!level) {
    level = new Map();
    levels.set(z, level);
  }
  return level;
}

function put(levels: Map<number, Cells>, x: number, y: number, z: number, tile: PlacedTile) {
  const level = levelOf(levels, z);
  const key = coordKey(x, y);
  const stack = level.get(key);
  if (stack) stack.push(tile);
  else level.set(key, [tile]);
}

function isStreet(x: number, y: number): boolean {
  return mod(x, BLOCK_SIZE) === 0 || mod(y, BLOCK_SIZE) === 0;
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

function blockOf(v: number): number {
  return Math.floor(v / BLOCK_SIZE);
}

type Rect = { x0: number; y0: number; x1: number; y1: number };

const SQUARE: Rect = {
  x0: -SQUARE_HALF_SPAN,
  y0: -SQUARE_HALF_SPAN,
  x1: SQUARE_HALF_SPAN,
  y1: SQUARE_HALF_SPAN,
};

const POND: Rect = {
  x0: -BLOCK_SIZE * 2 + 1,
  y0: BLOCK_SIZE + 1,
  x1: -BLOCK_SIZE - 1,
  y1: BLOCK_SIZE * 2 - 1,
};

function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
}

function houseAt(bx: number, by: number): Rect | null {
  const house: Rect = {
    x0: bx * BLOCK_SIZE + HOUSE_MARGIN,
    y0: by * BLOCK_SIZE + HOUSE_MARGIN,
    x1: (bx + 1) * BLOCK_SIZE - HOUSE_MARGIN,
    y1: (by + 1) * BLOCK_SIZE - HOUSE_MARGIN,
  };
  const insideTown =
    house.x0 >= -TOWN_HALF_SPAN &&
    house.y0 >= -TOWN_HALF_SPAN &&
    house.x1 <= TOWN_HALF_SPAN &&
    house.y1 <= TOWN_HALF_SPAN;
  if (!insideTown) return null;
  if (overlaps(house, SQUARE)) return null;
  if (overlaps(house, POND)) return null;
  return house;
}

function onPerimeter(x: number, y: number, r: Rect): boolean {
  return x === r.x0 || x === r.x1 || y === r.y0 || y === r.y1;
}

function layGround(levels: Map<number, Cells>) {
  for (let y = -TOWN_HALF_SPAN; y <= TOWN_HALF_SPAN; y++) {
    for (let x = -TOWN_HALF_SPAN; x <= TOWN_HALF_SPAN; x++) {
      put(levels, x, y, 0, { tileId: "grass-2" });
      if (isStreet(x, y) || contains(SQUARE, x, y)) {
        put(levels, x, y, 0, { tileId: "cobblestone" });
      }
    }
  }
}

function layTownWall(levels: Map<number, Cells>) {
  for (let v = -TOWN_HALF_SPAN; v <= TOWN_HALF_SPAN; v++) {
    for (const [x, y] of [
      [v, -TOWN_HALF_SPAN],
      [v, TOWN_HALF_SPAN],
      [-TOWN_HALF_SPAN, v],
      [TOWN_HALF_SPAN, v],
    ] as const) {
      put(levels, x, y, 0, { tileId: "half-stone" });
      put(levels, x, y, 1, { tileId: "half-stone" });
    }
  }
}

function layHouses(levels: Map<number, Cells>) {
  let built = 0;
  const lowestBlock = blockOf(-TOWN_HALF_SPAN);
  const highestBlock = blockOf(TOWN_HALF_SPAN);
  for (let by = lowestBlock; by <= highestBlock; by++) {
    for (let bx = lowestBlock; bx <= highestBlock; bx++) {
      const house = houseAt(bx, by);
      if (!house) continue;
      layHouse(levels, house, built % TORCH_EVERY_NTH_HOUSE === 0);
      built++;
    }
  }
}

function layHouse(levels: Map<number, Cells>, house: Rect, lit: boolean) {
  const doorX = Math.floor((house.x0 + house.x1) / 2);
  for (let y = house.y0; y <= house.y1; y++) {
    for (let x = house.x0; x <= house.x1; x++) {
      if (!onPerimeter(x, y, house)) {
        put(levels, x, y, 0, { tileId: "wooden-floor" });
        continue;
      }
      if (x === doorX && y === house.y1) {
        put(levels, x, y, 0, { tileId: "door-closed" });
        continue;
      }
      const isWindow = x === doorX && y === house.y0;
      put(levels, x, y, 0, { tileId: isWindow ? "window-1" : "stone-wall" });
      for (let z = 1; z <= HOUSE_WALL_LEVELS; z++) {
        put(levels, x, y, z, { tileId: "stone-wall" });
      }
    }
  }
  for (let y = house.y0; y <= house.y1; y++) {
    for (let x = house.x0; x <= house.x1; x++) {
      put(levels, x, y, ROOF_LEVEL, { tileId: "roof-1" });
    }
  }
  if (lit) {
    put(levels, house.x0 + 1, house.y0 + 1, 0, { tileId: "torch", direction: "n" });
  }
  put(levels, house.x1 - 1, house.y1 - 1, 0, { tileId: "barrel" });
}

function layStreetLamps(levels: Map<number, Cells>) {
  const first = -Math.floor(TOWN_HALF_SPAN / BLOCK_SIZE) * BLOCK_SIZE;
  for (let y = first; y <= TOWN_HALF_SPAN; y += BLOCK_SIZE) {
    for (let x = first; x <= TOWN_HALF_SPAN; x += BLOCK_SIZE) {
      if (contains(SQUARE, x, y)) continue;
      put(levels, x, y, 0, { tileId: "lamppost" });
    }
  }
}

function layForest(levels: Map<number, Cells>) {
  const clearance = TOWN_HALF_SPAN + FOREST_CLEARANCE;
  const span = clearance + FOREST_DEPTH;
  for (let y = -span; y <= span; y++) {
    for (let x = -span; x <= span; x++) {
      if (Math.abs(x) <= clearance && Math.abs(y) <= clearance) continue;
      put(levels, x, y, 0, { tileId: "dirt" });
      if (mod(x, TREE_SPACING) === 0 && mod(y, TREE_SPACING) === 0) {
        put(levels, x, y, 0, { tileId: "tree" });
      }
    }
  }
}

function layCave(levels: Map<number, Cells>) {
  for (let y = -CAVE_HALF_SPAN; y <= CAVE_HALF_SPAN; y++) {
    for (let x = -CAVE_HALF_SPAN; x <= CAVE_HALF_SPAN; x++) {
      put(levels, x, y, CAVE_LEVEL, { tileId: "brick-slab" });
      const edge = Math.abs(x) === CAVE_HALF_SPAN || Math.abs(y) === CAVE_HALF_SPAN;
      if (edge) put(levels, x, y, CAVE_LEVEL, { tileId: "stone-wall" });
      else if (mod(x, BLOCK_SIZE) === 0 && mod(y, BLOCK_SIZE) === 0) {
        put(levels, x, y, CAVE_LEVEL, { tileId: "torch", direction: "n" });
      }
    }
  }
}

function layPond(levels: Map<number, Cells>) {
  const cx = (POND.x0 + POND.x1) / 2;
  const cy = (POND.y0 + POND.y1) / 2;
  const rx = (POND.x1 - POND.x0) / 2;
  const ry = (POND.y1 - POND.y0) / 2;
  for (let y = POND.y0; y <= POND.y1; y++) {
    for (let x = POND.x0; x <= POND.x1; x++) {
      if (isStreet(x, y)) continue;
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy > 1) continue;
      put(levels, x, y, 0, { tileId: "dirt" });
      put(levels, x, y, 0, { tileId: "water" });
    }
  }
}

function layTownSquare(levels: Map<number, Cells>) {
  put(levels, 0, 0, 0, { tileId: "player" });
  for (const { x, y, tileId } of SPAWN_CREATURES) put(levels, x, y, 0, { tileId });
  put(levels, SQUARE_HALF_SPAN - 1, 0, 0, { tileId: "sign", description: "The square" });
  put(levels, -SQUARE_HALF_SPAN + 1, 0, 0, { tileId: "wooden-box" });
}

function build(): FlatMapFile {
  const levels = new Map<number, Cells>();
  layGround(levels);
  layForest(levels);
  layTownWall(levels);
  layHouses(levels);
  layStreetLamps(levels);
  layCave(levels);
  layPond(levels);
  layTownSquare(levels);

  const out: FlatMapFile["levels"] = {};
  for (const [z, cells] of levels) {
    out[levelKey(z)] = Object.fromEntries(cells);
  }
  return { version: MAP_FILE_VERSION, levels: out };
}

let cached: FlatMapFile | null = null;

export function fixtureTown(): MapFile {
  cached ??= build();
  return chunkifyMap(structuredClone(cached));
}
