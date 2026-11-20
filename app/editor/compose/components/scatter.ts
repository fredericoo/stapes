import * as v from "valibot";
import { stackHeight, type StackEdit } from "../../../lib/mapData";
import { HEIGHT_PER_LEVEL, physicalHeight } from "../../../lib/types";
import { fbm, hashCell, placed, randomAt } from "../../generator";
import type { Component } from "../build";
import { TILES, field } from "../field";

const ScatterSchema = v.object({
  tiles: v.optional(field.weighted(TILES.any), [
    { tile: "red-flowers", weight: 2 },
    { tile: "yellow-flowers", weight: 2 },
    { tile: "tuft", weight: 3 },
    { tile: "mushroom", weight: 1 },
  ]),
  density: v.optional(field.percent(), 12),
  clumping: v.optional(field.percent(), 50),
  clumpSize: v.optional(v.pipe(v.number(), v.integer(), v.minValue(2), v.maxValue(32)), 6),
  spacing: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(6)), 0),
  onlyOn: v.optional(field.tiles(TILES.ground), ["sand", "grass", "grass-2"]),
});

export type ScatterProps = v.InferOutput<typeof ScatterSchema>;

const CLUMP_OCTAVES = 2;
const PICK_SALT = 0x5ca7;
const UINT32 = 4294967296;

function pick(entries: ReadonlyArray<{ tile: string; weight: number }>, hash: number) {
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
 * Places a weighted mix of tiles over its frame. Each cell is taken with a
 * chance of `density`, raised and lowered by noise `clumpSize` cells across
 * as far as `clumping` says, so plants gather in patches rather than salting
 * the ground evenly. Cells are visited in rows and a cell is skipped when an
 * earlier one within `spacing` steps was taken, which keeps the result the
 * same however it is masked.
 */
export const scatter: Component<ScatterProps> = {
  type: "scatter",
  label: "Scatter",
  starter: { frame: { x: 2, y: 2, w: 16, h: 12 } },
  schema: ScatterSchema,
  build(ctx, props) {
    const onlyOn = new Set(props.onlyOn);
    const { minX, minY, maxX, maxY } = ctx.bounds;
    const width = maxX - minX + 1;
    const taken = new Uint8Array(width * (maxY - minY + 1));
    const near = (x: number, y: number) => {
      for (let dy = -props.spacing; dy <= 0; dy++) {
        for (let dx = -props.spacing; dx <= props.spacing; dx++) {
          const tx = x + dx;
          const ty = y + dy;
          if (tx < minX || tx > maxX || ty < minY) continue;
          if (taken[(ty - minY) * width + (tx - minX)]) return true;
        }
      }
      return false;
    };
    const edits: StackEdit[] = [];
    for (let y = ctx.bounds.minY; y <= ctx.bounds.maxY; y++) {
      for (let x = ctx.bounds.minX; x <= ctx.bounds.maxX; x++) {
        const swing = (fbm(x, y, ctx.seed, props.clumpSize, CLUMP_OCTAVES) - 0.5) * 2;
        const chance = (props.density / 100) * (1 + swing * (props.clumping / 100));
        if (randomAt(x, y, ctx.seed) >= chance) continue;
        if (props.spacing > 0 && near(x, y)) continue;
        const stack = ctx.stackAt(x, y);
        const top = stack.at(-1);
        if (!top || (onlyOn.size && !onlyOn.has(top.tileId))) continue;
        const tile = pick(props.tiles, hashCell(x, y, ctx.seed ^ PICK_SALT));
        const def = tile ? ctx.tilesById[tile] : undefined;
        if (!tile || !def) continue;
        if (stackHeight(stack, ctx.tilesById) + physicalHeight(def) > HEIGHT_PER_LEVEL) continue;
        taken[(y - minY) * width + (x - minX)] = 1;
        edits.push({ x, y, z: ctx.z, stack: [...stack, placed(tile, ctx.tilesById)] });
      }
    }
    return { ok: true, edits };
  },
};
