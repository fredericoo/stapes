import * as v from "valibot";
import { CELL_SIZE, type Direction, type TileDef } from "./types";

export const SHEET_FACINGS: readonly Direction[] = ["s", "e", "w", "n"];
export const SHEET_POSES = ["stepA", "stand", "stepB"] as const;
export const FRAME_PX = 2 * CELL_SIZE;
export const SHEET_WIDTH_PX = SHEET_POSES.length * FRAME_PX;
export const SHEET_HEIGHT_PX = SHEET_FACINGS.length * FRAME_PX;

const RGBA_CHANNELS = 4;
const ALPHA_OFFSET = 3;

export type Rgba = { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> };

export type Recolouring = "skin" | "hair";

/**
 * The layers of a human, bottom to top. Each file holds any number of 48×64
 * variants, laid out in a grid and read left to right, top to bottom.
 */
export const LAYERS = [
  { id: "base", label: "Body", file: "human_base.png", optional: false, recolour: ["skin"] },
  { id: "shoes", label: "Shoes", file: "human_shoes.png", optional: true, recolour: [] },
  { id: "clothes", label: "Clothes", file: "human_clothes.png", optional: true, recolour: [] },
  {
    id: "head",
    label: "Head",
    file: "human_heads.png",
    optional: false,
    recolour: ["skin", "hair"],
  },
  { id: "hat", label: "Hat", file: "human_hats.png", optional: true, recolour: [] },
] as const satisfies readonly {
  id: string;
  label: string;
  file: string;
  optional: boolean;
  recolour: readonly Recolouring[];
}[];

export type LayerId = (typeof LAYERS)[number]["id"];

/** Shadow, base and highlight, in the shades the parts are drawn with under `default`. */
export const SKIN_TONES = {
  default: ["#6e2727", "#cd683d", "#fbb954"],
  brown: ["#6e2727", "#9e4539", "#cd683d"],
  pale: ["#cf657f", "#e6904e", "#fbb954"],
} as const satisfies Record<string, readonly [string, string, string]>;

/** Dark and light, in the shades the heads are drawn with under `red`. */
export const HAIR_COLOURS = {
  red: ["#ae2334", "#e83b3b"],
  ginger: ["#cd683d", "#fb6b1d"],
  blonde: ["#f79617", "#fbb954"],
  brown: ["#6e2727", "#9e4539"],
  "dark brown": ["#45293f", "#694f62"],
  black: ["#2e222f", "#3e3546"],
  grey: ["#7f708a", "#9babb2"],
  white: ["#c7dcd0", "#ffffff"],
  blue: ["#484a77", "#4d65b4"],
  green: ["#165a4c", "#239063"],
  purple: ["#694f62", "#a884f3"],
} as const satisfies Record<string, readonly [string, string]>;

export type SkinTone = keyof typeof SKIN_TONES;
export type HairColour = keyof typeof HAIR_COLOURS;

export const SKIN_TONE_NAMES = Object.keys(SKIN_TONES) as SkinTone[];
export const HAIR_COLOUR_NAMES = Object.keys(HAIR_COLOURS) as HairColour[];

export const humanLookSchema = v.object({
  variants: v.object({
    base: v.number(),
    shoes: v.nullable(v.number()),
    clothes: v.nullable(v.number()),
    head: v.number(),
    hat: v.nullable(v.number()),
  }),
  skin: v.picklist(SKIN_TONE_NAMES),
  hair: v.picklist(HAIR_COLOUR_NAMES),
});

export type HumanLook = v.InferOutput<typeof humanLookSchema>;

export const DEFAULT_LOOK: HumanLook = {
  variants: { base: 0, shoes: 0, clothes: 0, head: 0, hat: null },
  skin: "default",
  hair: "red",
};

export type PartVariants = Record<LayerId, Rgba[]>;

function hexKey(hex: string): number {
  return Number.parseInt(hex.slice(1), 16);
}

function pixelKey(data: Uint8ClampedArray, i: number): number {
  return (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
}

function swapsBetween(from: readonly string[], to: readonly string[]): Map<number, number> {
  return new Map(from.map((hex, i) => [hexKey(hex), hexKey(to[i]!)]));
}

function isBlank(block: Rgba): boolean {
  for (let i = ALPHA_OFFSET; i < block.data.length; i += RGBA_CHANNELS) {
    if (block.data[i] !== 0) return false;
  }
  return true;
}

function cropBlock(image: Rgba, left: number, top: number): Rgba {
  const data = new Uint8ClampedArray(SHEET_WIDTH_PX * SHEET_HEIGHT_PX * RGBA_CHANNELS);
  for (let y = 0; y < SHEET_HEIGHT_PX; y++) {
    const from = ((top + y) * image.width + left) * RGBA_CHANNELS;
    data.set(
      image.data.subarray(from, from + SHEET_WIDTH_PX * RGBA_CHANNELS),
      y * SHEET_WIDTH_PX * RGBA_CHANNELS,
    );
  }
  return { width: SHEET_WIDTH_PX, height: SHEET_HEIGHT_PX, data };
}

/** Every non-empty 48×64 block of a part file, in reading order. */
export function splitVariants(image: Rgba): Rgba[] {
  const variants: Rgba[] = [];
  for (let top = 0; top + SHEET_HEIGHT_PX <= image.height; top += SHEET_HEIGHT_PX) {
    for (let left = 0; left + SHEET_WIDTH_PX <= image.width; left += SHEET_WIDTH_PX) {
      const block = cropBlock(image, left, top);
      if (!isBlank(block)) variants.push(block);
    }
  }
  return variants;
}

function swapsFor(recolour: readonly Recolouring[], look: HumanLook): Map<number, number> {
  const swaps = new Map<number, number>();
  if (recolour.includes("skin")) {
    for (const [k, to] of swapsBetween(SKIN_TONES.default, SKIN_TONES[look.skin])) swaps.set(k, to);
  }
  if (recolour.includes("hair")) {
    for (const [k, to] of swapsBetween(HAIR_COLOURS.red, HAIR_COLOURS[look.hair])) swaps.set(k, to);
  }
  return swaps;
}

/**
 * Lays each opaque pixel of a layer over the sheet. A swap is looked up on the
 * layer's own colour, so a hair shade that matches a skin shade on another
 * layer is never recoloured twice.
 */
function paint(sheet: Uint8ClampedArray, layer: Rgba, swaps: Map<number, number>) {
  for (let i = 0; i < layer.data.length; i += RGBA_CHANNELS) {
    if (layer.data[i + ALPHA_OFFSET] === 0) continue;
    const to = swaps.get(pixelKey(layer.data, i));
    if (to === undefined) {
      sheet.set(layer.data.subarray(i, i + RGBA_CHANNELS), i);
      continue;
    }
    sheet[i] = (to >> 16) & 0xff;
    sheet[i + 1] = (to >> 8) & 0xff;
    sheet[i + 2] = to & 0xff;
    sheet[i + ALPHA_OFFSET] = 0xff;
  }
}

export function composeSheet(parts: PartVariants, look: HumanLook): Uint8ClampedArray<ArrayBuffer> {
  const sheet = new Uint8ClampedArray(SHEET_WIDTH_PX * SHEET_HEIGHT_PX * RGBA_CHANNELS);
  for (const layer of LAYERS) {
    const index = look.variants[layer.id];
    if (index === null) continue;
    const variant = parts[layer.id][index];
    if (!variant) continue;
    paint(sheet, variant, swapsFor(layer.recolour, look));
  }
  return sheet;
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)]!;
}

function randomVariant(count: number, optional: boolean, random: () => number): number | null {
  const choices: (number | null)[] = Array.from({ length: count }, (_, i) => i);
  if (optional) choices.push(null);
  return choices.length ? pick(choices, random) : null;
}

export function randomLook(parts: PartVariants, random: () => number = Math.random): HumanLook {
  const variant = (id: LayerId, optional: boolean) =>
    randomVariant(parts[id].length, optional, random);
  return {
    variants: {
      base: variant("base", false) ?? 0,
      shoes: variant("shoes", true),
      clothes: variant("clothes", true),
      head: variant("head", false) ?? 0,
      hat: variant("hat", true),
    },
    skin: pick(SKIN_TONE_NAMES, random),
    hair: pick(HAIR_COLOUR_NAMES, random),
  };
}

const SHEET_WIDTH_CELLS = SHEET_WIDTH_PX / CELL_SIZE;
const SHEET_HEIGHT_CELLS = SHEET_HEIGHT_PX / CELL_SIZE;

/**
 * Whether every frame a tile draws, standing or walking, sits inside one
 * 48×64 block from its anchor — the tiles that can wear a generated sheet by
 * moving their anchor and nothing else.
 */
export function wearsHumanSheet(tile: TileDef): boolean {
  const walk = tile.states?.moving?.sprites;
  if (!walk || !tile.sprites) return false;
  const frames = [tile.sprites, walk].flatMap((sprites) =>
    SHEET_FACINGS.flatMap((facing) => sprites[facing]?.frames ?? []),
  );
  return (
    frames.length > 0 &&
    frames.every(({ sprite: { rect } }) => {
      return (
        rect.x >= 0 &&
        rect.y >= 0 &&
        rect.x + rect.w <= SHEET_WIDTH_CELLS &&
        rect.y + rect.h <= SHEET_HEIGHT_CELLS
      );
    })
  );
}
