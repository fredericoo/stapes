import { describe, expect, it } from "vitest";
import { defFrom } from "../lib/battler";
import { DEFAULT_CONTAINER, DEFAULT_WEAPON } from "../lib/item";
import { emptyMap, replaceStack } from "../lib/mapData";
import { levelForXp } from "../lib/mastery";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { TICK_MS } from "./constants";
import { GameSession } from "./GameSession";
import { tilesByIdFromList } from "../lib/validation";
import type { ObjectRef } from "./affordances";
import { masteryNotice, otherStatusNotice, rewardNotice, statusAcquiredNotice } from "./notices";
import { FRAME, tile as baseTile } from "../lib/testTile";

describe("what a crossing says", () => {
  it("names the mastery and where it now stands", () => {
    expect(masteryNotice("sharp", 10)).toBe("Your sharp mastery is now 10");
  });

  it("never says the word level, because there are none", () => {
    expect(masteryNotice("toughness", 3)).not.toContain("level");
  });
});

function tile(partial: Record<string, unknown> & Pick<TileDef, "id" | "height">): TileDef {
  const interactions = partial.interactions as { battler?: unknown } | undefined;
  return baseTile({
    kind: interactions?.battler ? "battler" : "prop",
    ...partial,
  });
}

const SPARRING_TOUGHNESS = 95;

const claws = {
  type: "weapon" as const,
  damage: defFrom(SPARRING_TOUGHNESS) + 3,
  def: 0,
  accuracy: 90,
  variance: 20,
  spd: 90,
  mastery: "fist" as const,
};

const EVENLY_MATCHED = { fist: 20, toughness: SPARRING_TOUGHNESS, agility: 20 };

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({
    id: "player",
    height: 4,
    directional: true,
    walkable: false,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
    interactions: {
      battler: { baseHp: 8, masteries: EVENLY_MATCHED, naturalWeapon: claws },
    },
  }),
  tile({
    id: "sparring-partner",
    height: 2,
    actor: true,
    walkable: false,
    interactions: {
      battler: { baseHp: 8, masteries: EVENLY_MATCHED, naturalWeapon: claws },
    },
  }),
];

function field(): MapFile {
  let map = emptyMap();
  for (let x = -2; x <= 2; x++) {
    for (let y = -2; y <= 2; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "e" }]);
  return replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "sparring-partner" }]);
}

function sparring() {
  const session = new GameSession(field(), tiles, {
    actorIds: ["me"],
    seed: 1,
  });
  const foe = session.actorIds().find((id) => id !== "me")!;
  session.setTarget(foe, "me");
  session.setAttackMode(true, "me");
  return session;
}

describe("level-ups out of a fight that actually happened", () => {
  it("says nothing to a body that was seeded rather than taught", () => {
    const session = new GameSession(field(), tiles, { actorIds: ["me"], seed: 1 });
    for (let elapsed = 0; elapsed < 10_000; elapsed += TICK_MS) {
      session.tick(TICK_MS);
    }

    expect(session.getSnapshot("me").masteryXp.fist).toBeGreaterThan(0);
    expect(session.drainNotices("me")).toEqual([]);
  });

  it("names each mastery once, on the tick it crosses", () => {
    const session = sparring();

    const heard: string[] = [];
    for (let elapsed = 0; elapsed < 60_000; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      heard.push(...session.drainNotices("me"));
    }

    expect(heard).toContain(
      `Your fist mastery is now ${levelForXp(session.getSnapshot("me").masteryXp.fist ?? 0)}`,
    );
    expect(new Set(heard).size).toBe(heard.length);
  });
});

const named = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  normalizeTileDef({
    name,
    height: 0,
    kind: "prop",
    directional: false,
    variants: { default: [FRAME] },
    attributes: {},
    id,
    ...extra,
  });

const BAG_TILE_ID = "basic-bag";

const rewardTiles: TileDef[] = [
  named("grass", "Grass"),
  named("player", "Player", {
    height: 4,
    kind: "battler",
    actor: true,
    walkable: false,
    directional: true,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
    interactions: {
      battler: {
        baseHp: 8,
        masteries: { toughness: 8 },
        naturalWeapon: DEFAULT_WEAPON,
        kit: [{ slot: "bag", tileId: BAG_TILE_ID, chance: 100 }],
      },
    },
  }),
  named("hand-lantern", "Hand Lantern", {
    kind: "item",
    interactions: { item: DEFAULT_WEAPON },
  }),
  named("rusty-sword", "Rusty Sword", {
    kind: "item",
    interactions: { item: DEFAULT_WEAPON },
  }),
  named("bread", "Bread", { kind: "item", interactions: { item: DEFAULT_WEAPON } }),
  named(BAG_TILE_ID, "Basic Bag", {
    kind: "item",
    interactions: { item: { ...DEFAULT_CONTAINER, size: 4 } },
  }),
  named("quest-chest", "Quest Chest", {
    interactions: { reward: { actionName: "Open" } },
  }),
  named("old-man", "Old Man", { interactions: { reward: {} } }),
];
const rewardTilesById = tilesByIdFromList(rewardTiles);

const CHEST: ObjectRef = { x: 1, y: 0, z: 0, stackIndex: 1 };

function chestBoard(
  giverTileId = "quest-chest",
  items: string[] = ["hand-lantern", "rusty-sword"],
): MapFile {
  let map = emptyMap();
  for (const [x, y] of [
    [0, 0],
    [1, 0],
  ] as const) {
    map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
  }
  map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "e" }]);
  return replaceStack(map, 1, 0, 0, [
    { tileId: "grass" },
    { tileId: giverTileId, rewardTag: "the-chest", rewardTileIds: items },
  ]);
}

const reward = (actionName: string | undefined, itemTileIds: string[]) => ({
  ...(actionName === undefined ? {} : { actionName }),
  tag: "the-chest",
  itemTileIds,
});

describe("what a reward says", () => {
  it("names the authored gesture, the giver and what was handed over", () => {
    expect(
      rewardNotice(
        reward("Open", ["hand-lantern", "rusty-sword"]),
        rewardTilesById["quest-chest"],
        rewardTilesById,
      ),
    ).toBe("You open Quest Chest and receive 1 Hand Lantern, 1 Rusty Sword");
  });

  it("groups repeats into a quantity rather than repeating the name", () => {
    expect(
      rewardNotice(
        reward("Open", ["bread", "bread", "rusty-sword", "bread"]),
        rewardTilesById["quest-chest"],
        rewardTilesById,
      ),
    ).toBe("You open Quest Chest and receive 3 Bread, 1 Rusty Sword");
  });

  it("falls back to taking when the author named no gesture", () => {
    expect(
      rewardNotice(reward(undefined, ["bread"]), rewardTilesById["old-man"], rewardTilesById),
    ).toBe("You take Old Man and receive 1 Bread");
  });

  it("drops the second clause for a reward that hands over nothing", () => {
    expect(rewardNotice(reward("Speak to", []), rewardTilesById["old-man"], rewardTilesById)).toBe(
      "You speak to Old Man",
    );
  });

  it("says the tile id rather than skipping an item the catalogue lost", () => {
    expect(
      rewardNotice(reward("Open", ["ghost-item"]), rewardTilesById["quest-chest"], rewardTilesById),
    ).toBe("You open Quest Chest and receive 1 ghost-item");
  });
});

describe("a chest opened for real", () => {
  it("tells the taker once, and has nothing to add on the second tap", () => {
    const session = new GameSession(chestBoard(), rewardTiles);

    expect(session.interact(CHEST)).toBe(true);
    expect(session.drainNotices()).toEqual([
      "You open Quest Chest and receive 1 Hand Lantern, 1 Rusty Sword",
    ]);

    expect(session.drainNotices()).toEqual([]);
    session.interact(CHEST);
    expect(session.drainNotices()).toEqual([]);
  });

  it("says nothing to anybody the reward did not happen to", () => {
    const session = new GameSession(chestBoard(), rewardTiles, {
      actorIds: ["me", "you"],
    });

    expect(session.actorIds()).toContain("you");

    expect(session.interact(CHEST, "me")).toBe(true);
    expect(session.drainNotices("you")).toEqual([]);
    expect(session.drainNotices("me")).toHaveLength(1);
  });
});

describe("a status named in a sentence", () => {
  it("is lowercased, whatever the author capitalised for the strip", () => {
    expect(statusAcquiredNotice("Asleep")).toBe("You are asleep");
    expect(otherStatusNotice("Deer", "Burning")).toBe("Deer is burning");
  });
});
