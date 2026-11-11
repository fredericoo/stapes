import { expect, it } from "bun:test";
import tilesJson from "../data/tiles.json";
import statusesJson from "../data/statuses.json";
import { chunkifyMap } from "../app/lib/mapData";
import { statusesById } from "../app/lib/status";
import {
  MAP_FILE_VERSION,
  normalizeTileDef,
  type PlacedTile,
  type TileDef,
} from "../app/lib/types";
import { tilesByIdFromList } from "../app/lib/validation";
import { exploreErrand } from "./goals";
import { HOME_RANGE_MIN_CELLS, VENTURE_STEP_CELLS, homeRange, inRange } from "./homeRange";
import { exploredKey, Knowledge } from "./knowledge";

const tilesById = tilesByIdFromList((tilesJson as TileDef[]).map(normalizeTileDef));
const statuses = statusesById(statusesJson as unknown[]);
const home = { x: 2, y: 4, z: 0 };

it.each([
  { case: "nothing known", farthest: 0, danger: null, z: 0, cells: HOME_RANGE_MIN_CELLS },
  { case: "been far", farthest: 60, danger: null, z: 0, cells: 60 + VENTURE_STEP_CELLS },
  { case: "danger beyond", farthest: 60, danger: { x: 52, cells: 9 }, z: 0, cells: 52 - 9 },
  {
    case: "danger at home",
    farthest: 60,
    danger: { x: 6, cells: 9 },
    z: 0,
    cells: HOME_RANGE_MIN_CELLS,
  },
  {
    case: "other level",
    farthest: 60,
    danger: { x: 52, cells: 9 },
    z: -1,
    cells: 60 + VENTURE_STEP_CELLS,
  },
])("ranges $cells cells on level $z with $case", ({ farthest, danger, z, cells }) => {
  const dangers = danger
    ? [{ at: { x: home.x + danger.x, y: home.y, z: 0 }, cells: danger.cells }]
    : [];
  const range = homeRange(home, dangers, () => farthest);

  expect(range.cells(z)).toBe(cells);
});

/** A long field the bot has been sent all of, so its only edges are the outside of the map. */
function corridor(): Knowledge {
  const cells: Record<string, PlacedTile[]> = {};
  for (let x = 0; x < 160; x++) {
    for (let y = 0; y < 8; y++) cells[`${x},${y}`] = [{ tileId: "grass-2" }];
  }
  const map = chunkifyMap({ version: MAP_FILE_VERSION, levels: { "0": cells } });
  return new Knowledge(map, [], tilesById, statuses);
}

it.each([
  { case: "nothing explored", explored: new Set<string>() },
  {
    case: "all of its range explored",
    explored: new Set(Array.from({ length: 40 }, (_, x) => exploredKey({ x, y: 4, z: 0 }))),
  },
])("heads back inside its range from far outside it with $case", ({ explored }) => {
  const range = homeRange(home, [], () => 0);
  const recall = {
    skipped: new Set<string>(),
    explored,
    random: () => 0.5,
    pulls: 0,
    avoid: () => false,
    range,
  };

  const errand = exploreErrand(corridor(), { x: 150, y: 4, z: 0 }, null, recall, range);

  expect(errand?.explores && inRange(range, errand.explores)).toBe(true);
});
