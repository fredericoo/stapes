import { useEffect, useRef } from "react";
import type { TileDef, TilesetDef } from "../lib/types";
import { EditorRenderer } from "./EditorRenderer";
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
    return () => {
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
