import { chunkifyMap, parseMap, serializeMap } from "../app/lib/mapData";
import { statusesById } from "../app/lib/status";
import { findStranded } from "../app/verify/stranded";
import { randomAt } from "../app/editor/generator";
import { tilesByIdFromList } from "../app/lib/validation";
import { normalizeTileDef } from "../app/lib/types";
import type { StatusDef } from "../app/lib/status";
import type { Direction, MapFile, TileDef } from "../app/lib/types";

const THINNING = {
  seed: 0xb057e,

  /** The walled town and its margin keep the bushes they were planted with. */
  town: { x0: -47, x1: 31, y0: -46, y1: 19 },

  /** The share of the bushes outside the town that is removed. */
  removeShare: 0.6,

  /** How far, in cells, another bush counts as crowding one, which puts it first in line to go. */
  crowdReach: 2,
} as const;

/** Every state of every bush, so a berry bush counts whether or not it has been picked. */
const BUSHES = new Set(["bush", "picked-bush", "small-bush", "bush-3"]);

const MAP_PATH = "data/map.json";
const dryRun = process.argv.includes("--dry-run");

type Placed = { tileId: string; direction?: Direction; [field: string]: unknown };
type Flat = { version: number; levels: Record<string, Record<string, Placed[]>> };
type Bush = { x: number; y: number; z: number; tileId: string };

const map: Flat = JSON.parse(await Bun.file(MAP_PATH).text());
const tiles: TileDef[] = (JSON.parse(await Bun.file("data/tiles.json").text()) as unknown[]).map(
  (raw) => normalizeTileDef(raw),
);
const tilesById = tilesByIdFromList(tiles);
const statusDefs: Record<string, StatusDef> = statusesById(
  JSON.parse(await Bun.file("data/statuses.json").text()),
);

const toBoard = (flat: Flat): MapFile => parseMap(serializeMap(chunkifyMap(flat as never)));

function inTown(x: number, y: number): boolean {
  const { x0, x1, y0, y1 } = THINNING.town;
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

function everyBush(): Bush[] {
  const bushes: Bush[] = [];
  for (const [zKey, cells] of Object.entries(map.levels)) {
    for (const [key, stack] of Object.entries(cells)) {
      const bush = stack.find((placed) => BUSHES.has(placed.tileId));
      if (!bush) continue;
      const [x, y] = key.split(",").map(Number) as [number, number];
      bushes.push({ x, y, z: Number(zKey), tileId: bush.tileId });
    }
  }
  return bushes;
}

function countByTile(bushes: readonly Bush[]): string {
  const counts = new Map<string, number>();
  for (const { tileId } of bushes) counts.set(tileId, (counts.get(tileId) ?? 0) + 1);
  return [...BUSHES].map((id) => `${id} ${counts.get(id) ?? 0}`).join(", ");
}

function crowding(bush: Bush, bushes: readonly Bush[]): number {
  return bushes.filter(
    (other) =>
      other !== bush &&
      other.z === bush.z &&
      Math.max(Math.abs(other.x - bush.x), Math.abs(other.y - bush.y)) <= THINNING.crowdReach,
  ).length;
}

const before = everyBush();
const strandedBefore = findStranded(toBoard(map), tilesById, statusDefs).stranded;

const candidates = before.filter(({ x, y }) => !inTown(x, y));
const ranked = candidates
  .map((bush) => ({
    bush,
    crowd: crowding(bush, before),
    roll: randomAt(bush.x, bush.y, THINNING.seed ^ bush.z),
  }))
  .sort((a, b) => b.crowd - a.crowd || a.roll - b.roll);
const removed = ranked
  .slice(0, Math.round(candidates.length * THINNING.removeShare))
  .map(({ bush }) => bush);

for (const { x, y, z } of removed) {
  const cells = map.levels[String(z)]!;
  const key = `${x},${y}`;
  const kept = cells[key]!.filter((placed) => !BUSHES.has(placed.tileId));
  if (kept.length > 0) cells[key] = kept;
  else delete cells[key];
}

const after = everyBush();
const strandedAfter = findStranded(toBoard(map), tilesById, statusDefs).stranded;

console.log(
  `removed ${removed.length} of ${candidates.length} bushes outside the town (${countByTile(removed)})`,
);
console.log(`bushes: ${before.length} → ${after.length} (${countByTile(after)} left)`);
console.log(`stranded: ${strandedBefore} → ${strandedAfter}`);

if (strandedAfter > strandedBefore) {
  console.error("thin:bushes: the thinned map strands cells the old one did not; not written");
  process.exit(1);
}
if (dryRun) {
  console.log("--dry-run: data/map.json left as it was");
} else {
  await Bun.write(MAP_PATH, serializeMap(chunkifyMap(map as never)));
  console.log(`wrote ${MAP_PATH}`);
}
