import { useMemo, useRef, useState, type RefObject } from "react";
import { IconSettings, IconTrash } from "@tabler/icons-react";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import type { Direction, PlacedTile, TileDef, TilesetDef } from "../lib/types";
import { isDirectional } from "../lib/types";
import { elevationAt, getStack, listChannels } from "../lib/mapData";
import { footRange } from "../lib/validation";
import {
  resolveEmit,
  resolveReceive,
  resolveRewardDef,
  resolveTeleportDef,
} from "../lib/interactions";
import { resolveContainer, resolveItem } from "../lib/item";
import { variantKeys } from "../lib/variant";
import { useEditorStore } from "../editor/store";
import { Button, Segmented, Tooltip } from "../ui";
import { PlacementSettingsDialog } from "./PlacementSettingsDialog";
import { TilePreview } from "./TilePreview";

type Props = {
  stack: PlacedTile[];
  tilesById: Record<string, TileDef>;
  tilesets: TilesetDef[];
};

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
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: "", x: 0, y: 0 },
    sprite: { frames: [] },
  };
}

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

function isWired(def: TileDef): boolean {
  return resolveEmit(def) != null || resolveReceive(def) != null;
}

function isGiver(def: TileDef): boolean {
  return resolveRewardDef(def) != null;
}

function needsDestination(def: TileDef): boolean {
  return resolveTeleportDef(def)?.destination.kind === "absolute";
}

function isGiveable(def: TileDef): boolean {
  return resolveItem(def) != null && resolveContainer(def) == null;
}

function holdsCount(def: TileDef): number | null {
  return resolveContainer(def)?.size ?? null;
}

function isStowable(def: TileDef): boolean {
  return resolveItem(def) != null && resolveContainer(def) == null;
}

function footChoice(
  stack: PlacedTile[],
  stackIndex: number,
  tilesById: Record<string, TileDef>,
): { value: number; resting: number; options: number[] } | null {
  const { min, max } = footRange(stack, stackIndex, tilesById);
  if (max <= min) return null;
  const options: number[] = [];
  for (let foot = min; foot <= max; foot++) options.push(foot);
  return { value: elevationAt(stack, stackIndex, tilesById), resting: min, options };
}

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
  foot,
  giveable,
  stowable,
  tilesById,
  tilesets,
  listRef,
}: {
  id: string;
  index: number;
  total: number;
  stackIndex: number;
  placed: PlacedTile;
  def: TileDef;
  foot: ReturnType<typeof footChoice>;
  giveable: TileDef[];
  stowable: TileDef[];
  tilesById: Record<string, TileDef>;
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
        variantKey={placed.variant}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-bold">{def.name}</div>
        <div className="text-[10px] text-muted">h{def.height}</div>
        {isDirectional(def) ? (
          <Segmented<Direction>
            size="sm"
            ariaLabel={`Direction for ${def.name}`}
            value={placed.direction ?? "s"}
            onChange={(d) => useEditorStore.getState().setStackDirection(stackIndex, d)}
            options={[
              { value: "n", label: "N" },
              { value: "e", label: "E" },
              { value: "s", label: "S" },
              { value: "w", label: "W" },
            ]}
          />
        ) : null}
        {def.type === "variant" ? (
          <div
            role="listbox"
            aria-label={`Face for ${def.name}`}
            className="mt-1 flex flex-wrap items-start gap-1"
          >
            {variantKeys(def).map((key) => {
              const active = (placed.variant ?? variantKeys(def)[0]) === key;
              return (
                <button
                  key={key}
                  type="button"
                  role="option"
                  aria-selected={active}
                  aria-label={key}
                  title={key}
                  onClick={() => useEditorStore.getState().setStackVariant(stackIndex, key)}
                  className={[
                    "border-2 p-0.5",
                    active ? "border-accent bg-paper" : "border-border bg-panel hover:border-ink",
                  ].join(" ")}
                >
                  <TilePreview
                    tile={def}
                    tilesets={tilesets}
                    size={20}
                    variantKey={key}
                    chrome={false}
                    still
                  />
                </button>
              );
            })}
          </div>
        ) : null}
        {foot ? (
          <div className="mt-1 flex items-center gap-1">
            <span className="text-[10px] font-bold uppercase text-muted">Foot</span>
            <Segmented<number>
              size="sm"
              ariaLabel={`Foot elevation for ${def.name}`}
              value={foot.value}
              onChange={(value) =>
                useEditorStore
                  .getState()
                  .setStackFoot(stackIndex, value === foot.resting ? null : value)
              }
              options={foot.options.map((value) => ({
                value,
                label: String(value),
              }))}
            />
          </div>
        ) : null}
        {placed.channel || placed.rewardTag || placed.contents?.length || placed.inscription ? (
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted">
            {placed.channel ? <span className="shrink-0">⌁ {placed.channel}</span> : null}
            {placed.rewardTag ? (
              <span className="shrink-0">
                ⛁ {placed.rewardTag}
                {placed.rewardTileIds?.length ? ` ×${placed.rewardTileIds.length}` : ""}
              </span>
            ) : null}
            {placed.contents?.length ? (
              <span className="shrink-0">
                <span className="sr-only">Holds </span>
                <span aria-hidden="true">▤ </span>
                {placed.contents.length}
              </span>
            ) : null}
            {placed.inscription ? (
              <span className="min-w-0 truncate" title={placed.inscription}>
                ❝ {placed.inscription}
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
      {settingsOpen ? (
        <PlacementSettingsDialog
          placed={placed}
          def={def}
          stackIndex={stackIndex}
          wired={isWired(def)}
          gives={isGiver(def)}
          teleports={needsDestination(def)}
          holds={holdsCount(def)}
          giveable={giveable}
          stowable={stowable}
          tilesById={tilesById}
          tilesets={tilesets}
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
  const giveable = useMemo(() => Object.values(tilesById).filter(isGiveable), [tilesById]);
  const stowable = useMemo(() => Object.values(tilesById).filter(isStowable), [tilesById]);

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
          const def = tilesById[row.placed.tileId] ?? missingTile(row.placed.tileId);
          return (
            <SortableStackItem
              key={row.id}
              id={row.id}
              index={displayIdx}
              total={rows.length}
              stackIndex={row.stackIndex}
              placed={row.placed}
              def={def}
              foot={footChoice(stack, row.stackIndex, tilesById)}
              giveable={giveable}
              stowable={stowable}
              tilesById={tilesById}
              tilesets={tilesets}
              listRef={listRef}
            />
          );
        })}
      </ul>
    </DragDropProvider>
  );
}
