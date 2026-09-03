import { useCallback, useEffect, useRef, useState } from "react";
import { tilesetUrl } from "../lib/api";
import type { SpriteRef, TilesetDef } from "../lib/types";
import { defaultBase } from "../lib/types";

type Props = {
  tileset: TilesetDef | null;
  value: SpriteRef | null;
  onChange: (sprite: SpriteRef) => void;
  zoom?: number;
};

/**
 * Drag-select a rectangular cell area on a tileset; click inside selection to set base.
 */
export function SpriteSelector({ tileset, value, onChange, zoom = 4 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The sheet is held with the tileset it belongs to, so which one is on screen
  // is a comparison rather than a second piece of state to clear. Clearing it
  // meant a render where the old sheet was still being drawn under the new
  // tileset's grid, and a sheet that arrived after the author had moved on
  // replaced the one they were looking at.
  const [loaded, setLoaded] = useState<{
    tileset: TilesetDef;
    image: HTMLImageElement;
  } | null>(null);
  const img = loaded?.tileset === tileset ? loaded.image : null;
  const dragRef = useRef<{
    startX: number;
    startY: number;
    dragging: boolean;
  } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!tileset) return;
    let cancelled = false;
    const image = new Image();
    image.src = tilesetUrl(tileset.file);
    image.onload = () => {
      if (!cancelled) setLoaded({ tileset, image });
    };
    return () => {
      cancelled = true;
    };
  }, [tileset]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !tileset) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = tileset.width * zoom;
    const h = tileset.height * zoom;
    // Resizing the buffer resets context state — set smoothing after.
    canvas.width = w;
    canvas.height = h;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#cfc8b6";
    ctx.fillRect(0, 0, w, h);

    if (img) {
      ctx.drawImage(img, 0, 0, w, h);
    }

    // Grid
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= tileset.width; x += 8) {
      ctx.beginPath();
      ctx.moveTo(x * zoom + 0.5, 0);
      ctx.lineTo(x * zoom + 0.5, h);
      ctx.stroke();
    }
    for (let y = 0; y <= tileset.height; y += 8) {
      ctx.beginPath();
      ctx.moveTo(0, y * zoom + 0.5);
      ctx.lineTo(w, y * zoom + 0.5);
      ctx.stroke();
    }

    if (value && value.tilesetId === tileset.id) {
      const { rect, base } = value;
      ctx.fillStyle = "rgba(45, 106, 79, 0.28)";
      ctx.fillRect(
        rect.x * 8 * zoom,
        rect.y * 8 * zoom,
        rect.w * 8 * zoom,
        rect.h * 8 * zoom,
      );
      ctx.strokeStyle = "#2d6a4f";
      ctx.lineWidth = 2;
      ctx.strokeRect(
        rect.x * 8 * zoom + 1,
        rect.y * 8 * zoom + 1,
        rect.w * 8 * zoom - 2,
        rect.h * 8 * zoom - 2,
      );
      // Base cell
      ctx.fillStyle = "rgba(255, 200, 0, 0.45)";
      ctx.fillRect(
        (rect.x + base.x) * 8 * zoom,
        (rect.y + base.y) * 8 * zoom,
        8 * zoom,
        8 * zoom,
      );
      ctx.strokeStyle = "#c9a227";
      ctx.strokeRect(
        (rect.x + base.x) * 8 * zoom + 1,
        (rect.y + base.y) * 8 * zoom + 1,
        8 * zoom - 2,
        8 * zoom - 2,
      );
    }

    if (hover) {
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.strokeRect(
        hover.x * 8 * zoom + 0.5,
        hover.y * 8 * zoom + 0.5,
        8 * zoom - 1,
        8 * zoom - 1,
      );
    }
  }, [tileset, img, value, zoom, hover]);

  useEffect(() => {
    draw();
  }, [draw]);

  const cellAt = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas || !tileset) return null;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((clientX - rect.left) / (8 * zoom));
    const y = Math.floor((clientY - rect.top) / (8 * zoom));
    if (x < 0 || y < 0 || x >= tileset.width / 8 || y >= tileset.height / 8) {
      return null;
    }
    return { x, y };
  };

  if (!tileset) {
    return (
      <div className="border-2 border-border bg-panel p-6 text-sm text-muted shadow-hard">
        Select a tileset to pick a sprite.
      </div>
    );
  }

  return (
    <div className="overflow-auto border-2 border-border bg-panel shadow-hard">
      <canvas
        ref={canvasRef}
        className="pixelated cursor-crosshair"
        onMouseMove={(e) => {
          const c = cellAt(e.clientX, e.clientY);
          setHover(c);
          if (dragRef.current?.dragging && c && tileset) {
            const { startX, startY } = dragRef.current;
            const x = Math.min(startX, c.x);
            const y = Math.min(startY, c.y);
            const w = Math.abs(c.x - startX) + 1;
            const h = Math.abs(c.y - startY) + 1;
            const rect = { x, y, w, h };
            onChange({
              tilesetId: tileset.id,
              rect,
              base: defaultBase(rect),
            });
          }
        }}
        onMouseLeave={() => setHover(null)}
        onMouseDown={(e) => {
          const c = cellAt(e.clientX, e.clientY);
          if (!c || !tileset) return;
          // If click inside existing selection, set base
          if (
            value &&
            value.tilesetId === tileset.id &&
            c.x >= value.rect.x &&
            c.y >= value.rect.y &&
            c.x < value.rect.x + value.rect.w &&
            c.y < value.rect.y + value.rect.h &&
            !e.shiftKey
          ) {
            // Start drag only if moving; for now: mousedown inside = potential base set on mouseup without drag
            dragRef.current = {
              startX: c.x,
              startY: c.y,
              dragging: false,
            };
            return;
          }
          dragRef.current = { startX: c.x, startY: c.y, dragging: true };
          const rect = { x: c.x, y: c.y, w: 1, h: 1 };
          onChange({
            tilesetId: tileset.id,
            rect,
            base: defaultBase(rect),
          });
        }}
        onMouseUp={(e) => {
          const c = cellAt(e.clientX, e.clientY);
          const drag = dragRef.current;
          dragRef.current = null;
          if (!c || !tileset || !value) return;
          if (
            drag &&
            !drag.dragging &&
            c.x >= value.rect.x &&
            c.y >= value.rect.y &&
            c.x < value.rect.x + value.rect.w &&
            c.y < value.rect.y + value.rect.h
          ) {
            onChange({
              ...value,
              base: { x: c.x - value.rect.x, y: c.y - value.rect.y },
            });
          }
        }}
      />
      <div className="border-t-2 border-border px-2 py-1 text-xs text-muted">
        Drag to select cells. Click inside selection to set base (yellow).
        {value
          ? ` Selected ${value.rect.w}×${value.rect.h}, base (${value.base.x},${value.base.y})`
          : ""}
      </div>
    </div>
  );
}
