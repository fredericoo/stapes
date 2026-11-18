import { PNG } from "pngjs";
import type { Frame, TileDef } from "../app/lib/types";
import { writeTileset } from "./tileset-output";

const CELL = 8;
const SIZE = 2 * CELL;
const FRAMES = 8;
const FRAME_MS = 160;

/** The ground cell is the south-east one of the 2×2 sprite. */
const GROUND_X = 12;
const GROUND_Y = 12;

const HIGHLIGHT = "#d5e04b";
const BODY = "#91db69";

/**
 * A puff is a flattened ball of gas `elev` pixels off the ground. The cabinet
 * projection draws it `elev` up and `elev` left of where it stands, so the
 * higher puffs sit up-left of the low ones and the cloud leans the way every
 * other thing with height does.
 */
type Puff = { dx: number; dy: number; elev: number; rx: number; ry: number; phase: number };

const PUFFS: readonly Puff[] = [
  { dx: -1, dy: 0.5, elev: 0.5, rx: 3.6, ry: 2.8, phase: 0 },
  { dx: 1.5, dy: 1, elev: 0.5, rx: 2.4, ry: 2, phase: 0.25 },
  { dx: 0.5, dy: -1.5, elev: 1.5, rx: 3.4, ry: 2.6, phase: 0.5 },
  { dx: 0, dy: 0, elev: 3, rx: 3, ry: 2.4, phase: 0.7 },
  { dx: 0, dy: 0, elev: 5, rx: 2.2, ry: 1.8, phase: 0.85 },
];

const DRIFT = 0.6;
const SWELL = 0.1;

function covered(px: number, py: number, frame: number): boolean {
  if (px < 0 || py < 0 || px >= SIZE || py >= SIZE) return false;
  return PUFFS.some((puff) => {
    const angle = ((frame / FRAMES + puff.phase) % 1) * Math.PI * 2;
    const swell = 1 + SWELL * Math.sin(angle);
    const cx = GROUND_X + puff.dx + DRIFT * Math.cos(angle) - puff.elev;
    const cy = GROUND_Y + puff.dy + 0.5 * DRIFT * Math.sin(angle) - puff.elev;
    return Math.hypot((px - cx) / (puff.rx * swell), (py - cy) / (puff.ry * swell)) < 1;
  });
}

function hexRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * The renderer snaps every blended colour back to the palette, so a translucent
 * wash over grass comes out as one more green. The gas is a checker of opaque
 * pixels instead, which lets the ground show through at any colour. Its upper-left
 * rim is solid and catches the south-west light. The checker swaps every frame,
 * so it shimmers rather than sitting on the ground like a pattern.
 */
function paintFrame(sheet: PNG, frame: number) {
  const left = frame * SIZE;
  const at = (x: number, y: number) => covered(x + 0.5, y + 0.5, frame);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (!at(x, y)) continue;
      const lit = !at(x - 1, y) || !at(x, y - 1);
      if (!lit && (x + y + frame) % 2 === 1) continue;
      const [r, g, b] = hexRgb(lit ? HIGHLIGHT : BODY);
      const i = (sheet.width * y + left + x) << 2;
      sheet.data[i] = r;
      sheet.data[i + 1] = g;
      sheet.data[i + 2] = b;
      sheet.data[i + 3] = 255;
    }
  }
}

const frames: Frame[] = Array.from({ length: FRAMES }, (_, f) => ({
  sprite: { rect: { x: 2 * f, y: 0, w: 2, h: 2 }, base: { x: 1, y: 1 } },
  durationMs: FRAME_MS,
}));

const cloud = {
  id: "poison-cloud",
  name: "Poison Cloud",
  height: 1,
  type: "simple",
  kind: "prop",
  attributes: {},
  anchor: { tilesetId: "poison-cloud", x: 0, y: 0 },
  lightPassing: true,
  intangible: true,
  sprite: { frames },
} as TileDef;

const sheet = new PNG({ width: SIZE * FRAMES, height: SIZE });
sheet.data.fill(0);
for (let f = 0; f < FRAMES; f++) paintFrame(sheet, f);
await writeTileset("poison-cloud", "Poison Cloud", sheet, [cloud]);
