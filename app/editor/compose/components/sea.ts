import * as v from "valibot";
import type { StackEdit } from "../../../lib/mapData";
import { placed } from "../../generator";
import type { Component } from "../build";
import { TILES, field } from "../field";

const SeaSchema = v.object({
  tiles: v.optional(field.tiles(TILES.any, 1), ["water", "deep-water"]),
});

export type SeaProps = v.InferOutput<typeof SeaSchema>;

/**
 * Fills its frame with open sea, replacing whatever was there, and is what a
 * tree starts from: the world is deep water until an island says otherwise.
 * Every cell has `water` under its `deep-water` because deep water's edge
 * fades to what lies beneath it, so where an island's shallows meet it the
 * fade shows shallow water rather than nothing.
 */
export const sea: Component<SeaProps> = {
  type: "sea",
  label: "Sea",
  starter: { frame: { x: 0, y: 0, w: 128, h: 96 } },
  schema: SeaSchema,
  build(ctx, props) {
    const stack = props.tiles.map((id) => placed(id, ctx.tilesById));
    const edits: StackEdit[] = [];
    for (let y = ctx.bounds.minY; y <= ctx.bounds.maxY; y++) {
      for (let x = ctx.bounds.minX; x <= ctx.bounds.maxX; x++) {
        edits.push({ x, y, z: ctx.z, stack: [...stack] });
      }
    }
    return { ok: true, edits };
  },
};
