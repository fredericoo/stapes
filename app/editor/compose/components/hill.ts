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
import { brinkOf, isFlat } from "../brinks";
import { isWet } from "./line";
import { nearestRamp, rampCells, type Cell, type RampGround, type RampSite } from "./ramp";

const HillSchema = v.object({
  levels: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(6)), 2),
  terrace: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(12)), 4),
  roughness: v.optional(field.percent(), 40),
  ground: v.optional(field.tile(TILES.ground), "grass-2"),
  brink: v.optional(field.tile(TILES.ground), "grass-brink"),
  wall: v.optional(field.tile(TILES.any), "hill-wall"),
  ramp: v.optional(field.tile(TILES.any), "ramp"),
  rampBlock: v.optional(field.tile(TILES.any), "half-stone"),
  ramps: v.optional(field.points(), []),
});

export type HillProps = v.InferOutput<typeof HillSchema>;

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

/**
 * How many levels each cell is raised. The foot of the hill is a noisy
 * ellipse cut down to dry ground its masks leave in, and a cell's level is how
 * many terraces it is from the nearest cell outside that, counted in
 * eight-neighbour steps: every level is then the one below it drawn in by a
 * whole terrace on every side, corners included, so ground never overhangs
 * and no cliff is more than one level high. With no terrace every level ends
 * at the foot, in one cliff `levels` high.
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
  return Uint8Array.from(distance, (d) =>
    d === 0
      ? 0
      : props.terrace === 0
        ? props.levels
        : Math.min(props.levels, Math.ceil(d / props.terrace)),
  );
}

/**
 * Raises ground the way Rune Isle's hills are built (`docs/terrain.md`): a
 * raised cell is a column with one `wall` on every level under its top,
 * standing on ground wherever a neighbour's ground lies on that level, with
 * `ground` on top, cut to its brink on every cell beside a drop; `brink` is
 * for a ground with no brink of its own. Plants on a cell go to the top with
 * it, and a cover such as grass stays at the foot of the wall: the top is the
 * hill's own ground until a cover is laid on it.
 *
 * It builds on whatever level the ground under the middle of its frame is
 * on, so a hill laid on a hill's top is a second tier, in its own tiles. Only
 * ground on that level is raised, and never a cell beside higher ground. A
 * hill with a terrace leaves the tier below a ledge a cell wide all round; one
 * with none is raised to the tier's edge, and its wall there takes the place
 * of the brink it stands on. Water, empty cells and
 * anything built stay as they are, with the cells round a building, and masks
 * cut the foot of the hill, not the finished one.
 *
 * It lays no way up by itself. Each of `ramps` is a point, and the ramp goes
 * on the nearest stretch of straight cliff to it; a road that crosses the
 * cliff lays its own, in the tiles declared here.
 */
export const hill: Component<HillProps> = {
  type: "hill",
  label: "Hill",
  starter: { frame: { x: 2, y: 2, w: 22, h: 18 } },
  schema: HillSchema,
  shapesItself: true,
  ownLevels: true,
  build(ctx, props) {
    const g = newGrid(ctx.bounds);
    const base = ctx.raisedAt(
      Math.floor((ctx.bounds.minX + ctx.bounds.maxX) / 2),
      Math.floor((ctx.bounds.minY + ctx.bounds.maxY) / 2),
    );
    const z0 = ctx.z + base;
    const stackOn = (x: number, y: number) => ctx.stackAt(x, y, z0);
    const before = (i: number) => stackOn(gridX(g, i), gridY(g, i));
    const built = (x: number, y: number) =>
      ctx.stackAt(x, y, z0 + 1).length > 0 ||
      stackOn(x, y)
        .slice(1)
        .some((p) => {
          const def = ctx.tilesById[p.tileId];
          return !def || (def.height > 0 && !TILES.standing.test(def));
        });
    const level = levelsOf(g, props, ctx.seed, (x, y) => {
      const stack = stackOn(x, y);
      if (stack.length === 0 || isWet(stack) || !ctx.covered(x, y)) return false;
      if (ctx.raisedAt(x, y) !== base) return false;
      const ledge = props.terrace > 0;
      return (
        !N8.some(([dx, dy]) => {
          const beside = ctx.raisedAt(x + dx, y + dy);
          return beside > base || (ledge && beside < base) || built(x + dx, y + dy);
        }) && !built(x, y)
      );
    });
    if (!level.some((l) => l > 0)) {
      return {
        ok: false,
        reason: "There is no dry, open ground on one level inside the frame to raise",
      };
    }
    const tile = (id: string, direction?: Direction) => placed(id, ctx.tilesById, direction);
    const flat = (p: PlacedTile) => isFlat(p, ctx.tilesById);
    /** A cell's level above the hill's base: its own terraces inside the hill, and what earlier hills made of it outside. */
    const levelAt = (x: number, y: number) => {
      const own = inGrid(g, x, y) ? level[gridIndex(g, x, y)]! : 0;
      return own || ctx.raisedAt(x, y) - base;
    };
    const around = (i: number, test: (l: number) => boolean) =>
      N8.some(([dx, dy]) => test(levelAt(gridX(g, i) + dx, gridY(g, i) + dy)));

    const used = new Set<string>();
    const key = (c: Cell) => `${c.x},${c.y}`;
    const ground: RampGround = {
      level: levelAt,
      clear: (x, y) => {
        if (!inGrid(g, x, y) || used.has(`${x},${y}`)) return false;
        const stack = stackOn(x, y);
        if (stack.length === 0 || isWet(stack)) return false;
        return level[gridIndex(g, x, y)]! > 0 || !built(x, y);
      },
    };
    const canRamp = ctx.tilesById[props.ramp] && ctx.tilesById[props.rampBlock];
    const sites: RampSite[] = [];
    for (const point of canRamp ? props.ramps : []) {
      const near = ctx.point(point);
      if (!near) continue;
      const site = nearestRamp(
        ground,
        near,
        Math.max(g.width, g.height),
        (s) => inGrid(g, s.head.x, s.head.y) && level[gridIndex(g, s.head.x, s.head.y)]! > 0,
      );
      if (!site) continue;
      sites.push(site);
      const cells = rampCells(site);
      for (const c of [cells.head, cells.high, cells.low]) used.add(key(c));
    }
    const heads = new Set(sites.map((s) => gridIndex(g, s.head.x, s.head.y)));

    const tops = new Map<string, StackEdit>();
    const edits: StackEdit[] = [];
    for (let i = 0; i < level.length; i++) {
      const L = level[i]!;
      if (L === 0) continue;
      const x = gridX(g, i);
      const y = gridY(g, i);
      const stack = before(i);
      for (let z = 0; z < L; z++) {
        const under =
          z === 0 ? [...stack.slice(0, 1), ...stack.slice(1).filter(flat)] : [tile(props.ground)];
        const column =
          heads.has(i) && z === L - 1
            ? [...under, tile(props.rampBlock), tile(props.rampBlock)]
            : around(i, (l) => l === z)
              ? [...under, tile(props.wall)]
              : [tile(props.wall)];
        edits.push({ x, y, z: z0 + z, stack: column });
      }
      const edge = !heads.has(i) && around(i, (l) => l < L);
      const carried = stack.slice(1).filter((p) => !flat(p));
      tops.set(`${x},${y}`, {
        x,
        y,
        z: z0 + L,
        stack: [tile(edge ? (brinkOf(props.ground) ?? props.brink) : props.ground), ...carried],
      });
    }
    for (const site of sites) {
      const { high, low } = rampCells(site);
      const slope = (cell: Cell, under: PlacedTile[]) => {
        const top = tops.get(key(cell));
        const bottom = (top?.stack ?? stackOn(cell.x, cell.y)).slice(0, 1);
        tops.set(key(cell), {
          x: cell.x,
          y: cell.y,
          z: top?.z ?? z0,
          stack: [...bottom, ...under, tile(props.ramp, site.side)],
        });
      };
      slope(low, []);
      slope(high, [tile(props.rampBlock)]);
    }
    edits.push(...tops.values());
    const cells = [];
    for (let i = 0; i < level.length; i++) {
      if (level[i]! > 0) cells.push({ x: gridX(g, i), y: gridY(g, i), levels: base + level[i]! });
    }
    return {
      ok: true,
      edits,
      raised: { cells, ramp: { slope: props.ramp, block: props.rampBlock, ground: props.ground } },
    };
  },
};
