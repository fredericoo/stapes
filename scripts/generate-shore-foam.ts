import { PNG } from "pngjs";
import { AUTOTILE_SLICE_MASKS, E, N, NE, NW, S, SE, SW, W } from "../app/lib/autotile";
import { CELL_SIZE, type TileDef, type TileSprite } from "../app/lib/types";
import { paint, writeTileset } from "./tileset-output";

const TILESET = "shore-foam";
const TILE_ID = "shore-foam";
const CELL = CELL_SIZE;

const FOAM = 28;
const FOAM_SHADE = 27;
const WET_SAND = 18;
/** The body colour of `sand-dunes`, painted where a rounded corner gives back land the square water covered. */
const SAND = 19;

const FRAMES = 8;
const FRAME_MS = 220;
/** One frame apart per cell along both axes, so a wave runs along a straight shore instead of the whole beach lapping at once. */
const PHASE = { x: 1, y: 1 };

/** Distances are in pixels in from the side that faces dry land; under one pixel is the strip `water` leaves cut away. */
const WET_SAND_PX = 1;
const FOAM_OUT_PX = 2.5;
const SWASH_PX = 2;
const FOAM_LINE_HALF_PX = 0.5;
const TRAIL_PX = 2.5;
const TRAIL_KEEP = 0.8;
const BUBBLES_PX = 1;
const BUBBLE_KEEP = 0.3;
const FOAM_FLECK = 0.2;

/**
 * Where water turns a corner with land on both sides, the shore follows a
 * quarter circle and the foam paints sand over the square corner `water`
 * leaves. The circle spans the whole cell when the two sides across from the
 * corner are water, and half of it otherwise, so it never runs into a curve
 * from the opposite corner. Either way it ends tangent to the sides, which
 * is what lets it meet the straight shore of the next cell without a step.
 */
const WIDE_CORNER_RADIUS_PX = CELL;
const NARROW_CORNER_RADIUS_PX = CELL / 2;

const CORNERS: { bit: number; edges: number; across: number; x: number; y: number }[] = [
  { bit: NW, edges: N | W, across: S | E, x: 0, y: 0 },
  { bit: NE, edges: N | E, across: S | W, x: CELL, y: 0 },
  { bit: SW, edges: S | W, across: N | E, x: 0, y: CELL },
  { bit: SE, edges: S | E, across: N | W, x: CELL, y: CELL },
];

/**
 * Distance from a corner along each axis to a pixel centre: a corner with both
 * sides open is a quarter circle, and one with both sides connected but its
 * diagonal open is the point of land poking in.
 */
function cornerDistance(mask: number, corner: (typeof CORNERS)[number], cx: number, cy: number) {
  const along = Math.abs(cx - corner.x);
  const across = Math.abs(cy - corner.y);
  const sidesOpen = (mask & corner.edges) === 0;
  const radius =
    (mask & corner.across) === corner.across ? WIDE_CORNER_RADIUS_PX : NARROW_CORNER_RADIUS_PX;
  if (sidesOpen && along < radius && across < radius) {
    return radius - Math.hypot(radius - along, radius - across);
  }
  const sidesConnected = (mask & corner.edges) === corner.edges;
  if (sidesConnected && !(mask & corner.bit)) return Math.hypot(along, across);
  return Infinity;
}

/** Distance from a pixel's centre to dry land: negative where the rounded shore is land, though `water` drew it. */
function edgeDistance(mask: number, x: number, y: number): number {
  const cx = x + 0.5;
  const cy = y + 0.5;
  let d = Infinity;
  if (!(mask & N)) d = Math.min(d, cy);
  if (!(mask & S)) d = Math.min(d, CELL - cy);
  if (!(mask & W)) d = Math.min(d, cx);
  if (!(mask & E)) d = Math.min(d, CELL - cx);
  for (const corner of CORNERS) d = Math.min(d, cornerDistance(mask, corner, cx, cy));
  return d;
}

/** A fixed per-pixel value in [0, 1), so the foam breaks up the same way on every run and the gaps stay put as the wave moves. */
function grain(x: number, y: number): number {
  let h = Math.imul(x + 1, 0x27d4eb2d) ^ Math.imul(y + 1, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return ((h ^ (h >>> 13)) >>> 0) / 0x1_0000_0000;
}

/** How far the foam line sits from dry land this frame: out at the break, then washed up over the wet sand and back. */
function foamLinePx(frame: number): number {
  const swash = (1 - Math.cos((2 * Math.PI * frame) / FRAMES)) / 2;
  return FOAM_OUT_PX - SWASH_PX * swash;
}

/**
 * A solid line one pixel wide, bubbles thrown a pixel ahead of it, and a trail
 * behind it that thins out towards open water. A trail pixel is kept while its
 * grain is under a share that falls linearly to zero across `TRAIL_PX`.
 */
function pixelColour(d: number, line: number, x: number, y: number): number | null {
  if (d < 0) return SAND;
  const fromLine = d - line;
  if (Math.abs(fromLine) < FOAM_LINE_HALF_PX) return grain(x, y) < FOAM_FLECK ? FOAM_SHADE : FOAM;
  const behind = fromLine - FOAM_LINE_HALF_PX;
  if (behind > 0 && behind < TRAIL_PX) {
    const keep = TRAIL_KEEP * (1 - behind / TRAIL_PX);
    if (grain(y, x) < keep) return grain(x + y, x) < FOAM_FLECK ? FOAM : FOAM_SHADE;
  }
  const ahead = -fromLine - FOAM_LINE_HALF_PX;
  if (ahead > 0 && ahead < BUBBLES_PX && grain(x * 3, y * 5) < BUBBLE_KEEP) return FOAM;
  if (d < WET_SAND_PX) return WET_SAND;
  return null;
}

function foamSheet(): PNG {
  const sheet = new PNG({ width: FRAMES * CELL, height: AUTOTILE_SLICE_MASKS.length * CELL });
  sheet.data.fill(0);
  AUTOTILE_SLICE_MASKS.forEach((mask, slice) => {
    for (let frame = 0; frame < FRAMES; frame++) {
      const line = foamLinePx(frame);
      for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
          const colour = pixelColour(edgeDistance(mask, x, y), line, x, y);
          if (colour !== null) paint(sheet, frame * CELL + x, slice * CELL + y, colour);
        }
      }
    }
  });
  return sheet;
}

function foamTile(): TileDef {
  const slices = AUTOTILE_SLICE_MASKS.map((_, slice): TileSprite => ({
    frames: Array.from({ length: FRAMES }, (_, frame) => ({
      sprite: { rect: { x: frame, y: slice, w: 1, h: 1 }, base: { x: 0, y: 0 } },
      durationMs: FRAME_MS,
    })),
    phase: PHASE,
  }));
  return {
    id: TILE_ID,
    name: "Shore foam",
    height: 0,
    type: "autotile",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET, x: 0, y: 0 },
    lightPassing: true,
    intangible: true,
    connectsTo: ["water", "deep-water"],
    slices: Object.fromEntries(slices.map((s, i) => [i, s])),
  };
}

await writeTileset(TILESET, "Shore Foam", foamSheet(), [foamTile()]);
