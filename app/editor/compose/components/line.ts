import type { PlacedTile } from "../../../lib/types";
import * as v from "valibot";
import { fbm, randomAt } from "../../generator";
import type { BridgeStyle, BuildContext } from "../build";
import type { Point } from "../doc";
import { field } from "../field";

export type Cell = { x: number; y: number };

/** The bridge a road builds over water no layer declared a crossing for, such as the sea's shallows or a lake laid with a fill. */
export const DEFAULT_BRIDGE: BridgeStyle = { deck: "wooden-floor", rail: "fence", arc: 0 };

/** The highest a deck is lifted in the middle, in height units: a body steps up one unit a cell without a ramp. */
export const MAX_ARC = 2;

const WATER_TILE_IDS = new Set(["water", "deep-water"]);

export function isWet(stack: readonly PlacedTile[]): boolean {
  return stack.some((p) => WATER_TILE_IDS.has(p.tileId));
}

/**
 * Steps one axis at a time, each time onto whichever of the two next cells
 * lies nearer the straight line from `a` to `b` (the smaller cross product), so
 * the result is four-connected and walkable without cutting a corner.
 */
export function lineCells(a: Cell, b: Cell): Cell[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  let { x, y } = a;
  const cells: Cell[] = [{ x, y }];
  while (x !== b.x || y !== b.y) {
    const offX = Math.abs((x + sx - a.x) * dy - (y - a.y) * dx);
    const offY = Math.abs((x - a.x) * dy - (y + sy - a.y) * dx);
    if (x !== b.x && (y === b.y || offX <= offY)) x += sx;
    else y += sy;
    cells.push({ x, y });
  }
  return cells;
}

/** The offsets across a band `width` cells wide, centred on the line, with the odd cell on the positive side. */
export function bandOffsets(width: number): number[] {
  const from = -Math.floor((width - 1) / 2);
  return Array.from({ length: width }, (_, i) => from + i);
}

/** A band is widened across the line's longer axis, so a mostly east-west line widens north-south. */
export function across(a: Cell, b: Cell): Cell {
  return Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? { x: 0, y: 1 } : { x: 1, y: 0 };
}

export type RouteCell = Cell & { side: Cell };

/** Cells between the samples a wandering route is pushed sideways at; finer reads as jitter, coarser as straight runs. */
const WANDER_STEP = 3;
const WANDER_OCTAVES = 2;

/**
 * A stretch also sweeps from side to side in bends a third of its length
 * long, at most `wander × SWEEP_REACH` of its length out, on top of the
 * `scale`-cell ones: bends of a fixed size are lost on a long stretch, which
 * then reads as a straight line from any distance. The sweep is a sine with a
 * phase and a strength taken from noise rather than noise alone, which can lie
 * flat for a whole stretch. Its envelope is squared so a route still leaves
 * each anchor almost head on.
 */
const SWEEPS_PER_STRETCH = 3;
const SWEEP_REACH = 0.3;
const SWEEP_FLOOR = 0.5;
const SWEEP_SALT = 0x5ee9;

/**
 * The cells of a route through `anchors` in order, each with the direction its
 * band widens in. With `wander` above zero each stretch is pushed sideways by
 * noise along the distance travelled: bends `scale` cells long and at most
 * `wander × scale` cells out, and the sweeps above on top of them. The push is multiplied by a sine that is zero
 * at both ends of the stretch, so the route still passes through every
 * anchor exactly.
 */
export function route(
  anchors: readonly Cell[],
  wander: number,
  scale: number,
  seed: number,
): RouteCell[] {
  const out: RouteCell[] = [];
  const seen = new Set<string>();
  const add = (cells: Cell[], side: Cell) => {
    for (const c of cells) {
      const key = `${c.x},${c.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ x: c.x, y: c.y, side });
    }
  };
  if (anchors.length === 1) add([anchors[0]!], { x: 0, y: 1 });
  let travelled = 0;
  for (let i = 0; i + 1 < anchors.length; i++) {
    const a = anchors[i]!;
    const b = anchors[i + 1]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length === 0) {
      add([a], { x: 0, y: 1 });
      continue;
    }
    const nx = -(b.y - a.y) / length;
    const ny = (b.x - a.x) / length;
    const sweepScale = Math.max(scale, length / SWEEPS_PER_STRETCH);
    const phase = randomAt(i, 0, seed ^ SWEEP_SALT) * 2 * Math.PI;
    const samples = wander > 0 ? Math.max(1, Math.ceil(length / WANDER_STEP)) : 1;
    let previous = a;
    for (let k = 1; k <= samples; k++) {
      const t = k / samples;
      const along = travelled + t * length;
      const swing = (fbm(along, 0, seed, scale, WANDER_OCTAVES) - 0.5) * 2;
      const strength =
        SWEEP_FLOOR + (1 - SWEEP_FLOOR) * fbm(along, 0, seed ^ SWEEP_SALT, sweepScale, 1);
      const sweep = strength * Math.sin((Math.PI * along) / sweepScale + phase);
      const envelope = Math.sin(Math.PI * t);
      const push =
        wander * (swing * scale * envelope + sweep * length * SWEEP_REACH * envelope ** 2);
      const next =
        k === samples
          ? b
          : {
              x: Math.round(a.x + (b.x - a.x) * t + nx * push),
              y: Math.round(a.y + (b.y - a.y) * t + ny * push),
            };
      add(lineCells(previous, next), across(previous, next));
      previous = next;
    }
    travelled += length;
  }
  return out;
}

/** The props every route shares: where it starts and ends, where it passes on the way, and how far it bends between them. */
export const ROUTE_PROPS = {
  from: field.point(),
  via: v.optional(field.points(), []),
  to: field.point(),
  wander: v.optional(field.percent(), 0),
  bendLength: v.optional(v.pipe(v.number(), v.integer(), v.minValue(4), v.maxValue(64)), 12),
};

type RouteProps = {
  from: Point;
  via: Point[];
  to: Point;
  wander: number;
  bendLength: number;
};

export function routeOf(ctx: BuildContext, props: RouteProps): RouteCell[] | { reason: string } {
  const anchors: Cell[] = [];
  for (const point of [props.from, ...props.via, props.to]) {
    const cell = ctx.point(point);
    if (!cell) return { reason: `There is no node called ${point.in ?? ""} to measure from` };
    anchors.push(cell);
  }
  return route(anchors, props.wander / 100, props.bendLength, ctx.seed);
}
