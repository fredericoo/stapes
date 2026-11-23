import * as v from "valibot";
import { coversCells, footprintOf, type PlacedTile } from "../../../lib/types";
import { PATH_COUNT_RANGE, PATH_WIDTH_RANGE, forestPaths } from "../../forest";
import { fbm, gridIndex, gridX, gridY, hashCell, inGrid, newGrid, randomAt } from "../../generator";
import type { Component } from "../build";
import { TILES, field } from "../field";
import { anchorFrom, atCliffFoot, placer } from "../placing";
import { OPEN, OUTSIDE, TREE, growWoodland } from "../woodland";

const ForestSchema = v.object({
  onlyOn: v.optional(field.tiles(TILES.ground, 1), ["sand", "grass", "grass-2"]),
  trees: v.optional(field.weighted(TILES.standing), [
    { tile: "tree", weight: 60 },
    { tile: "old-tree", weight: 1 },
  ]),
  density: v.optional(field.percent(), 55),
  edge: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(24)), 6),
  outliers: v.optional(field.percent(), 3),
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
    { tile: "small-bush", weight: 4 },
    { tile: "bush", weight: 1 },
    { tile: "tree-stump", weight: 1 },
  ]),
  undergrowthDensity: v.optional(field.percent(), 6),
});

export type ForestProps = v.InferOutput<typeof ForestSchema>;

const UNDERGROWTH_SALT = 0x0dd5;
const PICK_SALT = 0x91c4;
const STAND_SALT = 0x57a2;
const UINT32 = 4294967296;

/** How many cells across a stand of one kind of tree is. */
const STAND_SCALE = 13;

/** How strongly a stand favours its kind: at the noise's usual spread, about eight to one. */
const STAND_CONTRAST = 7;

/** How much more undergrowth grows where the canopy is half closed than in the deep wood or the open. */
const FRINGE_BOOST = 4;

type Weighted = ReadonlyArray<{ tile: string; weight: number }>;

/** The entry a uniform 32-bit `hash` lands on when each takes a share of the range in proportion to its weight. */
function pickWeighted(entries: Weighted, hash: number, scale?: (index: number) => number) {
  const weights = entries.map((e, n) => e.weight * (scale ? scale(n) : 1));
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return null;
  let at = (hash / UINT32) * total;
  for (let n = 0; n < entries.length; n++) {
    at -= weights[n]!;
    if (at < 0) return entries[n]!.tile;
  }
  return entries.at(-1)!.tile;
}

/**
 * Plants a wood (`growWoodland`) on the cells of its frame whose top tile is
 * one it may grow on and its masks leave in. It adds to a stack rather than
 * replacing it, so the ground under it is whatever the nodes before it laid.
 * Each kind of tree is weighted up and down by its own noise field, so the
 * mix comes in stands rather than evenly salted. A tree or a plant wider than
 * a cell grows south and east of the cell it starts in, and only where every
 * cell it covers is its own kind of ground; where it does not fit, the
 * commonest one-cell tree stands there instead. Nothing grows at the foot of
 * a cliff (`atCliffFoot`).
 */
export const forest: Component<ForestProps> = {
  type: "forest",
  label: "Forest",
  starter: { frame: { x: 2, y: 2, w: 16, h: 12 } },
  schema: ForestSchema,
  build(ctx, props) {
    for (const { tile } of props.trees) {
      if (!ctx.tilesById[tile]) return { ok: false, reason: `There is no tile called ${tile}` };
    }
    if (props.path && !ctx.tilesById[props.path]) {
      return { ok: false, reason: `There is no tile called ${props.path}` };
    }
    const grid = newGrid(ctx.bounds);
    const path = forestPaths(grid, ctx.bounds, ctx.seed, props.paths, props.pathWidth);
    const onlyOn = new Set(props.onlyOn);
    const grows = (x: number, y: number) => {
      const top = ctx.stackAt(x, y).at(-1);
      return !!top && onlyOn.has(top.tileId) && ctx.covered(x, y);
    };
    const ours = new Set<number>();
    for (const i of path) if (grows(gridX(grid, i), gridY(grid, i))) ours.add(i);
    const wood = growWoodland(ctx.bounds, grows, ours, {
      seed: ctx.seed,
      density: props.density / 100,
      edge: props.edge,
      outliers: props.outliers / 100,
    });
    const cellAt = (x: number, y: number) =>
      inGrid(grid, x, y) ? wood.cells[gridIndex(grid, x, y)]! : OUTSIDE;
    const single = [...props.trees]
      .filter((t) => !coversCells(footprintOf(ctx.tilesById[t.tile])))
      .sort((a, b) => b.weight - a.weight)[0]?.tile;
    const placing = placer(ctx);
    const wooded = (stack: readonly PlacedTile[], x: number, y: number) =>
      onlyOn.has(stack.at(-1)!.tileId) && cellAt(x, y) === TREE && !atCliffFoot(ctx, x, y);
    const open = (stack: readonly PlacedTile[], x: number, y: number) =>
      onlyOn.has(stack.at(-1)!.tileId) &&
      cellAt(x, y) === OPEN &&
      !ours.has(gridIndex(grid, x, y)) &&
      !atCliffFoot(ctx, x, y);
    const stand = (x: number, y: number) => (n: number) => {
      const swing = fbm(x, y, ctx.seed ^ (STAND_SALT + n * 0x9e37), STAND_SCALE, 2);
      return Math.exp(STAND_CONTRAST * (swing - 0.5));
    };
    for (let y = ctx.bounds.minY; y <= ctx.bounds.maxY; y++) {
      for (let x = ctx.bounds.minX; x <= ctx.bounds.maxX; x++) {
        if (placing.taken(x, y)) continue;
        const i = gridIndex(grid, x, y);
        const cell = wood.cells[i]!;
        if (cell === OUTSIDE) continue;
        if (ours.has(i)) {
          if (props.path) placing.put(props.path, { x, y });
        } else if (cell === TREE) {
          const tree = pickWeighted(props.trees, hashCell(x, y, ctx.seed ^ PICK_SALT), stand(x, y));
          const def = tree ? ctx.tilesById[tree] : undefined;
          const put = tree ? placing.put(tree, anchorFrom(def, { x, y }), { on: wooded }) : null;
          if ((!put || !put.ok) && single && single !== tree) {
            placing.put(single, { x, y }, { on: wooded });
          }
        } else {
          const c = wood.canopy[i]!;
          const chance = (props.undergrowthDensity / 100) * (1 + FRINGE_BOOST * 4 * c * (1 - c));
          if (randomAt(x, y, ctx.seed ^ UNDERGROWTH_SALT) >= chance) continue;
          const plant = pickWeighted(props.undergrowth, hashCell(x, y, ctx.seed ^ PICK_SALT));
          const plantDef = plant ? ctx.tilesById[plant] : undefined;
          if (plant && plantDef) {
            placing.put(plant, anchorFrom(plantDef, { x, y }), { on: open });
          }
        }
      }
    }
    return { ok: true, edits: placing.edits };
  },
};
