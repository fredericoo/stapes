import type { DecayInteraction } from "../lib/interactions";
import { resolveDecay } from "../lib/interactions";
import { getStack, listCoords, replaceStack } from "../lib/mapData";
import type { Coord, MapFile, PlacedTile, TileDef } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import { canReplaceStack } from "../lib/validation";
import { cellKey } from "./pressurePlates";
import type { Rng } from "./rng";

/**
 * Which placement a deadline belongs to, as a string.
 *
 * Cell plus tile id, and deliberately not the stack index: an index shifts the
 * moment anything is placed under or over it, so a splash of blood would forget
 * how old it was every time somebody walked across it. The trade is that two
 * placements of the *same* decaying tile in one cell share one deadline and go
 * together — which is the difference between a bounded key and one that has to
 * be minted onto the placement and then kept alive through every swap.
 */
function entryKey(cell: Coord, tileId: string): string {
  return `${cellKey(cell)}|${tileId}`;
}

/** A placement counting down, and when its time is up. */
export type DecayEntry = {
  cell: Coord;
  tileId: string;
  /** Session-elapsed ms at which this turns. See {@link DecayIndex.advance}. */
  dueMs: number;
};

/** Does any placement in this cell decay? */
export function cellHasDecay(
  map: MapFile,
  cell: Coord,
  tilesById: Record<string, TileDef>,
): boolean {
  return getStack(map, cell.x, cell.y, cell.z).some((placed) => {
    const def = tilesById[placed.tileId];
    return def != null && resolveDecay(def) != null;
  });
}

/**
 * Every cell holding a decaying placement. Whole-map scan, for arming the index
 * once at load rather than per tick — the same discipline plates and wires are
 * indexed under.
 */
export function findDecayCells(
  map: MapFile,
  tilesById: Record<string, TileDef>,
): Coord[] {
  const out: Coord[] = [];
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { x, y } of listCoords(map, z)) {
      const cell = { x, y, z };
      if (cellHasDecay(map, cell, tilesById)) out.push(cell);
    }
  }
  return out;
}

/**
 * What is counting down, and how long each has left.
 *
 * **Beside the map, never on it**, and that is the load-bearing decision here.
 * A deadline written onto the placement would ride the wire and the checkpoint
 * for free — which sounds like the whole problem solved, and is the trap. It
 * would also land in `data/map.json` the moment somebody saved from the editor,
 * turning a hand-editable, git-diffable file into one that churns a timestamp
 * per splash of blood. Held out here, decay costs the map format nothing, the
 * protocol nothing, and the checkpoint nothing.
 *
 * What that gives up is continuity across an eviction: a world resumed from a
 * checkpoint re-arms whatever it finds with a full fresh lifetime. That is the
 * same bargain hit points and brain memory already take — a world nobody is
 * looking at owes no continuity — and it is bounded by one lifetime.
 *
 * The clock is **simulated**, summed from the ticks the session actually ran,
 * so a decay is reproducible from a seed and a tick count exactly as a fight
 * is. `Date.now()` in here would make a test's outcome depend on how fast the
 * test ran.
 */
export class DecayIndex {
  private readonly entries = new Map<string, DecayEntry>();
  private readonly rng: Rng;
  private elapsedMs = 0;
  /**
   * Soonest deadline held, so a tick with nothing due costs one comparison.
   *
   * This is the whole performance story: blood is spawned under every blow
   * landed, so the index runs to hundreds of entries and is read thirty times a
   * second. Scanning it is proportional to what it holds, and this is what
   * keeps that scan off the ticks that have no reason to run it.
   */
  private nextDueMs = Number.POSITIVE_INFINITY;

  /**
   * @param rng the world's dice, shared with the brains rather than owned here.
   *   A lifetime drawn from a private generator would be reproducible on its own
   *   and unreproducible in company: two worlds on one seed would agree about
   *   where every deer walked and disagree about when the blood dried.
   */
  constructor(rng: Rng) {
    this.rng = rng;
  }

  /** Advance the simulated clock by one tick. */
  advance(tickMs: number) {
    this.elapsedMs += tickMs;
  }

  /** Is anything counting down? See `GameSession.isAtRest`. */
  pending(): boolean {
    return this.entries.size > 0;
  }

  /**
   * Start the clock on every decaying placement in this cell.
   *
   * Additive: a placement already counting down keeps the deadline it has.
   * Re-stamping would be the obvious reading of "this cell changed" and is
   * exactly wrong — a cell is reindexed whenever anything in it moves, so blood
   * in a doorway would have its timer reset by every person who walked over it
   * and would never dry.
   *
   * Nothing is dropped here either. A placement that has been erased or swapped
   * away leaves its entry behind until the deadline arrives, where the stack
   * read finds nothing to turn and forgets it — the same "a stale extra entry
   * costs one wasted stack read" the plate index runs on, bounded by one
   * lifetime.
   *
   * This is also where the lifetime is **drawn**, once and for good. Rolling at
   * expiry instead would be rolling to decide whether to have expired, and
   * rolling on every re-arm would let a busy cell keep winning itself a longer
   * life.
   */
  armCell(map: MapFile, cell: Coord, tilesById: Record<string, TileDef>) {
    for (const placed of getStack(map, cell.x, cell.y, cell.z)) {
      const def = tilesById[placed.tileId];
      const decay = def ? resolveDecay(def) : null;
      if (!decay) continue;
      const key = entryKey(cell, placed.tileId);
      if (this.entries.has(key)) continue;
      const dueMs = this.elapsedMs + this.rollLifetimeMs(decay);
      this.entries.set(key, { cell: { ...cell }, tileId: placed.tileId, dueMs });
      if (dueMs < this.nextDueMs) this.nextDueMs = dueMs;
    }
  }

  /**
   * A lifetime from the authored range, both ends included.
   *
   * **Always exactly one draw**, even where the two ends are equal and the
   * answer was never in doubt. This is the same discipline a swing's three draws
   * are under: a draw count that varied with what an author typed would mean
   * widening one tile's range by a millisecond changed what every creature in
   * the world rolled after it, and a reproducible world is the whole reason
   * these dice are seeded.
   */
  private rollLifetimeMs(decay: DecayInteraction): number {
    return decay.fromMs + this.rng.int(decay.toMs - decay.fromMs + 1);
  }

  /**
   * Everything whose time is up, forgotten on the way out.
   *
   * One pass serves every entry due at this instant and re-reads the soonest
   * deadline while it is already walking the map, so a tick either does nothing
   * or does all of it.
   */
  takeDue(): DecayEntry[] {
    if (this.elapsedMs < this.nextDueMs) return [];

    const due: DecayEntry[] = [];
    let soonest = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.entries) {
      if (entry.dueMs <= this.elapsedMs) {
        due.push(entry);
        this.entries.delete(key);
      } else if (entry.dueMs < soonest) {
        soonest = entry.dueMs;
      }
    }
    this.nextDueMs = soonest;
    return due;
  }
}

export type DecayResult = {
  map: MapFile;
  /** Cells whose stack changed — every index over them is now suspect. */
  changed: Coord[];
};

/**
 * `stack` with every placement of `tileId` turned, or null when nothing in it
 * turns.
 *
 * A placement somebody is driving is left alone. Deleting a body out from under
 * its runtime would strand an actor whose next `locate` throws, and a decaying
 * tile that has been adopted as somebody's avatar is a map an author can fix —
 * not a world that has to fall over to tell them.
 */
function decayedStack(
  map: MapFile,
  cell: Coord,
  tileId: string,
  tilesById: Record<string, TileDef>,
): PlacedTile[] | null {
  const def = tilesById[tileId];
  const decay: DecayInteraction | null = def ? resolveDecay(def) : null;
  if (!decay) return null;
  // A target that does not exist leaves the tile where it is rather than
  // erasing it: a typo in `tiles.json` should read as a decay that never
  // happened, not as content quietly deleting itself.
  if (decay.tileId && !tilesById[decay.tileId]) return null;

  const stack = getStack(map, cell.x, cell.y, cell.z);
  const next: PlacedTile[] = [];
  let turned = false;
  for (const placed of stack) {
    if (placed.tileId !== tileId || placed.owner) {
      next.push(placed);
      continue;
    }
    turned = true;
    if (decay.tileId) next.push({ ...placed, tileId: decay.tileId });
  }
  if (!turned) return null;

  // Refused rather than forced, exactly as a plate's swap is: whatever a decay
  // becomes has to fit under what has been stacked on it in the meantime.
  return canReplaceStack(map, cell.x, cell.y, cell.z, next, tilesById).ok
    ? next
    : null;
}

/**
 * Turn everything in `entries`, in one pass.
 *
 * A decay that cannot happen — the placement is gone, the target does not fit,
 * somebody is driving the body — is abandoned rather than retried. Retrying
 * would hold the world awake spinning on a swap that is never going to fit, and
 * the cell is re-armed for free the next time anything disturbs it.
 */
export function applyDecay(
  map: MapFile,
  entries: Iterable<DecayEntry>,
  tilesById: Record<string, TileDef>,
): DecayResult {
  const changed: Coord[] = [];
  let next = map;
  for (const { cell, tileId } of entries) {
    const stack = decayedStack(next, cell, tileId, tilesById);
    if (!stack) continue;
    next = replaceStack(next, cell.x, cell.y, cell.z, stack);
    changed.push(cell);
  }
  return { map: next, changed };
}
