import { PNG } from "pngjs";
import { AUTOTILE_SLICE_MASKS } from "../app/lib/autotile";
import type { TileParticleRule } from "../app/lib/particleRule";
import type { ParticleEmitterDef } from "../app/lib/particleVfx";
import { scatterSeedMatching } from "../app/lib/scatter";
import { CELL_SIZE, type TileColorCycle, type TileDef, type TileSprite } from "../app/lib/types";
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
import { cycleRamp } from "./water-ramps";

const CELL = CELL_SIZE;

/** One still frame: the shader moves the liquid. */
const STILL_MS = 200;

type Liquid = {
  tileId: string;
  name: string;
  tileset: string;
  colorCycle: TileColorCycle;
  extra: Partial<TileDef>;
};

const DEEP_BASE = "#323353";
const DEEP_HIGHLIGHT = "#484a77";
const SWAMP_BASE = "#165a4c";
const SWAMP_HIGHLIGHT = "#239063";
const SWAMP_SHADOW = "#1f3b35";

/**
 * Deep water's cycle is the shallows' at the same length and pace, so a wave
 * runs on through the faded rim into the deep without a seam. It has no
 * trough: the palette pass snaps any shade darker than its body to near
 * black. Swamp is still water, with fewer, slower ripples.
 */
const LIQUIDS: Liquid[] = [
  {
    tileId: "deep-water",
    name: "Deep water",
    tileset: "Deep Water",
    colorCycle: {
      key: DEEP_BASE,
      ramp: cycleRamp([
        [DEEP_BASE, 11],
        [DEEP_HIGHLIGHT, 3],
        [DEEP_BASE, 2],
      ]),
      cellsPerCycle: 4,
      msPerCycle: 1600,
      ripple: 8,
      gaps: 0.5,
    },
    extra: {
      lightPassing: true,
      walkable: false,
    },
  },
  {
    tileId: "swamp",
    name: "Swamp",
    tileset: "Swamp",
    colorCycle: {
      key: SWAMP_BASE,
      ramp: cycleRamp([
        [SWAMP_BASE, 11],
        [SWAMP_SHADOW, 2],
        [SWAMP_HIGHLIGHT, 1],
        [SWAMP_BASE, 2],
      ]),
      cellsPerCycle: 4,
      msPerCycle: 4000,
      ripple: 8,
      gaps: 0.5,
    },
    extra: {
      lightPassing: true,
      walkSpeedPercent: -75,
      wade: true,
      interactions: { removeStatus: { trigger: "step", statusId: "burned" } },
    },
  },
];

function rgbaOf(hex: string): Rgba {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
}

/**
 * One cell of the liquid's key colour, which every slice draws. The shader
 * cycles it and fades it out towards the edge of the pool by how much of the
 * cells round it hold the same liquid, so the water under it shows through.
 */
function liquidSheet(liquid: Liquid): PNG {
  const key = rgbaOf(liquid.colorCycle.key);
  const sheet = new PNG({ width: CELL, height: CELL });
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) paintRgba(sheet, x, y, key);
  }
  return sheet;
}

function liquidTile(liquid: Liquid): TileDef {
  const slices = AUTOTILE_SLICE_MASKS.map((): TileSprite => ({
    frames: [
      {
        sprite: { rect: { x: 0, y: 0, w: 1, h: 1 }, base: { x: 0, y: 0 } },
        durationMs: STILL_MS,
      },
    ],
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
    colorCycle: liquid.colorCycle,
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

const FIREFLIES: ParticleEmitterDef = {
  ratePerSecond: 0.5,
  ttlFromMs: 3000,
  ttlToMs: 5000,
  spawnRadiusCells: 1,
  spawnElevFrom: 1,
  spawnElevTo: 4,
  riseFrom: -0.2,
  riseTo: 0.3,
  driftCellsPerSecond: 0.2,
  gravity: 0,
  offsetX: "0.4 * sin(AGE_SEC * 1.3 + SEED * 2 * PI)",
  offsetY: "0.3 * cos(AGE_SEC * 0.9 + SEED * 2 * PI)",
  offsetElev: "0.6 * sin(AGE_SEC * 2 + SEED * 2 * PI)",
  lit: false,
  ownDepth: false,
  shape: null,
  sizeFromPx: 1,
  sizeToPx: null,
  radiusFromPx: 0,
  radiusToPx: 0,
  alphaFrom: 1,
  alphaTo: 1,
  ramp: [
    {
      at: 0,
      color: "#165a4c",
    },
    {
      at: 0.15,
      color: "#d5e04b",
    },
    {
      at: 0.45,
      color: "#91db69",
    },
    {
      at: 0.6,
      color: "#165a4c",
    },
    {
      at: 0.8,
      color: "#d5e04b",
    },
    {
      at: 1,
      color: "#165a4c",
    },
  ],
};

const FIREFLY_RULE: TileParticleRule = { oneIn: 5, hours: { from: 20, to: 5 } };
const VARIANTS = 2;

/** A stalk is shaded by height rather than by the light: lit from above, a thin upright cylinder is the same dull colour all the way up. */
const STALK_BY_SEGMENT = [
  ["#165a4c", "#239063"],
  ["#239063", "#1ebc73"],
  ["#1ebc73", "#91db69"],
];
const HEAD = ["#45293f", "#6e2727", "#9e4539"];
const PAD = ["#239063", "#1ebc73", "#91db69"];
const SUNK_PAD = ["#239063", "#1ebc73"];
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

/**
 * Trodden, the same stalks splay out from the middle of the cell and lie low,
 * parted round whatever is standing there. The random draws are the same
 * either way, so a clump keeps its shape between the two.
 */
function clumpSolids({ seed, stalks, cattails }: Clump, sway: number, trodden = false): Solid[] {
  const rand = random(seed);
  const solids: Solid[] = [];
  for (let i = 0; i < stalks; i++) {
    const angle = (2 * Math.PI * (i + rand() * 0.5)) / stalks;
    const reach = 1 + rand() * 1.8 + (trodden ? 1 : 0);
    const base: Vec = [CELL / 2 + Math.cos(angle) * reach, CELL / 2 + Math.sin(angle) * reach, 0];
    const splay = trodden ? 0.85 : 0.25;
    const lean: Vec = [Math.cos(angle) * splay, Math.sin(angle) * splay, 0];
    const height = (5 + rand() * 4) * (trodden ? 0.45 : 1);
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

/** Trodden, a pad is pushed under the surface, which darkens it, and its flower closes to a bud. */
function lilySolids(seed: number, flower: boolean, trodden = false): Solid[] {
  const rand = random(seed);
  const pads: Solid[] = [];
  const count = flower ? 1 : 2;
  for (let i = 0; i < count; i++) {
    const centre: Vec = [2.5 + rand() * 3, 2.5 + rand() * 3, 0];
    const disc = pad(centre, flower ? 2.6 : 1.8, rand() * Math.PI * 2);
    pads.push({ sdf: disc, ramp: trodden ? SUNK_PAD : PAD });
    if (flower && trodden) {
      pads.push({
        sdf: sphere([centre[0] - 0.5, centre[1] + 0.5, 0.9], 0.7),
        ramp: PETAL,
        weight: 3,
      });
    } else if (flower) {
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

const PARTED_RADIUS = 2.8;

/** Trodden, every frond within `PARTED_RADIUS` of the middle is pushed out to it, leaving a clear ring. */
function duckweedSolids(seed: number, trodden = false): Solid[] {
  const rand = random(seed);
  return Array.from({ length: 9 }, () => {
    let x = 0.5 + rand() * 7;
    let y = 0.5 + rand() * 7;
    const r = 0.45 + rand() * 0.45;
    const off = Math.hypot(x - CELL / 2, y - CELL / 2);
    if (trodden && off < PARTED_RADIUS) {
      const angle = Math.atan2(y - CELL / 2, x - CELL / 2);
      x = CELL / 2 + Math.cos(angle) * PARTED_RADIUS;
      y = CELL / 2 + Math.sin(angle) * PARTED_RADIUS;
    }
    return { sdf: cylinder([x, y, 0], r, 0, 0.3), ramp: PAD, weight: 2 };
  });
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

const TRODDEN_ROW = STANDING_CELLS + 1;
const TRODDEN_FLAT_COLUMN = 4;

/**
 * Each plant is a pressure plate that swaps for its trodden twin while
 * anything with height stands in its cell and swaps back once the cell is
 * empty. The twin has the same height, light and `intangible`, so a swap
 * changes nothing the light bake or the walk reads.
 */
function treadable(upright: TileDef, trodden: TileDef): TileDef[] {
  return [
    {
      ...upright,
      interactions: { pressurePlate: { tileId: trodden.id, type: "gte", height: 1 } },
    },
    {
      ...trodden,
      scatterSeed: scatterSeedMatching(trodden.id, upright.id),
      interactions: { pressurePlate: { tileId: upright.id, type: "lte", height: 0 } },
    },
  ];
}

function plantTile(
  tileId: string,
  name: string,
  height: TileDef["height"],
  anchor: { x: number; y: number },
  scatter: TileSprite[],
): TileDef {
  return {
    id: tileId,
    name,
    height,
    type: "scatter",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: PLANTS_TILESET, ...anchor },
    lightPassing: true,
    intangible: true,
    scatter,
  };
}

function standingSprite(columns: number[], durationMs: number): TileSprite {
  return {
    frames: columns.map((column) => ({
      sprite: { rect: { x: column, y: 0, w: 2, h: 2 }, base: { x: 1, y: 1 } },
      durationMs,
    })),
  };
}

function flatSprite(column: number): TileSprite {
  return {
    frames: [
      { sprite: { rect: { x: column, y: 0, w: 1, h: 1 }, base: { x: 0, y: 0 } }, durationMs: 200 },
    ],
  };
}

function plantSheet(): { sheet: PNG; tiles: TileDef[] } {
  const columnsPerPlant = VARIANTS * SWAYS.length * STANDING_CELLS;
  const sheet = new PNG({
    width: STANDING.length * columnsPerPlant * CELL,
    height: 2 * STANDING_PX + CELL,
  });
  sheet.data.fill(0);
  const tiles: TileDef[] = [];
  STANDING.forEach((plant, p) => {
    plant.clumps.forEach((clump, variant) => {
      SWAYS.forEach((sway, frame) => {
        const column = p * columnsPerPlant + (variant * SWAYS.length + frame) * STANDING_CELLS;
        const art = castSprite(clumpSolids(clump, sway), STANDING_CELLS);
        blit(sheet, art, STANDING_PX, column * CELL, 0);
      });
      const trodden = castSprite(clumpSolids(clump, 0, true), STANDING_CELLS);
      blit(
        sheet,
        trodden,
        STANDING_PX,
        (p * VARIANTS + variant) * STANDING_CELLS * CELL,
        TRODDEN_ROW * CELL,
      );
    });
    const upright = plantTile(
      plant.tileId,
      plant.name,
      2,
      { x: p * columnsPerPlant, y: 0 },
      plant.clumps.map((_, variant) => ({
        ...standingSprite(
          SWAYS.map((_, frame) => (variant * SWAYS.length + frame) * STANDING_CELLS),
          SWAY_FRAME_MS,
        ),
        phase: SWAY_PHASE,
      })),
    );
    const trodden = plantTile(
      `${plant.tileId}-trodden`,
      `${plant.name} (trodden)`,
      2,
      { x: p * VARIANTS * STANDING_CELLS, y: TRODDEN_ROW },
      plant.clumps.map((_, variant) => standingSprite([variant * STANDING_CELLS], 200)),
    );
    tiles.push(
      ...treadable({ ...upright, particles: FIREFLIES, particleRule: FIREFLY_RULE }, trodden),
    );
  });

  const flats: {
    tileId: string;
    name: string;
    draw: (variant: number, trodden: boolean) => Solid[];
  }[] = [
    { tileId: "duckweed", name: "Duckweed", draw: (v, t) => duckweedSolids(100 + v, t) },
    { tileId: "swamp-lily", name: "Swamp lily", draw: (v, t) => lilySolids(200 + v, v === 0, t) },
  ];
  flats.forEach((flat, f) => {
    for (let variant = 0; variant < VARIANTS; variant++) {
      const column = f * VARIANTS + variant;
      blit(sheet, castSprite(flat.draw(variant, false), 1), CELL, column * CELL, STANDING_PX);
      const troddenColumn = TRODDEN_FLAT_COLUMN + column;
      blit(sheet, castSprite(flat.draw(variant, true), 1), CELL, troddenColumn * CELL, STANDING_PX);
    }
    const variants = Array.from({ length: VARIANTS }, (_, v) => flatSprite(v));
    tiles.push(
      ...treadable(
        plantTile(flat.tileId, flat.name, 0, { x: f * VARIANTS, y: FLAT_ROW }, variants),
        plantTile(
          `${flat.tileId}-trodden`,
          `${flat.name} (trodden)`,
          0,
          { x: TRODDEN_FLAT_COLUMN + f * VARIANTS, y: FLAT_ROW },
          variants,
        ),
      ),
    );
  });
  return { sheet, tiles };
}

async function main() {
  for (const liquid of LIQUIDS) {
    await writeTileset(liquid.tileId, liquid.tileset, liquidSheet(liquid), [liquidTile(liquid)], {
      translucent: true,
    });
  }
  const { sheet, tiles } = plantSheet();
  await writeTileset(PLANTS_TILESET, "Swamp Plants", sheet, tiles);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
