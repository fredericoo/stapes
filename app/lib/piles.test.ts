import { describe, expect, it } from "vitest";
import { DEFAULT_CONTAINER, DEFAULT_PILE, pileMax } from "./item";
import { emptyMap, getStack, replaceStack } from "./mapData";
import {
  appendItem,
  countOf,
  fuses,
  peelOne,
  pileTally,
  pourInto,
  stackWithItem,
  stow,
  stowFits,
  withCount,
} from "./piles";
import type { ItemInstance } from "./itemInstance";
import type { PlacedTile, TileDef } from "./types";
import { normalizeTileDef } from "./types";

/**
 * The arithmetic of several-of-one-thing.
 *
 * Everything here is about `count` and nothing is about slots: whether a thing
 * may be somewhere at all belongs to `../game/itemMoves`, and the session tests
 * are where the two meet.
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

function food(id: string, pile?: number): TileDef {
  return tile({
    id,
    kind: "item",
    intangible: true,
    interactions: {
      item: { type: "consumable", label: "Eat", hp: 1, ...(pile ? { pile } : {}) },
    },
  });
}

const berry = food("berry", 12);
const bread = food("bread", 3);
const plainFood = food("plain-food");
const sword = tile({
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
});
const bag = tile({
  id: "bag",
  kind: "item",
  intangible: true,
  interactions: { item: { ...DEFAULT_CONTAINER, size: 2 } },
});
const grass = tile({ id: "grass" });

const tilesById: Record<string, TileDef> = Object.fromEntries(
  [berry, bread, plainFood, sword, bag, grass].map((def) => [def.id, def]),
);

describe("what piles", () => {
  it("is food, at the size the tile was authored with", () => {
    expect(pileMax(berry)).toBe(12);
    expect(pileMax(bread)).toBe(3);
  });

  it("is food nobody sized, at the handful every consumable gets", () => {
    expect(pileMax(plainFood)).toBe(DEFAULT_PILE);
  });

  it("is nothing else — a sword is a pile of one, not a pile of none", () => {
    expect(pileMax(sword)).toBe(1);
    expect(pileMax(bag)).toBe(1);
    expect(pileMax(grass)).toBe(1);
  });
});

describe("counting", () => {
  it("reads an absent count as the one thing it looks like", () => {
    expect(countOf({ tileId: "berry" })).toBe(1);
    expect(countOf({ tileId: "berry", count: 4 })).toBe(4);
  });

  it("drops the count on the way back down to one", () => {
    expect(withCount({ tileId: "berry", count: 3 }, 1)).toEqual({
      tileId: "berry",
    });
    expect(withCount({ tileId: "berry" }, 3)).toEqual({
      tileId: "berry",
      count: 3,
    });
  });

  it("says how many beside the name, and nothing at all for one", () => {
    expect(pileTally({ tileId: "berry", count: 3 })).toBe("×3");
    expect(pileTally({ tileId: "berry" })).toBeNull();
  });
});

describe("fusing", () => {
  it("joins two of the same food that fit inside the pile's ceiling", () => {
    const into = { tileId: "berry", count: 10 };
    expect(fuses(into, { tileId: "berry" }, tilesById)).toBe(true);
    expect(fuses(into, { tileId: "berry", count: 2 }, tilesById)).toBe(true);
  });

  it("refuses all of it or none, never half", () => {
    // Ten and three is thirteen, and a berry pile stops at twelve. Two would
    // fit; the rule is that a move lands whole or is refused.
    expect(
      fuses({ tileId: "berry", count: 10 }, { tileId: "berry", count: 3 }, tilesById),
    ).toBe(false);
  });

  it("refuses two different things, however alike they look", () => {
    expect(fuses({ tileId: "berry" }, { tileId: "bread" }, tilesById)).toBe(false);
  });

  it("refuses anything that does not pile", () => {
    expect(fuses({ tileId: "sword" }, { tileId: "sword" }, tilesById)).toBe(false);
  });

  it("refuses a thing somebody has written on, either side", () => {
    const described = { tileId: "berry", description: "the last one" };
    expect(fuses(described, { tileId: "berry" }, tilesById)).toBe(false);
    expect(fuses({ tileId: "berry" }, described, tilesById)).toBe(false);
  });

  it("refuses anything carrying a field a pile has no room for", () => {
    // The allow-list at work: a placement that is somebody's body, or is wired,
    // is not one of a heap however food-like its tile.
    const driven: PlacedTile = { tileId: "berry", owner: "npc:1" };
    const wired: PlacedTile = { tileId: "berry", channel: "door" };
    expect(fuses({ tileId: "berry" }, driven, tilesById)).toBe(false);
    expect(fuses({ tileId: "berry" }, wired, tilesById)).toBe(false);
  });

  it("keeps the identity of the pile that received", () => {
    const arriving: ItemInstance = { id: "itm_b", tileId: "berry", count: 3 };
    const poured = pourInto(
      [{ id: "itm_a", tileId: "berry", count: 2 }],
      arriving,
      tilesById,
    );
    expect(poured).toEqual([{ id: "itm_a", tileId: "berry", count: 5 }]);
  });

  it("pours into the first pile that will take all of it", () => {
    const poured = pourInto(
      [
        { tileId: "berry", count: 11 },
        { tileId: "berry", count: 2 },
      ],
      { tileId: "berry", count: 3 },
      tilesById,
    );
    // The first has room for one, not three, so the second takes it whole.
    expect(poured).toEqual([
      { tileId: "berry", count: 11 },
      { tileId: "berry", count: 5 },
    ]);
  });

  it("is nothing when no pile will have it", () => {
    expect(pourInto([{ tileId: "bread" }], { tileId: "berry" }, tilesById)).toBeNull();
    expect(pourInto([], { tileId: "berry" }, tilesById)).toBeNull();
  });
});

describe("stowing into a container", () => {
  it("pours before it takes a square, so a full bag still takes a berry", () => {
    const full = [
      { tileId: "berry", count: 2 },
      { tileId: "bread" },
    ];
    expect(stowFits(full, { tileId: "berry" }, 2, tilesById)).toBe(true);
    expect(stow(full, { tileId: "berry" }, 2, tilesById)).toEqual([
      { tileId: "berry", count: 3 },
      { tileId: "bread" },
    ]);
  });

  it("takes a square when nothing will pour", () => {
    expect(stow([{ tileId: "bread" }], { tileId: "berry" }, 2, tilesById)).toEqual([
      { tileId: "bread" },
      { tileId: "berry" },
    ]);
  });

  it("refuses when there is neither a pour nor a square", () => {
    const full = [{ tileId: "bread" }, { tileId: "sword" }];
    expect(stowFits(full, { tileId: "berry" }, 2, tilesById)).toBe(false);
    expect(stow(full, { tileId: "berry" }, 2, tilesById)).toBeNull();
  });

  it("refuses a pile the last square could not hold whole", () => {
    // Room in the pile for one and a pile of three arriving: no square left, and
    // the pour is all-or-nothing, so the bag is closed to it.
    const full = [{ tileId: "berry", count: 11 }, { tileId: "bread" }];
    expect(stowFits(full, { tileId: "berry", count: 3 }, 2, tilesById)).toBe(false);
  });
});

describe("peeling one off", () => {
  it("leaves the rest of the pile", () => {
    expect(peelOne({ tileId: "berry", count: 3 })).toEqual({
      tileId: "berry",
      count: 2,
    });
  });

  it("drops the count when two become one", () => {
    expect(peelOne({ tileId: "berry", count: 2 })).toEqual({ tileId: "berry" });
  });

  it("is nothing at all for the last of it", () => {
    expect(peelOne({ tileId: "berry" })).toBeNull();
  });
});

describe("landing on a cell", () => {
  it("joins a pile already in the stack rather than standing beside it", () => {
    const stack = [{ tileId: "grass" }, { tileId: "berry", count: 2 }];
    expect(stackWithItem(stack, { tileId: "berry" }, tilesById)).toEqual([
      { tileId: "grass" },
      { tileId: "berry", count: 3 },
    ]);
  });

  it("leaves the pile where it was in the stack", () => {
    const stack = [
      { tileId: "grass" },
      { tileId: "berry" },
      { tileId: "bread" },
    ];
    // Second, where it started — a pour adds no height, so there is nothing for
    // it to be on top of.
    expect(stackWithItem(stack, { tileId: "berry" }, tilesById)[1]).toEqual({
      tileId: "berry",
      count: 2,
    });
  });

  it("appends when nothing there will take it", () => {
    const stack = [{ tileId: "grass" }];
    expect(stackWithItem(stack, { tileId: "sword" }, tilesById)).toEqual([
      { tileId: "grass" },
      { tileId: "sword" },
    ]);
  });

  it("writes the poured stack back to the map", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "berry", count: 5 },
    ]);
    const next = appendItem(map, 0, 0, 0, { tileId: "berry" }, tilesById);
    expect(getStack(next, 0, 0, 0)).toEqual([
      { tileId: "grass" },
      { tileId: "berry", count: 6 },
    ]);
  });
});
