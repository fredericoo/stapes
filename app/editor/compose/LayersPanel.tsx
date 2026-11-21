import { Accessibility, defaultPreset } from "@dnd-kit/dom";
import { DragDropProvider, DragOverlay, PointerSensor, useDraggable } from "@dnd-kit/react";
import { Tree, TreeGroup, TreeItem, TreeItemIndicator, TreeItemLabel } from "@ui-sdk/react/tree";
import { IconEye, IconEyeOff } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

/**
 * Only the pointer drags a row. dnd-kit's keyboard sensor and accessibility
 * plugin would make every row a focusable button, taking the tree's single
 * tab stop and its Enter and Space.
 */
const DRAG_SENSORS = [PointerSensor];
const DRAG_PLUGINS = defaultPreset.plugins.filter((plugin) => plugin !== Accessibility);

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
  onHidden,
}: {
  node: MapNode;
  depth: number;
  isRoot: boolean;
  selected: boolean;
  label: string;
  problem: boolean;
  drop: Zone | null;
  onHidden: (hidden: boolean) => void;
}) {
  const { ref: dragRef, isDragSource } = useDraggable({ id: node.key });
  return (
    <TreeItemLabel
      data-layer={node.key}
      ref={isRoot ? undefined : dragRef}
      className={[
        "flex cursor-default items-center gap-1.5 border-2 py-0.5 pr-2 text-sm",
        selected ? "border-ink bg-ink text-paper" : "border-transparent hover:border-border",
        node.hidden || isDragSource ? "opacity-50" : "",
        drop ? DROP_LINE[drop] : "",
      ].join(" ")}
      style={{ paddingLeft: `${depth * 14 + 4}px` }}
    >
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
      <button
        type="button"
        aria-label={node.hidden ? `Show ${node.key}` : `Hide ${node.key}`}
        aria-pressed={node.hidden === true}
        className={[
          "shrink-0 hover:text-look",
          selected ? "text-paper/70" : "text-muted",
          node.hidden ? "" : "opacity-60 hover:opacity-100",
        ].join(" ")}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onHidden(!node.hidden);
        }}
      >
        {node.hidden ? (
          <IconEyeOff size={14} aria-hidden="true" />
        ) : (
          <IconEye size={14} aria-hidden="true" />
        )}
      </button>
    </TreeItemLabel>
  );
}

/**
 * The tree's layers in build order, top to bottom, which is the order they
 * draw in: a later row draws over an earlier one. A row is dragged from
 * anywhere on it and dropped beside or inside another, and with Alt held when
 * it is dropped a copy goes there instead; the root stays where it is. A
 * click selects one row, and Shift or ⌘ with a click selects several.
 */
export function LayersPanel({
  root,
  components,
  selection,
  onSelect,
  expanded,
  onExpandedChange,
  problems,
  onMove,
  onHidden,
}: {
  root: MapNode;
  components: ComponentRegistry;
  selection: readonly string[];
  onSelect: (keys: string[]) => void;
  expanded: string[];
  onExpandedChange: (expanded: string[]) => void;
  problems: ReadonlySet<string>;
  onMove: (key: string, parent: string, index: number, copy: boolean) => void;
  onHidden: (key: string, hidden: boolean) => void;
}) {
  const spots = useMemo(() => spotsOf(root), [root]);
  const [drop, setDrop] = useState<{ key: string; zone: Zone } | null>(null);
  /** dnd-kit's drag events carry no modifier keys, so Alt is followed from the window. */
  const alt = useRef(false);
  const held = useRef({ range: false, toggle: false });
  const anchor = useRef<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      alt.current = e.altKey;
      held.current = { range: e.shiftKey, toggle: e.metaKey || e.ctrlKey };
    };
    const onBlur = () => {
      alt.current = false;
      held.current = { range: false, toggle: false };
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const item = (node: MapNode, depth: number): ReactNode => (
    <TreeItem key={node.key} value={node.key} label={node.key}>
      <LayerRow
        node={node}
        depth={depth}
        isRoot={node === root}
        selected={selection.includes(node.key)}
        label={components[node.type]?.label ?? node.type}
        problem={problems.has(node.key)}
        drop={drop?.key === node.key ? drop.zone : null}
        onHidden={(hidden) => onHidden(node.key, hidden)}
      />
      {node.children?.length ? (
        <TreeGroup>{node.children.map((child) => item(child, depth + 1))}</TreeGroup>
      ) : null}
    </TreeItem>
  );

  return (
    <DragDropProvider
      sensors={DRAG_SENSORS}
      plugins={DRAG_PLUGINS}
      onBeforeDragStart={(event) => {
        const native = event.operation.activatorEvent;
        if (native && "altKey" in native) alt.current = (native as PointerEvent).altKey;
      }}
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
          onMove(String(source.id), key, spot.children, alt.current);
          if (!expanded.includes(key)) onExpandedChange([...expanded, key]);
        } else if (spot.parent) {
          onMove(
            String(source.id),
            spot.parent,
            spot.index + (zone === "after" ? 1 : 0),
            alt.current,
          );
        }
      }}
    >
      <Tree
        ref={treeRef}
        aria-label="Layers"
        className="flex flex-col gap-px outline-none"
        mode="multiple"
        value={[...selection]}
        onValueChange={(value) => {
          /**
           * With many selectable the tree toggles the pressed row and keeps
           * the rest, whatever keys are held. The pressed row is the one the
           * two lists differ by: alone it becomes the whole selection, with
           * ⌘ or Ctrl the toggle stands, and with Shift every row shown
           * between it and the last row pressed is selected.
           */
          const changed = [...value, ...selection].filter(
            (key) => value.includes(key) !== selection.includes(key),
          );
          const pressed = changed.length === 1 ? changed[0]! : null;
          if (!pressed || held.current.toggle) {
            if (pressed) anchor.current = pressed;
            onSelect(value);
            return;
          }
          if (!held.current.range) {
            anchor.current = pressed;
            onSelect([pressed]);
            return;
          }
          const rows = [
            ...(treeRef.current?.querySelectorAll<HTMLElement>("[data-layer]") ?? []),
          ].map((row) => row.dataset.layer!);
          const from = rows.indexOf(anchor.current ?? pressed);
          const to = rows.indexOf(pressed);
          onSelect(
            from < 0 || to < 0 ? value : rows.slice(Math.min(from, to), Math.max(from, to) + 1),
          );
        }}
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
