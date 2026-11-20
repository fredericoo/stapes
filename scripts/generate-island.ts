import { chunkifyMap, serializeMap } from "../app/lib/mapData";
import { normalizeTileDef } from "../app/lib/types";
import type { TileDef } from "../app/lib/types";
import { statusesById } from "../app/lib/status";
import { tilesByIdFromList } from "../app/lib/validation";
import { applyExceptions, parseExceptions } from "../app/verify/exceptions";
import { checkLandscape } from "../app/verify/landscape";
import { findStranded } from "../app/verify/stranded";
import { traitsById, withTraits } from "../app/lib/traits";
import { planIsland } from "./island/plan";
import { readSketch } from "./island/sketch";
import { tile } from "./island/board";
import { Builder } from "./island/build";
import { placeCast } from "./island/cast";
import { mapDoc } from "./island/doc";
import { harmoniseGround } from "./island/harmonise";
import { buildHarbour, buildLighthouse, buildWreck } from "./island/landmarks";
import { GROWN, plant } from "./island/plants";
import { buildCamp, buildDruids, buildInn, buildWarriors, buildWitch } from "./island/settlements";
import { bedRivers, raiseFallPockets, joinRiverCorners, writeTerrain } from "./island/stacks";
import { mergeSpecks } from "./island/specks";
import { buildIsland } from "./island/terrain";
import { digUnderground } from "./island/caves";
import { placeCreatures } from "./island/creatures";
import { reachable } from "./island/reach";
import { frayClearings } from "./island/fray";
import { layGrass } from "./island/grass";
import { jogStraightBorders } from "./island/jog";

/**
 * Writes Rune Isle to `data/map.json`: the island from the reference
 * generator inside the sketch's coast (`scripts/island/`), its settlements,
 * roads and plants. Seeded, so the same arguments write the same file.
 *
 * It writes `data/map-staging.json`, a corner of the same island for the
 * staging world, and `docs/map.md`, the table of who lives and works where.
 *
 *   bun run generate:island [--seed 75599] [--scale 0.5] [--out data/map.json]
 */
function argValue(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

export const ISLAND = { seed: 75599, cellsPerPixel: 0.5, peakLevel: 7, seaRing: 20 } as const;

const GROUND_PASSES = 6;
const LANDSCAPE_LISTED = 10;

const seed = Number(argValue("--seed") ?? ISLAND.seed);
const cellsPerPixel = Number(argValue("--scale") ?? ISLAND.cellsPerPixel);
const out = argValue("--out") ?? "data/map.json";

const tiles: TileDef[] = (JSON.parse(await Bun.file("data/tiles.json").text()) as unknown[]).map(
  (raw) => normalizeTileDef(raw),
);
const tilesById = tilesByIdFromList(tiles);

/** The island is written only if `verify landscape` would pass it, so a change to the generator cannot bring back the rivers and patches it rules out. */
async function refuseUnlikeLandscape(map: Parameters<typeof checkLandscape>[0]["map"]) {
  const traits = traitsById(JSON.parse(await Bun.file("data/traits.json").text()));
  const report = checkLandscape({ map, tilesById: tilesByIdFromList(withTraits(tiles, traits)) });
  const exceptions = parseExceptions(
    JSON.parse(await Bun.file("data/verify-exceptions.json").text()),
  );
  const { failing } = applyExceptions("landscape", report.problems, exceptions);
  if (failing.length === 0) return;
  const listed = failing.slice(0, LANDSCAPE_LISTED).map((p) => `  ${p.kind}: ${p.message}`);
  throw new Error(
    `the island breaks ${failing.length} landscape rules, so nothing was written; fix the generator, or excuse a rule in data/verify-exceptions.json:\n${listed.join("\n")}`,
  );
}

const started = performance.now();
const island = buildIsland({ ...ISLAND, seed, cellsPerPixel, sketch: await readSketch() });
const plan = planIsland(island);
const board = writeTerrain(island, plan);
const builder = new Builder(board, island, plan, tilesById);
const sites = plan.sites;
buildCamp(builder, sites.get("camp")!);
buildDruids(builder, sites.get("druids")!);
buildWarriors(builder, sites.get("warriors")!);
buildInn(builder, sites.get("inn")!);
buildWitch(builder, sites.get("witch")!);
buildHarbour(builder, sites.get("harbour")!);
buildLighthouse(builder, sites.get("lighthouse")!);
buildWreck(builder);
placeCast(builder);
plant(builder, frayClearings(builder));
const underground = digUnderground(builder, tilesById);
{
  const at = island.place("wreckBeach");
  const z = island.level[at.y * island.width + at.x]!;
  board.set(at.x, at.y, z, [tile(builder.base(at.x, at.y)), tile("player", "s")]);
}
/**
 * Each pass can give a river grass ground that needs a bed and banks, and
 * the dirt can open a seam, or leave a speck of ground, that the next pass
 * closes. Once the ground holds still, a border left straight is jogged and
 * the ground settles round the jog.
 */
for (let pass = 0; pass < GROUND_PASSES; pass++) {
  harmoniseGround(board, tilesById);
  const changed =
    joinRiverCorners(island, board, GROWN) +
    raiseFallPockets(island, board) +
    bedRivers(island, board, GROWN) +
    mergeSpecks(island, board);
  if (changed === 0 && jogStraightBorders(island, board, tilesById) === 0) break;
}
layGrass(island, board);
const creatures = placeCreatures(
  builder,
  underground,
  tilesById,
  await reachable(chunkifyMap(board.toFlat()), tilesById),
);

for (const layer of board.levels.values()) {
  for (const stack of layer.values()) {
    for (const placed of stack) {
      if (!tilesById[placed.tileId])
        throw new Error(`no tile "${placed.tileId}" in data/tiles.json`);
      if (tilesById[placed.tileId]!.footprint && !placed.span) {
        throw new Error(
          `"${placed.tileId}" covers more than one cell and was placed without its footprint`,
        );
      }
    }
  }
}

const flat = chunkifyMap(board.toFlat());
await refuseUnlikeLandscape(flat);
const json = serializeMap(flat);
await Bun.write(out, json);

/**
 * The staging world is a corner of this one, small enough to stay well
 * inside a preview's memory: the wreck beach, the camp, the harbour ruins and
 * the lighthouse, inside a ring of sea. The crop is widened until it cuts no
 * hill off from the ramps that lead down it.
 */
const stagingOut = argValue("--staging-out") ?? "data/map-staging.json";
{
  const pts = [
    island.place("wreckBeach"),
    island.place("camp"),
    island.place("harbour"),
    island.place("lighthouse"),
  ];
  const lighthouse = plan.sites.get("lighthouse")!;
  const camp = plan.sites.get("camp")!;
  const statusDefs = statusesById(JSON.parse(await Bun.file("data/statuses.json").text()));
  let staging = "";
  for (const grow of [0, 8, 16, 24, 32, 40]) {
    const rect = {
      x0: Math.min(...pts.map((p) => p.x)) - 40 - grow,
      x1: Math.max(lighthouse.x1, ...pts.map((p) => p.x)) + 12,
      y0: camp.y0 - 12 - grow,
      y1: Math.max(...pts.map((p) => p.y)) + 30,
    };
    const cropped = chunkifyMap(board.crop(rect, ISLAND.seaRing).toFlat());
    if (findStranded(cropped, tilesById, statusDefs).stranded > 0) continue;
    staging = serializeMap(cropped);
    break;
  }
  if (!staging) throw new Error("every staging crop tried cuts a hill off from its ramps");
  await Bun.write(stagingOut, staging);
  console.log(JSON.stringify({ out: stagingOut, megabytes: +(staging.length / 1e6).toFixed(1) }));
}
console.log(
  JSON.stringify({
    out,
    seconds: +((performance.now() - started) / 1000).toFixed(1),
    cells: board.cellCount(),
    megabytes: +(json.length / 1e6).toFixed(1),
    levels: [...board.levels.keys()].sort((a, b) => a - b),
    ramps: plan.ramps.length,
    bridges: plan.bridges.length,
    tallFall:
      plan.tallFall < 0
        ? null
        : [
            (plan.tallFall % island.width) + board.ox,
            Math.floor(plan.tallFall / island.width) + board.oy,
          ],
    roads: plan.roadLengths,
    buildings: builder.buildings.length,
    residents: builder.residents.filter((r) => r.tileId).length,
    lamps: builder.lamps.length,
    cats: builder.cats.length,
    underground: underground.cells,
    creatures: creatures.reduce(
      (sum, h) => sum + Object.values(h.placed).reduce((a, c) => a + c, 0),
      0,
    ),
  }),
);
await Bun.write(
  argValue("--doc") ?? "docs/map.md",
  mapDoc(builder, plan, island, { seed, cellsPerPixel }, underground, creatures),
);
const record = argValue("--record");
if (record) {
  await Bun.write(
    record,
    JSON.stringify(
      {
        buildings: builder.buildings,
        residents: builder.residents,
        lamps: builder.lamps,
        cats: builder.cats,
        ox: board.ox,
        oy: board.oy,
      },
      null,
      1,
    ),
  );
}
