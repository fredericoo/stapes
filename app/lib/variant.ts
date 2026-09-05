import type { StateSprites, TileSprite } from "./types";

/**
 * The faces a `variant` tile authors, in the order they were written.
 *
 * Object key order is insertion order for string keys, which is what makes the
 * editor's list stable and the "first authored" fallback below mean something
 * an author can see. A tile whose faces are named `1`, `2`, `3` would sort
 * numerically instead — one more reason the editor refuses a purely numeric
 * name.
 */
export function variantKeys(holder: StateSprites): string[] {
  return Object.keys(holder.variants ?? {});
}

/**
 * Which face this placement wears: the one it names, else the first authored.
 *
 * The fallback is doing two jobs. It answers a placement that names nothing —
 * every one of them, until an author picks — and it answers a placement naming
 * a face that has since been renamed away. Both draw the wrong art rather than
 * nothing, on the same grounds `pickScatterSprite` falls back: art that is not
 * what the author meant reads as art not finished, and a blank cell reads as a
 * hole in the world. Which is a particularly bad way to be wrong about a tile
 * whose whole job is to be a hole in the world.
 */
export function pickVariantSprite(
  /** Any sprite holder — a def for the idle state, a {@link StateSprites} for the rest. */
  holder: StateSprites,
  key: string | undefined,
): TileSprite | undefined {
  const variants = holder.variants;
  if (!variants) return undefined;
  if (key != null) {
    const named = variants[key];
    if (named) return named;
  }
  for (const sprite of Object.values(variants)) {
    if (sprite) return sprite;
  }
  return undefined;
}
