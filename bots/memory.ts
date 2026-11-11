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

const BUSY_TIMEOUT_MS = 2_000;

type Landmark = Coord & { readonly seenAt: number };

/** Where a bot died, and the rating of the strongest bot that died there. */
export type Death = { readonly at: Coord; readonly rating: number };

/**
 * Where the fleet has seen each kind of landmark, by tile id: an NPC, a vein,
 * a bush. It is the bots' own SQLite file, never the world's database, which
 * the server holds exclusively; and it is keyed by what a thing is and where
 * it stood, never by an actor or placement id, because those are minted
 * afresh whenever the world loads. Every bot thread opens the same file, so
 * one bot finding the blacksmith tells the rest, and the next run starts
 * knowing it. It also keeps where bots died, how far from home they have
 * been, and where they are reborn, which is what a bot's home range is
 * worked out from (`bots/homeRange.ts`).
 */
export class Landmarks {
  private readonly db: Database;
  private byTile = new Map<string, Landmark[]>();
  private deathList: Death[] = [];
  /** The furthest from home a bot has stood, by level and then by its rating. */
  private ventures = new Map<number, Map<number, number>>();
  private rebornAt: Coord | null = null;
  private loadedAt = -Infinity;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this.db.exec("PRAGMA journal_mode = WAL");
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
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS death (
         x INTEGER NOT NULL,
         y INTEGER NOT NULL,
         z INTEGER NOT NULL,
         rating INTEGER NOT NULL,
         PRIMARY KEY (x, y, z)
       )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS venture (
         z INTEGER NOT NULL,
         rating INTEGER NOT NULL,
         cells INTEGER NOT NULL,
         PRIMARY KEY (z, rating)
       )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS rebirth (
         id INTEGER PRIMARY KEY CHECK (id = 0),
         x INTEGER NOT NULL,
         y INTEGER NOT NULL,
         z INTEGER NOT NULL
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

  /**
   * A bot rated `rating` died at `at`. Deaths within `SAME_PLACE_CELLS` of
   * each other are one place, kept at the highest rating that died there,
   * because a place that killed a strong bot is a danger to every weaker one.
   */
  died(at: Coord, rating: number, nowMs = Date.now()) {
    this.reload(nowMs);
    const same = this.deathList.filter((death) => samePlace(death.at, at));
    const strongest = Math.max(rating, ...same.map((death) => death.rating));
    const place = { x: at.x, y: at.y, z: at.z };
    this.deathList = [
      ...this.deathList.filter((death) => !same.includes(death)),
      { at: place, rating: strongest },
    ];
    this.write(() => {
      for (const { at: gone } of same) {
        this.db
          .query("DELETE FROM death WHERE x = ? AND y = ? AND z = ?")
          .run(gone.x, gone.y, gone.z);
      }
      this.db
        .query("INSERT OR REPLACE INTO death VALUES (?, ?, ?, ?)")
        .run(place.x, place.y, place.z, strongest);
    });
  }

  deaths(nowMs = Date.now()): readonly Death[] {
    this.reload(nowMs);
    return this.deathList;
  }

  /** A bot rated `rating` stood `cells` from home on level `z`, healthy. */
  ventured(z: number, rating: number, cells: number, nowMs = Date.now()) {
    this.reload(nowMs);
    const level = this.ventures.get(z) ?? new Map<number, number>();
    if ((level.get(rating) ?? -Infinity) >= cells) return;
    level.set(rating, cells);
    this.ventures.set(z, level);
    this.write(() => {
      this.db
        .query(
          `INSERT INTO venture VALUES (?, ?, ?)
           ON CONFLICT (z, rating) DO UPDATE SET cells = MAX(cells, excluded.cells)`,
        )
        .run(z, rating, cells);
    });
  }

  /** The furthest from home any bot rated `rating` or lower has stood on level `z`, or 0. */
  farthest(z: number, rating: number, nowMs = Date.now()): number {
    this.reload(nowMs);
    let out = 0;
    for (const [rated, cells] of this.ventures.get(z) ?? []) {
      if (rated <= rating) out = Math.max(out, cells);
    }
    return out;
  }

  /** Where the last bot to come back from death stood when it did. */
  reborn(at: Coord, nowMs = Date.now()) {
    this.reload(nowMs);
    this.rebornAt = { x: at.x, y: at.y, z: at.z };
    this.write(() => {
      this.db.query("INSERT OR REPLACE INTO rebirth VALUES (0, ?, ?, ?)").run(at.x, at.y, at.z);
    });
  }

  home(nowMs = Date.now()): Coord | null {
    this.reload(nowMs);
    return this.rebornAt;
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
    const deaths = this.db.query("SELECT x, y, z, rating FROM death").all() as Array<
      Coord & { rating: number }
    >;
    this.deathList = deaths.map(({ x, y, z, rating }) => ({ at: { x, y, z }, rating }));
    const ventures = new Map<number, Map<number, number>>();
    const ventureRows = this.db.query("SELECT z, rating, cells FROM venture").all() as Array<{
      z: number;
      rating: number;
      cells: number;
    }>;
    for (const { z, rating, cells } of ventureRows) {
      const level = ventures.get(z) ?? new Map<number, number>();
      level.set(rating, cells);
      ventures.set(z, level);
    }
    this.ventures = ventures;
    const home = this.db.query("SELECT x, y, z FROM rebirth").get() as Coord | null;
    this.rebornAt = home ? { x: home.x, y: home.y, z: home.z } : null;
  }
}

function samePlace(a: Coord, b: Coord): boolean {
  return a.z === b.z && far(a, b) <= SAME_PLACE_CELLS;
}

function far(a: Coord, b: Coord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) * 4;
}
