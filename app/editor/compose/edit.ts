import type { Bounds } from "../generator";
import type { Frame, MapDoc, MapNode, Point } from "./doc";
import type { Footprint } from "./components/mask";
import {
  frameBounds,
  frameFor,
  pointFor,
  pointFrame,
  pointIn,
  type Layout,
  type Placement,
} from "./layout";

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
 * A node and everything under it with fresh keys. A point inside the copy
 * that named a node inside the original names that node's copy, so a copied
 * town keeps its own roads; one that named a node outside it keeps naming
 * that node.
 */
function copyOf(doc: MapDoc, node: MapNode): MapNode {
  const renames = new Map<string, string>();
  const taken = new Set(allKeys(doc.root));
  for (const old of allKeys(node)) {
    let next = `${old}-copy`;
    for (let n = 2; taken.has(next); n++) next = `${old}-copy-${n}`;
    taken.add(next);
    renames.set(old, next);
  }
  const retarget = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(retarget)
      : isPoint(value) && value.in && renames.has(value.in)
        ? { ...value, in: renames.get(value.in) }
        : value;
  return mapNodes(node, (n) => ({
    ...n,
    key: renames.get(n.key)!,
    ...(n.props
      ? { props: Object.fromEntries(Object.entries(n.props).map(([k, v]) => [k, retarget(v)])) }
      : {}),
  }));
}

/** Puts a copy of a node at `index` among `parentKey`'s children, leaving the original where it is. */
export function duplicateTo(
  doc: MapDoc,
  key: string,
  parentKey: string,
  index: number,
): { doc: MapDoc; key: string } {
  const node = findNode(doc.root, key);
  if (!node || node === doc.root || !findNode(doc.root, parentKey)) return { doc, key };
  const copy = copyOf(doc, node);
  return { doc: insertNode(doc, parentKey, index, copy), key: copy.key };
}

export function duplicateNode(doc: MapDoc, key: string): { doc: MapDoc; key: string } {
  const parent = findParent(doc.root, key);
  if (!parent) return { doc, key };
  return duplicateTo(doc, key, parent.key, parent.children!.findIndex((c) => c.key === key) + 1);
}

/** The keys that have no ancestor among `keys`, in tree order: moving or deleting these covers the rest. */
export function topmost(root: MapNode, keys: readonly string[]): string[] {
  const wanted = new Set(keys);
  const out: string[] = [];
  const walk = (node: MapNode) => {
    if (wanted.has(node.key)) out.push(node.key);
    else node.children?.forEach(walk);
  };
  walk(root);
  return out;
}

/**
 * Puts nodes inside a new group without a frame where the first of them
 * stood. For one node, or several under one parent, that changes nothing
 * they build; a node brought in from another parent is measured in the
 * group's parent from then on.
 */
export function wrapInGroup(doc: MapDoc, keys: readonly string[]): { doc: MapDoc; key: string } {
  const members = topmost(doc.root, keys).filter((key) => key !== doc.root.key);
  const first = members[0];
  const parent = first ? findParent(doc.root, first) : null;
  if (!first || !parent) return { doc, key: keys[0] ?? doc.root.key };
  const groupKey = freeKey(doc.root, "group");
  const children = members.map((key) => findNode(doc.root, key)!);
  const without = members.slice(1).reduce(removeNode, doc);
  const wrapped = updateNode(without, parent.key, (p) => ({
    ...p,
    children: p.children!.map((c) =>
      c.key === first ? { type: "group", key: groupKey, children } : c,
    ),
  }));
  return { doc: wrapped, key: groupKey };
}

/**
 * Whether a press on `cell` is on a layer: inside its frame when it has one,
 * and otherwise on a cell it wrote, since a layer without a frame fills its
 * parent and its frame says nothing about where it is.
 */
export function hitsLayer(
  placement: Placement,
  footprint: Footprint | null,
  cell: { x: number; y: number },
): boolean {
  if (placement.node.frame) {
    const { bounds } = placement;
    return (
      cell.x >= bounds.minX &&
      cell.x <= bounds.maxX &&
      cell.y >= bounds.minY &&
      cell.y <= bounds.maxY
    );
  }
  if (!footprint) return false;
  const x = cell.x - footprint.minX;
  const y = cell.y - footprint.minY;
  if (x < 0 || y < 0 || x >= footprint.width || y >= footprint.height) return false;
  return footprint.cells[y * footprint.width + x] === 1;
}

/**
 * The layer drawn on top at a cell: the last built whose frame or written
 * cells hold it. A mask is only found while it, its layer or another of that
 * layer's masks is selected, so a press on a lake finds the lake rather than
 * the oval that shapes it.
 */
export function pickLayer(
  root: MapNode,
  built: {
    layout: Layout;
    steps: ReadonlyArray<{ key: string; footprint: Footprint | null }>;
  },
  cell: { x: number; y: number },
  selection: readonly string[],
): string | null {
  for (let i = built.steps.length - 1; i >= 0; i--) {
    const { key, footprint } = built.steps[i]!;
    const placement = built.layout.placements.get(key);
    if (!placement || !hitsLayer(placement, footprint, cell)) continue;
    if (placement.node.type === "mask") {
      const layer = findParent(root, key);
      const open =
        layer &&
        (selection.includes(layer.key) || layer.children?.some((c) => selection.includes(c.key)));
      if (!open) continue;
    }
    return key;
  }
  return null;
}

/**
 * Moves nodes by whole cells from where `layout` has them. Each move reads
 * its geometry from the node `from` in that layout and writes to the node
 * `to`, which is the same node for a move and its copy for a duplicate, so
 * calling it again with another distance replaces the last move rather than
 * adding to it. A framed node gets a new frame and takes its subtree along;
 * one without a frame has its points and its children moved instead. A point
 * measured in a node that is itself moving is left alone, as it follows that
 * node already.
 */
export function translateNodes(
  doc: MapDoc,
  layout: Layout,
  moves: ReadonlyArray<{ from: string; to: string }>,
  dx: number,
  dy: number,
): MapDoc {
  const moving = new Set(
    moves.flatMap(({ from }) => {
      const node = layout.placements.get(from)?.node;
      return node ? allKeys(node) : [];
    }),
  );
  const translated = (node: MapNode, from: MapNode): MapNode => {
    const placement = layout.placements.get(from.key);
    if (!placement) return node;
    if (node.frame && from.frame) {
      const { bounds } = placement;
      const to = {
        minX: bounds.minX + dx,
        maxX: bounds.maxX + dx,
        minY: bounds.minY + dy,
        maxY: bounds.maxY + dy,
      };
      return { ...node, frame: frameFor(node.frame, to, placement.parent) };
    }
    const moved = (now: unknown, was: unknown): unknown => {
      if (Array.isArray(now) && Array.isArray(was)) return now.map((v, i) => moved(v, was[i]));
      if (!isPoint(now) || !isPoint(was) || (was.in && moving.has(was.in))) return now;
      const frame = pointFrame(layout, placement, was);
      if (!frame) return now;
      const at = pointIn(was, frame);
      return pointFor(now, { x: at.x + dx, y: at.y + dy }, frame);
    };
    const props = node.props
      ? Object.fromEntries(
          Object.entries(node.props).map(([k, v]) => [k, moved(v, from.props?.[k])]),
        )
      : undefined;
    const children = node.children?.map((child, i) =>
      from.children?.[i] ? translated(child, from.children[i]) : child,
    );
    return { ...node, ...(props ? { props } : {}), ...(children ? { children } : {}) };
  };
  const targets = new Map(moves.map(({ from, to }) => [to, layout.placements.get(from)?.node]));
  const walk = (node: MapNode): MapNode => {
    const from = targets.get(node.key);
    if (from) return translated(node, from);
    if (!node.children) return node;
    return { ...node, children: node.children.map(walk) };
  };
  return { ...doc, root: walk(doc.root) };
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
    const moved = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(moved) : isPoint(v) && !v.in ? pointFor(v, pointIn(v, from), to) : v;
    const props = child.props
      ? Object.fromEntries(Object.entries(child.props).map(([k, v]) => [k, moved(v)]))
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
