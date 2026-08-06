import { getStack } from "../../lib/mapData";
import { resolveAutotileSlice } from "../../lib/autotile";
import { MapCanvas } from "../MapCanvas";
import { useEditorStore } from "../store";
import { useMapAssets } from "./MapAssetsContext";
import { MapToolbar } from "./MapToolbar";

export function CanvasPanel() {
  const { tiles, tilesets } = useMapAssets();

  return (
    <div className="relative min-h-0 min-w-0 flex-1">
      <MapCanvas tilesets={tilesets} tiles={tiles} />
      <aside
        aria-label="Map editor chrome"
        className={[
          "pointer-events-none absolute inset-y-2 right-2 z-50",
          "flex w-max max-w-[min(100%,16rem)] flex-col items-end gap-2",
        ].join(" ")}
      >
        {import.meta.env.DEV ? (
          <div
            data-editor-stats
            className="relative z-10 shrink-0 empty:hidden [&_>div]:border-2 [&_>div]:border-border [&_>div]:bg-paper/90 [&_>div]:px-2 [&_>div]:py-1 [&_>div]:font-mono [&_>div]:text-[11px]/[&_>div]:leading-snug [&_>div]:text-accent [&_>div]:shadow-hard [&_>div]:whitespace-pre"
          />
        ) : null}
        <div className="relative min-h-0 w-full flex-1">
          <div className="absolute inset-0 flex items-center justify-end">
            <div className="pointer-events-auto max-h-full min-h-0 overflow-hidden">
              <MapToolbar />
            </div>
          </div>
        </div>
        <CanvasStatus />
      </aside>
    </div>
  );
}

/** Split out so pointer-driven hover updates re-render only this readout. */
function CanvasStatus() {
  const hover = useEditorStore((s) => s.hover);
  const currentLevel = useEditorStore((s) => s.currentLevel);
  const zoom = useEditorStore((s) => s.zoom);
  const previewMode = useEditorStore((s) => s.previewMode);
  const tool = useEditorStore((s) => s.tool);
  const selected = useEditorStore((s) => s.selected);
  const map = useEditorStore((s) => s.map);
  const tilesById = useEditorStore((s) => s.tilesById);

  const autotileSlices =
    selected == null
      ? null
      : getStack(map, selected.x, selected.y, currentLevel)
          .map((placed) => {
            const def = tilesById[placed.tileId];
            if (!def || def.type !== "autotile") return null;
            const slice = resolveAutotileSlice(
              map,
              selected.x,
              selected.y,
              currentLevel,
              def.id,
            );
            const defined = Boolean(def.slices?.[slice]);
            return {
              id: def.id,
              slice,
              fallback: !defined,
            };
          })
          .filter((x): x is NonNullable<typeof x> => x != null);

  return (
    <div className="relative z-10 shrink-0 border-2 border-border bg-paper/90 px-2 py-1 text-xs shadow-hard">
      {hover ? `${hover.x},${hover.y}` : "—"} · z{currentLevel} · ×{zoom}
      {previewMode ? <span className="text-accent"> · preview</span> : null}
      {tool !== "select" && !selected && tool !== "erase" ? (
        <span className="text-danger"> · no source selected</span>
      ) : null}
      {autotileSlices && autotileSlices.length > 0 ? (
        <span className="block font-mono text-[10px] text-muted">
          {autotileSlices.map((a) => (
            <span key={a.id} className="mr-2 last:mr-0">
              {a.id} slice {a.slice}
              {a.fallback ? (
                <span className="text-danger" title="Missing slice — using fallback">
                  {" "}
                  (fallback)
                </span>
              ) : null}
            </span>
          ))}
        </span>
      ) : null}
    </div>
  );
}
