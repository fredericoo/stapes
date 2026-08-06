import { describe, expect, it } from "vitest";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { indexInteractive } from "./pick";

function tile(
  partial: Record<string, unknown> & Pick<TileDef, "id" | "height">,
): TileDef {
  return normalizeTileDef({
    name: partial.id,
    directional: false,
    variants: {
      default: [
        {
          sprite: {
            tilesetId: "basic",
            rect: { x: 0, y: 0, w: 1, h: 1 },
            base: { x: 0, y: 0 },
          },
          durationMs: 200,
        },
      ],
    },
    attributes: {},
    ...partial,
  });
}

const tilesById = tilesByIdFromList([
  tile({ id: "grass", height: 0 }),
  tile({ id: "slab", height: 1 }),
  tile({
    id: "crate",
    height: 1,
    interactions: {
      drag: { distanceTiles: 1, climb: "half", moveOnTileIds: [] },
    },
  }),
]);

describe("indexInteractive", () => {
  it("includes a top-of-stack interactive object", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "crate" },
    ]);
    expect(indexInteractive(map, 0, tilesById)).toEqual([
      { ref: { x: 0, y: 0, z: 0, stackIndex: 1 }, elevation: 0 },
    ]);
  });

  it("omits an interactive object buried under another tile", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "crate" },
      { tileId: "slab" },
    ]);
    expect(indexInteractive(map, 0, tilesById)).toEqual([]);
  });
});
