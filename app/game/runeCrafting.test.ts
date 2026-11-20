import { describe, expect, it } from "vitest";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile } from "../lib/types";
import type { ObjectRef } from "./affordances";
import { emptyEquipment, type Equipment } from "./equipment";
import { GameSession } from "./GameSession";
import { shippedTiles } from "./testShippedTiles";

const tiles = shippedTiles();

const BESIDE = { x: 0, y: 1, z: 0 };
const AT_THE_PROP: ObjectRef = { x: 1, y: 0, z: 0, stackIndex: 1 };

function boardWith(tileId: string): MapFile {
  let map = emptyMap();
  for (let x = -1; x <= 3; x++) {
    for (let y = -1; y <= 3; y++) map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
  }
  map = replaceStack(map, -1, -1, 0, [{ tileId: "grass" }, { tileId: "player", direction: "s" }]);
  return replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId }]);
}

function carrying(piles: Record<string, number>): Equipment {
  return {
    ...emptyEquipment(),
    bag: {
      id: "itm_bag",
      tileId: "leather-backpack",
      contents: Object.entries(piles).map(([tileId, count], i) => ({
        id: `itm_${i}`,
        tileId,
        ...(count > 1 ? { count } : {}),
      })),
    },
  };
}

function piles(equipment: Equipment | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of equipment?.bag?.contents ?? []) {
    out[item.tileId] = (out[item.tileId] ?? 0) + (item.count ?? 1);
  }
  return out;
}

describe("shaping a blank at a rune forge", () => {
  const forges = [
    { forge: "bone-forge", material: "bone", cost: 3, blank: "rune-blank-bone" },
    { forge: "crystal-forge", material: "arcane-shard", cost: 4, blank: "rune-blank-crystal" },
    { forge: "obsidian-forge", material: "obsidian-shard", cost: 5, blank: "rune-blank-obsidian" },
  ];
  const everyMaterial = { bone: 6, "arcane-shard": 6, "obsidian-shard": 6 };

  it.each(forges)("$forge spends $cost $material on one $blank, and no other material", (row) => {
    const session = new GameSession(boardWith(row.forge), tiles);
    session.spawn("shaper", { at: BESIDE, carrying: carrying(everyMaterial) });

    expect(session.craft(AT_THE_PROP, 0, "shaper")).toBe(true);
    expect(piles(session.equipmentOf("shaper"))).toEqual({
      ...everyMaterial,
      [row.material]: 6 - row.cost,
      [row.blank]: 1,
    });
  });

  it.each(forges)("$forge refuses one $material short of its cost", (row) => {
    const session = new GameSession(boardWith(row.forge), tiles);
    session.spawn("shaper", {
      at: BESIDE,
      carrying: carrying({ ...everyMaterial, [row.material]: row.cost - 1 }),
    });

    expect(session.craft(AT_THE_PROP, 0, "shaper")).toBe(false);
  });
});
