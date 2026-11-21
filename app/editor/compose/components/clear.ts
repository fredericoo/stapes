import * as v from "valibot";
import type { StackEdit } from "../../../lib/mapData";
import type { Component } from "../build";
import { TILES, field } from "../field";

const ClearSchema = v.object({
  remove: v.optional(field.tiles(TILES.any, 1), ["tree", "old-tree", "apple-tree", "dead-tree"]),
});

export type ClearProps = v.InferOutput<typeof ClearSchema>;

/**
 * Takes the tiles in `remove` out of whatever the layers before it built,
 * wherever its masks leave it in (its whole frame without any). A mask on a
 * layer only stops that layer placing tiles; this is how something already
 * placed comes out again, such as the big trees in one corner of a forest.
 */
export const clear: Component<ClearProps> = {
  type: "clear",
  label: "Clear",
  starter: {},
  schema: ClearSchema,
  build(ctx, props) {
    const remove = new Set(props.remove);
    const edits: StackEdit[] = [];
    for (let y = ctx.bounds.minY; y <= ctx.bounds.maxY; y++) {
      for (let x = ctx.bounds.minX; x <= ctx.bounds.maxX; x++) {
        if (!ctx.covered(x, y)) continue;
        const stack = ctx.stackAt(x, y);
        const kept = stack.filter((p) => !remove.has(p.tileId));
        if (kept.length !== stack.length) edits.push({ x, y, z: ctx.z, stack: kept });
      }
    }
    return { ok: true, edits };
  },
};
