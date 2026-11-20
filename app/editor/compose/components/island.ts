import * as v from "valibot";
import type { StackEdit } from "../../../lib/mapData";
import type { PlacedTile } from "../../../lib/types";
import {
  fbm,
  gridIndex,
  gridX,
  gridY,
  inGrid,
  newGrid,
  placed,
  regionsOf,
  type CellGrid,
} from "../../generator";
import type { Component } from "../build";
import { TileIdSchema } from "../doc";

export const SHORE_RANGE = { min: 1, max: 3 } as const;

const IslandSchema = v.object({
  fill: v.optional(TileIdSchema, "sand"),
  shore: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(SHORE_RANGE.min), v.maxValue(SHORE_RANGE.max)),
    2,
  ),
  roughness: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(100)), 40),
});

export type IslandProps = v.InferOutput<typeof IslandSchema>;

const COAST_OCTAVES = 3;
const MIN_COAST_SCALE = 6;
const COAST_SCALE_SHARE = 0.25;
const MAX_WOBBLE = 0.6;
const LAND_ABOVE = 0.15;

const N4 = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;

const N8 = [...N4, [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

function touches(g: CellGrid, i: number, mask: Uint8Array, around: typeof N4 | typeof N8) {
  const x = gridX(g, i);
  const y = gridY(g, i);
  return around.some(
    ([dx, dy]) => inGrid(g, x + dx, y + dy) && mask[gridIndex(g, x + dx, y + dy)] === 1,
  );
}

/**
 * The coast is an ellipse inset from the frame by the shore and one cell
 * more, pushed in and out by noise. Only the largest piece of land is kept and
 * every lake it encloses is filled, so the island is one body with one coast.
 */
function landOf(g: CellGrid, seed: number, props: IslandProps): Uint8Array {
  const margin = props.shore + 1;
  const rx = g.width / 2 - margin;
  const ry = g.height / 2 - margin;
  const cx = g.minX + (g.width - 1) / 2;
  const cy = g.minY + (g.height - 1) / 2;
  const scale = Math.max(MIN_COAST_SCALE, Math.min(g.width, g.height) * COAST_SCALE_SHARE);
  const wobble = (props.roughness / 100) * MAX_WOBBLE;

  const land = newGrid({
    minX: g.minX,
    minY: g.minY,
    maxX: g.minX + g.width - 1,
    maxY: g.minY + g.height - 1,
  });
  if (rx < 1 || ry < 1) return land.cells;
  for (let i = 0; i < land.cells.length; i++) {
    const x = gridX(land, i);
    const y = gridY(land, i);
    const fromEdge = Math.min(
      x - g.minX,
      g.minX + g.width - 1 - x,
      y - g.minY,
      g.minY + g.height - 1 - y,
    );
    if (fromEdge < margin) continue;
    const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
    const noise = (fbm(x, y, seed, scale, COAST_OCTAVES) - 0.5) * 2 * wobble;
    if (1 - d + noise > LAND_ABOVE) land.cells[i] = 1;
  }

  const [largest] = regionsOf(land);
  land.cells.fill(0);
  for (const i of largest ?? []) land.cells[i] = 1;

  const sea = land.cells.map((c) => (c ? 0 : 1));
  for (const region of regionsOf(land, sea)) {
    const open = region.some((i) => {
      const x = gridX(land, i);
      const y = gridY(land, i);
      return (
        x === land.minX ||
        y === land.minY ||
        x === land.minX + land.width - 1 ||
        y === land.minY + land.height - 1
      );
    });
    if (!open) for (const i of region) land.cells[i] = 1;
  }
  return land.cells;
}

function distanceFrom(g: CellGrid, land: Uint8Array, limit: number): Int32Array {
  const distance = new Int32Array(land.length).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < land.length; i++) {
    if (land[i]) {
      distance[i] = 0;
      queue.push(i);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    if (distance[i]! >= limit) continue;
    for (const [dx, dy] of N4) {
      const x = gridX(g, i) + dx;
      const y = gridY(g, i) + dy;
      if (!inGrid(g, x, y)) continue;
      const j = gridIndex(g, x, y);
      if (distance[j] !== -1) continue;
      distance[j] = distance[i]! + 1;
      queue.push(j);
    }
  }
  return distance;
}

/**
 * Writes every cell of its frame, land and sea, over whatever was there.
 * The sea's stacks are the ones Rune Isle's sea is built from: shallows are
 * `water` on a bed of the fill, foamed where they meet land, and deep water is
 * `deep-water` with `water` under it where it borders the shallows.
 */
export const island: Component<IslandProps> = {
  type: "island",
  label: "Island",
  schema: IslandSchema,
  build(ctx, props) {
    if (!ctx.tilesById[props.fill])
      return { ok: false, reason: `There is no tile called ${props.fill}` };
    const g = newGrid(ctx.bounds);
    const land = landOf(g, ctx.seed, props);
    if (!land.includes(1)) {
      return { ok: false, reason: "The frame is too small for any land inside its shore" };
    }
    const distance = distanceFrom(g, land, props.shore + 1);
    const shallows = Uint8Array.from(distance, (d) => (d >= 1 && d <= props.shore ? 1 : 0));
    const tile = (id: string) => placed(id, ctx.tilesById);

    const edits: StackEdit[] = [];
    for (let i = 0; i < land.length; i++) {
      let stack: PlacedTile[];
      if (land[i]) stack = [tile(props.fill)];
      else if (shallows[i]) {
        stack = touches(g, i, land, N4)
          ? [tile(props.fill), tile("water"), tile("shore-foam")]
          : [tile(props.fill), tile("water")];
      } else {
        stack = touches(g, i, shallows, N8)
          ? [tile("water"), tile("deep-water")]
          : [tile("deep-water")];
      }
      edits.push({ x: gridX(g, i), y: gridY(g, i), z: ctx.z, stack });
    }
    return { ok: true, edits };
  },
};
