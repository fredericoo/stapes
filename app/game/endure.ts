import type { Affliction, EndureInteraction } from "../lib/interactions";
import { afflictionFor, resolveAddStatus, resolveEndure } from "../lib/interactions";
import { getStack, listCoords, replaceStack } from "../lib/mapData";
import type { StatusDef } from "../lib/status";
import type { Coord, MapFile, PlacedTile, TileDef } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import { canReplaceStack } from "../lib/validation";
import type { Element } from "../lib/element";
import { cellKey } from "./pressurePlates";
import type { Rng } from "./rng";
import { advanceStatuses, applyStatus, type StatusInstance } from "./statuses";

function poolKey(cell: Coord, tileId: string): string {
  return `${cellKey(cell)}|${tileId}`;
}

const HELD_EPSILON_MS = 1e-6;

export type Endurance = {
  cell: Coord;
  tileId: string;
  hp: number;
  endure: EndureInteraction;
  statuses: readonly StatusInstance[];
  heldMs: Readonly<Record<string, number>>;
};

export type Consumed = {
  cell: Coord;
  tileId: string;
  statusId: string;
  becomes: string;
  remainingMs: number;
  causedBy?: string;
  elements?: readonly Element[];
};

export type AfflictedPlacement = {
  x: number;
  y: number;
  z: number;
  tileId: string;
  defIds: string[];
};

function endureOf(tileId: string, tilesById: Record<string, TileDef>): EndureInteraction | null {
  const def = tilesById[tileId];
  return def ? resolveEndure(def) : null;
}

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

export function neighboursOf(cell: Coord): Coord[] {
  return [
    { x: cell.x + 1, y: cell.y, z: cell.z },
    { x: cell.x - 1, y: cell.y, z: cell.z },
    { x: cell.x, y: cell.y + 1, z: cell.z },
    { x: cell.x, y: cell.y - 1, z: cell.z },
  ];
}

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

export function cellAfflicts(
  map: MapFile,
  cell: Coord,
  tilesById: Record<string, TileDef>,
): boolean {
  return getStack(map, cell.x, cell.y, cell.z).some((placed) => {
    const def = tilesById[placed.tileId];
    return def != null && resolveAddStatus(def)?.ground === true;
  });
}

export function findAfflictCells(map: MapFile, tilesById: Record<string, TileDef>): Coord[] {
  const out: Coord[] = [];
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { x, y } of listCoords(map, z)) {
      const cell = { x, y, z };
      if (cellAfflicts(map, cell, tilesById)) out.push(cell);
    }
  }
  return out;
}

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
    const addStatus = def ? resolveAddStatus(def) : null;
    if (!addStatus?.ground) continue;
    out.push({
      statusId: addStatus.statusId,
      ...(placed.castBy ? { causedBy: placed.castBy } : {}),
      ...(placed.castElements?.length ? { elements: placed.castElements } : {}),
    });
  }
  return out;
}

export class EndureIndex {
  private readonly pools = new Map<string, Endurance>();
  private readonly rng: Rng;

  constructor(rng: Rng) {
    this.rng = rng;
  }

  pending(): boolean {
    return this.pools.size > 0;
  }

  statusesAt(cell: Coord, tileId: string): readonly StatusInstance[] {
    return this.pools.get(poolKey(cell, tileId))?.statuses ?? [];
  }

  afflicted(): Iterable<Endurance> {
    return this.pools.values();
  }

  afflictedPlacements(): AfflictedPlacement[] {
    const out: AfflictedPlacement[] = [];
    for (const pool of this.pools.values()) {
      if (pool.statuses.length === 0) continue;
      out.push({
        x: pool.cell.x,
        y: pool.cell.y,
        z: pool.cell.z,
        tileId: pool.tileId,
        defIds: pool.statuses.map((one) => one.defId),
      });
    }
    return out;
  }

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
    const pool = this.poolFor(cell, tileId, endure);
    this.pools.set(poolKey(cell, tileId), {
      ...pool,
      statuses: applyStatus(pool.statuses, def, this.rng, range, causedBy, elements),
    });
    return true;
  }

  hold(
    cell: Coord,
    tileId: string,
    endure: EndureInteraction,
    def: StatusDef,
    tickMs: number,
    everyMs: number,
    causedBy?: string,
    elements?: readonly Element[],
  ): boolean {
    if (!afflictionFor(endure, def.id)) return false;
    const key = poolKey(cell, tileId);
    const pool = this.poolFor(cell, tileId, endure);
    const running = pool.statuses.some((one) => one.defId === def.id);

    let heldMs = 0;
    if (running) {
      heldMs = (pool.heldMs[def.id] ?? 0) + tickMs;
      /**
       * Compared against the epsilon rather than the figure itself: thirty
       * ticks come to a hair over a second, and an exact comparison would be
       * a tick late half the time.
       */
      if (heldMs + HELD_EPSILON_MS < everyMs) {
        this.pools.set(key, { ...pool, heldMs: { ...pool.heldMs, [def.id]: heldMs } });
        return false;
      }
      heldMs -= everyMs;
    }

    this.pools.set(key, {
      ...pool,
      statuses: applyStatus(pool.statuses, def, this.rng, undefined, causedBy, elements),
      heldMs: { ...pool.heldMs, [def.id]: heldMs },
    });
    return true;
  }

  private poolFor(cell: Coord, tileId: string, endure: EndureInteraction): Endurance {
    return (
      this.pools.get(poolKey(cell, tileId)) ?? {
        cell: { ...cell },
        tileId,
        hp: endure.durability,
        endure,
        statuses: [],
        heldMs: {},
      }
    );
  }

  advance(tickMs: number, statusDefs: Record<string, StatusDef>): Consumed[] {
    if (this.pools.size === 0) return [];

    const consumed: Consumed[] = [];
    for (const [key, pool] of this.pools) {
      const durability = pool.endure.durability;
      const tick = advanceStatuses(
        pool.statuses,
        tickMs,
        { hp: pool.hp, maxHp: durability, statuses: pool.statuses },
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

      this.pools.delete(key);
      const finisher = this.finisherOf(pool, tick.statuses, statusDefs);
      if (finisher) consumed.push(finisher);
    }
    return consumed;
  }

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
  changed: Coord[];
};

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

  return canReplaceStack(map, cell.x, cell.y, cell.z, next, tilesById).ok ? next : null;
}

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
