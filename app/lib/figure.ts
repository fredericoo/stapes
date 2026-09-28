import * as v from "valibot";
import {
  STAPES_PALETTE,
  hexToRgb01,
  nearestPaletteIndex,
  paletteOklab,
  srgbToOklab,
} from "./palette";
import { CELL_SIZE } from "./types";
import type { Direction, TileDef } from "./types";
import FIGURE_PARTS from "./figureParts.json";

export const HAIR_STYLES = ["bald", "short", "bob", "long", "ponytail"] as const;

export const CLOAK_STYLES = ["none", "cape", "cloak", "hooded"] as const;

export const LOWER_STYLES = ["trousers", "robe"] as const;

const colour = v.pipe(v.string(), v.regex(/^#[0-9a-f]{6}$/i));

export const figureLookSchema = v.object({
  skin: colour,
  hair: v.object({ style: v.picklist(HAIR_STYLES), colour }),
  beard: v.boolean(),
  shirt: colour,
  trim: colour,
  lower: v.object({ style: v.picklist(LOWER_STYLES), colour }),
  shoes: colour,
  cloak: v.object({ style: v.picklist(CLOAK_STYLES), colour }),
});

export type FigureLook = v.InferOutput<typeof figureLookSchema>;

export const DEFAULT_LOOK: FigureLook = {
  skin: "#e6904e",
  hair: { style: "short", colour: "#6e2727" },
  beard: false,
  shirt: "#c7dcd0",
  trim: "#ae2334",
  lower: { style: "trousers", colour: "#7f708a" },
  shoes: "#45293f",
  cloak: { style: "none", colour: "#165a4c" },
};

/** The first palette entry is the outline colour, and a part drawn in it would vanish into its outline. */
export const FIGURE_SWATCHES: readonly string[] = STAPES_PALETTE.slice(1);

const SKIN_TONES = ["#e6904e", "#cd683d", "#9e4539", "#fbb954", "#694f62"];

export function randomLook(random: () => number = Math.random): FigureLook {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  return {
    skin: pick(SKIN_TONES),
    hair: { style: pick(HAIR_STYLES), colour: pick(FIGURE_SWATCHES) },
    beard: random() < 0.25,
    shirt: pick(FIGURE_SWATCHES),
    trim: pick(FIGURE_SWATCHES),
    lower: { style: random() < 0.3 ? "robe" : "trousers", colour: pick(FIGURE_SWATCHES) },
    shoes: pick(FIGURE_SWATCHES),
    cloak: {
      style: random() < 0.5 ? "none" : pick(CLOAK_STYLES),
      colour: pick(FIGURE_SWATCHES),
    },
  };
}

export type WalkPose = "stepA" | "stand" | "stepB";

/** Rows and columns of one character block, in the order `people.png` draws them. */
export const SHEET_FACINGS: readonly Direction[] = ["s", "e", "w", "n"];
export const SHEET_POSES: readonly WalkPose[] = ["stepA", "stand", "stepB"];

export const FRAME_PX = 2 * CELL_SIZE;
export const SHEET_WIDTH_PX = SHEET_POSES.length * FRAME_PX;
export const SHEET_HEIGHT_PX = SHEET_FACINGS.length * FRAME_PX;

export const OUTLINE_COLOUR = "#2e222f";

/**
 * A part is 64 rows of 48 characters, in the layout of `SHEET_FACINGS` by
 * `SHEET_POSES`: `.` is empty, `#` is outline, and `1` to `3` are the shadow,
 * base and highlight of the ramp of whichever colour the look gives the part.
 */
export const PART_TONES = "123";
export const PART_OUTLINE = "#";
export const PART_EMPTY = ".";

type Paint = "skin" | "hair" | "shirt" | "trim" | "lower" | "shoes" | "cloak";

export const PART_IDS = [
  "body",
  "hair-short",
  "hair-bob",
  "hair-long",
  "hair-ponytail",
  "beard",
  "shirt",
  "trim",
  "trousers",
  "robe",
  "shoes",
  "cape",
  "cloak",
  "hood",
] as const;
export type PartId = (typeof PART_IDS)[number];

export type FigureParts = Record<PartId, readonly string[]>;

type Z = Record<Direction, number>;

const everywhere = (z: number): Z => ({ s: z, e: z, w: z, n: z });

/**
 * Parts are drawn in increasing `z` for the facing. A cape hangs behind the
 * body except from behind, where it covers the back, and hair and hoods sit on
 * top of the head from every side.
 */
const PARTS: Record<PartId, { paint: Paint; z: Z; outlined: boolean }> = {
  cape: { paint: "cloak", z: { s: 0, e: 0, w: 0, n: 90 }, outlined: true },
  cloak: { paint: "cloak", z: { s: 0, e: 0, w: 0, n: 90 }, outlined: true },
  body: { paint: "skin", z: everywhere(10), outlined: false },
  trousers: { paint: "lower", z: everywhere(20), outlined: false },
  shoes: { paint: "shoes", z: everywhere(25), outlined: false },
  robe: { paint: "lower", z: everywhere(27), outlined: true },
  shirt: { paint: "shirt", z: everywhere(30), outlined: false },
  trim: { paint: "trim", z: everywhere(35), outlined: false },
  "hair-short": { paint: "hair", z: everywhere(50), outlined: false },
  "hair-bob": { paint: "hair", z: everywhere(50), outlined: true },
  "hair-long": { paint: "hair", z: everywhere(50), outlined: true },
  "hair-ponytail": { paint: "hair", z: everywhere(50), outlined: true },
  beard: { paint: "hair", z: everywhere(55), outlined: true },
  hood: { paint: "cloak", z: everywhere(95), outlined: true },
};

function partsFor(look: FigureLook): PartId[] {
  const ids: PartId[] = ["body", "shirt", "trim", "shoes"];
  ids.push(look.lower.style === "robe" ? "robe" : "trousers");
  if (look.hair.style !== "bald") ids.push("hair-short");
  if (look.hair.style !== "bald" && look.hair.style !== "short")
    ids.push(`hair-${look.hair.style}`);
  if (look.beard) ids.push("beard");
  if (look.cloak.style === "cape") ids.push("cape");
  if (look.cloak.style === "cloak") ids.push("cloak");
  if (look.cloak.style === "hooded") ids.push("cloak", "hood");
  return ids;
}

function paintFor(look: FigureLook, paint: Paint): string {
  switch (paint) {
    case "skin":
      return look.skin;
    case "hair":
      return look.hair.colour;
    case "shirt":
      return look.shirt;
    case "trim":
      return look.trim;
    case "lower":
      return look.lower.colour;
    case "shoes":
      return look.shoes;
    case "cloak":
      return look.cloak.colour;
  }
}

type Ramp = [shadow: string, base: string, highlight: string];

const PALETTE_LAB = paletteOklab(STAPES_PALETTE);

function labOf(hex: string) {
  return srgbToOklab(...hexToRgb01(hex));
}

/**
 * The step to a darker or lighter palette entry: the nearest entry to the
 * base moved in lightness, excluding the base itself, with a chroma weight so
 * a shadow stays in the base's hue family rather than jumping to grey.
 */
function neighbour(hex: string, dL: number): string {
  const [L, a, b] = labOf(hex);
  const self = STAPES_PALETTE.indexOf(hex);
  let best = hex;
  let bestD = Infinity;
  for (let i = 0; i < STAPES_PALETTE.length; i++) {
    if (i === self || STAPES_PALETTE[i] === OUTLINE_COLOUR) continue;
    const pl = PALETTE_LAB[i * 3]!;
    const pa = PALETTE_LAB[i * 3 + 1]!;
    const pb = PALETTE_LAB[i * 3 + 2]!;
    if (Math.sign(pl - L) !== Math.sign(dL)) continue;
    const d = (pl - (L + dL)) ** 2 + 2.5 * ((pa - a) ** 2 + (pb - b) ** 2);
    if (d < bestD) {
      bestD = d;
      best = STAPES_PALETTE[i]!;
    }
  }
  return best;
}

function snapToPalette(hex: string): string {
  return STAPES_PALETTE[nearestPaletteIndex(labOf(hex), PALETTE_LAB)]!;
}

/**
 * Ramps `people.png` draws that the one-step rule does not reach: its skin
 * skips a palette entry either side of the base.
 */
const HAND_RAMPS: Record<string, Ramp> = {
  "#cd683d": ["#6e2727", "#cd683d", "#fbb954"],
};

export function rampFor(hex: string): Ramp {
  const base = snapToPalette(hex);
  return HAND_RAMPS[base] ?? [neighbour(base, -0.14), base, neighbour(base, 0.12)];
}

function writeHex(out: Uint8ClampedArray, i: number, hex: string) {
  const n = Number.parseInt(hex.slice(1), 16);
  out[i] = (n >> 16) & 0xff;
  out[i + 1] = (n >> 8) & 0xff;
  out[i + 2] = n & 0xff;
  out[i + 3] = 255;
}

/**
 * Lays the look's parts over each other in `z` order for each facing, turning
 * every tone into the matching step of its part's ramp. The parts taken
 * from `people.png` carry the outline its artist drew, which leaves some edges
 * open on purpose, such as the tip of a hand. A part drawn later, like a cape
 * or long hair, marks `outlined`, and a transparent pixel beside it becomes
 * outline so it gets an edge of its own.
 */
export function renderFigureSheet(
  look: FigureLook,
  parts: FigureParts = FIGURE_PARTS as FigureParts,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(SHEET_WIDTH_PX * SHEET_HEIGHT_PX * 4);
  const coloured = new Uint8Array(SHEET_WIDTH_PX * SHEET_HEIGHT_PX);
  const chosen = partsFor(look);
  const ramps = new Map(chosen.map((id) => [id, rampFor(paintFor(look, PARTS[id].paint))]));

  SHEET_FACINGS.forEach((facing, row) => {
    const order = [...chosen].sort((a, b) => PARTS[a].z[facing] - PARTS[b].z[facing]);
    for (const id of order) {
      const rows = parts[id];
      const ramp = ramps.get(id)!;
      for (let y = row * FRAME_PX; y < (row + 1) * FRAME_PX; y++) {
        for (let x = 0; x < SHEET_WIDTH_PX; x++) {
          const cell = rows[y]?.[x] ?? PART_EMPTY;
          if (cell === PART_EMPTY) continue;
          const tone = PART_TONES.indexOf(cell);
          const i = y * SHEET_WIDTH_PX + x;
          writeHex(out, i * 4, tone >= 0 ? ramp[tone]! : OUTLINE_COLOUR);
          coloured[i] = tone >= 0 && PARTS[id].outlined ? 1 : 0;
        }
      }
    }
  });

  outlineEdges(out, coloured);
  return out;
}

function outlineEdges(out: Uint8ClampedArray, coloured: Uint8Array) {
  for (let y = 0; y < SHEET_HEIGHT_PX; y++) {
    for (let x = 0; x < SHEET_WIDTH_PX; x++) {
      const i = y * SHEET_WIDTH_PX + x;
      if (out[i * 4 + 3] !== 0) continue;
      const inFrame = (nx: number, ny: number) =>
        Math.floor(nx / FRAME_PX) === Math.floor(x / FRAME_PX) &&
        Math.floor(ny / FRAME_PX) === Math.floor(y / FRAME_PX);
      const touches = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ].some(([nx, ny]) => inFrame(nx!, ny!) && coloured[ny! * SHEET_WIDTH_PX + nx!] === 1);
      if (touches) writeHex(out, i * 4, OUTLINE_COLOUR);
    }
  }
}

export function renderFigureFrame(
  look: FigureLook,
  facing: Direction,
  pose: WalkPose,
  parts: FigureParts = FIGURE_PARTS as FigureParts,
): Uint8ClampedArray<ArrayBuffer> {
  const sheet = renderFigureSheet(look, parts);
  const row = SHEET_FACINGS.indexOf(facing);
  const col = SHEET_POSES.indexOf(pose);
  const frame = new Uint8ClampedArray(FRAME_PX * FRAME_PX * 4);
  for (let y = 0; y < FRAME_PX; y++) {
    const src = ((row * FRAME_PX + y) * SHEET_WIDTH_PX + col * FRAME_PX) * 4;
    frame.set(sheet.subarray(src, src + FRAME_PX * 4), y * FRAME_PX * 4);
  }
  return frame;
}

/**
 * Whether a tile's walk is drawn from a block laid out like this sheet, so
 * moving its anchor onto the sheet draws a whole character and not pieces of
 * one. A deer or a wolf walks too, from a block of another shape.
 */
export function drawsFromCharacterBlock(tile: TileDef): boolean {
  const walk = tile.states?.moving?.sprites;
  if (!walk || !tile.sprites) return false;
  return [tile.sprites, walk].every((sprites) =>
    SHEET_FACINGS.every((facing) =>
      sprites[facing]?.frames.every(({ sprite: { rect, base } }) => {
        const inBlock =
          rect.x >= 0 &&
          rect.y >= 0 &&
          rect.x + rect.w <= SHEET_WIDTH_PX / CELL_SIZE &&
          rect.y + rect.h <= SHEET_HEIGHT_PX / CELL_SIZE;
        return (
          inBlock &&
          rect.w * CELL_SIZE === FRAME_PX &&
          rect.h * CELL_SIZE === FRAME_PX &&
          base.x === 1 &&
          base.y === 1
        );
      }),
    ),
  );
}
