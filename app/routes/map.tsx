import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import type { Route } from "./+types/map";
import { AppShell } from "../components/AppShell";
import { SelectedStackList } from "../components/SelectedStackList";
import { TilePreview } from "../components/TilePreview";
import { MapCanvas } from "../editor/MapCanvas";
import { useEditorStore, type ToolId } from "../editor/store";
import { getStack } from "../lib/mapData";
import { readMap, readTiles, readTilesets, writeMap } from "../lib/fs.server";
import type { MapFile } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL, clampLevel } from "../lib/types";
import { Button, Input, Panel, useToast } from "../ui";

export async function loader() {
  const [map, tiles, tilesets] = await Promise.all([
    readMap(),
    readTiles(),
    readTilesets(),
  ]);
  return { map, tiles, tilesets };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const raw = String(form.get("map") ?? "");
  try {
    const map = JSON.parse(raw) as MapFile;
    if (map.version !== 1) {
      return { ok: false, error: "Unsupported map version" };
    }
    await writeMap(map);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to save",
    };
  }
}

const TOOLS: Array<{ id: ToolId; label: string; key: string }> = [
  { id: "select", label: "Select", key: "V" },
  { id: "erase", label: "Erase", key: "E" },
  { id: "pencil", label: "Pencil", key: "B" },
  { id: "rect", label: "Rect", key: "R" },
  { id: "circle", label: "Circle", key: "C" },
];

export default function MapPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const { show: showToast } = useToast();

  const map = useEditorStore((s) => s.map);
  const dirty = useEditorStore((s) => s.dirty);
  const currentLevel = useEditorStore((s) => s.currentLevel);
  const showOtherLevels = useEditorStore((s) => s.showOtherLevels);
  const tool = useEditorStore((s) => s.tool);
  const selected = useEditorStore((s) => s.selected);
  const hover = useEditorStore((s) => s.hover);
  const zoom = useEditorStore((s) => s.zoom);
  const armedTileId = useEditorStore((s) => s.armedTileId);
  const tilesById = useEditorStore((s) => s.tilesById);
  const lastToast = useEditorStore((s) => s.lastToast);

  const [levelDraft, setLevelDraft] = useState(String(currentLevel));
  const [search, setSearch] = useState("");
  const handledSaveData = useRef<unknown>(null);

  useLayoutEffect(() => {
    useEditorStore.getState().hydrate(data.map, data.tiles);
  }, [data.map, data.tiles]);

  useEffect(() => {
    setLevelDraft(String(currentLevel));
  }, [currentLevel]);

  useEffect(() => {
    if (!lastToast) return;
    showToast(lastToast);
    useEditorStore.getState().clearToast();
  }, [lastToast, showToast]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useEditorStore.getState().dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        const fd = new FormData();
        fd.set("map", JSON.stringify(useEditorStore.getState().map));
        fetcher.submit(fd, { method: "post" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fetcher]);

  useEffect(() => {
    if (!fetcher.data || handledSaveData.current === fetcher.data) return;
    handledSaveData.current = fetcher.data;
    if (fetcher.data.ok) {
      useEditorStore.getState().markSaved();
      showToast("Map saved");
    } else {
      showToast("Save failed", fetcher.data.error);
    }
  }, [fetcher.data, showToast]);

  const save = () => {
    const fd = new FormData();
    fd.set("map", JSON.stringify(useEditorStore.getState().map));
    fetcher.submit(fd, { method: "post" });
  };

  // Tile picker always reads from loader data — not the editor store —
  // so the library is visible on first paint / first visit to /map.
  const filteredTiles = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return data.tiles;
    return data.tiles.filter(
      (t) => t.name.toLowerCase().includes(q) || t.id.includes(q),
    );
  }, [data.tiles, search]);

  const stack = selected
    ? getStack(map, selected.x, selected.y, currentLevel)
    : [];

  return (
    <AppShell
      trailing={
        <>
          <div className="flex items-center gap-1">
            <span className="text-xs uppercase text-paper/70">Level</span>
            <Input
              className="w-14 bg-paper text-ink shadow-none"
              value={levelDraft}
              onChange={(e) => setLevelDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const n = Number(levelDraft);
                  if (!Number.isNaN(n)) {
                    useEditorStore.getState().setLevel(clampLevel(n));
                  }
                }
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              className="text-paper"
              onClick={() =>
                useEditorStore
                  .getState()
                  .setLevel(Math.max(MIN_LEVEL, currentLevel - 1))
              }
            >
              −
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-paper"
              onClick={() =>
                useEditorStore
                  .getState()
                  .setLevel(Math.min(MAX_LEVEL, currentLevel + 1))
              }
            >
              +
            </Button>
          </div>
          <label className="flex items-center gap-1 text-xs text-paper">
            <input
              type="checkbox"
              checked={showOtherLevels}
              onChange={(e) =>
                useEditorStore.getState().setShowOtherLevels(e.target.checked)
              }
              className="accent-accent"
            />
            Show other levels
          </label>
          <div className="flex gap-1">
            {TOOLS.map((t) => (
              <Button
                key={t.id}
                size="sm"
                variant="ghost"
                active={tool === t.id}
                className={tool === t.id ? "" : "text-paper"}
                title={`${t.label} (${t.key})`}
                onClick={() => useEditorStore.getState().setTool(t.id)}
              >
                {t.label}
              </Button>
            ))}
          </div>
          <Button
            size="sm"
            variant="primary"
            onClick={save}
            disabled={fetcher.state !== "idle"}
          >
            Save{dirty ? " *" : ""}
          </Button>
        </>
      }
    >
      <div className="flex h-full min-h-0">
        <aside className="flex w-64 shrink-0 flex-col border-r-2 border-border bg-panel">
          <Panel title="Tile picker" className="border-0 shadow-none">
            <div className="p-2">
              <Input
                placeholder="Search…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="mb-2 w-full"
              />
              <div className="grid max-h-48 grid-cols-3 gap-1 overflow-auto">
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
                      tilesets={data.tilesets}
                      size={40}
                    />
                    <span className="truncate text-[10px]">{tile.name}</span>
                  </button>
                ))}
              </div>
            </div>
          </Panel>

          <Panel
            title={
              selected
                ? `Selected ${selected.x},${selected.y}`
                : "No selection"
            }
            className="min-h-0 flex-1 border-0 border-t-2 shadow-none"
          >
            <div className="h-full overflow-auto p-2">
              {!selected ? (
                <p className="text-xs text-muted">
                  Use Select (V) and click a coordinate.
                </p>
              ) : stack.length === 0 ? (
                <p className="text-xs text-muted">
                  No tiles at {selected.x},{selected.y}
                </p>
              ) : (
                <SelectedStackList
                  stack={stack}
                  tilesById={tilesById}
                  tilesets={data.tilesets}
                />
              )}
            </div>
          </Panel>
        </aside>

        <div className="relative min-w-0 flex-1">
          <MapCanvas tilesets={data.tilesets} tiles={data.tiles} />
          <div className="pointer-events-none absolute right-2 bottom-2 border-2 border-border bg-paper/90 px-2 py-1 text-xs shadow-hard">
            {hover ? `${hover.x},${hover.y}` : "—"} · z{currentLevel} · ×{zoom}
            {tool !== "select" && !selected && tool !== "erase" ? (
              <span className="text-danger"> · no source selected</span>
            ) : null}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
