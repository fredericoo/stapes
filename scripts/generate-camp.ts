import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import type { TileDef } from "../app/lib/types";
import { paintRgba, type Rgba, writeTileset } from "./tileset-output";

const TILESET_ID = "camp";
const SOURCE = path.join(import.meta.dirname, "..", "data", "tilesets", "tiny-ranch-tiles.png");

/**
 * The two canvas tents drawn in the tiny-ranch sheet, as pixel boxes there. They
 * sit half a cell off that sheet's grid, so they are copied onto this one,
 * each into the south-east corner of a three-cell square.
 */
const TENTS = [
  { id: "tent", name: "Tent", from: { x: 68, y: 220, w: 21, h: 20 } },
  { id: "tent-2", name: "Tent", from: { x: 92, y: 220, w: 20, h: 20 } },
];
const TENT_CELLS = 3;

const C: Record<string, Rgba> = {
  O: [50, 51, 83, 255],
  P: [199, 220, 208, 255],
  p: [155, 171, 178, 255],
  L: [77, 155, 230, 255],
  B: [77, 101, 180, 255],
  D: [72, 74, 119, 255],
};

/**
 * A blanket rolled out flat along a row of two cells, pillow to the west; its
 * south edge is the roll's thickness. Lying east to west it reads as flat,
 * where one drawn north to south reads as a board standing up.
 */
const BEDROLL = [
  "................",
  "................",
  ".OOOOOOOOOOOOOO.",
  ".OPPpLBBBLBBBBO.",
  ".OPPpLBBBBBLBBO.",
  ".OPPpLBBBBBBBBO.",
  ".ODDDDDDDDDDDDO.",
  "..OOOOOOOOOOOO..",
];
const BEDROLL_CELL = { x: 0, y: TENT_CELLS };

function still(
  rect: { x: number; y: number; w: number; h: number },
  base: { x: number; y: number },
) {
  return { frames: [{ sprite: { rect, base }, durationMs: 200 }] };
}

function tiles(): TileDef[] {
  const tents = TENTS.map(
    ({ id, name }, i) =>
      ({
        id,
        name,
        height: 3,
        type: "simple",
        kind: "prop",
        attributes: {},
        anchor: { tilesetId: TILESET_ID, x: i * TENT_CELLS, y: 0 },
        lightPassing: true,
        walkable: false,
        footprint: { w: 2, d: 2 },
        sprite: still({ x: 0, y: 0, w: TENT_CELLS, h: TENT_CELLS }, { x: 2, y: 2 }),
      }) as TileDef,
  );
  const bedroll = {
    id: "bedroll",
    name: "Bedroll",
    height: 0,
    type: "simple",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET_ID, ...BEDROLL_CELL },
    lightPassing: true,
    footprint: { w: 2, d: 1 },
    sprite: still({ x: 0, y: 0, w: 2, h: 1 }, { x: 1, y: 0 }),
  } as TileDef;
  return [...tents, bedroll];
}

async function main() {
  const source = PNG.sync.read(await fs.readFile(SOURCE));
  const cell = 8;
  const sheet = new PNG({
    width: TENTS.length * TENT_CELLS * cell,
    height: (TENT_CELLS + 1) * cell,
  });
  sheet.data.fill(0);
  for (const [i, { from }] of TENTS.entries()) {
    const left = (i + 1) * TENT_CELLS * cell - from.w;
    const top = TENT_CELLS * cell - from.h;
    for (let y = 0; y < from.h; y++) {
      for (let x = 0; x < from.w; x++) {
        const at = ((from.y + y) * source.width + from.x + x) * 4;
        const rgba = [...source.data.subarray(at, at + 4)] as Rgba;
        if (rgba[3] > 0) paintRgba(sheet, left + x, top + y, rgba);
      }
    }
  }
  for (const [y, row] of BEDROLL.entries()) {
    for (const [x, key] of [...row].entries()) {
      const colour = C[key];
      if (colour) paintRgba(sheet, BEDROLL_CELL.x * cell + x, BEDROLL_CELL.y * cell + y, colour);
    }
  }
  await writeTileset(TILESET_ID, "Camp", sheet, tiles());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
