import { describe, expect, it } from "vitest";
import { nearest, type BrainDef } from "../lib/brain";
import { emptyMap, removeTileAt, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { BRAIN_TICK_MS, TICK_MS } from "./constants";
import { GameSession } from "./GameSession";
import {
  cellRefId,
  cellRefStillHolds,
  indexTileCells,
  parseCellRef,
  reindexTileCell,
} from "./tileIndex";

/**
 * Walking to a thing rather than to somebody.
 *
 * A selector names a tile, and until now only tiles something was *driving*
 * could answer — an oak is not an actor, so "the nearest oak" resolved to
 * nobody. Two halves to closing that: an index so the question is a lookup
 * rather than a board sweep, and an identity for a cell so the answer can travel
 * through the same blackboard a chase already uses.
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
  return normalizeTileDef({
    name: partial.id,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    ...partial,
  });
}

/** Walk to the nearest oak and stay there. */
const FORAGER: BrainDef = {
  initial: "seeking",
  states: {
    seeking: {
      do: [
        { action: "step_toward", of: nearest("oak") },
        { action: "hold" },
      ],
    },
  },
  transitions: [],
};

const TILES: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "oak", height: 2, walkable: false }),
  tile({
    id: "player",
    height: 2,
    directional: true,
    walkable: false,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
  }),
  tile({
    id: "boar",
    height: 1,
    actor: true,
    affectedByGravity: true,
    walkable: false,
    interactions: { brain: FORAGER },
  }),
];

/** Grass everywhere, plus whatever the test puts on it. */
function field(...placed: [string, number, number][]): MapFile {
  let map = emptyMap();
  for (let x = -8; x <= 8; x++) {
    for (let y = -8; y <= 8; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  for (const [tileId, x, y] of placed) {
    map = replaceStack(map, x, y, 0, [{ tileId: "grass" }, { tileId }]);
  }
  return map;
}

function session(map: MapFile): GameSession {
  // Somebody has to be connected or every brain in the world freezes, so the
  // player stands in the far corner where nothing here can notice them.
  const withPlayer = replaceStack(map, -8, -8, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "e", owner: "alice" },
  ]);
  return new GameSession(withPlayer, TILES, ["alice"], {
    x: 8,
    y: 8,
    z: 0,
    stackIndex: 1,
  });
}

function advance(s: GameSession, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) s.tick(TICK_MS);
}

function boarAt(s: GameSession) {
  return s.actorSnapshots().find((actor) => actor.tileId === "boar")!;
}

describe("indexing where each tile is", () => {
  it("finds every placement of a tile, and nothing it is not", () => {
    const index = indexTileCells(field(["oak", 2, 0], ["oak", -3, 4]));

    expect([...(index.get("oak")?.keys() ?? [])].sort()).toEqual([
      "-3,4,0",
      "2,0,0",
    ]);
    expect(index.get("boar")).toBeUndefined();
  });

  /**
   * The index is derived, never authored — which is the point of it. A tile
   * invented after this code was written is findable the moment one is placed.
   */
  it("takes a tile nothing in the code has heard of", () => {
    let map = emptyMap();
    map = replaceStack(map, 1, 1, 0, [{ tileId: "brand-new-thing" }]);

    expect([...indexTileCells(map).get("brand-new-thing")!.keys()]).toEqual([
      "1,1,0",
    ]);
  });

  it("forgets a cell whose stack no longer holds that tile", () => {
    let map = field(["oak", 2, 0]);
    const index = indexTileCells(map);
    expect(index.get("oak")?.size).toBe(1);

    map = removeTileAt(map, 2, 0, 0, 1);
    reindexTileCell(index, map, { x: 2, y: 0, z: 0 });

    expect(index.get("oak")?.size).toBe(0);
  });

  it("picks up a tile that has just been put down", () => {
    let map = field();
    const index = indexTileCells(map);

    map = replaceStack(map, 2, 0, 0, [{ tileId: "grass" }, { tileId: "oak" }]);
    reindexTileCell(index, map, { x: 2, y: 0, z: 0 });

    expect([...index.get("oak")!.keys()]).toEqual(["2,0,0"]);
  });
});

describe("a cell that answers to a name", () => {
  it("round-trips a tile and its cell", () => {
    const id = cellRefId("oak", { x: -3, y: 4, z: 1 });
    expect(parseCellRef(id)).toEqual({
      tileId: "oak",
      cell: { x: -3, y: 4, z: 1 },
    });
  });

  /** An actor id must not be mistaken for one of these. */
  it("does not answer for an actor id", () => {
    expect(parseCellRef("alice")).toBeNull();
    expect(parseCellRef("npc:1,2,0,1")).toBeNull();
  });

  /**
   * The reason a ref names its tile rather than only its cell. A felled oak is
   * gone, and a creature still heading for the stump would be following a memory
   * the world no longer holds — so the ref stops resolving, which reads to every
   * condition above it as a target that left, exactly like an actor who did.
   */
  it("stops holding once that tile is off the cell", () => {
    let map = field(["oak", 2, 0]);
    const ref = { tileId: "oak", cell: { x: 2, y: 0, z: 0 } };
    expect(cellRefStillHolds(map, ref)).toBe(true);

    map = removeTileAt(map, 2, 0, 0, 1);

    expect(cellRefStillHolds(map, ref)).toBe(false);
  });

  /** A different tile moving into the cell is not the one that was named. */
  it("is not satisfied by whatever else turns up in the cell", () => {
    const map = field(["boar", 2, 0]);
    expect(
      cellRefStillHolds(map, { tileId: "oak", cell: { x: 2, y: 0, z: 0 } }),
    ).toBe(false);
  });
});

describe("walking to a thing", () => {
  it("closes on the nearest oak", () => {
    const s = session(field(["boar", 0, 0], ["oak", 5, 0]));
    expect(boarAt(s).x).toBe(0);

    advance(s, BRAIN_TICK_MS * 6);

    // Beside it rather than on it — an oak is solid, so the last step is refused
    // and the creature settles against the trunk.
    expect(boarAt(s).x).toBeGreaterThan(2);
    expect(boarAt(s).y).toBe(0);
  });

  it("prefers the nearer of two", () => {
    const s = session(field(["boar", 0, 0], ["oak", 6, 0], ["oak", -3, 0]));

    advance(s, BRAIN_TICK_MS * 4);

    expect(boarAt(s).x).toBeLessThan(0);
  });

  it("stands still in a world with no oak in it at all", () => {
    const s = session(field(["boar", 0, 0]));

    advance(s, BRAIN_TICK_MS * 4);

    expect(boarAt(s).x).toBe(0);
    expect(boarAt(s).y).toBe(0);
  });
});
