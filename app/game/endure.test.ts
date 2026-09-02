import { describe, expect, it } from "vitest";
import statusesJson from "../../data/statuses.json";
import tilesJson from "../../data/tiles.json";
import { resolveAfflict, resolveEndure } from "../lib/interactions";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import { statusesById } from "../lib/status";
import type { Coord, MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { TICK_MS } from "./constants";
import { EndureIndex, applyConsumed, neighboursOf, spreadShares } from "./endure";
import { GameSession } from "./GameSession";
import { Rng } from "./rng";

/**
 * A tile worn down by a status, and what happens to what is left when it goes.
 *
 * The two halves that are the feature: the pool, which is arithmetic over an
 * index and asserted without a world, and the spread, whose whole point is that
 * a fire divides its fuel rather than copying it.
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

/** Fixed ends, so a roll is a constant and every sum below is exact. */
const BURN_MS = 8_000;
/** What `burned` takes off anything with a small enough maximum. */
const BURN_PER_SECOND = 4;
/** Three seconds of fire, so grass goes with five to spare. */
const GRASS_DURABILITY = 12;
/** Longer than one whole burn, so a tree needs two of them or a lucky share. */
const TREE_DURABILITY = 40;

const catalogue = statusesById([
  {
    id: "burned",
    name: "Burned",
    description: "Searing. Hurts fast, and is over fast.",
    tone: "bad",
    fromMs: BURN_MS,
    toMs: BURN_MS,
    stacks: true,
    maxMs: BURN_MS * 3,
    everyMs: 1_000,
    effects: { hp: `0 - ${BURN_PER_SECOND}` },
  },
]);

const tiles: TileDef[] = [
  tile({ id: "dirt" }),
  tile({
    id: "grass",
    interactions: {
      endure: {
        durability: GRASS_DURABILITY,
        suffers: [{ statusId: "burned", tileId: "dirt" }],
      },
    },
  }),
  tile({
    id: "tree",
    height: 4,
    walkable: false,
    interactions: {
      endure: {
        durability: TREE_DURABILITY,
        suffers: [{ statusId: "burned", tileId: "" }],
      },
    },
  }),
  tile({ id: "stone", height: 4, walkable: false }),
  tile({
    id: "flame",
    height: 2,
    intangible: true,
    lightPassing: true,
    interactions: { afflict: { statusId: "burned" } },
  }),
  // A source naming a status nothing in the catalogue holds, and one naming
  // nothing at all.
  tile({
    id: "haunt",
    height: 2,
    intangible: true,
    interactions: { afflict: { statusId: "cursed" } },
  }),
  tile({
    id: "unlit",
    height: 2,
    intangible: true,
    interactions: { afflict: { statusId: "" } },
  }),
  tile({
    id: "player",
    height: 4,
    kind: "battler",
    directional: true,
    walkable: false,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
    interactions: {
      battler: {
        masteries: { toughness: 40 },
        naturalWeapon: {
          type: "weapon",
          damage: 1,
          def: 0,
          accuracy: 50,
          variance: 0,
          spd: 50,
          mastery: "fist",
        },
      },
    },
  }),
];

const tilesById = tilesByIdFromList(tiles);
const BURNED = catalogue.burned!;
const ORIGIN: Coord = { x: 0, y: 0, z: 0 };

function grassEndure() {
  return resolveEndure(tilesById.grass!)!;
}

function run(session: GameSession, ticks: number) {
  for (let i = 0; i < ticks; i++) session.tick(TICK_MS);
}

function stackIds(map: MapFile, x: number, y: number, z = 0): string[] {
  return getStack(map, x, y, z).map((placed) => placed.tileId);
}

/** A board of the given tiles, plus a player parked well out of the way. */
function world(cells: { at: Coord; stack: string[] }[]): MapFile {
  let map = emptyMap();
  for (const { at, stack } of cells) {
    map = replaceStack(
      map,
      at.x,
      at.y,
      at.z,
      stack.map((tileId) => ({ tileId })),
    );
  }
  return replaceStack(map, 9, 9, 0, [
    { tileId: "dirt" },
    { tileId: "player", direction: "s" },
  ]);
}

describe("resolveEndure", () => {
  it("reads an authored block", () => {
    expect(resolveEndure(tilesById.grass!)).toEqual({
      durability: GRASS_DURABILITY,
      suffers: [{ statusId: "burned", tileId: "dirt" }],
    });
  });

  it("keeps a blank target, because that is how a tile says it vanishes", () => {
    expect(resolveEndure(tilesById.tree!)?.suffers[0]?.tileId).toBe("");
  });

  it("refuses a block with no durability in it", () => {
    const inert = tile({
      id: "inert",
      interactions: {
        endure: { durability: 0, suffers: [{ statusId: "burned", tileId: "" }] },
      },
    });
    expect(resolveEndure(inert)).toBeNull();
  });

  it("refuses a pool nothing can spend", () => {
    const inert = tile({
      id: "sealed",
      interactions: { endure: { durability: 10, suffers: [] } },
    });
    expect(resolveEndure(inert)).toBeNull();
  });

  it("is nothing on a tile with no block at all", () => {
    expect(resolveEndure(tilesById.stone!)).toBeNull();
  });
});

describe("resolveAfflict", () => {
  it("reads an authored block", () => {
    expect(resolveAfflict(tilesById.flame!)).toEqual({ statusId: "burned" });
  });

  it("refuses a block naming no status", () => {
    expect(resolveAfflict(tilesById.unlit!)).toBeNull();
  });

  it("is nothing on a tile with no block at all", () => {
    expect(resolveAfflict(tilesById.grass!)).toBeNull();
  });
});

describe("EndureIndex", () => {
  function index() {
    return new EndureIndex(new Rng(1));
  }

  it("holds nothing until something is actually inflicted", () => {
    expect(index().pending()).toBe(false);
  });

  it("refuses a status the tile does not suffer", () => {
    const endure = index();
    const chill = statusesById([
      {
        id: "chilled",
        name: "Chilled",
        description: "Numbing.",
        tone: "bad",
        fromMs: 1_000,
        toMs: 1_000,
        stacks: false,
        maxMs: 1_000,
        everyMs: 1_000,
        effects: { hp: "0 - 1" },
      },
    ]).chilled!;
    expect(
      endure.afflict(ORIGIN, "grass", grassEndure(), chill),
    ).toBe(false);
    expect(endure.pending()).toBe(false);
  });

  it("does not re-roll a status already running, so a sweep costs one draw", () => {
    const endure = index();
    expect(endure.afflict(ORIGIN, "grass", grassEndure(), BURNED)).toBe(true);
    expect(endure.afflict(ORIGIN, "grass", grassEndure(), BURNED)).toBe(false);
    expect(endure.statusesAt(ORIGIN, "grass")).toHaveLength(1);
  });

  it("spends the pool at the status's own cadence", () => {
    const endure = index();
    endure.afflict(ORIGIN, "grass", grassEndure(), BURNED);

    // Two seconds in: two payouts of four, and eight of twelve left.
    for (let i = 0; i < Math.round(2_000 / TICK_MS); i++) {
      expect(endure.advance(TICK_MS, catalogue)).toEqual([]);
    }
    expect([...endure.afflicted()][0]?.hp).toBe(
      GRASS_DURABILITY - BURN_PER_SECOND * 2,
    );
  });

  it("hands back what the placement becomes, and what is left to spread", () => {
    const endure = index();
    endure.afflict(ORIGIN, "grass", grassEndure(), BURNED);

    let consumed = endure.advance(TICK_MS, catalogue);
    const secondsToBurn = GRASS_DURABILITY / BURN_PER_SECOND;
    for (let ms = TICK_MS; consumed.length === 0 && ms < BURN_MS; ms += TICK_MS) {
      consumed = endure.advance(TICK_MS, catalogue);
    }

    expect(consumed).toHaveLength(1);
    expect(consumed[0]?.becomes).toBe("dirt");
    expect(consumed[0]?.statusId).toBe("burned");
    // Whatever the burn had left at that instant — three seconds of fire spent
    // out of eight, so five to hand on, and never more than it started with.
    expect(consumed[0]?.remainingMs).toBeGreaterThan(0);
    expect(consumed[0]?.remainingMs).toBeLessThanOrEqual(
      BURN_MS - secondsToBurn * 1_000 + TICK_MS,
    );
    expect(endure.pending()).toBe(false);
  });

  it("carries the caster and the elements onto what it hands back", () => {
    const endure = index();
    endure.afflict(
      ORIGIN,
      "grass",
      grassEndure(),
      BURNED,
      undefined,
      "arcanist",
      ["fire"],
    );

    let consumed = endure.advance(TICK_MS, catalogue);
    while (consumed.length === 0) consumed = endure.advance(TICK_MS, catalogue);
    expect(consumed[0]?.causedBy).toBe("arcanist");
    expect(consumed[0]?.elements).toEqual(["fire"]);
  });

  it("keeps the damage when a burn ends without finishing the job", () => {
    const endure = index();
    endure.afflict(ORIGIN, "tree", resolveEndure(tilesById.tree!)!, BURNED);

    // A whole burn: eight seconds of four, against a durability of forty.
    for (let ms = 0; ms < BURN_MS + TICK_MS; ms += TICK_MS) {
      endure.advance(TICK_MS, catalogue);
    }
    const pool = [...endure.afflicted()][0];
    expect(pool?.statuses).toHaveLength(0);
    expect(pool?.hp).toBe(TREE_DURABILITY - BURN_PER_SECOND * (BURN_MS / 1_000));
    // Still held, so a flame that sets it alight again finds it scorched.
    expect(endure.pending()).toBe(true);
  });
});

describe("spreadShares", () => {
  const consumed = {
    cell: ORIGIN,
    tileId: "grass",
    statusId: "burned",
    becomes: "dirt",
    remainingMs: 4_000,
  };

  it("divides the remainder rather than copying it", () => {
    const map = world([
      { at: ORIGIN, stack: ["grass"] },
      { at: { x: 1, y: 0, z: 0 }, stack: ["grass"] },
      { at: { x: -1, y: 0, z: 0 }, stack: ["grass"] },
    ]);
    const shares = spreadShares(map, consumed, tilesById);

    expect(shares).toHaveLength(2);
    expect(shares.every((share) => share.shareMs === 2_000)).toBe(true);
    // The whole point: what goes out is never more than what came in.
    const total = shares.reduce((sum, share) => sum + share.shareMs, 0);
    expect(total).toBeLessThanOrEqual(consumed.remainingMs);
  });

  it("skips a neighbour that cannot suffer it", () => {
    const map = world([
      { at: ORIGIN, stack: ["grass"] },
      { at: { x: 1, y: 0, z: 0 }, stack: ["stone"] },
      { at: { x: -1, y: 0, z: 0 }, stack: ["grass"] },
    ]);
    const shares = spreadShares(map, consumed, tilesById);

    expect(shares).toHaveLength(1);
    // Divided by what catches, not by what is there: a fire at the edge of a
    // wood must not lose half its fuel to the stone beside it.
    expect(shares[0]?.shareMs).toBe(consumed.remainingMs);
  });

  it("gives nothing away when nothing around it burns", () => {
    const map = world([{ at: ORIGIN, stack: ["grass"] }]);
    expect(spreadShares(map, consumed, tilesById)).toEqual([]);
  });

  it("lets the last embers go out rather than laying an infinitely thin burn", () => {
    const map = world([
      { at: ORIGIN, stack: ["grass"] },
      { at: { x: 1, y: 0, z: 0 }, stack: ["grass"] },
      { at: { x: -1, y: 0, z: 0 }, stack: ["grass"] },
      { at: { x: 0, y: 1, z: 0 }, stack: ["grass"] },
      { at: { x: 0, y: -1, z: 0 }, stack: ["grass"] },
    ]);
    expect(
      spreadShares(map, { ...consumed, remainingMs: 3 }, tilesById),
    ).toEqual([]);
  });

  it("never reaches diagonally, so a one-cell firebreak holds", () => {
    expect(neighboursOf(ORIGIN)).toEqual([
      { x: 1, y: 0, z: 0 },
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: -1, z: 0 },
    ]);
  });
});

describe("applyConsumed", () => {
  it("turns a placement into what it becomes", () => {
    const map = world([{ at: ORIGIN, stack: ["grass"] }]);
    const { map: next, changed } = applyConsumed(
      map,
      [
        {
          cell: ORIGIN,
          tileId: "grass",
          statusId: "burned",
          becomes: "dirt",
          remainingMs: 0,
        },
      ],
      tilesById,
    );

    expect(stackIds(next, 0, 0)).toEqual(["dirt"]);
    expect(changed).toEqual([ORIGIN]);
  });

  it("removes it entirely when what it becomes is blank", () => {
    const map = world([{ at: ORIGIN, stack: ["dirt", "tree"] }]);
    const { map: next } = applyConsumed(
      map,
      [
        {
          cell: ORIGIN,
          tileId: "tree",
          statusId: "burned",
          becomes: "",
          remainingMs: 0,
        },
      ],
      tilesById,
    );

    expect(stackIds(next, 0, 0)).toEqual(["dirt"]);
  });

  it("leaves the placement alone when the target has left the catalogue", () => {
    const map = world([{ at: ORIGIN, stack: ["grass"] }]);
    const { map: next, changed } = applyConsumed(
      map,
      [
        {
          cell: ORIGIN,
          tileId: "grass",
          statusId: "burned",
          becomes: "ash",
          remainingMs: 0,
        },
      ],
      tilesById,
    );

    expect(stackIds(next, 0, 0)).toEqual(["grass"]);
    expect(changed).toEqual([]);
  });
});

describe("a flame in a world", () => {
  function session(map: MapFile) {
    return new GameSession(map, tiles, { statuses: catalogue });
  }

  it("burns the ground it is standing in", () => {
    const play = session(world([{ at: ORIGIN, stack: ["grass", "flame"] }]));
    expect(stackIds(play.getMap(), 0, 0)).toEqual(["grass", "flame"]);

    run(play, Math.ceil((GRASS_DURABILITY / BURN_PER_SECOND) * 1_000 / TICK_MS) + 2);
    expect(stackIds(play.getMap(), 0, 0)).toEqual(["dirt", "flame"]);
  });

  it("leaves alone what it has nothing to say to", () => {
    const play = session(world([{ at: ORIGIN, stack: ["stone", "flame"] }]));
    run(play, Math.ceil(BURN_MS / TICK_MS) + 2);
    expect(stackIds(play.getMap(), 0, 0)).toEqual(["stone", "flame"]);
  });

  it("inflicts nothing when the catalogue has never heard of the status", () => {
    const play = session(world([{ at: ORIGIN, stack: ["grass", "haunt"] }]));
    run(play, Math.ceil(BURN_MS / TICK_MS) + 2);
    expect(stackIds(play.getMap(), 0, 0)).toEqual(["grass", "haunt"]);
  });

  it("keeps burning, so an eternal flame eventually gets through a tree", () => {
    const play = session(world([{ at: ORIGIN, stack: ["dirt", "tree", "flame"] }]));
    // Longer than one burn, which alone is not enough for a tree — the second
    // application is the thing under test.
    run(play, Math.ceil((BURN_MS * 3) / TICK_MS));
    expect(stackIds(play.getMap(), 0, 0)).toEqual(["dirt", "flame"]);
  });

  it("passes what is left to the grass beside it", () => {
    const play = session(
      world([
        { at: ORIGIN, stack: ["grass", "flame"] },
        { at: { x: 1, y: 0, z: 0 }, stack: ["grass"] },
      ]),
    );
    run(play, Math.ceil((GRASS_DURABILITY / BURN_PER_SECOND) * 1_000 / TICK_MS) + 2);

    // The first cell has gone, and the second is now alight from what was left.
    expect(stackIds(play.getMap(), 0, 0)).toEqual(["dirt", "flame"]);
    run(play, Math.ceil(BURN_MS / TICK_MS));
    expect(stackIds(play.getMap(), 1, 0)).toEqual(["dirt"]);
  });

  it("does not rest while anything is burning", () => {
    const play = session(world([{ at: ORIGIN, stack: ["grass", "flame"] }]));
    play.tick(TICK_MS);
    expect(play.isAtRest()).toBe(false);
  });

  it("rests again once the fire has nothing left to take", () => {
    const play = session(world([{ at: ORIGIN, stack: ["stone", "flame"] }]));
    run(play, Math.ceil(BURN_MS / TICK_MS) + 2);
    expect(play.isAtRest()).toBe(true);
  });
});

/**
 * The authored numbers, against the authored statuses.
 *
 * Everything above runs on a catalogue this file wrote, which is what makes the
 * arithmetic assertable — and is exactly why it cannot catch the failure that
 * actually matters here: `burned` deals `max(4, ceil(MAX_HP / 10))`, so a
 * durability raised past what one burn can spend leaves a tile that catches
 * fire, smoulders and never goes. That is a drift between two files neither of
 * which is wrong on its own, and this is the only test in a position to see it.
 */
describe("the content in data/", () => {
  const authoredTiles = (tilesJson as unknown[]).map((raw) =>
    normalizeTileDef(raw as Record<string, unknown>),
  );
  const authoredStatuses = statusesById(statusesJson as never);

  function board(cells: { at: Coord; stack: string[] }[]): MapFile {
    let map = emptyMap();
    for (const { at, stack } of cells) {
      map = replaceStack(
        map,
        at.x,
        at.y,
        at.z,
        stack.map((tileId) => ({ tileId })),
      );
    }
    return replaceStack(map, 9, 9, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "s" },
    ]);
  }

  function burn(cells: { at: Coord; stack: string[] }[], ms: number) {
    const play = new GameSession(board(cells), authoredTiles, {
      statuses: authoredStatuses,
    });
    run(play, Math.ceil(ms / TICK_MS));
    return play;
  }

  it("burns grass down to dirt under a flame", () => {
    const play = burn([{ at: ORIGIN, stack: ["grass", "flame"] }], 30_000);
    expect(stackIds(play.getMap(), 0, 0)).toEqual(["dirt", "flame"]);
  });

  it("carries into the grass beside it", () => {
    const play = burn(
      [
        { at: ORIGIN, stack: ["grass", "flame"] },
        { at: { x: 1, y: 0, z: 0 }, stack: ["grass"] },
      ],
      30_000,
    );
    expect(stackIds(play.getMap(), 1, 0)).toEqual(["dirt"]);
  });

  it("takes a tree down, given a flame that does not go out", () => {
    const play = burn(
      [{ at: ORIGIN, stack: ["dirt", "tree", "flame"] }],
      60_000,
    );
    expect(stackIds(play.getMap(), 0, 0)).toEqual(["dirt", "flame"]);
  });

  it("leaves cobblestone alone, because nothing in it burns", () => {
    const play = burn([{ at: ORIGIN, stack: ["cobblestone", "flame"] }], 30_000);
    expect(stackIds(play.getMap(), 0, 0)).toEqual(["cobblestone", "flame"]);
    // And the world settles again rather than smouldering forever.
    expect(play.isAtRest()).toBe(true);
  });
});
