import { useEffect, useRef } from "react";
import { tilesetUrl } from "../lib/api";
import type {
  AnchoredSprite,
  AutotileSlice,
  Frame,
  Octant,
  SpriteState,
  TileDef,
  TilesetDef,
} from "../lib/types";
import { anchoredSprite, facingKeysFor, isDirectional } from "../lib/types";
import { getFrames } from "../lib/tileResolve";

type Props = {
  tile: TileDef | null;
  tilesets: TilesetDef[];
  size?: number;
  className?: string;
  direction?: Octant;
  autotileSlice?: AutotileSlice;
  scatterIndex?: number;
  variantKey?: string;
  state?: SpriteState;
  still?: boolean;
  background?: string | null;
  chrome?: boolean;
};

const DEFAULT_PREVIEW_BACKGROUND = "#d9d3c4";

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
  direction: Octant | undefined,
  dirIndex: number,
  autotileSlice: AutotileSlice | undefined,
  scatterIndex: number | undefined,
  variantKey: string | undefined,
  state: SpriteState | undefined,
): Frame[] | undefined {
  if (isDirectional(tile)) {
    const keys = facingKeysFor(tile);
    const d = direction ?? keys[dirIndex % keys.length]!;
    return getFrames(tile, { state, direction: d });
  }
  if (tile.type === "autotile") {
    return getFrames(tile, { state, autotileSlice: autotileSlice ?? 0 });
  }
  if (tile.type === "scatter") {
    return getFrames(tile, { state, scatterIndex: scatterIndex ?? 0 });
  }
  if (tile.type === "variant") {
    return getFrames(tile, { state, variant: variantKey });
  }
  return getFrames(tile, { state });
}

function disableSmoothing(ctx: CanvasRenderingContext2D) {
  ctx.imageSmoothingEnabled = false;
}

const MISSING = "#ff00ff";

export async function drawSprite(
  ctx: CanvasRenderingContext2D,
  sprite: AnchoredSprite,
  tilesets: TilesetDef[],
  size: number,
): Promise<void> {
  const tileset = tilesets.find((ts) => ts.id === sprite.tilesetId);
  if (!tileset) {
    ctx.fillStyle = MISSING;
    ctx.fillRect(0, 0, size, size);
    return;
  }

  try {
    const img = await loadImage(tilesetUrl(tileset.file));
    const { rect } = sprite;
    const sx = rect.x * 8;
    const sy = rect.y * 8;
    const sw = rect.w * 8;
    const sh = rect.h * 8;
    /** Integer scale so canvas nearest-neighbor stays chunky, not interpolated. */
    const scale = Math.max(1, Math.floor(Math.min(size / sw, size / sh)));
    const dw = sw * scale;
    const dh = sh * scale;
    const dx = Math.floor((size - dw) / 2);
    const dy = Math.floor((size - dh) / 2);
    disableSmoothing(ctx);
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  } catch {
    ctx.fillStyle = MISSING;
    ctx.fillRect(0, 0, size, size);
  }
}

export function SpritePreview({
  sprite,
  tilesets,
  size = 48,
  className = "",
}: {
  sprite: AnchoredSprite | null;
  tilesets: TilesetDef[];
  size?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    disableSmoothing(ctx);
    ctx.clearRect(0, 0, size, size);

    if (!sprite) return;
    let alive = true;
    void drawSprite(ctx, sprite, tilesets, size).then(() => {
      if (!alive) return;
    });
    return () => {
      alive = false;
    };
  }, [sprite, tilesets, size]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: size, height: size, imageRendering: "pixelated" }}
    />
  );
}

export function TilePreview({
  tile,
  tilesets,
  size = 48,
  className = "",
  direction,
  autotileSlice,
  scatterIndex,
  variantKey,
  state,
  still = false,
  background = DEFAULT_PREVIEW_BACKGROUND,
  chrome = true,
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

    const again = () => {
      if (!still) raf = requestAnimationFrame(tick);
    };

    const tick = async (now: number) => {
      if (!alive) return;
      const elapsed = still ? 0 : now - start;
      const dirIndex = Math.floor(elapsed / 800) % 4;
      const frames = framesForPreview(
        tile,
        direction,
        dirIndex,
        autotileSlice,
        scatterIndex,
        variantKey,
        state,
      );
      disableSmoothing(ctx);
      ctx.clearRect(0, 0, size, size);
      if (background !== null) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, size, size);
      }

      if (!frames || frames.length === 0) {
        ctx.fillStyle = MISSING;
        ctx.fillRect(0, 0, size, size);
        again();
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

      await drawSprite(ctx, anchoredSprite(tile.anchor, frame.sprite), tilesets, size);
      if (!alive) return;

      again();
    };

    raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [
    tile,
    tilesets,
    size,
    direction,
    autotileSlice,
    scatterIndex,
    variantKey,
    state,
    still,
    background,
  ]);

  return (
    <canvas
      ref={canvasRef}
      className={["pixelated", chrome ? "border-2 border-border bg-panel" : "", className]
        .filter(Boolean)
        .join(" ")}
      style={{ width: size, height: size }}
    />
  );
}
