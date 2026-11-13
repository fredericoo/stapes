import { chunkifyMap, parseMap, serializeMap } from "../app/lib/mapData";
import { statusesById } from "../app/lib/status";
import { findStranded } from "../app/verify/stranded";
import { navigationLegs } from "../app/game/navigation";
import { tilesByIdFromList } from "../app/lib/validation";
import { MAP_FILE_VERSION, coordKey, normalizeTileDef } from "../app/lib/types";
import type { Coord, Direction, MapFile, TileDef } from "../app/lib/types";

const FILL = "half-stone";
const SLOPE = "hill-wall";
const RAMP = "ramp";

/** What `hill-wall` is and connects to, so a cell of any of these beside a wall keeps the wall's top whole on that side. */
const ROCK = new Set([
  FILL,
  "stone-wall",
  "cave-wall",
  "cave-wall-sloped",
  "cave-wall-grey",
  "cave-wall-sloped-grey",
  SLOPE,
]);

/** What `raise:hills` laid on each kind of ground beside a drop, and the brink that replaces both. */
const GROUNDS: Record<string, { ledge: string; brink: string }> = {
  "grass-2": { ledge: "grass-ledge", brink: "grass-brink" },
  "sand-dunes": { ledge: "sand-ledge", brink: "sand-brink" },
};

/** A cell the reachability walk starts from. It has to be one a player can stand in. */
const START: Coord = { x: -8, y: 0, z: 0 };

const STEP: Record<Direction, { dx: number; dy: number }> = {
  n: { dx: 0, dy: -1 },
  e: { dx: 1, dy: 0 },
  s: { dx: 0, dy: 1 },
  w: { dx: -1, dy: 0 },
};

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

const brinks = new Set(Object.values(GROUNDS).map(({ brink }) => brink));
for (const id of [SLOPE, ...brinks]) {
  if (!tilesById[id]) throw new Error(`data/tiles.json has no ${id}`);
}
const sloped = Object.values(map.levels).some((cells) =>
  Object.values(cells).some((stack) => stack.some((placed) => brinks.has(placed.tileId))),
);
if (sloped) {
  console.error("data/map.json already has brinks. Run this on a map whose hills are blocks.");
  process.exit(1);
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

/** Without drops, as in `raise-hills.ts`: with them every valley is reachable from a hilltop nothing leads up. */
function reachableOnFoot(board: MapFile): Set<string> {
  const world = { board, traveller: playerDef, tilesById, statusDefs: {} };
  const seen = new Set<string>([cellKey(START)]);
  const queue: Coord[] = [START];
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

const isFill = (stack: Placed[] | undefined) =>
  stack?.length === 3 &&
  stack[0]!.tileId in GROUNDS &&
  stack[1]!.tileId === FILL &&
  stack[2]!.tileId === FILL;

/**
 * The cell a ramp lands on stays a full block with plain ground on it. A ramp
 * ends at the edge of its cell, and a sloped wall's top stops half a cell short
 * of that edge, which would leave a strip of slope between the two.
 */
function rampHeads(): Set<string> {
  const heads = new Set<string>();
  for (const [z, cells] of Object.entries(map.levels)) {
    for (const [key, stack] of Object.entries(cells)) {
      const ramp = stack[2];
      if (stack.length !== 3 || stack[1]!.tileId !== FILL || ramp!.tileId !== RAMP) continue;
      const [x, y] = key.split(",").map(Number) as [number, number];
      const { dx, dy } = STEP[ramp!.direction ?? "s"];
      heads.add(`${coordKey(x - dx, y - dy)},${z}`);
    }
  }
  return heads;
}

const heads = rampHeads();
const isRock = (stack: Placed[] | undefined) =>
  stack?.some((placed) => ROCK.has(placed.tileId)) === true;

/**
 * A sloped wall's top stops half a cell short of every side or corner where
 * the rock stops, so the cell above it needs a brink wherever one of the eight
 * cells around the wall is not rock. That takes in the cells `raise:hills`
 * gave a ledge and the ends of a bridge, which it gave none.
 */
function atDrop(below: Record<string, Placed[]>, key: string): boolean {
  const [x, y] = key.split(",").map(Number) as [number, number];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!isRock(below[coordKey(x + dx, y + dy)])) return true;
    }
  }
  return false;
}

const levels: Flat["levels"] = {};
const counts = { walls: 0, brinks: 0, heads: 0 };
for (const [z, cells] of Object.entries(map.levels)) {
  const under = String(Number(z) - 1);
  const below = map.levels[under] ?? {};
  const out: Record<string, Placed[]> = (levels[z] = {});
  for (const [key, stack] of Object.entries(cells)) {
    const ground = GROUNDS[stack[0]!.tileId];
    if (isFill(stack) && !heads.has(`${key},${z}`)) {
      out[key] = [stack[0]!, { tileId: SLOPE }];
      counts.walls++;
      continue;
    }
    if (!ground || !isFill(below[key])) {
      out[key] = stack;
      continue;
    }
    const rest = stack.slice(1).filter((placed) => placed.tileId !== ground.ledge);
    if (heads.has(`${key},${under}`)) {
      out[key] = [stack[0]!, ...rest];
      counts.heads++;
    } else if (atDrop(below, key)) {
      out[key] = [{ tileId: ground.brink }, ...rest];
      counts.brinks++;
    } else {
      out[key] = stack;
    }
  }
}
const slopedMap: Flat = { version: map.version, levels };

console.log(
  `${counts.walls} fill cells sloped, ${counts.brinks} brinks laid, ${counts.heads} ramp heads kept as blocks`,
);

console.log("walking the map before and after…");
const before = reachableOnFoot(toBoard(map));
const after = reachableOnFoot(toBoard(slopedMap));
const moved = [
  ...[...before].filter((key) => !after.has(key)),
  ...[...after].filter((key) => !before.has(key)),
];
console.log(`on foot before ${before.size} cells, after ${after.size}`);
if (moved.length > 0) {
  console.error(`${moved.length} cells can be walked to on one map and not the other:`);
  for (const key of moved.slice(0, 40)) console.error(`  ${key}`);
  process.exit(1);
}

const statusDefs = statusesById(JSON.parse(await Bun.file("data/statuses.json").text()));
const withBodies = (flat: Flat) =>
  parseMap(serializeMap(chunkifyMap({ version: flat.version, levels: flat.levels } as never)));
const strandedIn = (flat: Flat) => findStranded(withBodies(flat), tilesById, statusDefs);

const strandedBefore = strandedIn(map);
const stranded = strandedIn(slopedMap);
if (!stranded.ok && stranded.stranded > strandedBefore.stranded) {
  console.error(
    `${stranded.stranded} cells can be dropped into and not left, against ${strandedBefore.stranded} before:`,
  );
  for (const region of stranded.regions.slice(0, 20)) {
    const at = region.cells[0]!;
    console.error(`  ${region.cells.length} cells around ${at.x},${at.y} L${at.z}`);
  }
  process.exit(1);
}

if (dryRun) {
  console.log("--dry-run: data/map.json left as it was");
} else {
  await Bun.write(MAP_PATH, serializeMap(chunkifyMap(slopedMap as never)));
  console.log(`wrote ${MAP_PATH}`);
}
