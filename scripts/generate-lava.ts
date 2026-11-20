import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { AUTOTILE_SLICE_MASKS, E, N, NE, NW, S, SE, SW, W } from "../app/lib/autotile";
import type { LightDef } from "../app/lib/types";
import { CELL_SIZE, type TileDef, type TileSprite } from "../app/lib/types";
import { paint, readJson, writeTileset } from "./tileset-output";

const DATA = path.resolve(import.meta.dirname, "..", "data");

const TILESET = "lava";

const LAVA_FRAMES = 16;
const LAVA_FRAME_MS = 220;
const LAVA_PHASE = { x: 5, y: 3 };

/**
 * The crust and the basalt do not move: each of their frames is a different
 * layout of cracks or joints, held for 2^30 ms (about twelve days), and `phase`
 * starts each cell on a different one, which is the only way an autotile can
 * vary from cell to cell. A power of two keeps every frame boundary exact in
 * the float32 clock the GPU's frame lookup compares against. With 24 layouts
 * and this phase the nearest cell showing the same layout is five cells away.
 */
const STILL_FRAMES = 24;
const STILL_FRAME_MS = 2 ** 30;
const STILL_PHASE = { x: 1, y: 5 };

const LAVA_COLUMN = 0;
const CRUST_COLUMN = LAVA_FRAMES;
const BASALT_COLUMN = CRUST_COLUMN + STILL_FRAMES;
const SHEET_CELLS = { w: BASALT_COLUMN + STILL_FRAMES, h: AUTOTILE_SLICE_MASKS.length };

const BLACK = 0;
const SOOT = 4;
const DEEP = 3;
const RED = 9;
const BRIGHT_RED = 10;
const ORANGE = 12;
const AMBER = 17;
const YELLOW = 19;

const LAVA_LIGHT: LightDef = { radius: 3, intensity: 0.7, color: "#fb6b1d" };
const CRUST_LIGHT: LightDef = { radius: 2, intensity: 0.35, color: "#e83b3b" };

const LAST = CELL_SIZE - 1;

const CLEAR = -1;

/**
 * `dirt`'s slices in `floors.png` have a copy four cells to the right with the
 * top filled in one flat green and the bank below it in other colours. That
 * copy is the house's rounded outline, and `water` takes its shape from it too.
 */
const SHAPE_SOURCE_TILE = "dirt";
const SHAPE_BLOCK_X = 4;
const SHAPE_FILL: readonly number[] = [35, 144, 99];

/** `top` is the flat surface; `bank` is the edge face the outline draws below and right of it. */
type Outline = { top: boolean[][]; bank: boolean[][]; rimDepth: number[][] };

const CORNERS: readonly { needs: number; missing: number; x: number; y: number }[] = [
  { needs: N | W, missing: NW, x: 0, y: 0 },
  { needs: N | E, missing: NE, x: LAST, y: 0 },
  { needs: S | W, missing: SW, x: 0, y: LAST },
  { needs: S | E, missing: SE, x: LAST, y: LAST },
];

/** Where both sides of a corner connect but the diagonal does not, its pixel is cleared, as `water` does. */
function nickCorners(top: boolean[][], mask: number) {
  for (const corner of CORNERS) {
    if ((mask & corner.needs) !== corner.needs || mask & corner.missing) continue;
    top[corner.y]![corner.x] = false;
  }
}

/**
 * Steps in from the top's own edge. A pixel past the cell's border counts as
 * top, because on a connected side the neighbour carries on the same surface.
 */
function rimDepths(top: boolean[][]): number[][] {
  const depth = top.map((row) => row.map((t) => (t ? Infinity : -1)));
  const queue: [number, number][] = [];
  for (let y = 0; y < CELL_SIZE; y++) {
    for (let x = 0; x < CELL_SIZE; x++) {
      if (!top[y]![x]!) continue;
      const open = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ].some(([nx, ny]) => nx! >= 0 && ny! >= 0 && nx! <= LAST && ny! <= LAST && !top[ny!]![nx!]!);
      if (open) {
        depth[y]![x] = 0;
        queue.push([x, y]);
      }
    }
  }
  while (queue.length > 0) {
    const [x, y] = queue.shift()!;
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ]) {
      if (nx! < 0 || ny! < 0 || nx! > LAST || ny! > LAST) continue;
      if (depth[ny!]![nx!]! !== Infinity) continue;
      depth[ny!]![nx!] = depth[y]![x]! + 1;
      queue.push([nx!, ny!]);
    }
  }
  return depth;
}

async function readOutlines(): Promise<Outline[]> {
  const tiles = await readJson<TileDef[]>(path.join(DATA, "tiles.json"));
  const source = tiles.find((t) => t.id === SHAPE_SOURCE_TILE);
  if (!source?.slices) throw new Error(`no slices on ${SHAPE_SOURCE_TILE}`);
  const floors = PNG.sync.read(await fs.readFile(path.join(DATA, "tilesets", "floors.png")));
  return AUTOTILE_SLICE_MASKS.map((mask, slice) => {
    const rect = source.slices?.[slice]?.frames[0]?.sprite.rect;
    if (!rect || rect.w !== 1 || rect.h !== 1) {
      throw new Error(`slice ${slice} of ${SHAPE_SOURCE_TILE} is not one cell`);
    }
    const top: boolean[][] = [];
    const bank: boolean[][] = [];
    for (let y = 0; y < CELL_SIZE; y++) {
      top.push([]);
      bank.push([]);
      for (let x = 0; x < CELL_SIZE; x++) {
        const px = (SHAPE_BLOCK_X + rect.x) * CELL_SIZE + x;
        const i = (floors.width * (rect.y * CELL_SIZE + y) + px) << 2;
        const opaque = floors.data[i + 3]! > 0;
        const fill = SHAPE_FILL.every((c, k) => floors.data[i + k] === c);
        top[y]!.push(opaque && fill);
        bank[y]!.push(opaque && !fill);
      }
    }
    nickCorners(top, mask);
    return { top, bank, rimDepth: rimDepths(top) };
  });
}

/**
 * Paints every slice of one autotile column, asking `ink` for each pixel the
 * outline covers; `ink` returns `CLEAR` to leave a pixel transparent.
 */
function drawAutotile(
  sheet: PNG,
  outlines: readonly Outline[],
  column: number,
  frames: number,
  ink: (pixel: { x: number; y: number; frame: number; rimDepth: number; bank: boolean }) => number,
) {
  outlines.forEach((outline, slice) => {
    for (let frame = 0; frame < frames; frame++) {
      for (let y = 0; y < CELL_SIZE; y++) {
        for (let x = 0; x < CELL_SIZE; x++) {
          const top = outline.top[y]![x]!;
          const bank = outline.bank[y]![x]!;
          if (!top && !bank) continue;
          const index = ink({ x, y, frame, rimDepth: outline.rimDepth[y]![x]!, bank });
          if (index === CLEAR) continue;
          paint(sheet, (column + frame) * CELL_SIZE + x, slice * CELL_SIZE + y, index);
        }
      }
    }
  });
}

/**
 * A wave in the lava's flow field: `turns` cycles over the animation, plus
 * `across`/`down` whole cycles per cell. The renderer starts the cell at
 * (cx, cy) `phase.x * cx + phase.y * cy` frames ahead, so each wave also gets
 * the fraction of a cycle that offset is worth; that makes a cell's right edge
 * continue exactly into its neighbour's left edge on every frame.
 */
type Wave = { turns: number; across: number; down: number; offset: number; weight: number };

const FLOW: readonly Wave[] = [
  { turns: 1, across: 0, down: 1, offset: 0.3, weight: 1 },
  { turns: -1, across: 1, down: 0, offset: 1.7, weight: 0.8 },
  { turns: 2, across: -1, down: 1, offset: 4.1, weight: 0.45 },
];

const WARP: readonly Wave[] = [
  { turns: 1, across: 1, down: 1, offset: 2.2, weight: 1 },
  { turns: -1, across: -1, down: 1, offset: 5.3, weight: 0.7 },
];

const WARP_STRENGTH = 1.6;

function waveSum(waves: readonly Wave[], x: number, y: number, frame: number, warp = 0): number {
  let sum = 0;
  for (const w of waves) {
    const kx = (2 * Math.PI * (w.across + (w.turns * LAVA_PHASE.x) / LAVA_FRAMES)) / CELL_SIZE;
    const ky = (2 * Math.PI * (w.down + (w.turns * LAVA_PHASE.y) / LAVA_FRAMES)) / CELL_SIZE;
    const t = (2 * Math.PI * w.turns * frame) / LAVA_FRAMES;
    sum += w.weight * Math.cos(kx * x + ky * y + t + w.offset + warp);
  }
  return sum;
}

function lavaIndex(x: number, y: number, frame: number): number {
  const warp = WARP_STRENGTH * waveSum(WARP, x, y, frame);
  const flow = waveSum(FLOW, x, y, frame, warp);
  const seam = Math.abs(flow);
  if (seam < 0.12) return YELLOW;
  if (seam < 0.32) return AMBER;
  if (seam < 0.6) return ORANGE;
  if (seam < 1.2) return BRIGHT_RED;
  if (seam < 1.75) return RED;
  return DEEP;
}

function drawLava(sheet: PNG, outlines: readonly Outline[]) {
  drawAutotile(sheet, outlines, LAVA_COLUMN, LAVA_FRAMES, (p) => {
    if (p.bank || p.rimDepth === 0) return BLACK;
    if (p.rimDepth === 1) return DEEP;
    return lavaIndex(p.x, p.y, p.frame);
  });
}

/** mulberry32: a seeded generator, so a re-run draws the same cracks. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `portChance` is how often an edge has a line crossing it, `spurChance` how
 * often a layout has a short branch, and `specks` how many single pixels are
 * scattered off the lines.
 */
type LineStyle = { seed: number; portChance: number; spurChance: number; specks: number };

const CRUST_CRACKS: LineStyle = { seed: 7, portChance: 0.5, spurChance: 0.35, specks: 2 };
const BASALT_JOINTS: LineStyle = { seed: 31, portChance: 0.4, spurChance: 0.3, specks: 1 };

/** `c` is a cooled crack, `w` a warm stretch of one, `h` its hot core and `s` a fleck of soot. */
type Crack = "." | "c" | "w" | "h" | "s";

/**
 * One layout of lines per still frame. The cell east of one showing layout `k`
 * shows `k + STILL_PHASE.x`, and the cell south of it `k + STILL_PHASE.y`, so
 * the place a crack leaves `k`'s east edge is drawn as the place it enters
 * that layout's west edge, and likewise south to north. A layout may have no
 * crack on an edge, and then neither does the one across it.
 */
function lineLayouts(style: LineStyle): Crack[][][] {
  const random = seeded(style.seed);
  const pick = (n: number) => Math.floor(random() * n);
  const port = () => (random() < style.portChance ? 1 + pick(CELL_SIZE - 2) : null);
  const leavesEast = Array.from({ length: STILL_FRAMES }, port);
  const leavesSouth = Array.from({ length: STILL_FRAMES }, port);
  const before = (k: number, step: number) => (k - step + STILL_FRAMES) % STILL_FRAMES;

  return Array.from({ length: STILL_FRAMES }, (_, k) => {
    const grid: Crack[][] = Array.from({ length: CELL_SIZE }, () =>
      Array.from({ length: CELL_SIZE }, (): Crack => "."),
    );
    const ports: [number, number][] = [];
    const west = leavesEast[before(k, STILL_PHASE.x)];
    const east = leavesEast[k];
    const north = leavesSouth[before(k, STILL_PHASE.y)];
    const south = leavesSouth[k];
    if (west != null) ports.push([0, west]);
    if (east != null) ports.push([LAST, east]);
    if (north != null) ports.push([north, 0]);
    if (south != null) ports.push([south, LAST]);

    const inner = (v: number) => Math.min(LAST - 1, Math.max(1, v));
    const path: [number, number][] = [];
    const mark = (x: number, y: number) => {
      grid[y]![x] = "c";
      path.push([x, y]);
    };
    const junction: [number, number] = [2 + pick(4), 2 + pick(4)];

    /** From a port, one step straight in, then a wandering line to the junction that keeps off the border. */
    for (const [px, py] of ports) {
      mark(px, py);
      let x = inner(px);
      let y = inner(py);
      mark(x, y);
      while (x !== junction[0] || y !== junction[1]) {
        const dx = Math.sign(junction[0] - x);
        const dy = Math.sign(junction[1] - y);
        const roll = random();
        if (dx !== 0 && (dy === 0 || roll < 0.35)) x += dx;
        else if (dy !== 0 && roll < 0.7) y += dy;
        else {
          x += dx;
          y += dy;
        }
        x = inner(x);
        y = inner(y);
        mark(x, y);
      }
    }
    if (ports.length === 0) {
      let [x, y] = junction;
      for (let i = 0; i < 3; i++) {
        mark(x, y);
        x = inner(x + pick(3) - 1);
        y = inner(y + 1);
      }
    }

    if (random() < style.spurChance) {
      let [x, y] = path[pick(path.length)]!;
      const dx = pick(3) - 1;
      const dy = dx === 0 ? (random() < 0.5 ? -1 : 1) : pick(3) - 1;
      for (let i = 0; i < 2 + pick(2); i++) {
        x = inner(x + dx);
        y = inner(y + dy);
        mark(x, y);
      }
    }

    const insides = path.filter(([x, y]) => x > 1 && y > 1 && x < LAST - 1 && y < LAST - 1);
    if (insides.length > 0) {
      const [hx, hy] = insides[pick(insides.length)]!;
      for (const [x, y] of insides) {
        if (Math.max(Math.abs(x - hx), Math.abs(y - hy)) <= 1) grid[y]![x] = "w";
      }
      if (random() < 0.6) grid[hy]![hx] = "h";
    }
    for (let i = 0; i < style.specks; i++) {
      const x = 1 + pick(CELL_SIZE - 2);
      const y = 1 + pick(CELL_SIZE - 2);
      if (grid[y]![x] === ".") grid[y]![x] = "s";
    }
    return grid;
  });
}

const CRACK_INK: Record<Crack, number> = { ".": BLACK, c: DEEP, w: RED, h: ORANGE, s: SOOT };

/** A fixed value in [0, 1) for each pixel of the cell, so every slice frays at the same places. */
function speckle(x: number, y: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * The crust has no bank, and its edge frays: half the outer ring is left clear
 * and the rest is basalt's colour, and a few pixels of the next ring are basalt
 * too. Over basalt that thins the black out into the floor; over anything else
 * it is a ragged dark edge rather than a hard line.
 */
function drawCrust(sheet: PNG, outlines: readonly Outline[]) {
  const layouts = lineLayouts(CRUST_CRACKS);
  drawAutotile(sheet, outlines, CRUST_COLUMN, STILL_FRAMES, (p) => {
    if (p.bank) return CLEAR;
    const fray = speckle(p.x, p.y);
    if (p.rimDepth === 0) return fray < 0.5 ? CLEAR : SOOT;
    if (p.rimDepth === 1 && fray < 0.35) return SOOT;
    return CRACK_INK[layouts[p.frame]![p.y]![p.x]!];
  });
}

const BASALT = 4;
const BASALT_JOINT = 1;
const BASALT_GRIT = 8;
const BASALT_BANK = 1;

/** Basalt's joints are one dark colour along their whole length, and a speck is a fleck of grit. */
const JOINT_INK: Record<Crack, number> = {
  ".": BASALT,
  c: BASALT_JOINT,
  w: BASALT_JOINT,
  h: BASALT_JOINT,
  s: BASALT_GRIT,
};

function drawBasalt(sheet: PNG, outlines: readonly Outline[]) {
  const layouts = lineLayouts(BASALT_JOINTS);
  drawAutotile(sheet, outlines, BASALT_COLUMN, STILL_FRAMES, (p) => {
    if (p.bank) return BASALT_BANK;
    return JOINT_INK[layouts[p.frame]![p.y]![p.x]!];
  });
}

function animatedSlice(
  row: number,
  frames: number,
  durationMs: number,
  phase: { x: number; y: number },
  light?: LightDef,
): TileSprite {
  return {
    frames: Array.from({ length: frames }, (_, frame) => ({
      sprite: { rect: { x: frame, y: row, w: 1, h: 1 }, base: { x: 0, y: 0 } },
      durationMs,
      ...(light ? { light } : {}),
    })),
    phase,
  };
}

function tiles(): TileDef[] {
  const lava = {
    id: "lava",
    name: "Lava",
    height: 0,
    type: "autotile",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET, x: LAVA_COLUMN, y: 0 },
    lightPassing: true,
    walkSpeedPercent: -50,
    wade: true,
    interactions: { addStatus: { trigger: "step", statusId: "burned", ground: true } },
    slices: Object.fromEntries(
      AUTOTILE_SLICE_MASKS.map((_, slice) => [
        slice,
        animatedSlice(slice, LAVA_FRAMES, LAVA_FRAME_MS, LAVA_PHASE, LAVA_LIGHT),
      ]),
    ),
  } as TileDef;
  const crust = {
    id: "lava-crust",
    name: "Lava crust",
    height: 0,
    type: "autotile",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET, x: CRUST_COLUMN, y: 0 },
    lightPassing: true,
    connectsTo: ["lava"],
    slices: Object.fromEntries(
      AUTOTILE_SLICE_MASKS.map((_, slice) => [
        slice,
        animatedSlice(slice, STILL_FRAMES, STILL_FRAME_MS, STILL_PHASE, CRUST_LIGHT),
      ]),
    ),
  } as TileDef;
  const basalt = {
    id: "basalt",
    name: "Basalt",
    height: 0,
    type: "autotile",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET, x: BASALT_COLUMN, y: 0 },
    connectsTo: ["lava-crust", "lava", "basalt-brink"],
    slices: Object.fromEntries(
      AUTOTILE_SLICE_MASKS.map((_, slice) => [
        slice,
        animatedSlice(slice, STILL_FRAMES, STILL_FRAME_MS, STILL_PHASE),
      ]),
    ),
  } as TileDef;
  return [lava, crust, basalt];
}

async function main() {
  const sheet = new PNG({ width: SHEET_CELLS.w * CELL_SIZE, height: SHEET_CELLS.h * CELL_SIZE });
  /** pngjs leaves the buffer opaque black; outside each slice's outline must stay clear. */
  sheet.data.fill(0);
  const outlines = await readOutlines();
  drawLava(sheet, outlines);
  drawCrust(sheet, outlines);
  drawBasalt(sheet, outlines);
  await writeTileset(TILESET, "Lava", sheet, tiles());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
