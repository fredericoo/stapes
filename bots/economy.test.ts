import { expect, it } from "bun:test";
import tilesJson from "../data/tiles.json";
import type { Depots } from "../app/game/depot";
import { emptyEquipment, type Equipment } from "../app/game/equipment";
import { normalizeTileDef, type TileDef } from "../app/lib/types";
import { tilesByIdFromList } from "../app/lib/validation";
import { Economy, type BankMove } from "./economy";
import { bodyOf } from "./gear";

const tilesById = tilesByIdFromList((tilesJson as TileDef[]).map(normalizeTileDef));
const body = bodyOf(tilesById, {})!;

/** More than anything costs, so no price in the catalogue decides a case. */
const PLENTY = 1_000;

function carrying(shards: number): Equipment {
  const contents = shards > 0 ? [{ id: "carried", tileId: "arcane-shard", count: shards }] : [];
  return { ...emptyEquipment(), bag: { id: "bag", tileId: "basic-bag", contents } };
}

function stashOf(shards: number): Depots {
  return { town: [{ id: "saved", tileId: "arcane-shard", count: shards }] };
}

it("moves nothing at a depot while it can pay, and takes out only for a seller it knows", () => {
  const economy = new Economy(tilesById, {}, "blunt");
  const everySeller = () => true;
  const noSeller = () => false;
  const takeOut: BankMove[] = [{ kind: "withdraw", tileId: "arcane-shard", from: 0, tag: "town" }];
  const putIn: BankMove[] = [{ kind: "deposit", tileId: "arcane-shard", from: 0 }];

  expect(economy.bankMoves(carrying(PLENTY), body, stashOf(PLENTY), everySeller)).toEqual([]);
  expect(economy.bankMoves(carrying(0), body, stashOf(PLENTY), everySeller)).toEqual(takeOut);
  expect(economy.bankMoves(carrying(PLENTY), body, stashOf(PLENTY), noSeller)).toEqual(putIn);
});
