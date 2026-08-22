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
  // Something with volume, which is what it takes to bury a thing.
  tile({ id: "crate", height: 1 }),
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
  tile({
    id: "mail",
    kind: "item",
    interactions: { item: { type: "armor", def: 4 } },
  }),
];
const tilesById = tilesByIdFromList(tiles);

const ME = { x: 0, y: 0, z: 0 };

function sword(id: string): ItemInstance {
  return { id, tileId: "sword" };
}

function kit(
  contents: ItemInstance[],
  weapon: ItemInstance | null = null,
  offhand: ItemInstance | null = null,
): Equipment {
  return {
    weapon,
    offhand,
    armor: null,
    bag: { id: "itm_bag", tileId: "bag", contents },
  };
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
      { tileId: "crate" },
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

    // A hand, though, will take one: nesting is about what is *inside* a
    // container, and a pack in your fist is not inside anything.
    expect(
      canMoveItem(emptyMap(), tilesById, ME, holding, { kind: "contents",
index: 0 }, {
        kind: "weapon",
      }),
    ).toBe(true);
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
    const bagless: Equipment = {
      weapon: null,
      offhand: null,
      armor: null,
      bag: null,
    };
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
    // A hand takes anything you can carry, a pack included — so this is the bag
    // coming off your back and into your fist, and the source is left bare.
    expect(moved?.equipment.bag).toBeNull();
    expect(moved?.equipment.weapon?.tileId).toBe("bag");
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
    const bagless: Equipment = { weapon: null, offhand: null,
  armor: null,
  bag: null };
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

/**
 * The body slot.
 *
 * **The one square in the game that refuses a drag**, and these are the tests
 * that keep it that way. Both hands are deliberately generous — a drag is
 * somebody saying exactly what they want, and a hand refusing a thing you could
 * obviously hold is the interface arguing with them — but defence is the whole
 * of what this square contributes to a fight, so a sword worn as a shirt would
 * be a number about nothing.
 */
describe("the armour slot", () => {
  /** Wearing nothing, with a shirt and a sword in the bag to try on. */
  function undressed(): Equipment {
    return {
      weapon: null,
      offhand: null,
      armor: null,
      bag: {
        id: "itm_bag",
        tileId: "bag",
        contents: [
          { id: "itm_mail", tileId: "mail" },
          { id: "itm_sword", tileId: "sword" },
        ],
      },
    };
  }

  const from = (index: number) => ({ kind: "contents", index }) as const;

  it("takes armour out of the bag and puts it on", () => {
    const moved = applyItemMove(
      emptyMap(),
      tilesById,
      ME,
      undressed(),
      from(0),
      { kind: "armor" },
    );
    expect(moved?.equipment.armor?.tileId).toBe("mail");
    expect(moved?.equipment.bag?.contents).toHaveLength(1);
  });

  it("refuses everything that is not armour", () => {
    for (const index of [1]) {
      expect(
        canMoveItem(emptyMap(), tilesById, ME, undressed(), from(index), {
          kind: "armor",
        }),
      ).toBe(false);
    }
    // Including the pack on your own back, which a hand would happily take.
    expect(
      canMoveItem(emptyMap(), tilesById, ME, undressed(), { kind: "bag" }, {
        kind: "armor",
      }),
    ).toBe(false);
  });

  /** A hand is still a hand: you may carry a breastplate without wearing it. */
  it("does not stop a hand holding one", () => {
    const moved = applyItemMove(
      emptyMap(),
      tilesById,
      ME,
      undressed(),
      from(0),
      { kind: "weapon" },
    );
    expect(moved?.equipment.weapon?.tileId).toBe("mail");
  });

  it("takes it off again, exactly as every other square is emptied", () => {
    const dressed: Equipment = {
      ...undressed(),
      armor: { id: "itm_mail", tileId: "mail" },
    };
    const moved = applyItemMove(
      emptyMap(),
      tilesById,
      ME,
      dressed,
      { kind: "armor" },
      { kind: "weapon" },
    );
    expect(moved?.equipment.armor).toBeNull();
    expect(moved?.equipment.weapon?.tileId).toBe("mail");
  });

  it("will not take a second thing while it is occupied", () => {
    const dressed: Equipment = {
      ...undressed(),
      armor: { id: "itm_worn", tileId: "mail" },
    };
    expect(
      canMoveItem(emptyMap(), tilesById, ME, dressed, from(0), {
        kind: "armor",
      }),
    ).toBe(false);
  });

  it("has a key of its own", () => {
    expect(slotKey({ kind: "armor" })).not.toBe(slotKey({ kind: "bag" }));
    expect(slotKey({ kind: "armor" })).not.toBe(slotKey({ kind: "offhand" }));
  });
});

/**
 * A pack held in a hand is a pack, and the squares inside it are squares.
 *
 * The one arm that had to learn there is more than one container on a body:
 * `contents` names *which* now, and absent still means the one on your back.
 * Everything else — the capacity check, the nesting rule, the append — is the
 * same code, which is the whole reason it is one arm and not two.
 */
describe("a container held in a hand", () => {
  /** Wearing a pack, holding a second one in the off hand. */
  function carrying(
    worn: ItemInstance[] = [],
    held: ItemInstance[] = [],
  ): Equipment {
    return {
      weapon: null,
      offhand: { id: "itm_held", tileId: "bag", contents: held },
      armor: null,
      bag: { id: "itm_bag", tileId: "bag", contents: worn },
    };
  }

  const HELD_SLOT = { kind: "contents", index: 0, of: "offhand" } as const;

  it("is where a thing put into it ends up", () => {
    const moved = applyItemMove(
      emptyMap(),
      tilesById,
      ME,
      carrying([sword("itm_a")]),
      { kind: "contents", index: 0 },
      HELD_SLOT,
    );

    expect(moved?.equipment.bag?.contents).toEqual([]);
    expect(moved?.equipment.offhand?.contents?.map((i) => i.tileId)).toEqual([
      "sword",
    ]);
  });

  it("is where a thing taken out of it comes from", () => {
    const moved = applyItemMove(
      emptyMap(),
      tilesById,
      ME,
      carrying([], [sword("itm_a")]),
      HELD_SLOT,
      { kind: "weapon" },
    );

    expect(moved?.equipment.offhand?.contents).toEqual([]);
    expect(moved?.equipment.weapon?.tileId).toBe("sword");
  });

  /** Two squares of one container: there is no reordering, here or anywhere. */
  it("refuses a shuffle within itself", () => {
    expect(
      canMoveItem(
        emptyMap(),
        tilesById,
        ME,
        carrying([], [sword("itm_a"), sword("itm_b")]),
        HELD_SLOT,
        { kind: "contents", index: 1, of: "offhand" },
      ),
    ).toBe(false);
  });

  /** The worn pack and the held one are two containers, so this is a real move. */
  it("is a different container from the one on your back", () => {
    expect(
      canMoveItem(
        emptyMap(),
        tilesById,
        ME,
        carrying([sword("itm_a")]),
        { kind: "contents", index: 0 },
        HELD_SLOT,
      ),
    ).toBe(true);
  });

  it("still refuses a container, because nothing nests", () => {
    const spare: ItemInstance = { id: "itm_spare", tileId: "bag", contents: [] };
    expect(
      canMoveItem(
        emptyMap(),
        tilesById,
        ME,
        { ...carrying(), weapon: spare },
        { kind: "weapon" },
        HELD_SLOT,
      ),
    ).toBe(false);
  });

  it("refuses a slot in a hand holding nothing", () => {
    expect(
      canMoveItem(
        emptyMap(),
        tilesById,
        ME,
        { ...carrying([sword("itm_a")]), offhand: null },
        { kind: "contents", index: 0 },
        HELD_SLOT,
      ),
    ).toBe(false);
  });

  it("keys apart from the same index in the worn pack", () => {
    expect(slotKey(HELD_SLOT)).not.toBe(slotKey({ kind: "contents", index: 0 }));
  });
});
