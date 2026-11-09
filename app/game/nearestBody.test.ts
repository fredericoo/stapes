import { describe, expect, it } from "vitest";
import type { ChunkCells, Coord } from "../lib/types";
import { type BodyBoard, type Located, nearestOnTiles, TileColumns } from "./nearestBody";
import { Rng } from "./rng";

const WORLDS = 200;
const VERSIONS = 30;
const MAX_BODIES_PER_TILE = 12;
/** Small enough that most questions have several bodies at the same distance. */
const SPAN_CELLS = 2;
const CHUNK_CELLS = 2;
const TILE_IDS = ["player", "rat", "wolf"];
const ASKED_CHANCE = 0.6;
const DISTURB_CHANCE = 0.2;
const REMOVE_SHARE = 0.1;
const RETILE_SHARE = 0.2;
const REFUSE_CHANCE = 0.2;
const IN_PLACE_CHANCE = 0.5;
const REINDEX_CHANCE = 0.2;
const SPAWNS_PER_REINDEX = 2;
/** Enough questions with a tie for the tie-break to be what is under test. */
const MIN_TIED_SHARE = 0.2;

interface Body {
  id: string;
  x: number;
  y: number;
  tileId: string;
}

function cellIn(rng: Rng): number {
  return Math.floor(rng.next() * (2 * SPAN_CELLS + 1)) - SPAN_CELLS;
}

function pick<T>(rng: Rng, from: readonly T[]): T {
  return from[Math.floor(rng.next() * from.length)]!;
}

function chunkKeyOf(x: number, y: number): string {
  return `${Math.floor(x / CHUNK_CELLS)},${Math.floor(y / CHUNK_CELLS)}`;
}

function stepsBetween(body: Body, from: Coord): number {
  return Math.abs(body.x - from.x) + Math.abs(body.y - from.y);
}

/**
 * A board that, like the real one, either replaces a chunk whenever anything
 * in it changes or, as a `MapDraft` does, writes it in place and counts the
 * write, and keeps every other chunk as it was.
 */
class FakeBoard implements BodyBoard {
  readonly bodies = new Map<string, Body>();
  private readonly chunks = new Map<string, ChunkCells>();
  private readonly writes = new WeakMap<ChunkCells, number>();
  version: object = {};

  constructor(private readonly rng: Rng) {}

  place(body: Body) {
    const before = this.bodies.get(body.id);
    if (before) this.touch(before.x, before.y);
    this.bodies.set(body.id, body);
    this.touch(body.x, body.y);
  }

  remove(id: string) {
    const before = this.bodies.get(id);
    if (!before) return;
    this.bodies.delete(id);
    this.touch(before.x, before.y);
  }

  chunkAt(_levelKey: string, chunkKey: string): ChunkCells | undefined {
    return this.chunks.get(chunkKey);
  }

  writesInPlace(chunk: ChunkCells | undefined): number {
    return chunk ? (this.writes.get(chunk) ?? 0) : 0;
  }

  locate(id: string): Located | null {
    const body = this.bodies.get(id);
    if (!body) return null;
    const chunkKey = chunkKeyOf(body.x, body.y);
    return { ...body, levelKey: "0", chunkKey, chunk: this.chunks.get(chunkKey) };
  }

  private touch(x: number, y: number) {
    const key = chunkKeyOf(x, y);
    const chunk = this.chunks.get(key);
    if (chunk && this.rng.next() < IN_PLACE_CHANCE) {
      this.writes.set(chunk, this.writesInPlace(chunk) + 1);
    } else {
      this.chunks.set(key, {});
    }
    this.version = {};
  }
}

/** Every body a question could name: listed for an asked tile, still on it, and accepted. */
function contenders(
  listed: ReadonlyMap<string, readonly string[]>,
  tileIds: readonly string[],
  board: FakeBoard,
  accept: (id: string) => boolean,
): Body[] {
  return tileIds.flatMap((tileId) =>
    (listed.get(tileId) ?? []).flatMap((id) => {
      const body = board.bodies.get(id);
      return body && body.tileId === tileId && accept(id) ? [body] : [];
    }),
  );
}

/** The search as it was before the index: every tile's bodies in turn, strict improvements only. */
function inOrder(bodies: readonly Body[], from: Coord): Body | null {
  let best: Body | null = null;
  for (const body of bodies) {
    if (!best || stepsBetween(body, from) < stepsBetween(best, from)) best = body;
  }
  return best;
}

function spawn(rng: Rng, board: FakeBoard, id: string) {
  board.place({ id, x: cellIn(rng), y: cellIn(rng), tileId: pick(rng, TILE_IDS) });
}

/** As `GameSession.buildTileIndex` lists them: by the tile each body stands on, in insertion order. */
function indexOf(board: FakeBoard): Map<string, string[]> {
  const listed = new Map<string, string[]>();
  for (const body of board.bodies.values()) {
    listed.set(body.tileId, [...(listed.get(body.tileId) ?? []), body.id]);
  }
  return listed;
}

function disturb(rng: Rng, board: FakeBoard) {
  for (const body of [...board.bodies.values()]) {
    if (rng.next() >= DISTURB_CHANCE) continue;
    const roll = rng.next();
    if (roll < REMOVE_SHARE) board.remove(body.id);
    else if (roll < REMOVE_SHARE + RETILE_SHARE)
      board.place({ ...body, tileId: pick(rng, TILE_IDS) });
    else board.place({ ...body, x: cellIn(rng), y: cellIn(rng) });
  }
}

describe("nearestOnTiles", () => {
  it("names the body a pass in order would as bodies move, change tile, spawn and leave", () => {
    const rng = new Rng(7);
    let questions = 0;
    let tied = 0;
    for (let world = 0; world < WORLDS; world++) {
      const board = new FakeBoard(rng);
      let spawned = 0;
      const count = 1 + Math.floor(rng.next() * MAX_BODIES_PER_TILE * TILE_IDS.length);
      while (spawned < count) spawn(rng, board, `body-${spawned++}`);
      let listed = indexOf(board);
      let columns = new Map(
        TILE_IDS.map((tileId) => [tileId, TileColumns.listing(tileId, listed.get(tileId) ?? [])]),
      );
      const columnsOf = (tileId: string) => {
        const found = columns.get(tileId)!;
        found.refresh(board.version, board);
        return found;
      };

      for (let version = 0; version < VERSIONS; version++) {
        disturb(rng, board);
        if (rng.next() < REINDEX_CHANCE) {
          for (let n = 0; n < SPAWNS_PER_REINDEX; n++) spawn(rng, board, `body-${spawned++}`);
          listed = indexOf(board);
          columns = new Map(
            TILE_IDS.map((tileId) => [
              tileId,
              columns.get(tileId)!.relisted(listed.get(tileId) ?? []),
            ]),
          );
        }
        const tileIds = TILE_IDS.filter(() => rng.next() < ASKED_CHANCE);
        const from = { x: cellIn(rng), y: cellIn(rng), z: 0 };
        const refused = new Set([...board.bodies.keys()].filter(() => rng.next() < REFUSE_CHANCE));
        const accept = (id: string) => !refused.has(id);

        const bodies = contenders(listed, tileIds, board, accept);
        const expected = inOrder(bodies, from);
        questions++;
        if (expected) {
          const steps = stepsBetween(expected, from);
          if (bodies.filter((body) => stepsBetween(body, from) === steps).length > 1) tied++;
        }

        expect(nearestOnTiles(tileIds, columnsOf, from, accept)).toBe(expected?.id ?? null);
      }
    }
    expect(tied / questions).toBeGreaterThan(MIN_TIED_SHARE);
  });
});
