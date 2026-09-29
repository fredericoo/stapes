import type { StateSprites, TileSprite } from "./types";

export function variantKeys(holder: StateSprites): string[] {
  return Object.keys(holder.variants ?? {});
}

export function pickVariantSprite(
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
