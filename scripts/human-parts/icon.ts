import { writeFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { CELL_SIZE } from "../../app/lib/types";
import { type Bound, type Camera, cast, shade } from "./cast";
import type { Solid } from "./model";
import { TILESETS, hexAt, read } from "./sheet";

const WINDOW = 14;

/**
 * The icons in `equipment.png` are front views, and a thing seen face-on is
 * what reads at eight pixels, so an icon looks at the model's south face from
 * `rise` above it (the slope of the view) rather than through the world's
 * projection.
 */
export function front(rise: number): Camera {
  return { at: (sx, sy) => [sx, 0, -sy], toward: [0, 1, rise] };
}

export const DEFAULT_RISE = 0.45;

/** `equipment.png` is drawn in the PICO-8 colours, so an icon cast in a human ramp is moved to the nearest of them. */
export const EQUIPMENT_INK: Record<string, string> = {
  "#2e222f": "#000000",
  "#3e3546": "#1d2b53",
  "#694f62": "#5f574f",
  "#7f708a": "#83769c",
  "#9babb2": "#c2c3c7",
  "#ffffff": "#fff1e8",
  "#45293f": "#7e2553",
  "#6e2727": "#7e2553",
  "#9e4539": "#ab5236",
  "#e6904e": "#ab5236",
};

/** The colours of one cell of `equipment.png`, by `y * CELL_SIZE + x`. */
export function readIcon([cx, cy]: readonly [number, number]): (string | null)[] {
  const sheet = read("equipment.png");
  const out: (string | null)[] = [];
  for (let y = 0; y < CELL_SIZE; y++)
    for (let x = 0; x < CELL_SIZE; x++)
      out.push(hexAt(sheet, cx * CELL_SIZE + x, cy * CELL_SIZE + y));
  return out;
}

const PX_STEP = 0.02;

/**
 * `solids`, modelled facing south, cast through `front(rise)` around the
 * bound's centre and cropped to one cell around what was drawn, at `px`
 * model units to a pixel or the nearest coarser scale the model fits at.
 */
export function castIcon(
  solids: Solid[],
  bound: Bound,
  px: number,
  rise = DEFAULT_RISE,
): (string | null)[] {
  for (let scale = px; ; scale += PX_STEP) {
    const icon = castAt(solids, bound, scale, rise);
    if (icon) return icon;
  }
}

function castAt(solids: Solid[], bound: Bound, px: number, rise: number): (string | null)[] | null {
  const half = (WINDOW / 2) * px;
  const cells = cast(
    solids,
    [],
    bound,
    {
      width: WINDOW,
      height: WINDOW,
      px,
      origin: [bound.centre[0] - half, -bound.centre[2] - half],
    },
    front(rise),
  );
  const window = shade(
    cells.map((c) => ({ ...c, ramp: solids[c.part]!.ramp })),
    WINDOW * WINDOW,
  );
  const drawn = window.flatMap((c, i) => (c ? [[i % WINDOW, Math.floor(i / WINDOW)]] : []));
  const xs = drawn.map(([x]) => x!);
  const ys = drawn.map(([, y]) => y!);
  const w = Math.max(...xs) - Math.min(...xs) + 1;
  const h = Math.max(...ys) - Math.min(...ys) + 1;
  if (w > CELL_SIZE || h > CELL_SIZE) return null;
  const left = Math.min(...xs) - Math.floor((CELL_SIZE - w) / 2);
  const top = Math.min(...ys) - Math.floor((CELL_SIZE - h) / 2);
  const icon: (string | null)[] = [];
  for (let y = 0; y < CELL_SIZE; y++) {
    for (let x = 0; x < CELL_SIZE; x++) {
      const c = window[(top + y) * WINDOW + left + x] ?? null;
      if (c && !EQUIPMENT_INK[c]) throw new Error(`${c} has no PICO-8 colour in EQUIPMENT_INK`);
      icon.push(c ? EQUIPMENT_INK[c]! : null);
    }
  }
  return icon;
}

/** pngjs's defaults (adaptive filters, run-length deflate) write this sheet four times larger than unfiltered, ordinary deflate. */
const ICON_SHEET_ENCODING = { deflateLevel: 9, filterType: 0, deflateStrategy: 0 };

export function writeIcon([cx, cy]: readonly [number, number], icon: (string | null)[]) {
  const sheet = read("equipment.png");
  icon.forEach((c, i) => {
    const x = cx * CELL_SIZE + (i % CELL_SIZE);
    const y = cy * CELL_SIZE + Math.floor(i / CELL_SIZE);
    const n = c ? Number.parseInt(c.slice(1), 16) : 0;
    sheet.data.set(
      [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, c ? 255 : 0],
      (y * sheet.width + x) * 4,
    );
  });
  writeFileSync(path.join(TILESETS, "equipment.png"), PNG.sync.write(sheet, ICON_SHEET_ENCODING));
}

const ICON_PREVIEW_SCALE = 12;

/** The cells `icons` of `equipment.png` side by side at 12×, for a `PREVIEW` directory. */
export function writeIconPreview(file: string, icons: (readonly [number, number])[]) {
  const equipment = read("equipment.png");
  const size = CELL_SIZE * ICON_PREVIEW_SCALE;
  const png = new PNG({ width: icons.length * size, height: size });
  icons.forEach(([cx, cy], k) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const c =
          hexAt(
            equipment,
            cx * CELL_SIZE + Math.floor(x / ICON_PREVIEW_SCALE),
            cy * CELL_SIZE + Math.floor(y / ICON_PREVIEW_SCALE),
          ) ?? "#5a8c5a";
        const n = Number.parseInt(c.slice(1), 16);
        png.data.set(
          [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255],
          (y * png.width + k * size + x) * 4,
        );
      }
    }
  });
  writeFileSync(file, PNG.sync.write(png));
}
