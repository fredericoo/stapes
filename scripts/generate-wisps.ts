import { PNG } from "pngjs";
import { nearestPaletteIndex, paletteOklab, srgbToOklab } from "../app/lib/palette";
import type { Frame, TileDef } from "../app/lib/types";
import { writeTileset } from "./tileset-output";

const CELL = 8;
const SIZE = 2 * CELL;
const FRAMES = 8;
const FRAME_MS = 150;
const SUPERSAMPLE = 8;

const GLOW_X = 8;
const GLOW_Y = 7;
const CORE_RADIUS = 1.3;
const GLOW_RADIUS = 4.6;
const PULSE = 0.12;
const BOB = 1.2;

/** Alpha is snapped to these, so the glow steps outward in rings rather than in a smooth gradient. */
const ALPHA_STEPS = [1, 0.7, 0.45, 0.25];
const ALPHA_FLOOR = 0.12;

type Wisp = {
  id: string;
  name: string;
  /** Brightest to darkest; all of them are `STAPES_PALETTE` entries. */
  ramp: readonly string[];
  glow: string;
};

const WISPS: readonly Wisp[] = [
  {
    id: "ember-wisp",
    name: "Ember Wisp",
    ramp: ["#ffffff", "#fbb954", "#f79617", "#fb6b1d", "#ae2334"],
    glow: "#fb6b1d",
  },
  {
    id: "tide-wisp",
    name: "Tide Wisp",
    ramp: ["#ffffff", "#affcdb", "#53d5cf", "#4d9be6", "#225ac0"],
    glow: "#4d9be6",
  },
  {
    id: "moss-wisp",
    name: "Moss Wisp",
    ramp: ["#ffffff", "#affcdb", "#91db69", "#1ebc73", "#239063"],
    glow: "#1ebc73",
  },
];

type Pose = { cx: number; cy: number; core: number; reach: number };

/** The pulse and the bob are a quarter-cycle apart, so the glow is widest halfway up its rise. */
function poseAt(frame: number): Pose {
  const phase = (frame / FRAMES) * Math.PI * 2;
  const swell = 1 + PULSE * Math.cos(phase);
  return {
    cx: GLOW_X,
    cy: GLOW_Y - BOB * Math.sin(phase),
    core: CORE_RADIUS * swell,
    reach: GLOW_RADIUS * swell,
  };
}

/** How far out from the core a point is, 0 inside the core and 1 at the edge of the glow. */
function falloff(px: number, py: number, pose: Pose): number {
  const d = Math.hypot(px - pose.cx, py - pose.cy);
  if (d <= pose.core) return 0;
  return Math.min(1, (d - pose.core) / (pose.reach - pose.core));
}

function snapAlpha(alpha: number): number {
  if (alpha < ALPHA_FLOOR) return 0;
  let best = ALPHA_STEPS[0]!;
  for (const step of ALPHA_STEPS) {
    if (Math.abs(step - alpha) < Math.abs(best - alpha)) best = step;
  }
  return best;
}

function hexRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

type Pixel = { colour: number; alpha: number };

/** The colour is an index into the wisp's ramp; an alpha of 0 is an empty pixel. */
function renderFrame(wisp: Wisp, frame: number): Pixel[] {
  const pose = poseAt(frame);
  const ramp = wisp.ramp.map(hexRgb);
  const rampLab = paletteOklab(wisp.ramp);
  const out: Pixel[] = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let t = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          t += falloff(x + (sx + 0.5) / SUPERSAMPLE, y + (sy + 0.5) / SUPERSAMPLE, pose);
        }
      }
      t /= SUPERSAMPLE * SUPERSAMPLE;
      const alpha = snapAlpha((1 - t) ** 2);
      if (alpha === 0) {
        out.push({ colour: 0, alpha: 0 });
        continue;
      }
      const at = Math.sqrt(t) * (ramp.length - 1);
      const lo = ramp[Math.floor(at)]!;
      const hi = ramp[Math.min(ramp.length - 1, Math.ceil(at))]!;
      const f = at - Math.floor(at);
      const mix = (c: number) => (lo[c]! + (hi[c]! - lo[c]!) * f) / 255;
      out.push({
        colour: nearestPaletteIndex(srgbToOklab(mix(0), mix(1), mix(2)), rampLab),
        alpha,
      });
    }
  }
  return out;
}

function paintFrame(sheet: PNG, wisp: Wisp, pixels: Pixel[], left: number, top: number) {
  pixels.forEach(({ colour, alpha }, n) => {
    if (alpha === 0) return;
    const [r, g, b] = hexRgb(wisp.ramp[colour]!);
    const i = (sheet.width * (top + Math.floor(n / SIZE)) + left + (n % SIZE)) << 2;
    sheet.data[i] = r;
    sheet.data[i + 1] = g;
    sheet.data[i + 2] = b;
    sheet.data[i + 3] = Math.round(alpha * 255);
  });
}

function wispTile(wisp: Wisp, row: number): TileDef {
  const light = { radius: 5, intensity: 1, color: wisp.glow };
  const frames: Frame[] = Array.from({ length: FRAMES }, (_, f) => ({
    sprite: { rect: { x: 2 * f, y: 0, w: 2, h: 2 }, base: { x: 1, y: 1 } },
    durationMs: FRAME_MS,
    light,
  }));
  return {
    id: wisp.id,
    name: wisp.name,
    height: 2,
    type: "simple",
    kind: "battler",
    attributes: {},
    anchor: { tilesetId: "wisps", x: 0, y: 2 * row },
    lightPassing: true,
    affectedByGravity: false,
    walkable: false,
    sprite: { frames },
  } as TileDef;
}

const sheet = new PNG({ width: SIZE * FRAMES, height: SIZE * WISPS.length });
sheet.data.fill(0);
WISPS.forEach((wisp, row) => {
  for (let f = 0; f < FRAMES; f++) {
    paintFrame(sheet, wisp, renderFrame(wisp, f), f * SIZE, row * SIZE);
  }
});
await writeTileset("wisps", "Wisps", sheet, WISPS.map(wispTile), { translucent: true });
