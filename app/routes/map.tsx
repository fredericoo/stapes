import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconEye,
  IconMinus,
  IconPlus,
} from "@tabler/icons-react";
import type { Route } from "./+types/map";
import { AppShell } from "../components/AppShell";
import { MapPanels } from "../editor/panels/MapPanels";
import {
  useEditorStore,
  ZOOM_LEVELS,
  snapZoom,
} from "../editor/store";
import { readMap, readTiles, readTilesets, writeMap } from "../lib/fs.server";
import { formatClock, MINUTES_PER_DAY } from "../lib/clock";
import type { MapFile } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL, clampLevel } from "../lib/types";
import { Button, Input, Switch, Tooltip, useToast } from "../ui";

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

export default function MapPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const { show: showToast } = useToast();

  const dirty = useEditorStore((s) => s.dirty);
  const currentLevel = useEditorStore((s) => s.currentLevel);
  const showOtherLevels = useEditorStore((s) => s.showOtherLevels);
  const previewMode = useEditorStore((s) => s.previewMode);
  const minutesOfDay = useEditorStore((s) => s.lighting.minutesOfDay);
  const zoom = useEditorStore((s) => s.zoom);
  const lastToast = useEditorStore((s) => s.lastToast);
  const canUndo = useEditorStore((s) => s.past.length > 0);
  const canRedo = useEditorStore((s) => s.future.length > 0);

  const [levelDraft, setLevelDraft] = useState(String(currentLevel));
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
              previewMode
                ? "Preview shows every level"
                : "Ghost related floors — above when on 0+, below when underground"
            }
          >
            <input
              type="checkbox"
              checked={showOtherLevels}
              disabled={previewMode}
              onChange={(e) =>
                useEditorStore.getState().setShowOtherLevels(e.target.checked)
              }
              className="hard-checkbox"
            />
            Show other levels
          </label>
          <Tooltip content="Preview (W) — every level at full opacity, no grid or selection">
            <Switch
              checked={previewMode}
              onCheckedChange={(v) =>
                useEditorStore.getState().setPreviewMode(v)
              }
              ariaLabel="Preview"
              thumb={<IconEye size={12} stroke={2.5} aria-hidden="true" />}
            />
          </Tooltip>
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase text-paper/70">Time</span>
            <input
              type="range"
              min={0}
              max={MINUTES_PER_DAY - 1}
              step={1}
              value={minutesOfDay}
              onChange={(e) =>
                useEditorStore
                  .getState()
                  .setMinutesOfDay(Number(e.target.value))
              }
              aria-label="Time of day"
              aria-valuetext={formatClock(minutesOfDay)}
              className="hard-slider w-28"
            />
            <span className="border-2 border-paper/40 px-1.5 py-0.5 text-xs tabular-nums text-paper">
              {formatClock(minutesOfDay)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase text-paper/70">Zoom</span>
            <input
              type="range"
              min={0}
              max={ZOOM_LEVELS.length - 1}
              step={1}
              value={ZOOM_LEVELS.indexOf(snapZoom(zoom))}
              onChange={(e) => {
                const level = ZOOM_LEVELS[Number(e.target.value)];
                if (level !== undefined) {
                  useEditorStore.getState().setZoom(level);
                }
              }}
              aria-label="Zoom"
              aria-valuetext={`${snapZoom(zoom)}x`}
              className="hard-slider"
            />
            <span className="border-2 border-paper/40 px-1.5 py-0.5 text-xs tabular-nums text-paper">
              {snapZoom(zoom)}x
            </span>
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
      <MapPanels tiles={data.tiles} tilesets={data.tilesets} />
    </AppShell>
  );
}
