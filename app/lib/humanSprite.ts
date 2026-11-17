import * as v from "valibot";
import {
  LAYERS,
  humanPart,
  idsOn,
  isCreaturePart,
  playerHeads,
  partOnSchema,
  type HumanPartId,
  type LayerId,
  type PartOn,
  type Recolouring,
  type WornLayer,
} from "./humanParts";
import { HANDS, HELD_PLACEMENT, carryOf } from "./heldPlacement";
import { CELL_SIZE, type Direction, type TileDef, type TilesetDef } from "./types";

export const SHEET_FACINGS: readonly Direction[] = ["s", "e", "w", "n"];
export const SHEET_POSES = ["stepA", "stand", "stepB"] as const;
export const FRAME_PX = 2 * CELL_SIZE;
export const SHEET_WIDTH_PX = SHEET_POSES.length * FRAME_PX;
export const SHEET_HEIGHT_PX = SHEET_FACINGS.length * FRAME_PX;

const RGBA_CHANNELS = 4;
const ALPHA_OFFSET = 3;

export type Rgba = { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> };

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
  parts: v.object({
    base: partOnSchema("base"),
    shoes: v.nullable(partOnSchema("shoes")),
    clothes: v.nullable(partOnSchema("clothes")),
    head: partOnSchema("head"),
    hat: v.nullable(partOnSchema("hat")),
    weaponHand: v.optional(v.nullable(partOnSchema("weaponHand")), null),
    offHand: v.optional(v.nullable(partOnSchema("offHand")), null),
  }),
  skin: v.picklist(SKIN_TONE_NAMES),
  hair: v.picklist(HAIR_COLOUR_NAMES),
});

export type HumanLook = v.InferOutput<typeof humanLookSchema>;

export const DEFAULT_LOOK: HumanLook = {
  parts: {
    base: "body",
    shoes: "dark-boots",
    clothes: "white-tunic",
    head: "short-hair",
    hat: null,
    weaponHand: null,
    offHand: null,
  },
  skin: "default",
  hair: "red",
};

/** What a human is born with: chosen once, on a tile or a character. */
export type HumanAppearance = { skin: SkinTone; hair: HairColour; head: PartOn<"head"> };

/** One part per worn layer; a layer left out is bare. */
export type Outfit = { [L in WornLayer]?: PartOn<L> };

const WORN_LAYERS = [
  "hat",
  "clothes",
  "shoes",
  "weaponHand",
  "offHand",
] as const satisfies readonly WornLayer[];

export const BARE: Outfit = {};

export function isBare(outfit: Outfit): boolean {
  return WORN_LAYERS.every((layer) => outfit[layer] === undefined);
}

/** Names an outfit by its parts, in a fixed order, so two equal outfits share a key. */
export function outfitKey(outfit: Outfit): string {
  return WORN_LAYERS.map((layer) => outfit[layer] ?? "").join("+");
}

/**
 * Keeps each layer whose part is drawn on that layer and drops the rest, so a
 * part renamed since the sender last loaded costs that one layer, not the
 * whole outfit.
 */
export function readOutfit(raw: Partial<Record<WornLayer, string>>): Outfit {
  const outfit: Outfit = {};
  const hat = v.safeParse(partOnSchema("hat"), raw.hat);
  if (hat.success) outfit.hat = hat.output;
  const clothes = v.safeParse(partOnSchema("clothes"), raw.clothes);
  if (clothes.success) outfit.clothes = clothes.output;
  const shoes = v.safeParse(partOnSchema("shoes"), raw.shoes);
  if (shoes.success) outfit.shoes = shoes.output;
  const weaponHand = v.safeParse(partOnSchema("weaponHand"), raw.weaponHand);
  if (weaponHand.success) outfit.weaponHand = weaponHand.output;
  const offHand = v.safeParse(partOnSchema("offHand"), raw.offHand);
  if (offHand.success) outfit.offHand = offHand.output;
  return isBare(outfit) ? BARE : outfit;
}

/**
 * A human's look: each worn layer is what they have equipped there, or the
 * outfit they fall back on when that slot is empty.
 */
export function resolveHumanLook(
  appearance: HumanAppearance,
  fallback: Outfit = {},
  worn: Outfit = {},
): HumanLook {
  return {
    parts: {
      base: "body",
      shoes: worn.shoes ?? fallback.shoes ?? null,
      clothes: worn.clothes ?? fallback.clothes ?? null,
      head: appearance.head,
      hat: worn.hat ?? fallback.hat ?? null,
      weaponHand: worn.weaponHand ?? fallback.weaponHand ?? null,
      offHand: worn.offHand ?? fallback.offHand ?? null,
    },
    skin: appearance.skin,
    hair: appearance.hair,
  };
}

/** What a player may choose: a creature's head is refused. */
export const humanAppearanceSchema = v.object({
  skin: v.picklist(SKIN_TONE_NAMES),
  hair: v.picklist(HAIR_COLOUR_NAMES),
  head: v.picklist(playerHeads()),
});

/** An appearance that loads, or null for anything else: a stored or sent look is never trusted. */
export function readAppearance(raw: unknown): HumanAppearance | null {
  const parsed = v.safeParse(humanAppearanceSchema, raw);
  return parsed.success ? parsed.output : null;
}

export function appearanceKey({ skin, hair, head }: HumanAppearance): string {
  return `${skin}.${hair}.${head}`;
}

export const tileHumanSchema = v.object({
  ...humanAppearanceSchema.entries,
  head: partOnSchema("head"),
  base: v.optional(partOnSchema("base")),
  outfit: v.optional(
    v.object({
      shoes: v.optional(partOnSchema("shoes")),
      clothes: v.optional(partOnSchema("clothes")),
      hat: v.optional(partOnSchema("hat")),
      weaponHand: v.optional(partOnSchema("weaponHand")),
      offHand: v.optional(partOnSchema("offHand")),
    }),
  ),
});

/** A tile's human: who it is, and what it wears when nothing is equipped. */
export type TileHuman = v.InferOutput<typeof tileHumanSchema>;

const HUMAN_SHEET_PREFIX = "human:";

/** Names a composed sheet by everything that draws it, so identical looks share one. */
export function humanSheetId(look: HumanLook): string {
  const parts = LAYERS.map((layer) => look.parts[layer.id] ?? "-");
  return `${HUMAN_SHEET_PREFIX}${look.skin}:${look.hair}:${parts.join(":")}`;
}

export function isHumanSheetId(tilesetId: string): boolean {
  return tilesetId.startsWith(HUMAN_SHEET_PREFIX);
}

export function humanSheetTileset(id: string): TilesetDef {
  return { id, name: id, file: "", width: SHEET_WIDTH_PX, height: SHEET_HEIGHT_PX };
}

/**
 * The look a tile is drawn in, or null when it is drawn from its anchor: it
 * has no `human`, the field does not parse, or its frames do not fit one
 * character block and so could not be cut from a composed sheet.
 */
export function tileHumanLook(def: TileDef): HumanLook | null {
  if (def.human === undefined || !wearsHumanSheet(def)) return null;
  const parsed = v.safeParse(tileHumanSchema, def.human);
  return parsed.success ? lookOfTileHuman(parsed.output) : null;
}

/** A tile's human with nothing equipped. */
export function lookOfTileHuman({ outfit, base, ...appearance }: TileHuman): HumanLook {
  const look = resolveHumanLook(appearance, outfit);
  return base ? { ...look, parts: { ...look.parts, base } } : look;
}

/** The tile field that draws a look; empty layers are left out rather than saved as null. */
export function tileHumanFromLook(look: HumanLook): TileHuman {
  const { shoes, clothes, hat, weaponHand, offHand } = look.parts;
  return {
    skin: look.skin,
    hair: look.hair,
    head: look.parts.head,
    ...(look.parts.base === DEFAULT_LOOK.parts.base ? {} : { base: look.parts.base }),
    outfit: {
      ...(shoes ? { shoes } : {}),
      ...(clothes ? { clothes } : {}),
      ...(hat ? { hat } : {}),
      ...(weaponHand ? { weaponHand } : {}),
      ...(offHand ? { offHand } : {}),
    },
  };
}

export type DressedHuman = { def: TileDef; sheetId: string; look: HumanLook };

/**
 * A copy of a human tile anchored at the origin of its composed sheet, for a
 * renderer to draw. The frames are already relative to one character block,
 * so only the anchor moves. Never save the copy: the catalogue keeps its own
 * anchor for whatever reads it without composing.
 */
export function dressHuman(def: TileDef): DressedHuman | null {
  const look = tileHumanLook(def);
  if (!look) return null;
  const sheetId = humanSheetId(look);
  return { def: { ...def, anchor: { tilesetId: sheetId, x: 0, y: 0 } }, sheetId, look };
}

/** Every 48×64 block of each layer's file, in the reading order `HUMAN_PARTS` counts in. */
export type LayerBlocks = Record<LayerId, Rgba[]>;

function hexKey(hex: string): number {
  return Number.parseInt(hex.slice(1), 16);
}

function pixelKey(data: Uint8ClampedArray, i: number): number {
  return (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
}

function swapsBetween(from: readonly string[], to: readonly string[]): Map<number, number> {
  return new Map(from.map((hex, i) => [hexKey(hex), hexKey(to[i]!)]));
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

/** Every 48×64 block of a part file, blank ones included, in reading order. */
export function splitBlocks(image: Rgba): Rgba[] {
  const blocks: Rgba[] = [];
  for (let top = 0; top + SHEET_HEIGHT_PX <= image.height; top += SHEET_HEIGHT_PX) {
    for (let left = 0; left + SHEET_WIDTH_PX <= image.width; left += SHEET_WIDTH_PX) {
      blocks.push(cropBlock(image, left, top));
    }
  }
  return blocks;
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

/**
 * Lays what each hand holds over every frame in which it is `behind` the
 * figure, or every one in which it is in front. A held part is drawn once
 * per facing for each hand, in the column of its row that `HANDS` gives the
 * hand, and moved to the hand for each pose.
 */
function paintHeld(
  sheet: Uint8ClampedArray,
  blocks: LayerBlocks,
  look: HumanLook,
  behind: boolean,
) {
  HANDS.forEach((hand, column) => {
    const id = look.parts[hand];
    const block = id === null ? undefined : blocks[hand][humanPart(id).block];
    if (id === null || !block) return;
    const placements = HELD_PLACEMENT[carryOf(id)][hand];
    SHEET_FACINGS.forEach((facing, row) => {
      placements[facing].forEach((placement, pose) => {
        if (placement.behind !== behind) return;
        const [dx, dy] = placement.at;
        for (let y = 0; y < FRAME_PX; y++) {
          for (let x = 0; x < FRAME_PX; x++) {
            const tx = x + dx;
            const ty = y + dy;
            if (tx < 0 || ty < 0 || tx >= FRAME_PX || ty >= FRAME_PX) continue;
            const from =
              ((row * FRAME_PX + y) * SHEET_WIDTH_PX + column * FRAME_PX + x) * RGBA_CHANNELS;
            if (block.data[from + ALPHA_OFFSET] === 0) continue;
            const to =
              ((row * FRAME_PX + ty) * SHEET_WIDTH_PX + pose * FRAME_PX + tx) * RGBA_CHANNELS;
            sheet.set(block.data.subarray(from, from + RGBA_CHANNELS), to);
          }
        }
      });
    });
  });
}

export function composeSheet(blocks: LayerBlocks, look: HumanLook): Uint8ClampedArray<ArrayBuffer> {
  const sheet = new Uint8ClampedArray(SHEET_WIDTH_PX * SHEET_HEIGHT_PX * RGBA_CHANNELS);
  paintHeld(sheet, blocks, look, true);
  for (const layer of LAYERS) {
    if (layer.parts === "held") continue;
    const id: HumanPartId | null = look.parts[layer.id];
    if (id === null) continue;
    const block = blocks[layer.id][humanPart(id).block];
    if (!block) continue;
    paint(sheet, block, swapsFor(layer.recolour, look));
  }
  paintHeld(sheet, blocks, look, false);
  return sheet;
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)]!;
}

function maybe<T>(items: readonly T[], random: () => number): T | null {
  return pick<T | null>([...items, null], random);
}

export function randomLook(random: () => number = Math.random): HumanLook {
  return {
    parts: {
      base: pick(
        idsOn("base").filter((id) => !isCreaturePart(id)),
        random,
      ),
      shoes: maybe(idsOn("shoes"), random),
      clothes: maybe(idsOn("clothes"), random),
      head: pick(playerHeads(), random),
      hat: maybe(idsOn("hat"), random),
      weaponHand: null,
      offHand: null,
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
