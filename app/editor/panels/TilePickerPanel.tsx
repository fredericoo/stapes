import { useMemo, useState } from "react";
import { TilePreview } from "../../components/TilePreview";
import { Input, useToast } from "../../ui";
import { useEditorStore } from "../store";
import { useMapAssets } from "./MapAssetsContext";

export function TilePickerPanel() {
  // Assets come from loader data — not the editor store — so the library is
  // visible on first paint / first visit to /map.
  const { tiles, tilesets } = useMapAssets();
  const { show: showToast } = useToast();
  const armedTileId = useEditorStore((s) => s.armedTileId);
  const [search, setSearch] = useState("");

  const filteredTiles = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tiles;
    return tiles.filter(
      (t) => t.name.toLowerCase().includes(q) || t.id.includes(q),
    );
  }, [tiles, search]);

  return (
    <div className="flex min-h-0 flex-1 flex-col p-2">
      <Input
        placeholder="Search…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="mb-2 w-full"
      />
      {/* Columns follow the panel width now that the sidebar is resizable. */}
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
            <TilePreview tile={tile} tilesets={tilesets} size={40} />
            <span className="truncate text-[10px]">{tile.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
