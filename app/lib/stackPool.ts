import type { PlacedTile } from "./types";

const pooled = new WeakSet<readonly PlacedTile[]>();

/**
 * A stack whose placements hold only strings, numbers and booleans. Anything
 * nested (contents, spots, a span, a teleport) could be edited in place
 * without the shallow freeze below noticing, so those stacks are never pooled.
 */
function isFlat(stack: readonly PlacedTile[]): boolean {
  for (const placed of stack) {
    for (const key in placed) {
      const value = placed[key as keyof PlacedTile];
      if (typeof value === "object" && value !== null) return false;
    }
  }
  return true;
}

export function isPooledStack(stack: readonly PlacedTile[]): boolean {
  return pooled.has(stack);
}

/**
 * Hands out one frozen copy of each distinct stack, so the many cells of a
 * world that hold the same tiles share one array. A world of 480k cells holds
 * about 1,700 distinct stacks. Placement objects are shared only within a
 * stack, never between two different stacks, so a placement found at one
 * index of one stack is at that index in every cell that shares it.
 */
export class StackPool {
  private readonly byText = new Map<string, PlacedTile[]>();

  /**
   * `text` is the stack's JSON when the caller already has it, as a parser
   * does. A stack that cannot be pooled is returned as given, so a caller
   * that does not own `stack` copies it first.
   */
  share(stack: PlacedTile[], text?: string): PlacedTile[] {
    if (pooled.has(stack) || !isFlat(stack)) return stack;
    const key = text ?? JSON.stringify(stack);
    const kept = this.byText.get(key);
    if (kept) return kept;
    const copy = Object.freeze(stack.map((placed) => Object.freeze({ ...placed }))) as PlacedTile[];
    pooled.add(copy);
    this.byText.set(key, copy);
    return copy;
  }

  /** Parses `text` only the first time it is seen. */
  shareText(text: string): PlacedTile[] {
    return this.byText.get(text) ?? this.share(JSON.parse(text) as PlacedTile[], text);
  }

  get size(): number {
    return this.byText.size;
  }
}
