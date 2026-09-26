import { describe, expect, it } from "vitest";
import { DEFAULT_CONSUMABLE, DEFAULT_CONTAINER, DEFAULT_WEAPON } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import type { TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { emptyEquipment, type Equipment } from "./equipment";
import { itemUseFor } from "./itemUse";
import tilesJson from "../../data/tiles.json";
import { normalizeTiles } from "../lib/types";

function tile(partial: Record<string, unknown>): TileDef {
  return normalizeTileDef({
    name: partial.id,
    height: 0,
    type: "simple",
    kind: "prop",
    attributes: {},
    sprite: { frames: [] },
    ...partial,
  });
}

const tiles = [
  tile({ id: "sword", kind: "item", interactions: { item: DEFAULT_WEAPON } }),
  tile({ id: "bag", kind: "item", interactions: { item: DEFAULT_CONTAINER } }),
  tile({
    id: "chest",
    kind: "item",
    interactions: {
      item: { ...DEFAULT_CONTAINER, size: 2, equippable: false },
    },
  }),
  tile({
    id: "cherry",
    kind: "item",
    interactions: { item: DEFAULT_CONSUMABLE },
  }),
  tile({
    id: "mail",
    kind: "item",
    interactions: { item: { type: "armor", def: 4 } },
  }),
  tile({ id: "sign" }),
];
const tilesById = tilesByIdFromList(tiles);

function instance(tileId: string): ItemInstance {
  return { id: `itm_${tileId}`, tileId };
}

function kit(worn: Partial<Equipment> = {}): Equipment {
  return { ...emptyEquipment(), ...worn };
}

const GROUND = { x: 1, y: 0, z: 0, stackIndex: 1 };

describe("itemUseFor", () => {
  it("wields a weapon from wherever it is", () => {
    for (const slot of [
      { kind: "contents", index: 2 } as const,
      { kind: "ground", ref: GROUND, index: 0 } as const,
    ]) {
      expect(itemUseFor(instance("sword"), slot, tilesById, kit())).toEqual({
        type: "move",
        to: { kind: "weapon" },
      });
    }
  });

  it("puts away the weapon already in hand", () => {
    expect(itemUseFor(instance("sword"), { kind: "weapon" }, tilesById, kit())).toEqual({
      type: "move",
      to: { kind: "contents", index: 0 },
    });
  });

  it("wears armour from wherever it is", () => {
    for (const slot of [
      { kind: "contents", index: 2 } as const,
      { kind: "offhand" } as const,
      { kind: "ground", ref: GROUND, index: 0 } as const,
    ]) {
      expect(itemUseFor(instance("mail"), slot, tilesById, kit())).toEqual({
        type: "move",
        to: { kind: "armor" },
      });
    }
  });

  it("takes off what is already worn", () => {
    expect(itemUseFor(instance("mail"), { kind: "armor" }, tilesById, kit())).toEqual({
      type: "move",
      to: { kind: "contents", index: 0 },
    });
  });

  it("opens the bag on your back", () => {
    expect(itemUseFor(instance("bag"), { kind: "bag" }, tilesById, kit())).toEqual({
      type: "open",
    });
  });

  it("opens a pack held in either hand", () => {
    for (const slot of [{ kind: "weapon" } as const, { kind: "offhand" } as const]) {
      expect(itemUseFor(instance("bag"), slot, tilesById, kit())).toEqual({
        type: "open",
      });
    }
  });

  it("does nothing with a container in a slot inside another container", () => {
    expect(
      itemUseFor(instance("chest"), { kind: "ground", ref: GROUND, index: 0 }, tilesById, kit()),
    ).toBeNull();
  });

  it("consumes a consumable from wherever it is", () => {
    for (const slot of [
      { kind: "contents", index: 1 } as const,
      { kind: "ground", ref: GROUND, index: 0 } as const,
    ]) {
      expect(itemUseFor(instance("cherry"), slot, tilesById, kit())).toEqual({
        type: "consume",
      });
    }
  });

  it("does nothing with a thing that is not for anything yet", () => {
    expect(
      itemUseFor(instance("sign"), { kind: "contents", index: 0 }, tilesById, kit()),
    ).toBeNull();
  });

  it("does nothing with a tile that is not in the catalogue", () => {
    expect(
      itemUseFor(instance("ghost"), { kind: "contents", index: 0 }, tilesById, kit()),
    ).toBeNull();
  });
});

describe("a tap on a light", () => {
  const shipped = tilesByIdFromList(normalizeTiles(tilesJson as unknown[]));
  const lantern = { id: "itm_lamp", tileId: "hand-lantern" };
  const amulet = { id: "itm_amulet", tileId: "jade-amulet" };
  const sword = { id: "itm_sword", tileId: "rusty-sword" };

  it("sends a lantern to the accessory square rather than to a hand", () => {
    expect(itemUseFor(lantern, { kind: "contents", index: 0 }, shipped, kit())).toEqual({
      type: "move",
      to: { kind: "charm" },
    });
  });

  it("falls back to the off hand when the accessory square is taken", () => {
    expect(
      itemUseFor(lantern, { kind: "contents", index: 0 }, shipped, kit({ charm: amulet })),
    ).toEqual({ type: "move", to: { kind: "offhand" } });
  });

  it("takes it back off again from either square it belongs in", () => {
    for (const slot of [{ kind: "charm" } as const, { kind: "offhand" } as const]) {
      const kitWithIt = kit({ [slot.kind]: lantern });
      const use = itemUseFor(lantern, slot, shipped, kitWithIt);
      expect(use?.type === "move" && use.to.kind).toBe("contents");
    }
  });

  it("still sends a sword to the hand that swings", () => {
    expect(itemUseFor(sword, { kind: "contents", index: 0 }, shipped, kit())).toEqual({
      type: "move",
      to: { kind: "weapon" },
    });
  });
});

describe("a tap on a second weapon", () => {
  const shipped = tilesByIdFromList(normalizeTiles(tilesJson as unknown[]));
  const bow = { id: "itm_bow", tileId: "simple-bow" };
  const sword = { id: "itm_sword", tileId: "rusty-sword" };

  it("fills the free hand rather than displacing the weapon already held", () => {
    expect(
      itemUseFor(sword, { kind: "contents", index: 1 }, shipped, kit({ weapon: bow })),
    ).toEqual({ type: "move", to: { kind: "offhand" } });
  });

  it("replaces the weapon hand once both hands are full", () => {
    const axe = { id: "itm_axe", tileId: "rusty-sword" };
    expect(
      itemUseFor(
        axe,
        { kind: "contents", index: 2 },
        shipped,
        kit({ weapon: bow, offhand: sword }),
      ),
    ).toEqual({ type: "move", to: { kind: "weapon" } });
  });
});
