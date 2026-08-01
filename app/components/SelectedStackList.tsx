import { useMemo, useRef, type RefObject } from "react";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import type { Direction, PlacedTile, TileDef, TilesetDef } from "../lib/types";
import { getStack } from "../lib/mapData";
import { useEditorStore } from "../editor/store";
import { Button, Segmented } from "../ui";
import { TilePreview } from "./TilePreview";

type Props = {
  stack: PlacedTile[];
  tilesById: Record<string, TileDef>;
  tilesets: TilesetDef[];
};

type StackRow = {
  id: string;
  placed: PlacedTile;
  stackIndex: number;
};

function missingTile(tileId: string): TileDef {
  return {
    id: tileId,
    name: "(missing)",
    height: 0,
    directional: false,
    variants: {},
    attributes: {},
  };
}

/**
 * Sortable ids for the current stack snapshot.
 * Occurrence counters are position-based (fine without per-placement identity).
 * Direction is omitted so changing N/E/S/W does not remount the row.
 */
function toDisplayRows(stack: PlacedTile[]): StackRow[] {
  const seen = new Map<string, number>();
  const ids = stack.map((placed) => {
    const n = seen.get(placed.tileId) ?? 0;
    seen.set(placed.tileId, n + 1);
    return `${placed.tileId}#${n}`;
  });

  return [...stack].reverse().map((placed, displayIdx) => {
    const stackIndex = stack.length - 1 - displayIdx;
    return { id: ids[stackIndex]!, placed, stackIndex };
  });
}

/** Display is top-first; store reorder uses bottom-first stack indices. */
function displayIndexToStackIndex(displayIndex: number, length: number): number {
  return length - 1 - displayIndex;
}

function SortableStackItem({
  id,
  index,
  total,
  stackIndex,
  placed,
  def,
  tilesets,
  listRef,
}: {
  id: string;
  index: number;
  total: number;
  stackIndex: number;
  placed: PlacedTile;
  def: TileDef;
  tilesets: TilesetDef[];
  listRef: RefObject<HTMLUListElement | null>;
}) {
  const { ref, handleRef, isDragging } = useSortable({ id, index });

  const focusAfterRemove = () => {
    requestAnimationFrame(() => {
      const handles = listRef.current?.querySelectorAll<HTMLElement>(
        'button[aria-roledescription="draggable"], button[aria-label^="Drag to reorder"]',
      );
      if (handles && handles.length > 0) {
        const next = handles[Math.min(index, handles.length - 1)];
        next?.focus();
        return;
      }
      listRef.current?.focus();
    });
  };

  return (
    <li
      ref={ref}
      className={[
        "flex items-center gap-2 border-2 border-border bg-paper p-1",
        isDragging ? "opacity-60" : "",
      ].join(" ")}
    >
      <button
        type="button"
        ref={handleRef}
        aria-label={`Drag to reorder ${def.name} (${index + 1} of ${total})`}
        className="cursor-grab px-1 text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:cursor-grabbing"
      >
        <span aria-hidden="true">⋮⋮</span>
      </button>
      <TilePreview
        tile={def}
        tilesets={tilesets}
        size={24}
        direction={placed.direction}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-bold">{def.name}</div>
        <div className="text-[10px] text-muted">h{def.height}</div>
        {def.directional ? (
          <Segmented<Direction>
            size="sm"
            ariaLabel={`Direction for ${def.name}`}
            value={placed.direction ?? "s"}
            onChange={(d) =>
              useEditorStore.getState().setStackDirection(stackIndex, d)
            }
            options={[
              { value: "n", label: "N" },
              { value: "e", label: "E" },
              { value: "s", label: "S" },
              { value: "w", label: "W" },
            ]}
          />
        ) : null}
      </div>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Remove ${def.name} from stack`}
        onClick={() => {
          useEditorStore.getState().removeFromStack(stackIndex);
          focusAfterRemove();
        }}
      >
        <span aria-hidden="true">✕</span>
      </Button>
    </li>
  );
}

export function SelectedStackList({ stack, tilesById, tilesets }: Props) {
  const rows = useMemo(() => toDisplayRows(stack), [stack]);
  const listRef = useRef<HTMLUListElement>(null);
  const stackLengthAtRender = stack.length;

  return (
    <DragDropProvider
      onDragEnd={(event) => {
        if (event.canceled) return;
        const { source } = event.operation;
        if (!isSortable(source)) return;

        const { initialIndex, index } = source;
        if (initialIndex === index) return;

        const store = useEditorStore.getState();
        const { map, selected, currentLevel } = store;
        if (!selected) return;

        const current = getStack(map, selected.x, selected.y, currentLevel);
        if (current.length !== stackLengthAtRender) return;

        const from = displayIndexToStackIndex(initialIndex, current.length);
        const to = displayIndexToStackIndex(index, current.length);
        store.reorderSelectedStack(from, to);
      }}
    >
      <ul
        ref={listRef}
        tabIndex={-1}
        className="flex flex-col gap-1 outline-none"
        aria-label="Tile stack, top first"
      >
        {rows.map((row, displayIdx) => {
          const def =
            tilesById[row.placed.tileId] ?? missingTile(row.placed.tileId);
          return (
            <SortableStackItem
              key={row.id}
              id={row.id}
              index={displayIdx}
              total={rows.length}
              stackIndex={row.stackIndex}
              placed={row.placed}
              def={def}
              tilesets={tilesets}
              listRef={listRef}
            />
          );
        })}
      </ul>
    </DragDropProvider>
  );
}
