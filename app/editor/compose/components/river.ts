import * as v from "valibot";
import type { StackEdit } from "../../../lib/mapData";
import type { PlacedTile } from "../../../lib/types";
import { placed } from "../../generator";
import type { Component } from "../build";
import { TILES, field } from "../field";
import { DEFAULT_BRIDGE, MAX_ARC, ROUTE_PROPS, bandOffsets, isWet, routeOf } from "./line";

const RiverSchema = v.object({
  ...ROUTE_PROPS,
  width: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(6)), 2),
  bed: v.optional(field.tile(TILES.ground), "dirt"),
  bridged: v.optional(v.boolean(), true),
  deck: v.optional(field.tile(TILES.ground), DEFAULT_BRIDGE.deck),
  rail: v.optional(v.nullable(field.tile(TILES.wall)), DEFAULT_BRIDGE.rail),
  arc: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_ARC)), 1),
});

export type RiverProps = v.InferOutput<typeof RiverSchema>;

/**
 * A fall stands in the lower cell, against the face of the cliff the water
 * comes down. Only water leaving a cliff south or east gets one, because the
 * north and west faces of a cliff are never drawn. South comes first, so a
 * cell under a corner of the cliff takes the south-facing fall. The lower
 * cell has to be open water, which a bridge's deck is not and shore foam is.
 */
const FALLS = [
  { dx: 0, dy: 1, segments: ["waterfall-base", "waterfall-middle", "waterfall-top"] },
  {
    dx: 1,
    dy: 0,
    segments: ["waterfall-east-base", "waterfall-east-middle", "waterfall-east-top"],
  },
] as const;

/** A fall segment is half a level tall, and a stack may not reach past its own level. */
const SEGMENTS_PER_LEVEL = 2;

const isFall = (p: PlacedTile) => p.tileId.startsWith("waterfall");

/**
 * Keeps the bottom tile of every dry cell it crosses and replaces the rest
 * with a bed and `water`, so a road or a tree in its way is washed out. Cells
 * that are already water, a bridge's among them, are left alone.
 *
 * Laid after a hill it runs over the hill's top, and wherever its water
 * stands above open water to the south or east it draws a waterfall down the
 * cliff between them, as many levels tall as the drop.
 *
 * It builds no bridge. It declares how its water is crossed, and a road that
 * crosses it later builds the bridge in that deck and rail, or stops at the
 * bank when the river is not `bridged`.
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
    for (const id of props.bridged ? [props.deck, props.rail] : []) {
      if (id && !ctx.tilesById[id]) return { ok: false, reason: `There is no tile called ${id}` };
    }
    const seen = new Set<string>();
    const pools = new Map<string, StackEdit>();
    const wet: Array<{ x: number; y: number }> = [];
    const cellsCovered: Array<{ x: number; y: number }> = [];
    for (const c of cells) {
      for (const o of bandOffsets(props.width)) {
        const x = c.x + c.side.x * o;
        const y = c.y + c.side.y * o;
        if (seen.has(`${x},${y}`)) continue;
        seen.add(`${x},${y}`);
        cellsCovered.push({ x, y });
        const stack = ctx.stackAt(x, y);
        const ground = stack[0];
        if (!ground) continue;
        wet.push({ x, y });
        if (isWet(stack)) continue;
        const bed =
          ground.tileId === props.bed ? [ground] : [ground, placed(props.bed, ctx.tilesById)];
        pools.set(`${x},${y}`, {
          x,
          y,
          z: ctx.z,
          stack: [...bed, placed("water", ctx.tilesById)],
        });
      }
    }
    const edits = [...pools.values()];
    for (const fall of FALLS) {
      for (const top of wet) {
        const x = top.x + fall.dx;
        const y = top.y + fall.dy;
        const levels = ctx.raisedAt(top.x, top.y) - ctx.raisedAt(x, y);
        const pool = pools.get(`${x},${y}`);
        const stack = pool?.stack ?? ctx.stackAt(x, y);
        const surface = stack.findLast((p) => !ctx.tilesById[p.tileId]?.intangible);
        if (levels <= 0 || !surface || !isWet([surface]) || stack.some(isFall)) continue;
        const [base, middle, crest] = fall.segments;
        const segments = [
          base,
          ...Array.from({ length: levels * SEGMENTS_PER_LEVEL - 2 }, () => middle),
          crest,
        ].map((id) => placed(id, ctx.tilesById));
        const filled = {
          x,
          y,
          z: ctx.z,
          stack: [...stack, ...segments.slice(0, SEGMENTS_PER_LEVEL)],
        };
        if (pool) pool.stack = filled.stack;
        else {
          pools.set(`${x},${y}`, filled);
          edits.push(filled);
        }
        for (let k = SEGMENTS_PER_LEVEL; k < segments.length; k += SEGMENTS_PER_LEVEL) {
          edits.push({
            x,
            y,
            z: ctx.z + k / SEGMENTS_PER_LEVEL,
            stack: segments.slice(k, k + SEGMENTS_PER_LEVEL),
          });
        }
      }
    }
    const bridge = props.bridged ? { deck: props.deck, rail: props.rail, arc: props.arc } : null;
    return { ok: true, edits, crossing: { cells: cellsCovered, bridge } };
  },
};
