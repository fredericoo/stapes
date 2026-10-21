import { describe, expect, it } from "vitest";
import { interactionsForSave, resolveReward, resolveRewardDef } from "../lib/interactions";
import { DEFAULT_CONTAINER, DEFAULT_WEAPON } from "../lib/item";
import {
  emptyMap,
  getStack,
  parseMap,
  replaceStack,
  serializeMap,
  updatePlacedReward,
  type RewardDraft,
} from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import type { ObjectRef } from "./affordances";
import { canRewardFrom, rewardFits, rewardShortfall } from "./affordances";
import { emptyEquipment, type Equipment } from "./equipment";
import { GameSession } from "./GameSession";
import { listInteractionOptions } from "./interactionOptions";

const BAG_TILE_ID = "basic-bag";

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
  tile({
    id: "player",
    height: 4,
    kind: "battler",
    actor: true,
    interactions: {
      battler: {
        baseHp: 8,
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
  tile({
    id: "quest-chest",
    interactions: { reward: { actionName: "Open" } },
  }),
  tile({ id: "plain-chest", interactions: { reward: {} } }),
];
const tilesById = tilesByIdFromList(tiles);

const ME = { x: 0, y: 0, z: 0, stackIndex: 0 };
const CHEST: ObjectRef = { x: 1, y: 0, z: 0, stackIndex: 1 };
const OTHER: ObjectRef = { x: 1, y: 1, z: 0, stackIndex: 1 };

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
  map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "s" }]);
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

function draft(tag: string, tileIds: string[], minRating: number | null = null): RewardDraft {
  return { tag, tileIds, minRating };
}

function requiring(minRating: number): MapFile {
  return updatePlacedReward(board(), 1, 0, 0, 1, draft(REWARD_TAG, ["torch", "sword"], minRating));
}

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
      requires: {},
    });
  });

  it("keeps the authored order of the items", () => {
    expect(
      rewardAt(board("quest-chest", REWARD_TAG, ["sword", "torch"]), 1, 0)?.itemTileIds,
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
    expect(interactionsForSave({ reward: { actionName: " Receive " } })?.reward).toEqual({
      actionName: "Receive",
    });
  });
});

describe("whether a reward fits", () => {
  it("needs room for every item at once, not merely for one", () => {
    const reward = rewardAt(board(), 1, 0)!;

    expect(rewardFits(reward, tilesById, bagWith(2))).toBe(true);
    expect(rewardFits(reward, tilesById, bagWith(3))).toBe(false);
  });

  it("is refused outright with no bag to put it in", () => {
    const reward = rewardAt(board(), 1, 0)!;

    expect(rewardFits(reward, tilesById, emptyEquipment())).toBe(false);
  });

  it("is refused when it would hand over a container", () => {
    const reward = rewardAt(board("quest-chest", "free-bag", [BAG_TILE_ID]), 1, 0)!;

    expect(rewardFits(reward, tilesById, bagWith(0))).toBe(false);
  });

  it("is refused when an item tile has been renamed out of the world", () => {
    const reward = rewardAt(board(), 1, 0)!;
    const withoutSword = tilesByIdFromList(tiles.filter((t) => t.id !== "sword"));

    expect(rewardFits(reward, withoutSword, bagWith(0))).toBe(false);
  });
});

describe("taking a reward", () => {
  it("fills the bag and leaves the chest exactly as it was", () => {
    const session = new GameSession(board(), tiles);
    const before = session.getMap();

    expect(session.interact(CHEST)).toBe(true);

    const snap = session.getSnapshot();
    expect(snap.equipment.bag?.contents?.map((i) => i.tileId)).toEqual(["torch", "sword"]);
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
    session.spawn("crowded", { at: { x: 0, y: 1, z: 0 }, carrying: bagWith(3) });

    expect(session.canTakeReward(CHEST, "crowded")).toBe(false);
    expect(session.interact(CHEST, "crowded")).toBe(false);
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
    expect(offered?.label).toBe("Open");
    expect(offered?.name).toBe("quest-chest");

    session.interact(CHEST);
    expect(rows().some((o) => o.action === "reward")).toBe(false);
  });
});

describe("a reward the actor cannot reach", () => {
  it("is not offered from two cells away", () => {
    const map = board();
    const far = { x: 3, y: 3, z: 0, stackIndex: 0 };

    expect(canRewardFrom(map, tilesById, far, CHEST, bagWith(0), [])).toBe(false);
  });

  it("is offered diagonally, unlike a shove", () => {
    expect(canRewardFrom(board(), tilesById, ME, OTHER, bagWith(0), [])).toBe(true);
  });

  it("is not offered under something solid", () => {
    let map = board();
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "quest-chest" },
      { tileId: "sword" },
    ]);

    expect(canRewardFrom(map, tilesById, ME, CHEST, bagWith(0), [])).toBe(false);
  });
});

describe("writing a reward onto a placement", () => {
  const at = (map: MapFile) => getStack(map, 1, 0, 0)[1]!;

  it("writes the pair together", () => {
    const next = updatePlacedReward(board("quest-chest", ""), 1, 0, 0, 1, draft("t", ["sword"]));

    expect(at(next).rewardTag).toBe("t");
    expect(at(next).rewardTileIds).toEqual(["sword"]);
  });

  it("returns the same map when nothing changed", () => {
    const before = board();
    expect(updatePlacedReward(before, 1, 0, 0, 1, draft(REWARD_TAG, ["torch", "sword"]))).toBe(
      before,
    );
  });

  it("clears both halves when either is emptied", () => {
    const cleared = updatePlacedReward(board(), 1, 0, 0, 1, draft("", ["sword"]));

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
      requires: {},
    });
  });
});

describe("a reward that asks for a rating", () => {
  const playerRating = new GameSession(board(), tiles).getSnapshot().self.rating!;
  const rows = (session: GameSession) => {
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

  it("is written on the placement and cleared with the reward", () => {
    const map = requiring(10);
    expect(getStack(map, 1, 0, 0)[1]?.rewardRequires).toEqual({ rating: 10 });

    const cleared = updatePlacedReward(map, 1, 0, 0, 1, draft("", ["sword"], 10));
    expect(getStack(cleared, 1, 0, 0)[1]?.rewardRequires).toBeUndefined();
  });

  it("asks only of its own placement, not of others of the same tile", () => {
    const map = requiring(10);
    expect(rewardAt(map, 1, 0)?.requires).toEqual({ rating: 10 });
    expect(rewardAt(map, 1, 1)?.requires).toEqual({});
  });

  it("asks nothing when the written requirement is malformed", () => {
    const map = replaceStack(board(), 1, 0, 0, [
      { tileId: "grass" },
      {
        tileId: "quest-chest",
        rewardTag: REWARD_TAG,
        rewardTileIds: ["sword"],
        rewardRequires: { rating: -3 },
      },
    ]);
    expect(rewardAt(map, 1, 0)?.requires).toEqual({});
  });

  it("is met at exactly the rating it names, and not by an unknown one", () => {
    const reward = rewardAt(requiring(10), 1, 0)!;

    expect(rewardShortfall(reward, 10)).toBeNull();
    expect(rewardShortfall(reward, 9)).toEqual({ rating: 10 });
    expect(rewardShortfall(reward, null)).toEqual({ rating: 10 });
  });

  it("shows a player rated too low the row, blocked with the rating it needs", () => {
    const needed = playerRating + 1;
    const session = new GameSession(requiring(needed), tiles);

    const offered = rows(session).find(
      (o) => o.action === "reward" && o.ref.x === CHEST.x && o.ref.y === CHEST.y,
    );
    expect(offered?.blocked).toEqual({ kind: "needs", rating: needed });
  });

  it("refuses a player rated too low, and gives them nothing", () => {
    const session = new GameSession(requiring(playerRating + 1), tiles);

    expect(session.canTakeReward(CHEST)).toBe(false);
    expect(session.interact(CHEST)).toBe(false);
    expect(session.getSnapshot().tags).toEqual([]);
    expect(session.getSnapshot().equipment.bag?.contents ?? []).toHaveLength(0);
  });

  it("opens for a player at the rating", () => {
    const session = new GameSession(requiring(playerRating), tiles);

    expect(rows(session).find((o) => o.action === "reward")?.blocked).toBeNull();
    expect(session.interact(CHEST)).toBe(true);
  });
});
