import { useMemo, useState } from "react";
import { TilePreview } from "../../components/TilePreview";
import { variantKeys } from "../../lib/variant";
import { Input, useToast } from "../../ui";
import { useEditorStore } from "../store";
import { useMapAssets } from "./MapAssetsContext";

export function TilePickerPanel() {
  const { tiles, tilesets } = useMapAssets();
  const { show: showToast } = useToast();
  const armedTileId = useEditorStore((s) => s.armedTileId);
  const armedVariant = useEditorStore((s) => s.armedVariant);
  const [search, setSearch] = useState("");

  const armedTile = tiles.find((t) => t.id === armedTileId);
  const armedFaces = armedTile?.type === "variant" ? variantKeys(armedTile) : [];

  const filteredTiles = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tiles;
    return tiles.filter((t) => t.name.toLowerCase().includes(q) || t.id.includes(q));
  }, [tiles, search]);

  return (
    <div className="flex min-h-0 flex-1 flex-col p-2">
      <Input
        placeholder="Search…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="mb-2 w-full"
      />
      <div className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(64px,1fr))] content-start gap-1 overflow-auto">
        {filteredTiles.map((tile) => (
          <button
            key={tile.id}
            type="button"
            title={tile.name}
            onClick={() => {
              const store = useEditorStore.getState();
              store.setArmedTileId(tile.id);
              if (store.selected) {
                const r = store.appendArmed();
                if (!r.ok && r.reason) showToast(r.reason);
              }
            }}
            className={[
              "flex flex-col items-center gap-1 border-2 p-1",
              armedTileId === tile.id
                ? "border-accent bg-paper"
                : "border-transparent hover:border-border hover:bg-paper",
            ].join(" ")}
          >
            <TilePreview
              tile={tile}
              tilesets={tilesets}
              size={40}
              variantKey={tile.id === armedTileId ? (armedVariant ?? undefined) : undefined}
            />
            <span className="max-w-full truncate text-[10px]">{tile.name}</span>
          </button>
        ))}
      </div>
      {armedFaces.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1 border-t-2 border-border pt-2">
          <span className="text-xs font-bold uppercase text-muted">Face for {armedTile!.name}</span>
          <div
            className="flex flex-wrap items-center gap-1"
            role="listbox"
            aria-label={`Face for ${armedTile!.name}`}
          >
            {armedFaces.map((key) => {
              const active = (armedVariant ?? armedFaces[0]) === key;
              return (
                <button
                  key={key}
                  type="button"
                  role="option"
                  aria-selected={active}
                  title={key}
                  onClick={() => useEditorStore.getState().setArmedVariant(key)}
                  className={[
                    "flex flex-col items-center gap-0.5 border-2 p-0.5",
                    active ? "border-accent bg-paper" : "border-border bg-panel hover:border-ink",
                  ].join(" ")}
                >
                  <TilePreview
                    tile={armedTile!}
                    tilesets={tilesets}
                    size={32}
                    variantKey={key}
                    chrome={false}
                    still
                  />
                  <span className="max-w-[56px] truncate font-mono text-[9px] leading-none">
                    {key}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
