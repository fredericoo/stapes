import { join } from "node:path";
import { GameSession } from "../app/game/GameSession";
import { chunkifyMap, serializeMap } from "../app/lib/mapData";
import { statusesById } from "../app/lib/status";
import { normalizeTileDef } from "../app/lib/types";
import type { TileDef } from "../app/lib/types";
import { removeUnfitPlacements, tilesByIdFromList } from "../app/lib/validation";
import { readItemTypes } from "./rookgaard/itemTypes";
import { readOtbmTiles } from "./rookgaard/otbm";
import { readSpawns } from "./rookgaard/spawns";
import { TEMPLE, translate } from "./rookgaard/translate";
import { walkFromSpawn } from "./rookgaard/verify";

const MAP_PATH = "data/map.json";
const TILES_PATH = "data/tiles.json";
const STATUSES_PATH = "data/statuses.json";

/** What is read out of the world file: the island, and every floor, with room on each side. */
const REGION = {
  x0: TEMPLE.x - 200,
  x1: TEMPLE.x + 160,
  y0: TEMPLE.y - 200,
  y1: TEMPLE.y + 100,
};
const AREA_SPAN = 256;

const source = process.argv[2];
if (!source) {
  console.error(
    [
      "usage: bun run import:rookgaard <datapack data directory>",
      "",
      "The directory is an OTHire 7.72 datapack's data/, which holds",
      "  world/world.otbm, world/world-spawn.xml, items/items.otb and items/items.xml.",
      "The one this was written against is peonso/tibialegacyserver's server/data;",
      "its world ships as world/world.7z and has to be unpacked first.",
    ].join("\n"),
  );
  process.exit(1);
}

const file = (path: string) => Bun.file(join(source, path));
const types = readItemTypes(
  new Uint8Array(await file("items/items.otb").arrayBuffer()),
  await file("items/items.xml").text(),
);
const tiles = readOtbmTiles(new Uint8Array(await file("world/world.otbm").arrayBuffer()), {
  wantsArea: (x, y) =>
    x + AREA_SPAN > REGION.x0 && x <= REGION.x1 && y + AREA_SPAN > REGION.y0 && y <= REGION.y1,
  wantsTile: (x, y) => x >= REGION.x0 && x <= REGION.x1 && y >= REGION.y0 && y <= REGION.y1,
});
const spawns = readSpawns(await file("world/world-spawn.xml").text());
console.log(`read ${tiles.length} tiles, ${types.size} item types, ${spawns.length} spawns`);

const { map: flat, report } = translate({ tiles, types, spawns });

const tileDefs: TileDef[] = (JSON.parse(await Bun.file(TILES_PATH).text()) as unknown[]).map(
  (raw) => normalizeTileDef(raw),
);
const tilesById = tilesByIdFromList(tileDefs);
const { map, removed } = removeUnfitPlacements(chunkifyMap(flat), tilesById);

/** Built and dropped: a map the server could not start a world on throws here, before it is written. */
new GameSession(map, tileDefs, {
  actorIds: [],
  statuses: statusesById(JSON.parse(await Bun.file(STATUSES_PATH).text())),
});

await Bun.write(MAP_PATH, serializeMap(map));

const counted = (entries: Map<string, number>) =>
  [...entries]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} ×${count}`)
    .join(", ");

console.log(`wrote ${MAP_PATH}`);
console.log(
  Object.entries(report.counts)
    .map(([name, count]) => `${name} ${count}`)
    .join(", "),
);
console.log(
  `creatures: ${counted(report.creatures)} (${report.thinnedSpawns} of Tibia's monsters left out)`,
);
if (report.unmappedSpawns.size > 0)
  console.log(`no counterpart: ${counted(report.unmappedSpawns)}`);
if (report.unplacedSpawns.length > 0) {
  console.log(`${report.unplacedSpawns.length} spawns had nowhere to stand and were left out`);
}
if (report.unknownItems.size > 0)
  console.log(`untranslated items: ${counted(report.unknownItems)}`);
if (removed.length > 0) {
  const byTile = new Map<string, number>();
  for (const r of removed) byTile.set(r.tileId, (byTile.get(r.tileId) ?? 0) + 1);
  console.log(`removed ${removed.length} placements that did not fit: ${counted(byTile)}`);
}

const walk = walkFromSpawn(map, tilesById);
for (const z of Object.keys(report.cellsByLevel).sort((a, b) => Number(b) - Number(a))) {
  console.log(
    `L${z}: ${report.cellsByLevel[z]} cells; walked to ${walk.reachedByLevel[z] ?? 0}`,
    `of the ${walk.standableByLevel[z] ?? 0} a body can stand in`,
  );
}
const problems = [
  ...walk.shopkeepersOutOfReach.map((at) => `nobody can get near enough to talk to the ${at}`),
  ...walk.stairsThatClimbNowhere.map((at) => `the stairs at ${at} climb nowhere`),
];
if (problems.length > 0) {
  console.error(`${problems.length} problems:\n${problems.join("\n")}`);
  process.exit(1);
}
