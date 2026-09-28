import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import {
  OUTLINE_COLOUR,
  PART_IDS,
  PART_EMPTY,
  PART_OUTLINE,
  PART_TONES,
  SHEET_HEIGHT_PX,
  SHEET_WIDTH_PX,
  type FigureParts,
} from "../app/lib/figure";
import FIGURE_PARTS from "../app/lib/figureParts.json";

const ROOT = path.resolve(import.meta.dirname, "..");
const PARTS_FILE = path.join(ROOT, "app", "lib", "figureParts.json");

/** The greys a part is exported in, shadow to highlight, so it can be edited as a picture. */
const EXPORT_GREYS = ["#595959", "#a6a6a6", "#e6e6e6"];

const USAGE = `Edit the paper-doll parts in app/lib/figureParts.json.

  bun run figure-parts export <dir>  write every part to <dir>/<part>.png, to edit in a pixel editor
  bun run figure-parts import <dir>  read <dir>/<part>.png back for every part found there

An exported part is drawn in the outline colour ${OUTLINE_COLOUR} and three greys, shadow to highlight:
${EXPORT_GREYS.join(" ")}. Keep to those four colours when editing; import refuses any other.`;

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
  if (command === "export" && dir) return exportParts(dir);
  if (command === "import" && dir) return importParts(dir);
  console.log(USAGE);
  if (command !== "--help" && command !== "-h") process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
