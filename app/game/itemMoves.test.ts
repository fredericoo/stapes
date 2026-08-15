import { describe, expect, it } from "vitest";
import { DEFAULT_CONTAINER, DEFAULT_WEAPON } from "../lib/item";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { ItemInstance } from "../lib/itemInstance";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import type { ObjectRef } from "./affordances";
import type { Equipment } from "./equipment";
import { applyItemMove, canMoveItem, slotIn, slotKey } from "./itemMoves";

/**
 * Moving one thing from a slot to a slot.
 *
 * The rules worth pinning are the ones no direction may leak past: a container
 * never ends up inside another, the weapon slot takes weapons and nothing else,
 * and a ground endpoint is re-reached every single time — the panel that named
 * it may have been open while its owner walked away.
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
  tile({ id: "grass" }),
  tile({ id: "sword", kind: "item", interactions: { item: DEFAULT_WEAPON } }),
  tile({ id: "sign" }),
  tile({ id: "bag", kind: "item", interactions: { item: DEFAULT_CONTAINER } }),
  tile({
    id: "chest",
    kind: "item",
    interactions: {
      item: { ...DEFAULT_CONTAINER, size: 2, equippable: false },
    },
  }),
];
const tilesById = tilesByIdFromList(tiles);

const ME = { x: 0, y: 0, z: 0 };

function sword(id: string): ItemInstance {
  return { id, tileId: "sword" };
}

function kit(contents: ItemInstance[], weapon: ItemInstance | null = null): Equipment {
  return { weapon, bag: { id: "itm_bag", tileId: "bag", contents } };
}

/** A chest one cell east, holding whatever it is given. */
function chestAt(
  x: number,
  contents: ItemInstance[] = [],
  tileId = "chest",
): { map: MapFile; ref: ObjectRef } {
  const map = replaceStack(emptyMap(), x, 0, 0, [
    { tileId: "grass" },
    { tileId, itemId: "itm_chest", contents },
  ]);
  return { map, ref: { x, y: 0, z: 0, stackIndex: 1 } };
}

function groundContents(map: MapFile, ref: ObjectRef): ItemInstance[] {
  return getStack(map, ref.x, ref.y, ref.z)[ref.stackIndex]?.contents ?? [];
}

describe("slotKey", () => {
  it("tells two slots in one container apart, and two containers apart", () => {
    const here: ObjectRef = { x: 1, y: 0, z: 0, stackIndex: 1 };
    const there: ObjectRef = { x: 2, y: 0, z: 0, stackIndex: 1 };
    const keys = [
      slotKey({ kind: "weapon" }),
      slotKey({ kind: "contents",
index: 0 }),
      slotKey({ kind: "contents",
index: 1 }),
      slotKey({ kind: "ground", ref: here, index: 0 }),
      slotKey({ kind: "ground", ref: there, index: 0 }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives one slot the same key twice", () => {
    const ref: ObjectRef = { x: 1, y: 0, z: 0, stackIndex: 1 };
    expect(slotKey(slotIn({ kind: "ground", ref }, 1))).toBe(
      slotKey({ kind: "ground", ref, index: 1 }),
    );
  });
});

describe("equipping and unequipping", () => {
  it("takes a weapon out of the bag and into the hand", () => {
    const moved = applyItemMove(
      emptyMap(),
      tilesById,
      ME,
      kit([sword("itm_a")]),
      { kind: "contents",
index: 0 },
      { kind: "weapon" },
    );
    expect(moved?.equipment.weapon).toEqual(sword("itm_a"));
    expect(moved?.equipment.bag?.contents).toEqual([]);
  });

  it("puts it back, which is the same operation the other way round", () => {
    const moved = applyItemMove(
      emptyMap(),
      tilesById,
      ME,
      kit([], sword("itm_a")),
      { kind: "weapon" },
      { kind: "contents",
index: 0 },
    );
    expect(moved?.equipment.weapon).toBeNull();
    expect(moved?.equipment.bag?.contents).toEqual([sword("itm_a")]);
  });

  it("refuses a second weapon while one is in hand", () => {
    const held = kit([sword("itm_a")], sword("itm_b"));
    expect(
      canMoveItem(
        emptyMap(),
        tilesById,
        ME,
        held,
        { kind: "contents",
index: 0 },
        { kind: "weapon" },
      ),
    ).toBe(false);
  });

  it("refuses to put something that is not a weapon in the hand", () => {
    const held = kit([{ id: "itm_sign", tileId: "sign" }]);
    expect(
      canMoveItem(
        emptyMap(),
        tilesById,
        ME,
        held,
        { kind: "contents",
index: 0 },
        { kind: "weapon" },
      ),
    ).toBe(false);
  });

  it("refuses to move a slot onto itself, and any move inside one bag", () => {
    const held = kit([sword("itm_a"), sword("itm_b")]);
    expect(
      canMoveItem(emptyMap(), tilesById, ME, held, { kind: "contents",
index: 0 }, {
        kind: "contents",
index: 1,
      }),
    ).toBe(false);
    expect(
      canMoveItem(emptyMap(), tilesById, ME, held, { kind: "weapon" }, {
        kind: "weapon",
      }),
    ).toBe(false);
  });

  it("refuses to move an empty slot", () => {
    expect(
      canMoveItem(emptyMap(), tilesById, ME, kit([]), { kind: "contents",
index: 0 }, {
        kind: "weapon",
      }),
    ).toBe(false);
  });

  it("leaves no hole behind when the middle of a bag is emptied", () => {
    const held = kit([sword("itm_a"), sword("itm_b"), sword("itm_c")]);
    const moved = applyItemMove(
      emptyMap(),
      tilesById,
      ME,
      held,
      { kind: "contents",
index: 1 },
      { kind: "weapon" },
    );
    expect(moved?.equipment.bag?.contents).toEqual([
      sword("itm_a"),
      sword("itm_c"),
    ]);
  });
});

describe("looting and stashing", () => {
  it("takes a thing out of a chest on the floor and into the bag", () => {
    const { map, ref } = chestAt(1, [sword("itm_a")]);
    const moved = applyItemMove(
      map,
      tilesById,
      ME,
      kit([]),
      { kind: "ground", ref, index: 0 },
      { kind: "contents",
index: 0 },
    );
    expect(moved?.equipment.bag?.contents).toEqual([sword("itm_a")]);
    expect(groundContents(moved!.map, ref)).toEqual([]);
  });

  it("puts one back, and the chest keeps its own identity", () => {
    const { map, ref } = chestAt(1);
    const moved = applyItemMove(
      map,
      tilesById,
      ME,
      kit([sword("itm_a")]),
      { kind: "contents",
index: 0 },
      { kind: "ground", ref, index: 0 },
    );
    expect(groundContents(moved!.map, ref)).toEqual([sword("itm_a")]);
    expect(moved?.equipment.bag?.contents).toEqual([]);
    const placed = getStack(moved!.map, ref.x, ref.y, ref.z)[ref.stackIndex];
    expect(placed?.itemId).toBe("itm_chest");
  });

  it("refuses a chest out of reach, however open the panel is", () => {
    const { map, ref } = chestAt(4, [sword("itm_a")]);
    expect(
      canMoveItem(map, tilesById, ME, kit([]), { kind: "ground", ref, index: 0 }, {
        kind: "contents",
index: 0,
      }),
    ).toBe(false);
  });

  it("refuses to stash into a chest out of reach", () => {
    const { map, ref } = chestAt(4);
    expect(
      canMoveItem(map, tilesById, ME, kit([sword("itm_a")]), {
        kind: "contents",
index: 0,
      }, { kind: "ground", ref, index: 0 }),
    ).toBe(false);
  });

  it("refuses a chest buried under something else", () => {
    const buried = replaceStack(emptyMap(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "chest", itemId: "itm_chest", contents: [sword("itm_a")] },
      { tileId: "grass" },
    ]);
    const ref: ObjectRef = { x: 1, y: 0, z: 0, stackIndex: 1 };
    expect(
      canMoveItem(buried, tilesById, ME, kit([]), { kind: "ground", ref, index: 0 }, {
        kind: "contents",
index: 0,
      }),
    ).toBe(false);
  });

  it("refuses a full chest and a full bag alike", () => {
    const full = chestAt(1, [sword("itm_a"), sword("itm_b")]);
    expect(
      canMoveItem(full.map, tilesById, ME, kit([sword("itm_c")]), {
        kind: "contents",
index: 0,
      }, { kind: "ground", ref: full.ref, index: 0 }),
    ).toBe(false);

    const brimming = Array.from({ length: DEFAULT_CONTAINER.size }, (_, i) =>
      sword(`itm_${i}`),
    );
    const { map, ref } = chestAt(1, [sword("itm_loot")]);
    expect(
      canMoveItem(map, tilesById, ME, kit(brimming), {
        kind: "ground",
        ref,
        index: 0,
      }, { kind: "contents",
index: 0 }),
    ).toBe(false);
  });

  it("moves between two chests, each reached in its own right", () => {
    const near = chestAt(1, [sword("itm_a")]);
    const far: ObjectRef = { x: -1, y: 0, z: 0, stackIndex: 1 };
    const map = replaceStack(near.map, -1, 0, 0, [
      { tileId: "grass" },
      { tileId: "chest", itemId: "itm_other", contents: [] },
    ]);
    const moved = applyItemMove(
      map,
      tilesById,
      ME,
      kit([]),
      { kind: "ground", ref: near.ref, index: 0 },
      { kind: "ground", ref: far, index: 0 },
    );
    expect(groundContents(moved!.map, near.ref)).toEqual([]);
    expect(groundContents(moved!.map, far)).toEqual([sword("itm_a")]);
  });

  it("refuses a move inside one chest", () => {
    const { map, ref } = chestAt(1, [sword("itm_a")]);
    expect(
      canMoveItem(map, tilesById, ME, kit([]), { kind: "ground", ref, index: 0 }, {
        kind: "ground",
        ref,
        index: 1,
      }),
    ).toBe(false);
  });

  it("refuses a slot index past the end of a container", () => {
    const { map, ref } = chestAt(1, [sword("itm_a")]);
    expect(
      canMoveItem(map, tilesById, ME, kit([]), { kind: "ground", ref, index: 7 }, {
        kind: "contents",
index: 0,
      }),
    ).toBe(false);
    expect(
      canMoveItem(map, tilesById, ME, kit([sword("itm_a")]), {
        kind: "contents",
index: 7,
      }, { kind: "ground", ref, index: 0 }),
    ).toBe(false);
  });
});

describe("containers do not nest", () => {
  /**
   * Every direction a container could get into another one, asked one at a time.
   * The rule lives in a single gate precisely so this list can be exhaustive
   * rather than hopeful.
   */
  it("refuses a bag into a bag, a bag into a chest, and a chest into a bag", () => {
    const spare: ItemInstance = { id: "itm_spare", tileId: "bag", contents: [] };
    const { map, ref } = chestAt(1, [spare]);

    // Chest → bag: a spare backpack may not be pocketed.
    expect(
      canMoveItem(map, tilesById, ME, kit([]), { kind: "ground", ref, index: 0 }, {
        kind: "contents",
index: 0,
      }),
    ).toBe(false);

    // Bag → chest: nor stashed in a box on the floor.
    const holding = kit([spare]);
    expect(
      canMoveItem(chestAt(1).map, tilesById, ME, holding, {
        kind: "contents",
index: 0,
      }, { kind: "ground", ref, index: 0 }),
    ).toBe(false);

    // Nor worn in the hand, which the weapon gate refuses for its own reason.
    expect(
      canMoveItem(emptyMap(), tilesById, ME, holding, { kind: "contents",
index: 0 }, {
        kind: "weapon",
      }),
    ).toBe(false);
  });
});

describe("what a move leaves alone", () => {
  it("does not touch the board when both ends are on the body", () => {
    const map = chestAt(1).map;
    const moved = applyItemMove(
      map,
      tilesById,
      ME,
      kit([sword("itm_a")]),
      { kind: "contents",
index: 0 },
      { kind: "weapon" },
    );
    expect(moved?.map).toBe(map);
  });

  it("does not touch the kit when both ends are on the floor", () => {
    const near = chestAt(1, [sword("itm_a")]);
    const map = replaceStack(near.map, -1, 0, 0, [
      { tileId: "grass" },
      { tileId: "chest", itemId: "itm_other", contents: [] },
    ]);
    const equipment = kit([]);
    const moved = applyItemMove(
      map,
      tilesById,
      ME,
      equipment,
      { kind: "ground", ref: near.ref, index: 0 },
      { kind: "ground", ref: { x: -1, y: 0, z: 0, stackIndex: 1 }, index: 0 },
    );
    expect(moved?.equipment).toBe(equipment);
  });

  it("keeps everything an instance was carrying across the move", () => {
    const lever: ItemInstance = {
      id: "itm_lever",
      tileId: "sword",
      direction: "n",
      channel: "gate",
      description: "the one from the tower",
    };
    const { map, ref } = chestAt(1, [lever]);
    const moved = applyItemMove(
      map,
      tilesById,
      ME,
      kit([]),
      { kind: "ground", ref, index: 0 },
      { kind: "contents",
index: 0 },
    );
    expect(moved?.equipment.bag?.contents?.[0]).toEqual(lever);
  });

  it("refuses to loot a thing that is not a container at all", () => {
    const { map, ref } = chestAt(1, [sword("itm_a")], "sword");
    expect(
      canMoveItem(map, tilesById, ME, kit([]), { kind: "ground", ref, index: 0 }, {
        kind: "contents",
index: 0,
      }),
    ).toBe(false);
  });

  it("refuses everything when there is no bag on your back", () => {
    const bagless: Equipment = { weapon: null, bag: null };
    const { map, ref } = chestAt(1, [sword("itm_a")]);
    expect(
      canMoveItem(map, tilesById, ME, bagless, { kind: "ground", ref, index: 0 }, {
        kind: "contents",
index: 0,
      }),
    ).toBe(false);
  });
});

/**
 * The bag is a thing you wear, so it has a slot like anything else worn — and
 * taking it off is the same gesture as taking a sword out of your hand.
 */
describe("the bag slot", () => {
  it("is where the bag is read from", () => {
    const held = kit([]);
    const moved = applyItemMove(
      emptyMap(),
      tilesById,
      ME,
      held,
      { kind: "bag" },
      { kind: "weapon" },
    );
    // Refused, since a bag is not a weapon — but the source was found, which is
    // the half this pins. The other half is `drop`.
    expect(moved).toBeNull();
    expect(held.bag).not.toBeNull();
  });

  it("refuses to take a container off into its own contents", () => {
    expect(
      canMoveItem(emptyMap(), tilesById, ME, kit([]), { kind: "bag" }, {
        kind: "contents",
        index: 0,
      }),
    ).toBe(false);
  });

  it("refuses to stash the bag in a chest, which would nest containers", () => {
    const { map, ref } = chestAt(1);
    expect(
      canMoveItem(map, tilesById, ME, kit([]), { kind: "bag" }, {
        kind: "ground",
        ref,
        index: 0,
      }),
    ).toBe(false);
  });

  it("is empty, and refuses everything, on a bare back", () => {
    const bagless: Equipment = { weapon: null, bag: null };
    expect(
      canMoveItem(emptyMap(), tilesById, ME, bagless, { kind: "bag" }, {
        kind: "weapon",
      }),
    ).toBe(false);
  });

  it("has a key of its own, distinct from the slots inside it", () => {
    expect(slotKey({ kind: "bag" })).not.toBe(
      slotKey({ kind: "contents", index: 0 }),
    );
  });
});
