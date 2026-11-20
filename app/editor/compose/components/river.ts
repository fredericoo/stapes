import * as v from "valibot";
import type { StackEdit } from "../../../lib/mapData";
import { placed } from "../../generator";
import type { Component } from "../build";
import { PointSchema, TileIdSchema } from "../doc";
import { across, bandOffsets, isWet, lineCells } from "./line";

const RiverSchema = v.object({
  from: PointSchema,
  to: PointSchema,
  width: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(6)), 2),
  bed: v.optional(TileIdSchema, "dirt"),
});

export type RiverProps = v.InferOutput<typeof RiverSchema>;

/**
 * Keeps the bottom tile of every dry cell it crosses and replaces the rest
 * with a bed and `water`, so a road or a tree in its way is washed out. Cells
 * that are already water, a bridge's among them, are left alone.
 */
export const river: Component<RiverProps> = {
  type: "river",
  label: "River",
  schema: RiverSchema,
  build(ctx, props) {
    if (!ctx.tilesById[props.bed])
      return { ok: false, reason: `There is no tile called ${props.bed}` };
    const a = ctx.point(props.from);
    const b = ctx.point(props.to);
    if (!a || !b) {
      const missing = (a ? props.to.in : props.from.in) ?? "";
      return { ok: false, reason: `There is no node called ${missing} to measure from` };
    }
    const side = across(a, b);
    const seen = new Set<string>();
    const edits: StackEdit[] = [];
    for (const c of lineCells(a, b)) {
      for (const o of bandOffsets(props.width)) {
        const x = c.x + side.x * o;
        const y = c.y + side.y * o;
        if (seen.has(`${x},${y}`)) continue;
        seen.add(`${x},${y}`);
        const stack = ctx.stackAt(x, y);
        const ground = stack[0];
        if (!ground || isWet(stack)) continue;
        const bed =
          ground.tileId === props.bed ? [ground] : [ground, placed(props.bed, ctx.tilesById)];
        edits.push({ x, y, z: ctx.z, stack: [...bed, placed("water", ctx.tilesById)] });
      }
    }
    return { ok: true, edits };
  },
};
