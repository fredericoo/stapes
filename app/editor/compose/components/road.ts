import * as v from "valibot";
import { stackHeight, type StackEdit } from "../../../lib/mapData";
import type { PlacedTile } from "../../../lib/types";
import { placed } from "../../generator";
import type { Component } from "../build";
import { PointSchema, TileIdSchema } from "../doc";
import { across, bandOffsets, isWet, lineCells } from "./line";

const RoadSchema = v.object({
  from: PointSchema,
  to: PointSchema,
  tile: v.optional(TileIdSchema, "dirt"),
  width: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3)), 1),
  deck: v.optional(TileIdSchema, "wooden-floor"),
  rail: v.optional(v.nullable(TileIdSchema), "fence"),
  clears: v.optional(v.array(TileIdSchema), [
    "tree",
    "apple-tree",
    "old-tree",
    "dead-tree",
    "small-bush",
  ]),
});

export type RoadProps = v.InferOutput<typeof RoadSchema>;

/**
 * Lays its tile along the line on the ground the nodes before it left: over
 * water it lays a deck with a rail on each side, through the plants it
 * `clears` it cuts them down, and it goes round nothing, so a cell where
 * anything else stands is left as it is.
 */
export const road: Component<RoadProps> = {
  type: "road",
  label: "Road",
  starter: { props: { from: { x: 2, y: 2 }, to: { x: 14, y: 2 } } },
  schema: RoadSchema,
  build(ctx, props) {
    for (const id of [props.tile, props.deck, props.rail, ...props.clears]) {
      if (id && !ctx.tilesById[id]) return { ok: false, reason: `There is no tile called ${id}` };
    }
    const a = ctx.point(props.from);
    const b = ctx.point(props.to);
    if (!a || !b) {
      const missing = (a ? props.to.in : props.from.in) ?? "";
      return { ok: false, reason: `There is no node called ${missing} to measure from` };
    }
    const side = across(a, b);
    const band = bandOffsets(props.width);
    const edges = [band[0]! - 1, band.at(-1)! + 1];
    const tile = (id: string) => placed(id, ctx.tilesById);
    const clears = new Set(props.clears);
    const written = new Map<string, PlacedTile[]>();
    const rails = new Map<string, { x: number; y: number }>();
    const at = (x: number, y: number) => `${x},${y}`;

    for (const c of lineCells(a, b)) {
      let bridge = false;
      for (const o of band) {
        const x = c.x + side.x * o;
        const y = c.y + side.y * o;
        if (written.has(at(x, y))) continue;
        const stack = ctx.stackAt(x, y);
        if (stack.length === 0) continue;
        if (isWet(stack)) {
          bridge = true;
          if (stack.at(-1)?.tileId !== props.deck)
            written.set(at(x, y), [...stack, tile(props.deck)]);
          continue;
        }
        const cleared = stack.filter((p) => !clears.has(p.tileId));
        if (stackHeight(cleared, ctx.tilesById) > 0) continue;
        if (cleared.at(-1)?.tileId === props.tile && cleared.length === stack.length) continue;
        written.set(
          at(x, y),
          cleared.at(-1)?.tileId === props.tile ? cleared : [...cleared, tile(props.tile)],
        );
      }
      if (!bridge || !props.rail) continue;
      for (const o of edges) {
        const x = c.x + side.x * o;
        const y = c.y + side.y * o;
        rails.set(at(x, y), { x, y });
      }
    }

    for (const [key, { x, y }] of rails) {
      if (written.has(key)) continue;
      const stack = ctx.stackAt(x, y);
      if (!isWet(stack) || stack.at(-1)?.tileId === props.rail) continue;
      written.set(key, [...stack, tile(props.deck), tile(props.rail!)]);
    }

    const edits: StackEdit[] = [];
    for (const [key, stack] of written) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      edits.push({ x, y, z: ctx.z, stack });
    }
    return { ok: true, edits };
  },
};
