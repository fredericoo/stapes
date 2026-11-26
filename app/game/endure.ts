import type { Affliction, EndureInteraction } from "../lib/interactions";
import { afflictionFor, resolveAddStatus, resolveDecay, resolveEndure } from "../lib/interactions";
import { getStack, listCoords, presentLevels, replaceStack } from "../lib/mapData";
import type { StatusDef } from "../lib/status";
import type { Coord, MapFile, PlacedTile, TileDef } from "../lib/types";
import { canReplaceStack } from "../lib/validation";
import type { Element } from "../lib/element";
import { cellKey } from "./pressurePlates";
import type { Rng } from "./rng";
import { advanceStatuses, applyStatus, type StatusInstance } from "./statuses";
import { reached } from "./ticks";

function poolKey(cell: Coord, tileId: string): string {
  return `${cellKey(cell)}|${tileId}`;
}

export type Endurance = {
  cell: Coord;
  tileId: string;
  hp: number;
  endure: EndureInteraction;
  statuses: readonly StatusInstance[];
  heldMs: Readonly<Record<string, number>>;
  kindledBy?: Kindling;
  spreadMs: number;
};

/** `hopsLeft` is how many more cells this fire may travel from `flame`; at zero a placement burns but lights nothing around it. */
export type Kindling = { flame: Coord; hopsLeft: number };

export const FIRE_REACH_CELLS = 1;

export type Ember = {
  cell: Coord;
  statusId: string;
  kindledBy: Kindling;
  causedBy?: string;
  elements?: readonly Element[];
};

export type Consumed = {
  cell: Coord;
  tileId: string;
  statusId: string;
  becomes: string;
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

export function neighboursOf(cell: Coord): Coord[] {
  return [
    { x: cell.x + 1, y: cell.y, z: cell.z },
    { x: cell.x - 1, y: cell.y, z: cell.z },
    { x: cell.x, y: cell.y + 1, z: cell.z },
    { x: cell.x, y: cell.y - 1, z: cell.z },
  ];
}

export function cellAfflicts(
  map: MapFile,
  cell: Coord,
  tilesById: Record<string, TileDef>,
): boolean {
  return stackAfflicts(getStack(map, cell.x, cell.y, cell.z), tilesById);
}

export function stackAfflicts(
  stack: readonly PlacedTile[],
  tilesById: Record<string, TileDef>,
): boolean {
  return stack.some((placed) => {
    const def = tilesById[placed.tileId];
    return def != null && resolveAddStatus(def)?.ground === true;
  });
}

export function findAfflictCells(map: MapFile, tilesById: Record<string, TileDef>): Coord[] {
  const out: Coord[] = [];
  for (const z of presentLevels(map)) {
    for (const { x, y } of listCoords(map, z)) {
      const cell = { x, y, z };
      if (cellAfflicts(map, cell, tilesById)) out.push(cell);
    }
  }
  return out;
}

export type GroundSource = {
  statusId: string;
  /** Only a source that goes out by itself may spread, or a hearth would burn every connected meadow on the map. */
  fades: boolean;
  causedBy?: string;
  elements?: readonly Element[];
};

export function flameLives(
  map: MapFile,
  cell: Coord,
  statusId: string,
  tilesById: Record<string, TileDef>,
): boolean {
  return afflictionsFrom(map, cell, tilesById).some(
    (source) => source.fades && source.statusId === statusId,
  );
}

export function afflictionsFrom(
  map: MapFile,
  cell: Coord,
  tilesById: Record<string, TileDef>,
): GroundSource[] {
  const out: GroundSource[] = [];
  for (const placed of getStack(map, cell.x, cell.y, cell.z)) {
    const def = tilesById[placed.tileId];
    const addStatus = def ? resolveAddStatus(def) : null;
    if (!addStatus?.ground) continue;
    out.push({
      statusId: addStatus.statusId,
      fades: resolveDecay(def!) != null,
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

  /**
   * Only a pool under a status changes with time; one left damaged by a fire
   * that has gone out keeps its hp but needs no ticks.
   */
  pending(): boolean {
    for (const pool of this.pools.values()) {
      if (pool.statuses.length > 0) return true;
    }
    return false;
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
    kindledBy?: Kindling,
  ): boolean {
    if (!afflictionFor(endure, def.id)) return false;
    const pool = this.poolFor(cell, tileId, endure);
    this.pools.set(poolKey(cell, tileId), {
      ...pool,
      statuses: applyStatus(pool.statuses, def, this.rng, range, causedBy, elements),
      ...kindled(pool, kindledBy),
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
    kindledBy?: Kindling,
  ): boolean {
    if (!afflictionFor(endure, def.id)) return false;
    const key = poolKey(cell, tileId);
    const pool = this.poolFor(cell, tileId, endure);
    const running = pool.statuses.some((one) => one.defId === def.id);

    let heldMs = 0;
    if (running) {
      heldMs = (pool.heldMs[def.id] ?? 0) + tickMs;
      if (!reached(heldMs, everyMs)) {
        this.pools.set(key, { ...pool, heldMs: { ...pool.heldMs, [def.id]: heldMs } });
        return false;
      }
      heldMs -= everyMs;
    }

    this.pools.set(key, {
      ...pool,
      statuses: applyStatus(pool.statuses, def, this.rng, undefined, causedBy, elements),
      heldMs: { ...pool.heldMs, [def.id]: heldMs },
      ...kindled(pool, kindledBy),
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
        spreadMs: 0,
      }
    );
  }

  /**
   * Each burning placement a fading flame lit renews its status on itself and
   * passes it to its neighbours once every `everyMs`. The caller decides whether that flame is
   * still there, since only it holds the map.
   */
  embers(tickMs: number, everyMs: number): Ember[] {
    const out: Ember[] = [];
    for (const [key, pool] of this.pools) {
      const kindledBy = pool.kindledBy;
      if (!kindledBy || pool.statuses.length === 0) continue;
      const spreadMs = pool.spreadMs + tickMs;
      if (!reached(spreadMs, everyMs)) {
        this.pools.set(key, { ...pool, spreadMs });
        continue;
      }
      this.pools.set(key, { ...pool, spreadMs: spreadMs - everyMs });
      for (const instance of pool.statuses) out.push(emberOf(pool, kindledBy, instance));
    }
    return out;
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
        this.pools.set(key, { ...pool, hp, statuses: tick.statuses, ...outIfCold(tick.statuses) });
        continue;
      }

      this.pools.delete(key);
      const finisher = this.finisherOf(pool, statusDefs);
      if (finisher) consumed.push(finisher);
    }
    return consumed;
  }

  private finisherOf(pool: Endurance, statusDefs: Record<string, StatusDef>): Consumed | null {
    for (const instance of pool.statuses) {
      const affliction = afflictionFor(pool.endure, instance.defId);
      if (!affliction || !statusDefs[instance.defId]) continue;
      return {
        cell: pool.cell,
        tileId: pool.tileId,
        statusId: instance.defId,
        becomes: affliction.tileId,
        ...(instance.causedBy ? { causedBy: instance.causedBy } : {}),
        ...(instance.elements?.length ? { elements: instance.elements } : {}),
      };
    }
    return null;
  }
}

/** A placement lit from two sides keeps the kindling nearer its flame, so a farther ember cannot shorten how far it may still spread. */
function kindled(pool: Endurance, kindledBy: Kindling | undefined): Partial<Endurance> {
  const held = pool.kindledBy;
  if (!kindledBy || (held && held.hopsLeft >= kindledBy.hopsLeft)) return { kindledBy: held };
  return { kindledBy: { flame: { ...kindledBy.flame }, hopsLeft: kindledBy.hopsLeft } };
}

/** A placement whose fire went out forgets the flame that lit it, so a new flame on that old cell cannot spread through it. */
function outIfCold(statuses: readonly StatusInstance[]): Partial<Endurance> {
  return statuses.length === 0 ? { kindledBy: undefined, spreadMs: 0 } : {};
}

function emberOf(pool: Endurance, kindledBy: Kindling, instance: StatusInstance): Ember {
  return {
    cell: pool.cell,
    statusId: instance.defId,
    kindledBy,
    ...(instance.causedBy ? { causedBy: instance.causedBy } : {}),
    ...(instance.elements?.length ? { elements: instance.elements } : {}),
  };
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
