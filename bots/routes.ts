import { navigationLegs, NAVIGATION_MAX_NODES, type NavWorld } from "../app/game/navigation";
import { cellKey } from "../app/game/pressurePlates";
import { DIR_DELTA } from "../app/game/movement";
import type { Coord } from "../app/lib/types";

/** How many legs of the walk from one place reach each standing cell, by the fewest. */
export type Walks = ReadonlyMap<string, number>;

/**
 * Every standing cell reachable from `from` through cells `within` allows,
 * with the fewest legs it takes. `from` itself is reached whatever `within`
 * says of it, so a bot standing in a danger zone still has a way out.
 */
export function walksFrom(
  world: NavWorld,
  from: Coord,
  within: (cell: Coord) => boolean,
  maxCells = NAVIGATION_MAX_NODES,
): Walks {
  const walks = new Map<string, number>([[cellKey(from), 0]]);
  const queue: Coord[] = [from];
  for (let head = 0; head < queue.length && walks.size < maxCells; head++) {
    const at = queue[head]!;
    const legs = walks.get(cellKey(at))! + 1;
    for (const leg of navigationLegs(world, at)) {
      const key = cellKey(leg.to);
      if (walks.has(key) || !within(leg.to)) continue;
      walks.set(key, legs);
      queue.push(leg.to);
    }
  }
  return walks;
}

/**
 * The fewest legs to `at` or to a cell beside it on its level, since a
 * resource is worked from beside it and a creature is met there; null when
 * no route reaches it.
 */
export function legsTo(walks: Walks, at: Coord): number | null {
  let fewest = walks.get(cellKey(at)) ?? Infinity;
  for (const { dx, dy } of Object.values(DIR_DELTA)) {
    fewest = Math.min(
      fewest,
      walks.get(cellKey({ x: at.x + dx, y: at.y + dy, z: at.z })) ?? Infinity,
    );
  }
  return Number.isFinite(fewest) ? fewest : null;
}
