import { describe, expect, it } from "vitest";
import {
  interactionKinds,
  interactionsForSave,
  resolveTransmute,
  transmuteVerb,
} from "../lib/interactions";
import { DEFAULT_CONTAINER, DEFAULT_WEAPON } from "../lib/item";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import type { ObjectRef } from "./affordances";
import { emptyEquipment, type Equipment } from "./equipment";
import { GameSession } from "./GameSession";
import { listInteractionOptions } from "./interactionOptions";
import { canTransmuteFrom, offeredTransmutations } from "./transmute";

/**
 * A transmutation is the one authored act that spends something the player is
 * *carrying*, and every test here is about that: the fire never changes, the
 * kit does, and what stops a second helping is having nothing left to cook.
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

const EDIBLE = { type: "consumable", label: "Eat", hp: 1 } as const;

/**
 * The bag `player`'s kit is authored with — see `app/lib/kit.ts`. A literal
 * here like every other tile id in this file: what a body carries is authored
 * content, so there is no constant in the engine left to import.
 */
const BAG_TILE_ID = "basic-bag";

const tiles = [
  tile({ id: "grass" }),
  tile({ id: "crate", height: 2 }),
  tile({ id: "player", height: 4, kind: "battler", actor: true }),
  tile({ id: "raw-meat", name: "Raw Meat", kind: "item", interactions: { item: EDIBLE } }),
  tile({ id: "cooked-meat", name: "Cooked Meat", kind: "item", interactions: { item: EDIBLE } }),
  tile({ id: "raw-fish", name: "Raw Fish", kind: "item", interactions: { item: EDIBLE } }),
  tile({ id: "cooked-fish", name: "Cooked Fish", kind: "item", interactions: { item: EDIBLE } }),
  tile({ id: "coal", name: "Coal", kind: "item", interactions: { item: DEFAULT_WEAPON } }),
  tile({
    id: BAG_TILE_ID,
    name: "Bag",
    kind: "item",
    interactions: { item: { ...DEFAULT_CONTAINER, size: 4 } },
  }),
  tile({
    id: "spare-bag",
    name: "Spare Bag",
    kind: "item",
    interactions: { item: { ...DEFAULT_CONTAINER, size: 2 } },
  }),
  // One fire, two recipes — which is the arrangement the whole "several rows on
  // one placement" design exists for.
  tile({
    id: "flame",
    name: "Flame",
    interactions: {
      transmute: {
        recipes: [
          { verb: "Cook", fromTileId: "raw-meat", toTileIds: ["cooked-meat"] },
          { verb: "Cook", fromTileId: "raw-fish", toTileIds: ["cooked-fish"] },
        ],
      },
    },
  }),
  // Gives back more than it takes, which is what "one item in, one or more out"
  // is for: a butcher.
  tile({
    id: "butcher",
    name: "Butcher",
    interactions: {
      transmute: {
        recipes: [
          {
            verb: "Trade",
            fromTileId: "coal",
            toTileIds: ["raw-meat", "raw-meat", "raw-fish"],
          },
        ],
      },
    },
  }),
  // A recipe that would take the pack off your back, which is the one input the
  // rules refuse outright.
  tile({
    id: "bag-eater",
    name: "Bag Eater",
    interactions: {
      transmute: {
        recipes: [
          { verb: "Trade", fromTileId: "spare-bag", toTileIds: ["coal"] },
        ],
      },
    },
  }),
];
const tilesById = tilesByIdFromList(tiles);

const ME = { x: 0, y: 0, z: 0 };
/** Free ground diagonally off the transmuter — inside the round reach. */
const BESIDE = { x: 0, y: 1, z: 0 };
const FLAME: ObjectRef = { x: 1, y: 0, z: 0, stackIndex: 1 };
const FAR: ObjectRef = { x: 4, y: 4, z: 0, stackIndex: 1 };

/** Somewhere to stand, with a transmuter beside it and another two cells off. */
function board(tileId = "flame"): MapFile {
  let map = emptyMap();
  for (let x = 0; x <= 4; x++) {
    for (let y = 0; y <= 4; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  map = replaceStack(map, 0, 0, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "s" },
  ]);
  map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: tileId }]);
  map = replaceStack(map, 4, 4, 0, [{ tileId: "grass" }, { tileId: tileId }]);
  return map;
}

/** A kit with a bag holding exactly these tiles, and nothing in either hand. */
function carrying(...contents: string[]): Equipment {
  return {
    ...emptyEquipment(),
    bag: {
      id: "itm_bag",
      tileId: BAG_TILE_ID,
      contents: contents.map((tileId, i) => ({ id: `itm_${i}`, tileId })),
    },
  };
}

function bagTiles(equipment: Equipment | null | undefined): string[] {
  return equipment?.bag?.contents?.map((item) => item.tileId) ?? [];
}

describe("resolving a transmuter", () => {
  it("is nothing on a tile with no block", () => {
    expect(resolveTransmute(tilesById.grass!)).toBeNull();
  });

  it("keeps the authored recipes, in order", () => {
    expect(resolveTransmute(tilesById.flame!)?.recipes).toEqual([
      { verb: "Cook", fromTileId: "raw-meat", toTileIds: ["cooked-meat"] },
      { verb: "Cook", fromTileId: "raw-fish", toTileIds: ["cooked-fish"] },
    ]);
  });

  it("drops one malformed recipe rather than the whole tile", () => {
    // A fire with a typo in its third recipe still cooks the other two, which is
    // the argument for parsing recipe by recipe.
    const patchy = tile({
      id: "patchy",
      interactions: {
        transmute: {
          recipes: [
            { verb: "Cook", fromTileId: "raw-meat", toTileIds: ["cooked-meat"] },
            { verb: "Cook", fromTileId: "", toTileIds: ["cooked-fish"] },
            { verb: "Cook", fromTileId: "raw-fish", toTileIds: [] },
          ],
        },
      },
    });

    expect(resolveTransmute(patchy)?.recipes).toEqual([
      { verb: "Cook", fromTileId: "raw-meat", toTileIds: ["cooked-meat"] },
    ]);
  });

  it("is not a transmuter once every recipe has been dropped", () => {
    // Unlike a reward, an empty block says nothing: there is no placement half
    // for it to be pointing at, so it is scenery rather than an empty menu.
    const empty = tile({
      id: "empty",
      interactions: { transmute: { recipes: [] } },
    });

    expect(resolveTransmute(empty)).toBeNull();
    expect(interactionKinds(empty)).toEqual([]);
  });

  it("is a player-activated kind, listed after the switch", () => {
    expect(interactionKinds(tilesById.flame!)).toEqual(["transmute"]);
  });

  it("names an unnamed recipe after the mechanism", () => {
    expect(transmuteVerb({ fromTileId: "a", toTileIds: ["b"] })).toBe(
      "Transmute",
    );
    expect(transmuteVerb({ verb: " Cook ", fromTileId: "a", toTileIds: ["b"] }))
      .toBe("Cook");
  });
});

describe("saving a transmuter", () => {
  it("trims the verb and drops a blank one", () => {
    expect(
      interactionsForSave({
        transmute: {
          recipes: [
            { verb: " Cook ", fromTileId: "raw-meat", toTileIds: ["cooked-meat"] },
            { verb: "  ", fromTileId: "raw-fish", toTileIds: ["cooked-fish"] },
          ],
        },
      })?.transmute,
    ).toEqual({
      recipes: [
        { verb: "Cook", fromTileId: "raw-meat", toTileIds: ["cooked-meat"] },
        { fromTileId: "raw-fish", toTileIds: ["cooked-fish"] },
      ],
    });
  });

  it("drops a half-filled row rather than writing a recipe the game refuses", () => {
    expect(
      interactionsForSave({
        transmute: {
          recipes: [
            { verb: "Cook", fromTileId: "", toTileIds: ["cooked-meat"] },
            { verb: "Cook", fromTileId: "raw-fish", toTileIds: [] },
          ],
        },
      }),
    ).toBeUndefined();
  });
});

describe("whether a recipe is on offer", () => {
  it("is not, to somebody carrying nothing to spend", () => {
    expect(
      canTransmuteFrom(board(), tilesById, ME, carrying(), FLAME, 0),
    ).toBe(false);
  });

  it("is, to somebody with the input in their bag", () => {
    expect(
      canTransmuteFrom(board(), tilesById, ME, carrying("raw-meat"), FLAME, 0),
    ).toBe(true);
  });

  it("is not, from across the field", () => {
    expect(
      canTransmuteFrom(board(), tilesById, ME, carrying("raw-meat"), FAR, 0),
    ).toBe(false);
  });

  it("is not, under something solid", () => {
    // A crate rather than a body: a body is not a lid, and somebody standing on
    // the fire does not put it out.
    const map = replaceStack(board(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "flame" },
      { tileId: "crate" },
    ]);

    expect(
      canTransmuteFrom(map, tilesById, ME, carrying("raw-meat"), FLAME, 0),
    ).toBe(false);
  });

  it("is not, for a recipe index the tile does not have", () => {
    expect(
      canTransmuteFrom(board(), tilesById, ME, carrying("raw-meat"), FLAME, 7),
    ).toBe(false);
  });

  it("is, with a full bag, when the input is in a hand", () => {
    // The bug this rule exists for: a pickup reaches for a hand only once the
    // pack has no room, so "input in a hand" and "bag full" are the *same*
    // moment — and a swap that costs a player no room at all was being refused
    // for want of it.
    const full: Equipment = {
      ...carrying("coal", "coal", "coal", "coal"),
      offhand: { id: "itm_held", tileId: "raw-meat" },
    };

    expect(canTransmuteFrom(board(), tilesById, ME, full, FLAME, 0)).toBe(true);
  });

  it("is, with no bag at all, when the input is in a hand", () => {
    const bagless: Equipment = {
      ...emptyEquipment(),
      offhand: { id: "itm_held", tileId: "raw-meat" },
    };

    expect(canTransmuteFrom(board(), tilesById, ME, bagless, FLAME, 0)).toBe(
      true,
    );
  });

  it("is, for more back than the hand that paid can hold, by spilling to the pack", () => {
    // A hand holds one thing, so two of the butcher's three overflow — onto the
    // body, never onto the floor.
    const holding: Equipment = {
      ...carrying(),
      weapon: { id: "itm_held", tileId: "coal" },
    };

    expect(
      canTransmuteFrom(board("butcher"), tilesById, ME, holding, FLAME, 0),
    ).toBe(true);
  });

  it("is, when the pack that paid is nearly full, by spilling to a free hand", () => {
    // Three back for one coal out of a four-square pack with three other things
    // in it: the coal frees one square and the two spare hands take the rest.
    const full = carrying("coal", "raw-meat", "raw-meat", "raw-meat");

    expect(
      canTransmuteFrom(board("butcher"), tilesById, ME, full, FLAME, 0),
    ).toBe(true);
  });

  it("is not, once the whole body is out of room", () => {
    // The same trade with both hands already full: one freed square against
    // three things, and nowhere else on the body to put them. Denied rather
    // than dropped at the player's feet.
    const packed: Equipment = {
      ...carrying("coal", "raw-meat", "raw-meat", "raw-meat"),
      weapon: { id: "itm_w", tileId: "coal" },
      offhand: { id: "itm_o", tileId: "coal" },
    };

    expect(
      canTransmuteFrom(board("butcher"), tilesById, ME, packed, FLAME, 0),
    ).toBe(false);
  });

  it("counts the square the input frees, so the last steak still cooks", () => {
    const brimming = carrying("raw-meat", "coal", "coal", "coal");

    expect(
      canTransmuteFrom(board(), tilesById, ME, brimming, FLAME, 0),
    ).toBe(true);
  });

  it("refuses to spend a pack, whatever the recipe says", () => {
    // A hand takes a spare bag, so without this rule a row saying "Trade Spare
    // Bag" would destroy the bag and everything in it.
    const holding: Equipment = {
      ...carrying(),
      weapon: { id: "itm_spare", tileId: "spare-bag", contents: [] },
    };

    expect(
      canTransmuteFrom(board("bag-eater"), tilesById, ME, holding, FLAME, 0),
    ).toBe(false);
  });

  it("offers only the recipes the player can actually run", () => {
    const offered = offeredTransmutations(
      board(),
      tilesById,
      ME,
      carrying("raw-fish"),
      FLAME,
    );

    expect(offered).toHaveLength(1);
    expect(offered[0]?.index).toBe(1);
    expect(offered[0]?.recipe.fromTileId).toBe("raw-fish");
  });
});

describe("running a recipe", () => {
  it("spends the input, gives back the output, and leaves the fire alone", () => {
    const session = new GameSession(board(), tiles);
    session.spawn("cook", { at: BESIDE, carrying: carrying("raw-meat") });
    const before = session.getMap();

    expect(session.transmute(FLAME, 0, "cook")).toBe(true);
    expect(bagTiles(session.equipmentOf("cook"))).toEqual(["cooked-meat"]);
    // The whole point: the next person finds the same fire.
    expect(session.getMap()).toBe(before);
    expect(getStack(session.getMap(), 1, 0, 0)[1]?.tileId).toBe("flame");
  });

  it("leaves no tag, so it can be run again and again", () => {
    const session = new GameSession(board(), tiles);
    session.spawn("cook", { at: BESIDE, carrying: carrying("raw-meat", "raw-meat") });

    expect(session.transmute(FLAME, 0, "cook")).toBe(true);
    expect(session.transmute(FLAME, 0, "cook")).toBe(true);
    expect(session.tagsOf("cook")).toEqual([]);
    expect(bagTiles(session.equipmentOf("cook"))).toEqual([
      "cooked-meat",
      "cooked-meat",
    ]);
  });

  it("stops once there is nothing left to spend", () => {
    const session = new GameSession(board(), tiles);
    session.spawn("cook", { at: BESIDE, carrying: carrying("raw-meat") });

    expect(session.transmute(FLAME, 0, "cook")).toBe(true);
    expect(session.transmute(FLAME, 0, "cook")).toBe(false);
  });

  it("mints a fresh identity per output", () => {
    const session = new GameSession(board("butcher"), tiles);
    session.spawn("cook", { at: BESIDE, carrying: carrying("coal") });

    expect(session.transmute(FLAME, 0, "cook")).toBe(true);
    const ids = session.equipmentOf("cook")!.bag!.contents!.map((i) => i.id);
    expect(bagTiles(session.equipmentOf("cook"))).toEqual([
      "raw-meat",
      "raw-meat",
      "raw-fish",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("takes what is in a hand before what is in the bag, and hands it back there", () => {
    const session = new GameSession(board(), tiles);
    session.spawn("cook", {
      at: BESIDE,
      carrying: {
        ...carrying("raw-meat"),
        offhand: { id: "itm_held", tileId: "raw-meat" },
      },
    });

    expect(session.transmute(FLAME, 0, "cook")).toBe(true);
    const kit = session.equipmentOf("cook")!;
    // One thing out of that hand and one thing back into it, which is what a
    // trade is. The one still in the bag is untouched.
    expect(kit.offhand?.tileId).toBe("cooked-meat");
    expect(bagTiles(kit)).toEqual(["raw-meat"]);
  });

  it("spills what the paying slot cannot hold onto the rest of the body", () => {
    const session = new GameSession(board("butcher"), tiles);
    session.spawn("cook", {
      at: BESIDE,
      carrying: { ...carrying(), weapon: { id: "itm_held", tileId: "coal" } },
    });

    expect(session.transmute(FLAME, 0, "cook")).toBe(true);
    const kit = session.equipmentOf("cook")!;
    // The hand that paid takes the first, and the pack takes the overflow —
    // which is where a thing you are merely carrying belongs.
    expect(kit.weapon?.tileId).toBe("raw-meat");
    expect(bagTiles(kit)).toEqual(["raw-meat", "raw-fish"]);
  });

  it("reaches a free hand only once the pack has no room left", () => {
    const session = new GameSession(board("butcher"), tiles);
    session.spawn("cook", {
      at: BESIDE,
      carrying: carrying("coal", "raw-meat", "raw-meat", "raw-meat"),
    });

    expect(session.transmute(FLAME, 0, "cook")).toBe(true);
    const kit = session.equipmentOf("cook")!;
    // One square freed by the coal, then the spare hands — off hand first,
    // because what you swing with is the slot with consequences.
    expect(bagTiles(kit)).toEqual([
      "raw-meat",
      "raw-meat",
      "raw-meat",
      "raw-meat",
    ]);
    expect(kit.offhand?.tileId).toBe("raw-meat");
    expect(kit.weapon?.tileId).toBe("raw-fish");
  });

  it("leaves the bag alone when the slot that paid can hold it all", () => {
    const session = new GameSession(board(), tiles);
    session.spawn("cook", {
      at: BESIDE,
      carrying: {
        ...carrying("coal", "coal", "coal", "coal"),
        weapon: { id: "itm_held", tileId: "raw-meat" },
      },
    });

    expect(session.transmute(FLAME, 0, "cook")).toBe(true);
    const kit = session.equipmentOf("cook")!;
    expect(kit.weapon?.tileId).toBe("cooked-meat");
    // A full pack, untouched — the swap needed no room in it at all.
    expect(bagTiles(kit)).toEqual(["coal", "coal", "coal", "coal"]);
  });

  it("changes nothing when it is refused", () => {
    const session = new GameSession(board(), tiles);
    session.spawn("cook", { at: BESIDE, carrying: carrying("coal") });

    expect(session.transmute(FLAME, 0, "cook")).toBe(false);
    expect(bagTiles(session.equipmentOf("cook"))).toEqual(["coal"]);
  });

  it("is refused from too far away", () => {
    const session = new GameSession(board(), tiles);
    session.spawn("cook", { at: BESIDE, carrying: carrying("raw-meat") });

    expect(session.transmute(FAR, 0, "cook")).toBe(false);
    expect(bagTiles(session.equipmentOf("cook"))).toEqual(["raw-meat"]);
  });
});

describe("the rows a transmuter offers", () => {
  function rows(equipment: Equipment) {
    const session = new GameSession(board(), tiles);
    const snap = session.getSnapshot();
    return listInteractionOptions(
      snap.map,
      tilesById,
      snap.self,
      [],
      null,
      equipment,
    );
  }

  it("names the verb and the thing being spent, not the fire", () => {
    const row = rows(carrying("raw-meat")).find(
      (o) => o.action === "transmute",
    );

    expect(row?.label).toBe("Cook");
    expect(row?.name).toBe("Raw Meat");
    // The sprite is the input's, so a menu of three recipes is scannable; the
    // ref is still the fire, which is what the outline goes round.
    expect(row?.tileId).toBe("raw-meat");
    expect(row?.ref).toMatchObject({ x: 1, y: 0, z: 0 });
  });

  it("is one row per runnable recipe on the same placement", () => {
    const both = rows(carrying("raw-meat", "raw-fish")).filter(
      (o) => o.action === "transmute",
    );

    expect(both.map((o) => o.name)).toEqual(["Raw Meat", "Raw Fish"]);
    expect(both.map((o) => o.recipeIndex)).toEqual([0, 1]);
    // Distinct ids, or the list could not be diffed between frames.
    expect(new Set(both.map((o) => o.id)).size).toBe(2);
  });

  it("offers nothing at all to somebody with nothing to spend", () => {
    expect(rows(carrying("coal")).some((o) => o.action === "transmute")).toBe(
      false,
    );
  });
});
