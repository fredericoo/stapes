import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import { fixtureTutorial, type FixtureCell } from "../lib/fixtureTutorial";
import { emptyMap, replaceStack } from "../lib/mapData";
import { normalizeTileDef, type MapFile, type PlacedTile, type TileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { cellGoal, levelGoal, planRoute, type NavLeg, type NavWorld } from "./navigation";

const tilesById = tilesByIdFromList((tilesJson as TileDef[]).map(normalizeTileDef));

function worldOf(cells: readonly FixtureCell[]): NavWorld {
  let board: MapFile = emptyMap();
  for (const [x, y, z, stack] of cells) board = replaceStack(board, x, y, z, stack);
  return { board, traveller: tilesById.player!, tilesById, statusDefs: {} };
}

const floor = (...more: PlacedTile[]): PlacedTile[] => [{ tileId: "grass-2" }, ...more];

function kinds(legs: readonly NavLeg[]): string[] {
  return legs.flatMap((leg) => {
    if (leg.kind === "use") return ["use"];
    if (leg.drop) return ["drop"];
    return leg.opens ? ["open"] : [];
  });
}

describe("planRoute", () => {
  it("drops into the pit, climbs the ladder and takes the ramps to the surface", () => {
    const route = planRoute(worldOf(fixtureTutorial()), { x: 0, y: 0, z: -1 }, levelGoal(0));

    expect(route.ok).toBe(true);
    if (!route.ok) return;
    expect(kinds(route.legs)).toEqual(["drop", "use"]);
    expect(route.legs.at(-1)!.to.z).toBe(0);
  });

  it("does not climb back up a drop", () => {
    const world = worldOf(fixtureTutorial({ ladder: false }));

    const route = planRoute(world, { x: 5, y: 0, z: -2 }, cellGoal({ x: 0, y: 0, z: -1 }));

    expect(route).toMatchObject({ ok: false, why: "unreachable" });
  });

  it("opens a closed door that stands in the way", () => {
    const door: PlacedTile = { tileId: "door-closed", direction: "e" };
    const world = worldOf([
      [0, 0, 0, floor()],
      [1, 0, 0, floor(door)],
      [2, 0, 0, floor()],
    ]);

    const route = planRoute(world, { x: 0, y: 0, z: 0 }, cellGoal({ x: 2, y: 0, z: 0 }));

    expect(route.ok).toBe(true);
    if (!route.ok) return;
    expect(route.legs[0]).toMatchObject({ kind: "walk", opens: { x: 1, y: 0, z: 0 } });
  });
});
