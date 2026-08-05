import { getStack } from "../../lib/mapData";
import { resolveAutotileSlice } from "../../lib/autotile";
import { MapCanvas } from "../MapCanvas";
import { useEditorStore } from "../store";
import { useMapAssets } from "./MapAssetsContext";

export function CanvasPanel() {
  const { tiles, tilesets } = useMapAssets();

  return (
    <div className="relative min-h-0 min-w-0 flex-1">
      <MapCanvas tilesets={tilesets} tiles={tiles} />
      <CanvasStatus />
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
    <div className="pointer-events-none absolute right-2 bottom-2 border-2 border-border bg-paper/90 px-2 py-1 text-xs shadow-hard">
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
