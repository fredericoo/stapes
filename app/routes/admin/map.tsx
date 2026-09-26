import { MAP_FILE_VERSION } from "../../lib/types";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fetchMapText, fetchTiles, fetchTilesets, saveMapText } from "../../lib/api";
import { parseMap, serializeMap } from "../../lib/mapData";
import { requireAdmin } from "../../lib/auth";
import { useFetcher, useLoaderData } from "react-router";
import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconArrowDown,
  IconArrowUp,
  IconEye,
  IconStackBackward,
} from "@tabler/icons-react";
import type { Route } from "./+types/map";
import { AdminShell } from "../../components/AppShell";
import { LightingToggle } from "../../components/LightingToggle";
import { MapPanels } from "../../editor/panels/MapPanels";
import { useEditorStore, ZOOM_LEVELS, snapZoom } from "../../editor/store";
import { formatClock, MINUTES_PER_DAY } from "../../lib/clock";
import type { MapFile, TileDef } from "../../lib/types";
import { MAX_LEVEL, MIN_LEVEL, clampLevel } from "../../lib/types";
import type { RemovedPlacement } from "../../lib/validation";
import { Button, Input, Toggle, Tooltip, useToast } from "../../ui";

export async function clientLoader() {
  await requireAdmin();
  const [mapText, tiles, tilesets] = await Promise.all([
    fetchMapText(),
    fetchTiles(),
    fetchTilesets(),
  ]);
  return { map: parseMap(mapText), tiles, tilesets };
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData();
  const raw = String(form.get("map") ?? "");
  try {
    const map = JSON.parse(raw) as MapFile;
    if (map.version !== MAP_FILE_VERSION) {
      return { ok: false, error: "Unsupported map version" };
    }
    const removed = await saveMapText(serializeMap(map));
    return { ok: true, removed };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to save",
    };
  }
}

const LISTED_REMOVALS = 4;

function removalNotice(
  removed: readonly RemovedPlacement[],
  tilesById: Record<string, TileDef>,
): [title: string, description: string] {
  const listed = removed
    .slice(0, LISTED_REMOVALS)
    .map(
      ({ x, y, z, tileId }) => `${tilesById[tileId]?.name ?? tileId} at ${x},${y} on level ${z}`,
    );
  if (removed.length > listed.length) listed.push(`and ${removed.length - listed.length} more`);
  const title =
    removed.length === 1
      ? "Removed 1 tile that did not fit"
      : `Removed ${removed.length} tiles that did not fit`;
  return [title, listed.join("\n")];
}

export default function MapPage() {
  const data = useLoaderData<typeof clientLoader>();
  const fetcher = useFetcher<typeof clientAction>();
  const { show: showToast } = useToast();

  const dirty = useEditorStore((s) => s.dirty);
  const currentLevel = useEditorStore((s) => s.currentLevel);
  const showOtherLevels = useEditorStore((s) => s.showOtherLevels);
  const previewMode = useEditorStore((s) => s.previewMode);
  const minutesOfDay = useEditorStore((s) => s.lighting.minutesOfDay);
  const lightingEnabled = useEditorStore((s) => s.lighting.enabled);
  const zoom = useEditorStore((s) => s.zoom);
  const lastToast = useEditorStore((s) => s.lastToast);
  const canUndo = useEditorStore((s) => s.past.length > 0);
  const canRedo = useEditorStore((s) => s.future.length > 0);

  const [levelDraft, setLevelDraft] = useState(String(currentLevel));
  const handledSaveData = useRef<unknown>(null);

  const save = useCallback(() => {
    const store = useEditorStore.getState();
    let removed: RemovedPlacement[];
    try {
      removed = store.removeUnfit();
    } catch (err) {
      showToast("Save failed", err instanceof Error ? err.message : "Failed to save", {
        untilDismissed: true,
      });
      return;
    }
    if (removed.length > 0) {
      showToast(...removalNotice(removed, store.tilesById), { untilDismissed: true });
    }
    const fd = new FormData();
    fd.set("map", JSON.stringify(useEditorStore.getState().map));
    fetcher.submit(fd, { method: "post" });
  }, [fetcher, showToast]);

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
        save();
        return;
      }

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
  }, [save]);

  useEffect(() => {
    if (!fetcher.data || handledSaveData.current === fetcher.data) return;
    handledSaveData.current = fetcher.data;
    if (!fetcher.data.ok) {
      showToast("Save failed", fetcher.data.error);
      return;
    }
    const store = useEditorStore.getState();
    store.markSaved();
    showToast("Map saved");
    /**
     * Empty unless the server's tile catalogue changed after this page loaded,
     * since `save` already removed what did not fit by the editor's own. The
     * loader runs again after the save, and `hydrate` takes the saved map.
     */
    const removed = fetcher.data.removed ?? [];
    if (removed.length > 0) {
      showToast(...removalNotice(removed, store.tilesById), { untilDismissed: true });
    }
  }, [fetcher.data, showToast]);

  return (
    <AdminShell
      trailing={
        <>
          <div className="flex items-center gap-1">
            <Tooltip content="Level down ([)">
              <Button
                size="icon"
                variant="ghost-inverse"
                aria-label="Level down"
                onClick={() =>
                  useEditorStore.getState().setLevel(Math.max(MIN_LEVEL, currentLevel - 1))
                }
              >
                <IconArrowDown size={16} aria-hidden="true" />
              </Button>
            </Tooltip>
            <Input
              aria-label="Level"
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
            <Tooltip content="Level up (])">
              <Button
                size="icon"
                variant="ghost-inverse"
                aria-label="Level up"
                onClick={() =>
                  useEditorStore.getState().setLevel(Math.min(MAX_LEVEL, currentLevel + 1))
                }
              >
                <IconArrowUp size={16} aria-hidden="true" />
              </Button>
            </Tooltip>
          </div>
          <div className="flex items-center gap-1">
            <Tooltip content="Isolate to current level (I) — drop the floors above, which are otherwise ghosted into one fade. Underground that fade stops at -1">
              <Toggle
                pressed={!showOtherLevels}
                onPressedChange={(v) => useEditorStore.getState().setShowOtherLevels(!v)}
                ariaLabel="Isolate to current level"
              >
                <IconStackBackward size={16} stroke={2} aria-hidden="true" />
              </Toggle>
            </Tooltip>
            <Tooltip content="Preview (W) — every level solid, as play draws it, with no grid or selection in the way">
              <Toggle
                pressed={previewMode}
                onPressedChange={(v) => useEditorStore.getState().setPreviewMode(v)}
                ariaLabel="Preview"
              >
                <IconEye size={16} stroke={2} aria-hidden="true" />
              </Toggle>
            </Tooltip>
            <LightingToggle
              enabled={lightingEnabled}
              onChange={(v) => useEditorStore.getState().setLightingEnabled(v)}
              shortcut="L"
            />
          </div>
          <div
            className={["flex items-center gap-2", lightingEnabled ? "" : "opacity-50"].join(" ")}
          >
            <span className="text-xs uppercase text-paper/70">Time</span>
            <input
              type="range"
              min={0}
              max={MINUTES_PER_DAY - 1}
              step={1}
              value={minutesOfDay}
              disabled={!lightingEnabled}
              onChange={(e) => useEditorStore.getState().setMinutesOfDay(Number(e.target.value))}
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
          <Button size="sm" variant="primary" onClick={save} disabled={fetcher.state !== "idle"}>
            Save{dirty ? " *" : ""}
          </Button>
        </>
      }
    >
      <MapPanels tiles={data.tiles} tilesets={data.tilesets} />
    </AdminShell>
  );
}
