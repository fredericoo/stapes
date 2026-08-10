import { useMemo, useRef, useState, type RefObject } from "react";
import { IconSettings, IconTrash } from "@tabler/icons-react";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import type { Direction, PlacedTile, TileDef, TilesetDef } from "../lib/types";
import { getStack, listChannels } from "../lib/mapData";
import { resolveEmit, resolveReceive } from "../lib/interactions";
import { useEditorStore } from "../editor/store";
import { Button, Segmented, Tooltip } from "../ui";
import { PlacementSettingsDialog } from "./PlacementSettingsDialog";
import { TilePreview } from "./TilePreview";

type Props = {
  stack: PlacedTile[];
  tilesById: Record<string, TileDef>;
  tilesets: TilesetDef[];
};

/** Shared across every row, so one datalist backs all the channel inputs. */
const CHANNEL_LIST_ID = "stack-signal-channels";

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
    type: "simple",
    attributes: {},
    sprite: { frames: [] },
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

/**
 * Does this tile have anything to say to a signal channel? Only wired-capable
 * tiles get a channel field — a channel on a rock is a control that can never
 * do anything, on every row of every stack.
 */
function isWired(def: TileDef): boolean {
  return resolveEmit(def) != null || resolveReceive(def) != null;
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
  const [settingsOpen, setSettingsOpen] = useState(false);

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
        {def.type === "directional" ? (
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
        {/* What the placement carries, rather than the fields themselves: the
            row says a wire and a description are set, and the dialog is where
            they are read and changed. */}
        {placed.channel || placed.description ? (
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted">
            {/* The channel keeps its width and the description gives way: a
                wire name truncated to "⌁…" tells you nothing, while a clipped
                first few words of prose still says which sign this is. */}
            {placed.channel ? (
              <span className="shrink-0">⌁ {placed.channel}</span>
            ) : null}
            {placed.description ? (
              <span className="min-w-0 truncate" title={placed.description}>
                ❝ {placed.description}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <Tooltip content={`Settings for ${def.name}`}>
        <Button
          size="icon"
          variant="ghost"
          aria-label={`Settings for ${def.name}`}
          className="text-muted hover:text-ink"
          onClick={() => setSettingsOpen(true)}
        >
          <IconSettings size={16} aria-hidden="true" />
        </Button>
      </Tooltip>
      <Tooltip content={`Remove ${def.name}`}>
        <Button
          size="icon"
          variant="ghost"
          aria-label={`Remove ${def.name} from stack`}
          className="text-muted hover:text-danger"
          onClick={() => {
            useEditorStore.getState().removeFromStack(stackIndex);
            focusAfterRemove();
          }}
        >
          <IconTrash size={16} aria-hidden="true" />
        </Button>
      </Tooltip>
      {/* Mounted only while open, which is what lets the dialog seed its fields
          from the map with `useState` and no re-sync effect. */}
      {settingsOpen ? (
        <PlacementSettingsDialog
          placed={placed}
          def={def}
          stackIndex={stackIndex}
          wired={isWired(def)}
          channelListId={CHANNEL_LIST_ID}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </li>
  );
}

export function SelectedStackList({ stack, tilesById, tilesets }: Props) {
  const rows = useMemo(() => toDisplayRows(stack), [stack]);
  const listRef = useRef<HTMLUListElement>(null);
  const stackLengthAtRender = stack.length;
  const map = useEditorStore((s) => s.map);
  const channels = useMemo(() => listChannels(map), [map]);

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
      <datalist id={CHANNEL_LIST_ID}>
        {channels.map((channel) => (
          <option key={channel} value={channel} />
        ))}
      </datalist>
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
