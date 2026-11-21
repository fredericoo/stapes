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
import { TILES, field } from "../field";
import { isWet } from "./line";

export const SHORE_RANGE = { min: 1, max: 3 } as const;

const IslandSchema = v.object({
  fill: v.optional(field.tile(TILES.ground), "sand"),
  shore: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(SHORE_RANGE.min), v.maxValue(SHORE_RANGE.max)),
    2,
  ),
  roughness: v.optional(field.percent(), 40),
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

function touches(g: CellGrid, i: number, mask: Uint8Array, around: typeof N4) {
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
 * Writes its land and the shallows round it, and nothing further out, so the
 * sea it stands in shows past them. Islands merge: shallows are never laid
 * over land that is already there, and where its land meets an earlier
 * island's shallows those are foamed as its own are, so two islands whose
 * land touches are one coast rather than two separated by a channel.
 * Shallows are `water` on a bed of the fill, as Rune Isle's are. Masks cut
 * the land, not the finished island, so a hole a mask makes has shallows and
 * foam round it like any other coast.
 */
export const island: Component<IslandProps> = {
  type: "island",
  label: "Island",
  starter: { frame: { x: 0, y: 0, w: 48, h: 36 } },
  schema: IslandSchema,
  shapesItself: true,
  build(ctx, props) {
    const g = newGrid(ctx.bounds);
    const land = landOf(g, ctx.seed, props);
    for (let i = 0; i < land.length; i++) {
      if (land[i] && !ctx.covered(gridX(g, i), gridY(g, i))) land[i] = 0;
    }
    if (!land.includes(1)) {
      return { ok: false, reason: "No land is left inside the frame's shore and its masks" };
    }
    const distance = distanceFrom(g, land, props.shore + 1);
    const tile = (id: string) => placed(id, ctx.tilesById);
    const before = (i: number) => ctx.stackAt(gridX(g, i), gridY(g, i));
    const dry = (stack: readonly PlacedTile[]) => stack.length > 0 && !isWet(stack);
    const landNow = Uint8Array.from(land, (l, i) => (l || dry(before(i)) ? 1 : 0));

    const edits: StackEdit[] = [];
    for (let i = 0; i < land.length; i++) {
      const x = gridX(g, i);
      const y = gridY(g, i);
      const stack = before(i);
      if (land[i]) {
        edits.push({ x, y, z: ctx.z, stack: [tile(props.fill)] });
      } else if (distance[i]! >= 1 && distance[i]! <= props.shore && !dry(stack)) {
        const shallows = [tile(props.fill), tile("water")];
        if (touches(g, i, landNow, N4)) shallows.push(tile("shore-foam"));
        edits.push({ x, y, z: ctx.z, stack: shallows });
      } else if (isWet(stack) && stack.at(-1)?.tileId === "water" && touches(g, i, land, N4)) {
        edits.push({ x, y, z: ctx.z, stack: [...stack, tile("shore-foam")] });
      }
    }
    return { ok: true, edits };
  },
};
