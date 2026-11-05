import { PNG } from "pngjs";
import { PX_PER_HEIGHT } from "../app/lib/geometry";
import { CELL_SIZE, DIRECTIONS, type Direction, type TileDef } from "../app/lib/types";
import { type Rgba, paintRgba, writeTileset } from "./tileset-output";

const TILESET_ID = "ramps";
const RISE = 2;
const STEPS = 4;

const SPRITE_CELLS = 2;
const SPRITE_PX = SPRITE_CELLS * CELL_SIZE;
const MARCH_STEP = 1 / 256;
const ON_SURFACE = 0.02;

const hex = (value: string): Rgba => {
  const n = Number.parseInt(value.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
};

/** The colours of the `tiny-ranch-tiles` sprites both tiles were drawn with before they had a facing each. */
const RAMP = {
  outline: hex("#6e2727"),
  top: hex("#fbb954"),
  speck: hex("#e6904e"),
  side: hex("#9e4539"),
};
const STAIRS = {
  tread: hex("#9babb2"),
  edge: hex("#45293f"),
  side: hex("#694f62"),
};

type Surface = (x: number, y: number) => number;

/**
 * A ramp facing `s` is climbed heading north, so its high edge is the one
 * opposite its facing: `climbFrom` reads facing `s` as "may climb `n`".
 */
const UPHILL: Record<Direction, Direction> = { s: "n", n: "s", e: "w", w: "e" };

/** How far towards the uphill edge a point is, 0 at the low edge and 1 at the high one. */
function climbed(facing: Direction, x: number, y: number): number {
  switch (UPHILL[facing]) {
    case "n":
      return (CELL_SIZE - y) / CELL_SIZE;
    case "s":
      return y / CELL_SIZE;
    case "w":
      return (CELL_SIZE - x) / CELL_SIZE;
    case "e":
      return x / CELL_SIZE;
  }
}

const rampSurface =
  (facing: Direction): Surface =>
  (x, y) =>
    RISE * climbed(facing, x, y);

const stairSurface =
  (facing: Direction): Surface =>
  (x, y) =>
    (RISE / STEPS) * Math.min(Math.ceil(climbed(facing, x, y) * STEPS), STEPS);

type Hit =
  | { face: "top"; x: number; y: number }
  | { face: "south" | "east"; outer: boolean; x: number; y: number };

const inCell = (v: number) => v >= 0 && v < CELL_SIZE;

/**
 * Marches the view ray down from the tile's top until it enters the solid. A
 * point `h` units up draws `PX_PER_HEIGHT * h` px up and to the left, so the
 * ray through a screen pixel is `(X + 2h, Y + 2h, h)`; what it last crossed
 * before entering says which face it hit.
 */
function cast(surface: Surface, X: number, Y: number): Hit | null {
  let prev: { x: number; y: number } | null = null;
  for (let h = RISE + 0.01; h >= 0; h -= MARCH_STEP) {
    const x = X + PX_PER_HEIGHT * h;
    const y = Y + PX_PER_HEIGHT * h;
    if (inCell(x) && inCell(y) && h <= surface(x, y)) {
      if (!prev || surface(x, y) - h < ON_SURFACE) return { face: "top", x, y };
      if (!inCell(prev.y)) return { face: "south", outer: true, x, y };
      if (!inCell(prev.x)) return { face: "east", outer: true, x, y };
      const face = surface(x, prev.y) < h ? "south" : "east";
      return { face, outer: false, x, y };
    }
    prev = { x, y };
  }
  return null;
}

/** A fixed scatter of darker grit on the ramp's surface, keyed to the world pixel so it does not move between facings. */
function speckled(x: number, y: number): boolean {
  const n = (Math.floor(x) * 73 + Math.floor(y) * 151 + Math.floor(x) * Math.floor(y) * 31) % 11;
  return n === 0 || n === 7;
}

function rampColour(hit: Hit): Rgba {
  if (hit.face !== "top") return RAMP.side;
  return speckled(hit.x, hit.y) ? RAMP.speck : RAMP.top;
}

/**
 * A flight climbed towards the camera hides its risers behind its treads and
 * shows one pixel of each tread, so alternate treads are shaded or the steps
 * read as one slope.
 */
function stairColour(facing: Direction, surface: Surface, hit: Hit): Rgba {
  if (hit.face !== "top") return hit.outer ? STAIRS.side : STAIRS.edge;
  const uphill = UPHILL[facing];
  if (uphill === "n" || uphill === "w") return STAIRS.tread;
  const step = Math.round(surface(hit.x, hit.y) / (RISE / STEPS));
  return step % 2 === 0 ? STAIRS.tread : STAIRS.side;
}

function drawSprite(
  sheet: PNG,
  left: number,
  top: number,
  surface: Surface,
  colour: (hit: Hit) => Rgba,
  outline: Rgba | null,
) {
  for (let sy = 0; sy < SPRITE_PX; sy++) {
    let first = true;
    for (let sx = 0; sx < SPRITE_PX; sx++) {
      const hit = cast(surface, sx - CELL_SIZE + 0.5, sy - CELL_SIZE + 0.5);
      if (!hit) continue;
      const rgba = outline && first && hit.face === "top" ? outline : colour(hit);
      first = false;
      paintRgba(sheet, left + sx, top + sy, rgba);
    }
  }
}

function frames(x: number, y: number) {
  return {
    frames: [
      {
        sprite: { rect: { x, y, w: SPRITE_CELLS, h: SPRITE_CELLS }, base: { x: 1, y: 1 } },
        durationMs: 200,
      },
    ],
  };
}

function tileDef(id: string, row: number): TileDef {
  return {
    id,
    type: "directional",
    anchor: { tilesetId: TILESET_ID, x: 0, y: row * SPRITE_CELLS },
    sprites: Object.fromEntries(
      DIRECTIONS.map((facing, column) => [facing, frames(column * SPRITE_CELLS, 0)]),
    ),
  } as unknown as TileDef;
}

const sheet = new PNG({ width: DIRECTIONS.length * SPRITE_PX, height: 2 * SPRITE_PX });
DIRECTIONS.forEach((facing, column) => {
  const left = column * SPRITE_PX;
  drawSprite(sheet, left, 0, rampSurface(facing), rampColour, RAMP.outline);
  const stairs = stairSurface(facing);
  drawSprite(sheet, left, SPRITE_PX, stairs, (hit) => stairColour(facing, stairs, hit), null);
});

await writeTileset(TILESET_ID, "Ramps", sheet, [tileDef("ramp", 0), tileDef("stone-stairs", 1)]);
