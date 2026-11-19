import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { CELL_SIZE, type TileDef } from "../app/lib/types";
import type { Projection, Vec3 } from "./limb-caster";
import { castModel, outlineBelow, writeCast } from "./model-caster";
import { type Rgba, paint, paintRgba, writeTileset } from "./tileset-output";

const TILESET_ID = "rune-temple";

const SPRITE_CELLS = 2;
const SPRITE_PX = SPRITE_CELLS * CELL_SIZE;
const PROP: Projection = {
  spritePx: SPRITE_PX,
  groundPx: SPRITE_PX - CELL_SIZE,
  topPx: SPRITE_PX - 1,
};
const ITEM: Projection = { spritePx: CELL_SIZE, groundPx: 0, topPx: CELL_SIZE - 1 };

const OUTLINE = 0;

type Hit = { normal: Vec3; edge?: boolean };
type Sampler = (p: Vec3, scale: number) => Hit | null;

function normalise(v: Vec3): Vec3 {
  const length = Math.hypot(...v) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Obsidian is black glass, so it is shaded in hard steps rather than a ramp:
 * every face is near black or a cold sheen, and the pale glint is only on the
 * edges between faces that are turned to the light from the south-west.
 * Palette indices.
 */
function shadeGlass(hit: Hit): number {
  const lit = -((hit.normal[0] - hit.normal[1]) / Math.SQRT2 - hit.normal[2] * 0.9);
  if (hit.edge) return lit > 0.3 ? 27 : 7;
  if (lit > 0.6) return 5;
  return 0;
}

/**
 * A shard of obsidian: a tapering prism from `foot` to `tip`, with five flat
 * faces round its axis. Each face has one normal, so it takes one colour.
 */
type Shard = { foot: Vec3; tip: Vec3; r: number };

function shard(c: Shard, p: Vec3, s: number): Hit | null {
  const a: Vec3 = [c.foot[0] * s, c.foot[1] * s, c.foot[2] * s];
  const ab: Vec3 = [
    (c.tip[0] - c.foot[0]) * s,
    (c.tip[1] - c.foot[1]) * s,
    (c.tip[2] - c.foot[2]) * s,
  ];
  const ap: Vec3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const t = Math.max(0, Math.min(1, dot(ap, ab) / dot(ab, ab)));
  const radial: Vec3 = [ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t];
  const radius = c.r * (1 - 0.8 * t) * s;
  const axis = normalise(ab);
  const u = normalise(Math.abs(axis[2]) > 0.95 ? cross(axis, [1, 0, 0]) : cross(axis, [0, 0, 1]));
  const v = cross(axis, u);
  const angle = Math.atan2(dot(radial, v), dot(radial, u));
  const facet = Math.round((angle / (2 * Math.PI)) * 5) * ((2 * Math.PI) / 5);
  /** A prism, not a cylinder: the distance that counts is across the nearest face, not to the axis. */
  if (Math.cos(angle - facet) * Math.hypot(...radial) > radius) return null;
  const across: Vec3 = [
    u[0] * Math.cos(facet) + v[0] * Math.sin(facet),
    u[1] * Math.cos(facet) + v[1] * Math.sin(facet),
    u[2] * Math.cos(facet) + v[2] * Math.sin(facet),
  ];
  const edge = Math.abs(angle - facet) > (Math.PI / 5) * 0.72;
  return {
    edge,
    normal: normalise([
      across[0] + axis[0] * 0.25,
      across[1] + axis[1] * 0.25,
      across[2] + axis[2] * 0.25,
    ]),
  };
}

/** The low glassy mound the shards stand in, chipped into flat planes the way the cave walls are. */
type Mound = { at: Vec3; r: Vec3 };

function mound(m: Mound, p: Vec3, s: number): Hit | null {
  const d: Vec3 = [p[0] / s - m.at[0], p[1] / s - m.at[1], p[2] / s - m.at[2]];
  if ((d[0] / m.r[0]) ** 2 + (d[1] / m.r[1]) ** 2 + (d[2] / m.r[2]) ** 2 > 1) return null;
  const raw = normalise([d[0] / m.r[0] ** 2, d[1] / m.r[1] ** 2, d[2] / m.r[2] ** 2]);
  return { normal: normalise(raw.map((c) => Math.round(c * 2) / 2) as Vec3) };
}

function outcrop(base: Mound | null, shards: readonly Shard[]): Sampler {
  return (p, s) => {
    if (p[2] < 0) return null;
    for (const c of shards) {
      const hit = shard(c, p, s);
      if (hit) return hit;
    }
    return base ? mound(base, p, s) : null;
  };
}

/**
 * The shards stand along the line from south-west to north-east, and the one
 * to the south-east is the shortest, because whatever stands south-east of a
 * shard is drawn over its foot.
 */
const VEINS: { id: string; height: number; base: Mound; shards: Shard[] }[] = [
  {
    id: "obsidian-vein-1",
    height: 3,
    base: { at: [4, 4.5, 0], r: [3.4, 3, 1.6] },
    shards: [
      { foot: [3.6, 4, -0.5], tip: [3.2, 3.2, 9], r: 2.2 },
      { foot: [5.6, 3, -0.5], tip: [6.8, 1.8, 6], r: 1.6 },
      { foot: [2.2, 6, -0.5], tip: [1, 6.8, 5], r: 1.5 },
      { foot: [5.8, 6, -0.5], tip: [6.6, 6.8, 2.6], r: 1.2 },
    ],
  },
  {
    id: "obsidian-vein-2",
    height: 2,
    base: { at: [4, 4.4, 0], r: [3.6, 3.2, 1.8] },
    shards: [
      { foot: [3.4, 3.8, -0.5], tip: [2.8, 3.2, 5], r: 2 },
      { foot: [5.4, 4.6, -0.5], tip: [6.8, 3.8, 3.4], r: 1.5 },
      { foot: [2.4, 6.2, -0.5], tip: [1.4, 7, 2.4], r: 1.3 },
    ],
  },
];

const PIECE: Sampler = outcrop(null, [{ foot: [2.8, 5.4, 1.2], tip: [6.2, 2.8, 1.8], r: 1.5 }]);

/**
 * The forges are `stone-forge` recoloured, so they keep its shape and its two
 * lit frames. Its sprite has three groups of colour: the stone of the rim and
 * stand, the dark basin, and the swirl in it. Each forge swaps all three.
 */
const STONE_FORGE = {
  file: "tiny-ranch-tiles.png",
  frames: [
    [128, 16],
    [112, 32],
  ],
  stone: "#9babb2",
  basin: "#362281",
  swirl: ["#affcdb", "#53d5cf", "#225ac0"],
  rimShadow: ["#646464", "#484a77"],
} as const;
const FRAME_MS = 200;

/**
 * A forge that is `flat` has its basin filled with its own stone, so its top
 * is one solid face, and a band of light sweeps across that face now and then
 * instead of the swirl turning.
 */
const SHIMMER = { restMs: 1800, stepMs: 60, colour: "#ffffff", from: 6, to: 20, step: 2 };

type Forge = {
  id: string;
  name: string;
  light: { radius: number; intensity: number; color: string };
  swaps: Record<string, string>;
  flat?: boolean;
};

const FORGES: Forge[] = [
  {
    id: "bone-forge",
    name: "Bone Forge",
    light: { radius: 5, intensity: 0.6, color: "#c7dcd0" },
    flat: true,
    swaps: {
      "#fcfcfc": "#ffffff",
      "#c8c8c8": "#ffffff",
      "#9babb2": "#c7dcd0",
      "#646464": "#7f708a",
      "#484a77": "#7f708a",
      "#323353": "#694f62",
      "#362281": "#3e3546",
    },
  },
  {
    id: "crystal-forge",
    name: "Crystal Forge",
    light: { radius: 8, intensity: 1, color: "#43d1f4" },
    swaps: {
      "#362281": "#225ac0",
      "#323353": "#484a77",
      "#affcdb": "#ffffff",
      "#53d5cf": "#affcdb",
      "#225ac0": "#53d5cf",
    },
  },
  {
    id: "obsidian-forge",
    name: "Obsidian Forge",
    light: { radius: 8, intensity: 1, color: "#fb6b1d" },
    swaps: {
      "#fcfcfc": "#c7dcd0",
      "#c8c8c8": "#7f708a",
      "#9babb2": "#3e3546",
      "#646464": "#2e222f",
      "#484a77": "#323353",
      "#323353": "#2e222f",
      "#362281": "#6e2727",
      "#affcdb": "#fbb954",
      "#53d5cf": "#fb6b1d",
      "#225ac0": "#ae2334",
    },
  },
];

const VEIN_ROW = FORGES.length;

type Frame = { pixels: (string | null)[]; durationMs: number };

function hex(data: Buffer, i: number): string {
  return `#${[data[i]!, data[i + 1]!, data[i + 2]!].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function readFrame(source: PNG, fromX: number, fromY: number): (string | null)[] {
  return Array.from({ length: SPRITE_PX * SPRITE_PX }, (_, k) => {
    const i = ((fromY + Math.floor(k / SPRITE_PX)) * source.width + fromX + (k % SPRITE_PX)) * 4;
    return source.data[i + 3] === 0 ? null : hex(source.data, i);
  });
}

/**
 * The basin is the swirl and the basin colour inside the rim. The same colour
 * also draws the forge's outer edge, and the edge is told apart by touching a
 * transparent pixel. The rim's inner shadow runs along the basin's north and
 * west sides, which are the pixels with `x + y` of 13 or less below the rim's
 * top row; its east side is the outside of the rim and keeps its shading.
 */
function fillBasin(pixels: (string | null)[]): (string | null)[] {
  const at = (x: number, y: number) =>
    x < 0 || y < 0 || x >= SPRITE_PX || y >= SPRITE_PX ? null : pixels[y * SPRITE_PX + x];
  return pixels.map((c, k) => {
    const x = k % SPRITE_PX;
    const y = Math.floor(k / SPRITE_PX);
    const swirl = (STONE_FORGE.swirl as readonly string[]).includes(c ?? "");
    const edge = [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)].includes(null);
    const innerShadow =
      (STONE_FORGE.rimShadow as readonly string[]).includes(c ?? "") && y >= 4 && x + y <= 13;
    return swirl || innerShadow || (c === STONE_FORGE.basin && !edge) ? STONE_FORGE.stone : c;
  });
}

/**
 * Only the forge's top takes the shimmer: the lit stone of the rim and the
 * filled basin. The stand runs down and to the right of the top, past column
 * 11 and row 10 of the frame.
 */
function shimmer(
  pixels: (string | null)[],
  top: (string | null)[],
  band: number,
): (string | null)[] {
  return pixels.map((c, k) => {
    const x = k % SPRITE_PX;
    const y = Math.floor(k / SPRITE_PX);
    const onTop = x <= 11 && y <= 10 && top[k] === STONE_FORGE.stone;
    return onTop && (x + y === band || x + y === band + 1) ? SHIMMER.colour : c;
  });
}

function forgeFrames(source: PNG, forge: Forge): Frame[] {
  const swap = (pixels: (string | null)[]) => pixels.map((c) => (c ? (forge.swaps[c] ?? c) : null));
  const frames = STONE_FORGE.frames.map(([x, y]) => readFrame(source, x, y));
  if (!forge.flat) return frames.map((pixels) => ({ pixels: swap(pixels), durationMs: FRAME_MS }));
  const top = fillBasin(frames[0]!);
  const still = swap(top);
  const sweeps: Frame[] = [];
  for (let band = SHIMMER.from; band <= SHIMMER.to; band += SHIMMER.step) {
    sweeps.push({ pixels: shimmer(still, top, band), durationMs: SHIMMER.stepMs });
  }
  return [{ pixels: still, durationMs: SHIMMER.restMs }, ...sweeps];
}

function rect(column: number, row: number, cells: number) {
  return {
    rect: { x: column * SPRITE_CELLS, y: row * SPRITE_CELLS, w: cells, h: cells },
    base: { x: cells - 1, y: cells - 1 },
  };
}

function forgeTile(forge: Forge, row: number, frames: Frame[]): TileDef {
  return {
    id: forge.id,
    name: forge.name,
    height: 3,
    type: "simple",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET_ID, x: 0, y: 0 },
    walkable: false,
    sprite: {
      frames: frames.map((frame, column) => ({
        sprite: rect(column, row, SPRITE_CELLS),
        durationMs: frame.durationMs,
        light: forge.light,
      })),
    },
  } as unknown as TileDef;
}

/**
 * Mined like `arcane-crystal-3`, the slowest crystal, and slower again:
 * obsidian is the rare top tier, so a vein takes longer per swing and gives
 * fewer pieces.
 */
function veinTile(vein: (typeof VEINS)[number], column: number): TileDef {
  return {
    id: vein.id,
    name: "Obsidian Vein",
    height: vein.height,
    type: "simple",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET_ID, x: 0, y: 0 },
    lightPassing: true,
    walkable: false,
    interactions: {
      extract: {
        actionName: "Mine",
        durability: 5,
        tileId: "",
        durationMs: 20000,
        slots: [
          { tileId: "obsidian-shard", chance: 100 },
          { tileId: "obsidian-shard", chance: 35 },
        ],
        mastery: "mining",
        xp: 24,
      },
      respawn: { fromMs: 600000, toMs: 1200000 },
    },
    sprite: { frames: [{ sprite: rect(column, VEIN_ROW, SPRITE_CELLS), durationMs: 200 }] },
  } as unknown as TileDef;
}

const PIECE_COLUMN = VEINS.length;

/** Not `obsidian`: that id is an older prop from `tiny-ranch-tiles`, and `writeTileset` would repaint it. */
const OBSIDIAN_ITEM = {
  id: "obsidian-shard",
  name: "Obsidian Shard",
  height: 0,
  type: "simple",
  kind: "item",
  attributes: {},
  anchor: { tilesetId: TILESET_ID, x: 0, y: 0 },
  lightPassing: true,
  interactions: { item: { type: "artifact", pile: 99 } },
  sprite: {
    frames: [
      {
        sprite: {
          rect: { x: PIECE_COLUMN * SPRITE_CELLS, y: VEIN_ROW * SPRITE_CELLS, w: 1, h: 1 },
          base: { x: 0, y: 0 },
        },
        durationMs: 200,
      },
    ],
  },
} as unknown as TileDef;

function paintFrame(sheet: PNG, pixels: (string | null)[], toX: number, toY: number) {
  pixels.forEach((c, k) => {
    if (!c) return;
    const n = Number.parseInt(c.slice(1), 16);
    const colour: Rgba = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
    paintRgba(sheet, toX + (k % SPRITE_PX), toY + Math.floor(k / SPRITE_PX), colour);
  });
}

async function paintCast(
  sheet: PNG,
  sampler: Sampler,
  projection: Projection,
  originX: number,
  originY: number,
  name: string,
) {
  const model = { sample: sampler, shade: shadeGlass };
  const size = projection.spritePx;
  const pixels = outlineBelow(castModel(model, projection), size, OUTLINE);
  for (let i = 0; i < pixels.length; i++) {
    if (pixels[i]! >= 0)
      paint(sheet, originX + (i % size), originY + Math.floor(i / size), pixels[i]!);
  }
  /** `PREVIEW=<dir>` also writes each cast four times larger, to judge the shape before it is pixels. */
  if (process.env.PREVIEW) {
    await writeCast(
      path.join(process.env.PREVIEW, `${name}-4x.png`),
      castModel(model, projection, 4),
      size * 4,
    );
  }
}

async function main() {
  const source = PNG.sync.read(
    await fs.readFile(path.join(import.meta.dirname, "..", "data", "tilesets", STONE_FORGE.file)),
  );
  const frames = FORGES.map((forge) => forgeFrames(source, forge));
  const columns = Math.max(VEINS.length + 1, ...frames.map((f) => f.length));
  const sheet = new PNG({ width: columns * SPRITE_PX, height: (VEIN_ROW + 1) * SPRITE_PX });
  sheet.data.fill(0);
  frames.forEach((row, r) =>
    row.forEach((frame, column) =>
      paintFrame(sheet, frame.pixels, column * SPRITE_PX, r * SPRITE_PX),
    ),
  );
  for (const [column, vein] of VEINS.entries()) {
    await paintCast(
      sheet,
      outcrop(vein.base, vein.shards),
      PROP,
      column * SPRITE_PX,
      VEIN_ROW * SPRITE_PX,
      vein.id,
    );
  }
  await paintCast(
    sheet,
    PIECE,
    ITEM,
    PIECE_COLUMN * SPRITE_PX,
    VEIN_ROW * SPRITE_PX,
    "obsidian-shard",
  );
  const tiles = [
    ...FORGES.map((forge, row) => forgeTile(forge, row, frames[row]!)),
    ...VEINS.map((vein, column) => veinTile(vein, column)),
    OBSIDIAN_ITEM,
  ];
  await writeTileset(TILESET_ID, "Rune Temple", sheet, tiles);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
