import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { CELL_SIZE } from "../app/lib/types";

const ROOT = path.resolve(import.meta.dirname, "..");
const TILESETS = path.join(ROOT, "data", "tilesets");

const BLOCK_COLS = 4;
const BLOCK_ROWS = 4;

const FULL_CELL = { x: 0, y: 0 };

type Block = { x: number; y: number };

const JOBS: { file: string; source: Block; dest: Block }[] = [
  { file: "floors.png", source: { x: 0, y: 4 }, dest: { x: 8, y: 4 } },
];

async function readPng(file: string): Promise<PNG> {
  return PNG.sync.read(await fs.readFile(file));
}

function alphaAt(png: PNG, x: number, y: number): number {
  return png.data[((png.width * y + x) << 2) + 3]!;
}

function copyPixel(png: PNG, from: [number, number], to: [number, number]) {
  const src = (png.width * from[1] + from[0]) << 2;
  const dst = (png.width * to[1] + to[0]) << 2;
  for (let i = 0; i < 4; i++) png.data[dst + i] = png.data[src + i]!;
}

function clearPixel(png: PNG, x: number, y: number) {
  const i = (png.width * y + x) << 2;
  for (let k = 0; k < 4; k++) png.data[i + k] = 0;
}

function complementBlock(png: PNG, source: Block, dest: Block): number {
  const fullX = (source.x + FULL_CELL.x) * CELL_SIZE;
  const fullY = (source.y + FULL_CELL.y) * CELL_SIZE;
  let painted = 0;

  for (let row = 0; row < BLOCK_ROWS; row++) {
    for (let col = 0; col < BLOCK_COLS; col++) {
      for (let py = 0; py < CELL_SIZE; py++) {
        for (let px = 0; px < CELL_SIZE; px++) {
          const sx = (source.x + col) * CELL_SIZE + px;
          const sy = (source.y + row) * CELL_SIZE + py;
          const dx = (dest.x + col) * CELL_SIZE + px;
          const dy = (dest.y + row) * CELL_SIZE + py;

          if (alphaAt(png, sx, sy) > 0) {
            clearPixel(png, dx, dy);
            continue;
          }
          if (alphaAt(png, fullX + px, fullY + py) === 0) {
            clearPixel(png, dx, dy);
            continue;
          }
          copyPixel(png, [fullX + px, fullY + py], [dx, dy]);
          painted++;
        }
      }
    }
  }
  return painted;
}

function assertRegionFree(png: PNG, dest: Block, sourceIsDest: boolean) {
  if (sourceIsDest) throw new Error("destination block overlaps its source");
  for (let row = 0; row < BLOCK_ROWS; row++) {
    for (let col = 0; col < BLOCK_COLS; col++) {
      const x0 = (dest.x + col) * CELL_SIZE;
      const y0 = (dest.y + row) * CELL_SIZE;
      if (x0 + CELL_SIZE > png.width || y0 + CELL_SIZE > png.height) {
        throw new Error(`destination block at ${dest.x},${dest.y} runs off the sheet`);
      }
    }
  }
}

async function main() {
  for (const job of JOBS) {
    const file = path.join(TILESETS, job.file);
    const png = await readPng(file);
    assertRegionFree(png, job.dest, job.source.x === job.dest.x && job.source.y === job.dest.y);
    const painted = complementBlock(png, job.source, job.dest);
    await fs.writeFile(file, PNG.sync.write(png));
    console.log(
      `${job.file}: complement of block ${job.source.x},${job.source.y} ` +
        `written at ${job.dest.x},${job.dest.y} (${painted} px)`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
