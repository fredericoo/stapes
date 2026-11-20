import { hashCell, type Bounds } from "../generator";
import type { Frame, MapDoc, MapNode, PinX, PinY, Point } from "./doc";

export type Placement = {
  readonly node: MapNode;
  readonly bounds: Bounds;
  readonly clip: Bounds;
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
