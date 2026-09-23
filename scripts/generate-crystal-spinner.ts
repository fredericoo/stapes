/**
 * Renders the loading spinner: `public/crystal-spinner.gif`, a blue crystal
 * turning on its axis in the colours of the logo.
 *
 * Run: `bun run generate:spinner`
 *
 * The crystal is modelled and lit in Three.js (`crystal-spinner/scene.ts`),
 * rendered in headless Chromium at `SUPERSAMPLE` times the GIF's size, and
 * brought down to pixel art here:
 *
 * 1. Each `SUPERSAMPLE`² block becomes one pixel. It is opaque when more than
 *    `COVERAGE` of the block is covered, and its colour is the covered part's
 *    mean. Deciding coverage per block rather than per sample is what keeps
 *    the silhouette's stair-steps even.
 * 2. The colour is snapped to the nearest entry of `LOGO_PALETTE` in OKLab.
 *    No dithering, because the logo has none.
 * 3. Every transparent pixel touching an opaque one (4-neighbour) becomes the
 *    outline colour, the same near-black the logo is outlined in.
 * 4. Sparkles are stamped on last, so they sit over the outline like the
 *    stars around the logo do.
 *
 * The crystal has six-fold symmetry, so turning it 60° brings it back to where
 * it started. The loop is those 60° only, which is why a full-looking turn fits
 * in `FRAMES` frames. The frames are few and held long on purpose, so the turn
 * steps like hand-drawn sprite animation rather than gliding.
 *
 * Both pyramids are the same height and the camera is level with the girdle,
 * so the silhouette is the same upside down. Only the light, which comes from
 * above, tells the top from the bottom.
 *
 * `CHROMIUM_PATH` points Playwright at a Chromium other than the one it
 * downloaded. Also writes `crystal-spinner@4x.gif`, the same frames scaled up by nearest
 * neighbour, to the scratch path in `PREVIEW` if it is set, for looking at.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { nearestPaletteIndex, paletteOklab, srgbToOklab } from "../app/lib/palette";
import { encodeGif } from "./crystal-spinner/gif";
import type { SceneParams } from "./crystal-spinner/scene";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "public", "crystal-spinner.gif");
const PREVIEW = process.env.PREVIEW;

/** GIF side in pixels. */
const SIZE = 32;
const SUPERSAMPLE = 6;
/** Fraction of a block that must be covered for its pixel to be drawn. */
const COVERAGE = 0.5;
const FRAMES = 8;
/** Hundredths of a second per frame. */
const DELAY_CS = 12;

/**
 * The logo's sixteen colours (`public/logo.png`), outline first. The spinner
 * uses these rather than `STAPES_PALETTE` because it sits next to the logo,
 * and the game palette's four blues are not the logo's.
 */
const OUTLINE = "#000001";
const LOGO_PALETTE = [
  "#010728",
  "#021652",
  "#03257e",
  "#0334bb",
  "#0450e9",
  "#098cf6",
  "#16d3fb",
  "#163d8a",
  "#2d52a1",
  "#406cbd",
  "#558bd5",
  "#69abe7",
  "#7cd1f5",
  "#aae3f8",
  "#e0f9fd",
];
const SPARKLE_CORE = "#e0f9fd";
const SPARKLE_ARM = "#16d3fb";

const SCENE: Omit<SceneParams, "size" | "frames"> = {
  sweepDeg: 60,
  sides: 6,
  radius: 0.62,
  topHeight: 1.05,
  bottomHeight: 1.05,
  girdle: 0.12,
  pitchDeg: 0,
  tiltDeg: 0,
  viewExtent: 1.25,
  frontOpacityMin: 0.7,
  frontOpacityMax: 0.95,
  filmFrequency: 7,
};

/**
 * A four-point star, as around the logo: at `x, y`, with its arm length per
 * frame (0 is off, 1 is a plus, 2 is a longer plus).
 */
type Sparkle = { x: number; y: number; arms: readonly number[] };
const SPARKLES: readonly Sparkle[] = [
  { x: 24, y: 5, arms: [0, 0, 1, 2, 1, 0, 0, 0] },
  { x: 7, y: 26, arms: [0, 0, 0, 0, 0, 1, 1, 0] },
];

// Index 0 is transparent, 1 is the outline, the rest are the logo's fills.
const TRANSPARENT = 0;
const OUTLINE_INDEX = 1;
const GIF_PALETTE_HEX = ["#000000", OUTLINE, ...LOGO_PALETTE];
const FILL_OKLAB = paletteOklab(LOGO_PALETTE);
const FILL_OFFSET = 2;
const indexOf = (hex: string): number => GIF_PALETTE_HEX.indexOf(hex);

async function renderFrames(): Promise<number[][]> {
  const build = await Bun.build({
    entrypoints: [path.join(import.meta.dirname, "crystal-spinner", "scene.ts")],
    target: "browser",
    minify: true,
  });
  if (!build.success) throw new AggregateError(build.logs, "scene bundle failed");
  const bundle = await build.outputs[0]!.text();

  const browser = await chromium.launch({
    // Set when the installed Chromium is not the build this Playwright expects.
    executablePath: process.env.CHROMIUM_PATH,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.error(e));
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ content: bundle });
    const params: SceneParams = { ...SCENE, size: SIZE * SUPERSAMPLE, frames: FRAMES };
    return await page.evaluate((p) => window.renderCrystal(p), params);
  } finally {
    await browser.close();
  }
}

function downsample(rgba: readonly number[]): Uint8Array {
  const big = SIZE * SUPERSAMPLE;
  const out = new Uint8Array(SIZE * SIZE).fill(TRANSPARENT);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let covered = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const i = ((y * SUPERSAMPLE + sy) * big + x * SUPERSAMPLE + sx) * 4;
          const a = rgba[i + 3]! / 255;
          if (a === 0) continue;
          covered++;
          // Colour is averaged without weighting by alpha: every front facet
          // is drawn over an opaque back facet, so a covered sample is opaque.
          r += rgba[i]!;
          g += rgba[i + 1]!;
          b += rgba[i + 2]!;
        }
      }
      if (covered / (SUPERSAMPLE * SUPERSAMPLE) <= COVERAGE) continue;
      const lab = srgbToOklab(r / covered / 255, g / covered / 255, b / covered / 255);
      out[y * SIZE + x] = FILL_OFFSET + nearestPaletteIndex(lab, FILL_OKLAB);
    }
  }
  return out;
}

function outline(px: Uint8Array): void {
  const src = px.slice();
  const opaque = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < SIZE && y < SIZE && src[y * SIZE + x] !== TRANSPARENT;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (src[y * SIZE + x] !== TRANSPARENT) continue;
      if (opaque(x - 1, y) || opaque(x + 1, y) || opaque(x, y - 1) || opaque(x, y + 1)) {
        px[y * SIZE + x] = OUTLINE_INDEX;
      }
    }
  }
}

function sparkle(px: Uint8Array, s: Sparkle, frame: number): void {
  const arms = s.arms[frame % s.arms.length]!;
  if (arms === 0) return;
  const star: [number, number, number][] = [[s.x, s.y, indexOf(SPARKLE_CORE)]];
  for (let d = 1; d <= arms; d++) {
    const c = indexOf(d === 1 ? SPARKLE_CORE : SPARKLE_ARM);
    star.push([s.x + d, s.y, c], [s.x - d, s.y, c], [s.x, s.y + d, c], [s.x, s.y - d, c]);
  }
  const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < SIZE && y < SIZE;
  // Outlined like the stars around the logo, or it disappears on a light page.
  for (const [x, y] of star) {
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      if (inside(x + dx, y + dy) && px[(y + dy) * SIZE + x + dx] === TRANSPARENT) {
        px[(y + dy) * SIZE + x + dx] = OUTLINE_INDEX;
      }
    }
  }
  for (const [x, y, c] of star) if (inside(x, y)) px[y * SIZE + x] = c;
}

function scale(px: Uint8Array, k: number): Uint8Array {
  const out = new Uint8Array(SIZE * k * SIZE * k);
  for (let y = 0; y < SIZE * k; y++) {
    for (let x = 0; x < SIZE * k; x++) {
      out[y * SIZE * k + x] = px[Math.floor(y / k) * SIZE + Math.floor(x / k)]!;
    }
  }
  return out;
}

const rgb = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

async function main(): Promise<void> {
  const rendered = await renderFrames();
  const frames = rendered.map((rgba, f) => {
    const px = downsample(rgba);
    outline(px);
    for (const s of SPARKLES) sparkle(px, s, f);
    return px;
  });

  const palette = GIF_PALETTE_HEX.map(rgb);
  const write = async (file: string, k: number): Promise<void> => {
    const gif = encodeGif(
      { width: SIZE * k, height: SIZE * k, palette, transparentIndex: TRANSPARENT },
      frames.map((px) => ({ indices: k === 1 ? px : scale(px, k), delayCs: DELAY_CS })),
    );
    await fs.writeFile(file, gif);
    console.log(`wrote ${path.relative(ROOT, file)} (${gif.length} bytes)`);
  };
  await write(OUT, 1);
  if (PREVIEW) await write(path.join(PREVIEW, "crystal-spinner@4x.gif"), 4);
}

await main();
