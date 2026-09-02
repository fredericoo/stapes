import { describe, expect, it } from "vitest";
import {
  interactionsForSave,
  resolveReward,
  resolveRewardDef,
} from "../lib/interactions";
import { DEFAULT_CONTAINER, DEFAULT_WEAPON } from "../lib/item";
import {
  emptyMap,
  getStack,
  parseMap,
  replaceStack,
  serializeMap,
  updatePlacedReward,
} from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import type { ObjectRef } from "./affordances";
import { canRewardFrom, rewardFits } from "./affordances";
import { emptyEquipment, type Equipment } from "./equipment";
import { GameSession } from "./GameSession";
import { listInteractionOptions } from "./interactionOptions";

/**
 * The bag `player`'s kit is authored with — see `app/lib/kit.ts`. A literal
 * here like every other tile id in this file: what a body carries is authored
 * content now, so there is no constant in the engine left to import.
 */
const BAG_TILE_ID = "basic-bag";

/**
 * A reward is the one thing on the board that happens to a *player* rather than
 * to the world, and every test here is about that asymmetry: the chest is
 * untouched afterwards, the taker is not, and the second tap has to know the
 * difference.
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

const REWARD_TAG = "chest-42";

const tiles = [
  tile({ id: "grass" }),
  // The kit is what puts a bag on somebody's back now — see `app/lib/kit.ts` —
  // and a reward with nowhere to go is refused, so this block is the premise of
  // half the file rather than decoration.
  tile({
    id: "player",
    height: 4,
    kind: "battler",
    actor: true,
    interactions: {
      battler: {
        masteries: { toughness: 8 },
        naturalWeapon: DEFAULT_WEAPON,
        kit: [{ slot: "bag", tileId: BAG_TILE_ID, chance: 100 }],
      },
    },
  }),
  tile({ id: "sword", kind: "item", interactions: { item: DEFAULT_WEAPON } }),
  tile({ id: "torch", kind: "item", interactions: { item: DEFAULT_WEAPON } }),
  tile({
    id: BAG_TILE_ID,
    kind: "item",
    interactions: { item: { ...DEFAULT_CONTAINER, size: 4 } },
  }),
  // One giver tile, used by every chest in these tests — which is the point of
  // the split: what each chest gives is on its placement.
  tile({
    id: "quest-chest",
    interactions: { reward: { actionName: "Open" } },
  }),
  tile({ id: "plain-chest", interactions: { reward: {} } }),
];
const tilesById = tilesByIdFromList(tiles);

const ME = { x: 0, y: 0, z: 0 };
const CHEST: ObjectRef = { x: 1, y: 0, z: 0, stackIndex: 1 };
const OTHER: ObjectRef = { x: 1, y: 1, z: 0, stackIndex: 1 };

/**
 * Somewhere to stand, with a chest beside it and its twin diagonally on.
 *
 * Both are the *same tile*, and they differ only in what is written on the
 * placement — which is the arrangement this whole split exists to make possible.
 * They share a tag, so they are a choice.
 */
function board(
  chestTileId = "quest-chest",
  chestTag: string | undefined = REWARD_TAG,
  chestItems: string[] | undefined = ["torch", "sword"],
): MapFile {
  let map = emptyMap();
  for (const [x, y] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const) {
    map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
  }
  map = replaceStack(map, 0, 0, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "s" },
  ]);
  map = replaceStack(map, 1, 0, 0, [
    { tileId: "grass" },
    {
      tileId: chestTileId,
      ...(chestTag ? { rewardTag: chestTag } : {}),
      ...(chestItems ? { rewardTileIds: chestItems } : {}),
    },
  ]);
  map = replaceStack(map, 1, 1, 0, [
    { tileId: "grass" },
    { tileId: "quest-chest", rewardTag: REWARD_TAG, rewardTileIds: ["sword"] },
  ]);
  return map;
}

/** The reward one cell of a board actually offers, for the resolver tests. */
function rewardAt(map: MapFile, x: number, y: number) {
  const placed = getStack(map, x, y, 0)[1]!;
  return resolveReward(placed, tilesById[placed.tileId]);
}

function bagWith(count: number): Equipment {
  return {
    ...emptyEquipment(),
    bag: {
      id: "itm_bag",
      tileId: BAG_TILE_ID,
      contents: Array.from({ length: count }, (_, i) => ({
        id: `itm_filler_${i}`,
        tileId: "sword",
      })),
    },
  };
}

describe("resolving a reward", () => {
  it("is nothing on a tile that is not a giver, however the placement is written", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass", rewardTag: "t", rewardTileIds: ["sword"] },
    ]);
    const placed = getStack(map, 0, 0, 0)[0]!;

    expect(resolveReward(placed, tilesById.grass)).toBeNull();
  });

  it("is nothing on a giver whose placement says nothing", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "quest-chest" }]);
    const placed = getStack(map, 0, 0, 0)[0]!;

    expect(resolveReward(placed, tilesById["quest-chest"])).toBeNull();
  });

  it("is nothing without a tag, however many items the placement lists", () => {
    expect(rewardAt(board("quest-chest", ""), 1, 0)).toBeNull();
  });

  it("is nothing with nothing to give", () => {
    expect(rewardAt(board("quest-chest", REWARD_TAG, []), 1, 0)).toBeNull();
  });

  it("joins the tile's verb to the placement's contents", () => {
    expect(rewardAt(board(), 1, 0)).toEqual({
      actionName: "Open",
      tag: REWARD_TAG,
      itemTileIds: ["torch", "sword"],
    });
  });

  it("keeps the authored order of the items", () => {
    // Not sorted, unlike `moveOnTileIds`: which thing lands in the bag first is
    // the author's to decide.
    expect(
      rewardAt(board("quest-chest", REWARD_TAG, ["sword", "torch"]), 1, 0)
        ?.itemTileIds,
    ).toEqual(["sword", "torch"]);
  });

  it("carries no verb from a tile that authored none", () => {
    expect(rewardAt(board("plain-chest"), 1, 0)?.actionName).toBeUndefined();
  });
});

describe("a reward tile def", () => {
  it("is a giver on an empty block, because the block's presence is the claim", () => {
    expect(resolveRewardDef(tilesById["plain-chest"]!)).toEqual({});
  });

  it("keeps an empty block through a save, rather than un-authoring the tile", () => {
    expect(interactionsForSave({ reward: {} })?.reward).toEqual({});
  });

  it("keeps the verb, trimmed", () => {
    expect(
      interactionsForSave({ reward: { actionName: " Receive " } })?.reward,
    ).toEqual({ actionName: "Receive" });
  });
});

describe("whether a reward fits", () => {
  it("needs room for every item at once, not merely for one", () => {
    const reward = rewardAt(board(), 1, 0)!;

    expect(rewardFits(reward, tilesById, bagWith(2))).toBe(true);
    // One slot free and two things to put in it. Half a reward is half of it
    // lost for ever, so the answer is no rather than one sword.
    expect(rewardFits(reward, tilesById, bagWith(3))).toBe(false);
  });

  it("is refused outright with no bag to put it in", () => {
    const reward = rewardAt(board(), 1, 0)!;

    expect(rewardFits(reward, tilesById, emptyEquipment())).toBe(false);
  });

  it("is refused when it would hand over a container", () => {
    const reward = rewardAt(
      board("quest-chest", "free-bag", [BAG_TILE_ID]),
      1,
      0,
    )!;

    expect(rewardFits(reward, tilesById, bagWith(0))).toBe(false);
  });

  it("is refused when an item tile has been renamed out of the world", () => {
    const reward = rewardAt(board(), 1, 0)!;
    const withoutSword = tilesByIdFromList(
      tiles.filter((t) => t.id !== "sword"),
    );

    expect(rewardFits(reward, withoutSword, bagWith(0))).toBe(false);
  });
});

describe("taking a reward", () => {
  it("fills the bag and leaves the chest exactly as it was", () => {
    const session = new GameSession(board(), tiles);
    const before = session.getMap();

    expect(session.interact(CHEST)).toBe(true);

    const snap = session.getSnapshot();
    expect(snap.equipment.bag?.contents?.map((i) => i.tileId)).toEqual([
      "torch",
      "sword",
    ]);
    // The whole point: nothing on the board moved, so the next player finds the
    // chest as full as this one did.
    expect(session.getMap()).toBe(before);
    expect(getStack(session.getMap(), 1, 0, 0)[1]?.tileId).toBe("quest-chest");
  });

  it("mints a fresh identity per item, so two takers hold two swords", () => {
    const session = new GameSession(board(), tiles);
    session.interact(CHEST);

    const ids = session.getSnapshot().equipment.bag!.contents!.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith("itm_"))).toBe(true);
  });

  it("marks the taker, and refuses them the second time", () => {
    const session = new GameSession(board(), tiles);

    expect(session.interact(CHEST)).toBe(true);
    expect(session.getSnapshot().tags).toEqual([REWARD_TAG]);
    expect(session.canInteract(CHEST)).toBe(false);
    expect(session.interact(CHEST)).toBe(false);
    expect(session.getSnapshot().equipment.bag?.contents).toHaveLength(2);
  });

  it("closes every other tile sharing the tag — which is what makes it a choice", () => {
    const session = new GameSession(board(), tiles);

    expect(session.canTakeReward(OTHER)).toBe(true);
    session.interact(CHEST);
    expect(session.canTakeReward(OTHER)).toBe(false);
  });

  it("is refused, and takes nothing at all, when the bag is nearly full", () => {
    const session = new GameSession(board(), tiles);
    // Somebody else, stood diagonally off the chest, with three of four slots
    // already spoken for against a reward of two.
    session.spawn("crowded", {
      at: { x: 0, y: 1, z: 0 },
      carrying: bagWith(3),
    });

    expect(session.canTakeReward(CHEST, "crowded")).toBe(false);
    expect(session.interact(CHEST, "crowded")).toBe(false);
    // Nothing partial: no tag, so they can come back once they have made room.
    expect(session.tagsOf("crowded")).toEqual([]);
    expect(session.equipmentOf("crowded")?.bag?.contents).toHaveLength(3);
  });

  it("is offered again to somebody who has made room", () => {
    const session = new GameSession(board(), tiles);
    session.spawn("roomy", { at: { x: 0, y: 1, z: 0 }, carrying: bagWith(2) });

    expect(session.canTakeReward(CHEST, "roomy")).toBe(true);
  });

  it("is not owed to somebody who arrives already carrying the tag", () => {
    const session = new GameSession(board(), tiles);
    session.spawn("returning", {
      at: { x: 0, y: 1, z: 0 },
      carrying: bagWith(0),
      tagged: [REWARD_TAG],
    });

    expect(session.canTakeReward(CHEST, "returning")).toBe(false);
  });

  it("drops out of the interaction list once taken", () => {
    const session = new GameSession(board(), tiles);
    const rows = () => {
      const snap = session.getSnapshot();
      return listInteractionOptions(
        snap.map,
        tilesById,
        snap.self,
        [],
        null,
        snap.equipment,
        null,
        snap.tags,
      );
    };

    const offered = rows().find((o) => o.action === "reward");
    // Named by its author, and by the tile it is on rather than by the verb the
    // mechanism would otherwise supply.
    expect(offered?.label).toBe("Open");
    expect(offered?.name).toBe("quest-chest");

    session.interact(CHEST);
    expect(rows().some((o) => o.action === "reward")).toBe(false);
  });
});

describe("a reward the actor cannot reach", () => {
  it("is not offered from two cells away", () => {
    const map = board();
    const far = { x: 3, y: 3, z: 0 };

    expect(canRewardFrom(map, tilesById, far, CHEST, bagWith(0), [])).toBe(
      false,
    );
  });

  it("is offered diagonally, unlike a shove", () => {
    expect(canRewardFrom(board(), tilesById, ME, OTHER, bagWith(0), [])).toBe(
      true,
    );
  });

  it("is not offered under something solid", () => {
    let map = board();
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "quest-chest" },
      { tileId: "sword" },
    ]);

    expect(canRewardFrom(map, tilesById, ME, CHEST, bagWith(0), [])).toBe(
      false,
    );
  });
});

/**
 * The authoring mutation, which the placement settings dialog commits on close —
 * so it runs whether or not anything was typed, and has to behave when nothing
 * was.
 */
describe("writing a reward onto a placement", () => {
  const at = (map: MapFile) => getStack(map, 1, 0, 0)[1]!;

  it("writes the pair together", () => {
    const next = updatePlacedReward(board("quest-chest", ""), 1, 0, 0, 1, "t", [
      "sword",
    ]);

    expect(at(next).rewardTag).toBe("t");
    expect(at(next).rewardTileIds).toEqual(["sword"]);
  });

  it("returns the same map when nothing changed", () => {
    const before = board();
    // The dialog commits on every close, so an author who opened it and pressed
    // Done must not mint a map identity, an undo entry and a geometry diff.
    expect(
      updatePlacedReward(before, 1, 0, 0, 1, REWARD_TAG, ["torch", "sword"]),
    ).toBe(before);
  });

  it("clears both halves when either is emptied", () => {
    // Half of one is inert — a tagless reward could be taken for ever, an empty
    // one offers a verb that does nothing — so a placement must never be left
    // looking authored and doing nothing.
    const cleared = updatePlacedReward(board(), 1, 0, 0, 1, "", ["sword"]);

    expect(at(cleared).rewardTag).toBeUndefined();
    expect(at(cleared).rewardTileIds).toBeUndefined();
  });

  it("survives a trip through the file", () => {
    const parsed = parseMap(serializeMap(board()));
    const placed = getStack(parsed, 1, 0, 0)[1]!;

    expect(resolveReward(placed, tilesById[placed.tileId])).toEqual({
      actionName: "Open",
      tag: REWARD_TAG,
      itemTileIds: ["torch", "sword"],
    });
  });
});
