import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { AUTOTILE_SLICE_MASKS, E, N, NE, NW, S, SE, SW, W } from "../app/lib/autotile";
import { CELL_SIZE, type TileDef, type TileSprite } from "../app/lib/types";
import { cast, shade } from "./human-parts/cast";
import {
  type Sdf,
  type Solid,
  type Vec,
  capsule,
  cylinder,
  minus,
  sphere,
} from "./human-parts/model";
import { type Rgba, paintRgba, writeTileset } from "./tileset-output";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const CELL = CELL_SIZE;

/** The water sheet's last row is the slice with every neighbour connected: open water, nothing cut away. */
const OPEN_WATER_ROW = 46;
const WATER_BASE: Rgba = [0x33, 0x5c, 0x8c, 255];
const WATER_HIGHLIGHT: Rgba = [0x5b, 0x8f, 0xbf, 255];
const WATER_SHADOW: Rgba = [0x24, 0x43, 0x6b, 255];

/** The same timing and per-cell phase as `water`, so a ripple runs on from the shallows into the new liquid. */
const WATER_FRAME_MS = 80;
const WATER_PHASE = { x: 3, y: -1 };

/**
 * Measured to pixel centres, this gives the three pixels in from an edge 0, ½
 * and 1 opacity. A finer fade puts faint blends over the water, and the palette
 * pass turns those into a broken grey line round the edge.
 */
const FADE_FROM_PX = 1.5;
const FADE_TO_PX = 3.5;

type Liquid = {
  tileId: string;
  name: string;
  tileset: string;
  base: Rgba;
  highlight: Rgba;
  shadow: Rgba;
  extra: Partial<TileDef>;
};

const LIQUIDS: Liquid[] = [
  {
    tileId: "deep-water",
    name: "Deep water",
    tileset: "Deep Water",
    base: [0x32, 0x33, 0x53, 255],
    highlight: [0x48, 0x4a, 0x77, 255],
    shadow: [0x2b, 0x24, 0x40, 255],
    extra: {
      lightPassing: true,
      walkable: false,
      reflective: { colors: ["#323353", "#484a77"], opacity: 0.3, fadePx: 24, turbulence: 1 },
    },
  },
  {
    tileId: "swamp",
    name: "Swamp",
    tileset: "Swamp",
    base: [0x16, 0x5a, 0x4c, 255],
    highlight: [0x23, 0x90, 0x63, 255],
    shadow: [0x1f, 0x3b, 0x35, 255],
    extra: {
      lightPassing: true,
      walkSpeedPercent: -75,
      wade: true,
      reflective: { colors: ["#165a4c"], opacity: 0.25, fadePx: 16, turbulence: 0 },
      interactions: { removeStatus: { trigger: "step", statusId: "burned" } },
    },
  },
];

const OPEN_CORNERS: { bit: number; edges: number; x: number; y: number }[] = [
  { bit: NW, edges: N | W, x: 0, y: 0 },
  { bit: NE, edges: N | E, x: CELL, y: 0 },
  { bit: SW, edges: S | W, x: 0, y: CELL },
  { bit: SE, edges: S | E, x: CELL, y: CELL },
];

/** Distance from a pixel's centre to the nearest side or corner of the cell that does not connect. */
function edgeDistance(mask: number, x: number, y: number): number {
  const cx = x + 0.5;
  const cy = y + 0.5;
  let d = Infinity;
  if (!(mask & N)) d = Math.min(d, cy);
  if (!(mask & S)) d = Math.min(d, CELL - cy);
  if (!(mask & W)) d = Math.min(d, cx);
  if (!(mask & E)) d = Math.min(d, CELL - cx);
  for (const corner of OPEN_CORNERS) {
    if ((mask & corner.edges) !== corner.edges || mask & corner.bit) continue;
    d = Math.min(d, Math.hypot(cx - corner.x, cy - corner.y));
  }
  return d;
}

function same(png: PNG, x: number, y: number, rgba: Rgba): boolean {
  const i = (png.width * y + x) << 2;
  return rgba.every((c, k) => png.data[i + k] === c);
}

/**
 * Recolours the water's open-water frames for every slice, so the new liquid
 * ripples in step with the water under it, and fades it out towards the sides
 * it does not connect on so that water shows through.
 */
function liquidSheet(water: PNG, liquid: Liquid): PNG {
  const frames = water.width / CELL;
  const sheet = new PNG({ width: water.width, height: AUTOTILE_SLICE_MASKS.length * CELL });
  sheet.data.fill(0);
  AUTOTILE_SLICE_MASKS.forEach((mask, slice) => {
    for (let frame = 0; frame < frames; frame++) {
      for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
          const sx = frame * CELL + x;
          const sy = OPEN_WATER_ROW * CELL + y;
          const tone = same(water, sx, sy, WATER_HIGHLIGHT)
            ? liquid.highlight
            : same(water, sx, sy, WATER_SHADOW)
              ? liquid.shadow
              : same(water, sx, sy, WATER_BASE)
                ? liquid.base
                : null;
          if (!tone) throw new Error(`water.png has a colour this does not map at ${sx},${sy}`);
          const d = edgeDistance(mask, x, y);
          const alpha = Math.min(1, Math.max(0, (d - FADE_FROM_PX) / (FADE_TO_PX - FADE_FROM_PX)));
          paintRgba(sheet, sx, slice * CELL + y, [
            tone[0],
            tone[1],
            tone[2],
            Math.round(alpha * 255),
          ]);
        }
      }
    }
  });
  return sheet;
}

function liquidTile(liquid: Liquid, frames: number): TileDef {
  const slices = AUTOTILE_SLICE_MASKS.map((_, slice): TileSprite => ({
    frames: Array.from({ length: frames }, (_, frame) => ({
      sprite: { rect: { x: frame, y: slice, w: 1, h: 1 }, base: { x: 0, y: 0 } },
      durationMs: WATER_FRAME_MS,
    })),
    phase: WATER_PHASE,
  }));
  return {
    id: liquid.tileId,
    name: liquid.name,
    height: 0,
    type: "autotile",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: liquid.tileId, x: 0, y: 0 },
    ...liquid.extra,
    slices: Object.fromEntries(slices.map((s, i) => [i, s])),
  } as TileDef;
}

const PLANTS_TILESET = "swamp-plants";
/** A standing plant's sprite is two cells square, its ground cell the south-east one, so it has room to rise up and to the left. */
const STANDING_CELLS = 2;
const STANDING_PX = STANDING_CELLS * CELL;
const FLAT_ROW = STANDING_CELLS;
const SWAY_FRAME_MS = 700;
/** Neighbouring clumps sway a frame apart, so a bed of reeds does not move as one. */
const SWAY_PHASE = { x: 1, y: 0 };
const VARIANTS = 2;

/** A stalk is shaded by height rather than by the light: lit from above, a thin upright cylinder is the same dull colour all the way up. */
const STALK_BY_SEGMENT = [
  ["#165a4c", "#239063"],
  ["#239063", "#1ebc73"],
  ["#1ebc73", "#91db69"],
];
const HEAD = ["#45293f", "#6e2727", "#9e4539"];
const PAD = ["#239063", "#1ebc73", "#91db69"];
const PETAL = ["#cf657f", "#ffffff"];
const HEART = ["#fbb954"];

/** Mulberry32: the same seed draws the same clump on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stalk bends twice on its way up; `sway` pushes the upper part towards the north-east. */
function stalk(base: Vec, height: number, lean: Vec, sway: number, radius: number): Sdf[] {
  const bend = (k: number): Vec => [
    base[0] + lean[0] * k * k * height + sway * k * k,
    base[1] + lean[1] * k * k * height - sway * k * k,
    base[2] + k * height,
  ];
  const points = [0, 0.4, 0.75, 1].map(bend);
  return points.slice(1).map((to, i) => capsule(points[i]!, to, radius * (1 - (i + 1) * 0.2)));
}

type Clump = { seed: number; stalks: number; cattails: boolean };

function clumpSolids({ seed, stalks, cattails }: Clump, sway: number): Solid[] {
  const rand = random(seed);
  const solids: Solid[] = [];
  for (let i = 0; i < stalks; i++) {
    const angle = (2 * Math.PI * (i + rand() * 0.5)) / stalks;
    const reach = 1 + rand() * 1.8;
    const base: Vec = [CELL / 2 + Math.cos(angle) * reach, CELL / 2 + Math.sin(angle) * reach, 0];
    const lean: Vec = [Math.cos(angle) * 0.25, Math.sin(angle) * 0.25, 0];
    const height = 5 + rand() * 4;
    const swayHere = sway * (0.6 + rand() * 0.6);
    stalk(base, height, lean, swayHere, 0.6).forEach((sdf, segment) =>
      solids.push({ sdf, ramp: STALK_BY_SEGMENT[segment]!, weight: 3 }),
    );
    if (cattails && i % 3 === 0) {
      const top: Vec = [
        base[0] + lean[0] * height + swayHere,
        base[1] + lean[1] * height - swayHere,
        base[2] + height,
      ];
      const from: Vec = [top[0], top[1], top[2] - 1.6];
      const to: Vec = [top[0], top[1], top[2] + 0.2];
      solids.push({ sdf: capsule(from, to, 0.6), ramp: HEAD, weight: 4 });
    }
  }
  return solids;
}

/** A lily pad is a thin disc with a wedge cut out of it towards the viewer. */
function pad(centre: Vec, radius: number, notch: number): Sdf {
  const disc = cylinder(centre, radius, 0, 0.5);
  const wedge: Sdf = (p) => {
    const dx = p[0] - centre[0];
    const dy = p[1] - centre[1];
    const angle = Math.atan2(dy, dx) - notch;
    const wrapped = Math.atan2(Math.sin(angle), Math.cos(angle));
    return Math.abs(wrapped) - 0.45;
  };
  return minus(disc, wedge);
}

function lilySolids(seed: number, flower: boolean): Solid[] {
  const rand = random(seed);
  const pads: Solid[] = [];
  const count = flower ? 1 : 2;
  for (let i = 0; i < count; i++) {
    const centre: Vec = [2.5 + rand() * 3, 2.5 + rand() * 3, 0];
    pads.push({ sdf: pad(centre, flower ? 2.6 : 1.8, rand() * Math.PI * 2), ramp: PAD });
    if (flower) {
      pads.push({
        sdf: sphere([centre[0] - 0.5, centre[1] + 0.5, 1.2], 0.6),
        ramp: HEART,
        weight: 3,
      });
      for (let k = 0; k < 4; k++) {
        const a = (k * Math.PI) / 2 + 0.4;
        const petal: Vec = [
          centre[0] - 0.5 + Math.cos(a) * 0.9,
          centre[1] + 0.5 + Math.sin(a) * 0.9,
          1,
        ];
        pads.push({ sdf: sphere(petal, 0.6), ramp: PETAL, weight: 2 });
      }
    }
  }
  return pads;
}

function duckweedSolids(seed: number): Solid[] {
  const rand = random(seed);
  return Array.from({ length: 9 }, () => ({
    sdf: cylinder([0.5 + rand() * 7, 0.5 + rand() * 7, 0], 0.45 + rand() * 0.45, 0, 0.3),
    ramp: PAD,
    weight: 2,
  }));
}

/** Casts solids standing in the sprite's ground cell, seen through the world's projection. */
function castSprite(solids: Solid[], cells: number): (string | null)[] {
  const px = cells * CELL;
  const ground = px - CELL;
  const hits = cast(
    solids,
    [],
    { centre: [CELL / 2, CELL / 2, ground / 2], r: px },
    { width: px, height: px, px: 1, origin: [-ground, -ground] },
  );
  return shade(
    hits.map((h) => ({ at: h.at, ramp: solids[h.part]!.ramp, light: h.light })),
    px * px,
  );
}

function hexRgba(hex: string): Rgba {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
}

function blit(sheet: PNG, colours: (string | null)[], size: number, left: number, top: number) {
  colours.forEach((c, i) => {
    if (c) paintRgba(sheet, left + (i % size), top + Math.floor(i / size), hexRgba(c));
  });
}

type StandingPlant = { tileId: string; name: string; clumps: Clump[] };

const STANDING: StandingPlant[] = [
  {
    tileId: "reeds",
    name: "Reeds",
    clumps: [
      { seed: 11, stalks: 7, cattails: false },
      { seed: 29, stalks: 6, cattails: false },
    ],
  },
  {
    tileId: "cattails",
    name: "Cattails",
    clumps: [
      { seed: 4, stalks: 6, cattails: true },
      { seed: 57, stalks: 7, cattails: true },
    ],
  },
];

const SWAYS = [0, 0.7];

function standingTile(plant: StandingPlant, column: number): TileDef {
  return {
    id: plant.tileId,
    name: plant.name,
    height: 2,
    type: "scatter",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: PLANTS_TILESET, x: column, y: 0 },
    lightPassing: true,
    intangible: true,
    scatter: plant.clumps.map((_, variant) => ({
      frames: SWAYS.map((_, frame) => ({
        sprite: {
          rect: { x: (variant * SWAYS.length + frame) * STANDING_CELLS, y: 0, w: 2, h: 2 },
          base: { x: 1, y: 1 },
        },
        durationMs: SWAY_FRAME_MS,
      })),
      phase: SWAY_PHASE,
    })),
  };
}

function flatTile(tileId: string, name: string, column: number): TileDef {
  return {
    id: tileId,
    name,
    height: 0,
    type: "scatter",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: PLANTS_TILESET, x: column, y: FLAT_ROW },
    lightPassing: true,
    intangible: true,
    scatter: Array.from({ length: VARIANTS }, (_, variant) => ({
      frames: [
        {
          sprite: { rect: { x: variant, y: 0, w: 1, h: 1 }, base: { x: 0, y: 0 } },
          durationMs: 200,
        },
      ],
    })),
  };
}

function plantSheet(): { sheet: PNG; tiles: TileDef[] } {
  const columnsPerPlant = VARIANTS * SWAYS.length * STANDING_CELLS;
  const sheet = new PNG({
    width: STANDING.length * columnsPerPlant * CELL,
    height: STANDING_PX + CELL,
  });
  sheet.data.fill(0);
  const tiles = STANDING.map((plant, p) => {
    plant.clumps.forEach((clump, variant) =>
      SWAYS.forEach((sway, frame) => {
        const column = p * columnsPerPlant + (variant * SWAYS.length + frame) * STANDING_CELLS;
        blit(
          sheet,
          castSprite(clumpSolids(clump, sway), STANDING_CELLS),
          STANDING_PX,
          column * CELL,
          0,
        );
      }),
    );
    return standingTile(plant, p * columnsPerPlant);
  });

  const flats: { tileId: string; name: string; draw: (variant: number) => Solid[] }[] = [
    { tileId: "duckweed", name: "Duckweed", draw: (v) => duckweedSolids(100 + v) },
    { tileId: "swamp-lily", name: "Swamp lily", draw: (v) => lilySolids(200 + v, v === 0) },
  ];
  flats.forEach((flat, f) => {
    for (let variant = 0; variant < VARIANTS; variant++) {
      const column = f * VARIANTS + variant;
      blit(sheet, castSprite(flat.draw(variant), 1), CELL, column * CELL, STANDING_PX);
    }
    tiles.push(flatTile(flat.tileId, flat.name, f * VARIANTS));
  });
  return { sheet, tiles };
}

async function main() {
  const water = PNG.sync.read(await fs.readFile(path.join(DATA, "tilesets", "water.png")));
  const frames = water.width / CELL;
  for (const liquid of LIQUIDS) {
    await writeTileset(
      liquid.tileId,
      liquid.tileset,
      liquidSheet(water, liquid),
      [liquidTile(liquid, frames)],
      { translucent: true },
    );
  }
  const { sheet, tiles } = plantSheet();
  await writeTileset(PLANTS_TILESET, "Swamp Plants", sheet, tiles);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
