import { getFrames } from "../lib/tileResolve";
import type { TileDef } from "../lib/types";

const PLAYER_SPRITE_CELLS = 2 * 2;

/**
 * The side of a square with the sprite's area, over the side of the player's:
 * a 4×4 body draws a plume twice as large, and a rat's 1×2 and 2×1 draw it the
 * same size. Measured on the idle frame facing south, so a body that is wider
 * side-on does not change size as it turns.
 */
export function plumeScale(def: TileDef | undefined): number {
  const rect = def ? getFrames(def, {})?.[0]?.sprite.rect : undefined;
  if (!rect) return 1;
  return Math.sqrt((rect.w * rect.h) / PLAYER_SPRITE_CELLS);
}
