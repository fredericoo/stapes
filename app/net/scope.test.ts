import { describe, expect, it } from "vitest";
import { chunkKeyFor } from "../lib/mapData";
import { CHUNK_SIZE } from "../lib/types";
import type { MotionEvent } from "./protocol";
import type { PlacedTile } from "../lib/types";
import { audienceOf, cellInScope, type ScopedCell } from "./scope";

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

describe("a cell of a patch", () => {
  it("reaches a client that holds the chunk it is in", () => {
    const here = terrain(1, 0);

    expect(cellInScope(here, holding(HERE), NOBODY, NOBODY)).toBe(here.cell);
    expect(cellInScope(terrain(AWAY[0], 0), holding(HERE), NOBODY, NOBODY)).toBeNull();
    expect(cellInScope(here, new Set(), NOBODY, NOBODY)).toBeNull();
  });

  /**
   * The saving this exists for. A creature's step is two cells that changed for
   * no other reason, and the world walks two dozen creatures a round — none of
   * which a client 60 cells away can see.
   */
  it("is not news when only a body this client is not being told about moved", () => {
    expect(cellInScope(stepped(1, 0, [grass]), holding(HERE), NOBODY, NOBODY)).toBeNull();
    expect(cellInScope(stepped(2, 0, [grass, deer]), holding(HERE), NOBODY, NOBODY)).toBeNull();
  });

  it("goes whole to a client that holds the body that moved", () => {
    const step = stepped(2, 0, [grass, deer]);

    expect(cellInScope(step, holding(HERE), new Set([deer.owner!]), NOBODY)).toBe(step.cell);
  });

  /**
   * The bug that shipped. A body is in `known` and not in `held` for exactly
   * one tick — the tick it died, or the tick it walked out of reach — and that
   * is the tick carrying the patch that takes its tile off this client's
   * board. Asking only about `held` dropped it, and nothing rewrites that cell
   * again: the corpse stayed where it fell.
   */
  it("goes to a client that had the body the step takes off the board", () => {
    const gone = stepped(2, 0, [grass]);

    // Dropped for a client that never had it...
    expect(cellInScope(gone, holding(HERE), NOBODY, NOBODY)).toBeNull();
    // ...and sent as it stands to one that did.
    expect(cellInScope(gone, holding(HERE), NOBODY, new Set([deer.owner!]))).toBe(gone.cell);
  });

  /**
   * A cell that changed for a reason of its own still goes out — with the body
   * standing in it taken back out, because a client is never sent a body it has
   * not been told about.
   */
  it("strips a body out of a cell that changed under it", () => {
    const changed = terrain(1, 0, [grass, deer]);

    expect(cellInScope(changed, holding(HERE), NOBODY, NOBODY)).toEqual({
      x: 1,
      y: 0,
      z: 0,
      stack: [grass],
    });
  });
});

/**
 * An arrow and a damage number carry no actor id on purpose — whoever they
 * were measured against may be off the board by the time they are drawn — so
 * the cell is what decides who hears them. Everything else is about a body.
 */
describe("who an event is for", () => {
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
    expect(audienceOf(hit)).toEqual({ kind: "cell", x: AWAY[0], y: 0 });
  });

  /**
   * A player is not told how many others are online, and hearing every arrival
   * and departure in the world would let them count.
   */
  it("gives the rest, joining and leaving included, to the body they are about", () => {
    const walk: MotionEvent = {
      kind: "walkStarted",
      actorId: "rat",
      from: { x: 1, y: 0, z: 0 },
      to: { x: 2, y: 0, z: 0 },
      direction: "e",
    };

    expect(audienceOf(walk)).toEqual({ kind: "actor", actorId: "rat" });
    expect(audienceOf({ kind: "joined", actorId: "bob" })).toEqual({
      kind: "actor",
      actorId: "bob",
    });
    expect(audienceOf({ kind: "left", actorId: "bob" })).toEqual({ kind: "actor", actorId: "bob" });
  });
});
