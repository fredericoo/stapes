import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { STAPES_PALETTE } from "../app/lib/palette";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = path.join(ROOT, "data", "tilesets", "tiny-ranch-tiles.png");
const OUT = path.join(ROOT, "data", "tilesets", "spell-projectiles.png");

const CELL = 8;
const ORB = 3 * CELL;
const SHEET_W = 8 * ORB;
const SMALL_ROWS = 5;
const ORB_ROWS = 3;
const QUARTER_TURNS = 4;

type Box = { x: number; y: number; w: number; h: number };

/** The falling star at tiny-ranch (12, 14), flying up and to the left with its tail behind it. */
const COMET: Box = { x: 96, y: 112, w: 16, h: 16 };
/** The four-point sparkle at tiny-ranch (4, 23), nine pixels across. */
const SPARKLE: Box = { x: 30, y: 190, w: 9, h: 9 };
/** The fern at tiny-ranch (18, 18). */
const FERN: Box = { x: 144, y: 144, w: 16, h: 16 };
/** The smallest of the three flames at tiny-ranch (0, 23). */
const FLAME: Box = { x: 2, y: 187, w: 5, h: 11 };
const BUBBLE_FRAMES: Box[] = [64, 88, 112, 136].map((x) => ({ x, y: 184, w: ORB, h: ORB }));

/** A pixel names a key into an `Ink`: a role for hand-drawn and role-mapped art, a source colour for recoloured art. */
type Pixel = { x: number; y: number; key: string };
type Ink = Record<string, number>;

const COMET_ROLES: Record<string, string> = {
  "#ffffff": "c",
  "#fbb954": "h",
  "#fb6b1d": "m",
  "#981c00": "d",
  "#9e4539": "t",
  "#45293f": "t",
};
const SPARKLE_ROLES: Record<string, string> = {
  "#fcfcfc": "c",
  "#affcdb": "h",
  "#53d5cf": "m",
  "#4d9be6": "d",
};
const FLAME_ROLES: Record<string, string> = {
  "#fcd8c4": "c",
  "#fbb954": "h",
  "#f79617": "m",
  "#e83b3b": "d",
};
/**
 * The flame is eleven pixels tall. Dropping two rows of its thin tail and one
 * of the three identical rows of its body fits it in a cell without losing the
 * tip or the outline.
 */
const FLAME_ROWS_DROPPED = new Set([1, 3, 7]);
const FERN_ROLES: Record<string, string> = {
  "#1ebc73": "h",
  "#239063": "m",
  "#165a4c": "d",
  "#2e222f": "o",
};

/** Indices into `STAPES_PALETTE`, so every pixel written is one the palette pass keeps. */
const VIOLET: Ink = { c: 28, h: 26, m: 26, d: 7, t: 32 };
const VIOLET_TWINKLE: Ink = { c: 26, h: 28, m: 26, d: 7, t: 32 };
const ICE: Ink = { c: 28, h: 29, m: 30, d: 24, t: 31 };
const THORN: Ink = { c: 21, h: 20, m: 16, d: 6 };
const LEAF: Ink = { c: 21, h: 20, m: 16, d: 15, o: 0 };
const BRAMBLE: Ink = { h: 21, m: 20, d: 16, o: 6 };
const FIRE: Ink = { c: 28, h: 19, m: 12, d: 9, t: 11 };
const FIRE_FLICKER: Ink = { c: 19, h: 28, m: 12, d: 9, t: 11 };
const FLAME_INK: Ink = { c: 28, h: 19, m: 17, d: 10 };
const FLAME_FLICKER: Ink = { c: 19, h: 28, m: 17, d: 10 };
const FROZEN_BUBBLE: Ink = {
  "#fcfcfc": 28,
  "#affcdb": 28,
  "#53d5cf": 29,
  "#4d9be6": 30,
  "#225ac0": 24,
};

/**
 * The sheet has no straight flight of the star and nothing sharp enough for a
 * thorn or a leaf, so these are drawn here in the letters the inks read: c core,
 * h highlight, m mid, d deep, t tail, o outline. The `WEST` drawings fly west.
 */
const COMET_WEST = ["..hm....", ".hcmddtt", "..mdt.t."];
const SHARD_WEST = ["..hmm...", "chcmmdd.", "..hmdd.."];
const THORN_NORTH_WEST = ["c.......", ".hh.....", ".hmm....", "..mmd...", "...mdd..", "....dd.."];
const THORN_WEST = ["..hhm...", "chmmmdd.", "..mmdd.."];
/** The flame flying north-west, head first, its tip trailing; symmetric about the diagonal. */
const FLAME_NORTH_WEST = [
  ".ddd....",
  "dmhhmd..",
  "dhcchm..",
  "dhchhmd.",
  ".mhhmmd.",
  ".dmmmmd.",
  "...dddm.",
  ".......d",
];
/** A trident: three prongs on a crossbar, then a shaft that darkens to its butt. */
const TRIDENT_WEST = [
  "chhhd...............",
  ".....h..............",
  "chhhhhhhhhhhhhddddtt",
  ".....h..............",
  "chhhd...............",
];
const TRIDENT_NORTH_WEST = [
  "....c.............",
  ".c...h............",
  "..h...h...........",
  "...h...h..........",
  "c...h.h...........",
  ".h...h............",
  "..h.h.ht..........",
  "...h...ht.........",
  "........ht........",
  ".........ht.......",
  "..........ht......",
  "...........dt.....",
  "............dt....",
  ".............dt...",
  "..............dt..",
  "...............t..",
  "................t.",
  ".................t",
];
const LEAF_DRAWN = [
  ".....ooo",
  "...oohho",
  "..ohhcmo",
  ".ohhcmmo",
  "ohhcmmo.",
  "ohcmmo..",
  ".ocoo...",
  "o.......",
];

function hexAt(png: PNG, x: number, y: number): string | null {
  const i = (png.width * y + x) << 2;
  if (png.data[i + 3] === 0) return null;
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(png.data[i]!)}${hex(png.data[i + 1]!)}${hex(png.data[i + 2]!)}`;
}

/** Cuts a box out of the sheet, naming each pixel by its role, or by its own colour when no roles are given. */
function cut(sheet: PNG, box: Box, roles?: Record<string, string>): Pixel[] {
  const out: Pixel[] = [];
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const hex = hexAt(sheet, box.x + x, box.y + y);
      if (!hex) continue;
      const key = roles ? roles[hex] : hex;
      if (!key) throw new Error(`no role for ${hex} at ${box.x + x},${box.y + y}`);
      out.push({ x, y, key });
    }
  }
  return out;
}

function drawn(rows: readonly string[]): Pixel[] {
  return rows.flatMap((row, y) =>
    [...row].flatMap((key, x) => (key === "." ? [] : [{ x, y, key }])),
  );
}

/** Shifts a drawing so the middle of its bounds sits on the middle of a `width` by `height` box. */
function centre(pixels: Pixel[], width: number, height = width): Pixel[] {
  const xs = pixels.map((p) => p.x);
  const ys = pixels.map((p) => p.y);
  const dx = Math.floor((width - 1 - Math.max(...xs) - Math.min(...xs)) / 2);
  const dy = Math.floor((height - 1 - Math.max(...ys) - Math.min(...ys)) / 2);
  return pixels.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
}

function rotateClockwise(pixels: Pixel[], size: number): Pixel[] {
  return pixels.map((p) => ({ ...p, x: size - 1 - p.y, y: p.x }));
}

/** Drops the given source rows and closes the gap, so the rows below move up. */
function dropRows(pixels: Pixel[], rows: Set<number>): Pixel[] {
  return pixels
    .filter((p) => !rows.has(p.y))
    .map((p) => ({ ...p, y: p.y - [...rows].filter((row) => row < p.y).length }));
}

function tumble(pixels: Pixel[], size: number): Pixel[][] {
  const frames = [centre(pixels, size)];
  while (frames.length < QUARTER_TURNS) frames.push(rotateClockwise(frames.at(-1)!, size));
  return frames;
}

/** n, ne, e, se, s, sw, w, nw — the order `directional8` frames are read in. */
function octants(northWest: Pixel[], west: Pixel[], size = CELL): Pixel[][] {
  const nw = centre(northWest, size);
  const ne = rotateClockwise(nw, size);
  const se = rotateClockwise(ne, size);
  const sw = rotateClockwise(se, size);
  const w = centre(west, size);
  const n = rotateClockwise(w, size);
  const e = rotateClockwise(n, size);
  const s = rotateClockwise(e, size);
  return [n, ne, e, se, s, sw, w, nw];
}

/** Hardens a comet's fading tail into a solid body and adds a point one pixel past its head. */
function sharpen(diagonal: Pixel[]): Pixel[] {
  const head = diagonal.reduce((a, b) => (a.x + a.y <= b.x + b.y ? a : b));
  const body = diagonal.map((p) => (p.key === "t" ? { ...p, key: "d" } : p));
  return [...body, { x: head.x - 1, y: head.y - 1, key: "c" }];
}

/** Keeps the pixels fewer than `reach` steps from the sparkle's middle along both axes, shortening its points. */
function trimSparkle(sparkle: Pixel[], reach: number): Pixel[] {
  const mid = Math.floor(SPARKLE.w / 2);
  return sparkle.filter((p) => Math.max(Math.abs(p.x - mid), Math.abs(p.y - mid)) < reach);
}

/** Adds the four diagonal arms a snowflake has and a sparkle does not. */
function flake(sparkle: Pixel[]): Pixel[] {
  const mid = Math.floor(SPARKLE.w / 2);
  const ARM = 2;
  const arms = [-ARM, ARM].flatMap((dx) =>
    [-ARM, ARM].map((dy) => ({ x: mid + dx, y: mid + dy, key: "m" })),
  );
  return [...sparkle, ...arms];
}

function paint(png: PNG, pixels: Pixel[], ink: Ink, box: Box) {
  for (const p of pixels) {
    if (p.x < 0 || p.y < 0 || p.x >= box.w || p.y >= box.h) throw new Error("pixel off its cell");
    const entry = ink[p.key];
    if (entry === undefined) throw new Error(`no ink for ${p.key}`);
    const hex = STAPES_PALETTE[entry]!;
    const i = (png.width * (box.y + p.y) + box.x + p.x) << 2;
    png.data[i] = parseInt(hex.slice(1, 3), 16);
    png.data[i + 1] = parseInt(hex.slice(3, 5), 16);
    png.data[i + 2] = parseInt(hex.slice(5, 7), 16);
    png.data[i + 3] = 255;
  }
}

const sheet = PNG.sync.read(await fs.readFile(SOURCE));
const comet = cut(sheet, COMET, COMET_ROLES);
const sparkle = cut(sheet, SPARKLE, SPARKLE_ROLES);
const SPARKLE_LONG = 4;
const SPARKLE_SHORT = 3;
const longSparkle = trimSparkle(sparkle, SPARKLE_LONG);
const shortSparkle = trimSparkle(sparkle, SPARKLE_SHORT);
/** Upright, the flame's tip is ahead; flying, it trails, so the upright flame is the one flying south and a quarter turn flies west. */
const flameWest = rotateClockwise(
  centre(dropRows(cut(sheet, FLAME, FLAME_ROLES), FLAME_ROWS_DROPPED), CELL),
  CELL,
);

/**
 * A strip is one projectile's frames laid left to right. `column` and `row`
 * count cells of the strip's own `size`, and orb rows start below the small
 * ones.
 */
type Strip = { frames: Pixel[][]; ink: Ink | Ink[]; size: number; column: number; row: number };

const strips: Strip[] = [
  {
    frames: [longSparkle, shortSparkle].map((p) => centre(p, CELL)),
    ink: [VIOLET, VIOLET_TWINKLE],
    size: CELL,
    column: 0,
    row: 0,
  },
  {
    frames: [flake(longSparkle), shortSparkle].map((p) => centre(p, CELL)),
    ink: ICE,
    size: CELL,
    column: 2,
    row: 0,
  },
  { frames: tumble(drawn(LEAF_DRAWN), CELL), ink: LEAF, size: CELL, column: 4, row: 0 },
  { frames: octants(comet, drawn(COMET_WEST)), ink: VIOLET, size: CELL, column: 0, row: 1 },
  {
    frames: octants(comet, drawn(COMET_WEST)),
    ink: VIOLET_TWINKLE,
    size: CELL,
    column: 0,
    row: 2,
  },
  {
    frames: octants(sharpen(comet), drawn(SHARD_WEST)),
    ink: ICE,
    size: CELL,
    column: 0,
    row: 3,
  },
  {
    frames: octants(drawn(THORN_NORTH_WEST), drawn(THORN_WEST)),
    ink: THORN,
    size: CELL,
    column: 0,
    row: 4,
  },
  { frames: octants(comet, drawn(COMET_WEST)), ink: FIRE, size: CELL, column: 8, row: 1 },
  { frames: octants(comet, drawn(COMET_WEST)), ink: FIRE_FLICKER, size: CELL, column: 8, row: 2 },
  {
    frames: octants(drawn(FLAME_NORTH_WEST), flameWest),
    ink: FLAME_INK,
    size: CELL,
    column: 8,
    row: 3,
  },
  {
    frames: octants(drawn(FLAME_NORTH_WEST), flameWest),
    ink: FLAME_FLICKER,
    size: CELL,
    column: 8,
    row: 4,
  },
  {
    frames: octants(drawn(TRIDENT_NORTH_WEST), drawn(TRIDENT_WEST), ORB),
    ink: VIOLET,
    size: ORB,
    column: 0,
    row: 0,
  },
  {
    frames: BUBBLE_FRAMES.map((box) => cut(sheet, box)),
    ink: FROZEN_BUBBLE,
    size: ORB,
    column: 0,
    row: 1,
  },
  {
    frames: tumble(cut(sheet, FERN, FERN_ROLES), ORB),
    ink: BRAMBLE,
    size: ORB,
    column: 0,
    row: 2,
  },
];

const ORB_TOP_PX = SMALL_ROWS * CELL;
const png = new PNG({ width: SHEET_W, height: ORB_TOP_PX + ORB_ROWS * ORB });
/** pngjs leaves the buffer opaque black even with `fill: true`; the sheet needs a transparent backdrop. */
png.data.fill(0);
for (const { frames, ink, size, column, row } of strips) {
  const y = size === ORB ? ORB_TOP_PX + row * ORB : row * CELL;
  frames.forEach((frame, i) => {
    const frameInk = Array.isArray(ink) ? ink[i]! : ink;
    paint(png, frame, frameInk, { x: (column + i) * size, y, w: size, h: size });
  });
}

await fs.writeFile(OUT, PNG.sync.write(png));
console.log(`wrote ${path.relative(ROOT, OUT)} (${png.width}×${png.height})`);
