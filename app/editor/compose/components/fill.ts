import * as v from "valibot";
import { getStack, stackHeight, type StackEdit } from "../../../lib/mapData";
import type { PlacedTile } from "../../../lib/types";
import { placed } from "../../generator";
import type { BuildContext, Component } from "../build";
import { TILES, field } from "../field";
import { brinkOf, groundOf, isBrink, isFlat } from "../brinks";
import { isWet } from "./line";

const FillSchema = v.object({
  tiles: v.optional(field.tiles(TILES.any, 1), ["water", "deep-water"]),
  mode: v.optional(v.picklist(["replace", "ground", "on top", "whole stack"]), "replace"),
  edge: v.optional(field.tiles(TILES.any), ["water"]),
  edgeWidth: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(4)), 2),
  onlyOn: v.optional(field.tiles(TILES.ground), []),
});

export type FillProps = v.InferOutput<typeof FillSchema>;

const N8 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

const N4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/**
 * The ground at the foot of a cliff is in the column of the raised cell, under
 * its wall, which a layer working on each cell's top never reads. Wherever
 * this layer laid flat ground beside a cliff, the same ground goes under the
 * wall, so the cliff stands on it. An edit's `z` is lowered by the cell's own
 * rise because the build raises every edit of a layer by it.
 */
function feet(
  ctx: BuildContext,
  props: FillProps,
  edits: readonly StackEdit[],
  inner: readonly PlacedTile[],
  onlyOn: ReadonlySet<string>,
): StackEdit[] {
  if (props.mode !== "on top" && props.mode !== "ground") return [];
  const flat = inner.filter((p) => isFlat(p, ctx.tilesById));
  if (flat.length === 0) return [];
  const out = new Map<string, StackEdit>();
  for (const edit of edits) {
    const level = ctx.raisedAt(edit.x, edit.y);
    for (const [dx, dy] of N8) {
      const x = edit.x + dx;
      const y = edit.y + dy;
      const rise = ctx.raisedAt(x, y);
      if (rise <= level || out.has(`${x},${y}`) || !ctx.covered(x, y)) continue;
      const column = getStack(ctx.map, x, y, ctx.z + level);
      const ground = column[0];
      if (column.length !== 2 || !ground || !isFlat(ground, ctx.tilesById)) continue;
      const read = props.mode === "ground" ? ground.tileId : groundOf(ground.tileId);
      if (onlyOn.size && !onlyOn.has(read)) continue;
      const stack = props.mode === "ground" ? [...flat, column[1]!] : [ground, ...flat, column[1]!];
      out.set(`${x},${y}`, { x, y, z: ctx.z + level - rise, stack });
    }
  }
  return [...out.values()];
}

/**
 * Lays a stack of tiles, bottom first, over every cell of its frame its masks
 * leave in: a lake is a fill of water with a ragged oval mask. `replace`
 * keeps each cell's bottom tile and replaces what stands on it, which is how
 * water goes in over a road; `ground` does the opposite, replacing the bottom
 * tile under everything that stands on it, which is how sand becomes grass
 * without a hole under each tree, and leaves water alone; `on top` adds to
 * bare ground and passes over anything standing; `whole stack` replaces
 * everything. `onlyOn` reads the top tile of a cell, or the bottom one for
 * `ground`, since that is the tile it replaces; a brink reads as the ground
 * it is cut from, and in those two modes takes the brink of what is laid on
 * it instead of being covered, where that ground has a brink. Cells within
 * `edgeWidth` steps of the area's edge get the `edge` stack instead, so a
 * lake can be shallow round a deep middle.
 */
export const fill: Component<FillProps> = {
  type: "fill",
  label: "Fill",
  starter: { frame: { x: 2, y: 2, w: 12, h: 10 } },
  schema: FillSchema,
  build(ctx, props) {
    const { minX, minY, maxX, maxY } = ctx.bounds;
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const onlyOn = new Set(props.onlyOn);
    const inArea = new Uint8Array(width * height);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (!ctx.covered(x, y)) continue;
        const stack = ctx.stackAt(x, y);
        if (stack.length === 0 && props.mode !== "whole stack") continue;
        const ground = props.mode === "ground";
        if (ground && isWet(stack)) continue;
        const read = ground ? stack[0] : stack.at(-1);
        if (onlyOn.size && !onlyOn.has(groundOf(read?.tileId ?? ""))) continue;
        inArea[(y - minY) * width + (x - minX)] = 1;
      }
    }
    const depth = new Int32Array(width * height).fill(-1);
    const queue: number[] = [];
    for (let i = 0; i < inArea.length; i++) {
      if (!inArea[i]) continue;
      const x = i % width;
      const y = (i - x) / width;
      const onEdge = N4.some(([dx, dy]) => {
        const nx = x + dx;
        const ny = y + dy;
        return nx < 0 || ny < 0 || nx >= width || ny >= height || !inArea[ny * width + nx];
      });
      if (onEdge) {
        depth[i] = 1;
        queue.push(i);
      }
    }
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head]!;
      const x = i % width;
      const y = (i - x) / width;
      for (const [dx, dy] of N4) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (!inArea[j] || depth[j] !== -1) continue;
        depth[j] = depth[i]! + 1;
        queue.push(j);
      }
    }
    const stackOf = (ids: readonly string[]) => ids.map((id) => placed(id, ctx.tilesById));
    /** Flat tiles laid whole on a brink would cover it, so they become the brink of the top one where that ground has one. */
    const cutToBrink = (laid: PlacedTile[]): PlacedTile[] => {
      const flat = laid.filter((p) => isFlat(p, ctx.tilesById));
      const brink = flat.length ? brinkOf(flat.at(-1)!.tileId) : undefined;
      if (!brink) return laid;
      return [placed(brink, ctx.tilesById), ...laid.filter((p) => !isFlat(p, ctx.tilesById))];
    };
    const inner = stackOf(props.tiles);
    const rim = props.edge.length ? stackOf(props.edge) : inner;
    const edits: StackEdit[] = [];
    for (let i = 0; i < inArea.length; i++) {
      if (!inArea[i]) continue;
      const x = minX + (i % width);
      const y = minY + Math.floor(i / width);
      const laid = depth[i]! <= props.edgeWidth ? rim : inner;
      const stack = ctx.stackAt(x, y);
      let next: PlacedTile[];
      const cut = isBrink(stack[0]?.tileId) ? cutToBrink(laid) : laid;
      if (props.mode === "whole stack") next = laid;
      else if (props.mode === "replace") next = [...stack.slice(0, 1), ...laid];
      else if (props.mode === "ground") next = [...cut, ...stack.slice(1)];
      else if (stackHeight(stack, ctx.tilesById) > 0) continue;
      else if (cut !== laid) next = [...cut, ...stack.slice(1)];
      else next = [...stack, ...laid];
      edits.push({ x, y, z: ctx.z, stack: next });
    }
    edits.push(...feet(ctx, props, edits, inner, onlyOn));
    return { ok: true, edits };
  },
};
