import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const TILESETS = path.join(ROOT, "data", "tilesets");
const NORMAL_SUFFIX = "_normal.png";

const OPAQUE_ALPHA = 128;
/** Pixels further than this from a transparent one sit on the sprite's flat top. */
const BEVEL_PX = 2;
const EDGE_WEIGHT = 0.7;
const LUMA_WEIGHT = 0.3;
const SLOPE_GAIN = 2.5;
const CHANNEL_MAX = 255;
const RGBA = 4;

type Sheet = { width: number; height: number; data: Buffer };

function opaque(sheet: Sheet, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= sheet.width || y >= sheet.height) return false;
  return sheet.data[(y * sheet.width + x) * RGBA + 3]! >= OPAQUE_ALPHA;
}

function insetPx(sheet: Sheet, x: number, y: number): number {
  for (let r = 1; r <= BEVEL_PX; r++) {
    if (ringHasGap(sheet, x, y, r)) return r - 1;
  }
  return BEVEL_PX;
}

function ringHasGap(sheet: Sheet, x: number, y: number, r: number): boolean {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) === r && !opaque(sheet, x + dx, y + dy)) return true;
    }
  }
  return false;
}

/** Rec. 601 weights; the art is sRGB, and a bump only needs relative brightness. */
function luma(sheet: Sheet, i: number): number {
  const d = sheet.data;
  return (0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!) / CHANNEL_MAX;
}

function heightField(sheet: Sheet): Float32Array {
  const heights = new Float32Array(sheet.width * sheet.height);
  for (let y = 0; y < sheet.height; y++) {
    for (let x = 0; x < sheet.width; x++) {
      if (!opaque(sheet, x, y)) continue;
      const p = y * sheet.width + x;
      const edge = (insetPx(sheet, x, y) + 1) / (BEVEL_PX + 1);
      heights[p] = edge * EDGE_WEIGHT + luma(sheet, p * RGBA) * LUMA_WEIGHT;
    }
  }
  return heights;
}

function heightAt(sheet: Sheet, heights: Float32Array, x: number, y: number, fallback: number) {
  if (x < 0 || y < 0 || x >= sheet.width || y >= sheet.height) return fallback;
  return heights[y * sheet.width + x]!;
}

/** Normal-map y points up the image, so a height rising down the rows tilts the normal up. */
function normalMap(sheet: Sheet): PNG {
  const heights = heightField(sheet);
  const out = new PNG({ width: sheet.width, height: sheet.height });
  for (let y = 0; y < sheet.height; y++) {
    for (let x = 0; x < sheet.width; x++) {
      const p = y * sheet.width + x;
      const o = p * RGBA;
      if (!opaque(sheet, x, y)) continue;
      const h = heights[p]!;
      const dx = heightAt(sheet, heights, x + 1, y, h) - heightAt(sheet, heights, x - 1, y, h);
      const dy = heightAt(sheet, heights, x, y + 1, h) - heightAt(sheet, heights, x, y - 1, h);
      const nx = -dx * SLOPE_GAIN;
      const ny = dy * SLOPE_GAIN;
      const len = Math.hypot(nx, ny, 1);
      out.data[o] = Math.round(((nx / len) * 0.5 + 0.5) * CHANNEL_MAX);
      out.data[o + 1] = Math.round(((ny / len) * 0.5 + 0.5) * CHANNEL_MAX);
      out.data[o + 2] = Math.round(((1 / len) * 0.5 + 0.5) * CHANNEL_MAX);
      out.data[o + 3] = CHANNEL_MAX;
    }
  }
  return out;
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: bun run generate:normals <sheet.png> [...]");
  process.exit(1);
}
for (const file of files) {
  const source = path.join(TILESETS, file);
  const sheet = PNG.sync.read(await fs.readFile(source));
  const target = source.replace(/\.png$/, NORMAL_SUFFIX);
  await fs.writeFile(target, PNG.sync.write(normalMap(sheet)));
  console.log(`wrote ${path.relative(ROOT, target)}`);
}
