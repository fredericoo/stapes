import { expect, it } from "bun:test";
import tilesJson from "../data/tiles.json";
import traitsJson from "../data/traits.json";
import { normalizeTileDef, type Coord, type TileDef } from "../app/lib/types";
import { traitsById, withTraits } from "../app/lib/traits";
import { tilesByIdFromList } from "../app/lib/validation";
import { Landmarks } from "./memory";
import { refugeFor } from "./refuge";

const tilesById = tilesByIdFromList(
  withTraits((tilesJson as TileDef[]).map(normalizeTileDef), traitsById(traitsJson as unknown[])),
);

const SELF = { x: 0, y: 0, z: 0 };

/** Stands in for a tile id in `sightings`: the place the fleet was last reborn. */
const REBORN = "reborn";

function refuge(sightings: Array<[string, Coord]>, avoid: (cell: Coord) => boolean = () => false) {
  const landmarks = new Landmarks(":memory:");
  for (const [tileId, at] of sightings) {
    if (tileId === REBORN) landmarks.reborn(at);
    else landmarks.saw(tileId, at);
  }
  return refugeFor({ landmarks, tilesById, bodies: [], avoid }, SELF);
}

it.each([
  {
    case: "walks far to an NPC when a wolf was seen beside it",
    sightings: [
      ["wolf", { x: 0, y: 5, z: 0 }],
      ["pie-maker", { x: 80, y: 0, z: 0 }],
    ],
    expected: { x: 80, y: 0, z: 0 },
  },
  {
    case: "recovers where it stands when nothing was seen near it and safe ground is far",
    sightings: [["pie-maker", { x: 80, y: 0, z: 0 }]],
    expected: null,
  },
  {
    case: "walks to safe ground that is near even with nothing near it",
    sightings: [[REBORN, { x: 20, y: 0, z: 0 }]],
    expected: { x: 20, y: 0, z: 0 },
  },
  {
    case: "stays where it is when it already stands on safe ground",
    sightings: [
      ["wolf", { x: 0, y: 5, z: 0 }],
      [REBORN, { x: 0, y: 2, z: 0 }],
    ],
    expected: null,
  },
  {
    case: "passes over an NPC with a wolf seen beside it",
    sightings: [
      ["wolf", { x: 0, y: 5, z: 0 }],
      ["pie-maker", { x: 40, y: 0, z: 0 }],
      ["wolf", { x: 43, y: 0, z: 0 }],
      [REBORN, { x: -60, y: 0, z: 0 }],
    ],
    expected: { x: -60, y: 0, z: 0 },
  },
  {
    case: "takes the longer way round when the shorter one passes two wolves",
    sightings: [
      ["wolf", { x: 0, y: 5, z: 0 }],
      ["wolf", { x: 20, y: 30, z: 0 }],
      ["snake", { x: 30, y: 30, z: 0 }],
      [REBORN, { x: 40, y: 40, z: 0 }],
      ["pie-maker", { x: -90, y: 0, z: 0 }],
    ],
    expected: { x: -90, y: 0, z: 0 },
  },
] as const)("$case", ({ sightings, expected }) => {
  expect(refuge(sightings as unknown as Array<[string, Coord]>)).toEqual(expected);
});

it("never picks a haven where the bot itself died", () => {
  const diedAt = { x: 40, y: 0, z: 0 };
  const sightings: Array<[string, Coord]> = [
    ["wolf", { x: 0, y: 5, z: 0 }],
    [REBORN, diedAt],
  ];

  expect(refuge(sightings, (cell) => cell.x === diedAt.x && cell.y === diedAt.y)).toBeNull();
});
