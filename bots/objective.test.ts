import { expect, it } from "bun:test";
import tilesJson from "../data/tiles.json";
import { equipmentForBody } from "../app/game/battlerKit";
import { normalizeTileDef, type TileDef } from "../app/lib/types";
import { tilesByIdFromList } from "../app/lib/validation";
import { Economy } from "./economy";
import { bodyOf } from "./gear";
import { objectivesFor, type Objective, type Sources } from "./objective";

const tilesById = tilesByIdFromList((tilesJson as TileDef[]).map(normalizeTileDef));
const body = bodyOf(tilesById, {})!;
const starter = equipmentForBody("player", tilesById, () => 0);
const economy = new Economy(tilesById, {}, "blunt");

const takesOnly = (tileId: string) => (objective: Objective) =>
  objective.needs.every((need) => need.tileId === tileId);

const timed = (kill: number | null, pull: number | null): Sources => ({
  sold: () => true,
  killSeconds: () => kill,
  pullSeconds: () => pull,
});

it("reads from the catalogue that skins come from hunting and shards from gathering", () => {
  const objectives = objectivesFor(economy, starter, body, {}, timed(10, 10));

  expect(objectives.find(takesOnly("skin"))?.needs[0]?.via).toBe("hunt");
  expect(objectives.find(takesOnly("arcane-shard"))?.needs[0]?.via).toBe("gather");
});

it("leaves out an offer whose seller nobody has found or whose input it has no creature to hunt for", () => {
  const nothingHunted = objectivesFor(economy, starter, body, {}, timed(null, 10));
  const nobodyFound = objectivesFor(
    economy,
    starter,
    body,
    {},
    { ...timed(10, 10), sold: () => false },
  );

  expect(nothingHunted.some((o) => o.needs.some((need) => need.tileId === "skin"))).toBe(false);
  expect(nothingHunted.some(takesOnly("arcane-shard"))).toBe(true);
  expect(nobodyFound).toEqual([]);
});

it("counts what its depots hold towards an objective", () => {
  const depots = { town: [{ id: "saved", tileId: "skin", count: 3 }] };
  const objectives = objectivesFor(economy, starter, body, depots, timed(10, 10));

  expect(objectives.find(takesOnly("skin"))?.needs[0]?.have).toBe(3);
});

it("ranks first the offer whose inputs come quickest for what it gains, whatever its price", () => {
  const slowKills = objectivesFor(economy, starter, body, {}, timed(60, 5));
  const slowPulls = objectivesFor(economy, starter, body, {}, timed(5, 60));

  expect(slowKills[0]?.needs.map((need) => need.via)).toEqual(["gather"]);
  expect(slowPulls[0]?.needs.map((need) => need.via)).toEqual(["hunt"]);
});
