import { useEffect, useRef } from "react";
import type { TileDef, TilesetDef } from "../lib/types";
import { EditorRenderer } from "./EditorRenderer";
import { createMapApi } from "./mapApi";
import type { EditorPerfProbe } from "./perf";
import { useEditorStore } from "./store";

export function MapCanvas({
  tilesets,
  tiles,
}: {
  tilesets: TilesetDef[];
  tiles: TileDef[];
}) {
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

    // See `./mapApi`: driving the view from the console, so a script can say
    // where to look. Installed with the renderer because it needs the canvas
    // size to work out what "centred" means.
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
    // Wait a tick so hydrate (useLayoutEffect in the page) has populated the store.
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
