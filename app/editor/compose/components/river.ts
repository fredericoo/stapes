import * as v from "valibot";
import type { StackEdit } from "../../../lib/mapData";
import { placed } from "../../generator";
import type { Component } from "../build";
import { TILES, field } from "../field";
import { ROUTE_PROPS, bandOffsets, isWet, routeOf } from "./line";

const RiverSchema = v.object({
  ...ROUTE_PROPS,
  width: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(6)), 2),
  bed: v.optional(field.tile(TILES.ground), "dirt"),
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
  starter: { props: { from: { x: 2, y: 0 }, to: { x: 6, y: 0, pinY: "bottom" } } },
  schema: RiverSchema,
  build(ctx, props) {
    if (!ctx.tilesById[props.bed])
      return { ok: false, reason: `There is no tile called ${props.bed}` };
    const cells = routeOf(ctx, props);
    if ("reason" in cells) return { ok: false, reason: cells.reason };
    const seen = new Set<string>();
    const edits: StackEdit[] = [];
    for (const c of cells) {
      for (const o of bandOffsets(props.width)) {
        const x = c.x + c.side.x * o;
        const y = c.y + c.side.y * o;
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
