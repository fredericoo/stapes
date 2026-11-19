import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { CELL_SIZE, type TileDef, type TileSprite } from "../app/lib/types";
import { paintRgba, readJson, type Rgba, writeTileset } from "./tileset-output";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const TILESET = "cats";

/** The cat's three fur shades in `animals.png`, darkest first. Its outline, `#2e222f`, is kept on every coat. */
const FUR: readonly string[] = ["#cd683d", "#e6904e", "#fbb954"];

type Coat = { id: string; name: string; fur: readonly [string, string, string] };

const COATS: Coat[] = [
  { id: "cat-black", name: "Black Cat", fur: ["#3e3546", "#45293f", "#694f62"] },
  { id: "cat-grey", name: "Grey Cat", fur: ["#7f708a", "#9babb2", "#c7dcd0"] },
  { id: "cat-white", name: "White Cat", fur: ["#c7dcd0", "#ffffff", "#ffffff"] },
  { id: "cat-brown", name: "Brown Cat", fur: ["#6e2727", "#9e4539", "#cd683d"] },
  { id: "cat-cream", name: "Cream Cat", fur: ["#e6904e", "#fbb954", "#ffffff"] },
  { id: "cat-tuxedo", name: "Tuxedo Cat", fur: ["#3e3546", "#45293f", "#ffffff"] },
  { id: "cat-blue", name: "Blue Cat", fur: ["#484a77", "#7f708a", "#9babb2"] },
];

function rgba(hex: string): Rgba {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
}

function hexAt(png: PNG, x: number, y: number): string | null {
  const i = (png.width * y + x) << 2;
  if (png.data[i + 3] === 0) return null;
  return `#${[0, 1, 2].map((c) => png.data[i + c]!.toString(16).padStart(2, "0")).join("")}`;
}

type Rect = { x: number; y: number; w: number; h: number };

function spriteRectsOf(tile: TileDef): Rect[] {
  const sets = [tile.sprites, ...Object.values(tile.states ?? {}).map((s) => s.sprites)];
  return sets.flatMap((set) =>
    Object.values(set ?? {}).flatMap((sprite: TileSprite) =>
      sprite.frames.map((f) => f.sprite.rect),
    ),
  );
}

function uniqueRects(tile: TileDef): Rect[] {
  const rects = spriteRectsOf(tile);
  return [...new Map(rects.map((r) => [`${r.x},${r.y},${r.w},${r.h}`, r])).values()];
}

/**
 * Every coat keeps the cat's frames and their layout, so each coat's rows are
 * the cat's own block of `animals.png` with the fur shades swapped. Coats are
 * stacked one block below another, and each tile's anchor points at its block.
 */
function drawCoats(animals: PNG, cat: TileDef) {
  const rects = uniqueRects(cat);
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const block = {
    w: Math.max(...rects.map((r) => r.x + r.w)) - minX,
    h: Math.max(...rects.map((r) => r.y + r.h)) - minY,
  };
  const sheet = new PNG({
    width: block.w * CELL_SIZE,
    height: block.h * COATS.length * CELL_SIZE,
  });
  sheet.data.fill(0);
  COATS.forEach((coat, c) => {
    const swap = new Map(FUR.map((from, i) => [from, coat.fur[i]!]));
    for (const rect of rects) {
      const x0 = (cat.anchor.x + rect.x) * CELL_SIZE;
      const y0 = (cat.anchor.y + rect.y) * CELL_SIZE;
      const dx = (rect.x - minX) * CELL_SIZE;
      const dy = (rect.y - minY + c * block.h) * CELL_SIZE;
      for (let y = 0; y < rect.h * CELL_SIZE; y++) {
        for (let x = 0; x < rect.w * CELL_SIZE; x++) {
          const hex = hexAt(animals, x0 + x, y0 + y);
          if (hex) paintRgba(sheet, dx + x, dy + y, rgba(swap.get(hex) ?? hex));
        }
      }
    }
  });
  const tiles = COATS.map((coat, c): TileDef => {
    const tile: TileDef = {
      ...structuredClone(cat),
      id: coat.id,
      name: coat.name,
      anchor: { tilesetId: TILESET, x: 0, y: c * block.h },
    };
    for (const rect of spriteRectsOf(tile)) {
      rect.x -= minX;
      rect.y -= minY;
    }
    return tile;
  });
  return { sheet, tiles };
}

async function main() {
  const catalogue = await readJson<TileDef[]>(path.join(DATA, "tiles.json"));
  const cat = catalogue.find((t) => t.id === "cat");
  if (!cat) throw new Error("no cat to recolour");
  const animals = PNG.sync.read(await fs.readFile(path.join(DATA, "tilesets", "animals.png")));
  const { sheet, tiles } = drawCoats(animals, cat);
  await writeTileset(TILESET, "Cats", sheet, tiles);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
