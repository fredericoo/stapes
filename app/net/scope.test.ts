import { describe, expect, it } from "vitest";
import { chunkKeyFor } from "../lib/mapData";
import { CHUNK_SIZE } from "../lib/types";
import type { CellPatch, MotionEvent } from "./protocol";
import {
  audienceOf,
  cellsInScope,
  eventsInScope,
  patchesInScope,
  reaches,
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

const HERE: [number, number] = [0, 0];
const AWAY: [number, number] = [CHUNK_SIZE * 4, 0];

function cell(x: number, y: number): CellPatch {
  return { x, y, z: 0, stack: [{ tileId: "grass" }] };
}

describe("cells of a patch", () => {
  it("keeps the ones in chunks this client holds", () => {
    const cells = [cell(1, 0), cell(AWAY[0], 0), cell(2, 0)];

    expect(cellsInScope(cells, holding(HERE))).toEqual([cell(1, 0), cell(2, 0)]);
  });

  /**
   * By identity, and it is not a detail: the caller sends one serialization to
   * every client that takes the patch whole, and this is how it tells.
   */
  it("hands back the same array when none is dropped", () => {
    const cells = [cell(1, 0), cell(2, 0)];

    expect(cellsInScope(cells, holding(HERE))).toBe(cells);
  });

  it("drops every one when the client holds nothing", () => {
    expect(cellsInScope([cell(1, 0)], new Set())).toEqual([]);
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

    expect(eventsInScope([joined, left], new Set(), new Set())).toEqual([
      joined,
      left,
    ]);
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
      durationMs: 300,
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
    expect(reaches({ kind: "actor", actorId: "rat" }, chunks, new Set())).toBe(
      false,
    );
    expect(
      reaches({ kind: "actor", actorId: "rat" }, new Set(), new Set(["rat"])),
    ).toBe(true);
  });

  function cellAway() {
    return { x: AWAY[0], y: AWAY[1] };
  }
});
