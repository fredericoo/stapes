import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconCircle,
  IconEraser,
  IconMinus,
  IconPencil,
  IconPlus,
  IconPointer,
  IconSquare,
  type TablerIcon,
} from "@tabler/icons-react";
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
import { Button, Input, Panel, Tooltip, useToast } from "../ui";

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

const TOOLS: Array<{
  id: ToolId;
  label: string;
  key: string;
  Icon: TablerIcon;
}> = [
  { id: "select", label: "Select", key: "V", Icon: IconPointer },
  { id: "erase", label: "Erase", key: "E", Icon: IconEraser },
  { id: "pencil", label: "Pencil", key: "B", Icon: IconPencil },
  { id: "rect", label: "Rect", key: "R", Icon: IconSquare },
  { id: "circle", label: "Circle", key: "C", Icon: IconCircle },
];

export default function MapPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const { show: showToast } = useToast();

  const map = useEditorStore((s) => s.map);
  const dirty = useEditorStore((s) => s.dirty);
  const currentLevel = useEditorStore((s) => s.currentLevel);
  const showOtherLevels = useEditorStore((s) => s.showOtherLevels);
  const previewMode = useEditorStore((s) => s.previewMode);
  const tool = useEditorStore((s) => s.tool);
  const selected = useEditorStore((s) => s.selected);
  const hover = useEditorStore((s) => s.hover);
  const zoom = useEditorStore((s) => s.zoom);
  const armedTileId = useEditorStore((s) => s.armedTileId);
  const tilesById = useEditorStore((s) => s.tilesById);
  const lastToast = useEditorStore((s) => s.lastToast);
  const canUndo = useEditorStore((s) => s.past.length > 0);
  const canRedo = useEditorStore((s) => s.future.length > 0);

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
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        const fd = new FormData();
        fd.set("map", JSON.stringify(useEditorStore.getState().map));
        fetcher.submit(fd, { method: "post" });
        return;
      }

      // Leave native text undo/redo alone in inputs.
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      ) {
        return;
      }

      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        useEditorStore.getState().undo();
        return;
      }
      if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        useEditorStore.getState().redo();
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
            <Tooltip content="Level down (,)">
              <Button
                size="icon"
                variant="ghost-inverse"
                aria-label="Level down"
                onClick={() =>
                  useEditorStore
                    .getState()
                    .setLevel(Math.max(MIN_LEVEL, currentLevel - 1))
                }
              >
                <IconMinus size={16} aria-hidden="true" />
              </Button>
            </Tooltip>
            <Tooltip content="Level up (.)">
              <Button
                size="icon"
                variant="ghost-inverse"
                aria-label="Level up"
                onClick={() =>
                  useEditorStore
                    .getState()
                    .setLevel(Math.min(MAX_LEVEL, currentLevel + 1))
                }
              >
                <IconPlus size={16} aria-hidden="true" />
              </Button>
            </Tooltip>
          </div>
          <label
            className={[
              "flex items-center gap-1 text-xs text-paper",
              previewMode ? "opacity-50" : "",
            ].join(" ")}
            title={
              previewMode ? "Preview shows every level" : "Show other levels"
            }
          >
            <input
              type="checkbox"
              checked={showOtherLevels}
              disabled={previewMode}
              onChange={(e) =>
                useEditorStore.getState().setShowOtherLevels(e.target.checked)
              }
              className="accent-accent"
            />
            Show other levels
          </label>
          <label
            className="flex items-center gap-1 text-xs text-paper"
            title="Preview (P) — every level at full opacity, no grid or selection"
          >
            <input
              type="checkbox"
              checked={previewMode}
              onChange={(e) =>
                useEditorStore.getState().setPreviewMode(e.target.checked)
              }
              className="accent-accent"
            />
            Preview
          </label>
          <div className="flex gap-1">
            {TOOLS.map(({ id, label, key, Icon }) => (
              <Tooltip key={id} content={`${label} (${key})`}>
                <Button
                  size="icon"
                  variant="ghost-inverse"
                  active={tool === id}
                  aria-label={label}
                  onClick={() => useEditorStore.getState().setTool(id)}
                >
                  <Icon size={18} aria-hidden="true" />
                </Button>
              </Tooltip>
            ))}
          </div>
          <div className="flex gap-1">
            <Tooltip content="Undo (⌘Z)">
              <Button
                size="icon"
                variant="ghost-inverse"
                aria-label="Undo"
                disabled={!canUndo}
                onClick={() => useEditorStore.getState().undo()}
              >
                <IconArrowBackUp size={18} aria-hidden="true" />
              </Button>
            </Tooltip>
            <Tooltip content="Redo (⌘⇧Z)">
              <Button
                size="icon"
                variant="ghost-inverse"
                aria-label="Redo"
                disabled={!canRedo}
                onClick={() => useEditorStore.getState().redo()}
              >
                <IconArrowForwardUp size={18} aria-hidden="true" />
              </Button>
            </Tooltip>
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
            {previewMode ? <span className="text-accent"> · preview</span> : null}
            {tool !== "select" && !selected && tool !== "erase" ? (
              <span className="text-danger"> · no source selected</span>
            ) : null}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
