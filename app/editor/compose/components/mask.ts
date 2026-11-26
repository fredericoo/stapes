import * as v from "valibot";
import type { StackEdit } from "../../../lib/mapData";
import type { PlacedTile } from "../../../lib/types";
import { fbm, type Bounds } from "../../generator";
import type { Component } from "../build";
import { TILES, field } from "../field";

export const MASK_TYPE = "mask";

export const MASK_OPS = ["subtract", "add", "intersect"] as const;

const MaskSchema = v.object({
  shape: v.optional(v.picklist(["oval", "rect"]), "oval"),
  op: v.optional(v.picklist(MASK_OPS), "subtract"),
  ragged: v.optional(field.percent(), 0),
  raggedScale: v.optional(v.pipe(v.number(), v.integer(), v.minValue(2), v.maxValue(32)), 6),
  grow: v.optional(v.pipe(v.number(), v.integer(), v.minValue(-16), v.maxValue(24)), 0),
  only: v.optional(field.tiles(TILES.any), []),
  from: v.optional(v.nullable(field.node()), null),
});

export type MaskProps = v.InferOutput<typeof MaskSchema>;

/**
 * Writes nothing. A mask is a child of the layer it shapes, and the build
 * passes that layer's output through its masks before writing it (see
 * `applyMasks`), so it is the only component whose effect is on its parent.
 */
export const mask: Component<MaskProps> = {
  type: MASK_TYPE,
  label: "Mask",
  starter: { frame: { x: 2, y: 2, w: 10, h: 8 }, props: { ragged: 40 } },
  schema: MaskSchema,
  build: () => ({ ok: true, edits: [] }),
};

const RAGGED_OCTAVES = 2;
/** At 100% ragged the edge moves by up to half the shape's radius in or out. */
const RAGGED_REACH = 0.5;

export type MaskShape = {
  op: (typeof MASK_OPS)[number];
  only: ReadonlySet<string> | null;
  minX: number;
  minY: number;
  width: number;
  height: number;
  cells: Uint8Array;
};

const N4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/**
 * Grows the shape by `by` cells where it is 0 and shrinks it where it is 1,
 * stepping a cell at a time to each of four neighbours, so a grown oval keeps
 * its outline rather than squaring off.
 */
function grown(shape: MaskShape, by: number) {
  if (by === 0) return;
  const { width, height, cells } = shape;
  const want = by > 0 ? 1 : 0;
  const distance = new Int32Array(cells.length).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === want) {
      distance[i] = 0;
      queue.push(i);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    if (distance[i]! >= Math.abs(by)) continue;
    const x = i % width;
    const y = (i - x) / width;
    for (const [dx, dy] of N4) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const j = ny * width + nx;
      if (distance[j] !== -1) continue;
      distance[j] = distance[i]! + 1;
      queue.push(j);
    }
  }
  for (let i = 0; i < cells.length; i++) if (distance[i]! > 0) cells[i] = want;
}

/** Which cells a layer wrote, as a grid over the box round them. */
export type Footprint = {
  minX: number;
  minY: number;
  width: number;
  height: number;
  cells: Uint8Array;
};

export function footprintOf(cells: readonly { x: number; y: number }[]): Footprint | null {
  if (cells.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { x, y } of cells) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const width = maxX - minX + 1;
  const footprint = { minX, minY, width, height: maxY - minY + 1, cells: new Uint8Array(0) };
  footprint.cells = new Uint8Array(width * footprint.height);
  for (const { x, y } of cells) footprint.cells[(y - minY) * width + (x - minX)] = 1;
  return footprint;
}

function emptyShape(props: MaskProps, minX: number, minY: number, width: number, height: number) {
  return {
    op: props.op,
    only: props.only.length ? new Set(props.only) : null,
    minX,
    minY,
    width,
    height,
    cells: new Uint8Array(width * height),
  } satisfies MaskShape;
}

/**
 * The cells a mask covers. A shape mask's cell is inside when its centre's
 * distance from the shape's middle, in units of the shape's half-size (round
 * for an oval, square for a rectangle), plus the ragged noise, is at most 1:
 * with no noise that is exactly the frame for a rectangle and the inscribed
 * ellipse for an oval. A mask `from` a layer covers the cells that layer wrote,
 * and grow and ragged widen it from there. The grid spans only as far as the
 * mask can reach, so a small clearing costs a small grid.
 */
export function maskShape(
  props: MaskProps,
  frame: Bounds,
  seed: number,
  footprint: Footprint | null,
): MaskShape {
  const reach = (props.ragged / 100) * RAGGED_REACH;
  const out = Math.max(0, props.grow);
  if (props.from) {
    if (!footprint) return emptyShape(props, 0, 0, 0, 0);
    const wobble = Math.ceil(reach * props.raggedScale);
    const pad = out + wobble;
    const shape = emptyShape(
      props,
      footprint.minX - pad,
      footprint.minY - pad,
      footprint.width + 2 * pad,
      footprint.height + 2 * pad,
    );
    for (let y = 0; y < footprint.height; y++) {
      for (let x = 0; x < footprint.width; x++) {
        if (footprint.cells[y * footprint.width + x]) {
          shape.cells[(y + pad) * shape.width + (x + pad)] = 1;
        }
      }
    }
    if (wobble === 0) {
      grown(shape, props.grow);
      return shape;
    }
    const core = shape.cells.slice();
    const widest = { ...shape, cells: core };
    grown(widest, pad);
    for (let i = 0; i < shape.cells.length; i++) {
      if (!widest.cells[i]) continue;
      const x = shape.minX + (i % shape.width);
      const y = shape.minY + Math.floor(i / shape.width);
      const swing = (fbm(x, y, seed, props.raggedScale, RAGGED_OCTAVES) - 0.5) * 2 * wobble;
      shape.cells[i] = within(core, shape.width, shape.height, i, props.grow + swing) ? 1 : 0;
    }
    return shape;
  }
  const halfW = (frame.maxX - frame.minX + 1) / 2;
  const halfH = (frame.maxY - frame.minY + 1) / 2;
  const pad = Math.ceil(reach * Math.max(halfW, halfH)) + out + 1;
  const shape = emptyShape(
    props,
    frame.minX - pad,
    frame.minY - pad,
    frame.maxX - frame.minX + 1 + 2 * pad,
    frame.maxY - frame.minY + 1 + 2 * pad,
  );
  const cx = frame.minX + halfW;
  const cy = frame.minY + halfH;
  for (let i = 0; i < shape.cells.length; i++) {
    const x = shape.minX + (i % shape.width);
    const y = shape.minY + Math.floor(i / shape.width);
    const nx = Math.abs(x + 0.5 - cx) / halfW;
    const ny = Math.abs(y + 0.5 - cy) / halfH;
    const metric = props.shape === "oval" ? Math.hypot(nx, ny) : Math.max(nx, ny);
    const noise = reach
      ? (fbm(x, y, seed, props.raggedScale, RAGGED_OCTAVES) - 0.5) * 2 * reach
      : 0;
    if (metric + noise <= 1) shape.cells[i] = 1;
  }
  grown(shape, props.grow);
  return shape;
}

/** Whether cell `i` is within `reach` four-neighbour steps of a set cell of `cells`, or, for a negative reach, that far inside them. */
function within(
  cells: Uint8Array,
  width: number,
  height: number,
  i: number,
  reach: number,
): boolean {
  const x0 = i % width;
  const y0 = (i - x0) / width;
  const steps = Math.floor(Math.abs(reach));
  if (reach >= 0) {
    for (let dy = -steps; dy <= steps; dy++) {
      const span = steps - Math.abs(dy);
      for (let dx = -span; dx <= span; dx++) {
        const x = x0 + dx;
        const y = y0 + dy;
        if (x >= 0 && y >= 0 && x < width && y < height && cells[y * width + x]) return true;
      }
    }
    return false;
  }
  if (!cells[i]) return false;
  for (let dy = -steps; dy <= steps; dy++) {
    const span = steps - Math.abs(dy);
    for (let dx = -span; dx <= span; dx++) {
      const x = x0 + dx;
      const y = y0 + dy;
      if (x < 0 || y < 0 || x >= width || y >= height || !cells[y * width + x]) return false;
    }
  }
  return true;
}

function covers(shape: MaskShape, x: number, y: number): boolean {
  const lx = x - shape.minX;
  const ly = y - shape.minY;
  if (lx < 0 || ly < 0 || lx >= shape.width || ly >= shape.height) return false;
  return shape.cells[ly * shape.width + lx] === 1;
}

/**
 * Whether a tile its parent puts at x,y survives the masks. Only masks whose
 * `only` lists the tile, or that list nothing, take part; in order, an add
 * puts back what the mask covers, a subtract takes it away and an intersect
 * keeps only what it covers. A chain that starts with an add starts from
 * nothing, any other from everything.
 */
export function keeps(shapes: readonly MaskShape[], x: number, y: number, tileId: string): boolean {
  const applying = shapes.filter((s) => !s.only || s.only.has(tileId));
  if (applying.length === 0) return true;
  let kept = applying[0]!.op !== "add";
  for (const s of applying) {
    const inside = covers(s, x, y);
    if (s.op === "add") kept ||= inside;
    else if (s.op === "subtract") kept &&= !inside;
    else kept &&= inside;
  }
  return kept;
}

function same(a: PlacedTile | undefined, b: PlacedTile | undefined) {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Takes out of a layer's edits every tile its masks remove. The tiles a layer
 * added to a cell are what follows the part of the stack it kept, and only
 * those are tested; a cell where none of them survive keeps the stack it had,
 * so a subtracted corner of a house is the ground the house was built on.
 */
export function applyMasks(
  edits: readonly StackEdit[],
  shapes: readonly MaskShape[],
  stackAt: (x: number, y: number, z: number) => readonly PlacedTile[],
): StackEdit[] {
  if (shapes.length === 0) return [...edits];
  const out: StackEdit[] = [];
  for (const edit of edits) {
    const before = stackAt(edit.x, edit.y, edit.z);
    let kept = 0;
    while (
      kept < edit.stack.length &&
      kept < before.length &&
      same(edit.stack[kept], before[kept])
    ) {
      kept++;
    }
    const added = edit.stack.slice(kept);
    const surviving = added.filter((p) => keeps(shapes, edit.x, edit.y, p.tileId));
    if (surviving.length === added.length) out.push(edit);
    else if (surviving.length > 0)
      out.push({ ...edit, stack: [...edit.stack.slice(0, kept), ...surviving] });
  }
  return out;
}
