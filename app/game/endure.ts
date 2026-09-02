import type { Affliction, EndureInteraction } from "../lib/interactions";
import { afflictionFor, resolveAfflict, resolveEndure } from "../lib/interactions";
import { getStack, listCoords, replaceStack } from "../lib/mapData";
import type { StatusDef } from "../lib/status";
import type { Coord, MapFile, PlacedTile, TileDef } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import { canReplaceStack } from "../lib/validation";
import type { Element } from "../lib/element";
import { cellKey } from "./pressurePlates";
import type { Rng } from "./rng";
import {
  advanceStatuses,
  applyStatus,
  type StatusInstance,
} from "./statuses";

/**
 * What a status does to the ground it is running on.
 *
 * The other half of `../lib/interactions`' `EndureInteraction`: that says a
 * tile can be worn down and what is left when it has been, and this spends the
 * pool, decides what the placement becomes and hands the remainder on.
 *
 * **`./decay` of this feature, on `./statuses`' terms.** Everything here is
 * arithmetic over a side index and a map, and the index holds no world: a
 * spread, a consumption and a whole forest burning down are all assertable
 * without a `GameSession`, which is why they are tested that way.
 */

/**
 * Which placement a pool belongs to, as a string.
 *
 * Cell plus tile id, and deliberately not the stack index, for exactly the
 * reason `./decay`'s `entryKey` is not: an index shifts the moment anything is
 * placed under it, so a burning tree in a doorway would forget its damage every
 * time somebody walked across the cell. The trade is the same one — two
 * placements of the same tile in one cell share a pool and go together.
 */
function poolKey(cell: Coord, tileId: string): string {
  return `${cellKey(cell)}|${tileId}`;
}

/** One placement being worn down, and what is doing it. */
export type Endurance = {
  cell: Coord;
  tileId: string;
  /**
   * What is left of `EndureInteraction.durability`.
   *
   * Spent only downward. A status that heals is honoured up to the authored
   * durability and no further, because the def is the authority on what a tile
   * is worth — the same clamp `mapData`'s `extractsLeft` puts on a vein.
   */
  hp: number;
  /**
   * What it was authored to take when the pool was opened.
   *
   * Held rather than re-read off the catalogue on every tick, because a pool
   * outlives an edit: a tile whose `suffers` was rewritten mid-fire would
   * otherwise finish under a rule it never caught fire under, and its
   * `durability` is the denominator every formula on it has been reading. What
   * it *becomes* is read from here too, so the whole arithmetic of one burn is
   * fixed at the moment it starts.
   */
  endure: EndureInteraction;
  statuses: readonly StatusInstance[];
};

/**
 * A placement that has been worn through, and everything the swap needs.
 *
 * The remainder travels on the result rather than being looked up afterwards,
 * because by then there is nothing to look it up on: the entry has been dropped
 * and the status went with it.
 */
export type Consumed = {
  cell: Coord;
  tileId: string;
  /** The status that finished it. */
  statusId: string;
  /** What the placement becomes. Blank removes it — see {@link Affliction.tileId}. */
  becomes: string;
  /** What was left of the status at the instant it finished, to be divided. */
  remainingMs: number;
  /** Who is answerable, carried so the spread stays somebody's doing. */
  causedBy?: string;
  /** What the spell behind it was made of, carried for the same reason. */
  elements?: readonly Element[];
};

/** This tile's endurance, or null when nothing can wear it down. */
function endureOf(
  tileId: string,
  tilesById: Record<string, TileDef>,
): EndureInteraction | null {
  const def = tilesById[tileId];
  return def ? resolveEndure(def) : null;
}

/**
 * Does anything in this cell's stack suffer `statusId`?
 *
 * Asked of a neighbour before the remainder is divided, so a share is never
 * handed to a cell that cannot use it — which is what keeps the arithmetic
 * honest: dividing by the neighbours that *exist* rather than by the ones that
 * burn would quietly destroy fuel at the edge of a forest.
 */
export function cellSuffers(
  map: MapFile,
  cell: Coord,
  statusId: string,
  tilesById: Record<string, TileDef>,
): boolean {
  return getStack(map, cell.x, cell.y, cell.z).some((placed) => {
    const endure = endureOf(placed.tileId, tilesById);
    return endure != null && afflictionFor(endure, statusId) != null;
  });
}

/**
 * The cells a remainder may pass into: the four orthogonal neighbours.
 *
 * **Orthogonal and same-level.** Diagonals would let a fire cross a one-cell
 * firebreak, which is the one thing a player building one is entitled to rely
 * on; levels would let a fire climb a storey, which is a second question about
 * volume that nothing here is equipped to answer. Both are knobs rather than
 * omissions, and both make a fire faster rather than differently shaped.
 *
 * The consumed cell itself is not among them. A stack is afflicted together —
 * the grass and the bush standing in it are both already under the status — so
 * handing the remainder back into the cell that produced it would be paying the
 * same fuel twice.
 */
export function neighboursOf(cell: Coord): Coord[] {
  return [
    { x: cell.x + 1, y: cell.y, z: cell.z },
    { x: cell.x - 1, y: cell.y, z: cell.z },
    { x: cell.x, y: cell.y + 1, z: cell.z },
    { x: cell.x, y: cell.y - 1, z: cell.z },
  ];
}

/**
 * How long each neighbour catches for, when a placement is consumed.
 *
 * **Fuel is conserved and never created**, and this one line is the whole of
 * why a fire is bounded: eight seconds of burning divided four ways is four
 * two-second burns, so a fire crossing a forest is spending a budget rather
 * than compounding one. A rule that gave each neighbour the *full* remainder
 * would double the fuel at every branch, and one flame in a wood would burn
 * until the wood ran out — which is a different game, and not one anybody could
 * put a hearth in.
 *
 * Floored, so nothing is created by rounding, and a share that floors to zero
 * simply does not catch: the last embers of a fire go out at its edge rather
 * than laying an infinitely thin burn across the rest of the map.
 */
export function spreadShares(
  map: MapFile,
  consumed: Consumed,
  tilesById: Record<string, TileDef>,
): { cell: Coord; shareMs: number }[] {
  const catching = neighboursOf(consumed.cell).filter((cell) =>
    cellSuffers(map, cell, consumed.statusId, tilesById),
  );
  if (catching.length === 0) return [];
  const shareMs = Math.floor(consumed.remainingMs / catching.length);
  if (shareMs <= 0) return [];
  return catching.map((cell) => ({ cell, shareMs }));
}

/**
 * Does this cell hold a placement that inflicts a status on its own stack?
 *
 * The membership question behind `GameSession.afflictCells`, asked on exactly
 * the terms `cellHasPlate` and `cellIsWired` are: cheap, per cell, and the only
 * thing standing between a per-tick sweep and a whole-map scan.
 */
export function cellAfflicts(
  map: MapFile,
  cell: Coord,
  tilesById: Record<string, TileDef>,
): boolean {
  return getStack(map, cell.x, cell.y, cell.z).some((placed) => {
    const def = tilesById[placed.tileId];
    return def != null && resolveAfflict(def) != null;
  });
}

/**
 * Every cell holding a source of an affliction.
 *
 * Whole-map scan, for indexing once at load rather than per tick — the same
 * discipline plates, wires and decay are indexed under. Note there is no
 * companion scan for the tiles that *suffer*: a pool opens the first time
 * something is actually inflicted on it, so an untouched forest costs nothing.
 */
export function findAfflictCells(
  map: MapFile,
  tilesById: Record<string, TileDef>,
): Coord[] {
  const out: Coord[] = [];
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { x, y } of listCoords(map, z)) {
      const cell = { x, y, z };
      if (cellAfflicts(map, cell, tilesById)) out.push(cell);
    }
  }
  return out;
}

/**
 * Every status a placement in this cell hands to the stack it is standing in.
 *
 * A cell may hold two sources — a flame conjured onto a brazier — and each is
 * asked separately, so what the stack catches is the union rather than
 * whichever placement happened to be read first.
 *
 * The caster's name and elements ride along, because that is what makes a
 * conjured fire somebody's doing all the way down: the arcanist who lit the
 * first tree is paid for the whole forest, through the same `causedBy` a body
 * burned by that flame already carries. @see `GameSession.awardCausedDamage`
 */
export function afflictionsFrom(
  map: MapFile,
  cell: Coord,
  tilesById: Record<string, TileDef>,
): {
  statusId: string;
  causedBy?: string;
  elements?: readonly Element[];
}[] {
  const out: {
    statusId: string;
    causedBy?: string;
    elements?: readonly Element[];
  }[] = [];
  for (const placed of getStack(map, cell.x, cell.y, cell.z)) {
    const def = tilesById[placed.tileId];
    const afflict = def ? resolveAfflict(def) : null;
    if (!afflict) continue;
    out.push({
      statusId: afflict.statusId,
      ...(placed.castBy ? { causedBy: placed.castBy } : {}),
      ...(placed.castElements?.length
        ? { elements: placed.castElements }
        : {}),
    });
  }
  return out;
}

/**
 * Every placement being worn down, and the clock that wears them.
 *
 * **Beside the map, never on it**, on exactly `DecayIndex`'s terms and for the
 * same reason: an `hp` written onto the placement would ride the cell patches
 * and the checkpoint for free, and it would also land in `data/map.json` the
 * first time somebody saved from the editor — a file that is hand-edited and
 * version-controlled, where `flattenMap` goes out of its way to keep a one-cell
 * edit a one-line diff. Held out here, a half-burnt tree costs the map format
 * nothing, the protocol nothing and the checkpoint nothing.
 *
 * What that gives up is continuity across an eviction: a resumed world finds
 * every tree whole again, however far a fire had got. Same bargain hit points,
 * brain memory and decay deadlines already take, and bounded by one burn.
 *
 * **The clock is simulated, not wall time**, again as decay's is: the index is
 * advanced by the ticks the session actually ran, so a fire is reproducible
 * from a seed and a tick count exactly as a fight is.
 *
 * Cost per tick is one `size` check. A world with nothing burning in it — which
 * is every world almost all of the time — pays that and nothing else.
 */
export class EndureIndex {
  private readonly pools = new Map<string, Endurance>();
  private readonly rng: Rng;

  /**
   * @param rng the world's dice, shared with the brains rather than owned here,
   *   on `DecayIndex`'s terms: a duration drawn from a private generator would
   *   be reproducible alone and unreproducible in company.
   */
  constructor(rng: Rng) {
    this.rng = rng;
  }

  /** Is anything being worn down? See `GameSession.isAtRest`. */
  pending(): boolean {
    return this.pools.size > 0;
  }

  /** What is running on this placement, for the wire and for the tests. */
  statusesAt(cell: Coord, tileId: string): readonly StatusInstance[] {
    return this.pools.get(poolKey(cell, tileId))?.statuses ?? [];
  }

  /** Every placement currently under something, for the wire. */
  afflicted(): Iterable<Endurance> {
    return this.pools.values();
  }

  /**
   * Put a status on one placement, opening its pool if this is the first.
   *
   * Refused when the tile cannot be worn down by this status at all, which is
   * what makes "flammable" a question with one answer: the affliction, the
   * spread and the wire all ask `afflictionFor` and none of them can come to a
   * different view of what burns.
   *
   * **Nothing is re-applied to a placement already under it.** `applyStatus`
   * would happily refresh or stack, and the caller is a per-tick sweep — so
   * refreshing here would be a roll of the world's dice thirty times a second
   * per burning tile, which is exactly the draw discipline `./decay` and
   * `./statuses` are both written to protect. One roll per burn.
   */
  afflict(
    cell: Coord,
    tileId: string,
    endure: EndureInteraction,
    def: StatusDef,
    range?: { fromMs: number; toMs: number },
    causedBy?: string,
    elements?: readonly Element[],
  ): boolean {
    if (!afflictionFor(endure, def.id)) return false;
    const key = poolKey(cell, tileId);
    const existing = this.pools.get(key);
    if (existing?.statuses.some((one) => one.defId === def.id)) return false;

    const pool: Endurance = existing ?? {
      cell: { ...cell },
      tileId,
      hp: endure.durability,
      endure,
      statuses: [],
    };
    this.pools.set(key, {
      ...pool,
      statuses: applyStatus(
        pool.statuses,
        def,
        this.rng,
        range,
        causedBy,
        elements,
      ),
    });
    return true;
  }

  /**
   * Advance every pool by one tick, and hand back what has been worn through.
   *
   * The order matches `advanceStatuses`' own, because it is the same order: the
   * clocks wind down, whatever is due pays out, and what has run out is dropped.
   * A pool whose statuses have all ended keeps its damage and stays in the index
   * — that is what lets a permanent flame set the same tile alight again next
   * tick without the tile having quietly healed in between, and what makes a
   * scorched half-burnt tree stay scorched.
   *
   * **A pool at full health with nothing running on it is forgotten**, which is
   * the only thing keeping the index from growing to the size of the map: a
   * status that ended without spending anything leaves no trace to keep.
   */
  advance(tickMs: number, statusDefs: Record<string, StatusDef>): Consumed[] {
    if (this.pools.size === 0) return [];

    const consumed: Consumed[] = [];
    for (const [key, pool] of this.pools) {
      const durability = pool.endure.durability;
      const tick = advanceStatuses(
        pool.statuses,
        tickMs,
        { hp: pool.hp, maxHp: durability },
        statusDefs,
      );

      let hp = pool.hp;
      for (const change of tick.hpChanges) {
        hp = Math.min(durability, hp + change.amount);
      }

      if (hp > 0) {
        if (hp === durability && tick.statuses.length === 0) {
          this.pools.delete(key);
          continue;
        }
        this.pools.set(key, { ...pool, hp, statuses: tick.statuses });
        continue;
      }

      // Worn through. Which status finished it decides what it becomes, and the
      // one asked is the first the tile suffers that is actually running on it —
      // a tile authored to burn to dirt and freeze to ice does whichever of the
      // two it was under. Read off the list *before* the tick dropped anything,
      // because a status that expired on the very tick it finished the tile is
      // still what finished it.
      this.pools.delete(key);
      const finisher = this.finisherOf(pool, tick.statuses, statusDefs);
      if (finisher) consumed.push(finisher);
    }
    return consumed;
  }

  /**
   * Which running status wore this placement through, as a {@link Consumed}.
   *
   * `after` is preferred over `before` for the remainder, because that is what
   * is actually left: a status one tick from expiry has one tick of fuel to pass
   * on, not a full period. A status that ended on this tick has no remainder and
   * spreads nothing, which is right — a fire that goes out as the tree falls
   * does not jump.
   */
  private finisherOf(
    pool: Endurance,
    after: readonly StatusInstance[],
    statusDefs: Record<string, StatusDef>,
  ): Consumed | null {
    for (const instance of pool.statuses) {
      const affliction = afflictionFor(pool.endure, instance.defId);
      if (!affliction || !statusDefs[instance.defId]) continue;
      const left = after.find((one) => one.defId === instance.defId);
      return {
        cell: pool.cell,
        tileId: pool.tileId,
        statusId: instance.defId,
        becomes: affliction.tileId,
        remainingMs: Math.max(0, left?.remainingMs ?? 0),
        ...(instance.causedBy ? { causedBy: instance.causedBy } : {}),
        ...(instance.elements?.length ? { elements: instance.elements } : {}),
      };
    }
    return null;
  }

}

export type EndureResult = {
  map: MapFile;
  /** Cells whose stack changed — every index over them is now suspect. */
  changed: Coord[];
};

/**
 * `stack` with every anonymous placement of `tileId` turned, or null when
 * nothing in it turns.
 *
 * The same three refusals `./decay`'s `decayedStack` makes, and for the same
 * reasons: a placement somebody is driving is left alone rather than stranding
 * an actor, one carrying an item id is left alone rather than turning every copy
 * in the cell, and a target that has left the catalogue reads as a swap that
 * never happened rather than as content quietly deleting itself.
 */
function consumedStack(
  map: MapFile,
  consumed: Consumed,
  tilesById: Record<string, TileDef>,
): PlacedTile[] | null {
  const { cell, tileId, becomes } = consumed;
  if (becomes && !tilesById[becomes]) return null;

  const stack = getStack(map, cell.x, cell.y, cell.z);
  const next: PlacedTile[] = [];
  let turned = false;
  for (const placed of stack) {
    if (placed.tileId !== tileId || placed.owner || placed.itemId) {
      next.push(placed);
      continue;
    }
    turned = true;
    if (becomes) next.push({ ...placed, tileId: becomes });
  }
  if (!turned) return null;

  // Refused rather than forced, exactly as a decay's swap and a plate's are:
  // whatever this becomes has to fit under what has been stacked on it since.
  return canReplaceStack(map, cell.x, cell.y, cell.z, next, tilesById).ok
    ? next
    : null;
}

/**
 * Turn every placement that has been worn through, in one pass.
 *
 * A turn that cannot happen — the placement is gone, somebody is driving it,
 * what it becomes will not fit — is abandoned rather than retried, on
 * `applyDecay`'s terms: retrying would hold the world awake spinning on a swap
 * that is never going to fit, and the cell is armed again for free the next time
 * anything disturbs it.
 */
export function applyConsumed(
  map: MapFile,
  consumed: Iterable<Consumed>,
  tilesById: Record<string, TileDef>,
): EndureResult {
  const changed: Coord[] = [];
  let next = map;
  for (const one of consumed) {
    const stack = consumedStack(next, one, tilesById);
    if (!stack) continue;
    next = replaceStack(next, one.cell.x, one.cell.y, one.cell.z, stack);
    changed.push(one.cell);
  }
  return { map: next, changed };
}

/** The placements in this cell that suffer `statusId`, with what wears them. */
export function sufferersIn(
  map: MapFile,
  cell: Coord,
  statusId: string,
  tilesById: Record<string, TileDef>,
): { tileId: string; endure: EndureInteraction; affliction: Affliction }[] {
  const out: {
    tileId: string;
    endure: EndureInteraction;
    affliction: Affliction;
  }[] = [];
  const seen = new Set<string>();
  for (const placed of getStack(map, cell.x, cell.y, cell.z)) {
    // Two placements of one tile in a cell share a pool — see {@link poolKey} —
    // so offering the same tile id twice would be two afflictions of one thing.
    if (seen.has(placed.tileId)) continue;
    if (placed.owner || placed.itemId) continue;
    const endure = endureOf(placed.tileId, tilesById);
    if (!endure) continue;
    const affliction = afflictionFor(endure, statusId);
    if (!affliction) continue;
    seen.add(placed.tileId);
    out.push({ tileId: placed.tileId, endure, affliction });
  }
  return out;
}
