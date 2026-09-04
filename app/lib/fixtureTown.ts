/**
 * The map the unit suite runs against.
 *
 * `data/map.json` is the world being authored: somebody moves a shopkeeper,
 * roofs a building, or plants a hedge, and any test that read a coordinate out
 * of it fails on a change that had nothing to do with the code. Those failures
 * taught nobody anything, so the suite builds its own town instead and leaves
 * the shipped map to the e2e run, which is the one that is actually about it.
 *
 * What is deliberately *not* faked is the tile catalogue. `data/tiles.json` is
 * the real thing here, because the heights, the light-passing flags and the
 * per-frame emitter radii are what most of these subsystems are reasoning
 * about — a fixture tile with a made-up radius would test the fixture.
 *
 * The shape is a walled town on a road grid: a ground plane, houses with
 * walls, roofs and lit interiors, a lamplit street grid, a forest outside the
 * wall and a cave beneath the square. That mix exists so the map exercises
 * every case the lighting and geometry paths split on — sky-exposed cells,
 * roofed ones, emitters at several levels, half-height occluders — and so its
 * scale stands still while `data/map.json` grows.
 */
import { chunkifyMap } from "./mapData";
import { coordKey, levelKey } from "./types";
import type { FlatMapFile, MapFile, PlacedTile } from "./types";

/**
 * Half-width of the ground plane, in cells.
 *
 * Sized so the town lands within a few percent of the shipped map's cell and
 * quad counts. The lighting bake budget in `app/editor/perf.ts` is a wall-clock
 * number measured against a map of roughly this size, so shrinking this makes
 * that budget pass for the wrong reason. `app/lib/mapData.test.ts` pins the
 * resulting scale.
 */
const TOWN_HALF_SPAN = 56;

/** Pitch of the street grid. Also the size of one town block. */
const BLOCK_SIZE = 16;

/** Inset of a house from the streets bounding its block. */
const HOUSE_MARGIN = 3;

/** Levels a house wall occupies above its floor: z = 1 and z = 2. */
const HOUSE_WALL_LEVELS = 2;

/** Level the roof sits on, directly above the top of the walls. */
const ROOF_LEVEL = HOUSE_WALL_LEVELS + 1;

/** Half-width of the cave carved under the town square. */
const CAVE_HALF_SPAN = 18;

/** Level the cave sits on. */
const CAVE_LEVEL = -1;

/**
 * How far the forest reaches past the clearance ring.
 *
 * Kept narrow because forest cells are one quad each: a wide ring inflates the
 * cell count — which is what the sky flood is paid per — without adding any of
 * the stacked geometry the rest of the map is here to provide.
 */
const FOREST_DEPTH = 4;

/** Only every Nth house gets a torch, so emitters stay near the shipped count. */
const TORCH_EVERY_NTH_HOUSE = 3;

/** Cells between the town wall and the first trees. */
const FOREST_CLEARANCE = 4;

/** One tree per N×N patch of forest, so trunks do not form a solid block. */
const TREE_SPACING = 2;

/** Half-width of the town square, which is kept clear for the spawn. */
const SQUARE_HALF_SPAN = BLOCK_SIZE / 2;

/**
 * Creatures near the spawn.
 *
 * Named rather than scattered, because `app/render/lightingSteadiness.test.ts`
 * is about bodies moving inside the lighting window and needs to know they are
 * there. A deer grazes and a cat roams, which are the two brains that used to
 * dirty the light cache every tick.
 */
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

/** True on a street cell — the grid lines the blocks are laid out between. */
function isStreet(x: number, y: number): boolean {
  return mod(x, BLOCK_SIZE) === 0 || mod(y, BLOCK_SIZE) === 0;
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** The block a cell belongs to, identified by the corner street it sits past. */
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

/**
 * The block the pond fills, two blocks out from the square.
 *
 * The pond is here so the renderer budgets in `app/editor/perf.ts` are measured
 * against **animated terrain**, which is the one thing the fixture had none of.
 * Torches animate, and a map has a few dozen of them; water animates and a map
 * has hundreds of it, so it is the only tile whose animation can plausibly move
 * a draw-call count. Without a pond here the budgets pass on a fixture that
 * cannot fail them, while the shipped map goes over.
 *
 * Kept clear of the streets that bound its block, so the grid the rest of the
 * town is laid out on still runs past it.
 */
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

/**
 * The house footprint of a block, or null where no house is built.
 *
 * Nothing is built over the square: the spawn, the creatures around it and the
 * lighting window `app/render/lightingSteadiness.test.ts` watches all live
 * there, and a wall dropped on one of them would leave that test passing for
 * want of anything that moves.
 */
function houseAt(bx: number, by: number): Rect | null {
  const house: Rect = {
    x0: bx * BLOCK_SIZE + HOUSE_MARGIN,
    y0: by * BLOCK_SIZE + HOUSE_MARGIN,
    x1: (bx + 1) * BLOCK_SIZE - HOUSE_MARGIN,
    y1: (by + 1) * BLOCK_SIZE - HOUSE_MARGIN,
  };
  const insideTown =
    house.x0 >= -TOWN_HALF_SPAN && house.y0 >= -TOWN_HALF_SPAN &&
    house.x1 <= TOWN_HALF_SPAN && house.y1 <= TOWN_HALF_SPAN;
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

/**
 * The wall around the town, in half-height stone.
 *
 * Half-height on purpose: a half-block occludes sight but still takes part in
 * the sky flood, and that split is the one the chunked baker gets wrong most
 * easily. A wall of full-height stone would never take the branch.
 */
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
      // Windows halfway along each wall, so some of the interior is lit
      // through an opening rather than only by its own torch.
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

/** A lamppost on every street intersection but the square's own. */
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

/**
 * A chamber under the square, walled and torchlit.
 *
 * Below the ground plane rather than beside it, so the map has a level that
 * sees no sky at all. Every emitter down here is the only light there is,
 * which is what makes a dropped chunk visible rather than merely dimmer.
 */
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

/**
 * A pond filling one block, in water over a dirt bed.
 *
 * An ellipse rather than the block, because a rectangle of water would sit
 * entirely inside one lighting chunk boundary and one autotile neighbourhood,
 * and the interesting cells are the ones on a curve.
 */
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
  return { version: 1, levels: out };
}

let cached: FlatMapFile | null = null;

/**
 * The town, in the runtime shape.
 *
 * A fresh copy per call. Callers hand it to a `GameSession`, which owns and
 * mutates whatever it is given, so a shared instance would let one test's
 * pushed crate turn up in the next.
 */
export function fixtureTown(): MapFile {
  cached ??= build();
  return chunkifyMap(structuredClone(cached));
}
