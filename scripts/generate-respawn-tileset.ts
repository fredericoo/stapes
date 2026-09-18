/**
 * Draws the respawn point's sheet: `data/tilesets/respawn.png`.
 *
 * Run: `bun run generate:respawn`
 *
 * **Generated rather than drawn, because there is nothing to draw.** Every
 * other sheet in `data/tilesets/` is pixel art somebody made, and opening one
 * in an editor is how it is changed. This tile is a marker with no diegesis
 * behind it — a target on the floor saying "you come back here" — so the honest
 * form for it is eight by eight pixels of geometry with the palette entries
 * named in one place. A script is also the only version of this that can be
 * reviewed: a committed PNG is a blob, and a blob is a thing nobody can say is
 * right or wrong in a diff.
 *
 * Two frames, and the pulse is the point. A floor plate that never moves reads
 * as scenery — the pressure plate beside it in the catalogue is exactly that —
 * and this one has to say "there is something here to press" while the player
 * is standing on top of it and cannot see it at all.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { STAPES_PALETTE } from "../app/lib/palette";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "data", "tilesets", "respawn.png");

/** One cell, which is the whole tile: this is a floor marker, not a thing. */
const CELL = 8;
const FRAMES = 2;

/**
 * The marker, as characters, so the shape is reviewable rather than a list of
 * coordinates. A ring with a square eye — the one shape that reads at eight
 * pixels as "this exact spot" and not as a button, a gem or a hole.
 *
 * - `R` the ring
 * - `r` its inside edge, one step darker, which is what stops the ring reading
 *   as a flat circle of one colour on a busy floor
 * - `C` the eye
 * - `.` nothing, so whatever the marker is lying on shows through it
 */
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

/**
 * What each character is, dim and lit.
 *
 * Every colour is a {@link STAPES_PALETTE} entry by index rather than a hex
 * literal, because a sheet with an off-palette pixel in it is a sheet the
 * quantiser will move the next time anything is regenerated — and then the art
 * in the repository and the art on screen are two different pictures.
 */
const INK: Record<string, readonly [number, number]> = {
  // Indigo (23), then the lighter blue above it (24). The same pair the arcane
  // tiles already use, so a marker on the floor of a cave does not read as a
  // different game's furniture.
  R: [23, 24],
  // Its shadow, one step down each time: near-black purple (4), then the muted
  // indigo (7) that sits under the lit ring without competing with it.
  r: [4, 7],
  // The eye carries the whole of the pulse: the lit blue (24) to the pale mint
  // (29), which is the brightest step in the palette that is not simply white.
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
// `fill: true` is not enough on its own — pngjs leaves the buffer opaque black
// otherwise, and an opaque backdrop is exactly what this sheet must not have.
png.data.fill(0);
for (let frame = 0; frame < FRAMES; frame++) paint(png, frame);

await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, PNG.sync.write(png));
console.log(`wrote ${path.relative(ROOT, OUT)} (${png.width}×${png.height})`);
