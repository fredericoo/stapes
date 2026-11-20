import { Popover } from "@base-ui/react/popover";
import { IconPlus, IconX } from "@tabler/icons-react";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { TilePreview } from "../../components/TilePreview";
import type { TileDef, TilesetDef } from "../../lib/types";
import { Input, NumberInput } from "../../ui";
import type { TileKind } from "./field";

export const TileCatalogue = createContext<{ tiles: TileDef[]; tilesets: TilesetDef[] }>({
  tiles: [],
  tilesets: [],
});

const MAX_SHOWN = 120;

function useOffered(kind: TileKind) {
  const { tiles } = useContext(TileCatalogue);
  return useMemo(() => tiles.filter((t) => kind.test(t)), [tiles, kind]);
}

function TileFace({ id, size = 24 }: { id: string; size?: number }) {
  const { tiles, tilesets } = useContext(TileCatalogue);
  const tile = tiles.find((t) => t.id === id) ?? null;
  return (
    <>
      <TilePreview tile={tile} tilesets={tilesets} size={size} chrome={false} still />
      <span className="min-w-0 truncate">{tile?.name ?? id}</span>
    </>
  );
}

/**
 * A button that opens a searchable grid of the tiles `kind` allows. The grid
 * shows only those tiles, so a house's door field cannot be given a tree.
 */
function TileGrid({
  kind,
  exclude = [],
  onPick,
  trigger,
  label,
}: {
  kind: TileKind;
  exclude?: readonly string[];
  onPick: (id: string) => void;
  trigger: ReactNode;
  label: string;
}) {
  const offered = useOffered(kind);
  const { tilesets } = useContext(TileCatalogue);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = offered
    .filter((t) => !exclude.includes(t.id))
    .filter((t) => !q || t.id.includes(q) || t.name.toLowerCase().includes(q));
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={label}
        className="flex min-w-0 items-center gap-1.5 border-2 border-border bg-paper px-1.5 py-0.5 text-left text-sm shadow-hard focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {trigger}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="start" className="z-50">
          <Popover.Popup className="flex w-80 flex-col gap-2 border-2 border-border bg-paper p-2 shadow-hard">
            <Input
              autoFocus
              aria-label={`Search ${kind.label}`}
              placeholder={`Search ${offered.length} tiles: ${kind.label}`}
              className="w-full shadow-none"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="grid max-h-72 grid-cols-4 gap-1 overflow-y-auto">
              {shown.slice(0, MAX_SHOWN).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  title={t.id}
                  className="flex flex-col items-center gap-0.5 border-2 border-transparent p-1 text-[10px] hover:border-border focus-visible:border-accent focus-visible:outline-none"
                  onClick={() => {
                    onPick(t.id);
                    setOpen(false);
                    setQuery("");
                  }}
                >
                  <TilePreview tile={t} tilesets={tilesets} size={36} still />
                  <span className="w-full truncate text-center">{t.name}</span>
                </button>
              ))}
            </div>
            {shown.length === 0 ? (
              <p className="text-sm text-muted">No {kind.label} matches.</p>
            ) : shown.length > MAX_SHOWN ? (
              <p className="text-xs text-muted">Showing {MAX_SHOWN}; search to narrow it.</p>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function TilePicker({
  value,
  kind,
  onChange,
  label,
}: {
  value: string;
  kind: TileKind;
  onChange: (id: string) => void;
  label: string;
}) {
  return <TileGrid kind={kind} onPick={onChange} label={label} trigger={<TileFace id={value} />} />;
}

export function TileSet({
  value,
  kind,
  onChange,
  label,
}: {
  value: string[];
  kind: TileKind;
  onChange: (ids: string[]) => void;
  label: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {value.map((id) => (
        <span
          key={id}
          className="flex max-w-full items-center gap-1 border-2 border-border bg-panel py-0.5 pl-1 text-xs"
        >
          <TileFace id={id} size={18} />
          <button
            type="button"
            aria-label={`Remove ${id}`}
            className="px-1 text-muted hover:text-ink"
            onClick={() => onChange(value.filter((v) => v !== id))}
          >
            <IconX size={12} aria-hidden="true" />
          </button>
        </span>
      ))}
      <TileGrid
        kind={kind}
        exclude={value}
        label={`Add to ${label}`}
        onPick={(id) => onChange([...value, id])}
        trigger={
          <>
            <IconPlus size={14} aria-hidden="true" />
            <span className="text-xs">Add</span>
          </>
        }
      />
    </div>
  );
}

type Weighted = Array<{ tile: string; weight: number }>;

/** Each tile's chance is its weight over the sum of the weights, shown beside it as a share. */
export function WeightedTiles({
  value,
  kind,
  onChange,
  label,
}: {
  value: Weighted;
  kind: TileKind;
  onChange: (value: Weighted) => void;
  label: string;
}) {
  const total = value.reduce((sum, w) => sum + w.weight, 0);
  const set = (i: number, next: Partial<Weighted[number]>) =>
    onChange(value.map((w, j) => (j === i ? { ...w, ...next } : w)));
  return (
    <div className="flex w-full flex-col gap-1">
      {value.map((w, i) => (
        <div key={`${w.tile}-${i}`} className="flex items-center gap-1">
          <TilePicker
            value={w.tile}
            kind={kind}
            label={`${label} ${i + 1}`}
            onChange={(tile) => set(i, { tile })}
          />
          <NumberInput
            aria-label={`${label} ${i + 1} weight`}
            className="w-14 shadow-none"
            min={0}
            value={w.weight}
            onChange={(weight) => set(i, { weight })}
          />
          <span className="w-9 text-right text-xs tabular-nums text-muted">
            {total > 0 ? `${Math.round((w.weight / total) * 100)}%` : "—"}
          </span>
          <button
            type="button"
            aria-label={`Remove ${w.tile}`}
            className="px-1 text-muted hover:text-ink"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <IconX size={12} aria-hidden="true" />
          </button>
        </div>
      ))}
      <TileGrid
        kind={kind}
        label={`Add to ${label}`}
        onPick={(tile) => onChange([...value, { tile, weight: 1 }])}
        trigger={
          <>
            <IconPlus size={14} aria-hidden="true" />
            <span className="text-xs">Add</span>
          </>
        }
      />
    </div>
  );
}
