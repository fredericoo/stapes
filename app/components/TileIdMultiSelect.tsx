import { useMemo, useState } from "react";
import type { TileDef, TilesetDef } from "../lib/types";
import { Input, ScrollArea } from "../ui";
import { TilePreview } from "./TilePreview";

const PREVIEW_SIZE_PX = 24;

type Props = {
  tiles: TileDef[];
  tilesets: TilesetDef[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  label: string;
  /** Shown when nothing is selected, to explain what "none" means. */
  emptyHint: string;
};

/**
 * Pick any number of tile ids. The library can run to hundreds of tiles, so
 * this is a searchable list rather than a grid, with the current picks pinned
 * above it as removable chips.
 */
export function TileIdMultiSelect({
  tiles,
  tilesets,
  selectedIds,
  onChange,
  label,
  emptyHint,
}: Props) {
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tiles;
    return tiles.filter(
      (t) =>
        t.id.toLowerCase().includes(q) || t.name.toLowerCase().includes(q),
    );
  }, [tiles, query]);

  const selected = new Set(selectedIds);
  const toggle = (id: string) => {
    const next = selected.has(id)
      ? selectedIds.filter((s) => s !== id)
      : [...selectedIds, id];
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <span className="font-bold uppercase text-muted">{label}</span>

      {selectedIds.length === 0 ? (
        <p className="text-[11px] leading-snug text-muted">{emptyHint}</p>
      ) : (
        <div className="flex flex-wrap gap-1">
          {selectedIds.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => toggle(id)}
              aria-label={`Remove ${id}`}
              className="border-2 border-border bg-ink px-1 py-0.5 font-mono text-[10px] text-paper hover:bg-danger"
            >
              {id} ×
            </button>
          ))}
        </div>
      )}

      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search tiles"
      />

      <ScrollArea className="h-40 border-2 border-border bg-panel">
        <div role="listbox" aria-multiselectable aria-label={label}>
          {matches.map((tile) => {
            const isSelected = selected.has(tile.id);
            return (
              <button
                key={tile.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => toggle(tile.id)}
                className={[
                  "flex w-full items-center gap-2 px-1.5 py-1 text-left",
                  isSelected ? "bg-accent text-paper" : "hover:bg-paper",
                ].join(" ")}
              >
                <TilePreview
                  tile={tile}
                  tilesets={tilesets}
                  size={PREVIEW_SIZE_PX}
                />
                <span className="truncate font-medium">{tile.name}</span>
                <span
                  className={[
                    "ml-auto shrink-0 font-mono text-[10px]",
                    isSelected ? "text-paper/70" : "text-muted",
                  ].join(" ")}
                >
                  {tile.id}
                </span>
              </button>
            );
          })}
          {matches.length === 0 ? (
            <p className="px-1.5 py-2 text-[11px] text-muted">
              No tiles match “{query}”.
            </p>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}
