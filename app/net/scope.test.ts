import { describe, expect, it } from "vitest";
import { chunkKeyFor } from "../lib/mapData";
import { CHUNK_SIZE } from "../lib/types";
import type { MotionEvent } from "./protocol";
import type { PlacedTile } from "../lib/types";
import { audienceOf, cellInScope, type ScopedCell } from "./scope";

function holding(...cells: Array<[number, number]>): Set<string> {
  return new Set(cells.map(([x, y]) => chunkKeyFor(x, y)));
}

const NOBODY: ReadonlySet<string> = new Set();

const HERE: [number, number] = [0, 0];
const AWAY: [number, number] = [CHUNK_SIZE * 4, 0];

const grass = { tileId: "grass" } as PlacedTile;
const deer = { tileId: "deer", owner: "npc:9,9,0,1" } as PlacedTile;

function terrain(x: number, y: number, stack: PlacedTile[] = [grass]): ScopedCell {
  return { cell: { x, y, z: 0, stack }, terrain: true, bodies: [] };
}

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

  it("is not news when only a body this client is not being told about moved", () => {
    expect(cellInScope(stepped(1, 0, [grass]), holding(HERE), NOBODY, NOBODY)).toBeNull();
    expect(cellInScope(stepped(2, 0, [grass, deer]), holding(HERE), NOBODY, NOBODY)).toBeNull();
  });

  it("goes whole to a client that holds the body that moved", () => {
    const step = stepped(2, 0, [grass, deer]);

    expect(cellInScope(step, holding(HERE), new Set([deer.owner!]), NOBODY)).toBe(step.cell);
  });

  it("goes to a client that had the body the step takes off the board", () => {
    const gone = stepped(2, 0, [grass]);

    expect(cellInScope(gone, holding(HERE), NOBODY, NOBODY)).toBeNull();
    expect(cellInScope(gone, holding(HERE), NOBODY, new Set([deer.owner!]))).toBe(gone.cell);
  });

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
