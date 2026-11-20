import { DragDropProvider, DragOverlay, useDraggable } from "@dnd-kit/react";
import { Tree, TreeGroup, TreeItem, TreeItemIndicator, TreeItemLabel } from "@ui-sdk/react/tree";
import { useMemo, useState, type ReactNode } from "react";
import type { ComponentRegistry } from "./build";
import type { MapNode } from "./doc";

export function branchKeys(node: MapNode): string[] {
  if (!node.children?.length) return [];
  return [node.key, ...node.children.flatMap(branchKeys)];
}

type Zone = "before" | "inside" | "after";

type Spot = { parent: string | null; index: number; children: number };

function spotsOf(root: MapNode): Map<string, Spot> {
  const spots = new Map<string, Spot>();
  const walk = (node: MapNode, parent: string | null, index: number) => {
    spots.set(node.key, { parent, index, children: node.children?.length ?? 0 });
    node.children?.forEach((child, i) => walk(child, node.key, i));
  };
  walk(root, null, 0);
  return spots;
}

/**
 * The row under the pointer and where in it the pointer is. The row is found
 * from the pointer rather than from dnd-kit's collision, which measures the
 * dragged row's whole shape and so can name a neighbour of the row the
 * pointer is on. It looks through every element there because the drag
 * overlay is the topmost one. A row's top and bottom thirds put the dragged layer beside
 * it; the middle third puts it inside, as its last child.
 */
function dropAt(x: number, y: number, rootKey: string): { key: string; zone: Zone } | null {
  const row = document
    .elementsFromPoint(x, y)
    .map((el) => el.closest<HTMLElement>("[data-layer]"))
    .find(Boolean);
  const key = row?.dataset.layer;
  if (!row || !key) return null;
  if (key === rootKey) return { key, zone: "inside" };
  const rect = row.getBoundingClientRect();
  const at = (y - rect.top) / rect.height;
  return { key, zone: at < 1 / 3 ? "before" : at > 2 / 3 ? "after" : "inside" };
}

const DROP_LINE: Record<Zone, string> = {
  before: "shadow-[inset_0_2px_0_var(--color-look)]",
  inside: "outline outline-2 outline-look",
  after: "shadow-[inset_0_-2px_0_var(--color-look)]",
};

function LayerRow({
  node,
  depth,
  isRoot,
  selected,
  label,
  problem,
  drop,
}: {
  node: MapNode;
  depth: number;
  isRoot: boolean;
  selected: boolean;
  label: string;
  problem: boolean;
  drop: Zone | null;
}) {
  const { ref: dragRef, handleRef, isDragSource } = useDraggable({ id: node.key });
  return (
    <TreeItemLabel
      data-layer={node.key}
      ref={(el: HTMLElement | null) => {
        if (!isRoot) dragRef(el);
      }}
      className={[
        "flex cursor-default items-center gap-1.5 border-2 py-0.5 pr-2 text-sm",
        selected ? "border-ink bg-ink text-paper" : "border-transparent hover:border-border",
        node.hidden || isDragSource ? "opacity-50" : "",
        drop ? DROP_LINE[drop] : "",
      ].join(" ")}
      style={{ paddingLeft: `${depth * 14 + 4}px` }}
    >
      {isRoot ? (
        <span className="w-3" />
      ) : (
        <button
          type="button"
          ref={handleRef}
          aria-label={`Move ${node.key}`}
          className="w-3 cursor-grab text-xs text-muted active:cursor-grabbing"
        >
          <span aria-hidden="true">⋮</span>
        </button>
      )}
      <TreeItemIndicator className="w-3 text-xs text-muted">
        {node.children?.length ? "▾" : ""}
      </TreeItemIndicator>
      <span className="truncate">{node.key}</span>
      <span
        className={["ml-auto shrink-0 text-xs", selected ? "text-paper/70" : "text-muted"].join(
          " ",
        )}
      >
        {label}
      </span>
      {problem ? (
        <span className="shrink-0 text-xs text-danger" aria-label="Could not be built">
          !
        </span>
      ) : null}
    </TreeItemLabel>
  );
}

/**
 * The tree's layers in build order, top to bottom, which is the order they
 * draw in: a later row draws over an earlier one. A row is dragged by its
 * handle and dropped beside or inside another; the root stays where it is.
 */
export function LayersPanel({
  root,
  components,
  selected,
  onSelect,
  expanded,
  onExpandedChange,
  problems,
  onMove,
}: {
  root: MapNode;
  components: ComponentRegistry;
  selected: string | null;
  onSelect: (key: string | null) => void;
  expanded: string[];
  onExpandedChange: (expanded: string[]) => void;
  problems: ReadonlySet<string>;
  onMove: (key: string, parent: string, index: number) => void;
}) {
  const spots = useMemo(() => spotsOf(root), [root]);
  const [drop, setDrop] = useState<{ key: string; zone: Zone } | null>(null);

  const item = (node: MapNode, depth: number): ReactNode => (
    <TreeItem key={node.key} value={node.key} label={node.key}>
      <LayerRow
        node={node}
        depth={depth}
        isRoot={node === root}
        selected={node.key === selected}
        label={components[node.type]?.label ?? node.type}
        problem={problems.has(node.key)}
        drop={drop?.key === node.key ? drop.zone : null}
      />
      {node.children?.length ? (
        <TreeGroup>{node.children.map((child) => item(child, depth + 1))}</TreeGroup>
      ) : null}
    </TreeItem>
  );

  return (
    <DragDropProvider
      onDragMove={(event) => {
        const { x, y } = event.operation.position.current;
        const at = dropAt(x, y, root.key);
        setDrop(at && at.key !== String(event.operation.source?.id) ? at : null);
      }}
      onDragEnd={(event) => {
        setDrop(null);
        const { source, position } = event.operation;
        const at = dropAt(position.current.x, position.current.y, root.key);
        if (event.canceled || !source || !at || at.key === String(source.id)) return;
        const { key, zone } = at;
        const spot = spots.get(key);
        if (!spot) return;
        if (zone === "inside") {
          onMove(String(source.id), key, spot.children);
          if (!expanded.includes(key)) onExpandedChange([...expanded, key]);
        } else if (spot.parent) {
          onMove(String(source.id), spot.parent, spot.index + (zone === "after" ? 1 : 0));
        }
      }}
    >
      <Tree
        aria-label="Layers"
        className="flex flex-col gap-px outline-none"
        value={selected}
        onValueChange={(value) => onSelect(value)}
        expanded={expanded}
        onExpandedChange={(next) => onExpandedChange(next)}
        expandOnPress={false}
      >
        {item(root, 0)}
      </Tree>
      {/**
       * With an overlay to drag, dnd-kit leaves the row where React rendered
       * it. Without one it lifts the row itself out of the list, and the
       * re-render after a drop finds the DOM rearranged under it.
       */}
      <DragOverlay dropAnimation={null}>
        {(source) => (
          <div className="border-2 border-ink bg-paper px-2 py-0.5 text-sm shadow-hard">
            {String(source.id)}
          </div>
        )}
      </DragOverlay>
    </DragDropProvider>
  );
}
