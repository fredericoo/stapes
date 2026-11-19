import path from "node:path";
import { PNG } from "pngjs";
import { AUTOTILE_SLICE_MASKS, E, N, S, W } from "../app/lib/autotile";
import {
  AUTOTILE_SLICE_COUNT,
  CELL_SIZE,
  type Direction,
  type Frame,
  type TileDef,
} from "../app/lib/types";
import type { ParticleEmitterDef } from "../app/lib/particleVfx";
import type { Projection, Vec3 } from "./limb-caster";
import { castModel, type Model, outlineBelow, writeCast } from "./model-caster";
import { paint, writeTileset } from "./tileset-output";

const TILESET_ID = "lighthouse";

const SMALL_CELLS = 2;
const SMALL_PX = SMALL_CELLS * CELL_SIZE;
const SMALL: Projection = {
  spritePx: SMALL_PX,
  groundPx: SMALL_PX - CELL_SIZE,
  topPx: SMALL_PX - 1,
};

/**
 * The roof covers the 3×3 room at the top and rises two cells above it, so its
 * sprite is the footprint plus two cells of lean, with one more for the finial.
 */
const CAP_FOOTPRINT = 3;
const CAP_CELLS = CAP_FOOTPRINT + 3;
const CAP_PX = CAP_CELLS * CELL_SIZE;
const CAP: Projection = { spritePx: CAP_PX, groundPx: CAP_PX - CELL_SIZE, topPx: CAP_PX - 1 };

/** One level is four height units of two pixels each. */
const LEVEL_PX = 8;

/**
 * Palette indices for each face of a stone, with a second shade some stones
 * take so the courses read as rubble. The grey is `stone-wall`'s; the
 * limewash is the ramp `sw2` is painted in, with grey stones showing through.
 */
const RUBBLE = {
  top: 25,
  south: 25,
  southAlt: 27,
  east: 22,
  eastAlt: 8,
  southMortar: 22,
  eastMortar: 4,
};
const LIMEWASH = {
  top: 27,
  south: 27,
  southAlt: 25,
  east: 25,
  eastAlt: 22,
  southMortar: 25,
  eastMortar: 22,
};
const ROOF_RAMP = [22, 8, 2] as const;

type Ramp = typeof RUBBLE;
type Face = "top" | "south" | "east" | "diagonal";

/**
 * Which half of the cell a corner block keeps: facing `n` cuts the tower's
 * north-east corner, and each facing after it is the next corner clockwise,
 * so rotating the tile in the editor walks it round the tower.
 */
const CORNER_KEEPS: Record<Direction, (x: number, y: number) => boolean> = {
  n: (x, y) => y >= x,
  e: (x, y) => x + y <= LEVEL_PX,
  s: (x, y) => x >= y,
  w: (x, y) => x + y >= LEVEL_PX,
};

const CORNER_NORMAL: Record<Direction, Vec3> = {
  n: [Math.SQRT1_2, -Math.SQRT1_2, 0],
  e: [Math.SQRT1_2, Math.SQRT1_2, 0],
  s: [-Math.SQRT1_2, Math.SQRT1_2, 0],
  w: [-Math.SQRT1_2, -Math.SQRT1_2, 0],
};

function cornerDistance(facing: Direction, x: number, y: number): number {
  if (facing === "n" || facing === "s") return Math.abs(x - y) / Math.SQRT2;
  return Math.abs(x + y - LEVEL_PX) / Math.SQRT2;
}

type BlockHit = { face: Face; p: Vec3; normal: Vec3 };

/**
 * A whole cell of wall one level high, or the half of one a corner keeps. The
 * face a point belongs to is the visible face it is nearest, which is enough
 * because the cast stops at the first point inside.
 */
function blockSampler(corner: Direction | null) {
  return (p: Vec3): BlockHit | null => {
    const [x, y, z] = p;
    if (x < 0 || y < 0 || z < 0 || x > LEVEL_PX || y > LEVEL_PX || z > LEVEL_PX) return null;
    if (corner && !CORNER_KEEPS[corner](x, y)) return null;
    const faces: Array<[Face, number, Vec3]> = [
      ["top", LEVEL_PX - z, [0, 0, 1]],
      ["south", LEVEL_PX - y, [0, 1, 0]],
      ["east", LEVEL_PX - x, [1, 0, 0]],
    ];
    if (corner) faces.push(["diagonal", cornerDistance(corner, x, y), CORNER_NORMAL[corner]]);
    const [face, , normal] = faces.sort((a, b) => a[1] - b[1])[0]!;
    return { face, p, normal };
  };
}

/**
 * Rubble courses of uneven height, the same on every level so a stack of
 * walls lines up. `COURSE_TOPS` are where each course's mortar bed starts.
 */
const COURSE_TOPS = [0, 3, 5, 8];
/** Where each course's vertical joints fall across one cell, so stones run two to four pixels long. */
const COURSE_JOINTS = [
  [0, 3, 5.5],
  [1.5, 4, 7],
  [0.5, 2.5, 6],
];

function hash(a: number, b: number): number {
  const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

type Stone = { mortar: boolean; alt: boolean };

/** Which stone of the rubble `(along, z)` falls in, or whether it is in the mortar between two. */
function rubbleAt(along: number, z: number): Stone {
  const course = COURSE_TOPS.findIndex((top, i) => z >= top && z < (COURSE_TOPS[i + 1] ?? 99));
  if (course < 0 || course >= COURSE_JOINTS.length) return { mortar: false, alt: false };
  if (z - COURSE_TOPS[course]! < 0.8) return { mortar: true, alt: false };
  const wrapped = ((along % LEVEL_PX) + LEVEL_PX) % LEVEL_PX;
  const joints = COURSE_JOINTS[course]!;
  if (joints.some((j) => Math.abs(wrapped - j) < 0.45)) return { mortar: true, alt: false };
  const stone = joints.filter((j) => j <= wrapped).length;
  return { mortar: false, alt: hash(course, stone) > 0.6 };
}

function faceAlong(face: Face, p: Vec3, normal: Vec3): number {
  const [x, y] = p;
  if (face === "south") return x;
  if (face === "east") return y;
  return Math.abs(normal[0] - normal[1]) > 1 ? (x + y) / Math.SQRT2 : (x - y) / Math.SQRT2;
}

function shadeStone(face: Face, p: Vec3, normal: Vec3, ramp: Ramp): number {
  if (face === "top") return ramp.top;
  const lit = face === "south" || (face === "diagonal" && normal[1] > 0 && normal[0] <= 0);
  const stone = rubbleAt(faceAlong(face, p, normal), p[2]);
  if (stone.mortar) return lit ? ramp.southMortar : ramp.eastMortar;
  if (lit) return stone.alt ? ramp.southAlt : ramp.south;
  return stone.alt ? ramp.eastAlt : ramp.east;
}

function shadeBlock(hit: BlockHit, ramp: Ramp): number {
  return shadeStone(hit.face, hit.p, hit.normal, ramp);
}

const CENTRE = LEVEL_PX / 2;

/** Whether `(x, y)` lies on a wall of half-width `half` from the cell's centre towards a connected neighbour, and how far along it. */
function onArm(
  x: number,
  y: number,
  edges: number,
  half: number,
): { axis: "ns" | "ew"; along: number } | null {
  const dx = x - CENTRE;
  const dy = y - CENTRE;
  if (Math.abs(dy) <= half && ((edges & E && dx >= 0) || (edges & W && dx <= 0))) {
    return { axis: "ew", along: Math.abs(dx) };
  }
  if (Math.abs(dx) <= half && ((edges & S && dy >= 0) || (edges & N && dy <= 0))) {
    return { axis: "ns", along: Math.abs(dy) };
  }
  return null;
}

type ThinHit = { face: Face; p: Vec3; normal: Vec3 };

/** The face of a thin wall a point is on: its top within `lid` of `top`, otherwise the side the camera sees. */
function thinHit(p: Vec3, top: number, axis: "ns" | "ew" | "pier", lid = 0.8): ThinHit {
  if (p[2] > top - lid) return { face: "top", p, normal: [0, 0, 1] };
  if (axis === "ns") return { face: "east", p, normal: [1, 0, 0] };
  if (axis === "ew") return { face: "south", p, normal: [0, 1, 0] };
  const dx = p[0] - CENTRE;
  const dy = p[1] - CENTRE;
  return dy >= dx
    ? { face: "south", p, normal: [0, 1, 0] }
    : { face: "east", p, normal: [1, 0, 0] };
}

const PIER_HALF = 1.2;
const ARM_HALF = 1;
const ARCH_SPRING = 3;
/** Half the opening between two piers, one in each of two neighbouring cells. */
const ARCH_HALF_SPAN = CENTRE - PIER_HALF;

/**
 * A stone pier at the cell's centre and a round arch to each neighbour that
 * is arcade too: open below the arch, solid stone above it to the top of the
 * level. The arch's crown is on the edge between the two cells, so each cell
 * draws half of it.
 */
function arcadeSampler(edges: number) {
  return (p: Vec3): ThinHit | null => {
    const [x, y, z] = p;
    if (z < 0 || z > LEVEL_PX || x < 0 || y < 0 || x > LEVEL_PX || y > LEVEL_PX) return null;
    if (Math.abs(x - CENTRE) <= PIER_HALF && Math.abs(y - CENTRE) <= PIER_HALF) {
      return thinHit(p, LEVEL_PX, "pier");
    }
    const arm = onArm(x, y, edges, ARM_HALF);
    if (!arm) return null;
    const fromCrown = CENTRE - arm.along;
    const intrados = ARCH_SPRING + Math.sqrt(Math.max(0, ARCH_HALF_SPAN ** 2 - fromCrown ** 2));
    if (z < intrados) return null;
    return thinHit(p, LEVEL_PX, arm.axis);
  };
}

const PARAPET_TOP = 4;
const CRENEL_TOP = 2.5;
const MERLON_HALF = 1.6;

/**
 * A stone parapet the height of `fence`, along the cell's centre lines to each
 * neighbour that is parapet too, with a merlon at the centre of every cell and
 * the crenel between two merlons on the edge the cells share.
 */
function parapetSampler(edges: number) {
  return (p: Vec3): ThinHit | null => {
    const [x, y, z] = p;
    if (z < 0 || z > PARAPET_TOP || x < 0 || y < 0 || x > LEVEL_PX || y > LEVEL_PX) return null;
    if (Math.abs(x - CENTRE) <= PIER_HALF && Math.abs(y - CENTRE) <= PIER_HALF) {
      return thinHit(p, PARAPET_TOP, "pier", 0.6);
    }
    const arm = onArm(x, y, edges, ARM_HALF);
    if (!arm) return null;
    const top = arm.along <= MERLON_HALF ? PARAPET_TOP : CRENEL_TOP;
    if (z > top) return null;
    return thinHit(p, top, arm.axis, 0.6);
  };
}

/** The arcade and parapet are dressed stone, so they take the rubble's colours but are cut in longer courses. */
function shadeThin(hit: ThinHit, ramp: Ramp): number {
  return shadeStone(hit.face, hit.p, hit.normal, ramp);
}

type CapHit = { part: "cone" | "eave" | "finial"; normal: Vec3; course: boolean };

/** The footprint's middle, in pixels of the south-east cell the tile is anchored in. */
const CAP_CENTRE = CELL_SIZE / 2 - (CAP_FOOTPRINT - 1) * CELL_SIZE * 0.5;
const CAP_RADIUS = (CAP_FOOTPRINT * CELL_SIZE) / 2 + 1;
const EAVE_TOP = 1.5;
const CONE_APEX = 10;
const FINIAL_Z = 12;
/** The cone is laid in rings of stone slabs, a course every two pixels of height. */
const ROOF_COURSE_PX = 2;

function normalise(v: Vec3): Vec3 {
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
}

/**
 * A cone of stone slabs on a corbelled eave a little wider than the room, with
 * a stone knob on top. The eave overhangs the arcade by one pixel so the roof
 * reads as sitting on it rather than inside it.
 */
function sampleCap(p: Vec3): CapHit | null {
  const dx = p[0] - CAP_CENTRE;
  const dy = p[1] - CAP_CENTRE;
  const z = p[2];
  const r = Math.hypot(dx, dy);
  const finial = Math.hypot(dx, dy, z - FINIAL_Z);
  if (finial <= 1.6)
    return { part: "finial", normal: normalise([dx, dy, z - FINIAL_Z]), course: false };
  if (r <= 0.5 && z >= CONE_APEX - 1 && z <= FINIAL_Z) {
    return { part: "finial", normal: normalise([dx || 0.01, dy || 0.01, 0]), course: false };
  }
  if (z < 0) return null;
  if (z <= EAVE_TOP && r <= CAP_RADIUS) {
    return { part: "eave", normal: normalise([dx, dy, 0.2]), course: false };
  }
  const coneRadius = (CAP_RADIUS - 1) * (1 - (z - EAVE_TOP) / (CONE_APEX - EAVE_TOP));
  if (z > EAVE_TOP && r <= coneRadius) {
    const slope = (CAP_RADIUS - 1) / (CONE_APEX - EAVE_TOP);
    const normal = normalise([dx, dy, r * slope]);
    const course = (z - EAVE_TOP) % ROOF_COURSE_PX < 0.5;
    return { part: "cone", normal, course };
  }
  return null;
}

/** Lit from the south-west, as every other block here: `across` runs from the lit side to the dark one. */
function rampAcross(normal: Vec3, ramp: readonly number[]): number {
  const across = (normal[0] - normal[1]) / Math.SQRT2 - normal[2] * 0.6;
  const band = Math.floor(((across + 1) / 2) * ramp.length);
  return Math.max(0, Math.min(ramp.length - 1, band));
}

function shadeCap(hit: CapHit): number {
  if (hit.part === "finial") return [25, 22, 8][rampAcross(hit.normal, [0, 1, 2])]!;
  if (hit.part === "eave") return [25, 22, 8][rampAcross(hit.normal, [0, 1, 2])]!;
  const band = rampAcross(hit.normal, ROOF_RAMP);
  return ROOF_RAMP[Math.min(ROOF_RAMP.length - 1, band + (hit.course ? 1 : 0))]!;
}

type Beat = "rest" | "swell" | "beat";

/**
 * Wyrd's stone gets brighter with each beat, and the rune cut into its south
 * face brightest of all. Every ramp is reds from the palette, light to dark.
 */
const HEART: Record<Beat, { stone: readonly number[]; rune: number }> = {
  rest: { stone: [9, 3, 2], rune: 10 },
  swell: { stone: [10, 9, 3], rune: 14 },
  beat: { stone: [14, 10, 9], rune: 28 },
};

type WyrdHit = { part: "stone" | "rune" | "plinth"; normal: Vec3 };

/**
 * Wyrd stands a little taller than a body on its plinth, so it needs three
 * cells of sprite where every other small thing here has two.
 */
const WYRD_CELLS = 3;
const WYRD_PX = WYRD_CELLS * CELL_SIZE;
const WYRD: Projection = { spritePx: WYRD_PX, groundPx: WYRD_PX - CELL_SIZE, topPx: WYRD_PX - 1 };
const STONE_Z = 8.4;
const STONE_R: Vec3 = [3.4, 3.4, 4.4];
/** The plinth's top is where the stone's point rests. */
const PLINTH_TOP = 4;

/**
 * A stone the shape of a heart set point-down on a stone plinth: an
 * ellipsoid pinched at its foot, with a notch at the top between two lobes.
 * The rune is a stave and a crossbar on the side that faces the camera.
 */
function sampleWyrd(p: Vec3): WyrdHit | null {
  const dx = p[0] - CENTRE;
  const dy = p[1] - CENTRE;
  const dz = p[2] - STONE_Z;
  const pinch = 1 - Math.max(0, -dz / STONE_R[2]) * 0.55;
  const rx = STONE_R[0] * pinch;
  const ry = STONE_R[1] * pinch;
  const notch = dz > STONE_R[2] * 0.55 && Math.abs(dx - dy) < 0.9;
  const inside = (dx / rx) ** 2 + (dy / ry) ** 2 + (dz / STONE_R[2]) ** 2 <= 1;
  if (inside && !notch) {
    const normal = normalise([dx / rx ** 2, dy / ry ** 2, dz / STONE_R[2] ** 2]);
    const facesCamera = normal[1] > 0.35 && normal[0] < 0.5;
    const stave = Math.abs(dx) < 0.6 && Math.abs(dz) < 2.8;
    const bar = Math.abs(dz - 0.9) < 0.55 && Math.abs(dx) < 1.9;
    const branch = Math.abs(dz + 1 - dx * 0.8) < 0.5 && dx > 0 && dx < 1.8;
    if (facesCamera && (stave || bar || branch)) return { part: "rune", normal };
    return { part: "stone", normal };
  }
  const half = p[2] > PLINTH_TOP - 0.8 ? 2.6 : 2.1;
  if (p[2] < 0 || p[2] > PLINTH_TOP || Math.abs(dx) > half || Math.abs(dy) > half) return null;
  if (p[2] > PLINTH_TOP - 0.6) return { part: "plinth", normal: [0, 0, 1] };
  return { part: "plinth", normal: half - dy < half - dx ? [0, 1, 0] : [1, 0, 0] };
}

function shadeWyrd(hit: WyrdHit, beat: Beat): number {
  if (hit.part === "plinth") {
    if (hit.normal[2] > 0) return RUBBLE.top;
    return hit.normal[1] > 0 ? RUBBLE.south : RUBBLE.east;
  }
  if (hit.part === "rune") return HEART[beat].rune;
  const ramp = HEART[beat].stone;
  return ramp[rampAcross(hit.normal, ramp)]!;
}

/**
 * A heartbeat: two beats close together, then a long rest, about forty-five a
 * minute. The light keeps its radius and swells only in intensity, so each
 * beat changes how bright the island is and not how far it reaches.
 */
const HEARTBEAT: Array<{ beat: Beat; durationMs: number; intensity: number }> = [
  { beat: "beat", durationMs: 130, intensity: 1 },
  { beat: "swell", durationMs: 110, intensity: 0.85 },
  { beat: "beat", durationMs: 150, intensity: 0.97 },
  { beat: "swell", durationMs: 200, intensity: 0.8 },
  { beat: "rest", durationMs: 750, intensity: 0.68 },
];
const WYRD_LIGHT = { radius: 15, color: "#e0304a" };

/** Motes of the heart's light drifting up off the stone and fading through darker reds. */
const WYRD_PARTICLES: ParticleEmitterDef = {
  ratePerSecond: 7,
  ttlFromMs: 1600,
  ttlToMs: 2800,
  spawnRadiusCells: 0.3,
  spawnElevFrom: 2,
  spawnElevTo: 4,
  riseFrom: 1.2,
  riseTo: 2.4,
  driftCellsPerSecond: 0.08,
  lit: false,
  ownDepth: false,
  gravity: 0,
  offsetX: "0.15 * sin(AGE_SEC * 2 + SEED * 2 * PI)",
  offsetY: "",
  offsetElev: "",
  shape: null,
  sizeFromPx: 5,
  sizeToPx: null,
  radiusFromPx: 1,
  radiusToPx: 0,
  alphaFrom: 1,
  alphaTo: 0,
  ramp: [
    { at: 0, color: "#ffffff" },
    { at: 0.2, color: "#e83b3b" },
    { at: 0.6, color: "#ae2334" },
    { at: 1, color: "#6e2727" },
  ],
};

/** Every model here is written in pixels at 1×; a cast at another scale divides the point back down. */
function atScale<H>(sample: (p: Vec3) => H | null) {
  return (p: Vec3, scale: number) => sample([p[0] / scale, p[1] / scale, p[2] / scale]);
}

type Cast = { pixels: Int16Array; size: number };

function blit(sheet: PNG, cast: Cast, cellX: number, cellY: number) {
  for (let i = 0; i < cast.pixels.length; i++) {
    const index = cast.pixels[i]!;
    if (index < 0) continue;
    paint(
      sheet,
      cellX * CELL_SIZE + (i % cast.size),
      cellY * CELL_SIZE + Math.floor(i / cast.size),
      index,
    );
  }
}

function frameAt(x: number, y: number, cells = SMALL_CELLS): Frame {
  return {
    sprite: { rect: { x, y, w: cells, h: cells }, base: { x: cells - 1, y: cells - 1 } },
    durationMs: 200,
  };
}

/** Sheet layout, in cells: one row of blocks, two of arcade, two of parapet, then Wyrd and the roof. */
const BLOCK_ROW = 0;
const ARCADE_ROW = 2;
const PARAPET_ROW = 6;
const WYRD_ROW = 10;
const CAP_COLUMN = 10;
const SHEET_CELLS = { w: 20, h: WYRD_ROW + CAP_CELLS };
const DIRECTIONS: Direction[] = ["n", "e", "s", "w"];

/** The sprite for a set of connected edges, sixteen to a block of two rows. */
function edgeCell(row: number, edges: number): { x: number; y: number } {
  const index =
    (edges & N ? 1 : 0) | (edges & E ? 2 : 0) | (edges & S ? 4 : 0) | (edges & W ? 8 : 0);
  return { x: (index % 8) * SMALL_CELLS, y: row + Math.floor(index / 8) * SMALL_CELLS };
}

const EDGE_SETS = Array.from(
  { length: 16 },
  (_, i) => (i & 1 ? N : 0) | (i & 2 ? E : 0) | (i & 4 ? S : 0) | (i & 8 ? W : 0),
);

function slicesFor(row: number) {
  const slices: Record<string, { frames: Frame[] }> = {};
  for (let slice = 0; slice < AUTOTILE_SLICE_COUNT; slice++) {
    const cell = edgeCell(row, AUTOTILE_SLICE_MASKS[slice]! & (N | E | S | W));
    slices[String(slice)] = { frames: [frameAt(cell.x, cell.y)] };
  }
  return slices;
}

async function preview<H>(name: string, model: Model<H>, projection: Projection) {
  if (!process.env.PREVIEW) return;
  await writeCast(
    path.join(process.env.PREVIEW, `${name}-4x.png`),
    castModel(model, projection, 4),
    projection.spritePx * 4,
  );
}

async function main() {
  const sheet = new PNG({ width: SHEET_CELLS.w * CELL_SIZE, height: SHEET_CELLS.h * CELL_SIZE });
  sheet.data.fill(0);
  const anchor = { tilesetId: TILESET_ID, x: 0, y: 0 };
  const tiles: TileDef[] = [];

  const finishes = [
    { id: "lighthouse-wall", name: "Lighthouse Wall", ramp: RUBBLE, column: 0 },
    {
      id: "lighthouse-wall-limewashed",
      name: "Lighthouse Wall (limewashed)",
      ramp: LIMEWASH,
      column: 2,
    },
  ];
  for (const finish of finishes) {
    const model = {
      sample: atScale(blockSampler(null)),
      shade: (hit: BlockHit) => shadeBlock(hit, finish.ramp),
    };
    blit(sheet, { pixels: castModel(model, SMALL), size: SMALL_PX }, finish.column, BLOCK_ROW);
    await preview(finish.id, model, SMALL);
    tiles.push({
      id: finish.id,
      name: finish.name,
      height: 4,
      type: "simple",
      kind: "prop",
      attributes: {},
      anchor,
      sprite: { frames: [frameAt(finish.column, BLOCK_ROW)] },
    } as TileDef);
  }

  for (const [f, finish] of finishes.entries()) {
    const sprites: Partial<Record<Direction, { frames: Frame[] }>> = {};
    for (const [d, facing] of DIRECTIONS.entries()) {
      const column = 4 + (f * 4 + d) * SMALL_CELLS;
      const model = {
        sample: atScale(blockSampler(facing)),
        shade: (hit: BlockHit) => shadeBlock(hit, finish.ramp),
      };
      blit(sheet, { pixels: castModel(model, SMALL), size: SMALL_PX }, column, BLOCK_ROW);
      await preview(`${finish.id}-corner-${facing}`, model, SMALL);
      sprites[facing] = { frames: [frameAt(column, BLOCK_ROW)] };
    }
    tiles.push({
      id: `${finish.id}-corner`,
      name: `${finish.name} corner`,
      height: 4,
      type: "directional",
      kind: "prop",
      attributes: {},
      anchor,
      sprites,
    } as TileDef);
  }

  for (const edges of EDGE_SETS) {
    const arcade = {
      sample: atScale(arcadeSampler(edges)),
      shade: (hit: ThinHit) => shadeThin(hit, RUBBLE),
    };
    const parapet = {
      sample: atScale(parapetSampler(edges)),
      shade: (hit: ThinHit) => shadeThin(hit, RUBBLE),
    };
    const a = edgeCell(ARCADE_ROW, edges);
    const r = edgeCell(PARAPET_ROW, edges);
    blit(sheet, { pixels: castModel(arcade, SMALL), size: SMALL_PX }, a.x, a.y);
    blit(sheet, { pixels: castModel(parapet, SMALL), size: SMALL_PX }, r.x, r.y);
    if (edges === (E | W)) {
      await preview("lighthouse-arcade-ew", arcade, SMALL);
      await preview("lighthouse-parapet-ew", parapet, SMALL);
    }
  }
  tiles.push({
    id: "lighthouse-arcade",
    name: "Lighthouse Arcade",
    height: 4,
    type: "autotile",
    kind: "prop",
    attributes: {},
    anchor,
    lightPassing: true,
    walkable: false,
    slices: slicesFor(ARCADE_ROW),
  } as TileDef);
  tiles.push({
    id: "lighthouse-parapet",
    name: "Lighthouse Parapet",
    height: 2,
    type: "autotile",
    kind: "prop",
    attributes: {},
    anchor,
    lightPassing: true,
    walkable: false,
    slices: slicesFor(PARAPET_ROW),
  } as TileDef);

  const beats: Beat[] = ["rest", "swell", "beat"];
  for (const [i, beat] of beats.entries()) {
    const model = { sample: atScale(sampleWyrd), shade: (hit: WyrdHit) => shadeWyrd(hit, beat) };
    const pixels = outlineBelow(castModel(model, WYRD), WYRD_PX, 0);
    blit(sheet, { pixels, size: WYRD_PX }, i * WYRD_CELLS, WYRD_ROW);
    await preview(`wyrd-${beat}`, model, WYRD);
  }
  tiles.push({
    id: "wyrd",
    name: "Wyrd",
    height: 4,
    type: "simple",
    kind: "prop",
    attributes: {},
    anchor,
    lightPassing: true,
    walkable: false,
    sprite: {
      frames: HEARTBEAT.map((step) => ({
        ...frameAt(beats.indexOf(step.beat) * WYRD_CELLS, WYRD_ROW, WYRD_CELLS),
        durationMs: step.durationMs,
        light: { ...WYRD_LIGHT, intensity: step.intensity },
      })),
    },
    particles: WYRD_PARTICLES,
  } as TileDef);

  const cap = { sample: atScale(sampleCap), shade: shadeCap };
  blit(
    sheet,
    { pixels: outlineBelow(castModel(cap, CAP), CAP_PX, 2), size: CAP_PX },
    CAP_COLUMN,
    WYRD_ROW,
  );
  tiles.push({
    id: "lighthouse-roof",
    name: "Lighthouse Roof",
    height: 8,
    type: "simple",
    kind: "prop",
    attributes: {},
    anchor,
    footprint: { w: CAP_FOOTPRINT, d: CAP_FOOTPRINT },
    sprite: { frames: [frameAt(CAP_COLUMN, WYRD_ROW, CAP_CELLS)] },
  } as TileDef);

  await writeTileset(TILESET_ID, "Lighthouse", sheet, tiles);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
