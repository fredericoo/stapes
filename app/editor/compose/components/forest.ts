import * as v from "valibot";
import { stackHeight, type StackEdit } from "../../../lib/mapData";
import { HEIGHT_PER_LEVEL, physicalHeight } from "../../../lib/types";
import { FOREST_DENSITY_RANGE, PATH_COUNT_RANGE, PATH_WIDTH_RANGE, growForest } from "../../forest";
import { gridIndex, isOpen, placed } from "../../generator";
import type { Component } from "../build";
import { TileIdSchema } from "../doc";

const ForestSchema = v.object({
  onlyOn: v.optional(v.pipe(v.array(TileIdSchema), v.minLength(1)), ["sand", "grass", "grass-2"]),
  tree: v.optional(TileIdSchema, "tree"),
  density: v.optional(
    v.pipe(v.number(), v.minValue(FOREST_DENSITY_RANGE.min), v.maxValue(FOREST_DENSITY_RANGE.max)),
    55,
  ),
  paths: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(PATH_COUNT_RANGE.min),
      v.maxValue(PATH_COUNT_RANGE.max),
    ),
    1,
  ),
  pathWidth: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(PATH_WIDTH_RANGE.min),
      v.maxValue(PATH_WIDTH_RANGE.max),
    ),
    2,
  ),
  path: v.optional(v.nullable(TileIdSchema), "dirt"),
});

export type ForestProps = v.InferOutput<typeof ForestSchema>;

/**
 * Grows the editor forest's shape over its frame and keeps only the cells
 * whose top tile is one it may grow on. It adds to a stack rather than
 * replacing it, so the ground under it is whatever the nodes before it laid.
 */
export const forest: Component<ForestProps> = {
  type: "forest",
  label: "Forest",
  schema: ForestSchema,
  build(ctx, props) {
    const treeDef = ctx.tilesById[props.tree];
    if (!treeDef) return { ok: false, reason: `There is no tile called ${props.tree}` };
    if (props.path && !ctx.tilesById[props.path]) {
      return { ok: false, reason: `There is no tile called ${props.path}` };
    }
    const { grid, path } = growForest(ctx.bounds, {
      generator: "forest",
      seed: ctx.seed,
      density: props.density,
      groundTileId: props.onlyOn[0]!,
      treeTileId: props.tree,
      paths: props.paths,
      pathWidth: props.pathWidth,
      pathTileId: props.path,
      waterTileId: null,
      waterCoverage: 0,
      scatter: [],
    });
    const onlyOn = new Set(props.onlyOn);
    const treeHeight = physicalHeight(treeDef);
    const edits: StackEdit[] = [];
    for (let y = ctx.bounds.minY; y <= ctx.bounds.maxY; y++) {
      for (let x = ctx.bounds.minX; x <= ctx.bounds.maxX; x++) {
        const stack = ctx.stackAt(x, y);
        const top = stack.at(-1);
        if (!top || !onlyOn.has(top.tileId)) continue;
        if (path.has(gridIndex(grid, x, y))) {
          if (props.path)
            edits.push({ x, y, z: ctx.z, stack: [...stack, placed(props.path, ctx.tilesById)] });
        } else if (
          !isOpen(grid, x, y) &&
          stackHeight(stack, ctx.tilesById) + treeHeight <= HEIGHT_PER_LEVEL
        ) {
          edits.push({ x, y, z: ctx.z, stack: [...stack, placed(props.tree, ctx.tilesById)] });
        }
      }
    }
    return { ok: true, edits };
  },
};
