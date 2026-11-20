import * as v from "valibot";
import { stackHeight, type StackEdit } from "../../../lib/mapData";
import { HEIGHT_PER_LEVEL, physicalHeight } from "../../../lib/types";
import { PATH_COUNT_RANGE, PATH_WIDTH_RANGE, growForest } from "../../forest";
import { gridIndex, hashCell, isOpen, placed, randomAt } from "../../generator";
import type { Component } from "../build";
import { TILES, field } from "../field";

const ForestSchema = v.object({
  onlyOn: v.optional(field.tiles(TILES.ground, 1), ["sand", "grass", "grass-2"]),
  tree: v.optional(field.tile(TILES.standing), "tree"),
  density: v.optional(field.percent(), 55),
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
  path: v.optional(v.nullable(field.tile(TILES.ground)), "dirt"),
  undergrowth: v.optional(field.weighted(TILES.standing), [
    { tile: "small-bush", weight: 3 },
    { tile: "tree-stump", weight: 1 },
  ]),
  undergrowthDensity: v.optional(field.percent(), 6),
});

export type ForestProps = v.InferOutput<typeof ForestSchema>;

const UNDERGROWTH_SALT = 0x0dd5;
const PICK_SALT = 0x91c4;
const UINT32 = 4294967296;

/** The entry a uniform 32-bit `hash` lands on when each takes a share of the range in proportion to its weight. */
function pickWeighted(entries: ReadonlyArray<{ tile: string; weight: number }>, hash: number) {
  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  if (total <= 0) return null;
  let at = (hash / UINT32) * total;
  for (const e of entries) {
    at -= e.weight;
    if (at < 0) return e.tile;
  }
  return entries.at(-1)!.tile;
}

/**
 * Grows the editor forest's shape over its frame and keeps only the cells
 * whose top tile is one it may grow on. It adds to a stack rather than
 * replacing it, so the ground under it is whatever the nodes before it laid.
 */
export const forest: Component<ForestProps> = {
  type: "forest",
  label: "Forest",
  starter: { frame: { x: 2, y: 2, w: 16, h: 12 } },
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
        } else if (
          isOpen(grid, x, y) &&
          randomAt(x, y, ctx.seed ^ UNDERGROWTH_SALT) * 100 < props.undergrowthDensity
        ) {
          const plant = pickWeighted(props.undergrowth, hashCell(x, y, ctx.seed ^ PICK_SALT));
          const plantDef = plant && ctx.tilesById[plant];
          if (
            plantDef &&
            stackHeight(stack, ctx.tilesById) + physicalHeight(plantDef) <= HEIGHT_PER_LEVEL
          ) {
            edits.push({ x, y, z: ctx.z, stack: [...stack, placed(plant, ctx.tilesById)] });
          }
        }
      }
    }
    return { ok: true, edits };
  },
};
