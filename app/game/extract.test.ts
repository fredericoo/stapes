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
import { canExtractFrom, extractFits, extractKey, rollExtract } from "./extract";
import { GameSession } from "./GameSession";
import { listInteractionOptions } from "./interactionOptions";

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
    height: 2,
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
  tile({ id: "berry", kind: "item", interactions: { item: { type: "artifact" } } }),
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
    height: 1,
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
  tile({ id: "picked-bush", height: 1 }),
  // The other arrangement: one pull, sometimes nothing, and gone when it is
  // spent. No target at all, which is how a tile says it vanishes.
  tile({
    id: "crystal",
    height: 2,
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
const NOTHING_COOLING = new Set<string>();

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
      contents: Array.from({ length: count }, (_, i) => ({
        id: `itm_filler_${i}`,
        tileId: "berry",
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
      canExtractFrom(
        board(),
        tilesById,
        ME,
        bagWith(0),
        BUSH,
        NOTHING_COOLING,
      ),
    ).toBe(true);
  });

  it("is no once this player is waiting on this very placement", () => {
    const cooling = new Set([extractKey(BUSH, "bush")]);

    expect(
      canExtractFrom(board(), tilesById, ME, bagWith(0), BUSH, cooling),
    ).toBe(false);
  });

  it("is yes while they wait on the same tile in a different cell", () => {
    const cooling = new Set([extractKey({ x: 5, y: 5, z: 0 }, "bush")]);

    expect(
      canExtractFrom(board(), tilesById, ME, bagWith(0), BUSH, cooling),
    ).toBe(true);
  });

  it("is no on a placement whose pulls are spent", () => {
    let map = board();
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "bush", extractsLeft: 0 },
    ]);

    expect(
      canExtractFrom(map, tilesById, ME, bagWith(0), BUSH, NOTHING_COOLING),
    ).toBe(false);
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
      canExtractFrom(
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
    expect(bagTileIds(session)).toEqual(["berry", "berry"]);
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
      extractKey(BUSH, "bush"),
    ]);

    session.tick(COOLDOWN_MS);
    expect(session.getSnapshot().extractCooling).toEqual([]);
  });

  it("leaves the identity of the cooling list alone while nothing changes", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);

    const first = session.getSnapshot().extractCooling;
    session.tick(100);

    // Winding is silent: the renderer gates its whole interaction list on this
    // identity, and a fresh array per tick would rebuild the list thirty times
    // a second for a set that has not moved.
    expect(session.getSnapshot().extractCooling).toBe(first);
  });

  it("charges the wait even on a pull that found nothing", () => {
    const stingy = tiles.map((t) =>
      t.id === "crystal"
        ? tile({
            id: "crystal",
            height: 2,
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

describe("the row it offers", () => {
  function rowsFor(session: GameSession) {
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
      new Set(snap.extractCooling),
    ).filter((option) => option.action === "extract");
  }

  it("is named by the author", () => {
    const session = new GameSession(board(), tiles);

    expect(rowsFor(session).map((o) => o.label)).toEqual(["Pick"]);
  });

  it("falls back to a word a person would use", () => {
    const session = new GameSession(board("crystal"), tiles);

    expect(rowsFor(session).map((o) => o.label)).toEqual(["Gather"]);
  });

  it("goes away while this player is waiting on it", () => {
    const session = new GameSession(board(), tiles);
    session.interact(BUSH);

    expect(rowsFor(session)).toEqual([]);

    session.tick(COOLDOWN_MS);
    expect(rowsFor(session)).toHaveLength(1);
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
