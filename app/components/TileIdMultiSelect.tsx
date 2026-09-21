import { useMemo, useState, type ReactNode } from "react";
import type { TileDef, TilesetDef } from "../lib/types";
import { FieldLabel, Input, ScrollArea } from "../ui";
import { TilePreview } from "./TilePreview";

const PREVIEW_SIZE_PX = 24;

/**
 * A searchable list of tiles, and nothing about what picking one means.
 *
 * Split out of {@link TileIdMultiSelect} because a second field wanted the same
 * list with different semantics: contents are a *list* with repeats and counts,
 * not a set of ids, so the chips and the toggle above did not fit — but the
 * hundreds-of-tiles problem and its answer are identical either way.
 *
 * `selectedIds` only marks rows. Whether picking an already-marked tile adds,
 * removes or does nothing is the caller's rule.
 */
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
  /** Names the list for a screen reader; the visible caption is the caller's. */
  label: string;
  /** Rows to mark as chosen, or none when choosing does not mark a row. */
  selectedIds?: ReadonlySet<string>;
  multiselectable?: boolean;
  /**
   * What activating a row means, and therefore what the rows *are*.
   *
   * "select" is a set the rows belong to, which is a listbox: a row is an
   * option and carries whether it is chosen. "add" is an action that leaves the
   * row exactly as it was — a contents list holds repeats, so there is no row
   * state for `aria-selected` to be about, and announcing one would promise a
   * selection that never changes however many times it is clicked.
   */
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
        // Named as well as placeheld: the placeholder is gone the moment
        // anybody types, and a box whose only name was its placeholder is a box
        // with no name for the rest of the session.
        aria-label={`Search tiles to ${label.toLowerCase()}`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search tiles"
      />

      <ScrollArea className="h-40 border-2 border-border bg-panel">
        <div
          // A group rather than a list of items when these are actions: the
          // rows stay buttons, which is what they do, and nothing promises a
          // selection to read back.
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
  /** What the engine does with the pick — the caption's tooltip. */
  info?: ReactNode;
  /** Shown when nothing is selected, to say what "none" means. */
  emptyHint: string;
  /** When true, picking a tile replaces the current selection (radio). */
  single?: boolean;
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
