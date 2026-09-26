import { chunkKeyFor } from "../lib/mapData";
import { visibleStack } from "./interest";
import type { CellPatch, MotionEvent } from "./protocol";

export type Audience = { kind: "actor"; actorId: string } | { kind: "cell"; x: number; y: number };

export function audienceOf(event: MotionEvent): Audience {
  switch (event.kind) {
    case "projectileFired":
      return { kind: "cell", x: event.from.x, y: event.from.y };
    case "damage":
    case "tileTransition":
      return { kind: "cell", x: event.x, y: event.y };
    default:
      return { kind: "actor", actorId: event.actorId };
  }
}

export type ScopedCell = {
  cell: CellPatch;
  terrain: boolean;
  bodies: readonly string[];
  chunk?: string;
};

export function cellInScope(
  scoped: ScopedCell,
  chunks: ReadonlySet<string>,
  held: ReadonlySet<string>,
  known: ReadonlySet<string>,
): CellPatch | null {
  const { cell, terrain, bodies } = scoped;
  if (!chunks.has(scoped.chunk ?? chunkKeyFor(cell.x, cell.y))) return null;
  /**
   * Held or known, not held alone: the two sets differ for exactly one
   * tick, and a body that died or walked out of reach in that tick is one
   * whose departure patch — the one that takes its tile off this client's
   * board — must not be dropped.
   */
  if (!terrain && !bodies.some((o) => held.has(o) || known.has(o))) return null;
  const stack = visibleStack(cell.stack, held);
  return stack === cell.stack ? cell : { ...cell, stack };
}
