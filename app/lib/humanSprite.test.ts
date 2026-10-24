import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOOK,
  HAIR_COLOURS,
  SHEET_HEIGHT_PX,
  SHEET_WIDTH_PX,
  SKIN_TONES,
  composeSheet,
  resolveHumanLook,
  splitBlocks,
  type LayerBlocks,
  type Rgba,
} from "./humanSprite";

const SKIN_LIGHT = SKIN_TONES.default[2];
const HAIR_DARK = HAIR_COLOURS.red[0];

function rgb(hex: string): number[] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function block(
  pixels: Record<number, string> = {},
  widthPx = SHEET_WIDTH_PX,
  heightPx = SHEET_HEIGHT_PX,
): Rgba {
  const data = new Uint8ClampedArray(widthPx * heightPx * 4);
  for (const [at, hex] of Object.entries(pixels)) data.set([...rgb(hex), 255], Number(at) * 4);
  return { width: widthPx, height: heightPx, data };
}

function pixelAt(sheet: Uint8ClampedArray, at: number): number[] {
  return [...sheet.subarray(at * 4, at * 4 + 3)];
}

function partsWith(overrides: Partial<LayerBlocks>): LayerBlocks {
  return { base: [block()], shoes: [], clothes: [], head: [block()], hat: [], ...overrides };
}

describe("splitBlocks", () => {
  it("reads blocks left to right then down, keeping empty ones so later blocks keep their place", () => {
    const columns = 2;
    const rows = 2;
    const widthPx = SHEET_WIDTH_PX * columns;
    const atBlock = (column: number, row: number) =>
      row * SHEET_HEIGHT_PX * widthPx + column * SHEET_WIDTH_PX;
    const image = block(
      { [atBlock(1, 0)]: "#111111", [atBlock(1, 1)]: "#222222" },
      widthPx,
      SHEET_HEIGHT_PX * rows,
    );

    const blocks = splitBlocks(image);

    expect(blocks.map((b) => pixelAt(b.data, 0))).toEqual([
      [0, 0, 0],
      rgb("#111111"),
      [0, 0, 0],
      rgb("#222222"),
    ]);
  });
});

describe("composeSheet", () => {
  it("swaps skin shades on the body but leaves the same shade in clothes alone", () => {
    const parts = partsWith({
      base: [block({ 0: SKIN_LIGHT })],
      clothes: [block({ 1: SKIN_LIGHT })],
    });

    const sheet = composeSheet(parts, { ...DEFAULT_LOOK, skin: "brown" });

    expect(pixelAt(sheet, 0)).toEqual(rgb(SKIN_TONES.brown[2]));
    expect(pixelAt(sheet, 1)).toEqual(rgb(SKIN_LIGHT));
  });

  it("swaps hair shades on the head only", () => {
    const parts = partsWith({ base: [block({ 0: HAIR_DARK })], head: [block({ 1: HAIR_DARK })] });

    const sheet = composeSheet(parts, { ...DEFAULT_LOOK, hair: "blonde" });

    expect(pixelAt(sheet, 0)).toEqual(rgb(HAIR_DARK));
    expect(pixelAt(sheet, 1)).toEqual(rgb(HAIR_COLOURS.blonde[0]));
  });

  it("draws the block a part names", () => {
    const parts = partsWith({ head: [block({ 0: "#111111" }), block({ 0: "#222222" })] });

    const sheet = composeSheet(parts, {
      ...DEFAULT_LOOK,
      parts: { ...DEFAULT_LOOK.parts, head: "beard" },
    });

    expect(pixelAt(sheet, 0)).toEqual(rgb("#222222"));
  });

  it("draws later layers over earlier ones and skips a layer set to none", () => {
    const parts = partsWith({
      clothes: [block({ 0: "#111111" })],
      hat: [block({ 0: "#222222" })],
    });

    const hatless = composeSheet(parts, {
      ...DEFAULT_LOOK,
      parts: { ...DEFAULT_LOOK.parts, hat: null },
    });
    const hatted = composeSheet(parts, {
      ...DEFAULT_LOOK,
      parts: { ...DEFAULT_LOOK.parts, hat: "leather-cap" },
    });

    expect(pixelAt(hatless, 0)).toEqual(rgb("#111111"));
    expect(pixelAt(hatted, 0)).toEqual(rgb("#222222"));
  });
});

describe("resolveHumanLook", () => {
  const appearance = { skin: "pale", hair: "black", head: "beard" } as const;

  it("wears what is equipped over the fallback outfit, and the fallback where a slot is empty", () => {
    const look = resolveHumanLook(
      appearance,
      { clothes: "brown-tunic", shoes: "dark-boots" },
      { clothes: "steel-mail", hat: "iron-helmet" },
    );

    expect(look).toEqual({
      parts: {
        base: "body",
        shoes: "dark-boots",
        clothes: "steel-mail",
        head: "beard",
        hat: "iron-helmet",
      },
      skin: "pale",
      hair: "black",
    });
  });

  it("leaves a layer bare when neither the outfit nor the equipment covers it", () => {
    const look = resolveHumanLook(appearance);

    expect(look.parts).toMatchObject({ shoes: null, clothes: null, hat: null });
  });
});
