import { describe, expect, it } from "vitest";
import { shippedTiles } from "../game/testShippedTiles";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile, PlacedTile } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { checkLandscape, type LandscapeProblemKind } from "./landscape";

const tilesById = tilesByIdFromList(shippedTiles());

const t = (tileId: string): PlacedTile => ({ tileId });
const GRASS = [t("grass-2")];
const SAND = [t("sand-dunes")];
const SNOW = [t("snow")];
const GRASS_RIVER = [t("grass-2"), t("dirt"), t("water")];
const GRASS_BANK = [t("grass-2"), t("dirt")];
const MUD = [t("grass-2"), t("mud")];
const SNOW_RIVER = [t("snow"), t("water")];
const SEA = [t("sand-dunes"), t("water")];

const FIELD_CELLS = 30;
/** Wide enough for one window of the crowding rule to see a whole desert. */
const DESERT_CELLS = 40;
const RIVER_X = 15;

type Paint = (x: number, y: number) => PlacedTile[];

function field(size: number, paint: Paint): MapFile {
  let map = emptyMap();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) map = replaceStack(map, x, y, 0, paint(x, y));
  }
  return map;
}

const kindsOf = (map: MapFile): LandscapeProblemKind[] => [
  ...new Set(checkLandscape({ map, tilesById }).problems.map((p) => p.kind)),
];

/** A river one cell wide running down a meadow at `riverX(y)`, with the ground either side painted by `bank` and `land`. */
function meadowRiver(
  riverX: (y: number) => number,
  { river = GRASS_RIVER, bank = GRASS_BANK, land = GRASS } = {},
): MapFile {
  return field(FIELD_CELLS, (x, y) => {
    if (x === riverX(y)) return river;
    const nearRiver = [-1, 0, 1].some((dy) => Math.abs(x - riverX(y + dy)) <= 1);
    return nearRiver ? bank : land;
  });
}

const straight = () => RIVER_X;
/** Steps one cell east halfway down, touching the cell above only at a corner. */
const stepped = (y: number) => (y < FIELD_CELLS / 2 ? RIVER_X : RIVER_X + 1);

describe("checkLandscape", () => {
  it.each<[string, MapFile, LandscapeProblemKind[]]>([
    ["a river on grass with a dirt bed and dirt banks", meadowRiver(straight), []],
    ["a river on grass with mud banks", meadowRiver(straight, { bank: MUD }), ["water-mud"]],
    ["a river that steps sideways only at a corner", meadowRiver(stepped), ["river-corner"]],
    [
      "a river on grass with no dirt under the water",
      meadowRiver(straight, { river: [t("grass-2"), t("water")] }),
      ["river-bed"],
    ],
    [
      "a river on grass with bare grass banks",
      meadowRiver(straight, { bank: GRASS }),
      ["river-bank"],
    ],
    [
      "a river through snow with no grass or mud round it",
      meadowRiver(straight, { river: SNOW_RIVER, bank: SNOW, land: SNOW }),
      [],
    ],
    [
      "a river laid on grass through a snowfield",
      meadowRiver(straight, { bank: SNOW, land: SNOW }),
      ["river-ground"],
    ],
  ])("%s", (_, map, expected) => {
    expect(kindsOf(map)).toEqual(expected);
  });

  it("leaves a sea shore bare and fails mud laid on it", () => {
    const SEA_CELLS = 8;
    const coast = (bank: PlacedTile[]) =>
      field(FIELD_CELLS, (x) => (x < SEA_CELLS ? SEA : x === SEA_CELLS ? bank : GRASS));
    expect(kindsOf(coast(GRASS))).toEqual([]);
    expect(kindsOf(coast(MUD))).toEqual(["water-mud"]);
  });

  it.each<[string, PlacedTile[], number, LandscapeProblemKind[]]>([
    ["a speck of snow", SNOW, 2, ["ground-patch"]],
    ["a field of snow off the peak", SNOW, 10, ["ground-patch"]],
    ["a field of sand", SAND, 10, []],
  ])("judges %s inside a meadow", (_, ground, sideCells, expected) => {
    const PATCH_AT = 10;
    const inPatch = (v: number) => v >= PATCH_AT && v < PATCH_AT + sideCells;
    const map = field(FIELD_CELLS, (x, y) => (inPatch(x) && inPatch(y) ? ground : GRASS));
    expect(kindsOf(map)).toEqual(expected);
  });

  it("fails a border drawn with a ruler and passes a ragged one", () => {
    const BORDER_X = 15;
    const RAGGED_ROWS = 3;
    const border = (edgeX: (y: number) => number) =>
      field(FIELD_CELLS, (x, y) => (x < edgeX(y) ? GRASS : SAND));
    expect(kindsOf(border(() => BORDER_X))).toEqual(["straight-edge"]);
    const ragged = (y: number) => BORDER_X + (Math.floor(y / RAGGED_ROWS) % 2);
    expect(kindsOf(border(ragged))).toEqual([]);
  });

  it("fails a desert crowded with cacti and passes a sparse one", () => {
    const desert = (everyCells: number) =>
      field(DESERT_CELLS, (x, y) =>
        x % everyCells === 0 && y % everyCells === 0 ? [...SAND, t("saguaro")] : SAND,
      );
    const CROWDED_EVERY_CELLS = 3;
    const SPARSE_EVERY_CELLS = 8;
    expect(kindsOf(desert(CROWDED_EVERY_CELLS))).toEqual(["crowded"]);
    expect(kindsOf(desert(SPARSE_EVERY_CELLS))).toEqual([]);
  });
});
