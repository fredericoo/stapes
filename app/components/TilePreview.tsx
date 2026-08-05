import { useEffect, useRef } from "react";
import type {
  AutotileSlice,
  Direction,
  Frame,
  TileDef,
  TilesetDef,
} from "../lib/types";
import { DIRECTIONS } from "../lib/types";
import { getFrames } from "../lib/tileResolve";

type Props = {
  tile: TileDef | null;
  tilesets: TilesetDef[];
  size?: number;
  className?: string;
  /** Force a direction (skip cycling). */
  direction?: Direction;
  /** Autotile slice for preview (default isolated = 0). */
  autotileSlice?: AutotileSlice;
};

const imageCache = new Map<string, Promise<HTMLImageElement>>();

function loadImage(src: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(src);
  if (cached) return cached;

  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (err) => {
      imageCache.delete(src);
      reject(err);
    };
    img.src = src;
  });
  imageCache.set(src, promise);
  return promise;
}

function framesForPreview(
  tile: TileDef,
  direction: Direction | undefined,
  dirIndex: number,
  autotileSlice: AutotileSlice | undefined,
): Frame[] | undefined {
  if (tile.type === "directional") {
    const d = direction ?? DIRECTIONS[dirIndex % 4]!;
    return getFrames(tile, { direction: d });
  }
  if (tile.type === "autotile") {
    return getFrames(tile, { autotileSlice: autotileSlice ?? 0 });
  }
  return getFrames(tile);
}

/** Keep nearest-neighbor after canvas buffer / transform resets. */
function disableSmoothing(ctx: CanvasRenderingContext2D) {
  ctx.imageSmoothingEnabled = false;
}

/**
 * Shared animated tile preview. Uses a local rAF loop; fine for dozens of cards.
 */
export function TilePreview({
  tile,
  tilesets,
  size = 48,
  className = "",
  direction,
  autotileSlice,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !tile) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    disableSmoothing(ctx);

    let raf = 0;
    let alive = true;
    const start = performance.now();

    const tick = async (now: number) => {
      if (!alive) return;
      const elapsed = now - start;
      const dirIndex = Math.floor(elapsed / 800) % 4;
      const frames = framesForPreview(tile, direction, dirIndex, autotileSlice);
      disableSmoothing(ctx);
      ctx.clearRect(0, 0, size, size);
      ctx.fillStyle = "#d9d3c4";
      ctx.fillRect(0, 0, size, size);

      if (!frames || frames.length === 0) {
        ctx.fillStyle = "#ff00ff";
        ctx.fillRect(0, 0, size, size);
        raf = requestAnimationFrame(tick);
        return;
      }

      let total = 0;
      for (const f of frames) total += f.durationMs;
      let t = total > 0 ? elapsed % total : 0;
      let frame = frames[0]!;
      for (const f of frames) {
        if (t < f.durationMs) {
          frame = f;
          break;
        }
        t -= f.durationMs;
      }

      const tileset = tilesets.find((ts) => ts.id === frame.sprite.tilesetId);
      if (!tileset) {
        ctx.fillStyle = "#ff00ff";
        ctx.fillRect(0, 0, size, size);
        raf = requestAnimationFrame(tick);
        return;
      }

      try {
        const img = await loadImage(`/tilesets/${tileset.file}`);
        if (!alive) return;
        const { rect } = frame.sprite;
        const sx = rect.x * 8;
        const sy = rect.y * 8;
        const sw = rect.w * 8;
        const sh = rect.h * 8;
        // Integer scale so canvas nearest-neighbor stays chunky, not interpolated.
        const scale = Math.max(1, Math.floor(Math.min(size / sw, size / sh)));
        const dw = sw * scale;
        const dh = sh * scale;
        const dx = Math.floor((size - dw) / 2);
        const dy = Math.floor((size - dh) / 2);
        disableSmoothing(ctx);
        ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
      } catch {
        ctx.fillStyle = "#ff00ff";
        ctx.fillRect(0, 0, size, size);
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [tile, tilesets, size, direction, autotileSlice]);

  return (
    <canvas
      ref={canvasRef}
      className={["pixelated border-2 border-border bg-panel", className].join(
        " ",
      )}
      style={{ width: size, height: size }}
    />
  );
}
