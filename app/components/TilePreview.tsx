import { useEffect, useRef } from "react";
import { tilesetUrl } from "../lib/api";
import type {
  AutotileSlice,
  Frame,
  Octant,
  SpriteRef,
  SpriteState,
  TileDef,
  TilesetDef,
} from "../lib/types";
import { facingKeysFor, isDirectional } from "../lib/types";
import { getFrames } from "../lib/tileResolve";

type Props = {
  tile: TileDef | null;
  tilesets: TilesetDef[];
  size?: number;
  className?: string;
  /** Force a bearing (skip cycling). */
  direction?: Octant;
  /** Autotile slice for preview (default isolated = 0). */
  autotileSlice?: AutotileSlice;
  /** Scatter face for preview (default first authored = 0). */
  scatterIndex?: number;
  /** Which face a variant tile wears (default first authored). */
  variantKey?: string;
  /** Which sprite state to draw. Default / absent → idle. */
  state?: SpriteState;
  /**
   * Draw the first frame once and stop.
   *
   * For places where the tile is an *identifier* rather than the subject — a row
   * in a list naming what you are about to shove. A dozen of those animating in
   * their own rAF loops is a dozen loops competing with the frame budget of the
   * game they are drawn beside, to say nothing of what a wall of independently
   * flickering thumbnails is like to read.
   */
  still?: boolean;
  /**
   * What to paint behind the sprite, or null to leave the canvas transparent.
   * Sprites are authored with transparency, so a row on a dark surround needs
   * the surround showing through rather than the editor's paper square.
   */
  background?: string | null;
  /** Border and fill around the canvas. Off where the caller draws its own. */
  chrome?: boolean;
};

/** The editor's paper square, which is what a preview sits on unless told otherwise. */
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
    // Cycles the tile's own keys, so an eight-way tile shows all eight rather
    // than four of them and then four repeats.
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

/** Keep nearest-neighbor after canvas buffer / transform resets. */
function disableSmoothing(ctx: CanvasRenderingContext2D) {
  ctx.imageSmoothingEnabled = false;
}

/** The placeholder that makes a missing tileset obvious rather than invisible. */
const MISSING = "#ff00ff";

/**
 * Paint one sprite reference into a square of canvas.
 *
 * Split out of {@link TilePreview} because a sprite is not always a tile: a
 * status carries a bare {@link SpriteRef} and has no def to resolve frames from.
 * The *function* rather than a component, because `TilePreview` animates on its
 * own rAF loop and needs to repaint without a React render per frame — sharing
 * the component would have meant setting state five times a second per thumbnail.
 *
 * Returns nothing and swallows a failed load into the magenta placeholder, on
 * the same terms the renderer does: a missing tileset should be *visible*, not
 * an exception on a frame.
 */
export async function drawSprite(
  ctx: CanvasRenderingContext2D,
  sprite: SpriteRef,
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
    // Integer scale so canvas nearest-neighbor stays chunky, not interpolated.
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

/**
 * One sprite, drawn once.
 *
 * What {@link TilePreview} is for a tile, this is for anything that is *only* a
 * picture — a status icon, and whatever else stops being a tile next. There is
 * no animation loop because a sprite reference has nothing to animate: a `Frame`
 * is what carries a duration, and picking between frames is the tile's business.
 */
export function SpritePreview({
  sprite,
  tilesets,
  size = 48,
  className = "",
}: {
  sprite: SpriteRef | null;
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
      // The draw is async; a component unmounted in between has a canvas that
      // is no longer in the page, and painting it is wasted rather than wrong.
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

    // A still preview is drawn from the clock's origin and never scheduled
    // again — the image cache means even a redraw would produce the same pixels.
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

      await drawSprite(ctx, frame.sprite, tilesets, size);
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
      className={[
        "pixelated",
        chrome ? "border-2 border-border bg-panel" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ width: size, height: size }}
    />
  );
}
