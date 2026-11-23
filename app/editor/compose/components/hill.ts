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
import { distanceTo } from "../distance";
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

const ROOM_EPSILON = 1e-9;

/** The share of the wobble the ellipse is drawn in by, so the noise seldom needs squeezing at all. */
const HEADROOM = 0.6;

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
 * How far each terrace's edge is pushed in or out, in terraces at full
 * roughness, and how many terraces across a bend in it is, so the terraces are
 * not all one width the whole way round.
 */
const TERRACE_SWAY = 0.45;
const TERRACE_SWAY_SCALE = 3;
/**
 * How far, in cells at full roughness, a finer noise than the foot's and the
 * sway's pushes the foot and each terrace's edge in or out, and how many cells
 * across one of its bends is, so neither runs straight for long on a large hill.
 */
const EDGE_JAG = 5;
const EDGE_JAG_SCALE = 3;

/** Lowers every cell to at most one level above its lowest eight-neighbour, which the sway alone does not promise. */
function capSteps(g: CellGrid, level: Uint8Array): Uint8Array {
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < level.length; i++) {
      let lowest = level[i]!;
      for (const [dx, dy] of N8) {
        const x = gridX(g, i) + dx;
        const y = gridY(g, i) + dy;
        if (inGrid(g, x, y)) lowest = Math.min(lowest, level[gridIndex(g, x, y)]!);
      }
      if (level[i]! > lowest + 1) {
        level[i] = lowest + 1;
        changed = true;
      }
    }
  }
  return level;
}

const N4 = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;

/** The most cells the bottom of a dip inside a hill may cover and still be filled; a larger one was cut on purpose. */
const MAX_PIT_CELLS = 64;

/**
 * Raises every cell that could not walk down to the foot of the hill, or off
 * the frame, without climbing, to the level it would spill out at. A dip the
 * foot's noise, a terrace's sway or a mask's ragged edge leaves inside the
 * hill is otherwise a pit a player drops into and cannot leave. Only cells
 * the hill may raise are filled, and only in dips of up to `MAX_PIT_CELLS`;
 * the rest are where the flood starts.
 */
function fillPits(g: CellGrid, level: Uint8Array, mayRaise: Uint8Array): Uint8Array {
  const filled = new Uint8Array(level.length).fill(255);
  const buckets: number[][] = [];
  const add = (i: number, l: number) => {
    filled[i] = l;
    (buckets[l] ??= []).push(i);
  };
  for (let i = 0; i < level.length; i++) {
    const x = gridX(g, i);
    const y = gridY(g, i);
    const rim =
      x === g.minX || y === g.minY || x === g.minX + g.width - 1 || y === g.minY + g.height - 1;
    if (rim || !mayRaise[i]) add(i, level[i]!);
  }
  for (let l = 0; l < buckets.length; l++) {
    const bucket = buckets[l] ?? [];
    for (let k = 0; k < bucket.length; k++) {
      const i = bucket[k]!;
      if (filled[i] !== l) continue;
      for (const [dx, dy] of N4) {
        const x = gridX(g, i) + dx;
        const y = gridY(g, i) + dy;
        if (!inGrid(g, x, y)) continue;
        const j = gridIndex(g, x, y);
        const spill = Math.max(level[j]!, l);
        if (spill < filled[j]!) add(j, spill);
      }
    }
  }
  const seen = new Uint8Array(level.length);
  for (let start = 0; start < level.length; start++) {
    if (seen[start] || filled[start] === level[start]) continue;
    const dip = [start];
    seen[start] = 1;
    for (let k = 0; k < dip.length; k++) {
      for (const [dx, dy] of N4) {
        const x = gridX(g, dip[k]!) + dx;
        const y = gridY(g, dip[k]!) + dy;
        if (!inGrid(g, x, y)) continue;
        const j = gridIndex(g, x, y);
        if (seen[j] || filled[j] === level[j]) continue;
        seen[j] = 1;
        dip.push(j);
      }
    }
    const floor = Math.min(...dip.map((i) => level[i]!));
    const bottom = dip.filter((i) => level[i] === floor).length;
    if (bottom > MAX_PIT_CELLS) for (const i of dip) filled[i] = level[i]!;
  }
  return filled;
}

/** The fewest cells a piece of one level of a hill may have apart from the rest of that level; `MIN_PATCH_CELLS` in `app/verify/landscape.ts` is the same bar. */
const MIN_KNOB_CELLS = 16;

/**
 * Lowers each piece of a level that is smaller than `MIN_KNOB_CELLS` and is
 * not that level's largest piece to the level below, from the top down. The
 * foot's noise leaves knobs a cell or two across beside a hill's edge, which
 * read as specks of its ground in the ground below.
 */
function lowerKnobs(g: CellGrid, level: Uint8Array): Uint8Array {
  const top = Math.max(...level);
  for (let l = top; l >= 1; l--) {
    const piece = new Int32Array(level.length).fill(-1);
    const pieces: number[][] = [];
    for (let start = 0; start < level.length; start++) {
      if (level[start]! < l || piece[start] !== -1) continue;
      const cells = [start];
      piece[start] = pieces.length;
      for (let k = 0; k < cells.length; k++) {
        for (const [dx, dy] of N4) {
          const x = gridX(g, cells[k]!) + dx;
          const y = gridY(g, cells[k]!) + dy;
          if (!inGrid(g, x, y)) continue;
          const j = gridIndex(g, x, y);
          if (level[j]! < l || piece[j] !== -1) continue;
          piece[j] = pieces.length;
          cells.push(j);
        }
      }
      pieces.push(cells);
    }
    const largest = Math.max(0, ...pieces.map((p) => p.length));
    for (const cells of pieces) {
      if (cells.length >= MIN_KNOB_CELLS || cells.length === largest) continue;
      for (const i of cells) level[i] = l - 1;
    }
  }
  return level;
}

/**
 * How many levels each cell is raised. The foot of the hill is a noisy
 * ellipse cut down to dry ground its masks leave in, and a cell's level is how
 * many terraces it is from the nearest cell outside that, in a straight
 * line, so each level is the one below drawn in by a terrace and its corners
 * are round. Neighbours are at most √2 apart, under two terraces, so no cliff
 * is more than one level high. A terrace of one would let diagonal
 * neighbours differ by two levels, so it counts eight-neighbour steps
 * instead. With no terrace every level ends at the foot, in one cliff
 * `levels` high.
 */
function levelsOf(
  g: CellGrid,
  props: HillProps,
  seed: number,
  raisable: (x: number, y: number) => boolean,
  covered: (x: number, y: number) => boolean,
): Uint8Array {
  const wobble = (props.roughness / 100) * MAX_WOBBLE;
  /** A steep hill keeps a smooth foot: a jagged one leaves shelves wide enough for a ramp up its cliffs. */
  const jag = props.terrace >= 2 ? (props.roughness / 100) * EDGE_JAG : 0;
  const rx = (g.width / 2 - MARGIN) / (1 + wobble * HEADROOM);
  const ry = (g.height / 2 - MARGIN) / (1 + wobble * HEADROOM);
  const cx = g.minX + (g.width - 1) / 2;
  const cy = g.minY + (g.height - 1) / 2;
  const scale = Math.max(MIN_EDGE_SCALE, Math.min(g.width, g.height) * EDGE_SCALE_SHARE);
  const n = g.width * g.height;
  const distance = new Int32Array(n).fill(-1);
  const mayRaise = new Uint8Array(n);
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
    const jagged = (fbm(x, y, seed ^ 0x1a66, EDGE_JAG_SCALE, 2) - 0.5) * 2 * jag;
    const noise =
      (fbm(x, y, seed, scale, EDGE_OCTAVES) - 0.5) * 2 * wobble + jagged / Math.min(rx, ry);
    /**
     * The noise pushes the foot out only as far as the frame's margin leaves
     * room for, squeezed smoothly towards that limit. Cut off by the frame
     * instead, a side would be a straight line, and so would every terrace.
     */
    const toFrame = Math.min(
      ((g.width - 1) / 2 - MARGIN) / Math.max(Math.abs(x - cx), ROOM_EPSILON),
      ((g.height - 1) / 2 - MARGIN) / Math.max(Math.abs(y - cy), ROOM_EPSILON),
    );
    const room = Math.max(0, d * toFrame - 1);
    const bulge = noise <= 0 ? noise : room * Math.tanh(noise / Math.max(room, ROOM_EPSILON));
    if (fromEdge >= MARGIN && raisable(x, y)) {
      mayRaise[i] = 1;
      if (d - bulge <= 1 && covered(x, y)) continue;
    }
    distance[i] = 0;
    queue.push(i);
  }
  if (props.terrace >= 2) {
    const round = distanceTo(g.width, g.height, (i) => distance[i] === 0);
    const sway = (props.roughness / 100) * props.terrace * TERRACE_SWAY;
    const swayScale = Math.max(MIN_EDGE_SCALE, props.terrace * TERRACE_SWAY_SCALE);
    const level = Uint8Array.from(round, (d, i) => {
      if (d === 0) return 0;
      const x = gridX(g, i);
      const y = gridY(g, i);
      const push =
        (fbm(x, y, seed ^ 0x7e55, swayScale, 2) - 0.5) * 2 * sway +
        (fbm(x, y, seed ^ 0x1a66, EDGE_JAG_SCALE, 2) - 0.5) * 2 * jag;
      return Math.max(1, Math.min(props.levels, Math.ceil((d + push) / props.terrace)));
    });
    return lowerKnobs(g, fillPits(g, capSteps(g, level), mayRaise));
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
  const level = Uint8Array.from(distance, (d) =>
    d === 0 ? 0 : props.terrace === 0 ? props.levels : Math.min(props.levels, d),
  );
  return lowerKnobs(g, fillPits(g, level, mayRaise));
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
 * cut the foot of the hill, not the finished one. A hole of a few cells that
 * a mask's ragged edge cuts inside the hill is raised with it, since nobody
 * could climb out of it.
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
    const level = levelsOf(
      g,
      props,
      ctx.seed,
      (x, y) => {
        const stack = stackOn(x, y);
        if (stack.length === 0 || isWet(stack)) return false;
        if (ctx.raisedAt(x, y) !== base) return false;
        const ledge = props.terrace > 0;
        return (
          !N8.some(([dx, dy]) => {
            const beside = ctx.raisedAt(x + dx, y + dy);
            return beside > base || (ledge && beside < base) || built(x + dx, y + dy);
          }) && !built(x, y)
        );
      },
      ctx.covered,
    );
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
