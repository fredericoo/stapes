import { normalizeTileDef } from "./types";
import type { TileDef } from "./types";

export const FRAME = {
  sprite: {
    tilesetId: "basic",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  durationMs: 200,
};

export function tile(partial: Record<string, unknown> & Pick<TileDef, "id">): TileDef {
  return normalizeTileDef({
    name: partial.id,
    height: 0,
    directional: false,
    variants: { default: [FRAME] },
    attributes: {},
    ...partial,
  });
}
