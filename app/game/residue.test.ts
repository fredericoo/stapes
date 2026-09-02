import { describe, expect, it } from "vitest";
import { DEFAULT_CONTAINER } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { emptyEquipment, type Equipment } from "./equipment";
import { slotKey } from "./itemMoves";
import { leaveResidue, residueSlots } from "./residue";

/**
 * Where a bottle goes once the potion is gone.
 *
 * The session tests cover a drink end to end; these pin the order the places
 * are tried in and the refusals, against a kit built by hand.
 */

const frame = {
  sprite: {
    tilesetId: "basic",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  durationMs: 200,
};

function tile(partial: Record<string, unknown>): TileDef {
  return normalizeTileDef({
    name: partial.id,
    height: 0,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    kind: "item",
    intangible: true,
    ...partial,
  });
}

const bottle = tile({
  id: "bottle",
  interactions: { item: { type: "artifact", pile: 12 } },
});
const sword = tile({
  id: "sword",
  interactions: {
    item: { type: "weapon", damage: 1, def: 0, accuracy: 100, variance: 0, spd: 50, mastery: "blade" },
  },
});
const bag = tile({
  id: "bag",
  interactions: { item: { ...DEFAULT_CONTAINER, size: 2 } },
});
const chest = tile({
  id: "chest",
  interactions: { item: { ...DEFAULT_CONTAINER, size: 2, equippable: false } },
});
const grass = tile({ id: "grass", kind: "prop", intangible: false });

const tilesById: Record<string, TileDef> = Object.fromEntries(
  [bottle, sword, bag, chest, grass].map((def) => [def.id, def]),
);

const actor = { x: 0, y: 0, z: 0 };

/** A board with the actor's cell and a chest one step east. */
function board(chestContents: ItemInstance[] = []): MapFile {
  let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
  map = replaceStack(map, 1, 0, 0, [
    { tileId: "grass" },
    { tileId: "chest", itemId: "itm_chest", contents: chestContents },
  ]);
  return map;
}

let minted = 0;
function instance(tileId: string): ItemInstance {
  return { id: `itm_${++minted}`, tileId };
}

function wearing(contents: ItemInstance[], hands: Partial<Equipment> = {}): Equipment {
  return {
    ...emptyEquipment(),
    bag: { id: "itm_bag", tileId: "bag", contents },
    ...hands,
  };
}

describe("where the residue may go", () => {
  it("tries the place the drink was, then the bag, then the hands", () => {
    expect(residueSlots({ kind: "contents", index: 3, of: "weapon" }).map(slotKey)).toEqual([
      "contents:weapon:0",
      "contents:bag:0",
      "offhand",
      "weapon",
    ]);
  });

  it("does not ask the worn bag twice for a drink out of it", () => {
    expect(residueSlots({ kind: "contents", index: 1 }).map(slotKey)).toEqual([
      "contents:bag:0",
      "offhand",
      "weapon",
    ]);
  });

  it("puts a hand first when the drink was in it, and asks it once", () => {
    expect(residueSlots({ kind: "offhand" }).map(slotKey)).toEqual([
      "offhand",
      "contents:bag:0",
      "weapon",
    ]);
  });
});

describe("leaving the residue", () => {
  it("lands in the bag the potion came out of", () => {
    const kit = wearing([]);
    const map = board();
    const landed = leaveResidue(map, tilesById, actor, kit, { kind: "contents", index: 0 }, instance("bottle"));
    expect(landed?.equipment.bag?.contents?.map((i) => i.tileId)).toEqual(["bottle"]);
    // The board is untouched, and identically so: nothing here reindexes.
    expect(landed?.map).toBe(map);
  });

  it("pours onto a bottle pile already in the bag, needing no square", () => {
    const kit = wearing([
      { id: "itm_b", tileId: "bottle", count: 3 },
      instance("sword"),
    ]);
    const landed = leaveResidue(board(), tilesById, actor, kit, { kind: "contents", index: 1 }, instance("bottle"));
    expect(landed?.equipment.bag?.contents).toEqual([
      { id: "itm_b", tileId: "bottle", count: 4 },
      kit.bag!.contents![1],
    ]);
  });

  it("lands in the hand that held the last of the pile", () => {
    const kit = wearing([instance("sword"), instance("sword")]);
    const landed = leaveResidue(board(), tilesById, actor, kit, { kind: "offhand" }, instance("bottle"));
    expect(landed?.equipment.offhand?.tileId).toBe("bottle");
  });

  it("falls past a hand still holding the rest of the pile, into the bag", () => {
    const kit = wearing([], { offhand: { id: "itm_p", tileId: "sword" } });
    const landed = leaveResidue(board(), tilesById, actor, kit, { kind: "offhand" }, instance("bottle"));
    expect(landed?.equipment.offhand?.tileId).toBe("sword");
    expect(landed?.equipment.bag?.contents?.map((i) => i.tileId)).toEqual(["bottle"]);
  });

  it("stays in the chest the potion was drunk out of", () => {
    const map = board([]);
    const chestRef = { x: 1, y: 0, z: 0, stackIndex: 1 };
    const landed = leaveResidue(map, tilesById, actor, wearing([]), { kind: "ground", ref: chestRef, index: 0 }, instance("bottle"));
    expect(landed?.map.levels).not.toBe(map.levels);
    expect(landed?.equipment).toEqual(wearing([]));
  });

  it("refuses when nothing on the body will take it", () => {
    const kit = wearing([instance("sword"), instance("sword")], {
      weapon: instance("sword"),
      offhand: instance("sword"),
    });
    expect(
      leaveResidue(board(), tilesById, actor, kit, { kind: "contents", index: 0 }, instance("bottle")),
    ).toBeNull();
  });
});
