import { useEffect, useRef } from "react";
import type { TileDef, TilesetDef } from "../lib/types";
import { EditorRenderer } from "./EditorRenderer";
import { createMapApi } from "./mapApi";
import type { EditorPerfProbe } from "./perf";
import { useEditorStore } from "./store";

export function MapCanvas({ tilesets, tiles }: { tilesets: TilesetDef[]; tiles: TileDef[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<EditorRenderer | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new EditorRenderer(canvas);
    rendererRef.current = renderer;

    const probe: EditorPerfProbe = {
      ready: () => renderer.isReady(),
      snapshot: () => renderer.getPerfSnapshot(),
      measureRenders: (samples) => renderer.measureRenders(samples),
    };
    window.__editorPerf = probe;

    const map = createMapApi(() => renderer.getViewportSize());
    window.map = map;

    return () => {
      if (window.__editorPerf === probe) delete window.__editorPerf;
      if (window.map === map) delete window.map;
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    /**
     * Read fresh rather than subscribed: an ordinary effect runs after the
     * page's useLayoutEffect that hydrates the store, so tilesById is
     * already populated by the time this runs.
     */
    const tilesById = useEditorStore.getState().tilesById;
    rendererRef.current?.setAssets(tilesets, tilesById);
  }, [tilesets, tiles]);

  return (
    <canvas
      ref={canvasRef}
      className="block h-full w-full touch-none"
      style={{ imageRendering: "pixelated" }}
    />
  );
}
