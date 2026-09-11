import { describe, expect, it } from "vitest";
import {
  extractsLeft,
  interactionsForSave,
  resolveExtract,
} from "../lib/interactions";
import { DEFAULT_CONTAINER, DEFAULT_WEAPON } from "../lib/item";
import { emptyMap, getStack, replaceStack, serializeMap } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import type { ObjectRef } from "./affordances";
import { emptyEquipment, type Equipment } from "./equipment";
import {
  canBeginExtract,
  clearExtractReservations,
  extractFits,
  extractKey,
  extractionFraction,
  rollExtract,
  type Extraction,
} from "./extract";
import { GameSession } from "./GameSession";
import {
  listInteractionOptions,
  topInteractionAt,
} from "./interactionOptions";

/**
 * A resource is the one interaction you are *part-way through*, and nearly
 * every test here is about that: a pull is bought with a place at the vein and
 * paid for in seconds of standing still, it hands nothing over until it
 * finishes, and anything that moves or hurts the player takes it off them and
 * gives the vein its pull back.
 */

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

const EXTRACT_MS = 4_000;

/** Shorter than a pull, so a wilting bush always turns mid-pull. */
const WILT_MS = 1_000;

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
  // A consumable rather than an artifact, because only food piles — see
  // `../lib/item`'s `pileMax` — and a bush yielding berries is exactly the case
  // pouring exists for.
  tile({
    id: "berry",
    kind: "item",
    interactions: { item: { type: "consumable", label: "Eat", hp: 0 } },
  }),
  tile({ id: "shard", kind: "item", interactions: { item: { type: "artifact" } } }),
  tile({
    id: BAG_TILE_ID,
    kind: "item",
    interactions: { item: { ...DEFAULT_CONTAINER, size: 4 } },
  }),
  // Two pulls, one certain berry each, and it turns into the picked bush when
  // it is spent — the whole of the bush arrangement, minus the decay that grows
  // it back, which is the picked bush's own business.
  tile({
    id: "bush",
    height: 2,
    interactions: {
      extract: {
        actionName: "Pick",
        durability: 2,
        tileId: "picked-bush",
        durationMs: EXTRACT_MS,
        slots: [{ tileId: "berry", chance: 100 }],
      },
    },
  }),
  tile({ id: "picked-bush", height: 2 }),
  // A bush with a second clock on it, for the one case a pull has to notice:
  // the thing being worked turning into something else while it is being
  // worked. Its lifetime is shorter than a pull, so the swap always wins.
  tile({
    id: "wilting-bush",
    height: 2,
    interactions: {
      extract: {
        actionName: "Pick",
        durability: 2,
        tileId: "picked-bush",
        durationMs: EXTRACT_MS,
        slots: [{ tileId: "berry", chance: 100 }],
      },
      decay: { tileId: "picked-bush", fromMs: WILT_MS, toMs: WILT_MS },
    },
  }),
  // The other arrangement: one pull, sometimes nothing, and gone when it is
  // spent. No target at all, which is how a tile says it vanishes.
  tile({
    id: "crystal",
    height: 4,
    interactions: {
      extract: {
        durability: 1,
        tileId: "",
        durationMs: 0,
        slots: [{ tileId: "shard", chance: 50 }],
      },
    },
  }),
];
const tilesById = tilesByIdFromList(tiles);

const ME = { x: 0, y: 0, z: 0 };
const BUSH: ObjectRef = { x: 1, y: 0, z: 0, stackIndex: 1 };
const NOTHING_EXTRACTING: Extraction | null = null;

/** One pull in progress, as its owner holds it. */
function pulling(
  key: string,
  remainingMs = 2_000,
  durationMs = EXTRACT_MS,
): Extraction {
  return { key, remainingMs, durationMs };
}

/** Somewhere to stand, with something to work beside it. */
function board(resource = "bush"): MapFile {
  let map = emptyMap();
  for (const [x, y] of [
    [0, 0],
    [1, 0],
  ] as const) {
    map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
  }
  map = replaceStack(map, 0, 0, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "s" },
  ]);
  map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: resource }]);
  return map;
}

/** The same board with one pull left in the bush, and nothing free once taken. */
function lastPullBoard(): MapFile {
  return replaceStack(board(), 1, 0, 0, [
    { tileId: "grass" },
    { tileId: "bush", extractsLeft: 1 },
  ]);
}

function bagWith(count: number): Equipment {
  return {
    ...emptyEquipment(),
    bag: {
      id: "itm_bag",
      tileId: BAG_TILE_ID,
      // Shards rather than berries: this means "n squares are taken", and a
      // filler that poured would take one square however many there were.
      contents: Array.from({ length: count }, (_, i) => ({
        id: `itm_filler_${i}`,
        tileId: "shard",
      })),
    },
  };
}

function stackAt(map: MapFile, x: number, y: number) {
  return getStack(map, x, y, 0);
}

function bagTileIds(session: GameSession): string[] {
  return (
    session.getSnapshot().equipment.bag?.contents?.map((i) => i.tileId) ?? []
  );
}

describe("resolving an extract", () => {
  it("is nothing on a tile with no block at all", () => {
    expect(resolveExtract(tilesById.grass)).toBeNull();
  });

  it("is nothing with no yield, because there would be nothing to take", () => {
    const barren = tile({
      id: "barren",
      interactions: {
        extract: { durability: 3, tileId: "", durationMs: 0, slots: [] },
      },
    });

    expect(resolveExtract(barren)).toBeNull();
  });

  it("is nothing with no pulls in it", () => {
    const spent = tile({
      id: "spent",
      interactions: {
        extract: {
          durability: 0,
          tileId: "",
          durationMs: 0,
          slots: [{ tileId: "berry", chance: 100 }],
        },
      },
    });

    expect(resolveExtract(spent)).toBeNull();
  });

  it("keeps a blank target, which is how a resource says it vanishes", () => {
    expect(resolveExtract(tilesById.crystal)?.tileId).toBe("");
  });

  it("drops one malformed slot rather than the whole block", () => {
    const typo = tile({
      id: "typo",
      interactions: {
        extract: {
          durability: 1,
          tileId: "",
          durationMs: 0,
          slots: [
            { tileId: "berry", chance: 100 },
            { tileId: "shard", chance: "lots" },
          ],
        },
      },
    });

    expect(resolveExtract(typo)?.slots).toEqual([
      { tileId: "berry", chance: 100 },
    ]);
  });
});

describe("what is left in a placement", () => {
  it("is the def's count on one nobody has touched", () => {
    const extract = resolveExtract(tilesById.bush)!;

    expect(extractsLeft({ tileId: "bush" }, extract)).toBe(2);
  });

  it("is the placement's count once somebody has", () => {
    const extract = resolveExtract(tilesById.bush)!;

    expect(extractsLeft({ tileId: "bush", extractsLeft: 1 }, extract)).toBe(1);
  });

  it("is clamped to the def, so lowering it shortens veins already started", () => {
    const extract = resolveExtract(tilesById.bush)!;

    expect(extractsLeft({ tileId: "bush", extractsLeft: 9 }, extract)).toBe(2);
  });
});

describe("whether a pull is on offer", () => {
  it("is yes beside a full resource with room to carry what comes out", () => {
    expect(
      canBeginExtract(board(), tilesById, ME, bagWith(0), BUSH, NOTHING_EXTRACTING),
    ).toBe(true);
  });

  it("is no while this player is already pulling at this very placement", () => {
    const mine = pulling(extractKey(BUSH, "bush"));

    expect(canBeginExtract(board(), tilesById, ME, bagWith(0), BUSH, mine)).toBe(
      false,
    );
  });

  it("is yes while they are pulling at the same tile in a different cell", () => {
    const elsewhere = pulling(extractKey({ x: 5, y: 5, z: 0 }, "bush"));

    expect(
      canBeginExtract(board(), tilesById, ME, bagWith(0), BUSH, elsewhere),
    ).toBe(true);
  });

  it("is no once everything left in it is somebody else's pull", () => {
    let map = board();
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      // Two pulls in the def, both spoken for.
      { tileId: "bush", extractsReserved: 2 },
    ]);

    expect(
      canBeginExtract(map, tilesById, ME, bagWith(0), BUSH, NOTHING_EXTRACTING),
    ).toBe(false);
  });

  it("is yes while somebody else holds one of two", () => {
    let map = board();
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "bush", extractsReserved: 1 },
    ]);

    expect(
      canBeginExtract(map, tilesById, ME, bagWith(0), BUSH, NOTHING_EXTRACTING),
    ).toBe(true);
  });

  it("is no on a placement whose pulls are spent", () => {
    let map = board();
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "bush", extractsLeft: 0 },
    ]);

    expect(
      canBeginExtract(map, tilesById, ME, bagWith(0), BUSH, NOTHING_EXTRACTING),
    ).toBe(false);
  });

  it("pours into a pile already in the bag rather than asking for a square", () => {
    // Three squares of four are taken, and a pull could yield three berries —
    // but the fourth square holds berries already, so they all pour into it.
    const bag: Equipment = {
      ...emptyEquipment(),
      bag: {
        id: "itm_bag",
        tileId: BAG_TILE_ID,
        contents: [
          { id: "itm_a", tileId: "shard" },
          { id: "itm_b", tileId: "shard" },
          { id: "itm_c", tileId: "shard" },
          { id: "itm_d", tileId: "berry" },
        ],
      },
    };

    expect(canBeginExtract(board(), tilesById, ME, bag, BUSH, NOTHING_EXTRACTING)).toBe(
      true,
    );
  });

  it("is no when the pile it would pour into is already full", () => {
    // A berry's default pile is eight, so a full one takes no more — and with
    // every other square spoken for there is nowhere else for one to go.
    const bag: Equipment = {
      ...emptyEquipment(),
      bag: {
        id: "itm_bag",
        tileId: BAG_TILE_ID,
        contents: [
          { id: "itm_a", tileId: "shard" },
          { id: "itm_b", tileId: "shard" },
          { id: "itm_c", tileId: "shard" },
          { id: "itm_d", tileId: "berry", count: 8 },
        ],
      },
    };

    expect(canBeginExtract(board(), tilesById, ME, bag, BUSH, NOTHING_EXTRACTING)).toBe(
      false,
    );
  });

  it("is no with no room for everything the pull could hand back", () => {
    // Four squares, three of them full, and a resource that could yield two.
    const generous = resolveExtract(
      tile({
        id: "generous",
        interactions: {
          extract: {
            durability: 1,
            tileId: "",
            durationMs: 0,
            slots: [
              { tileId: "berry", chance: 100 },
              { tileId: "shard", chance: 1 },
            ],
          },
        },
      }),
    )!;

    expect(extractFits(generous, tilesById, bagWith(3))).toBe(false);
    expect(extractFits(generous, tilesById, bagWith(2))).toBe(true);
  });

  it("is no with no bag at all", () => {
    expect(
      canBeginExtract(
        board(),
        tilesById,
        ME,
        emptyEquipment(),
        BUSH,
        NOTHING_EXTRACTING,
      ),
    ).toBe(false);
  });

  it("is no where a slot names something that cannot be carried", () => {
    const scenery = resolveExtract(
      tile({
        id: "scenery-source",
        interactions: {
          extract: {
            durability: 1,
            tileId: "",
            durationMs: 0,
            slots: [{ tileId: "grass", chance: 100 }],
          },
        },
      }),
    )!;

    expect(extractFits(scenery, tilesById, bagWith(0))).toBe(false);
  });
});

describe("rolling a pull", () => {
  it("draws for every slot, whatever has already come up", () => {
    const draws: number[] = [];
    const extract = resolveExtract(
      tile({
        id: "three",
        interactions: {
          extract: {
            durability: 1,
            tileId: "",
            durationMs: 0,
            slots: [
              { tileId: "berry", chance: 100 },
              { tileId: "berry", chance: 0 },
              { tileId: "shard", chance: 100 },
            ],
          },
        },
      }),
    )!;

    const yielded = rollExtract(extract, () => {
      draws.push(draws.length);
      return 0.5;
    });

    // Three draws for three slots, and the same three whatever the dice say —
    // a skipped draw would change what the next creature in the world rolled.
    expect(draws).toHaveLength(3);
    expect(yielded).toEqual(["berry", "shard"]);
  });

  it("can come up empty, which is a pull that found nothing", () => {
    const extract = resolveExtract(tilesById.crystal)!;

    expect(rollExtract(extract, () => 0.99)).toEqual([]);
  });
});

describe("how far through a pull", () => {
  /** Past the end or before the start, as two unsynchronised clocks leave it. */
  const OVERSHOOT_MS = 100;

  it("runs from nothing to done", () => {
    const at = (remainingMs: number) =>
      extractionFraction({ remainingMs, durationMs: EXTRACT_MS });

    expect(at(EXTRACT_MS)).toBe(0);
    expect(at(EXTRACT_MS / 4)).toBe(0.75);
    expect(at(0)).toBe(1);
  });

  it("stays inside the bar when a clock overshoots", () => {
    const at = (remainingMs: number) =>
      extractionFraction({ remainingMs, durationMs: EXTRACT_MS });

    expect(at(-OVERSHOOT_MS)).toBe(1);
    expect(at(EXTRACT_MS + OVERSHOOT_MS)).toBe(0);
  });

  it("calls a pull authored at no time at all done", () => {
    expect(extractionFraction({ remainingMs: 0, durationMs: 0 })).toBe(1);
  });
});

describe("making a pull", () => {
  /**
   * The whole of the redesign in one assertion: the tap buys a place at the
   * vein and nothing else. A player who taps and walks away has spent nothing
   * and has nothing.
   */
  it("hands nothing over on the tap", () => {
    const session = new GameSession(board(), tiles);

    expect(session.interact(BUSH)).toBe(true);

    expect(bagTileIds(session)).toEqual([]);
    expect(stackAt(session.getMap(), 1, 0)[1]).toMatchObject({
      tileId: "bush",
      // The pull is held rather than spent: what is left in the vein has not
      // moved, and what somebody may still start has.
      extractsReserved: 1,
    });
    expect(stackAt(session.getMap(), 1, 0)[1]?.extractsLeft).toBeUndefined();
  });

  it("pays out when the time is up, and gives the hold back with it", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);
    session.tick(EXTRACT_MS);

    expect(bagTileIds(session)).toEqual(["berry"]);
    const placed = stackAt(session.getMap(), 1, 0)[1]!;
    expect(placed.extractsLeft).toBe(1);
    expect(placed.extractsReserved).toBeUndefined();
  });

  /**
   * On the body as well as on the viewer's own channel, because a pull is a
   * thing other people can watch somebody doing.
   */
  it("shows the pull on the body making it, until it lands", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);

    expect(session.getSnapshot().self.extracting).toMatchObject({
      remainingMs: EXTRACT_MS,
      durationMs: EXTRACT_MS,
    });

    session.tick(EXTRACT_MS);
    expect(session.getSnapshot().self.extracting).toBeNull();
  });

  it("hands nothing over one tick early", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);
    session.tick(EXTRACT_MS - 100);

    expect(bagTileIds(session)).toEqual([]);
  });

  /**
   * The check and the run are the same function, which is what this is really
   * asserting: a pull that was allowed because it could pour has to actually
   * pour, or the two halves disagree and the kit ends up somewhere the row never
   * promised.
   */
  it("pours what came up into a pile already there", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);
    session.tick(EXTRACT_MS);
    session.interact(BUSH);
    session.tick(EXTRACT_MS);

    const contents = session.getSnapshot().equipment.bag?.contents ?? [];
    expect(contents).toHaveLength(1);
    expect(contents[0].tileId).toBe("berry");
    // Two pulls of one certain berry each, in one square rather than two.
    expect(contents[0].count).toBe(2);
  });

  it("turns the placement into what the author named once it is spent", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);
    session.tick(EXTRACT_MS);
    session.interact(BUSH);
    session.tick(EXTRACT_MS);

    const placed = stackAt(session.getMap(), 1, 0)[1]!;
    expect(placed.tileId).toBe("picked-bush");
    // The count goes with the tile it was counting: what this is now has a
    // durability of its own or none at all.
    expect(placed.extractsLeft).toBeUndefined();
    expect(placed.extractsReserved).toBeUndefined();
    expect(bagTileIds(session)).toEqual(["berry"]);
  });

  it("removes the placement where the author named nothing", () => {
    const session = new GameSession(board("crystal"), tiles);

    expect(session.interact(BUSH)).toBe(true);

    expect(stackAt(session.getMap(), 1, 0).map((p) => p.tileId)).toEqual([
      "grass",
    ]);
  });

  /**
   * A resource authored at zero has nothing to interrupt, so it lands on the
   * tap and holds nothing while it does. The crystal fixture is the one.
   */
  it("lands on the tap where the author asked for no time at all", () => {
    const session = new GameSession(board("crystal"), tiles);
    session.interact(BUSH);

    expect(session.getSnapshot().extracting).toBeNull();
  });

  it("refuses a second tap on the vein it is already pulling at", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);

    expect(session.canExtract(BUSH)).toBe(false);
    expect(session.interact(BUSH)).toBe(false);
    // And the pull it already had is untouched — a refused tap must not
    // restart the clock.
    expect(session.getSnapshot().extracting?.remainingMs).toBe(EXTRACT_MS);
  });

  it("says what it is pulling on the snapshot, and stops when it lands", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);

    expect(session.getSnapshot().extracting).toEqual({
      key: extractKey(BUSH, "bush"),
      remainingMs: EXTRACT_MS,
      durationMs: EXTRACT_MS,
    });

    session.tick(EXTRACT_MS);
    expect(session.getSnapshot().extracting).toBeNull();
  });

  it("spends the pull even when it found nothing", () => {
    const stingy = tiles.map((t) =>
      t.id === "crystal"
        ? tile({
            id: "crystal",
            height: 4,
            interactions: {
              extract: {
                durability: 2,
                tileId: "",
                durationMs: EXTRACT_MS,
                // Never comes up, so every pull is a swing at nothing.
                slots: [{ tileId: "shard", chance: 0 }],
              },
            },
          })
        : t,
    );
    const session = new GameSession(board("crystal"), stingy);

    session.interact(BUSH);
    session.tick(EXTRACT_MS);

    expect(bagTileIds(session)).toEqual([]);
    // The seconds went into the swing rather than into what came out of it.
    expect(stackAt(session.getMap(), 1, 0)[1]?.extractsLeft).toBe(1);
  });

  it("is one shared vein: two people may work it and a third may not", () => {
    const session = new GameSession(board(), tiles, {
      actorIds: ["a", "b", "c"],
    });

    // Two pulls in the bush, and the first two takers hold one each.
    expect(session.interact(BUSH, "a")).toBe(true);
    expect(session.interact(BUSH, "b")).toBe(true);
    expect(stackAt(session.getMap(), 1, 0)[1]?.extractsReserved).toBe(2);

    // The third finds a bush that is standing there with nothing left to
    // promise — which is exactly what the greyed row says.
    expect(session.canExtract(BUSH, "c")).toBe(false);
  });

  it("lets two people each come away with what they mined", () => {
    const session = new GameSession(board(), tiles, { actorIds: ["a", "b"] });
    session.interact(BUSH, "a");
    session.interact(BUSH, "b");
    session.tick(EXTRACT_MS);

    expect(session.getSnapshot("a").equipment.bag?.contents).toHaveLength(1);
    expect(session.getSnapshot("b").equipment.bag?.contents).toHaveLength(1);
    // Both pulls landed, so the bush is spent and has become what it becomes.
    expect(stackAt(session.getMap(), 1, 0)[1]?.tileId).toBe("picked-bush");
  });
});

describe("losing a pull", () => {
  it("gives the vein its pull back when the player steps away", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);
    expect(stackAt(session.getMap(), 1, 0)[1]?.extractsReserved).toBe(1);

    session.setInput({ directions: ["w"] });
    session.tick(16);

    expect(session.getSnapshot().extracting).toBeNull();
    expect(stackAt(session.getMap(), 1, 0)[1]?.extractsReserved).toBeUndefined();
    expect(bagTileIds(session)).toEqual([]);
  });

  /**
   * Standing still is the whole rule, and it is one rule rather than a list of
   * the ways a body can move: a step towards the bush ends the pull exactly as
   * a step away from it does. Anything else would be a list with a gap in it
   * the next time a way of moving is added.
   */
  it("ends on any step at all, not only one out of reach", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);

    // South, which keeps the bush a diagonal away and well within reach.
    session.setInput({ directions: ["s"] });
    session.tick(16);

    expect(session.getSnapshot().extracting).toBeNull();
  });

  it("gives it back when the player is hit", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);
    session.drainNotices();

    session.runCommand("/health -1");
    session.tick(16);

    expect(session.getSnapshot().extracting).toBeNull();
    expect(stackAt(session.getMap(), 1, 0)[1]?.extractsReserved).toBeUndefined();
    // Said rather than left to the bar disappearing, which is what a pull that
    // paid out nothing also looks like.
    expect(session.drainNotices()).toContain("You are interrupted");
  });

  it("frees it for the person who was refused a moment ago", () => {
    // One pull left in the bush and one taker, so there is nothing free.
    const session = new GameSession(lastPullBoard(), tiles, {
      actorIds: ["a", "b"],
    });

    expect(session.interact(BUSH, "a")).toBe(true);
    expect(session.canExtract(BUSH, "b")).toBe(false);

    session.runCommand("/health -1", "a");
    session.tick(16);

    expect(session.canExtract(BUSH, "b")).toBe(true);
  });

  it("gives it back when the thing being worked becomes something else", () => {
    // The wilting bush is the same bush with a second clock on it: `a` starts a
    // pull, the tile turns under them a second later, and what they were
    // working is not there any more. Somebody else's last pull, an editor save
    // and a decay all look exactly like this.
    const session = new GameSession(board("wilting-bush"), tiles);
    const key = extractKey(BUSH, "wilting-bush");
    session.interact(BUSH);
    expect(session.getSnapshot().extracting?.key).toBe(key);

    session.tick(WILT_MS);

    expect(stackAt(session.getMap(), 1, 0)[1]?.tileId).toBe("picked-bush");
    // Same tick: the pull is wound after decay has turned whatever it turns.
    expect(session.getSnapshot().extracting).toBeNull();
    expect(bagTileIds(session)).toEqual([]);
  });

  /**
   * A player who taps a second crystal has said which one they want. Making
   * them walk away to say so would be a refusal with nothing on screen
   * explaining it.
   */
  it("is abandoned, hold and all, by a tap on a different vein", () => {
    let map = board();
    map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }, { tileId: "bush" }]);
    const other: ObjectRef = { x: 0, y: 1, z: 0, stackIndex: 1 };
    const session = new GameSession(map, tiles);

    session.interact(BUSH);
    session.interact(other);

    expect(stackAt(session.getMap(), 1, 0)[1]?.extractsReserved).toBeUndefined();
    expect(stackAt(session.getMap(), 0, 1)[1]?.extractsReserved).toBe(1);
    expect(session.getSnapshot().extracting?.key).toBe(
      extractKey(other, "bush"),
    );
  });

  it("gives it back when the body leaves the board", () => {
    const session = new GameSession(board(), tiles, { actorIds: ["a", "b"] });
    session.interact(BUSH, "a");

    session.despawn("a");

    expect(stackAt(session.getMap(), 1, 0)[1]?.extractsReserved).toBeUndefined();
  });
});

describe("what it says afterwards", () => {
  /**
   * The line and the button have to agree, and this is what holds them
   * together: an author writes one verb, and a player who pressed "Mine" being
   * told they *worked* the crystal has been given two names for one act.
   */
  it("uses the author's verb, the same one the row is named for", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);
    session.tick(EXTRACT_MS);

    // The names are the fixture's ids — see `tile` above, which defaults one.
    expect(session.drainNotices()).toEqual(["You pick bush and take 1 berry"]);
  });

  it("falls back to the row's own fallback, lowercased", () => {
    // The crystal names no verb, so its row reads "Gather" and its line has to
    // read "gather" rather than some third word.
    const session = new GameSession(board("crystal"), tiles);
    session.interact(BUSH);

    expect(session.drainNotices()[0]).toMatch(/^You gather crystal /);
  });

  it("says so when a pull found nothing, rather than saying nothing", () => {
    const stingy = tiles.map((t) =>
      t.id === "crystal"
        ? tile({
            id: "crystal",
            name: "Arcane Crystal",
            height: 4,
            interactions: {
              extract: {
                actionName: "Mine",
                durability: 2,
                tileId: "",
                durationMs: 0,
                slots: [{ tileId: "shard", chance: 0 }],
              },
            },
          })
        : t,
    );
    const session = new GameSession(board("crystal"), stingy);
    session.interact(BUSH);

    expect(session.drainNotices()).toEqual([
      "You mine Arcane Crystal and find nothing",
    ]);
  });

  it("counts a pile rather than listing it", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);
    session.tick(EXTRACT_MS);
    session.drainNotices();
    session.interact(BUSH);
    session.tick(EXTRACT_MS);

    // The second berry pours into the first, and the line is about what this
    // pull gave rather than about what the bag now holds.
    expect(session.drainNotices()).toEqual(["You pick bush and take 1 berry"]);
  });
});

describe("the row it offers", () => {
  function optionsFor(session: GameSession, equipment?: Equipment) {
    const snap = session.getSnapshot();
    return listInteractionOptions(
      snap.map,
      tilesById,
      snap.self,
      [],
      null,
      equipment ?? snap.equipment,
      null,
      snap.tags,
      false,
      snap.extracting,
    );
  }

  function rowsFor(session: GameSession, equipment?: Equipment) {
    return optionsFor(session, equipment).filter(
      (option) => option.action === "extract",
    );
  }

  it("is named by the author", () => {
    const session = new GameSession(board(), tiles);

    expect(rowsFor(session).map((o) => o.label)).toEqual(["Pick"]);
  });

  it("falls back to a word a person would use", () => {
    const session = new GameSession(board("crystal"), tiles);

    expect(rowsFor(session).map((o) => o.label)).toEqual(["Gather"]);
  });

  /**
   * The row stays and goes grey rather than disappearing, and this is the whole
   * argument for the `blocked` field: a player who did nothing and watched a
   * row vanish has been told nothing, where one looking at a greyed row with a
   * bar across it can see how much longer.
   */
  it("stays while this player is pulling at it, carrying the pull", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);

    const [row] = rowsFor(session);
    expect(row.label).toBe("Pick");
    expect(row.blocked).toEqual({
      kind: "working",
      extraction: {
        key: extractKey(BUSH, "bush"),
        remainingMs: EXTRACT_MS,
        durationMs: EXTRACT_MS,
      },
    });
  });

  it("reports how far through the pull it is, so a bar can be drawn", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);
    session.tick(EXTRACT_MS / 2);

    const [row] = rowsFor(session);
    expect(row.blocked).toEqual({
      kind: "working",
      extraction: expect.objectContaining({ remainingMs: EXTRACT_MS / 2 }),
    });
  });

  it("comes back ready once the pull has landed", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);
    session.tick(EXTRACT_MS);

    expect(rowsFor(session)[0].blocked).toBeNull();
  });

  /**
   * A crystal standing there that somebody else is mining is still a crystal,
   * so the row stays and says who has it rather than vanishing under a player
   * who did nothing.
   */
  it("stays while somebody else holds every pull, saying it is in use", () => {
    const session = new GameSession(board(), tiles, { actorIds: ["a", "b"] });
    session.interact(BUSH, "a");
    session.interact(BUSH, "b");

    const snap = session.getSnapshot("b");
    // A third pair of eyes: `b` holds one of the two, so what they see on the
    // row is their own pull. The list built for somebody holding neither is
    // what says "in use".
    const rows = listInteractionOptions(
      snap.map,
      tilesById,
      snap.self,
      [],
      null,
      snap.equipment,
      null,
      snap.tags,
      false,
      null,
    ).filter((option) => option.action === "extract");

    expect(rows[0].blocked).toEqual({ kind: "taken" });
  });

  /**
   * The same argument as the pull, for the refusal that used to be silent. A
   * player with a full bag walked up to a bush and found no row on it at all,
   * which reads as a broken bush — the one thing they cannot do anything about
   * — rather than as a full bag, which they can.
   */
  it("stays with a full bag, saying that is what is in the way", () => {
    const session = new GameSession(board(), tiles);

    const [row] = rowsFor(session, bagWith(4));
    expect(row.label).toBe("Pick");
    expect(row.blocked).toEqual({ kind: "noRoom" });
  });

  it("stays with no bag at all, on the same terms", () => {
    const session = new GameSession(board(), tiles);

    expect(rowsFor(session, emptyEquipment())[0].blocked).toEqual({
      kind: "noRoom",
    });
  });

  it("comes back ready once a square is free", () => {
    const session = new GameSession(board(), tiles);

    expect(rowsFor(session, bagWith(3))[0].blocked).toBeNull();
  });

  /**
   * The pull in progress is what the row is drawing, and everything else about
   * it is beside the point while it runs.
   */
  it("names the pull ahead of the bag when both are true", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);

    expect(rowsFor(session, bagWith(4))[0].blocked).toMatchObject({
      kind: "working",
    });
  });

  /**
   * Presentation, never permission: the row is drawn and the pull is still
   * refused by the session — and by the server behind it.
   */
  it("is offered without the pull being allowed", () => {
    const session = new GameSession(board(), tiles);

    expect(rowsFor(session, bagWith(4))).toHaveLength(1);
    expect(
      canBeginExtract(
        board(),
        tilesById,
        ME,
        bagWith(4),
        BUSH,
        NOTHING_EXTRACTING,
      ),
    ).toBe(false);
  });

  it("is passed over by the tap while the bag is full", () => {
    const session = new GameSession(board(), tiles);

    expect(
      topInteractionAt(optionsFor(session, bagWith(4)), BUSH),
    ).toBeNull();
  });

  /**
   * The pointer and the list are one list, so a row nothing can press must not
   * be the row a tap on the world runs — otherwise the outline lights up over a
   * bush and clicking it does nothing.
   */
  it("is passed over by the tap while the pull is being made", () => {
    const session = new GameSession(board(), tiles);
    expect(topInteractionAt(optionsFor(session), BUSH)?.action).toBe("extract");

    session.interact(BUSH);
    expect(topInteractionAt(optionsFor(session), BUSH)).toBeNull();

    session.tick(EXTRACT_MS);
    expect(topInteractionAt(optionsFor(session), BUSH)?.action).toBe("extract");
  });

  it("keeps the pull's identity while it merely runs down", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);

    const first = session.getSnapshot().extracting;
    session.tick(100);

    // The renderer gates its whole interaction list on this identity, so a
    // fresh object per tick would rebuild the list thirty times a second to
    // redraw a bar CSS is already animating. It is wound in place.
    expect(session.getSnapshot().extracting).toBe(first);
    expect(first?.remainingMs).toBe(EXTRACT_MS - 100);
  });

  /**
   * The pull is wound by the tick loop and by nothing else, so a world that
   * fell asleep under one would leave the bar frozen and the vein's hold with
   * it. Exactly the clause a cooling stone has, and sharper: somebody is
   * standing there waiting to be paid.
   */
  it("holds the world awake until the pull lands", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);

    expect(session.isAtRest()).toBe(false);

    session.tick(EXTRACT_MS);
    expect(session.isAtRest()).toBe(true);
  });
});

describe("saving an extract", () => {
  it("drops a slot nobody filled in", () => {
    const saved = interactionsForSave({
      extract: {
        actionName: " Mine ",
        durability: 3,
        tileId: " crystal ",
        durationMs: 1000,
        slots: [
          { tileId: "shard", chance: 40 },
          { tileId: "  ", chance: 100 },
        ],
      },
    });

    expect(saved?.extract).toEqual({
      actionName: "Mine",
      durability: 3,
      tileId: "crystal",
      durationMs: 1000,
      slots: [{ tileId: "shard", chance: 40 }],
    });
  });

  it("drops the block entirely when nothing is left to give", () => {
    const saved = interactionsForSave({
      extract: {
        durability: 3,
        tileId: "",
        durationMs: 0,
        slots: [{ tileId: "", chance: 100 }],
      },
    });

    expect(saved).toBeUndefined();
  });

  it("keeps a blank target, which is not the same as an unfilled one", () => {
    const saved = interactionsForSave({
      extract: {
        durability: 1,
        tileId: "",
        durationMs: 0,
        slots: [{ tileId: "shard", chance: 100 }],
      },
    });

    expect(saved?.extract?.tileId).toBe("");
  });
});

describe("what a map remembers", () => {
  it("keeps how much is left across a cell patch", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);
    session.tick(EXTRACT_MS);

    // The map is what the checkpoint stores and what a patch carries, so this
    // is the whole of "everybody sees the same vein".
    expect(stackAt(session.getMap(), 1, 0)[1]?.extractsLeft).toBe(1);
  });

  it("carries the hold too, so everybody sees what is spoken for", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);

    // A reservation nobody else could see would be a vein that refused the
    // second person with nothing on screen saying why.
    expect(stackAt(session.getMap(), 1, 0)[1]?.extractsReserved).toBe(1);
  });

  it("does not write either into an authored map", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);
    session.tick(EXTRACT_MS);
    session.interact(BUSH);

    // A state of play, not something anybody typed: a map saved after an
    // afternoon of picking must not arrive claiming the author meant those
    // bushes to be half picked, still less that somebody is standing at one.
    const saved = serializeMap(session.getMap());
    expect(saved).not.toContain("extractsLeft");
    expect(saved).not.toContain("extractsReserved");
  });

  /**
   * A checkpoint can only have been written while somebody was mid-pull, and
   * there is nobody mid-anything in a world that is only now starting. Left in,
   * those holds would be held by nobody until the vein respawned.
   */
  it("drops every hold as a world loads", () => {
    let map = board();
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "bush", extractsLeft: 2, extractsReserved: 2 },
    ]);

    const cleared = clearExtractReservations(map);
    expect(getStack(cleared, 1, 0, 0)[1]).toEqual({
      tileId: "bush",
      extractsLeft: 2,
    });

    // And a session built on that map offers the row, rather than refusing it
    // on behalf of people who left.
    expect(new GameSession(map, tiles).canExtract(BUSH)).toBe(true);
  });

  it("leaves a map with nothing held exactly as it was", () => {
    const map = board();

    expect(clearExtractReservations(map)).toBe(map);
  });
});
