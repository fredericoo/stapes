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
import { masteryNotice, rewardNotice } from "./notices";

/**
 * What crossing a mastery says, and when it is said.
 *
 * The sentence itself is one line and barely worth a test; what is worth testing
 * is that **only earning speaks**. A body is seeded with the masteries its tile
 * was authored with, and a seed that announced itself would greet every new
 * player with a burst of level-ups for progress they never made — which is
 * exactly the failure the old client-side diff needed a `hasExperience` gate to
 * avoid. Composed at the source, the silence is structural, and the tests below
 * are what say so.
 */

describe("what a crossing says", () => {
  it("names the mastery and where it now stands", () => {
    expect(masteryNotice("blade", 10)).toBe("Your blade mastery is now 10");
  });

  it("never says the word level, because there are none", () => {
    expect(masteryNotice("toughness", 3)).not.toContain("level");
  });
});

/**
 * The same sentence out of a real fight, because the line above proves nothing
 * about whether anything ever says it.
 *
 * A session is the only honest source: a crossing is a thing that happens inside
 * `grantExperience`, between two totals that exist together nowhere else. The
 * fixtures are the ones `./experience.test.ts` fights with, cut down to the pair
 * that is needed.
 */

const frame = {
  sprite: {
    tilesetId: "basic",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  durationMs: 200,
};

function tile(
  partial: Record<string, unknown> & Pick<TileDef, "id" | "height">,
): TileDef {
  const interactions = partial.interactions as
    | { battler?: unknown }
    | undefined;
  return normalizeTileDef({
    name: partial.id,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    kind: interactions?.battler ? "battler" : "prop",
    ...partial,
  });
}

/**
 * How tough both sides are, named above the claws because the claws must clear
 * it: Toughness grants defence now — see `../lib/battler`'s `defFrom` — and a
 * fixture bred to trade blows for a whole test had quietly grown enough armour
 * to swallow every blow in the file, which reads as level-ups never happening.
 */
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

/** Both sides rated alike, and tough enough to trade blows for a whole test. */
const EVENLY_MATCHED = { fist: 20, toughness: SPARRING_TOUGHNESS, agility: 20 };

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({
    id: "player",
    height: 4,
    directional: true,
    walkable: false,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
    interactions: {
      battler: { masteries: EVENLY_MATCHED, naturalWeapon: claws },
    },
  }),
  tile({
    id: "sparring-partner",
    height: 2,
    actor: true,
    walkable: false,
    interactions: {
      battler: { masteries: EVENLY_MATCHED, naturalWeapon: claws },
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
  map = replaceStack(map, 0, 0, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "e" },
  ]);
  return replaceStack(map, 1, 0, 0, [
    { tileId: "grass" },
    { tileId: "sparring-partner" },
  ]);
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
    // Standing next to the same opponent and not fighting it. Seeding is lazy —
    // it happens inside `bodyOf`, on whichever tick first asks — so the ticks
    // are the point: this is silent because seeding is not earning, not because
    // nothing has run yet.
    const session = new GameSession(field(), tiles, {
      actorIds: ["me"],
      seed: 1,
    });
    for (let elapsed = 0; elapsed < 10_000; elapsed += TICK_MS) {
      session.tick(TICK_MS);
    }

    // The masteries are there — the player tile is authored with them — and not
    // one of them was earned.
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

    // Fist, because that is what the fixture swings with. The figure is the one
    // the body actually stands at by the end, which is what would break if a
    // crossing were reported against a stale total.
    expect(heard).toContain(
      `Your fist mastery is now ${levelForXp(session.getSnapshot("me").masteryXp.fist ?? 0)}`,
    );
    // One line per crossing and no more: a mastery that gained experience on
    // ninety of those ticks must not have spoken on eighty-nine of them.
    expect(new Set(heard).size).toBe(heard.length);
  });
});

/**
 * What a chest says when it is opened.
 *
 * The unit tests read the sentence; the session test after them is about the
 * plumbing — that the line is composed at all, that it goes to the taker and to
 * nobody else, and that a second tap on an emptied chest says nothing. A
 * sentence that is perfect and wired to nothing is the more likely failure, and
 * here it is the *only* evidence a reward left: the board is untouched by
 * design.
 */

const named = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  normalizeTileDef({
    name,
    height: 0,
    kind: "prop",
    directional: false,
    variants: { default: [frame] },
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
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
    interactions: {
      battler: {
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
  named("bread", "Bread", {
    kind: "item",
    interactions: { item: DEFAULT_WEAPON },
  }),
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
  map = replaceStack(map, 0, 0, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "e" },
  ]);
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
        rewardTilesById["quest-chest"]!,
        rewardTilesById,
      ),
    ).toBe("You open Quest Chest and receive 1 Hand Lantern, 1 Rusty Sword");
  });

  it("groups repeats into a quantity rather than repeating the name", () => {
    expect(
      rewardNotice(
        reward("Open", ["bread", "bread", "rusty-sword", "bread"]),
        rewardTilesById["quest-chest"]!,
        rewardTilesById,
      ),
    ).toBe("You open Quest Chest and receive 3 Bread, 1 Rusty Sword");
  });

  it("falls back to taking when the author named no gesture", () => {
    expect(
      rewardNotice(
        reward(undefined, ["bread"]),
        rewardTilesById["old-man"]!,
        rewardTilesById,
      ),
    ).toBe("You take Old Man and receive 1 Bread");
  });

  it("drops the second clause for a reward that hands over nothing", () => {
    expect(
      rewardNotice(
        reward("Speak to", []),
        rewardTilesById["old-man"]!,
        rewardTilesById,
      ),
    ).toBe("You speak to Old Man");
  });

  it("says the tile id rather than skipping an item the catalogue lost", () => {
    expect(
      rewardNotice(
        reward("Open", ["ghost-item"]),
        rewardTilesById["quest-chest"]!,
        rewardTilesById,
      ),
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

    // Drained, so a second frame is silent — and the chest is spent, so a second
    // tap has nothing to say either.
    expect(session.drainNotices()).toEqual([]);
    session.interact(CHEST);
    expect(session.drainNotices()).toEqual([]);
  });

  it("says nothing to anybody the reward did not happen to", () => {
    const session = new GameSession(chestBoard(), rewardTiles, {
      actorIds: ["me", "you"],
    });

    // Both are really on the board, or the silence below would prove nothing.
    expect(session.actorIds()).toContain("you");

    expect(session.interact(CHEST, "me")).toBe(true);
    expect(session.drainNotices("you")).toEqual([]);
    expect(session.drainNotices("me")).toHaveLength(1);
  });
});
