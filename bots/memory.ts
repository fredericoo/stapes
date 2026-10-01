import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Coord } from "../app/lib/types";

/**
 * Two sightings of one kind of thing this close together are one thing that
 * moved: a salesman strolls about his stall, and a bot that kept every cell
 * it saw him on would remember a crowd.
 */
export const SAME_PLACE_CELLS = 12;

/** Other threads write to the same file, so what they found is read again this often. */
export const RELOAD_MS = 30_000;

/** A sighting no further than this from the remembered one is not written again. */
const REWRITE_CELLS = 3;

const REWRITE_MS = 5 * 60_000;

type Landmark = Coord & { readonly seenAt: number };

/**
 * Where the fleet has seen each kind of landmark, by tile id: an NPC, a vein,
 * a bush. It is the bots' own SQLite file, never the world's database, which
 * the server holds exclusively; and it is keyed by what a thing is and where
 * it stood, never by an actor or placement id, because those are minted
 * afresh whenever the world loads. Every bot thread opens the same file, so
 * one bot finding the blacksmith tells the rest, and the next run starts
 * knowing it.
 */
export class Landmarks {
  private readonly db: Database;
  private byTile = new Map<string, Landmark[]>();
  private loadedAt = -Infinity;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 2000");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS landmark (
         tile_id TEXT NOT NULL,
         x INTEGER NOT NULL,
         y INTEGER NOT NULL,
         z INTEGER NOT NULL,
         seen_at INTEGER NOT NULL,
         PRIMARY KEY (tile_id, x, y, z)
       )`,
    );
  }

  /** Every remembered place of `tileId`, nearest `from` first. */
  where(tileId: string, from: Coord, nowMs = Date.now()): Coord[] {
    this.reload(nowMs);
    const found = this.byTile.get(tileId) ?? [];
    return found.map(({ x, y, z }) => ({ x, y, z })).sort((a, b) => far(a, from) - far(b, from));
  }

  saw(tileId: string, at: Coord, nowMs = Date.now()) {
    this.reload(nowMs);
    const known = this.byTile.get(tileId) ?? [];
    const same = known.find((mark) => samePlace(mark, at));
    if (same && far(same, at) <= REWRITE_CELLS && nowMs - same.seenAt < REWRITE_MS) return;
    const kept = known.filter((mark) => !samePlace(mark, at));
    this.byTile.set(tileId, [...kept, { x: at.x, y: at.y, z: at.z, seenAt: nowMs }]);
    this.write(() => {
      for (const mark of known) {
        if (samePlace(mark, at)) this.remove(tileId, mark);
      }
      this.db
        .query("INSERT OR REPLACE INTO landmark VALUES (?, ?, ?, ?, ?)")
        .run(tileId, at.x, at.y, at.z, nowMs);
    });
  }

  /** The bot went to where it remembered `tileId` and found nothing there. */
  missing(tileId: string, at: Coord) {
    const known = this.byTile.get(tileId) ?? [];
    const gone = known.filter((mark) => samePlace(mark, at));
    if (gone.length === 0) return;
    this.byTile.set(
      tileId,
      known.filter((mark) => !samePlace(mark, at)),
    );
    this.write(() => {
      for (const mark of gone) this.remove(tileId, mark);
    });
  }

  close() {
    this.db.close();
  }

  private remove(tileId: string, at: Coord) {
    this.db
      .query("DELETE FROM landmark WHERE tile_id = ? AND x = ? AND y = ? AND z = ?")
      .run(tileId, at.x, at.y, at.z);
  }

  /**
   * A write that finds the file busy past the timeout is dropped: the
   * memory is a shortcut, and a bot that forgets one sighting sees it again.
   */
  private write(body: () => void) {
    try {
      this.db.transaction(body)();
    } catch {
      return;
    }
  }

  private reload(nowMs: number) {
    if (nowMs - this.loadedAt < RELOAD_MS) return;
    this.loadedAt = nowMs;
    const rows = this.db.query("SELECT tile_id, x, y, z, seen_at FROM landmark").all() as Array<{
      tile_id: string;
      x: number;
      y: number;
      z: number;
      seen_at: number;
    }>;
    const byTile = new Map<string, Landmark[]>();
    for (const row of rows) {
      const list = byTile.get(row.tile_id) ?? [];
      list.push({ x: row.x, y: row.y, z: row.z, seenAt: row.seen_at });
      byTile.set(row.tile_id, list);
    }
    this.byTile = byTile;
  }
}

function samePlace(a: Coord, b: Coord): boolean {
  return a.z === b.z && far(a, b) <= SAME_PLACE_CELLS;
}

function far(a: Coord, b: Coord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) * 4;
}
