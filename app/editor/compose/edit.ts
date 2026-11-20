import type { Bounds } from "../generator";
import type { Frame, MapDoc, MapNode, Point } from "./doc";
import { frameBounds, frameFor, pointFor, pointIn, type Layout } from "./layout";

function mapNodes(node: MapNode, fn: (node: MapNode) => MapNode): MapNode {
  const next = fn(node);
  if (!next.children) return next;
  return { ...next, children: next.children.map((child) => mapNodes(child, fn)) };
}

export function findNode(root: MapNode, key: string): MapNode | null {
  if (root.key === key) return root;
  for (const child of root.children ?? []) {
    const found = findNode(child, key);
    if (found) return found;
  }
  return null;
}

export function findParent(root: MapNode, key: string): MapNode | null {
  for (const child of root.children ?? []) {
    if (child.key === key) return root;
    const found = findParent(child, key);
    if (found) return found;
  }
  return null;
}

export function allKeys(root: MapNode): string[] {
  return [root.key, ...(root.children ?? []).flatMap(allKeys)];
}

export function updateNode(doc: MapDoc, key: string, fn: (node: MapNode) => MapNode): MapDoc {
  return { ...doc, root: mapNodes(doc.root, (node) => (node.key === key ? fn(node) : node)) };
}

function isPoint(value: unknown): value is Point {
  return typeof value === "object" && value !== null && "x" in value && "y" in value;
}

/**
 * Renames a node and every point that is measured in its frame, so a road
 * pinned to a town stays pinned to it. Points are found by shape, in any
 * prop of any node, because a component's schema is the only place that says
 * which props are points.
 */
export function renameNode(doc: MapDoc, from: string, to: string): MapDoc {
  const retarget = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(retarget);
    if (isPoint(value)) return value.in === from ? { ...value, in: to } : value;
    return value;
  };
  return {
    ...doc,
    root: mapNodes(doc.root, (node) => {
      const props = node.props
        ? Object.fromEntries(Object.entries(node.props).map(([k, v]) => [k, retarget(v)]))
        : undefined;
      return { ...node, key: node.key === from ? to : node.key, ...(props ? { props } : {}) };
    }),
  };
}

export function removeNode(doc: MapDoc, key: string): MapDoc {
  if (doc.root.key === key) return doc;
  return {
    ...doc,
    root: mapNodes(doc.root, (node) =>
      node.children?.some((c) => c.key === key)
        ? { ...node, children: node.children.filter((c) => c.key !== key) }
        : node,
    ),
  };
}

export function insertNode(
  doc: MapDoc,
  parentKey: string,
  index: number,
  inserted: MapNode,
): MapDoc {
  return updateNode(doc, parentKey, (parent) => {
    const children = [...(parent.children ?? [])];
    children.splice(Math.max(0, Math.min(index, children.length)), 0, inserted);
    return { ...parent, children };
  });
}

/** Refuses a move into the node's own subtree, which would detach it from the tree. */
export function moveNode(doc: MapDoc, key: string, parentKey: string, index: number): MapDoc {
  const node = findNode(doc.root, key);
  if (!node || node === doc.root || findNode(node, parentKey)) return doc;
  const parent = findParent(doc.root, key);
  const from = parent?.children?.findIndex((c) => c.key === key) ?? -1;
  const at = parent?.key === parentKey && from < index ? index - 1 : index;
  return insertNode(removeNode(doc, key), parentKey, at, node);
}

export function freeKey(root: MapNode, base: string): string {
  const taken = new Set(allKeys(root));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * Copies a node and everything under it with fresh keys, beside the original.
 * A point inside the copy that named a node inside the original names that
 * node's copy, so a copied town keeps its own roads; one that named a node
 * outside it keeps naming that node.
 */
export function duplicateNode(doc: MapDoc, key: string): { doc: MapDoc; key: string } {
  const node = findNode(doc.root, key);
  const parent = findParent(doc.root, key);
  if (!node || !parent) return { doc, key };
  const renames = new Map<string, string>();
  const taken = new Set(allKeys(doc.root));
  for (const old of allKeys(node)) {
    let next = `${old}-copy`;
    for (let n = 2; taken.has(next); n++) next = `${old}-copy-${n}`;
    taken.add(next);
    renames.set(old, next);
  }
  const retarget = (value: unknown): unknown =>
    isPoint(value) && value.in && renames.has(value.in)
      ? { ...value, in: renames.get(value.in) }
      : value;
  const copy = mapNodes(node, (n) => ({
    ...n,
    key: renames.get(n.key)!,
    ...(n.props
      ? { props: Object.fromEntries(Object.entries(n.props).map(([k, v]) => [k, retarget(v)])) }
      : {}),
  }));
  const index = parent.children!.findIndex((c) => c.key === key);
  return { doc: insertNode(doc, parent.key, index + 1, copy), key: copy.key };
}

/** Puts a node inside a new group without a frame where it stood, which changes nothing it builds. */
export function wrapInGroup(doc: MapDoc, key: string): { doc: MapDoc; key: string } {
  const node = findNode(doc.root, key);
  const parent = findParent(doc.root, key);
  if (!node || !parent) return { doc, key };
  const groupKey = freeKey(doc.root, "group");
  const index = parent.children!.findIndex((c) => c.key === key);
  const wrapped = insertNode(removeNode(doc, key), parent.key, index, {
    type: "group",
    key: groupKey,
    children: [node],
  });
  return { doc: wrapped, key: groupKey };
}

function union(boxes: Bounds[]): Bounds | null {
  if (boxes.length === 0) return null;
  return {
    minX: Math.min(...boxes.map((b) => b.minX)),
    minY: Math.min(...boxes.map((b) => b.minY)),
    maxX: Math.max(...boxes.map((b) => b.maxX)),
    maxY: Math.max(...boxes.map((b) => b.maxY)),
  };
}

/**
 * Rewrites what is measured in a frame that moves from `from` to `to` so it
 * stays where it is: a child's frame keeps its pins and gets new offsets, and
 * a child without a frame, which fills the moving one, has its own points
 * rewritten and its children rebased in turn. Absolute frames and points
 * measured in another node's frame are left alone.
 */
function rebase(node: MapNode, from: Bounds, to: Bounds): MapNode {
  const children = node.children?.map((child) => {
    if (child.frame) {
      if (child.frame.absolute) return child;
      return { ...child, frame: frameFor(child.frame, frameBounds(child.frame, from), to) };
    }
    const props = child.props
      ? Object.fromEntries(
          Object.entries(child.props).map(([k, v]) =>
            isPoint(v) && !v.in ? [k, pointFor(v, pointIn(v, from), to)] : [k, v],
          ),
        )
      : undefined;
    return rebase({ ...child, ...(props ? { props } : {}) }, from, to);
  });
  return children ? { ...node, children } : node;
}

/**
 * Gives a node a frame, or takes it away so it fills its parent, without
 * moving anything inside it. "fit" sizes the frame round its children's
 * frames and every cell its subtree wrote in the last build, so nothing it
 * builds ends up clipped by the new frame.
 */
export function reframeNode(
  doc: MapDoc,
  built: { layout: Layout; written: ReadonlyMap<string, Bounds> },
  key: string,
  frame: Frame | "fit" | null,
): MapDoc {
  const { layout } = built;
  const placement = layout.placements.get(key);
  if (!placement?.parent) return doc;
  const parent = placement.parent;
  let to: Bounds;
  let nextFrame: Frame | undefined;
  if (frame === null) {
    to = parent;
  } else {
    const fitted =
      frame === "fit"
        ? union([
            ...(placement.node.children ?? []).flatMap((c) => {
              const b = layout.placements.get(c.key);
              return b && c.frame ? [b.bounds] : [];
            }),
            ...allKeys(placement.node).flatMap((k) => {
              const b = built.written.get(k);
              return b ? [b] : [];
            }),
          ])
        : null;
    to = fitted ?? (frame === "fit" ? placement.bounds : frameBounds(frame, parent));
    nextFrame = frameFor(frame === "fit" ? { x: 0, y: 0, w: 1, h: 1 } : frame, to, parent);
  }
  return updateNode(doc, key, (node) => {
    const rebased = rebase(node, placement.bounds, to);
    if (nextFrame) return { ...rebased, frame: nextFrame };
    const { frame: _frame, ...rest } = rebased;
    return rest;
  });
}
