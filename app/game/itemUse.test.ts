import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONSUMABLE,
  DEFAULT_CONTAINER,
  DEFAULT_WEAPON,
} from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import type { TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { itemUseFor } from "./itemUse";
import tilesJson from "../../data/tiles.json";
import { normalizeTiles } from "../lib/types";

/**
 * What a tap on a carried thing does.
 *
 * The rule worth pinning is the one the interface is built on: a tap never
 * asks "where does this go", it asks what the thing is *for*. So every case
 * here is about the item's own kind, and the slot only ever decides which way
 * round the answer runs.
 */

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

const GROUND = { x: 1, y: 0, z: 0, stackIndex: 1 };

describe("itemUseFor", () => {
  it("wields a weapon from wherever it is", () => {
    for (const slot of [
      { kind: "contents", index: 2 } as const,
      { kind: "ground", ref: GROUND, index: 0 } as const,
    ]) {
      expect(itemUseFor(instance("sword"), slot, tilesById)).toEqual({
        type: "move",
        to: { kind: "weapon" },
      });
    }
  });

  it("puts away the weapon already in hand", () => {
    expect(
      itemUseFor(instance("sword"), { kind: "weapon" }, tilesById),
    ).toEqual({ type: "move", to: { kind: "contents", index: 0 } });
  });

  it("wears armour from wherever it is", () => {
    for (const slot of [
      { kind: "contents", index: 2 } as const,
      { kind: "offhand" } as const,
      { kind: "ground", ref: GROUND, index: 0 } as const,
    ]) {
      expect(itemUseFor(instance("mail"), slot, tilesById)).toEqual({
        type: "move",
        to: { kind: "armor" },
      });
    }
  });

  it("takes off what is already worn", () => {
    expect(itemUseFor(instance("mail"), { kind: "armor" }, tilesById)).toEqual({
      type: "move",
      to: { kind: "contents", index: 0 },
    });
  });

  it("opens the bag on your back", () => {
    expect(itemUseFor(instance("bag"), { kind: "bag" }, tilesById)).toEqual({
      type: "open",
    });
  });

  /**
   * The reason a hand may hold one at all: a pack you could carry but never
   * look into would be a worse place to keep things than the floor.
   */
  it("opens a pack held in either hand", () => {
    for (const slot of [{ kind: "weapon" } as const, { kind: "offhand" } as const]) {
      expect(itemUseFor(instance("bag"), slot, tilesById)).toEqual({
        type: "open",
      });
    }
  });

  // No container may hold a container, so the squares on a body are the only
  // ones in the game a container can be sitting in. A ground endpoint names a
  // slot *inside* a box, and nothing that goes there is one.
  it("does nothing with a container in a slot inside another container", () => {
    expect(
      itemUseFor(
        instance("chest"),
        { kind: "ground", ref: GROUND, index: 0 },
        tilesById,
      ),
    ).toBeNull();
  });

  // The case this module said it was waiting to gain: a consumable is for
  // being eaten, from any square it can be sitting in.
  it("consumes a consumable from wherever it is", () => {
    for (const slot of [
      { kind: "contents", index: 1 } as const,
      { kind: "ground", ref: GROUND, index: 0 } as const,
    ]) {
      expect(itemUseFor(instance("cherry"), slot, tilesById)).toEqual({
        type: "consume",
      });
    }
  });

  it("does nothing with a thing that is not for anything yet", () => {
    expect(
      itemUseFor(instance("sign"), { kind: "contents", index: 0 }, tilesById),
    ).toBeNull();
  });

  it("does nothing with a tile that is not in the catalogue", () => {
    expect(
      itemUseFor(instance("ghost"), { kind: "contents", index: 0 }, tilesById),
    ).toBeNull();
  });
});

/**
 * A light goes to the other hand.
 *
 * Checked before the weapon rule rather than after it, because a lantern *is* a
 * weapon as far as the catalogue is concerned — it had to be, when the swinging
 * hand was the only hand there was. Tapping one is a request to see in the dark
 * and never a request to fight with it, and getting that order wrong is how the
 * off hand would ship and change nothing anybody noticed.
 */
describe("a tap on a light", () => {
  const shipped = tilesByIdFromList(normalizeTiles(tilesJson as unknown[]));
  const lantern = { id: "itm_lamp", tileId: "hand-lantern" };
  const sword = { id: "itm_sword", tileId: "rusty-sword" };

  it("sends a lantern to the off hand rather than the weapon hand", () => {
    expect(itemUseFor(lantern, { kind: "contents", index: 0 }, shipped)).toEqual({
      type: "move",
      to: { kind: "offhand" },
    });
  });

  it("takes it back off again when it is already held", () => {
    const use = itemUseFor(lantern, { kind: "offhand" }, shipped);
    expect(use?.type === "move" && use.to.kind).toBe("contents");
  });

  it("still sends a sword to the hand that swings", () => {
    expect(itemUseFor(sword, { kind: "contents", index: 0 }, shipped)).toEqual({
      type: "move",
      to: { kind: "weapon" },
    });
  });
});
