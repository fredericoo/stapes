import * as v from "valibot";
import type { StackEdit } from "../../../lib/mapData";
import type { Direction, PlacedTile } from "../../../lib/types";
import {
  fbm,
  gridIndex,
  gridX,
  gridY,
  inGrid,
  newGrid,
  placed,
  type CellGrid,
} from "../../generator";
import type { Component } from "../build";
import { TILES, field } from "../field";
import { isWet } from "./line";

const HillSchema = v.object({
  levels: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(6)), 2),
  terrace: v.optional(v.pipe(v.number(), v.integer(), v.minValue(2), v.maxValue(12)), 4),
  roughness: v.optional(field.percent(), 40),
  ground: v.optional(field.tile(TILES.ground), "grass-2"),
  brink: v.optional(field.tile(TILES.ground), "grass-brink"),
  wall: v.optional(field.tile(TILES.any), "hill-wall"),
  ramps: v.optional(v.boolean(), true),
  rampSide: v.optional(field.direction(), "s"),
});

export type HillProps = v.InferOutput<typeof HillSchema>;

const RAMP = "ramp";
const BLOCK = "half-stone";

/** Cells kept clear inside the frame, so the two cells of a ramp down to the ground and the cell at its foot fit. */
const MARGIN = 3;
const EDGE_OCTAVES = 3;
const MIN_EDGE_SCALE = 5;
const EDGE_SCALE_SHARE = 0.25;
const MAX_WOBBLE = 0.6;

const N8 = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
] as const;

const STEP: Record<Direction, readonly [number, number]> = {
  n: [0, -1],
  e: [1, 0],
  s: [0, 1],
  w: [-1, 0],
};
const SIDES: readonly Direction[] = ["s", "e", "w", "n"];

/**
 * How many levels each cell is raised. The foot of the hill is a noisy
 * ellipse cut down to dry ground its masks leave in, and a cell's level is how
 * many terraces it is from the nearest cell outside that, counted in
 * eight-neighbour steps: every level is then the one below it drawn in by a
 * whole terrace on every side, corners included, so ground never overhangs
 * and no cliff is more than one level high.
 */
function levelsOf(
  g: CellGrid,
  props: HillProps,
  seed: number,
  raisable: (x: number, y: number) => boolean,
): Uint8Array {
  const rx = g.width / 2 - MARGIN;
  const ry = g.height / 2 - MARGIN;
  const cx = g.minX + (g.width - 1) / 2;
  const cy = g.minY + (g.height - 1) / 2;
  const scale = Math.max(MIN_EDGE_SCALE, Math.min(g.width, g.height) * EDGE_SCALE_SHARE);
  const wobble = (props.roughness / 100) * MAX_WOBBLE;
  const n = g.width * g.height;
  const distance = new Int32Array(n).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = gridX(g, i);
    const y = gridY(g, i);
    const fromEdge = Math.min(
      x - g.minX,
      g.minX + g.width - 1 - x,
      y - g.minY,
      g.minY + g.height - 1 - y,
    );
    const d = rx < 1 || ry < 1 ? Infinity : Math.hypot((x - cx) / rx, (y - cy) / ry);
    const noise = (fbm(x, y, seed, scale, EDGE_OCTAVES) - 0.5) * 2 * wobble;
    if (fromEdge >= MARGIN && d - noise <= 1 && raisable(x, y)) continue;
    distance[i] = 0;
    queue.push(i);
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    for (const [dx, dy] of N8) {
      const x = gridX(g, i) + dx;
      const y = gridY(g, i) + dy;
      if (!inGrid(g, x, y)) continue;
      const j = gridIndex(g, x, y);
      if (distance[j] !== -1) continue;
      distance[j] = distance[i]! + 1;
      queue.push(j);
    }
  }
  return Uint8Array.from(distance, (d) => Math.min(props.levels, Math.ceil(d / props.terrace)));
}

type Ramp = { low: number; high: number; head: number; side: Direction };

/**
 * One ramp for each level, from the level below. A ramp is two cells in a
 * line on the lower level, running away from the cliff, and it needs a third
 * beyond them to step off onto. Each is the candidate nearest the head of the
 * ramp below it, so the way up is one path, and the first is the one nearest
 * the middle of the hill on the side asked for.
 */
function rampsOf(g: CellGrid, level: Uint8Array, props: HillProps, flat: (i: number) => boolean) {
  const ramps: Ramp[] = [];
  const used = new Set<number>();
  let near = {
    x: g.minX + (g.width - 1) / 2 + (STEP[props.rampSide][0] * g.width) / 2,
    y: g.minY + (g.height - 1) / 2 + (STEP[props.rampSide][1] * g.height) / 2,
  };
  const order = [props.rampSide, ...SIDES.filter((s) => s !== props.rampSide)];
  for (let k = 0; k < props.levels; k++) {
    let best: (Ramp & { cost: number }) | null = null;
    for (let i = 0; i < level.length; i++) {
      if (level[i] !== k + 1) continue;
      for (const side of order) {
        const [dx, dy] = STEP[side];
        const cells = [1, 2, 3].map((steps) => {
          const x = gridX(g, i) + dx * steps;
          const y = gridY(g, i) + dy * steps;
          return inGrid(g, x, y) ? gridIndex(g, x, y) : -1;
        });
        if (cells.some((j) => j < 0 || level[j] !== k || used.has(j) || !flat(j))) continue;
        const cost =
          Math.hypot(gridX(g, i) - near.x, gridY(g, i) - near.y) + order.indexOf(side) * g.width;
        if (!best || cost < best.cost)
          best = { high: cells[0]!, low: cells[1]!, head: i, side, cost };
      }
    }
    if (!best) break;
    ramps.push(best);
    for (const j of [best.low, best.high, best.head]) used.add(j);
    near = { x: gridX(g, best.head), y: gridY(g, best.head) };
  }
  return ramps;
}

/**
 * Raises the ground the nodes before it left, the way Rune Isle's hills are
 * built (`docs/terrain.md`): a raised cell is a column with one `wall` on
 * every level under its top, standing on ground wherever a neighbour's ground
 * lies on that level, and whatever stood on the cell moves to the top with
 * it, so a hill laid over a forest is a wooded hill. The top is `brink` on
 * every cell with a drop beside it and `ground` elsewhere. Water and empty
 * cells are not raised, and masks cut the foot of the hill, not the finished
 * one, so a hole a mask makes is ringed by its own cliffs.
 */
export const hill: Component<HillProps> = {
  type: "hill",
  label: "Hill",
  starter: { frame: { x: 2, y: 2, w: 22, h: 18 } },
  schema: HillSchema,
  shapesItself: true,
  build(ctx, props) {
    const g = newGrid(ctx.bounds);
    const before = (i: number) => ctx.stackAt(gridX(g, i), gridY(g, i));
    const level = levelsOf(g, props, ctx.seed, (x, y) => {
      const stack = ctx.stackAt(x, y);
      return stack.length > 0 && !isWet(stack) && ctx.covered(x, y);
    });
    if (!level.some((l) => l > 0)) {
      return { ok: false, reason: "There is no dry ground inside the frame to raise" };
    }
    const tile = (id: string, direction?: Direction) => placed(id, ctx.tilesById, direction);
    const levelAt = (x: number, y: number) => (inGrid(g, x, y) ? level[gridIndex(g, x, y)]! : 0);
    const around = (i: number, test: (l: number) => boolean) =>
      N8.some(([dx, dy]) => test(levelAt(gridX(g, i) + dx, gridY(g, i) + dy)));

    const canRamp = props.ramps && ctx.tilesById[RAMP] && ctx.tilesById[BLOCK];
    const ramps = canRamp
      ? rampsOf(g, level, props, (i) => {
          const stack = before(i);
          return stack.length > 0 && !isWet(stack);
        })
      : [];
    const heads = new Set(ramps.map((r) => r.head));

    const tops = new Map<number, PlacedTile[]>();
    const edits: StackEdit[] = [];
    for (let i = 0; i < level.length; i++) {
      const L = level[i]!;
      if (L === 0) continue;
      const x = gridX(g, i);
      const y = gridY(g, i);
      const stack = before(i);
      for (let z = 0; z < L; z++) {
        const under = z === 0 ? stack.slice(0, 1) : [tile(props.ground)];
        const column =
          heads.has(i) && z === L - 1
            ? [...under, tile(BLOCK), tile(BLOCK)]
            : around(i, (l) => l === z)
              ? [...under, tile(props.wall)]
              : [tile(props.wall)];
        edits.push({ x, y, z: ctx.z + z, stack: column });
      }
      const edge = !heads.has(i) && around(i, (l) => l < L);
      tops.set(i, [tile(edge ? props.brink : props.ground), ...stack.slice(1)]);
    }
    for (const r of ramps) {
      const base = (i: number) => (tops.get(i) ?? before(i)).slice(0, 1);
      tops.set(r.low, [...base(r.low), tile(RAMP, r.side)]);
      tops.set(r.high, [...base(r.high), tile(BLOCK), tile(RAMP, r.side)]);
    }
    for (const [i, stack] of tops) {
      edits.push({ x: gridX(g, i), y: gridY(g, i), z: ctx.z + level[i]!, stack });
    }
    return { ok: true, edits };
  },
};
