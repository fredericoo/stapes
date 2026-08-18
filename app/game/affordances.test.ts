import { describe, expect, it } from "vitest";
import { DEFAULT_CONTAINER, DEFAULT_WEAPON } from "../lib/item";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import {
  canDropAt,
  canOpenFrom,
  canPickUpFrom,
  pickUpDestination,
  REACH_CELLS,
  withinReach,
  type ObjectRef,
} from "./affordances";
import type { Equipment } from "./equipment";
import { emptyEquipment } from "./equipment";

/**
 * Reaching for things.
 *
 * The geometry above all: pick-up and open share a round radius that is
 * deliberately not the orthogonal-adjacent rule a push uses, and the difference
 * is the whole reason these are separate functions.
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
  tile({ id: "rock", height: 1 }),
  // Full height and light-blocking, so it stops a line of sight — see `./sight`,
  // where sight is light and you see over anything shorter than a level.
  tile({ id: "wall", height: 2 }),
  tile({ id: "sword", kind: "item", interactions: { item: DEFAULT_WEAPON } }),
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

const KIT: Equipment = {
  weapon: null,
  offhand: null,
  bag: { id: "itm_bag", tileId: "bag", contents: [] },
};
const FULL_KIT: Equipment = {
  weapon: null,
  offhand: null,
  bag: {
    id: "itm_bag",
    tileId: "bag",
    contents: Array.from({ length: DEFAULT_CONTAINER.size }, (_, i) => ({
      id: `itm_${i}`,
      tileId: "sword",
    })),
  },
};

const ME = { x: 0, y: 0, z: 0 };

function mapWith(x: number, y: number, tileId: string, z = 0): MapFile {
  return replaceStack(emptyMap(), x, y, z, [
    { tileId: "grass" },
    { tileId, itemId: "itm_target" },
  ]);
}

function ref(x: number, y: number, z = 0, stackIndex = 1): ObjectRef {
  return { x, y, z, stackIndex };
}

describe("withinReach", () => {
  it("takes the eight neighbours and the cell you are standing in", () => {
    const inReach: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ];
    for (const [x, y] of inReach) {
      expect(withinReach(ME, ref(x, y))).toBe(true);
    }
  });

  it("stops short of two cells, straight or diagonal", () => {
    const outOfReach: Array<[number, number]> = [
      [2, 0],
      [0, 2],
      [2, 1],
      [2, 2],
      [-2, 0],
    ];
    for (const [x, y] of outOfReach) {
      expect(withinReach(ME, ref(x, y))).toBe(false);
    }
  });

  /** A diagonal is √2 ≈ 1.41 away, which is what 1.5 is chosen to include. */
  it("is a circle, not a square of side 1.5", () => {
    expect(REACH_CELLS).toBeGreaterThan(Math.SQRT2);
    expect(REACH_CELLS).toBeLessThan(2);
  });

  it("reaches one floor up and down, and no further", () => {
    expect(withinReach(ME, ref(1, 0, 1))).toBe(true);
    expect(withinReach(ME, ref(1, 0, -1))).toBe(true);
    expect(withinReach(ME, ref(1, 0, 2))).toBe(false);
  });
});

describe("pickUpDestination", () => {
  it("puts an ordinary item in the bag", () => {
    const map = mapWith(1, 0, "sword");
    expect(pickUpDestination(map, tilesById, ME, ref(1, 0), KIT)).toBe(
      "contents",
    );
  });

  it("puts a wearable bag on a bare back", () => {
    const map = mapWith(1, 0, "bag");
    expect(
      pickUpDestination(map, tilesById, ME, ref(1, 0), emptyEquipment()),
    ).toBe("bag-slot");
  });

  /** Containers do not nest: a bag never goes inside a bag. */
  it("refuses a bag when one is already worn, however much room is inside it", () => {
    const map = mapWith(1, 0, "bag");
    expect(pickUpDestination(map, tilesById, ME, ref(1, 0), KIT)).toBeNull();
  });

  it("never takes a chest, which is looted where it lies", () => {
    const map = mapWith(1, 0, "chest");
    expect(
      pickUpDestination(map, tilesById, ME, ref(1, 0), emptyEquipment()),
    ).toBeNull();
  });

  it("refuses an ordinary item with no bag to put it in", () => {
    const map = mapWith(1, 0, "sword");
    expect(
      pickUpDestination(map, tilesById, ME, ref(1, 0), emptyEquipment()),
    ).toBeNull();
  });

  it("refuses an ordinary item once the bag is full", () => {
    const map = mapWith(1, 0, "sword");
    expect(pickUpDestination(map, tilesById, ME, ref(1, 0), FULL_KIT)).toBeNull();
  });

  it("refuses a tile that is not an item", () => {
    const map = mapWith(1, 0, "rock");
    expect(pickUpDestination(map, tilesById, ME, ref(1, 0), KIT)).toBeNull();
  });

  it("refuses something buried under another tile", () => {
    const map = replaceStack(emptyMap(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "sword", itemId: "itm_buried" },
      { tileId: "rock" },
    ]);
    expect(canPickUpFrom(map, tilesById, ME, ref(1, 0), KIT)).toBe(false);
  });

  it("refuses an empty cell", () => {
    expect(
      pickUpDestination(emptyMap(), tilesById, ME, ref(1, 0), KIT),
    ).toBeNull();
  });
});

describe("canOpenFrom", () => {
  it("opens a bag in reach", () => {
    expect(canOpenFrom(mapWith(1, 0, "bag"), tilesById, ME, ref(1, 0))).toBe(
      true,
    );
  });

  it("opens a chest in reach", () => {
    expect(canOpenFrom(mapWith(1, 0, "chest"), tilesById, ME, ref(1, 0))).toBe(
      true,
    );
  });

  /**
   * Opening is looking, and looking costs nothing — so unlike pick-up it asks
   * nothing at all about what the player is already carrying.
   */
  it("opens a bag even with one already worn and a full pack", () => {
    const map = mapWith(1, 0, "bag");
    expect(canOpenFrom(map, tilesById, ME, ref(1, 0))).toBe(true);
    expect(canPickUpFrom(map, tilesById, ME, ref(1, 0), FULL_KIT)).toBe(false);
  });

  it("does not open a weapon", () => {
    expect(canOpenFrom(mapWith(1, 0, "sword"), tilesById, ME, ref(1, 0))).toBe(
      false,
    );
  });

  it("does not open something out of reach", () => {
    expect(canOpenFrom(mapWith(2, 0, "chest"), tilesById, ME, ref(2, 0))).toBe(
      false,
    );
  });

  it("reaches a chest on the diagonal", () => {
    expect(canOpenFrom(mapWith(1, 1, "chest"), tilesById, ME, ref(1, 1))).toBe(
      true,
    );
  });
});

/**
 * What counts as being buried.
 *
 * The round reach takes in the cell the actor is standing in, so the commonest
 * thing on top of a reachable item is the actor's own body — and a rule that
 * counted that as cover would make the most obvious case in the game
 * impossible.
 */
describe("a body is not a lid", () => {
  function under(tileId: string, above: string[]): MapFile {
    return replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId, itemId: "itm_target" },
      ...above.map((t) => ({ tileId: t, owner: "somebody" })),
    ]);
  }

  it("picks up a sword from under your own feet", () => {
    expect(
      pickUpDestination(under("sword", ["rock"]), tilesById, ME, ref(0, 0), KIT),
    ).toBe("contents");
  });

  it("opens a chest you are standing on", () => {
    expect(canOpenFrom(under("chest", ["rock"]), tilesById, ME, ref(0, 0))).toBe(
      true,
    );
  });

  it("reaches under two bodies as readily as one", () => {
    expect(
      pickUpDestination(
        under("sword", ["rock", "rock"]),
        tilesById,
        ME,
        ref(0, 0),
        KIT,
      ),
    ).toBe("contents");
  });

  it("is still buried under something nobody is driving", () => {
    const buried = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "sword", itemId: "itm_target" },
      { tileId: "rock" },
    ]);
    expect(pickUpDestination(buried, tilesById, ME, ref(0, 0), KIT)).toBeNull();
    expect(canOpenFrom(buried, tilesById, ME, ref(0, 0))).toBe(false);
  });
});

/**
 * Putting a thing down.
 *
 * A much longer reach than taking one, and the only affordance here that asks
 * about sight — which is what the length makes necessary: five cells is far
 * enough to reach through a wall if nothing stops it.
 */
describe("canDropAt", () => {
  /** Open ground, eleven by eleven, with the actor at the origin. */
  function field(): MapFile {
    let map = emptyMap();
    for (let x = -5; x <= 5; x++) {
      for (let y = -5; y <= 5; y++) {
        map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
      }
    }
    return map;
  }

  const sword = tilesById.sword!;

  it("drops at your own feet", () => {
    expect(canDropAt(field(), tilesById, ME, { x: 0, y: 0, z: 0 }, sword)).toBe(
      true,
    );
  });

  it("reaches five cells out, and no further", () => {
    const map = field();
    expect(canDropAt(map, tilesById, ME, { x: 5, y: 0, z: 0 }, sword)).toBe(true);
    expect(canDropAt(map, tilesById, ME, { x: -5, y: 0, z: 0 }, sword)).toBe(
      true,
    );
    expect(canDropAt(map, tilesById, ME, { x: 6, y: 0, z: 0 }, sword)).toBe(
      false,
    );
  });

  /** Round, like every other item reach — `3,4` is exactly five away. */
  it("measures the radius round rather than square", () => {
    const map = field();
    expect(canDropAt(map, tilesById, ME, { x: 3, y: 4, z: 0 }, sword)).toBe(true);
    expect(canDropAt(map, tilesById, ME, { x: 4, y: 4, z: 0 }, sword)).toBe(
      false,
    );
  });

  it("will not throw through a wall", () => {
    const walled = replaceStack(field(), 2, 0, 0, [
      { tileId: "grass" },
      { tileId: "wall" },
    ]);
    expect(canDropAt(walled, tilesById, ME, { x: 4, y: 0, z: 0 }, sword)).toBe(
      false,
    );
    // The same distance the other way, with nothing in between.
    expect(canDropAt(walled, tilesById, ME, { x: -4, y: 0, z: 0 }, sword)).toBe(
      true,
    );
  });

  it("refuses a cell with nothing to stand the thing on", () => {
    expect(
      canDropAt(emptyMap(), tilesById, ME, { x: 1, y: 0, z: 0 }, sword),
    ).toBe(false);
  });

  it("refuses a floor further off than a reach can follow", () => {
    const map = field();
    expect(canDropAt(map, tilesById, ME, { x: 1, y: 0, z: 3 }, sword)).toBe(
      false,
    );
  });
});
