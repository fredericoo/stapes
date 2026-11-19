import { resolveWorth } from "./item";
import type { TileDef } from "./types";

export type Denomination = { readonly tileId: string; readonly worth: number };

const denominationsByCatalogue = new WeakMap<Record<string, TileDef>, readonly Denomination[]>();

/** Every tile with a worth, largest first; ties fall back to the id so the order is stable. */
export function denominations(tilesById: Record<string, TileDef>): readonly Denomination[] {
  const cached = denominationsByCatalogue.get(tilesById);
  if (cached) return cached;
  const out: Denomination[] = [];
  for (const def of Object.values(tilesById)) {
    const worth = resolveWorth(def);
    if (worth > 0) out.push({ tileId: def.id, worth });
  }
  out.sort((a, b) => b.worth - a.worth || a.tileId.localeCompare(b.tileId));
  denominationsByCatalogue.set(tilesById, out);
  return out;
}

export function isMoney(tilesById: Record<string, TileDef>, tileId: string): boolean {
  const def = tilesById[tileId];
  return def !== undefined && resolveWorth(def) > 0;
}

/**
 * `amount` as the fewest coins, largest first. With no coin of worth 1 in the
 * catalogue some amounts cannot be made exactly, and what is left over is
 * dropped rather than rounded up.
 */
export function splitCash(
  tilesById: Record<string, TileDef>,
  amount: number,
): Array<{ tileId: string; count: number }> {
  const out: Array<{ tileId: string; count: number }> = [];
  let left = amount;
  for (const { tileId, worth } of denominations(tilesById)) {
    const count = Math.floor(left / worth);
    if (count === 0) continue;
    out.push({ tileId, count });
    left -= count * worth;
  }
  return out;
}
