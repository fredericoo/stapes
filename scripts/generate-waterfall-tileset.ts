import { PNG } from "pngjs";
import { PX_PER_HEIGHT } from "../app/lib/geometry";
import { CELL_SIZE, type TileDef } from "../app/lib/types";
import { paintRgba, paletteRgba, type Rgba, writeTileset } from "./tileset-output";

const TILESET_ID = "waterfall";
const FRAME_COUNT = 8;
const FRAME_MS = 90;

const CELL = CELL_SIZE;
const SPRITE_CELLS = 2;
const SPRITE_PX = SPRITE_CELLS * CELL;

const SEGMENT_HEIGHT_UNITS = 2;
const RISE_PX = SEGMENT_HEIGHT_UNITS * PX_PER_HEIGHT;
/** How far south of the cell's north edge the falling sheet stands, so it hides the cliff face behind it. */
const SHEET_DEPTH_PX = 1;
/**
 * The cliff's top edge draws a row of outline and a row of stone between the
 * river above and the fall. The top segment lays water over the pair, one
 * pixel into the cell north of it and one on top of its own sheet.
 */
const LIP_REACH_PX = 1;

/** The `water` tile's own three blues, so a river runs into the fall without a seam in colour. */
const SHADOW: Rgba = [0x24, 0x43, 0x6b, 255];
const BASE: Rgba = [0x33, 0x5c, 0x8c, 255];
const HIGHLIGHT: Rgba = [0x5b, 0x8f, 0xbf, 255];
const SPRAY = paletteRgba(27);
const FOAM = paletteRgba(28);

const INK: Record<string, Rgba> = { s: SHADOW, b: BASE, h: HIGHLIGHT, p: SPRAY, f: FOAM };

/**
 * One streak per column of the sheet, read bottom to top and repeating every
 * four pixels of height — a segment's height — so stacked segments meet on the
 * same colour. A streak moves down `speed` pixels a frame; eight frames of one or
 * two pixels each bring every streak back to where it started.
 */
const STREAKS: { pattern: string; speed: number }[] = [
  { pattern: "bbbh", speed: 1 },
  { pattern: "hhhp", speed: 2 },
  { pattern: "bbbs", speed: 1 },
  { pattern: "bbhb", speed: 2 },
  { pattern: "hhhb", speed: 1 },
  { pattern: "sbbs", speed: 2 },
  { pattern: "hhph", speed: 2 },
  { pattern: "bbbh", speed: 1 },
];

type Segment = { tileId: string; name: string; lip: boolean; pool: boolean };

const SEGMENTS: Segment[] = [
  { tileId: "waterfall-top", name: "Waterfall (top)", lip: true, pool: false },
  { tileId: "waterfall-middle", name: "Waterfall (middle)", lip: false, pool: false },
  { tileId: "waterfall-base", name: "Waterfall (base)", lip: false, pool: true },
];

function hash(x: number, y: number, salt: number): number {
  let h = Math.imul(x + 1, 0x27d4eb2d) ^ Math.imul(y + 1, 0x165667b1) ^ Math.imul(salt, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function streakAt(x: number, z: number, frame: number): Rgba {
  const { pattern, speed } = STREAKS[x]!;
  const at = (((z + speed * frame) % pattern.length) + pattern.length) % pattern.length;
  return INK[pattern[at]!]!;
}

const LIP_CURL_PX = 1;
const SPLASH_PX = 1;

/**
 * The falling face of the sheet: a point at height `z` stands `z` pixels up and
 * to the left of the cell's floor, and the sheet's south face is
 * `SHEET_DEPTH_PX` into the cell, so screen row `v` holds one height.
 */
function sheetPixel(segment: Segment, u: number, v: number, frame: number): Rgba | null {
  const z = CELL + SHEET_DEPTH_PX - v - 0.5;
  const x = Math.floor(u - CELL + z + 0.5);
  if (z < 0 || z >= RISE_PX || x < 0 || x >= CELL) return null;
  if (segment.lip && z >= RISE_PX - LIP_CURL_PX) return hash(x, frame, 1) < 0.4 ? FOAM : SPRAY;
  if (segment.pool && z < SPLASH_PX) return hash(x, frame, 2) < 0.5 ? FOAM : SPRAY;
  return streakAt(x, Math.floor(z), frame);
}

type Vec3 = [number, number, number];
type Bubble = { x: number; radius: number; offset: number; reach: number; rise: number };

const BUBBLE_COUNT = 18;

/**
 * The splash is a heap of bubbles, each thrown south out of the foot of the
 * fall on an arc and shrinking as it goes. A bubble's life is the whole
 * cycle, staggered by `offset`, so the heap churns without a frame where it
 * all starts again.
 */
const BUBBLES: Bubble[] = Array.from({ length: BUBBLE_COUNT }, (_, i) => ({
  x: 0.8 + 6.4 * hash(i, 0, 5),
  radius: 1 + 0.9 * hash(i, 1, 5),
  offset: i / BUBBLE_COUNT + 0.3 * hash(i, 2, 5),
  reach: 1.5 + 2 * hash(i, 3, 5),
  rise: 1 + 1.5 * hash(i, 4, 5),
}));

function bubbleAt(bubble: Bubble, frame: number): { centre: Vec3; radius: number } {
  const t = (frame / FRAME_COUNT + bubble.offset) % 1;
  const centre: Vec3 = [
    bubble.x,
    SHEET_DEPTH_PX + 0.5 + t * bubble.reach,
    0.3 + Math.sin(Math.PI * t) * bubble.rise,
  ];
  return { centre, radius: bubble.radius * (1 - 0.5 * t) };
}

const FOAM_STEP_PX = 1 / 16;
const FOAM_SUPERSAMPLE = 3;

/**
 * Walks the view ray down through the heap, as the fall's face is walked: a
 * point at height `z` is drawn `z` pixels up and to the left of where it stands.
 */
function foamNormal(u: number, v: number, frame: number): Vec3 | null {
  const bubbles = BUBBLES.map((bubble) => bubbleAt(bubble, frame));
  for (let z = RISE_PX; z > 0; z -= FOAM_STEP_PX) {
    const p: Vec3 = [u - CELL + z, v - CELL + z, z];
    for (const { centre, radius } of bubbles) {
      const d: Vec3 = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]];
      const off = Math.hypot(...d);
      if (off <= radius) return [d[0] / off, d[1] / off, d[2] / off];
    }
  }
  return null;
}

/** White where the heap faces up or toward the light, spray on its flanks, water in its shade. */
function foamTone(normal: Vec3): Rgba {
  const across = (normal[0] - normal[1]) / Math.SQRT2 - normal[2];
  if (across < -0.6) return FOAM;
  return across < 0.4 ? SPRAY : HIGHLIGHT;
}

function foamPixel(u: number, v: number, frame: number): Rgba | null {
  const votes = new Map<Rgba, number>();
  let hits = 0;
  for (let j = 0; j < FOAM_SUPERSAMPLE; j++) {
    for (let i = 0; i < FOAM_SUPERSAMPLE; i++) {
      const normal = foamNormal(
        u + (i + 0.5) / FOAM_SUPERSAMPLE,
        v + (j + 0.5) / FOAM_SUPERSAMPLE,
        frame,
      );
      if (!normal) continue;
      hits++;
      const tone = foamTone(normal);
      votes.set(tone, (votes.get(tone) ?? 0) + 1);
    }
  }
  if (hits * 2 < FOAM_SUPERSAMPLE * FOAM_SUPERSAMPLE) return null;
  return [...votes].sort((a, b) => b[1] - a[1])[0]![0];
}

const POOL_DEPTH_PX = 4;

/**
 * Foam on the floor of the cell, thinning to the south and drifting away from
 * the fall half a pixel a frame, which is four pixels over the cycle: the
 * period the foam repeats with, so the last frame runs into the first.
 */
function poolPixel(u: number, v: number, frame: number): Rgba | null {
  const y = v - CELL + 0.5;
  const x = u - CELL;
  if (y < SHEET_DEPTH_PX || y >= SHEET_DEPTH_PX + POOL_DEPTH_PX || x < 0 || x >= CELL) return null;
  const out = (y - SHEET_DEPTH_PX) / POOL_DEPTH_PX;
  const drifted = Math.floor(y - frame / 2);
  const chance = hash(x, ((drifted % 4) + 4) % 4, 4);
  if (chance < 0.55 * (1 - out)) return FOAM;
  if (chance < 0.85 * (1 - out)) return SPRAY;
  return null;
}

/** Flecks drift south toward the edge a pixel every two frames, as the river's surface does. */
function lipPixel(u: number, v: number, frame: number): Rgba | null {
  const y = v - CELL + RISE_PX + 0.5;
  const x = Math.floor(u - CELL + RISE_PX + 0.5);
  if (y < -LIP_REACH_PX || y >= SHEET_DEPTH_PX || x < 0 || x >= CELL) return null;
  const drifted = Math.floor(y) - Math.floor(frame / 2);
  return hash(x, ((drifted % 4) + 4) % 4, 3) < 0.2 ? HIGHLIGHT : SHADOW;
}

function framePixel(segment: Segment, u: number, v: number, frame: number): Rgba | null {
  const splash = segment.pool ? foamPixel(u, v, frame) : null;
  if (splash) return splash;
  const fall = sheetPixel(segment, u, v, frame);
  if (fall) return fall;
  if (segment.lip) return lipPixel(u, v, frame);
  return segment.pool ? poolPixel(u, v, frame) : null;
}

function segmentTile(segment: Segment, row: number): TileDef {
  return {
    id: segment.tileId,
    name: segment.name,
    height: SEGMENT_HEIGHT_UNITS,
    type: "simple",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET_ID, x: 0, y: row * SPRITE_CELLS },
    walkable: false,
    lightPassing: true,
    sprite: {
      phase: { x: 3, y: 0 },
      frames: Array.from({ length: FRAME_COUNT }, (_, frame) => ({
        sprite: {
          rect: { x: frame * SPRITE_CELLS, y: 0, w: SPRITE_CELLS, h: SPRITE_CELLS },
          base: { x: 1, y: 1 },
        },
        durationMs: FRAME_MS,
      })),
    },
  };
}

function drawFrame(sheet: PNG, segment: Segment, row: number, frame: number) {
  for (let v = 0; v < SPRITE_PX; v++) {
    for (let u = 0; u < SPRITE_PX; u++) {
      const colour = framePixel(segment, u, v, frame);
      if (colour) paintRgba(sheet, frame * SPRITE_PX + u, row * SPRITE_PX + v, colour);
    }
  }
}

async function main() {
  const sheet = new PNG({ width: FRAME_COUNT * SPRITE_PX, height: SEGMENTS.length * SPRITE_PX });
  sheet.data.fill(0);
  const tiles = SEGMENTS.map((segment, row) => {
    for (let frame = 0; frame < FRAME_COUNT; frame++) drawFrame(sheet, segment, row, frame);
    return segmentTile(segment, row);
  });
  await writeTileset(TILESET_ID, "Waterfall", sheet, tiles);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
