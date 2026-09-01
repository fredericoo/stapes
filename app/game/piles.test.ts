import { describe, expect, it } from "vitest";
import { DEFAULT_CONTAINER } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { Coord, MapFile, PlacedTile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { emptyEquipment, type Equipment } from "./equipment";
import { GameSession } from "./GameSession";
import type { SlotRef } from "./itemMoves";

/**
 * Several of one thing, as the session moves them about.
 *
 * The arithmetic is `../lib/piles`' own file; this is about the four verbs that
 * meet it — taking a pile off the board, putting one down, spending one of it,
 * and dragging the lot from square to square.
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
    kind: "prop",
    ...partial,
  });
}

/** A pile of at most `pile`, which is the whole of what makes it food. */
function food(id: string, pile: number): TileDef {
  return tile({
    id,
    kind: "item",
    intangible: true,
    interactions: { item: { type: "consumable", label: "Eat", hp: 1, pile } },
  });
}

const BAG_TILE_ID = "basic-bag";
/** Two squares, so "the bag is full" is one line of setup rather than four. */
const BAG_SIZE = 2;

const tiles: TileDef[] = [
  tile({ id: "grass" }),
  tile({
    id: "player",
    height: 2,
    kind: "battler",
    directional: true,
    walkable: false,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
    interactions: {
      battler: {
        masteries: { toughness: 20 },
        naturalWeapon: {
          type: "weapon",
          damage: 1,
          def: 0,
          accuracy: 100,
          variance: 0,
          spd: 50,
          mastery: "fist",
        },
        kit: [{ slot: "bag", tileId: BAG_TILE_ID, chance: 100 }],
      },
    },
  }),
  tile({
    id: BAG_TILE_ID,
    kind: "item",
    intangible: true,
    interactions: { item: { ...DEFAULT_CONTAINER, size: BAG_SIZE } },
  }),
  food("berry", 3),
  food("bread", 3),
  tile({
    id: "sword",
    kind: "item",
    intangible: true,
    interactions: {
      item: {
        type: "weapon",
        damage: 1,
        def: 0,
        accuracy: 100,
        variance: 0,
        spd: 50,
        mastery: "blade",
      },
    },
  }),
];

/** Where the bearer stands, and the tile they can reach. */
const HERE: Coord = { x: 0, y: 0, z: 0 };
const BESIDE: Coord = { x: 1, y: 0, z: 0 };
/** Whose kit these tests are about — never the map's own idle player. */
const WHO = "bearer";
const BAG_SLOT: SlotRef = { kind: "contents", index: 0 };
const SECOND_BAG_SLOT: SlotRef = { kind: "contents", index: 1 };
const OFFHAND: SlotRef = { kind: "offhand" };

/**
 * Open grass, with the map's own player parked well out of the way.
 *
 * The bearer is spawned into it rather than being that player, because a body
 * already on the board keeps whatever kit it arrived with — `spawn` is how a
 * *new* actor is given one, and it does nothing for an id the session already
 * holds. Every test here is about a kit somebody was handed.
 */
function field(): MapFile {
  let map = emptyMap();
  for (let x = -2; x <= 4; x++) {
    for (let y = -2; y <= 2; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  return replaceStack(map, 4, 2, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "s" },
  ]);
}

/** A world with `placed` on the grass beside the player. */
function beside(placed: PlacedTile): MapFile {
  return replaceStack(field(), BESIDE.x, BESIDE.y, BESIDE.z, [
    { tileId: "grass" },
    placed,
  ]);
}

function carrying(contents: ItemInstance[], slots: Partial<Equipment> = {}) {
  return {
    ...emptyEquipment(),
    bag: { id: "itm_bag", tileId: BAG_TILE_ID, contents },
    ...slots,
  };
}

/** A session with the bearer carrying `kit`, and `placed` on the next tile. */
function world(kit: Equipment, placed?: PlacedTile): GameSession {
  const session = new GameSession(placed ? beside(placed) : field(), tiles);
  session.spawn(WHO, { at: { ...HERE, direction: "e" }, carrying: kit });
  return session;
}

function kitOf(session: GameSession): Equipment {
  const kit = session.equipmentOf(WHO);
  if (!kit) throw new Error("the bearer is carrying nothing at all");
  return kit;
}

function bag(session: GameSession): ItemInstance[] {
  return kitOf(session).bag?.contents ?? [];
}

function asideStack(session: GameSession): PlacedTile[] {
  return getStack(session.getMap(), BESIDE.x, BESIDE.y, BESIDE.z);
}

/** The thing lying beside the player, as something to act on. */
const ASIDE = { ...BESIDE, stackIndex: 1 };

describe("picking a pile up", () => {
  it("joins a pile already in the bag rather than taking a second square", () => {
    const session = world(
      carrying([{ id: "itm_a", tileId: "berry" }]),
      { tileId: "berry", itemId: "itm_b" },
    );

    expect(session.pickUp(ASIDE, WHO)).toBe(true);
    expect(bag(session)).toEqual([{ id: "itm_a", tileId: "berry", count: 2 }]);
  });

  it("takes the whole pile off the board in one go", () => {
    const session = world(carrying([]), {
      tileId: "berry",
      itemId: "itm_b",
      count: 3,
    });

    expect(session.pickUp(ASIDE, WHO)).toBe(true);
    expect(bag(session)).toEqual([{ id: "itm_b", tileId: "berry", count: 3 }]);
    expect(asideStack(session)).toEqual([{ tileId: "grass" }]);
  });

  it("goes into a full bag, when a pile in it has room", () => {
    const session = world(
      carrying([
        { id: "itm_a", tileId: "berry" },
        { id: "itm_c", tileId: "sword" },
      ]),
      { tileId: "berry", itemId: "itm_b" },
    );

    // Two squares, both taken — and the berry still goes in, because the row is
    // offered on whether it *lands*, not on whether a square is free.
    expect(session.canPickUp(ASIDE, WHO)).toBe(true);
    expect(session.pickUp(ASIDE, WHO)).toBe(true);
    expect(bag(session)).toEqual([
      { id: "itm_a", tileId: "berry", count: 2 },
      { id: "itm_c", tileId: "sword" },
    ]);
  });

  it("starts a second pile once the first is at its ceiling", () => {
    const session = world(
      carrying([{ id: "itm_a", tileId: "berry", count: 3 }]),
      { tileId: "berry", itemId: "itm_b" },
    );

    expect(session.pickUp(ASIDE, WHO)).toBe(true);
    expect(bag(session)).toEqual([
      { id: "itm_a", tileId: "berry", count: 3 },
      { id: "itm_b", tileId: "berry" },
    ]);
  });

  it("leaves the pile where it is when neither a pour nor a square will have it", () => {
    const session = world(
      carrying([
        { id: "itm_a", tileId: "berry", count: 3 },
        { id: "itm_c", tileId: "sword" },
      ]),
      { tileId: "berry", itemId: "itm_b", count: 2 },
    );

    // A hand would take it — that is the row the pickup falls through to — so
    // this asserts only that the bag did not, which is the pile rule.
    expect(session.pickUp(ASIDE, WHO)).toBe(true);
    expect(bag(session)).toHaveLength(2);
    expect(kitOf(session).offhand).toEqual({
      id: "itm_b",
      tileId: "berry",
      count: 2,
    });
  });
});

describe("putting a pile down", () => {
  it("lands as one placement, whole", () => {
    const session = world(
      carrying([{ id: "itm_a", tileId: "berry", count: 3 }]),
    );

    expect(session.drop(BAG_SLOT, BESIDE, WHO)).toBe(true);
    expect(asideStack(session)).toEqual([
      { tileId: "grass" },
      { tileId: "berry", itemId: "itm_a", count: 3 },
    ]);
    expect(bag(session)).toEqual([]);
  });

  it("joins a pile already lying on that tile", () => {
    const session = world(carrying([{ id: "itm_a", tileId: "berry" }]), {
      tileId: "berry",
      itemId: "itm_b",
    });

    expect(session.drop(BAG_SLOT, BESIDE, WHO)).toBe(true);
    // Two berries on a tile are two berries in the same tile, not two things
    // standing on each other.
    expect(asideStack(session)).toEqual([
      { tileId: "grass" },
      { tileId: "berry", itemId: "itm_b", count: 2 },
    ]);
  });

  it("stands beside a pile that is already at its ceiling", () => {
    const session = world(carrying([{ id: "itm_a", tileId: "berry" }]), {
      tileId: "berry",
      itemId: "itm_b",
      count: 3,
    });

    expect(session.drop(BAG_SLOT, BESIDE, WHO)).toBe(true);
    expect(asideStack(session)).toEqual([
      { tileId: "grass" },
      { tileId: "berry", itemId: "itm_b", count: 3 },
      { tileId: "berry", itemId: "itm_a" },
    ]);
  });
});

describe("summoning one with /tile", () => {
  it("pours into a pile already in that cell, like a drop", () => {
    const session = world(carrying([]), {
      tileId: "berry",
      itemId: "itm_b",
      count: 2,
    });

    session.runCommand("/tile berry +1", WHO);
    const stack = asideStack(session);
    expect(stack).toHaveLength(2);
    expect(stack[1]).toEqual({
      tileId: "berry",
      itemId: "itm_b",
      count: 3,
    });
  });

  it("starts a second placement once that pile is at its ceiling", () => {
    const session = world(carrying([]), {
      tileId: "berry",
      itemId: "itm_b",
      count: 3,
    });

    session.runCommand("/tile berry +1", WHO);
    const stack = asideStack(session);
    expect(stack).toHaveLength(3);
    expect(stack[1]?.count).toBe(3);
    expect(stack[2]?.tileId).toBe("berry");
    expect(stack[2]?.count).toBeUndefined();
  });

  it("still places a thing that does not pile beside its own kind", () => {
    const session = world(carrying([]), { tileId: "sword", itemId: "itm_s" });

    session.runCommand("/tile sword +1", WHO);
    expect(asideStack(session).map((p) => p.tileId)).toEqual([
      "grass",
      "sword",
      "sword",
    ]);
  });
});

describe("spending one of a pile", () => {
  it("eats one out of a pile in the bag and leaves the rest", () => {
    const session = world(
      carrying([{ id: "itm_a", tileId: "berry", count: 3 }]),
    );

    expect(session.consume({ kind: "slot", slot: BAG_SLOT }, WHO)).toBe(true);
    expect(bag(session)).toEqual([
      { id: "itm_a", tileId: "berry", count: 2 },
    ]);
  });

  it("empties the square on the last of it", () => {
    const session = world(carrying([{ id: "itm_a", tileId: "berry" }]));

    expect(session.consume({ kind: "slot", slot: BAG_SLOT }, WHO)).toBe(true);
    expect(bag(session)).toEqual([]);
  });

  it("eats one off a pile on the floor and leaves the placement", () => {
    const session = world(carrying([]), {
      tileId: "berry",
      itemId: "itm_b",
      count: 2,
    });

    expect(session.consume({ kind: "floor", ref: ASIDE }, WHO)).toBe(true);
    expect(asideStack(session)).toEqual([
      { tileId: "grass" },
      { tileId: "berry", itemId: "itm_b" },
    ]);
  });
});

describe("dragging a pile between squares", () => {
  it("moves the whole pile", () => {
    const session = world(
      carrying([{ id: "itm_a", tileId: "berry", count: 3 }]),
    );

    expect(session.moveItem(BAG_SLOT, OFFHAND, WHO)).toBe(true);
    expect(kitOf(session).offhand).toEqual({
      id: "itm_a",
      tileId: "berry",
      count: 3,
    });
    expect(bag(session)).toEqual([]);
  });

  it("pours onto a hand already holding the same food", () => {
    const session = world(
      carrying([{ id: "itm_a", tileId: "berry" }], {
        offhand: { id: "itm_b", tileId: "berry" },
      }),
    );

    expect(session.canMoveItem(BAG_SLOT, OFFHAND, WHO)).toBe(true);
    expect(session.moveItem(BAG_SLOT, OFFHAND, WHO)).toBe(true);
    // The square that received keeps its identity; the one that arrived is gone
    // as surely as if it had been drunk.
    expect(kitOf(session).offhand).toEqual({
      id: "itm_b",
      tileId: "berry",
      count: 2,
    });
    expect(bag(session)).toEqual([]);
  });

  it("refuses a hand holding something the pile cannot join", () => {
    const session = world(
      carrying([{ id: "itm_a", tileId: "berry" }], {
        offhand: { id: "itm_c", tileId: "bread" },
      }),
    );

    expect(session.canMoveItem(BAG_SLOT, OFFHAND, WHO)).toBe(false);
  });

  it("refuses a hand whose pile has no room for all of it", () => {
    const session = world(
      carrying([{ id: "itm_a", tileId: "berry", count: 2 }], {
        offhand: { id: "itm_b", tileId: "berry", count: 2 },
      }),
    );

    // Two and two is four against a ceiling of three. One would fit and that is
    // not on offer: a move lands whole or is refused.
    expect(session.canMoveItem(BAG_SLOT, OFFHAND, WHO)).toBe(false);
  });

  it("pours into a full bag out of a hand", () => {
    const session = world(
      carrying(
        [
          { id: "itm_a", tileId: "berry" },
          { id: "itm_c", tileId: "sword" },
        ],
        { offhand: { id: "itm_b", tileId: "berry" } },
      ),
    );

    expect(session.moveItem(OFFHAND, SECOND_BAG_SLOT, WHO)).toBe(true);
    expect(bag(session)).toEqual([
      { id: "itm_a", tileId: "berry", count: 2 },
      { id: "itm_c", tileId: "sword" },
    ]);
    expect(kitOf(session).offhand).toBeNull();
  });
});
