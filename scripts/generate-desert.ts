import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { resolveScatterIndex } from "../app/lib/scatter";
import { CELL_SIZE, HEIGHT_PER_LEVEL, type TileDef, type TileSprite } from "../app/lib/types";
import { castSprite, type Capsule, type Hit, type Vec3 } from "./limb-caster";
import { paint, paintRgba, paletteRgba, writeTileset } from "./tileset-output";

const TILESET = "desert";
const FRAME_MS = 200;

const SAND = 19;
const DENT = 18;
const HOLLOW = 13;

const BONE_LIGHT = 28;
const BONE = 27;
const BONE_SHADE = 25;
const SOCKET = 4;

const CACTUS_RAMP = [20, 16, 15, 6];
const BLOOM_RAMP = [14, 14, 9, 3];

const SHEET_CELLS = { w: 9, h: 5 };
const SAND_ROW = 0;
const BONES_ROW = 1;
const CACTI_ROW = 2;

/**
 * Every face keeps its border plain sand, and only its inner 6x6 carries a
 * dent. That is what lets the scatter put any face beside any other without a
 * seam, and `drawGrid` refuses a sand face that breaks it.
 */
const SAND_FACES: readonly (readonly string[])[] = [
  ["........", "........", "........", "........", "........", "........", "........", "........"],
  ["........", "........", "........", ".d....d.", "..dddd..", "........", "........", "........"],
  ["........", "...dd...", "..d.....", "..dH....", "...d....", "........", "........", "........"],
  ["........", ".d..d...", "..dd....", "........", "........", "...d..d.", "....dd..", "........"],
  ["........", "........", "......d.", ".....d..", "..ddd...", ".d......", "........", "........"],
  ["........", "........", "........", "...d.d..", "....d...", "........", "........", "........"],
];

/** The plain face is listed this many extra times, so most of the ground is smooth sand. */
const PLAIN_REPEATS = 40;

const SAND_INK: Record<string, number | null> = { ".": SAND, d: DENT, H: HOLLOW };

const BONE_FACES: readonly (readonly string[])[] = [
  ["w......w", "bw....wb", ".bwwwwb.", ".wkwwkw.", "..wwws..", "..bwws..", "...ss...", "........"],
  ["........", ".wwbbbs.", "w.w.b.s.", "b.b.b.s.", "b.b.s.s.", ".s.s.s..", "........", "........"],
  ["........", ".w......", "wbb.....", "..bb....", "...bbw..", "....ww..", "......b.", ".....bs."],
  ["........", "........", "..www...", ".wbwbs..", ".wkwks..", "..wws...", "...b.s..", "........"],
];

const BONE_INK: Record<string, number | null> = {
  ".": null,
  w: BONE_LIGHT,
  b: BONE,
  s: BONE_SHADE,
  k: SOCKET,
};

function onBorder(x: number, y: number) {
  return x === 0 || y === 0 || x === CELL_SIZE - 1 || y === CELL_SIZE - 1;
}

function drawGrid(
  sheet: PNG,
  grid: readonly string[],
  ink: Record<string, number | null>,
  cell: { x: number; y: number },
  plainBorder: boolean,
) {
  for (let y = 0; y < CELL_SIZE; y++) {
    for (let x = 0; x < CELL_SIZE; x++) {
      const key = grid[y]![x]!;
      if (!(key in ink)) throw new Error(`no ink for '${key}'`);
      if (plainBorder && onBorder(x, y) && key !== ".") {
        throw new Error(`a sand face marks its border at (${x}, ${y}), so it would show a seam`);
      }
      const index = ink[key];
      if (index != null) paint(sheet, cell.x * CELL_SIZE + x, cell.y * CELL_SIZE + y, index);
    }
  }
}

const DUNES_TILESET = "desert-dunes";

/**
 * A dune is a height field cast through the game's projection, so its crest
 * lifts up and to the left like everything else that stands. The crest runs
 * along the 45-degree diagonal from south-west to north-east: a long windward
 * slope to the north-west, a short slip face to the south-east, and ends that
 * taper to nothing. `hornPx` bends both ends downwind into a crescent, and
 * `bendPx` pushes one end each way, into an S.
 */
type Dune = {
  tileId: string;
  name: string;
  cells: number;
  column: number;
  heightPx: number;
  lengthPx: number;
  windwardPx: number;
  slipPx: number;
  hornPx: number;
  bendPx: number;
};

const DUNES: readonly Dune[] = [
  {
    tileId: "sand-dune",
    name: "Sand dune",
    cells: 4,
    column: 0,
    heightPx: 3,
    lengthPx: 30,
    windwardPx: 7,
    slipPx: 3,
    hornPx: 1,
    bendPx: 1.5,
  },
  {
    tileId: "sand-dune-crescent",
    name: "Crescent dune",
    cells: 4,
    column: 4,
    heightPx: 3.5,
    lengthPx: 28,
    windwardPx: 7,
    slipPx: 3.5,
    hornPx: 6,
    bendPx: 0,
  },
];

/** The dune sits this far south-east of its sprite's middle, so the lifted crest stays inside. */
const DUNE_NUDGE_PX = 1.5;

function smooth(t: number) {
  return t * t * (3 - 2 * t);
}

type DunePoint = { height: number; slip: number; ridge: number };

/** `slip` runs from 1 on the crest to 0 at the foot of the slip face, and is 0 on the windward side. */
function dunePoint(dune: Dune, x: number, y: number): DunePoint {
  const middle = (dune.cells * CELL_SIZE) / 2 + DUNE_NUDGE_PX;
  const across = (x - middle + (y - middle)) / Math.SQRT2;
  const along = (x - middle - (y - middle)) / Math.SQRT2;
  const half = dune.lengthPx / 2;
  if (Math.abs(along) >= half) return { height: 0, slip: 0, ridge: 0 };
  const ridge = dune.heightPx * Math.cos((Math.PI / 2) * (along / half)) ** 2;
  const curve =
    dune.hornPx * (along / half) ** 2 + dune.bendPx * Math.sin((Math.PI * along) / half);
  const off = across - curve;
  const t = off <= 0 ? 1 + off / dune.windwardPx : 1 - off / dune.slipPx;
  if (t <= 0) return { height: 0, slip: 0, ridge };
  return { height: ridge * smooth(t), slip: off > 0 ? t : 0, ridge };
}

/**
 * The slip face is shadow over the sand, deepest at the crest and thinning
 * towards its foot; the windward slope is left as plain sand. A shadow fainter
 * than `SHADE_FLOOR` is dropped, because the palette pass snaps a faint
 * shadow over sand to an orange brighter than the sand, which outlines the
 * dune. The ink is darker than the sand's own shadows because daylight
 * brightens the sprite before the palette pass, and the sand's shadow colour
 * would land on that orange.
 */
const DUNE_SHADOW = 11;
const SHADE_FOOT = 0.4;
const SHADE_CREST = 0.85;
const CREST_LINE = 0.8;
const SHADE_FLOOR = 0.3;
const RIDGE_FLOOR = 0.35;
const DUNE_SAMPLES = 3;
const DUNE_STEP_PX = 1 / 16;

/**
 * How much shadow one view ray sees where it meets the dune, as an opacity
 * over the sand. The crest is 1, and `drawDune` asks it of the pixel's centre
 * alone, so the crest stays one solid line rather than being averaged away.
 */
function duneShade(dune: Dune, u: number, v: number): number {
  for (let z = dune.heightPx + 1; z >= 0; z -= DUNE_STEP_PX) {
    const point = dunePoint(dune, u + z, v + z);
    if (point.height < z) continue;
    if (point.slip <= 0 || point.ridge < dune.heightPx * RIDGE_FLOOR) return 0;
    if (point.slip > CREST_LINE) return 1;
    return SHADE_FOOT + (SHADE_CREST - SHADE_FOOT) * point.slip;
  }
  return 0;
}

function drawDune(sheet: PNG, dune: Dune) {
  const size = dune.cells * CELL_SIZE;
  const [r, g, b] = paletteRgba(DUNE_SHADOW);
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      if (duneShade(dune, u + 0.5, v + 0.5) === 1) {
        paintRgba(sheet, dune.column * CELL_SIZE + u, v, [r, g, b, 255]);
        continue;
      }
      let shade = 0;
      for (let j = 0; j < DUNE_SAMPLES; j++) {
        for (let i = 0; i < DUNE_SAMPLES; i++) {
          shade += duneShade(dune, u + (i + 0.5) / DUNE_SAMPLES, v + (j + 0.5) / DUNE_SAMPLES);
        }
      }
      const share = shade / DUNE_SAMPLES ** 2;
      const alpha = share < SHADE_FLOOR ? 0 : Math.round(share * 255);
      if (alpha > 0) paintRgba(sheet, dune.column * CELL_SIZE + u, v, [r, g, b, alpha]);
    }
  }
}

type Limb = Capsule & { ramp: readonly number[]; ribs?: number };

type Cactus = {
  tileId: string;
  name: string;
  height: TileDef["height"];
  column: number;
  limbs: readonly Limb[];
};

const MIDDLE = CELL_SIZE / 2;

function stem(from: Vec3, to: Vec3, radiusFrom: number, radiusTo: number, ribs?: number): Limb {
  return { from, to, radiusFrom, radiusTo, ramp: CACTUS_RAMP, ribs };
}

function bloom(at: Vec3, radius: number): Limb {
  const to: Vec3 = [at[0], at[1], at[2] + 0.2];
  return { from: at, to, radiusFrom: radius, radiusTo: radius, ramp: BLOOM_RAMP };
}

const SAGUARO_RIBS = 8;
const BARREL_RIBS = 10;

/** Points are in pixels of the standing cell, `z` up; the cell's middle is 4, 4. */
const CACTI: readonly Cactus[] = [
  {
    tileId: "saguaro",
    name: "Saguaro",
    height: HEIGHT_PER_LEVEL,
    column: 0,
    limbs: [
      stem([MIDDLE, MIDDLE, 0], [MIDDLE, MIDDLE, 13], 2, 1.7, SAGUARO_RIBS),
      stem([MIDDLE, MIDDLE, 5], [6.6, 1.4, 5.6], 1.1, 1.1, SAGUARO_RIBS),
      stem([6.6, 1.4, 5.6], [6.6, 1.4, 10], 1.1, 1, SAGUARO_RIBS),
      stem([MIDDLE, MIDDLE, 7], [1.6, 6.4, 7.6], 1.1, 1.1, SAGUARO_RIBS),
      stem([1.6, 6.4, 7.6], [1.6, 6.4, 11.5], 1.1, 1, SAGUARO_RIBS),
    ],
  },
  {
    tileId: "barrel-cactus",
    name: "Barrel cactus",
    height: 2,
    column: 3,
    limbs: [
      bloom([MIDDLE, MIDDLE, 5.3], 0.9),
      stem([MIDDLE, MIDDLE, 2.5], [MIDDLE, MIDDLE, 2.8], 2.6, 2.5, BARREL_RIBS),
    ],
  },
  {
    tileId: "prickly-pear",
    name: "Prickly pear",
    height: 2,
    column: 6,
    limbs: [
      bloom([7, 1.4, 8], 0.7),
      bloom([1.2, 6.8, 7.8], 0.7),
      stem([MIDDLE, MIDDLE, 1.8], [MIDDLE, MIDDLE, 3.6], 2, 1.9),
      stem([5.6, 2.4, 4.4], [6.6, 1.6, 6.4], 1.6, 1.4),
      stem([2.4, 5.6, 4.6], [1.6, 6.4, 6.4], 1.5, 1.3),
    ],
  },
];

const CACTUS_CELLS = 3;
const CACTUS_PX = CACTUS_CELLS * CELL_SIZE;
const PROJECTION = {
  spritePx: CACTUS_PX,
  groundPx: CACTUS_PX - CELL_SIZE,
  topPx: CACTUS_PX - 2,
};

/**
 * Lit from the south-west, banded as the swamp trees are. A ribbed stem darkens
 * one band in a stripe every `ribs`th of the way round, which is what makes it
 * read as a cactus and not a smooth post.
 */
function shadeCactus({ normal, limb }: Hit<Limb>): number {
  const { ramp } = limb;
  const across = (normal[0] - normal[1]) / Math.SQRT2 - normal[2] * 0.5;
  let band = Math.floor(((across + 1) / 2) * ramp.length);
  if (limb.ribs) {
    const turn = (Math.atan2(normal[1], normal[0]) / (2 * Math.PI) + 1) * limb.ribs;
    if (turn % 1 < 0.3) band += 1;
  }
  return ramp[Math.max(0, Math.min(ramp.length - 1, band))]!;
}

function cellSprite(rect: { x: number; y: number; w: number; h: number }): TileSprite {
  return {
    frames: [{ sprite: { rect, base: { x: rect.w - 1, y: rect.h - 1 } }, durationMs: FRAME_MS }],
  };
}

function tiles(): TileDef[] {
  const sand: TileDef = {
    id: "sand-dunes",
    name: "Sand dunes",
    height: 0,
    type: "scatter",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET, x: 0, y: SAND_ROW },
    scatter: [
      ...SAND_FACES.map((_, i) => cellSprite({ x: i, y: 0, w: 1, h: 1 })),
      ...Array.from({ length: PLAIN_REPEATS }, () => cellSprite({ x: 0, y: 0, w: 1, h: 1 })),
    ],
  };
  const bones: TileDef = {
    id: "bleached-bones",
    name: "Bleached bones",
    height: 0,
    type: "scatter",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET, x: 0, y: BONES_ROW },
    lightPassing: true,
    intangible: true,
    scatter: BONE_FACES.map((_, i) => cellSprite({ x: i, y: 0, w: 1, h: 1 })),
  };
  const dunes = DUNES.map((dune): TileDef => ({
    id: dune.tileId,
    name: dune.name,
    height: 0,
    type: "simple",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: DUNES_TILESET, x: dune.column, y: 0 },
    lightPassing: true,
    intangible: true,
    footprint: { w: dune.cells, d: dune.cells },
    sprite: cellSprite({ x: 0, y: 0, w: dune.cells, h: dune.cells }),
  }));
  const cacti = CACTI.map((cactus): TileDef => ({
    id: cactus.tileId,
    name: cactus.name,
    height: cactus.height,
    type: "simple",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET, x: cactus.column, y: CACTI_ROW },
    walkable: false,
    lightPassing: true,
    sprite: cellSprite({ x: 0, y: 0, w: CACTUS_CELLS, h: CACTUS_CELLS }),
  }));
  return [sand, bones, ...dunes, ...cacti];
}

const PREVIEW_CELLS = 16;
const PREVIEW_SCALE = 6;

/** The same pick the renderer makes per cell, so the preview shows the field a player sees. */
async function writePreview(dir: string, sheet: PNG, sand: TileDef) {
  const side = PREVIEW_CELLS * CELL_SIZE * PREVIEW_SCALE;
  const out = new PNG({ width: side, height: side });
  const cellPx = CELL_SIZE * PREVIEW_SCALE;
  for (let cy = 0; cy < PREVIEW_CELLS; cy++) {
    for (let cx = 0; cx < PREVIEW_CELLS; cx++) {
      const pick = resolveScatterIndex(cx, cy, 0, sand, sand.scatter!.length);
      const face = pick < SAND_FACES.length ? pick : 0;
      for (let py = 0; py < cellPx; py++) {
        for (let px = 0; px < cellPx; px++) {
          const fromX = face * CELL_SIZE + Math.floor(px / PREVIEW_SCALE);
          const from = (sheet.width * Math.floor(py / PREVIEW_SCALE) + fromX) << 2;
          const to = (side * (cy * cellPx + py) + cx * cellPx + px) << 2;
          sheet.data.copy(out.data, to, from, from + 4);
        }
      }
    }
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "sand-dunes.png"), PNG.sync.write(out));
}

async function main() {
  const sheet = new PNG({ width: SHEET_CELLS.w * CELL_SIZE, height: SHEET_CELLS.h * CELL_SIZE });
  /** pngjs leaves the buffer opaque black; the props need a transparent backdrop. */
  sheet.data.fill(0);
  SAND_FACES.forEach((face, i) => drawGrid(sheet, face, SAND_INK, { x: i, y: SAND_ROW }, true));
  BONE_FACES.forEach((face, i) => drawGrid(sheet, face, BONE_INK, { x: i, y: BONES_ROW }, false));
  for (const cactus of CACTI) {
    castSprite(cactus.limbs, PROJECTION, shadeCactus, (u, v, index) =>
      paint(sheet, cactus.column * CELL_SIZE + u, CACTI_ROW * CELL_SIZE + v, index),
    );
  }
  const generated = tiles();
  const dunes = new PNG({
    width: DUNES.reduce((w, d) => w + d.cells, 0) * CELL_SIZE,
    height: Math.max(...DUNES.map((d) => d.cells)) * CELL_SIZE,
  });
  dunes.data.fill(0);
  for (const dune of DUNES) drawDune(dunes, dune);
  const onDunes = new Set(DUNES.map((d) => d.tileId));
  await writeTileset(
    TILESET,
    "Desert",
    sheet,
    generated.filter((t) => !onDunes.has(t.id)),
  );
  await writeTileset(
    DUNES_TILESET,
    "Desert Dunes",
    dunes,
    generated.filter((t) => onDunes.has(t.id)),
    { translucent: true },
  );
  const preview = process.env.PREVIEW;
  if (preview) await writePreview(preview, sheet, generated[0]!);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
