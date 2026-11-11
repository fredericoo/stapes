import { resolveWalkDurationMs } from "../app/game/movement";
import type { Coord, TileDef } from "../app/lib/types";
import type { Landmarks } from "./memory";

/**
 * How far from home a bot heads to explore, hunt or gather however little
 * it knows: a danger seen close to home, or a fresh fleet, never shrinks its
 * range below this.
 */
export const HOME_RANGE_MIN_CELLS = 24;

/**
 * How much further than any bot no stronger has stood, healthy, a bot is
 * willing to head. Each bot that goes that far and lives widens the range by
 * as much again, until a danger is found.
 */
export const VENTURE_STEP_CELLS = 12;

/** A place a bot should keep `cells` away from. */
export type Danger = { readonly at: Coord; readonly cells: number };

/** How far from `home` a bot is willing to head, by level. */
export type HomeRange = { readonly home: Coord; readonly cells: (z: number) => number };

/**
 * Steps from home, counting a level as four steps, as the rest of the bot's
 * distances do.
 */
export function fromHome(home: Coord, cell: Coord): number {
  return Math.abs(cell.x - home.x) + Math.abs(cell.y - home.y) + Math.abs(cell.z - home.z) * 4;
}

/**
 * The range on each level: `VENTURE_STEP_CELLS` past `farthest(z)`, the
 * furthest a bot no stronger has stood there, but short of every danger on
 * that level by the danger's own berth, and never under
 * `HOME_RANGE_MIN_CELLS`. Hostiles are placed by distance from the city, so
 * the nearest danger of a kind marks where its country starts in every
 * direction; a danger on another level says nothing about this one.
 */
export function homeRange(
  home: Coord,
  dangers: readonly Danger[],
  farthest: (z: number) => number,
): HomeRange {
  const limits = new Map<number, number>();
  for (const { at, cells } of dangers) {
    const limit = fromHome(home, at) - cells;
    limits.set(at.z, Math.min(limits.get(at.z) ?? Infinity, limit));
  }
  const byLevel = new Map<number, number>();
  return {
    home,
    cells: (z) => {
      const known = byLevel.get(z);
      if (known !== undefined) return known;
      const widened = farthest(z) + VENTURE_STEP_CELLS;
      const cells = Math.max(HOME_RANGE_MIN_CELLS, Math.min(widened, limits.get(z) ?? Infinity));
      byLevel.set(z, cells);
      return cells;
    },
  };
}

export function inRange(range: HomeRange, cell: Coord): boolean {
  return fromHome(range.home, cell) <= range.cells(cell.z);
}

/**
 * Whether a player walking at its own pace leaves `def` behind. Backing away
 * keeps a bot clear of anything slower, so only what it cannot outwalk has
 * to be kept out of its range.
 */
export function outwalks(player: TileDef, def: TileDef): boolean {
  return resolveWalkDurationMs(def) > resolveWalkDurationMs(player);
}

/**
 * One bot's side of the fleet's home memory: where it died, where it came
 * back, and how far it has stood from home while healthy. Home is where the
 * fleet was last reborn, or, until any bot has died, where this bot first
 * stood.
 */
export class Homestead {
  private firstAt: Coord | null = null;
  private diedAt: Coord | null = null;

  constructor(private readonly landmarks: Landmarks) {}

  home(): Coord | null {
    return this.landmarks.home() ?? this.firstAt;
  }

  died(at: Coord, rating: number | null) {
    this.diedAt = at;
    if (rating !== null) this.landmarks.died(at, rating);
  }

  /**
   * Called every decision while alive. The first snapshots after rebirth can
   * still show the bot where it died, so the place it is reborn is the
   * first cell it is seen on that is not that one.
   */
  stood(at: Coord, rating: number, healthy: boolean) {
    this.firstAt ??= { x: at.x, y: at.y, z: at.z };
    if (this.diedAt) {
      const { x, y, z } = this.diedAt;
      if (at.x === x && at.y === y && at.z === z) return;
      this.diedAt = null;
      this.landmarks.reborn(at);
    }
    const home = this.home();
    if (home && healthy) this.landmarks.ventured(at.z, rating, fromHome(home, at));
  }

  /**
   * The range of a bot rated `rating` that fears `feared` and cannot
   * outwalk them: kept short of every place the fleet saw one of them, and
   * of every place a bot at least as strong died, by `deathCells`.
   */
  range(
    rating: number,
    feared: readonly { readonly tileId: string; readonly cells: number }[],
    deathCells: number,
  ): HomeRange | null {
    const home = this.home();
    if (!home) return null;
    const dangers: Danger[] = [];
    for (const { tileId, cells } of feared) {
      for (const at of this.landmarks.where(tileId, home)) dangers.push({ at, cells });
    }
    for (const death of this.landmarks.deaths()) {
      if (death.rating >= rating) dangers.push({ at: death.at, cells: deathCells });
    }
    return homeRange(home, dangers, (z) => this.landmarks.farthest(z, rating));
  }
}
