import { useMemo, useState, type ReactNode } from "react";
import type { TileDef, TilesetDef } from "../lib/types";
import { FieldLabel, Input, ScrollArea } from "../ui";
import { TilePreview } from "./TilePreview";

const PREVIEW_SIZE_PX = 24;

export function TilePickList({
  tiles,
  tilesets,
  label,
  selectedIds,
  multiselectable = true,
  mode = "select",
  onPick,
}: {
  tiles: TileDef[];
  tilesets: TilesetDef[];
  label: string;
  selectedIds?: ReadonlySet<string>;
  multiselectable?: boolean;
  mode?: "select" | "add";
  onPick: (tileId: string) => void;
}) {
  const asListbox = mode === "select";
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tiles;
    return tiles.filter((t) => t.id.toLowerCase().includes(q) || t.name.toLowerCase().includes(q));
  }, [tiles, query]);

  return (
    <>
      <Input
        aria-label={`Search tiles to ${label.toLowerCase()}`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search tiles"
      />

      <ScrollArea className="h-40 border-2 border-border bg-panel">
        <div
          role={asListbox ? "listbox" : "group"}
          {...(asListbox ? { "aria-multiselectable": multiselectable } : {})}
          aria-label={label}
        >
          {matches.map((tile) => {
            const isSelected = selectedIds?.has(tile.id) ?? false;
            return (
              <button
                key={tile.id}
                type="button"
                {...(asListbox
                  ? { role: "option" as const, "aria-selected": isSelected }
                  : { "aria-label": `${label}: ${tile.name}` })}
                onClick={() => onPick(tile.id)}
                className={[
                  "flex w-full items-center gap-2 px-1.5 py-1 text-left",
                  isSelected ? "bg-accent text-paper" : "hover:bg-paper",
                ].join(" ")}
              >
                <TilePreview tile={tile} tilesets={tilesets} size={PREVIEW_SIZE_PX} />
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
            <p className="px-1.5 py-2 text-[11px] text-muted">No tiles match “{query}”.</p>
          ) : null}
        </div>
      </ScrollArea>
    </>
  );
}

type Props = {
  tiles: TileDef[];
  tilesets: TilesetDef[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  label: string;
  info?: ReactNode;
  emptyHint: string;
  single?: boolean;
};

export function TileIdMultiSelect({
  tiles,
  tilesets,
  selectedIds,
  onChange,
  label,
  info,
  emptyHint,
  single = false,
}: Props) {
  const selected = new Set(selectedIds);
  const toggle = (id: string) => {
    if (single) {
      onChange(selected.has(id) ? [] : [id]);
      return;
    }
    const next = selected.has(id) ? selectedIds.filter((s) => s !== id) : [...selectedIds, id];
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <FieldLabel info={info}>{label}</FieldLabel>

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

      <TilePickList
        tiles={tiles}
        tilesets={tilesets}
        label={label}
        selectedIds={selected}
        multiselectable={!single}
        onPick={toggle}
      />
    </div>
  );
}
