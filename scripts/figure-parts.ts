import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import {
  FRAME_PX,
  PART_IDS,
  OUTLINE_COLOUR,
  PART_EMPTY,
  PART_OUTLINE,
  PART_TONES,
  SHEET_HEIGHT_PX,
  SHEET_WIDTH_PX,
  type FigureParts,
} from "../app/lib/figure";
import FIGURE_PARTS from "../app/lib/figureParts.json";

const ROOT = path.resolve(import.meta.dirname, "..");
const PEOPLE = path.join(ROOT, "data", "tilesets", "people.png");
const PARTS_FILE = path.join(ROOT, "app", "lib", "figureParts.json");

/** The player is the first character block in `people.png` and the naked human the second. */
const CLOTHED_X = 0;
const NAKED_X = SHEET_WIDTH_PX;

/** Frame rows above this hold the head, where the naked human's dark hair is. */
const HEAD_ROWS = 7;

/** Frame rows from this one down hold the feet, where the player's boots are. */
const FEET_ROW = 11;

const SHADOW = 0;
const BASE = 1;
const HIGHLIGHT = 2;
const OUTLINE = -1;

/** The colours `people.png` draws the two figures in, and the tone each stands for. */
const SKIN: Record<string, number> = { "#6e2727": SHADOW, "#cd683d": BASE, "#fbb954": HIGHLIGHT };
const SHIRT: Record<string, number> = { "#9babb2": SHADOW, "#c7dcd0": BASE, "#ffffff": HIGHLIGHT };
const LEGS: Record<string, number> = { "#694f62": SHADOW, "#7f708a": BASE };
const TRIM: Record<string, number> = { "#6e2727": SHADOW, "#ae2334": BASE };

const USAGE = `Edit the paper-doll parts in app/lib/figureParts.json.

  bun run figure-parts extract       re-derive body, hair-short, shirt, trim, trousers and shoes from people.png
  bun run figure-parts export <dir>  write every part to <dir>/<part>.png, to edit in a pixel editor
  bun run figure-parts import <dir>  read <dir>/<part>.png back for every part found there

An exported part is drawn in the outline colour ${OUTLINE_COLOUR} and three greys, shadow to highlight:
${["#595959", "#a6a6a6", "#e6e6e6"].join(" ")}. Keep to those four colours when editing; import refuses any other.`;

/** The greys a part is exported in, shadow to highlight, so it can be edited as a picture. */
const EXPORT_GREYS = ["#595959", "#a6a6a6", "#e6e6e6"];

type Layer = Int8Array;
const EMPTY = -2;

function layer(): Layer {
  return new Int8Array(SHEET_WIDTH_PX * SHEET_HEIGHT_PX).fill(EMPTY);
}

async function extract() {
  const png = PNG.sync.read(await fs.readFile(PEOPLE));
  const colourAt = (sx: number, x: number, y: number): string | null => {
    if (x < 0 || y < 0 || x >= SHEET_WIDTH_PX || y >= SHEET_HEIGHT_PX) return null;
    const i = (y * png.width + sx + x) * 4;
    if (png.data[i + 3] === 0) return null;
    return `#${[png.data[i]!, png.data[i + 1]!, png.data[i + 2]!].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  };

  const layers = {
    body: layer(),
    "hair-short": layer(),
    shirt: layer(),
    trim: layer(),
    trousers: layer(),
    shoes: layer(),
  };

  for (let y = 0; y < SHEET_HEIGHT_PX; y++) {
    for (let x = 0; x < SHEET_WIDTH_PX; x++) {
      const i = y * SHEET_WIDTH_PX + x;
      const frameRow = y % FRAME_PX;
      const naked = colourAt(NAKED_X, x, y);
      const clothed = colourAt(CLOTHED_X, x, y);

      if (naked !== null) {
        /**
         * The naked human's hair is drawn in the outline colour. A dark pixel
         * on the head with nothing transparent beside it is hair rather than
         * outline, so it becomes skin on the body and a pixel of the hair part.
         */
        const enclosed = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].every(([dx, dy]) => colourAt(NAKED_X, x + dx!, y + dy!) !== null);
        if (naked === OUTLINE_COLOUR && enclosed && frameRow < HEAD_ROWS) {
          layers.body[i] = BASE;
          layers["hair-short"][i] = BASE;
        } else {
          layers.body[i] = naked === OUTLINE_COLOUR ? OUTLINE : (SKIN[naked] ?? BASE);
        }
      }

      if (clothed === null || clothed === naked) continue;
      /** Where the player's skin is shaded differently from the naked human's, the player wins, because a look reproduces the player. */
      if (clothed in SKIN && !(clothed in TRIM && naked !== null && naked in SKIN))
        layers.body[i] = SKIN[clothed]!;
      else if (clothed in SHIRT) layers.shirt[i] = SHIRT[clothed]!;
      else if (clothed in LEGS) layers.trousers[i] = LEGS[clothed]!;
      else if (clothed in TRIM) layers.trim[i] = TRIM[clothed]!;
      else if (clothed === OUTLINE_COLOUR && frameRow >= FEET_ROW) layers.shoes[i] = BASE;
      else if (clothed === OUTLINE_COLOUR) layers.shirt[i] = OUTLINE;
    }
  }

  const parts = { ...(FIGURE_PARTS as Partial<FigureParts>) };
  for (const [id, pixels] of Object.entries(layers)) {
    const rows: string[] = [];
    for (let y = 0; y < SHEET_HEIGHT_PX; y++) {
      let row = "";
      for (let x = 0; x < SHEET_WIDTH_PX; x++) {
        const tone = pixels[y * SHEET_WIDTH_PX + x]!;
        row += tone === EMPTY ? PART_EMPTY : tone === OUTLINE ? PART_OUTLINE : PART_TONES[tone];
      }
      rows.push(row);
    }
    parts[id as keyof FigureParts] = rows;
    console.log(`Extracted ${id}`);
  }
  await fs.writeFile(PARTS_FILE, `${JSON.stringify(parts, null, 2)}\n`);
  console.log(`Wrote ${path.relative(ROOT, PARTS_FILE)}`);
}

function hexOf(data: Uint8Array, i: number): string {
  return `#${[data[i]!, data[i + 1]!, data[i + 2]!].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

async function exportParts(dir: string) {
  await fs.mkdir(dir, { recursive: true });
  const parts = FIGURE_PARTS as FigureParts;
  for (const id of PART_IDS) {
    const png = new PNG({ width: SHEET_WIDTH_PX, height: SHEET_HEIGHT_PX });
    parts[id].forEach((row, y) => {
      [...row].forEach((cell, x) => {
        if (cell === PART_EMPTY) return;
        const hex =
          cell === PART_OUTLINE ? OUTLINE_COLOUR : EXPORT_GREYS[PART_TONES.indexOf(cell)]!;
        const n = Number.parseInt(hex.slice(1), 16);
        const i = (y * SHEET_WIDTH_PX + x) * 4;
        png.data[i] = (n >> 16) & 0xff;
        png.data[i + 1] = (n >> 8) & 0xff;
        png.data[i + 2] = n & 0xff;
        png.data[i + 3] = 255;
      });
    });
    await fs.writeFile(path.join(dir, `${id}.png`), PNG.sync.write(png));
  }
  console.log(`Wrote ${PART_IDS.length} parts to ${dir}`);
}

async function importParts(dir: string) {
  const parts = { ...(FIGURE_PARTS as FigureParts) };
  for (const id of PART_IDS) {
    const file = path.join(dir, `${id}.png`);
    const bytes = await fs.readFile(file).catch(() => null);
    if (!bytes) continue;
    const png = PNG.sync.read(bytes);
    if (png.width !== SHEET_WIDTH_PX || png.height !== SHEET_HEIGHT_PX) {
      throw new Error(
        `${file} is ${png.width}x${png.height}; a part is ${SHEET_WIDTH_PX}x${SHEET_HEIGHT_PX}.`,
      );
    }
    const rows: string[] = [];
    for (let y = 0; y < SHEET_HEIGHT_PX; y++) {
      let row = "";
      for (let x = 0; x < SHEET_WIDTH_PX; x++) {
        const i = (y * SHEET_WIDTH_PX + x) * 4;
        if (png.data[i + 3] === 0) {
          row += PART_EMPTY;
          continue;
        }
        const hex = hexOf(png.data, i);
        const tone = EXPORT_GREYS.indexOf(hex);
        if (hex === OUTLINE_COLOUR) row += PART_OUTLINE;
        else if (tone >= 0) row += PART_TONES[tone];
        else
          throw new Error(
            `${file} has ${hex} at ${x}, ${y}, which is not the outline or one of the three greys.`,
          );
      }
      rows.push(row);
    }
    parts[id] = rows;
    console.log(`Read ${id}`);
  }
  await fs.writeFile(PARTS_FILE, `${JSON.stringify(parts, null, 2)}\n`);
  console.log(`Wrote ${path.relative(ROOT, PARTS_FILE)}`);
}

async function main() {
  const [command, dir] = process.argv.slice(2);
  if (command === "extract") return extract();
  if (command === "export" && dir) return exportParts(dir);
  if (command === "import" && dir) return importParts(dir);
  console.log(USAGE);
  if (command !== "--help" && command !== "-h") process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
