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

  return (
    <div className="pointer-events-none absolute right-2 bottom-2 border-2 border-border bg-paper/90 px-2 py-1 text-xs shadow-hard">
      {hover ? `${hover.x},${hover.y}` : "—"} · z{currentLevel} · ×{zoom}
      {previewMode ? <span className="text-accent"> · preview</span> : null}
      {tool !== "select" && !selected && tool !== "erase" ? (
        <span className="text-danger"> · no source selected</span>
      ) : null}
    </div>
  );
}
