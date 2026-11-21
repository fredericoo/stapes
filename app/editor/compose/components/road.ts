import * as v from "valibot";
import { stackHeight, type StackEdit } from "../../../lib/mapData";
import type { PlacedTile } from "../../../lib/types";
import { placed } from "../../generator";
import type { Component } from "../build";
import { TILES, field } from "../field";
import {
  ROUTE_PROPS,
  across,
  bandOffsets,
  isWet,
  lineCells,
  routeOf,
  type RouteCell,
} from "./line";

const RoadSchema = v.object({
  ...ROUTE_PROPS,
  tile: v.optional(field.tile(TILES.ground), "dirt"),
  width: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3)), 1),
  deck: v.optional(field.tile(TILES.ground), "wooden-floor"),
  rail: v.optional(v.nullable(field.tile(TILES.wall)), "fence"),
  clears: v.optional(field.tiles(TILES.standing), [
    "tree",
    "apple-tree",
    "old-tree",
    "dead-tree",
    "small-bush",
  ]),
});

export type RoadProps = v.InferOutput<typeof RoadSchema>;

type Laid = RouteCell & { bridge: boolean };

/** Longest bridge a road will build; past it the far bank is taken to be open sea, and the road stops. */
const MAX_SPAN = 48;

/** How far from a bridge's end the route is relaid to meet it squarely. */
const SQUARE_UP_CELLS = 3;

/**
 * Whether a route cell is near the end of a bridge without being past it in
 * the direction `onward`. A line from past the end to such a cell would
 * double back through the cells beside the end, where the rails go.
 */
function beside(cell: RouteCell, end: { x: number; y: number }, onward: { x: number; y: number }) {
  const dx = cell.x - end.x;
  const dy = cell.y - end.y;
  return (
    dx * onward.x + dy * onward.y < 1 && Math.max(Math.abs(dx), Math.abs(dy)) <= SQUARE_UP_CELLS
  );
}

/**
 * Replaces every stretch of the route that runs over water with one straight
 * bridge. It runs along the crossing's longer axis, or along the step the
 * route entered the water by when the longer axis starts on land, from the
 * last land cell before the water to the first one after it on that line, so
 * a bridge always spans the whole crossing and rests one cell on each bank,
 * rails included, so its outline is a rectangle.
 * The road then rejoins its route across land. A route that ends in water,
 * or whose crossing never reaches land within `MAX_SPAN`, stops at the bank.
 */
function withBridges(cells: readonly RouteCell[], wet: (x: number, y: number) => boolean): Laid[] {
  const out: Laid[] = [];
  let i = 0;
  while (i < cells.length && wet(cells[i]!.x, cells[i]!.y)) i++;
  while (i < cells.length) {
    const c = cells[i]!;
    if (!wet(c.x, c.y)) {
      out.push({ ...c, bridge: false });
      i++;
      continue;
    }
    const bank = out.at(-1)!;
    let j = i;
    while (j < cells.length && wet(cells[j]!.x, cells[j]!.y)) j++;
    if (j >= cells.length) break;
    const exit = cells[j]!;
    const entered = { x: c.x - bank.x, y: c.y - bank.y };
    const longer =
      Math.abs(exit.x - bank.x) >= Math.abs(exit.y - bank.y)
        ? { x: Math.sign(exit.x - bank.x), y: 0 }
        : { x: 0, y: Math.sign(exit.y - bank.y) };
    const step = wet(bank.x + longer.x, bank.y + longer.y) ? longer : entered;
    const side = step.x !== 0 ? { x: 0, y: 1 } : { x: 1, y: 0 };
    /**
     * The road comes onto the bridge from straight behind it. A route that
     * steps sideways onto the bank cell would run through where a rail goes,
     * so its last cells round the bank are relaid as a line to the cell
     * behind the bridge, unless that line would itself touch water.
     */
    const behind = { x: bank.x - step.x, y: bank.y - step.y };
    let kept = out.length - 1;
    while (
      kept > 0 &&
      !out[kept - 1]!.bridge &&
      beside(out[kept - 1]!, bank, { x: -step.x, y: -step.y })
    ) {
      kept--;
    }
    const joined = kept > 0 && !out[kept - 1]!.bridge ? out[kept - 1]! : null;
    const approach = joined ? lineCells(joined, behind).slice(1) : [];
    if (joined && !wet(behind.x, behind.y) && !approach.some((k) => wet(k.x, k.y))) {
      const approachSide = across(joined, behind);
      out.length = kept;
      for (const k of approach) out.push({ ...k, side: approachSide, bridge: false });
      out.push({ ...bank, bridge: false });
    }
    const span: Laid[] = [{ x: bank.x, y: bank.y, side, bridge: true }];
    let x = bank.x + step.x;
    let y = bank.y + step.y;
    while (wet(x, y) && span.length <= MAX_SPAN) {
      span.push({ x, y, side, bridge: true });
      x += step.x;
      y += step.y;
    }
    if (span.length > MAX_SPAN) break;
    span.push({ x, y, side, bridge: true });
    out[out.length - 1] = span[0]!;
    out.push(...span.slice(1));
    /**
     * It leaves the same way: one more cell straight on where there is ground
     * for it, and from there to the first cell of the route that is past the
     * end, so the road turns beyond the rails' ends rather than through one.
     */
    let rejoin = j;
    while (
      rejoin < cells.length - 1 &&
      !wet(cells[rejoin + 1]!.x, cells[rejoin + 1]!.y) &&
      beside(cells[rejoin]!, { x, y }, step)
    ) {
      rejoin++;
    }
    const target = cells[rejoin]!;
    const ahead = { x: x + step.x, y: y + step.y };
    const clear = !wet(ahead.x, ahead.y) && (x !== target.x || y !== target.y);
    const from = clear ? ahead : { x, y };
    if (clear) out.push({ ...ahead, side, bridge: false });
    const joinSide = across(from, target);
    for (const k of lineCells(from, target).slice(1))
      out.push({ ...k, side: joinSide, bridge: false });
    i = rejoin + 1;
  }
  return out;
}

/**
 * Lays its tile along the route on the ground the nodes before it left. A
 * crossing of water is one straight bridge of `deck` with a `rail` on each
 * side (see `withBridges`); through the plants it `clears` it cuts them down;
 * and it goes round nothing, so a cell where anything else stands is left
 * as it is.
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
    const cells = routeOf(ctx, props);
    if ("reason" in cells) return { ok: false, reason: cells.reason };
    const band = bandOffsets(props.width);
    const edges = [band[0]! - 1, band.at(-1)! + 1];
    const tile = (id: string) => placed(id, ctx.tilesById);
    const clears = new Set(props.clears);
    const written = new Map<string, PlacedTile[]>();
    const at = (x: number, y: number) => `${x},${y}`;
    const wet = (x: number, y: number) => isWet(ctx.stackAt(x, y));

    const laid = withBridges(cells, wet);
    /** Where the road itself runs beside its bridge, which only happens when it turns on the bank: a rail there would fence the road off from its own deck. */
    const roadway = new Set(
      laid
        .filter((c) => !c.bridge)
        .flatMap((c) => band.map((o) => at(c.x + c.side.x * o, c.y + c.side.y * o))),
    );
    for (const c of laid) {
      for (const o of band) {
        const x = c.x + c.side.x * o;
        const y = c.y + c.side.y * o;
        const stack = ctx.stackAt(x, y);
        if (stack.length === 0) continue;
        if (!c.bridge && (written.has(at(x, y)) || isWet(stack))) continue;
        const cleared = isWet(stack) ? stack : stack.filter((p) => !clears.has(p.tileId));
        if (stackHeight(cleared, ctx.tilesById) > 0) continue;
        const surface = c.bridge ? props.deck : props.tile;
        if (cleared.at(-1)?.tileId === surface && cleared.length === stack.length) continue;
        written.set(
          at(x, y),
          cleared.at(-1)?.tileId === surface ? cleared : [...cleared, tile(surface)],
        );
      }
      if (!c.bridge || !props.rail) continue;
      for (const o of edges) {
        const x = c.x + c.side.x * o;
        const y = c.y + c.side.y * o;
        const stack = ctx.stackAt(x, y);
        if (stack.length === 0 || roadway.has(at(x, y))) continue;
        const cleared = isWet(stack) ? stack : stack.filter((p) => !clears.has(p.tileId));
        if (stackHeight(cleared, ctx.tilesById) > 0) continue;
        const under = cleared.filter((p) => p.tileId !== props.tile && p.tileId !== props.deck);
        written.set(at(x, y), [...under, tile(props.deck), tile(props.rail)]);
      }
    }

    const edits: StackEdit[] = [];
    for (const [key, stack] of written) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      edits.push({ x, y, z: ctx.z, stack });
    }
    return { ok: true, edits };
  },
};
