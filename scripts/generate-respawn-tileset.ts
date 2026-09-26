import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { STAPES_PALETTE } from "../app/lib/palette";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "data", "tilesets", "respawn.png");

const CELL = 8;
const FRAMES = 2;

const SHAPE = [
  "..RRRR..",
  ".Rr..rR.",
  "Rr....rR",
  "R..CC..R",
  "R..CC..R",
  "Rr....rR",
  ".Rr..rR.",
  "..RRRR..",
] as const;

const INK: Record<string, readonly [number, number]> = {
  R: [23, 24],
  r: [4, 7],
  C: [24, 29],
};

function paint(png: PNG, frame: number) {
  const originX = frame * CELL;
  for (let y = 0; y < CELL; y++) {
    const row = SHAPE[y]!;
    for (let x = 0; x < CELL; x++) {
      const key = row[x]!;
      if (key === ".") continue;
      const entry = INK[key];
      if (!entry) throw new Error(`no ink for '${key}'`);
      const hex = STAPES_PALETTE[entry[frame]!]!;
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      const i = (png.width * y + originX + x) << 2;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
}

const png = new PNG({ width: CELL * FRAMES, height: CELL });
png.data.fill(0);
for (let frame = 0; frame < FRAMES; frame++) paint(png, frame);

await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, PNG.sync.write(png));
console.log(`wrote ${path.relative(ROOT, OUT)} (${png.width}×${png.height})`);
