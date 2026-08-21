/**
 * Draws the placeholder projectile tileset — one arrow per bearing.
 * Run: pnpm generate:projectiles
 *
 * Additive, and deliberately its own script rather than a section of
 * `generate-tilesets.ts`: that one rewrites `tiles.json` and `map.json`
 * wholesale from scratch, so anything sharing it would take the authored world
 * down with it. This only ever writes one PNG.
 *
 * The art is a placeholder in the honest sense — it is a straight shaft and a
 * head, drawn by arithmetic, and it exists so that a bow is a thing you can pick
 * up and fire today rather than a feature waiting on somebody with a pen. Replace
 * the PNG and nothing else has to change.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { CELL_SIZE, OCTANTS } from "../app/lib/types";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "data", "tilesets", "projectiles.png");

/**
 * Which way each bearing points on screen, as a unit-ish vector.
 *
 * Screen y grows downward, so north is negative. Diagonals are the raw ±1
 * rather than normalised: an arrow drawn on an 8px grid has no room for the
 * difference, and stepping by whole pixels is what keeps the shaft a clean line
 * rather than a stair with a rounding wobble in it.
 */
const HEADING: Record<(typeof OCTANTS)[number], [number, number]> = {
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
  nw: [-1, -1],
};

/** Shaft and head. Two values, so the point of the thing reads at one pixel. */
const SHAFT = [122, 92, 58, 255] as const;
const HEAD = [214, 214, 222, 255] as const;

function plot(png: PNG, x: number, y: number, rgba: readonly number[]) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const i = (png.width * y + x) << 2;
  png.data[i] = rgba[0]!;
  png.data[i + 1] = rgba[1]!;
  png.data[i + 2] = rgba[2]!;
  png.data[i + 3] = rgba[3]!;
}

/**
 * One arrow, centred in its cell and pointing along `heading`.
 *
 * Drawn from the middle outward rather than from a corner: an arrow that is not
 * centred in its cell wobbles as the renderer swaps bearings mid-flight, since
 * the sprite's own offset changes while the thing it depicts does not.
 */
function drawArrow(
  png: PNG,
  cellX: number,
  [dx, dy]: [number, number],
) {
  const cx = cellX * CELL_SIZE + CELL_SIZE / 2;
  const cy = CELL_SIZE / 2;
  const half = CELL_SIZE / 2 - 1;

  for (let t = -half; t <= half; t++) {
    const x = cx + dx * t;
    const y = cy + dy * t;
    plot(png, x, y, t >= half - 1 ? HEAD : SHAFT);
  }

  // Two barbs, one step back from the tip and one step to either side of the
  // shaft. Without them a diagonal arrow is a plain diagonal line and reads as
  // a crack in the tile rather than as something with a direction.
  const tipX = cx + dx * half;
  const tipY = cy + dy * half;
  const barbs: Array<[number, number]> =
    dx === 0 ? [[1, 0], [-1, 0]] : dy === 0 ? [[0, 1], [0, -1]] : [[-dx, 0], [0, -dy]];
  for (const [bx, by] of barbs) {
    plot(png, tipX - dx + bx, tipY - dy + by, HEAD);
  }
}

async function main() {
  const png = new PNG({
    width: OCTANTS.length * CELL_SIZE,
    height: CELL_SIZE,
  });
  png.data.fill(0);

  OCTANTS.forEach((octant, i) => drawArrow(png, i, HEADING[octant]));

  await fs.writeFile(OUT, PNG.sync.write(png));
  console.log(`Generated ${path.relative(ROOT, OUT)} (${OCTANTS.join(", ")})`);
}

main();
