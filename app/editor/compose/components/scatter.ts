import * as v from "valibot";
import { footprintOf } from "../../../lib/types";
import { fbm, hashCell, randomAt } from "../../generator";
import type { Component } from "../build";
import { TILES, field } from "../field";
import { anchorFrom, atCliffFoot, placer } from "../placing";

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
 * same however it is masked. A tile wider than a cell grows south and east
 * of the cell that was taken, and only where every cell it covers is free.
 * A tile that stands in the way is never put at the foot of a cliff
 * (`atCliffFoot`).
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
    const placing = placer(ctx);
    const grows = (stack: readonly { tileId: string }[]) =>
      onlyOn.size === 0 || onlyOn.has(stack.at(-1)!.tileId);
    const growsClear = (stack: readonly { tileId: string }[], x: number, y: number) =>
      grows(stack) && !atCliffFoot(ctx, x, y);
    for (let y = ctx.bounds.minY; y <= ctx.bounds.maxY; y++) {
      for (let x = ctx.bounds.minX; x <= ctx.bounds.maxX; x++) {
        const swing = (fbm(x, y, ctx.seed, props.clumpSize, CLUMP_OCTAVES) - 0.5) * 2;
        const chance = (props.density / 100) * (1 + swing * (props.clumping / 100));
        if (randomAt(x, y, ctx.seed) >= chance) continue;
        if (props.spacing > 0 && near(x, y)) continue;
        const tile = pick(props.tiles, hashCell(x, y, ctx.seed ^ PICK_SALT));
        const def = tile ? ctx.tilesById[tile] : undefined;
        if (!tile || !def) continue;
        const { w, d } = footprintOf(def);
        if (x + w - 1 > maxX || y + d - 1 > maxY) continue;
        const on = def.walkable === false ? growsClear : grows;
        if (!placing.put(tile, anchorFrom(def, { x, y }), { on }).ok) continue;
        for (let dy = 0; dy < d; dy++) {
          for (let dx = 0; dx < w; dx++) taken[(y + dy - minY) * width + (x + dx - minX)] = 1;
        }
      }
    }
    return { ok: true, edits: placing.edits };
  },
};
