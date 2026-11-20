import type { MapDoc, MapNode, Point } from "./doc";

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
