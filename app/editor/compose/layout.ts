import { hashCell, type Bounds } from "../generator";
import type { Frame, MapDoc, MapNode, PinX, PinY, Point } from "./doc";

export type Placement = {
  readonly node: MapNode;
  readonly bounds: Bounds;
  readonly clip: Bounds;
  readonly parent: Bounds | null;
  readonly z: number;
  readonly seed: number;
  readonly depth: number;
};

export type Layout = {
  readonly placements: ReadonlyMap<string, Placement>;
  readonly order: readonly string[];
  readonly problems: ReadonlyArray<{ key: string; reason: string }>;
};

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const KEY_SALT = 0x6b6579;

/**
 * Seeded from the document's seed and the node's key, never its parent's
 * seed or its place in the tree, so re-rolling or moving one node leaves
 * every other node's randomness where it was.
 */
export function seedFor(docSeed: number, node: MapNode): number {
  if (node.seed !== undefined) return node.seed >>> 0;
  let h = FNV_OFFSET;
  for (let i = 0; i < node.key.length; i++) {
    h = Math.imul(h ^ node.key.charCodeAt(i), FNV_PRIME);
  }
  return hashCell(h, KEY_SALT, docSeed);
}

function along(min: number, max: number, offset: number, pin: PinX | PinY, size: number): number {
  const span = max - min + 1;
  if (pin === "right" || pin === "bottom") return Math.round(max - offset - (size - 1));
  if (pin === "center") return Math.round(min + Math.floor((span - size) / 2) + offset);
  if (pin === "scale") return Math.round(min + offset * (span - size));
  return Math.round(min + offset);
}

export function frameBounds(frame: Frame, parent: Bounds | null): Bounds {
  if (frame.absolute || !parent) {
    const minX = Math.round(frame.x);
    const minY = Math.round(frame.y);
    return { minX, minY, maxX: minX + frame.w - 1, maxY: minY + frame.h - 1 };
  }
  const minX = along(parent.minX, parent.maxX, frame.x, frame.pinX ?? "left", frame.w);
  const minY = along(parent.minY, parent.maxY, frame.y, frame.pinY ?? "top", frame.h);
  return { minX, minY, maxX: minX + frame.w - 1, maxY: minY + frame.h - 1 };
}

/** The inverse of `along`: the offset that puts a span of `size` at `at` under `pin`. */
function offsetAlong(min: number, max: number, at: number, pin: PinX | PinY, size: number): number {
  const span = max - min + 1;
  if (pin === "right" || pin === "bottom") return max - (size - 1) - at;
  if (pin === "center") return at - min - Math.floor((span - size) / 2);
  if (pin === "scale") return span === size ? 0 : (at - min) / (span - size);
  return at - min;
}

/** The frame that resolves to `bounds`, keeping the frame's pins, so dragging a box keeps what it is pinned to. */
export function frameFor(frame: Frame, bounds: Bounds, parent: Bounds | null): Frame {
  const w = bounds.maxX - bounds.minX + 1;
  const h = bounds.maxY - bounds.minY + 1;
  if (frame.absolute || !parent) return { ...frame, x: bounds.minX, y: bounds.minY, w, h };
  return {
    ...frame,
    x: offsetAlong(parent.minX, parent.maxX, bounds.minX, frame.pinX ?? "left", w),
    y: offsetAlong(parent.minY, parent.maxY, bounds.minY, frame.pinY ?? "top", h),
    w,
    h,
  };
}

/** The point, keeping its frame and pins, that resolves to `cell`. */
export function pointFor(point: Point, cell: { x: number; y: number }, frame: Bounds): Point {
  return {
    ...point,
    x: offsetAlong(frame.minX, frame.maxX, cell.x, point.pinX ?? "left", 1),
    y: offsetAlong(frame.minY, frame.maxY, cell.y, point.pinY ?? "top", 1),
  };
}

export function pointFrame(layout: Layout, placement: Placement, point: Point): Bounds | null {
  return point.in ? (layout.placements.get(point.in)?.bounds ?? null) : placement.bounds;
}

function intersect(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.max(a.minX, b.minX),
    minY: Math.max(a.minY, b.minY),
    maxX: Math.min(a.maxX, b.maxX),
    maxY: Math.min(a.maxY, b.maxY),
  };
}

export function pointIn(point: Point, frame: Bounds): { x: number; y: number } {
  return {
    x: along(frame.minX, frame.maxX, point.x, point.pinX ?? "left", 1),
    y: along(frame.minY, frame.maxY, point.y, point.pinY ?? "top", 1),
  };
}

/**
 * Every frame is resolved before anything is built, so a road can be pinned to
 * a town that comes after it in the tree. A node without a frame fills its
 * parent; the root's frame is in world cells whether or not it says so.
 */
export function layOut(doc: MapDoc): Layout {
  const placements = new Map<string, Placement>();
  const order: string[] = [];
  const problems: Array<{ key: string; reason: string }> = [];

  const visit = (node: MapNode, parent: Placement | null, depth: number) => {
    if (placements.has(node.key)) {
      problems.push({ key: node.key, reason: `Another node is already called ${node.key}` });
      return;
    }
    let bounds: Bounds;
    if (node.frame) bounds = frameBounds(node.frame, parent?.bounds ?? null);
    else if (parent) bounds = parent.bounds;
    else {
      problems.push({ key: node.key, reason: "The root needs a frame" });
      return;
    }
    const z =
      node.frame?.absolute || !parent ? (node.frame?.z ?? 0) : parent.z + (node.frame?.z ?? 0);
    const placement: Placement = {
      node,
      bounds,
      clip: parent ? intersect(parent.clip, parent.bounds) : bounds,
      parent: parent?.bounds ?? null,
      z,
      seed: seedFor(doc.seed, node),
      depth,
    };
    placements.set(node.key, placement);
    order.push(node.key);
    for (const child of node.children ?? []) visit(child, placement, depth + 1);
  };
  visit(doc.root, null, 0);
  return { placements, order, problems };
}
