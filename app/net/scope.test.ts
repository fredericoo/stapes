import { describe, expect, it } from "vitest";
import { chunkKeyFor } from "../lib/mapData";
import { CHUNK_SIZE } from "../lib/types";
import type { MotionEvent } from "./protocol";
import type { PlacedTile } from "../lib/types";
import {
  audienceOf,
  cellsInScope,
  eventsInScope,
  patchesInScope,
  reaches,
  type ScopedCell,
} from "./scope";

/**
 * What one client is told about.
 *
 * Two rules and they have to agree: a cell reaches whoever holds the chunk it
 * is in, and an event reaches whoever holds the body it is about — or, where it
 * names no body, the chunk it happened in.
 */

/** A subscription holding the chunks these cells are in, and no others. */
function holding(...cells: Array<[number, number]>): Set<string> {
  return new Set(cells.map(([x, y]) => chunkKeyFor(x, y)));
}

const NOBODY: ReadonlySet<string> = new Set();

const HERE: [number, number] = [0, 0];
const AWAY: [number, number] = [CHUNK_SIZE * 4, 0];

const grass = { tileId: "grass" } as PlacedTile;
const deer = { tileId: "deer", owner: "npc:9,9,0,1" } as PlacedTile;

/** A cell whose change is terrain: a tile appeared, nobody moved. */
function terrain(x: number, y: number, stack: PlacedTile[] = [grass]): ScopedCell {
  return { cell: { x, y, z: 0, stack }, terrain: true, bodies: [] };
}

/** A cell that changed only because a body walked into or out of it. */
function stepped(x: number, y: number, stack: PlacedTile[]): ScopedCell {
  return {
    cell: { x, y, z: 0, stack },
    terrain: false,
    bodies: [deer.owner!],
  };
}

describe("cells of a patch", () => {
  it("keeps the ones in chunks this client holds", () => {
    const cells = [terrain(1, 0), terrain(AWAY[0], 0), terrain(2, 0)];

    expect(cellsInScope(cells, holding(HERE), NOBODY, NOBODY)).toEqual([
      cells[0]!.cell,
      cells[2]!.cell,
    ]);
  });

  /**
   * Null, and it is not a detail: the caller sends one serialization to every
   * client that takes the patch whole, and this is how it tells. A same-length
   * answer would not do — a cell can come back with a body taken out of it.
   */
  it("says so when none is dropped or rewritten", () => {
    expect(cellsInScope([terrain(1, 0), terrain(2, 0)], holding(HERE), NOBODY, NOBODY)).toBeNull();
  });

  it("drops every one when the client holds no ground", () => {
    expect(cellsInScope([terrain(1, 0)], new Set(), NOBODY, NOBODY)).toEqual([]);
  });

  /**
   * The saving this exists for. A creature's step is two cells that changed for
   * no other reason, and the world walks two dozen creatures a round — none of
   * which a client 60 cells away can see.
   */
  it("drops a step by a body this client is not being told about", () => {
    const cells = [stepped(1, 0, [grass]), stepped(2, 0, [grass, deer])];

    expect(cellsInScope(cells, holding(HERE), NOBODY, NOBODY)).toEqual([]);
  });

  it("sends that same step to a client that holds the body", () => {
    const cells = [stepped(1, 0, [grass]), stepped(2, 0, [grass, deer])];

    expect(cellsInScope(cells, holding(HERE), new Set([deer.owner!]), NOBODY)).toBeNull();
  });

  /**
   * The bug that shipped. A body is in `known` and not in `held` for exactly
   * one tick — the tick it died, or the tick it walked out of reach — and that
   * is the tick carrying the patch that takes its tile off this client's
   * board. Asking only about `held` dropped it, and nothing rewrites that cell
   * again: the corpse stayed where it fell.
   */
  it("sends the step that takes a body this client had off the board", () => {
    const gone = [stepped(2, 0, [grass])];

    // Dropped for a client that never had it...
    expect(cellsInScope(gone, holding(HERE), NOBODY, NOBODY)).toEqual([]);
    // ...and taken whole by one that did, which is null for "nothing was cut".
    expect(cellsInScope(gone, holding(HERE), NOBODY, new Set([deer.owner!]))).toBeNull();
  });

  /**
   * A cell that changed for a reason of its own still goes out — with the body
   * standing in it taken back out, because a client is never sent a body it has
   * not been told about.
   */
  it("strips a body out of a cell that changed under it", () => {
    const cells = [terrain(1, 0, [grass, deer])];

    expect(cellsInScope(cells, holding(HERE), NOBODY, NOBODY)).toEqual([
      { x: 1, y: 0, z: 0, stack: [grass] },
    ]);
  });
});

describe("events of a patch", () => {
  const walk: MotionEvent = {
    kind: "walkStarted",
    actorId: "rat",
    from: { x: 1, y: 0, z: 0 },
    to: { x: 2, y: 0, z: 0 },
    direction: "e",
  };

  it("reaches a client that knows the body it is about", () => {
    expect(eventsInScope([walk], holding(HERE), new Set(["rat"]))).toEqual([walk]);
    expect(eventsInScope([walk], holding(HERE), new Set())).toEqual([]);
  });

  /**
   * The headcount is about the world rather than about anywhere in it, and a
   * client that missed one draws a wrong number for the rest of the session
   * with nothing to correct it.
   */
  it("reaches everybody with who joined and who left", () => {
    const joined: MotionEvent = { kind: "joined", actorId: "bob", playerCount: 2 };
    const left: MotionEvent = { kind: "left", actorId: "bob", playerCount: 1 };

    expect(eventsInScope([joined, left], new Set(), new Set())).toEqual([joined, left]);
  });

  /**
   * An arrow and a damage number carry no actor id on purpose — whoever they
   * were measured against may be off the board by the time they are drawn — so
   * the cell is what decides who hears them.
   */
  it("places the events that name no body", () => {
    const shot: MotionEvent = {
      kind: "projectileFired",
      id: "shot-1",
      tileId: "arrow",
      from: { x: 1, y: 0, elevAbs: 2 },
      to: { x: 3, y: 0, elevAbs: 2 },
      hit: true,
    };
    const hit: MotionEvent = {
      kind: "damage",
      id: "hit-1",
      targetId: "rat",
      outcome: "hit",
      amount: 3,
      x: AWAY[0],
      y: 0,
      z: 0,
      stackIndex: 1,
    };

    expect(audienceOf(shot)).toEqual({ kind: "cell", x: 1, y: 0 });
    expect(eventsInScope([shot, hit], holding(HERE), new Set())).toEqual([shot]);
    expect(eventsInScope([shot, hit], holding(AWAY), new Set())).toEqual([hit]);
  });

  it("hands back the same array when none is dropped", () => {
    const events = [walk];

    expect(eventsInScope(events, holding(HERE), new Set(["rat"]))).toBe(events);
  });
});

describe("actor-keyed diffs", () => {
  it("keep only what this client has been told there is a body for", () => {
    const hps = [
      { actorId: "rat", hp: 2, maxHp: 4, rating: 1 },
      { actorId: "wolf", hp: 9, maxHp: 9, rating: 3 },
    ];

    expect(patchesInScope(hps, new Set(["wolf"]))).toEqual([hps[1]!]);
    expect(patchesInScope(hps, new Set(["rat", "wolf"]))).toBe(hps);
  });
});

describe("what reaches a client", () => {
  it("asks the subscription about a place and the set about a body", () => {
    const chunks = holding(HERE);

    expect(reaches({ kind: "cell", x: 1, y: 0 }, chunks, new Set())).toBe(true);
    expect(reaches({ kind: "cell", ...cellAway() }, chunks, new Set())).toBe(false);
    expect(reaches({ kind: "actor", actorId: "rat" }, chunks, new Set())).toBe(false);
    expect(reaches({ kind: "actor", actorId: "rat" }, new Set(), new Set(["rat"]))).toBe(true);
  });

  function cellAway() {
    return { x: AWAY[0], y: AWAY[1] };
  }
});
