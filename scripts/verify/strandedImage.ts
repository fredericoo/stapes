import { PNG } from "pngjs";
import { getStack, listCoords, presentLevels } from "../../app/lib/mapData";
import type { MapFile } from "../../app/lib/types";
import type { StrandedReport } from "../../app/verify/stranded";

const PX_PER_CELL = 4;
const FRAME_CELLS = 5;

type Rgb = readonly [number, number, number];

const STRANDED: Rgb = [255, 32, 48];
const WAY_IN: Rgb = [255, 220, 0];
const UNKNOWN: Rgb = [150, 150, 150];

/** Enough of the catalogue to tell land from water from buildings; anything else is drawn grey. */
const COLOUR: Record<string, Rgb> = {
  "deep-water": [28, 48, 110],
  water: [62, 110, 196],
  swamp: [70, 110, 90],
  "grass-2": [84, 160, 82],
  grass: [84, 160, 82],
  "grass-ledge": [84, 160, 82],
  tree: [34, 100, 52],
  "small-bush": [50, 124, 60],
  "picked-bush": [50, 124, 60],
  dirt: [156, 116, 76],
  mud: [104, 82, 56],
  "sand-dunes": [226, 204, 138],
  "sand-ledge": [226, 204, 138],
  "half-stone": [150, 96, 70],
  ramp: [236, 176, 84],
  "stone-stairs": [176, 186, 190],
  cobblestone: [168, 168, 178],
  "wooden-floor": [196, 138, 84],
  "brick-wall": [120, 60, 52],
  "brick-slab": [150, 78, 64],
  "stone-wall": [110, 110, 122],
  sw2: [96, 78, 96],
  plaster: [170, 80, 70],
};

/**
 * A top-down picture of the surface with every stranded cell in red, the cell
 * each way in leaves from in yellow, and a red frame round each place, since
 * a pocket of five cells is five dots on a map this size. Cells below ground
 * are marked where they are, over whatever the surface has there.
 */
export function strandedImage(map: MapFile, report: StrandedReport): Buffer {
  const levels = presentLevels(map).filter((z) => z >= 0);
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const z of levels) {
    for (const { x, y } of listCoords(map, z)) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  if (x0 > x1) return PNG.sync.write(new PNG({ width: 1, height: 1 }));

  const png = new PNG({
    width: (x1 - x0 + 1) * PX_PER_CELL,
    height: (y1 - y0 + 1) * PX_PER_CELL,
  });
  const dot = (px: number, py: number, [r, g, b]: Rgb) => {
    if (px < 0 || py < 0 || px >= png.width || py >= png.height) return;
    const i = (py * png.width + px) * 4;
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  };
  const cell = (x: number, y: number, colour: Rgb) => {
    for (let dy = 0; dy < PX_PER_CELL; dy++) {
      for (let dx = 0; dx < PX_PER_CELL; dx++) {
        dot((x - x0) * PX_PER_CELL + dx, (y - y0) * PX_PER_CELL + dy, colour);
      }
    }
  };

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let colour: Rgb | null = null;
      let height = 0;
      for (const z of levels) {
        const stack = getStack(map, x, y, z);
        if (stack.length === 0) continue;
        height = z;
        for (const placed of stack) colour = COLOUR[placed.tileId] ?? colour ?? UNKNOWN;
      }
      if (!colour) continue;
      const lift = 1 + height * 0.18;
      cell(x, y, [0, 1, 2].map((c) => Math.min(255, colour[c]! * lift)) as unknown as Rgb);
    }
  }

  for (const region of report.regions) {
    for (const entrance of region.entrances) cell(entrance.from.x, entrance.from.y, WAY_IN);
  }
  for (const region of report.regions) {
    for (const at of region.cells) cell(at.x, at.y, STRANDED);
    const left = (Math.min(...region.cells.map((c) => c.x)) - FRAME_CELLS - x0) * PX_PER_CELL;
    const right = (Math.max(...region.cells.map((c) => c.x)) + 1 + FRAME_CELLS - x0) * PX_PER_CELL;
    const top = (Math.min(...region.cells.map((c) => c.y)) - FRAME_CELLS - y0) * PX_PER_CELL;
    const bottom = (Math.max(...region.cells.map((c) => c.y)) + 1 + FRAME_CELLS - y0) * PX_PER_CELL;
    for (let thick = 0; thick < 2; thick++) {
      for (let px = left; px <= right; px++) {
        dot(px, top + thick, STRANDED);
        dot(px, bottom - thick, STRANDED);
      }
      for (let py = top; py <= bottom; py++) {
        dot(left + thick, py, STRANDED);
        dot(right - thick, py, STRANDED);
      }
    }
  }
  return PNG.sync.write(png);
}
