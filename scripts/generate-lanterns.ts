import path from "node:path";
import { PNG } from "pngjs";
import { CELL_SIZE, type TileDef } from "../app/lib/types";
import type { Vec3 } from "./limb-caster";
import { castModel, outlineBelow, writeCast } from "./model-caster";
import { paint, writeTileset } from "./tileset-output";

const TILESET_ID = "lanterns";

const SPRITE_CELLS = 2;
const SPRITE_PX = SPRITE_CELLS * CELL_SIZE;
const PROJECTION = { spritePx: SPRITE_PX, groundPx: SPRITE_PX - CELL_SIZE, topPx: SPRITE_PX - 1 };

/** Palette indices, light to dark. */
const IRON = [22, 8, 4];
const IRON_GLINT = 25;
const BRASS = [19, 17, 13];
const WAX = [28, 27, 25];
const WICK = 0;
const EMBER = 12;
const LANTERN_FLAME = 28;
const LIT_GLASS = [19, 18, 17];
const GLOWING_GLASS = [28, 21, 19];
const DARK_GLASS = [23, 7, 5];
const OUTLINE = 0;

type Part = "iron" | "brass" | "wax" | "wick" | "glass" | "glow" | "core";
type Hit = { part: Part; normal: Vec3; lit: boolean };

const CENTRE = CELL_SIZE / 2;
const UP: Vec3 = [0, 0, 1];

function boxNormal(dx: number, dy: number, half: number): Vec3 {
  if (Math.abs(dx) > Math.abs(dy)) return [Math.sign(dx), 0, 0];
  return Math.abs(dy) > 0 || half === 0 ? [0, Math.sign(dy), 0] : UP;
}

/**
 * A flame is a teardrop standing on `foot`: an ellipsoid whose upper half
 * narrows to a point, `height` tall. The lantern's second frame shortens it.
 */
function inFlame(p: Vec3, foot: number, height: number, width: number, scale: number): boolean {
  const dx = p[0] / scale - CENTRE;
  const dy = p[1] / scale - CENTRE;
  const t = (p[2] / scale - foot) / height;
  if (t < 0 || t > 1) return false;
  const radius = width * Math.sin(Math.PI * Math.min(1, t * 1.6) ** 0.7) * (1 - t * 0.6);
  return Math.hypot(dx, dy) <= radius;
}

const LANTERN = {
  baseHalf: 1.7,
  baseTop: 0.5,
  glassHalf: 1.45,
  glassTop: 2.9,
  post: 0.5,
  roofTop: 3.7,
  ringTop: 4.5,
  flameFoot: 0.6,
  flameHeight: 2.1,
  flameWidth: 0.8,
};

function lanternSampler(lit: boolean, flicker: number) {
  const L = LANTERN;
  const flameHeight = L.flameHeight * flicker;
  return (p: Vec3, scale: number): Hit | null => {
    const x = p[0] / scale - CENTRE;
    const y = p[1] / scale - CENTRE;
    const z = p[2] / scale;
    const ax = Math.abs(x);
    const ay = Math.abs(y);
    if (z < 0) return null;
    if (z <= L.baseTop) {
      if (ax > L.baseHalf || ay > L.baseHalf) return null;
      return { part: "iron", normal: z > L.baseTop - 0.25 ? UP : boxNormal(x, y, 1), lit };
    }
    if (z <= L.glassTop) {
      if (ax > L.glassHalf || ay > L.glassHalf) return null;
      const onPost = ax > L.glassHalf - L.post && ay > L.glassHalf - L.post;
      if (onPost) return { part: "iron", normal: boxNormal(x, y, 1), lit };
      if (lit && inFlame(p, L.flameFoot, flameHeight, L.flameWidth, scale)) {
        return { part: "core", normal: UP, lit };
      }
      return { part: behindIsFlame(p, scale) ? "glow" : "glass", normal: boxNormal(x, y, 1), lit };
    }
    if (z <= L.roofTop) {
      const t = (z - L.glassTop) / (L.roofTop - L.glassTop);
      const half = L.glassHalf + 0.15 - (L.glassHalf - 0.2) * t;
      if (ax > half || ay > half) return null;
      /** A shallow tilt rather than the roof's true slope, so its east and south faces shade apart. */
      const n: Vec3 = ax > ay ? [Math.sign(x), 0, 0.3] : [0, Math.sign(y), 0.3];
      return { part: "iron", normal: normalise(n), lit };
    }
    if (z <= L.ringTop) {
      const ring = Math.hypot(x, z - (L.roofTop + L.ringTop) / 2 - 0.1);
      if (Math.abs(y) > 0.35 || ring > 0.75 || ring < 0.3) return null;
      return { part: "iron", normal: normalise([x, 0, 1]), lit };
    }
    return null;

    /**
     * The glass is see-through: from where the ray meets a pane, keep walking it
     * through the lantern, and the pane glows where the flame is behind it.
     */
    function behindIsFlame(at: Vec3, s: number): boolean {
      if (!lit) return false;
      for (let t = 0; t < 2 * L.glassHalf * 1.5; t += 0.1) {
        const q: Vec3 = [at[0] - t * s, at[1] - t * s, at[2] - t * s];
        if (inFlame(q, L.flameFoot, flameHeight, L.flameWidth * 1.4, s)) return true;
      }
      return false;
    }
  };
}

const CANDLE = {
  dishRadius: 1.7,
  dishTop: 0.5,
  waxRadius: 0.75,
  waxTop: 2.6,
  wickTop: 3.2,
};

/** The candle's flame is not drawn: it is the lit tile's particles, so the sprite is the wick alone, glowing when lit. */
function candleSampler(lit: boolean) {
  const C = CANDLE;
  return (p: Vec3, scale: number): Hit | null => {
    const x = p[0] / scale - CENTRE;
    const y = p[1] / scale - CENTRE;
    const z = p[2] / scale;
    const r = Math.hypot(x, y);
    if (z < 0) return null;
    if (z <= C.dishTop) {
      if (r > C.dishRadius) return null;
      return { part: "brass", normal: z > C.dishTop - 0.2 ? UP : normalise([x, y, 0]), lit };
    }
    if (z <= C.waxTop) {
      if (r > C.waxRadius) return null;
      return { part: "wax", normal: z > C.waxTop - 0.25 ? UP : normalise([x, y, 0]), lit };
    }
    if (z <= C.wickTop && r < 0.25) return { part: "wick", normal: UP, lit };
    return null;
  };
}

function normalise(v: Vec3): Vec3 {
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** Lit from the south-west, as every other block here, so a top or a south face is the bright one. */
function band(normal: Vec3, ramp: readonly number[]): number {
  if (normal[2] > 0.9) return ramp[0]!;
  const across = (normal[0] - normal[1]) / Math.SQRT2 - normal[2] * 0.8;
  const i = Math.floor(((across + 1) / 2) * ramp.length);
  return ramp[Math.max(0, Math.min(ramp.length - 1, i))]!;
}

function shade(hit: Hit): number {
  switch (hit.part) {
    case "iron":
      return band(hit.normal, IRON);
    case "brass":
      return band(hit.normal, BRASS);
    case "wax":
      return band(hit.normal, WAX);
    case "wick":
      return hit.lit ? EMBER : WICK;
    case "core":
      return LANTERN_FLAME;
    case "glow":
      return band(hit.normal, GLOWING_GLASS);
    case "glass":
      return band(hit.normal, hit.lit ? LIT_GLASS : DARK_GLASS);
  }
}

/**
 * Where the frame's lit face meets its shaded one, the lit pixel along the
 * seam takes a brighter grey, a one-pixel glint that reads as metal.
 */
function glintIron(pixels: Int16Array, size: number): Int16Array {
  const out = pixels.slice();
  const at = (u: number, v: number) =>
    u >= 0 && v >= 0 && u < size && v < size ? pixels[v * size + u]! : -1;
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      if (at(u, v) !== IRON[0]) continue;
      const around = [at(u + 1, v), at(u - 1, v), at(u, v + 1), at(u, v - 1)];
      const seam = around.some((index) => index === IRON[1] || index === IRON[2]);
      if (seam) out[v * size + u] = IRON_GLINT;
    }
  }
  return out;
}

function outlineAround(pixels: Int16Array, size: number, index: number): Int16Array {
  const out = pixels.slice();
  const filled = (u: number, v: number) =>
    u >= 0 && v >= 0 && u < size && v < size && pixels[v * size + u]! >= 0;
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      if (filled(u, v)) continue;
      if (filled(u - 1, v) || filled(u + 1, v) || filled(u, v - 1) || filled(u, v + 1)) {
        out[v * size + u] = index;
      }
    }
  }
  return out;
}

type Sampler = (p: Vec3, scale: number) => Hit | null;

/**
 * One row per tile, one column per frame. A lantern is outlined all round
 * because its grey frame otherwise sinks into a stone or wooden floor; a
 * candle has the dark edge below that the hand-drawn props have.
 */
type Row = { name: string; frames: Sampler[]; outline: "around" | "below" };

const FLICKER = [1, 0.8];

const ROWS: Row[] = [
  { name: "lantern", frames: FLICKER.map((f) => lanternSampler(true, f)), outline: "around" },
  { name: "lantern-off", frames: [lanternSampler(false, 1)], outline: "around" },
  { name: "candle", frames: [candleSampler(true)], outline: "below" },
  { name: "candle-off", frames: [candleSampler(false)], outline: "below" },
];

/** One frame of a tile: which cast column it shows, for how long, and how bright its light is. */
type Beat = { column: number; durationMs: number; intensity?: number };

function sprite(beats: readonly Beat[], light?: { radius: number; color: string }) {
  return {
    frames: beats.map(({ column, durationMs, intensity }) => ({
      sprite: {
        rect: { x: column * SPRITE_CELLS, y: 0, w: SPRITE_CELLS, h: SPRITE_CELLS },
        base: { x: SPRITE_CELLS - 1, y: SPRITE_CELLS - 1 },
      },
      durationMs,
      ...(light && intensity !== undefined ? { light: { ...light, intensity } } : {}),
    })),
  };
}

const STILL: Beat[] = [{ column: 0, durationMs: 200, intensity: 0.9 }];

/**
 * The lit lantern breathes rather than blinks: four uneven beats, the tall
 * flame on the bright ones and the short one on the dim. Every distinct frame
 * is one more cached light bake for each chunk a lantern reaches, so the cycle
 * stays at four, and the radius stays put because a radius that changed would
 * change which chunks it reaches.
 */
const LANTERN_BEATS: Beat[] = [
  { column: 0, durationMs: 380, intensity: 0.95 },
  { column: 1, durationMs: 260, intensity: 0.82 },
  { column: 0, durationMs: 320, intensity: 0.9 },
  { column: 1, durationMs: 240, intensity: 0.76 },
];

const LANTERN_LIGHT = { radius: 6, color: "#ffcc88" };
const CANDLE_LIGHT = { radius: 3, color: "#ffc27a" };

/**
 * The candle's flame. Elevations are in height units, two pixels each, from
 * the candle's foot: each mote starts just over the wick, 2 up, and rises about
 * half a unit before it fades, shrinking and reddening as it goes. A rise is
 * drawn up and to the left, so that is a flame of one or two pixels on screen.
 */
const CANDLE_FLAME = {
  ratePerSecond: 22,
  ttlFromMs: 350,
  ttlToMs: 550,
  spawnRadiusCells: 0.02,
  spawnElevFrom: 2,
  spawnElevTo: 2.1,
  riseFrom: 0.8,
  riseTo: 1.2,
  driftCellsPerSecond: 0,
  gravity: 0,
  offsetX: "0.04 * sin(AGE_SEC * 18 + SEED * 2 * PI)",
  offsetY: "",
  offsetElev: "",
  lit: false,
  ownDepth: false,
  shape: null,
  sizeFromPx: 1,
  sizeToPx: null,
  radiusFromPx: 0.7,
  radiusToPx: 0.5,
  alphaFrom: 1,
  alphaTo: 0.3,
  ramp: [
    { at: 0, color: "#fbb954" },
    { at: 0.45, color: "#f79617" },
    { at: 0.8, color: "#fb6b1d" },
    { at: 1, color: "#ae2334" },
  ],
};

/**
 * A lantern is short enough to lift two units with the placement's foot and
 * still end inside its level, which is how one hangs on a wall. Neither tile
 * is walkable, so nobody stands on top of a lantern or on the gap under it.
 */
function tiles(): TileDef[] {
  const prop = (
    id: string,
    name: string,
    height: number,
    row: number,
    frames: ReturnType<typeof sprite>,
    switchTo: string,
    actionName: string,
  ) =>
    ({
      id,
      name,
      height,
      type: "simple",
      kind: "prop",
      attributes: {},
      anchor: { tilesetId: TILESET_ID, x: 0, y: row * SPRITE_CELLS },
      lightPassing: true,
      walkable: false,
      interactions: { switch: { targetTileId: switchTo, actionName } },
      sprite: frames,
    }) as TileDef;
  return [
    prop(
      "lantern",
      "Lantern",
      2,
      0,
      sprite(LANTERN_BEATS, LANTERN_LIGHT),
      "lantern-off",
      "Put out",
    ),
    prop("lantern-off", "Unlit Lantern", 2, 1, sprite(STILL), "lantern", "Light"),
    {
      ...prop("candle", "Candle", 1, 2, sprite(STILL, CANDLE_LIGHT), "candle-off", "Snuff"),
      particles: CANDLE_FLAME,
    },
    prop("candle-off", "Unlit Candle", 1, 3, sprite(STILL), "candle", "Light"),
  ];
}

async function main() {
  const columns = Math.max(...ROWS.map((r) => r.frames.length));
  const sheet = new PNG({ width: columns * SPRITE_PX, height: ROWS.length * SPRITE_PX });
  sheet.data.fill(0);
  for (const [row, { name, frames, outline }] of ROWS.entries()) {
    for (const [column, sample] of frames.entries()) {
      const model = { sample, shade };
      const cast = castModel(model, PROJECTION);
      const pixels =
        outline === "around"
          ? outlineAround(glintIron(cast, SPRITE_PX), SPRITE_PX, OUTLINE)
          : outlineBelow(cast, SPRITE_PX, OUTLINE);
      for (let i = 0; i < pixels.length; i++) {
        const x = column * SPRITE_PX + (i % SPRITE_PX);
        const y = row * SPRITE_PX + Math.floor(i / SPRITE_PX);
        if (pixels[i]! >= 0) paint(sheet, x, y, pixels[i]!);
      }
      /** `PREVIEW=<dir>` also writes each frame cast four times larger, to judge its shape. */
      if (process.env.PREVIEW) {
        const file = path.join(process.env.PREVIEW, `${name}-${column}-4x.png`);
        await writeCast(file, castModel(model, PROJECTION, 4), SPRITE_PX * 4);
      }
    }
  }
  await writeTileset(TILESET_ID, "Lanterns", sheet, tiles());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
