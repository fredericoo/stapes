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
  canWorkNow,
  extractFits,
  extractKey,
  rollExtract,
  type ExtractCooling,
} from "./extract";
import { GameSession } from "./GameSession";
import {
  listInteractionOptions,
  topInteractionAt,
} from "./interactionOptions";

/**
 * A resource is the one interaction whose two halves belong to different
 * people, and nearly every test here is about that split: the pulls come off the
 * board where everybody shares them, the wait sits on one player where nobody
 * else can see it, and the second person to walk up to a picked bush has to find
 * it exactly as full as the board says it is.
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

const COOLDOWN_MS = 4_000;

const tiles = [
  tile({ id: "grass" }),
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
        cooldownMs: COOLDOWN_MS,
        slots: [{ tileId: "berry", chance: 100 }],
      },
    },
  }),
  tile({ id: "picked-bush", height: 2 }),
  // The other arrangement: one pull, sometimes nothing, and gone when it is
  // spent. No target at all, which is how a tile says it vanishes.
  tile({
    id: "crystal",
    height: 4,
    interactions: {
      extract: {
        durability: 1,
        tileId: "",
        cooldownMs: 0,
        slots: [{ tileId: "shard", chance: 50 }],
      },
    },
  }),
];
const tilesById = tilesByIdFromList(tiles);

const ME = { x: 0, y: 0, z: 0 };
const BUSH: ObjectRef = { x: 1, y: 0, z: 0, stackIndex: 1 };
const NOTHING_COOLING = new Map<string, ExtractCooling>();

/** One wait, as the owner's map holds it. */
function cooling(key: string, remainingMs = 2_000, durationMs = COOLDOWN_MS) {
  return new Map([[key, { key, remainingMs, durationMs }]]);
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
        extract: { durability: 3, tileId: "", cooldownMs: 0, slots: [] },
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
          cooldownMs: 0,
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
          cooldownMs: 0,
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
      canWorkNow(board(), tilesById, ME, bagWith(0), BUSH, NOTHING_COOLING),
    ).toBe(true);
  });

  it("is no once this player is waiting on this very placement", () => {
    const waits = cooling(extractKey(BUSH, "bush"));

    expect(canWorkNow(board(), tilesById, ME, bagWith(0), BUSH, waits)).toBe(
      false,
    );
  });

  it("is yes while they wait on the same tile in a different cell", () => {
    const waits = cooling(extractKey({ x: 5, y: 5, z: 0 }, "bush"));

    expect(canWorkNow(board(), tilesById, ME, bagWith(0), BUSH, waits)).toBe(
      true,
    );
  });

  it("is no on a placement whose pulls are spent", () => {
    let map = board();
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "bush", extractsLeft: 0 },
    ]);

    expect(
      canWorkNow(map, tilesById, ME, bagWith(0), BUSH, NOTHING_COOLING),
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

    expect(canWorkNow(board(), tilesById, ME, bag, BUSH, NOTHING_COOLING)).toBe(
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

    expect(canWorkNow(board(), tilesById, ME, bag, BUSH, NOTHING_COOLING)).toBe(
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
            cooldownMs: 0,
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
      canWorkNow(
        board(),
        tilesById,
        ME,
        emptyEquipment(),
        BUSH,
        NOTHING_COOLING,
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
            cooldownMs: 0,
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
            cooldownMs: 0,
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

describe("taking a pull", () => {
  /**
   * The check and the run are the same function, which is what this is really
   * asserting: a pull that was allowed because it could pour has to actually
   * pour, or the two halves disagree and the kit ends up somewhere the row never
   * promised.
   */
  it("pours what came up into a pile already there", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);
    session.tick(COOLDOWN_MS);
    session.interact(BUSH);

    const contents = session.getSnapshot().equipment.bag?.contents ?? [];
    expect(contents).toHaveLength(1);
    expect(contents[0].tileId).toBe("berry");
    // Two pulls of one certain berry each, in one square rather than two.
    expect(contents[0].count).toBe(2);
  });

  it("puts what came up in the bag and takes a pull off the board", () => {
    const session = new GameSession(board(), tiles);

    expect(session.interact(BUSH)).toBe(true);

    expect(bagTileIds(session)).toEqual(["berry"]);
    expect(stackAt(session.getMap(), 1, 0)[1]).toMatchObject({
      tileId: "bush",
      extractsLeft: 1,
    });
  });

  it("turns the placement into what the author named once it is spent", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);
    // The wait is this player's, so it has to run out before they may pull
    // again. Ticking is what the world does anyway.
    session.tick(COOLDOWN_MS);
    session.interact(BUSH);

    const placed = stackAt(session.getMap(), 1, 0)[1]!;
    expect(placed.tileId).toBe("picked-bush");
    // The count goes with the tile it was counting: what this is now has a
    // durability of its own or none at all.
    expect(placed.extractsLeft).toBeUndefined();
    expect(bagTileIds(session)).toEqual(["berry"]);
  });

  it("removes the placement where the author named nothing", () => {
    const session = new GameSession(board("crystal"), tiles);

    expect(session.interact(BUSH)).toBe(true);

    expect(stackAt(session.getMap(), 1, 0).map((p) => p.tileId)).toEqual([
      "grass",
    ]);
  });

  it("refuses the second pull until this player's wait is up", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);

    expect(session.canExtract(BUSH)).toBe(false);
    expect(session.interact(BUSH)).toBe(false);

    session.tick(COOLDOWN_MS);
    expect(session.canExtract(BUSH)).toBe(true);
  });

  it("says so on the snapshot, and stops saying so when the wait is up", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);

    expect(session.getSnapshot().extractCooling).toEqual([
      {
        key: extractKey(BUSH, "bush"),
        remainingMs: COOLDOWN_MS,
        durationMs: COOLDOWN_MS,
      },
    ]);

    session.tick(COOLDOWN_MS);
    expect(session.getSnapshot().extractCooling).toEqual([]);
  });

  it("charges the wait even on a pull that found nothing", () => {
    const stingy = tiles.map((t) =>
      t.id === "crystal"
        ? tile({
            id: "crystal",
            height: 4,
            interactions: {
              extract: {
                durability: 2,
                tileId: "",
                cooldownMs: COOLDOWN_MS,
                // Never comes up, so every pull is a swing at nothing.
                slots: [{ tileId: "shard", chance: 0 }],
              },
            },
          })
        : t,
    );
    const session = new GameSession(board("crystal"), stingy);

    expect(session.interact(BUSH)).toBe(true);
    expect(bagTileIds(session)).toEqual([]);
    // The durability went into the swing rather than into what came out of it,
    // and a pull that cost nothing when it gave nothing would be a free re-roll.
    expect(stackAt(session.getMap(), 1, 0)[1]?.extractsLeft).toBe(1);
    expect(session.canExtract(BUSH)).toBe(false);
  });

  it("is one shared resource: the wait is the player's, the pulls are not", () => {
    const session = new GameSession(board(), tiles, { actorIds: ["a", "b"] });

    session.interact(BUSH, "a");
    // The bush is down to one pull for everybody, and the person who did not
    // touch it is not waiting on anything.
    expect(stackAt(session.getMap(), 1, 0)[1]?.extractsLeft).toBe(1);
    expect(session.canExtract(BUSH, "b")).toBe(true);
    expect(session.canExtract(BUSH, "a")).toBe(false);
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
                cooldownMs: 0,
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
    session.drainNotices();
    session.tick(COOLDOWN_MS);
    session.interact(BUSH);

    // The second berry pours into the first, and the line is about what this
    // pull gave rather than about what the bag now holds.
    expect(session.drainNotices()).toEqual(["You pick bush and take 1 berry"]);
  });
});

describe("the row it offers", () => {
  function optionsFor(session: GameSession) {
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
      false,
      new Map(snap.extractCooling.map((entry) => [entry.key, entry])),
    );
  }

  function rowsFor(session: GameSession) {
    return optionsFor(session).filter((option) => option.action === "extract");
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
   * argument for the `cooldown` field: a player who did nothing and watched a
   * row vanish has been told nothing, where one looking at a greyed row with a
   * bar under it has been told to wait.
   */
  it("stays while this player is waiting on it, carrying the wait", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);

    const [row] = rowsFor(session);
    expect(row.label).toBe("Pick");
    expect(row.cooldown).toEqual({
      key: extractKey(BUSH, "bush"),
      remainingMs: COOLDOWN_MS,
      durationMs: COOLDOWN_MS,
    });
  });

  it("reports how far through the wait it is, so a bar can be drawn", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);
    session.tick(COOLDOWN_MS / 2);

    expect(rowsFor(session)[0].cooldown?.remainingMs).toBe(COOLDOWN_MS / 2);
  });

  it("comes back ready once the wait is up", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);
    session.tick(COOLDOWN_MS);

    expect(rowsFor(session)[0].cooldown).toBeNull();
  });

  /**
   * The pointer and the list are one list, so a row nothing can press must not
   * be the row a tap on the world runs — otherwise the outline lights up over a
   * bush and clicking it does nothing.
   */
  it("is passed over by the tap, so nothing is outlined while it waits", () => {
    const session = new GameSession(board(), tiles);
    expect(topInteractionAt(optionsFor(session), BUSH)?.action).toBe("extract");

    session.interact(BUSH);
    expect(topInteractionAt(optionsFor(session), BUSH)).toBeNull();

    session.tick(COOLDOWN_MS);
    expect(topInteractionAt(optionsFor(session), BUSH)?.action).toBe("extract");
  });

  it("keeps the list's identity while a wait merely runs down", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);

    const first = session.getSnapshot().extractCooling;
    session.tick(100);

    // The renderer gates its whole interaction list on this identity, so a
    // fresh array per tick would rebuild the list thirty times a second to
    // redraw a bar CSS is already animating. The entry inside is wound in place.
    expect(session.getSnapshot().extractCooling).toBe(first);
    expect(first[0].remainingMs).toBe(COOLDOWN_MS - 100);
  });

  /**
   * The wait is wound by the tick loop and by nothing else, so a world that
   * fell asleep under one would leave the row grey and the bar frozen until
   * somebody happened to move. Exactly the clause a cooling stone has.
   */
  it("holds the world awake until the wait is up", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);

    expect(session.isAtRest()).toBe(false);

    session.tick(COOLDOWN_MS);
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
        cooldownMs: 1000,
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
      cooldownMs: 1000,
      slots: [{ tileId: "shard", chance: 40 }],
    });
  });

  it("drops the block entirely when nothing is left to give", () => {
    const saved = interactionsForSave({
      extract: {
        durability: 3,
        tileId: "",
        cooldownMs: 0,
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
        cooldownMs: 0,
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

    // The map is what the checkpoint stores and what a patch carries, so this
    // is the whole of "everybody sees the same vein".
    expect(stackAt(session.getMap(), 1, 0)[1]?.extractsLeft).toBe(1);
  });

  it("does not write it into an authored map", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);

    // A state of play, not something anybody typed: a map saved after an
    // afternoon of picking must not arrive claiming the author meant those
    // bushes to be half picked.
    expect(serializeMap(session.getMap())).not.toContain("extractsLeft");
  });
});
