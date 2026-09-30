import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { nearestPaletteIndex, paletteOklab, srgbToOklab } from "../app/lib/palette";
import { encodeGif } from "./crystal-spinner/gif";
import type { SceneParams } from "./crystal-spinner/scene";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "public", "crystal-spinner.gif");
const FAVICON = path.join(ROOT, "public", "favicon.ico");
const TOUCH_ICON = path.join(ROOT, "public", "apple-touch-icon.png");
const PREVIEW = process.env.PREVIEW;

const SIZE = 32;
const SUPERSAMPLE = 6;
const COVERAGE = 0.5;
const FRAMES = 8;
const DELAY_CS = 12;

const FAVICON_FRAME = 3;
const FAVICON_SCALES = [1, 2];
const TOUCH_ICON_SIZE = 180;
const TOUCH_ICON_SCALE = 5;
/** Copies `--color-ink` in `app.css`; iOS fills a transparent touch icon with black. */
const TOUCH_ICON_BACKGROUND = "#1a1a1a";

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

type Sparkle = { x: number; y: number; arms: readonly number[] };
const SPARKLES: readonly Sparkle[] = [
  { x: 24, y: 5, arms: [0, 0, 1, 2, 1, 0, 0, 0] },
  { x: 7, y: 26, arms: [0, 0, 0, 0, 0, 1, 1, 0] },
];

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

function encodePng(
  px: Uint8Array,
  k: number,
  canvas: number,
  palette: readonly [number, number, number][],
  background?: string,
): Buffer {
  const png = new PNG({ width: canvas, height: canvas });
  const [br, bg, bb] = background ? rgb(background) : [0, 0, 0];
  const ba = background ? 255 : 0;
  for (let i = 0; i < canvas * canvas; i++) png.data.set([br, bg, bb, ba], i * 4);
  const scaled = scale(px, k);
  const side = SIZE * k;
  const offset = Math.floor((canvas - side) / 2);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const index = scaled[y * side + x]!;
      if (index === TRANSPARENT) continue;
      const i = ((y + offset) * canvas + x + offset) * 4;
      png.data.set([...palette[index]!, 255], i);
    }
  }
  return PNG.sync.write(png);
}

/** An ICO file may hold PNG images whole; every browser that reads `.ico` accepts them. */
function encodeIco(images: readonly { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, n) => {
    const entry = 6 + 16 * n;
    /** A dimension of 256 is written as 0; the field is one byte. */
    header.writeUInt8(size % 256, entry);
    header.writeUInt8(size % 256, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.png)]);
}

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

  const still = frames[FAVICON_FRAME]!;
  const ico = encodeIco(
    FAVICON_SCALES.map((k) => ({ size: SIZE * k, png: encodePng(still, k, SIZE * k, palette) })),
  );
  await fs.writeFile(FAVICON, ico);
  console.log(`wrote ${path.relative(ROOT, FAVICON)} (${ico.length} bytes)`);
  const touch = encodePng(still, TOUCH_ICON_SCALE, TOUCH_ICON_SIZE, palette, TOUCH_ICON_BACKGROUND);
  await fs.writeFile(TOUCH_ICON, touch);
  console.log(`wrote ${path.relative(ROOT, TOUCH_ICON)} (${touch.length} bytes)`);
}

await main();
