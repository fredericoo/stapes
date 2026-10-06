import { getStack, replaceStack } from "../lib/mapData";
import type { Coord, MapFile, PlacedTile } from "../lib/types";

/**
 * What a predicted act did to the things in one cell, by identity rather than
 * by stack index, so it can be laid again over a server stack that has since
 * gained or lost a body, or already carries the same change.
 */
export type CellEdit = Coord & { removed: string[]; placed: [key: string, thing: PlacedTile][] };

/**
 * An item is known by its `itemId`. A thing without one — a chest, a barrel —
 * is known by its tile and how many of that tile sit under it, which taking an
 * item out from beneath it does not change.
 */
function keysOf(stack: readonly PlacedTile[]): (string | null)[] {
  const seen = new Map<string, number>();
  return stack.map((placed) => {
    if (placed.owner) return null;
    if (placed.itemId) return placed.itemId;
    const nth = seen.get(placed.tileId) ?? 0;
    seen.set(placed.tileId, nth + 1);
    return `${placed.tileId}#${nth}`;
  });
}

function keyed(stack: readonly PlacedTile[]): Map<string, PlacedTile> {
  const keys = keysOf(stack);
  const out = new Map<string, PlacedTile>();
  stack.forEach((placed, i) => {
    const key = keys[i];
    if (key) out.set(key, placed);
  });
  return out;
}

export function cellEdit(before: MapFile, after: MapFile, at: Coord): CellEdit | null {
  const was = keyed(getStack(before, at.x, at.y, at.z));
  const now = keyed(getStack(after, at.x, at.y, at.z));
  const removed = [...was.keys()].filter((key) => !now.has(key));
  const placed = [...now].filter(
    ([key, thing]) => JSON.stringify(was.get(key)) !== JSON.stringify(thing),
  );
  if (removed.length === 0 && placed.length === 0) return null;
  return { x: at.x, y: at.y, z: at.z, removed, placed };
}

/** A placed thing absent from the stack goes on top, where `appendItem` puts it. */
export function applyCellEdit(map: MapFile, edit: CellEdit): MapFile {
  const stack = getStack(map, edit.x, edit.y, edit.z);
  const keys = keysOf(stack);
  const removed = new Set(edit.removed);
  const pending = new Map(edit.placed);

  const next: PlacedTile[] = [];
  stack.forEach((thing, i) => {
    const key = keys[i];
    if (key && removed.has(key)) return;
    const replacement = key ? pending.get(key) : undefined;
    if (key) pending.delete(key);
    next.push(replacement ?? thing);
  });
  next.push(...pending.values());
  return replaceStack(map, edit.x, edit.y, edit.z, next);
}
