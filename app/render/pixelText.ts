import * as THREE from "three";

/**
 * Text as pixels, for drawing inside the world rather than over it.
 *
 * The DOM can typeset text far better than this can, but not *in* the scene: a
 * name has to sit between the world and the chrome, scale with the view's whole
 * pixels and take the same outline the sprites take. So the string is rasterised
 * once into a texture and drawn as a quad like any other sprite.
 */

/** Silkscreen, by Jason Kottke (SIL OFL). Declared in app.css. */
export const PIXEL_FONT_FAMILY = "Silkscreen";

/**
 * The one size the font is pixel-exact at.
 *
 * Its em is 8 units wide, so 8px puts every brick on exactly one pixel. At 9px
 * a brick is 1.125px, the rasteriser spreads the difference as grey, and the
 * threshold below turns that grey into ragged edges. This is a constant rather
 * than a parameter for that reason: there is no second good value.
 */
export const PIXEL_FONT_SIZE_PX = 8;

/** Tallest glyph above the baseline, measured off the font's own outlines. */
const ASCENT_PX = 8;
/** Deepest glyph below it — commas and semicolons, 1px. */
const DESCENT_PX = 1;

/** Height of one rasterised line, baseline included. */
export const PIXEL_TEXT_LINE_PX = ASCENT_PX + DESCENT_PX;

/**
 * Alpha at or above this becomes a solid texel, below it becomes nothing.
 *
 * Canvas2D antialiases text whatever the size, and even a well-aligned pixel
 * font picks up a few grey texels at stroke ends. Left alone they show up twice:
 * as a soft fringe on the glyph, and as a ragged outline, since the outline
 * shader thresholds coverage at the same halfway point. Collapsing to 1-bit
 * here means the glyph the designer drew is the glyph that reaches the screen.
 */
const ALPHA_CUTOFF = 128;

export type PixelTextRaster = {
  texture: THREE.Texture;
  widthPx: number;
  heightPx: number;
};

/**
 * Wait for the font file, once.
 *
 * Rasterising before it lands silently draws the fallback — a proportional
 * system font at 8px, which is unreadable mush and, worse, looks like a
 * rendering bug rather than a loading one.
 */
let fontReady: Promise<boolean> | null = null;

export function loadPixelFont(): Promise<boolean> {
  fontReady ??= (async () => {
    if (typeof document === "undefined" || !document.fonts) return false;
    const face = `${PIXEL_FONT_SIZE_PX}px "${PIXEL_FONT_FAMILY}"`;
    try {
      await document.fonts.load(face, "ABCabc123");
      return document.fonts.check(face);
    } catch {
      return false;
    }
  })();
  return fontReady;
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.font = `${PIXEL_FONT_SIZE_PX}px "${PIXEL_FONT_FAMILY}"`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  return ctx;
}

/** Width the string will occupy, in world pixels. */
export function measurePixelText(text: string): number {
  if (typeof document === "undefined") return 0;
  const ctx = context(document.createElement("canvas"));
  if (!ctx) return 0;
  return Math.ceil(ctx.measureText(text).width);
}

/**
 * Draw a string into a texture whose texels are world pixels 1:1.
 *
 * Nearest filtering and a whole-pixel quad are what keep it that way: the view
 * only ever scales by whole numbers, so one texel lands on one square block of
 * screen pixels, exactly like the tile art beside it.
 */
export function rasterizePixelText(text: string): PixelTextRaster | null {
  if (typeof document === "undefined" || text.length === 0) return null;

  const canvas = document.createElement("canvas");
  const ctx = context(canvas);
  if (!ctx) return null;

  const widthPx = Math.max(1, Math.ceil(ctx.measureText(text).width));
  const heightPx = PIXEL_TEXT_LINE_PX;
  canvas.width = widthPx;
  canvas.height = heightPx;

  // Sizing the canvas resets the context, so the font has to be set again.
  const draw = context(canvas);
  if (!draw) return null;
  // White, so the material's colour is the only thing deciding the tint and one
  // raster can serve any number of colours.
  draw.fillStyle = "#ffffff";
  draw.fillText(text, 0, ASCENT_PX);

  const image = draw.getImageData(0, 0, widthPx, heightPx);
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    const solid = data[i + 3]! >= ALPHA_CUTOFF;
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = solid ? 255 : 0;
  }
  draw.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  // Matches the tile atlases, so a text quad's UVs read the same way theirs do.
  texture.flipY = true;
  texture.needsUpdate = true;

  return { texture, widthPx, heightPx };
}
