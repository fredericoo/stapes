import { describe, expect, it } from "vitest";
import { interactionsForSave, resolveReward } from "../lib/interactions";
import { DEFAULT_CONTAINER, DEFAULT_WEAPON } from "../lib/item";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import type { ObjectRef } from "./affordances";
import { canRewardFrom, rewardFits } from "./affordances";
import { STARTING_BAG_TILE_ID } from "./constants";
import { emptyEquipment, type Equipment } from "./equipment";
import { GameSession } from "./GameSession";
import { listInteractionOptions } from "./interactionOptions";

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
  tile({ id: "player", height: 2, kind: "battler", actor: true }),
  tile({ id: "sword", kind: "item", interactions: { item: DEFAULT_WEAPON } }),
  tile({ id: "torch", kind: "item", interactions: { item: DEFAULT_WEAPON } }),
  tile({
    id: STARTING_BAG_TILE_ID,
    kind: "item",
    interactions: { item: { ...DEFAULT_CONTAINER, size: 4 } },
  }),
  tile({
    id: "quest-chest",
    interactions: {
      reward: {
        tag: REWARD_TAG,
        actionName: "Open",
        itemTileIds: ["torch", "sword"],
      },
    },
  }),
  // The other half of a choice: a different tile, the same tag. Taking one is
  // what closes the other, and nothing but the shared tag says so.
  tile({
    id: "other-chest",
    interactions: {
      reward: { tag: REWARD_TAG, actionName: "Open", itemTileIds: ["sword"] },
    },
  }),
  tile({
    id: "bag-giver",
    interactions: {
      reward: { tag: "free-bag", itemTileIds: [STARTING_BAG_TILE_ID] },
    },
  }),
];
const tilesById = tilesByIdFromList(tiles);

const ME = { x: 0, y: 0, z: 0 };
const CHEST: ObjectRef = { x: 1, y: 0, z: 0, stackIndex: 1 };
const OTHER: ObjectRef = { x: 1, y: 1, z: 0, stackIndex: 1 };

/** Somewhere to stand, with a chest beside it and its twin diagonally on. */
function board(chestTileId = "quest-chest"): MapFile {
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
    { tileId: chestTileId },
  ]);
  map = replaceStack(map, 1, 1, 0, [
    { tileId: "grass" },
    { tileId: "other-chest" },
  ]);
  return map;
}

function bagWith(count: number): Equipment {
  return {
    weapon: null,
    bag: {
      id: "itm_bag",
      tileId: STARTING_BAG_TILE_ID,
      contents: Array.from({ length: count }, (_, i) => ({
        id: `itm_filler_${i}`,
        tileId: "sword",
      })),
    },
  };
}

describe("a reward tile", () => {
  it("is not one without a tag, however many items it lists", () => {
    const untagged = tile({
      id: "broken",
      interactions: { reward: { tag: "", itemTileIds: ["sword"] } },
    });

    expect(resolveReward(untagged)).toBeNull();
  });

  it("is not one with nothing to give", () => {
    const empty = tile({
      id: "empty",
      interactions: { reward: { tag: "t", itemTileIds: [] } },
    });

    expect(resolveReward(empty)).toBeNull();
  });

  it("keeps the authored order of its items when saved", () => {
    const saved = interactionsForSave({
      reward: { tag: " t ", actionName: " Receive ", itemTileIds: ["torch", "sword"] },
    });

    expect(saved?.reward).toEqual({
      tag: "t",
      actionName: "Receive",
      itemTileIds: ["torch", "sword"],
    });
  });

  it("is dropped from the file when half-authored", () => {
    expect(
      interactionsForSave({ reward: { tag: "t", itemTileIds: [] } }),
    ).toBeUndefined();
  });
});

describe("whether a reward fits", () => {
  it("needs room for every item at once, not merely for one", () => {
    const reward = resolveReward(tilesById["quest-chest"]!)!;

    expect(rewardFits(reward, tilesById, bagWith(2))).toBe(true);
    // One slot free and two things to put in it. Half a reward is half of it
    // lost for ever, so the answer is no rather than one sword.
    expect(rewardFits(reward, tilesById, bagWith(3))).toBe(false);
  });

  it("is refused outright with no bag to put it in", () => {
    const reward = resolveReward(tilesById["quest-chest"]!)!;

    expect(rewardFits(reward, tilesById, emptyEquipment())).toBe(false);
  });

  it("is refused when it would hand over a container", () => {
    const reward = resolveReward(tilesById["bag-giver"]!)!;

    expect(rewardFits(reward, tilesById, bagWith(0))).toBe(false);
  });

  it("is refused when an item tile has been renamed out of the world", () => {
    const reward = resolveReward(tilesById["quest-chest"]!)!;
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

    const ids = session
      .getSnapshot()
      .equipment.bag!.contents!.map((i) => i.id);
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
    session.spawn("crowded", { x: 0, y: 1, z: 0 }, bagWith(3));

    expect(session.canTakeReward(CHEST, "crowded")).toBe(false);
    expect(session.interact(CHEST, "crowded")).toBe(false);
    // Nothing partial: no tag, so they can come back once they have made room.
    expect(session.tagsOf("crowded")).toEqual([]);
    expect(session.equipmentOf("crowded")?.bag?.contents).toHaveLength(3);
  });

  it("is offered again to somebody who has made room", () => {
    const session = new GameSession(board(), tiles);
    session.spawn("roomy", { x: 0, y: 1, z: 0 }, bagWith(2));

    expect(session.canTakeReward(CHEST, "roomy")).toBe(true);
  });

  it("is not owed to somebody who arrives already carrying the tag", () => {
    const session = new GameSession(board(), tiles);
    session.spawn("returning", { x: 0, y: 1, z: 0 }, bagWith(0), [REWARD_TAG]);

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

    expect(
      canRewardFrom(map, tilesById, far, CHEST, bagWith(0), []),
    ).toBe(false);
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
