import { describe, expect, it } from "bun:test";
import tilesJson from "../data/tiles.json";
import { emptyEquipment, type Equipment } from "../app/game/equipment";
import { applyItemMove, clearSlot } from "../app/game/itemMoves";
import { emptyMap } from "../app/lib/mapData";
import { normalizeTileDef, type TileDef } from "../app/lib/types";
import { tilesByIdFromList } from "../app/lib/validation";
import { nextDressing, type Judge } from "./dress";
import { bodyOf, type Style } from "./gear";

const tilesById = tilesByIdFromList((tilesJson as TileDef[]).map(normalizeTileDef));

function judge(style: Style): Judge {
  return {
    body: bodyOf(tilesById, {})!,
    taste: { style, statusDefs: {} },
    keeps: () => false,
    spends: () => false,
    refused: () => false,
  };
}

function kit(worn: Partial<Equipment>, bag: string[]): Equipment {
  return {
    ...emptyEquipment(),
    ...worn,
    bag: {
      id: "bag",
      tileId: "basic-bag",
      contents: bag.map((tileId, i) => ({ id: `item-${i}`, tileId })),
    },
  };
}

/** Applies dressings the way the server would until the bot has nothing left to change. */
function dressed(equipment: Equipment, style: Style): { equipment: Equipment; dropped: string[] } {
  const dropped: string[] = [];
  const at = { x: 0, y: 0, z: 0 };
  for (let moves = 0; moves < 8; moves++) {
    const dressing = nextDressing(equipment, tilesById, judge(style));
    if (!dressing) return { equipment, dropped };
    if (dressing.kind === "drop") {
      equipment = clearSlot(emptyMap(), tilesById, at, equipment, dressing.from)!.equipment;
      dropped.push(dressing.tileId);
      continue;
    }
    equipment = applyItemMove(
      emptyMap(),
      tilesById,
      at,
      equipment,
      dressing.from,
      dressing.to,
    )!.equipment;
  }
  throw new Error("the bot never stopped changing its gear");
}

describe("nextDressing", () => {
  it("has an archer take up the bow and keep the sword in its other hand", () => {
    const start = kit({ weapon: { id: "s", tileId: "rusty-sword" } }, ["simple-bow"]);
    const { equipment, dropped } = dressed(start, "ranged");
    expect(equipment.weapon?.tileId).toBe("simple-bow");
    expect(equipment.offhand?.tileId).toBe("rusty-sword");
    expect(dropped).toEqual([]);
  });

  it("has a swordsman drop a bow it picked up rather than carry it", () => {
    const start = kit({ weapon: { id: "s", tileId: "rusty-sword" } }, ["simple-bow"]);
    const { equipment, dropped } = dressed(start, "sharp");
    expect(equipment.weapon?.tileId).toBe("rusty-sword");
    expect(dropped).toEqual(["simple-bow"]);
  });
});
