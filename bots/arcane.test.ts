import { describe, expect, it } from "bun:test";
import tilesJson from "../data/tiles.json";
import statusesJson from "../data/statuses.json";
import { squareSlot, type CastSquare } from "../app/game/casting";
import { emptyEquipment, type Equipment } from "../app/game/equipment";
import { statusesById } from "../app/lib/status";
import { normalizeTileDef, type TileDef } from "../app/lib/types";
import { tilesByIdFromList } from "../app/lib/validation";
import { bestBolt, forgeOrders } from "./arcane";
import { bodyOf } from "./gear";

const tilesById = tilesByIdFromList((tilesJson as TileDef[]).map(normalizeTileDef));
const statuses = statusesById(statusesJson as unknown[]);
const READY = { ok: true } as const;

function trained(levels: Record<string, number>) {
  const body = bodyOf(tilesById, {})!;
  return { ...body, masteries: { ...body.masteries, ...levels } };
}

function holding(bag: string[]): Equipment {
  return {
    ...emptyEquipment(),
    bag: {
      id: "bag",
      tileId: "leather-backpack",
      contents: bag.map((tileId, i) => ({ id: `item-${i}`, tileId })),
    },
  };
}

describe("bestBolt", () => {
  const caster = trained({ arcane: 10 }).masteries;
  const hands = (stones: Partial<Record<CastSquare, string>>) =>
    Object.entries(stones).map(([square, tileId]) => ({
      slot: squareSlot(square as CastSquare),
      tileId,
      castability: READY,
    }));

  it("throws water at a fire body, though fire hits harder on paper", () => {
    const buttons = hands({ weapon: "arcane-stone-of-cinder", offhand: "arcane-stone-of-sleet" });

    expect(bestBolt(buttons, tilesById, caster, ["fire"])).toEqual(squareSlot("offhand"));
    expect(bestBolt(buttons, tilesById, caster, [])).toEqual(squareSlot("weapon"));
  });

  it("passes over a stone that is still cooling", () => {
    const buttons = [
      ...hands({ offhand: "arcane-stone-of-sleet" }),
      {
        slot: squareSlot("weapon"),
        tileId: "arcane-stone-of-cinder",
        castability: { ok: false, reason: "cooling" } as const,
      },
    ];

    expect(bestBolt(buttons, tilesById, caster, [])).toEqual(squareSlot("offhand"));
  });
});

describe("forgeOrders", () => {
  const recipes = (bag: string[], levels: Record<string, number>) =>
    forgeOrders(tilesById, statuses, holding(bag), trained(levels)).map((o) => o.recipe.name);

  it("always forges a blank, even when nothing it can become is castable yet", () => {
    expect(recipes(["arcane-stone"], { arcane: 1 })).toEqual(["Forge a Blank Stone"]);
  });

  it("merges a pair only once what it makes can be cast and outworths either stone", () => {
    const cinders = ["arcane-stone-of-cinder", "arcane-stone-of-cinder"];

    expect(recipes(cinders, { arcane: 10 })).toEqual([]);
    expect(recipes(cinders, { arcane: 20, fire: 5 })).toEqual([]);
    expect(recipes(cinders, { arcane: 40, fire: 20 })).toEqual(["Forge Ember"]);
  });
});
