import * as v from "valibot";
import { coversCells, footprintOf, type PlacedTile } from "../../../lib/types";
import { PATH_COUNT_RANGE, PATH_WIDTH_RANGE, forestPaths } from "../../forest";
import { fbm, gridIndex, gridX, gridY, hashCell, inGrid, newGrid, randomAt } from "../../generator";
import type { Component } from "../build";
import { TILES, field } from "../field";
import { anchorFrom, atCliffFoot, placer } from "../placing";
import { TALL_TREES } from "../tallTrees";
import { OPEN, OUTSIDE, TREE, growWoodland } from "../woodland";

const ForestSchema = v.object({
  onlyOn: v.optional(field.tiles(TILES.ground, 1), ["sand", "grass", "grass-2"]),
  density: v.optional(field.percent(), 40),
  decay: v.optional(field.percent(), 0),
  foliage: v.optional(field.weighted(TILES.cover), [
    { tile: "tuft", weight: 4 },
    { tile: "fern", weight: 3 },
    { tile: "undergrowth", weight: 2 },
    { tile: "red-flowers", weight: 1 },
    { tile: "yellow-flowers", weight: 1 },
  ]),
  bushes: v.optional(field.weighted(TILES.standing), [
    { tile: "small-bush", weight: 3 },
    { tile: "bush", weight: 1 },
  ]),
  trees: v.optional(field.weighted(TILES.standing), [
    { tile: "tree", weight: 30 },
    { tile: "apple-tree", weight: 1 },
  ]),
  tall: v.optional(field.weighted(TILES.standing), [{ tile: "old-tree", weight: 1 }]),
  dead: v.optional(field.weighted(TILES.standing), [
    { tile: "dead-tree", weight: 3 },
    { tile: "tree-stump", weight: 2 },
    { tile: "fallen-log", weight: 2 },
  ]),
  edge: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(24)), 6),
  outliers: v.optional(field.percent(), 3),
  opensTo: v.optional(field.tiles(TILES.ground), []),
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
});

export type ForestProps = v.InferOutput<typeof ForestSchema>;

const COVER_SALT = 0x0dd5;
const PICK_SALT = 0x91c4;
const STAND_SALT = 0x57a2;
const TALL_SALT = 0x7a11;
const DECAY_SALT = 0xdeca;
const BUSH_SALT = 0xb054;
const UINT32 = 4294967296;

/**
 * What a wood holds at each `density`, in the deep wood where the canopy is
 * closed. Up to `TREES_FROM` it is ground cover alone, and a rare bush; from
 * there `trees` grow, up to `MOST_TREES` of the cells at 100; from
 * `TALL_FROM` a growing share of them are `tall` instead, up to `MOST_TALL`.
 * `MOST_TREES` is low on purpose: a wood is trees to walk round, never a wall.
 */
const TREES_FROM = 10;
const TALL_FROM = 50;
const MOST_TREES = 0.4;
const MOST_TALL = 0.4;
const MOST_FOLIAGE = 0.22;
const FEWEST_BUSHES = 0.01;
const MOST_BUSHES = 0.04;

export type ForestMix = { trees: number; tall: number; foliage: number; bushes: number };

export function forestMix(density: number): ForestMix {
  const d = Math.max(0, Math.min(100, density)) / 100;
  const band = (from: number, to: number) =>
    Math.max(0, Math.min(1, (d * 100 - from) / (to - from)));
  return {
    trees: MOST_TREES * band(TREES_FROM, 100),
    tall: MOST_TALL * band(TALL_FROM, 100),
    foliage: MOST_FOLIAGE * band(0, TREES_FROM),
    bushes: d === 0 ? 0 : FEWEST_BUSHES + (MOST_BUSHES - FEWEST_BUSHES) * d,
  };
}

/** How many cells across a stand of one kind of tree is. */
const STAND_SCALE = 13;

/**
 * How many cells clear of each other two tall trees (`TALL_TREES`) stand. A
 * tall tree takes one cell and its crown spreads over the cells round it, so
 * a stand of them packed cell to cell draws as one dark mass; the commonest
 * one-cell tree grows in between instead.
 */
const TALL_SPACING = 2;

/** How strongly a stand favours its kind: at the noise's usual spread, about eight to one. */
const STAND_CONTRAST = 7;

/** How much more ground cover grows where the canopy is half closed than in the deep wood or the open. */
const FRINGE_BOOST = 0.5;

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
 *
 * `density` picks what grows as well as how much (`forestMix`): ground cover
 * and a rare bush below 10, then `trees`, then from 50 a share of `tall`
 * trees in their place, each kept `TALL_SPACING` from the next. `decay` is
 * the share of trees that grow as one of `dead` instead. Each kind of tree is
 * weighted up and down by its own noise field, so the mix comes in stands
 * rather than evenly salted. A tile wider than a cell grows south and east of
 * the cell it starts in where every cell it covers is free ground of the
 * wood; where it does not fit, the commonest one-cell kind of its list stands
 * there instead. Nothing grows at the foot of a cliff (`atCliffFoot`). With
 * `opensTo`, the wood thins toward the ground tiles named there, such as a
 * road's, and toward its frame and masks, and is thickest where other ground,
 * such as a hill's foot, ends it.
 */
export const forest: Component<ForestProps> = {
  type: "forest",
  label: "Forest",
  starter: { frame: { x: 2, y: 2, w: 16, h: 12 } },
  schema: ForestSchema,
  build(ctx, props) {
    const lists = [props.foliage, props.bushes, props.trees, props.tall, props.dead];
    for (const { tile } of lists.flat()) {
      if (!ctx.tilesById[tile]) return { ok: false, reason: `There is no tile called ${tile}` };
    }
    if (props.path && !ctx.tilesById[props.path]) {
      return { ok: false, reason: `There is no tile called ${props.path}` };
    }
    const mix = forestMix(props.density);
    const grid = newGrid(ctx.bounds);
    const path = forestPaths(grid, ctx.bounds, ctx.seed, props.paths, props.pathWidth);
    const onlyOn = new Set(props.onlyOn);
    const opensTo = new Set(props.opensTo);
    const grows = (x: number, y: number) => {
      const top = ctx.stackAt(x, y).at(-1);
      return !!top && onlyOn.has(top.tileId) && ctx.covered(x, y);
    };
    const ours = new Set<number>();
    for (const i of path) if (grows(gridX(grid, i), gridY(grid, i))) ours.add(i);
    const wood = growWoodland(ctx.bounds, grows, ours, {
      seed: ctx.seed,
      density: mix.trees + mix.bushes,
      edge: props.edge,
      outliers: mix.trees > 0 ? props.outliers / 100 : 0,
      opensTo:
        opensTo.size > 0
          ? (x, y) => !ctx.covered(x, y) || opensTo.has(ctx.stackAt(x, y).at(-1)?.tileId ?? "")
          : undefined,
    });
    const cellAt = (x: number, y: number) =>
      inGrid(grid, x, y) ? wood.cells[gridIndex(grid, x, y)]! : OUTSIDE;
    const singleOf = (entries: Weighted) =>
      [...entries]
        .filter((t) => !coversCells(footprintOf(ctx.tilesById[t.tile])) && !TALL_TREES[t.tile])
        .sort((a, b) => b.weight - a.weight)[0]?.tile;
    const placing = placer(ctx);
    /** What blocks a way grows only on the wood's tree cells, which `growWoodland` has kept from shutting anywhere in. */
    const on = (kind: number) => (stack: readonly PlacedTile[], x: number, y: number) =>
      onlyOn.has(stack.at(-1)!.tileId) &&
      cellAt(x, y) === kind &&
      !ours.has(gridIndex(grid, x, y)) &&
      !atCliffFoot(ctx, x, y);
    const onTree = on(TREE);
    const onOpen = on(OPEN);
    const stand = (x: number, y: number) => (n: number) => {
      const swing = fbm(x, y, ctx.seed ^ (STAND_SALT + n * 0x9e37), STAND_SCALE, 2);
      return Math.exp(STAND_CONTRAST * (swing - 0.5));
    };
    const tall = new Set<string>();
    const crowded = (x: number, y: number) => {
      for (let dy = -TALL_SPACING; dy <= TALL_SPACING; dy++) {
        for (let dx = -TALL_SPACING; dx <= TALL_SPACING; dx++) {
          if (tall.has(`${x + dx},${y + dy}`)) return true;
        }
      }
      return false;
    };
    /** Puts the pick, or the commonest one-cell kind of its list where the pick does not fit. */
    const grow = (tile: string | null, entries: Weighted, x: number, y: number) => {
      const where = cellAt(x, y) === TREE ? onTree : onOpen;
      const def = tile ? ctx.tilesById[tile] : undefined;
      const put = tile ? placing.put(tile, anchorFrom(def, { x, y }), { on: where }) : null;
      if (put?.ok) return tile;
      const fallback = singleOf(entries);
      if (!fallback || fallback === tile) return null;
      return placing.put(fallback, { x, y }, { on: where }).ok ? fallback : null;
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
          if (randomAt(x, y, ctx.seed ^ BUSH_SALT) * (mix.trees + mix.bushes) < mix.bushes) {
            grow(
              pickWeighted(props.bushes, hashCell(x, y, ctx.seed ^ PICK_SALT)),
              props.bushes,
              x,
              y,
            );
            continue;
          }
          if (randomAt(x, y, ctx.seed ^ DECAY_SALT) < props.decay / 100) {
            grow(pickWeighted(props.dead, hashCell(x, y, ctx.seed ^ PICK_SALT)), props.dead, x, y);
            continue;
          }
          const tallHere =
            props.tall.length > 0 &&
            randomAt(x, y, ctx.seed ^ TALL_SALT) < mix.tall &&
            !crowded(x, y);
          if (tallHere) {
            const pick = pickWeighted(props.tall, hashCell(x, y, ctx.seed ^ PICK_SALT));
            const grew = grow(pick, props.tall, x, y);
            if (grew && TALL_TREES[grew]) tall.add(`${x},${y}`);
            if (grew) continue;
          }
          const pick = pickWeighted(props.trees, hashCell(x, y, ctx.seed ^ PICK_SALT), stand(x, y));
          grow(pick, props.trees, x, y);
        } else {
          const c = wood.canopy[i]!;
          const fringe = 1 + FRINGE_BOOST * 4 * c * (1 - c);
          if (randomAt(x, y, ctx.seed ^ COVER_SALT) >= mix.foliage * fringe) continue;
          grow(
            pickWeighted(props.foliage, hashCell(x, y, ctx.seed ^ PICK_SALT)),
            props.foliage,
            x,
            y,
          );
        }
      }
    }
    return { ok: true, edits: placing.edits };
  },
};
