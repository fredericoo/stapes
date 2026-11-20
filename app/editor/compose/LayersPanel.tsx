import { Tree, TreeGroup, TreeItem, TreeItemIndicator, TreeItemLabel } from "@ui-sdk/react/tree";
import type { ReactNode } from "react";
import type { ComponentRegistry } from "./build";
import type { MapNode } from "./doc";

export function branchKeys(node: MapNode): string[] {
  if (!node.children?.length) return [];
  return [node.key, ...node.children.flatMap(branchKeys)];
}

/**
 * The tree's layers in build order, top to bottom, which is the order they
 * draw in: a later row draws over an earlier one.
 */
export function LayersPanel({
  root,
  components,
  selected,
  onSelect,
  expanded,
  onExpandedChange,
  problems,
  row,
}: {
  root: MapNode;
  components: ComponentRegistry;
  selected: string | null;
  onSelect: (key: string | null) => void;
  expanded: string[];
  onExpandedChange: (expanded: string[]) => void;
  problems: ReadonlySet<string>;
  row?: (node: MapNode, label: ReactNode) => ReactNode;
}) {
  const item = (node: MapNode, depth: number): ReactNode => {
    const label = (
      <TreeItemLabel
        className={[
          "flex cursor-default items-center gap-1.5 border-2 py-0.5 pr-2 text-sm",
          node.key === selected
            ? "border-ink bg-ink text-paper"
            : "border-transparent hover:border-border",
          node.hidden ? "opacity-50" : "",
        ].join(" ")}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
      >
        <TreeItemIndicator className="w-3 text-xs text-muted">
          {node.children?.length ? "▾" : ""}
        </TreeItemIndicator>
        <span className="truncate">{node.key}</span>
        <span
          className={[
            "ml-auto shrink-0 text-xs",
            node.key === selected ? "text-paper/70" : "text-muted",
          ].join(" ")}
        >
          {components[node.type]?.label ?? node.type}
        </span>
        {problems.has(node.key) ? (
          <span className="shrink-0 text-xs text-danger" aria-label="Could not be built">
            !
          </span>
        ) : null}
      </TreeItemLabel>
    );
    return (
      <TreeItem key={node.key} value={node.key} label={node.key}>
        {row ? row(node, label) : label}
        {node.children?.length ? (
          <TreeGroup>{node.children.map((child) => item(child, depth + 1))}</TreeGroup>
        ) : null}
      </TreeItem>
    );
  };

  return (
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
  );
}
