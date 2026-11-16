import { describe, expect, it } from "vitest";
import { HANDS, HELD_PLACEMENT } from "./heldPlacement";
import {
  DEFAULT_LOOK,
  FRAME_PX,
  HAIR_COLOURS,
  SHEET_FACINGS,
  SHEET_HEIGHT_PX,
  SHEET_WIDTH_PX,
  SKIN_TONES,
  composeSheet,
  randomLook,
  readAppearance,
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
  return {
    base: [block()],
    shoes: [],
    clothes: [],
    head: [block()],
    hat: [],
    weaponHand: [],
    offHand: [],
    ...overrides,
  };
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

  it("moves a held part to its hand in every pose, behind the figure or over it as that frame says", () => {
    const everywhere = Object.fromEntries(
      Array.from({ length: SHEET_WIDTH_PX * SHEET_HEIGHT_PX }, (_, at) => [at, "#111111"]),
    );
    const gripAt = FRAME_PX / 2;
    const held = block(
      Object.fromEntries(
        SHEET_FACINGS.map((_, row) => [
          (row * FRAME_PX + gripAt) * SHEET_WIDTH_PX + gripAt,
          "#222222",
        ]),
      ),
    );

    for (const hand of HANDS) {
      const sheet = composeSheet(
        partsWith({ base: [block(everywhere)], weaponHand: [held], offHand: [held] }),
        { ...DEFAULT_LOOK, parts: { ...DEFAULT_LOOK.parts, clothes: null, [hand]: "sword" } },
      );

      SHEET_FACINGS.forEach((facing, row) => {
        HELD_PLACEMENT[hand][facing].forEach(({ behind, at: [dx, dy] }, pose) => {
          const x = pose * FRAME_PX + gripAt + dx;
          const y = row * FRAME_PX + gripAt + dy;
          expect(pixelAt(sheet, y * SHEET_WIDTH_PX + x)).toEqual(
            rgb(behind ? "#111111" : "#222222"),
          );
        });
      });
    }
  });
});

describe("resolveHumanLook", () => {
  const appearance = { skin: "pale", hair: "black", head: "beard" } as const;

  it("wears what is equipped over the fallback outfit, and the fallback where a slot is empty", () => {
    const look = resolveHumanLook(
      appearance,
      { clothes: "brown-tunic", shoes: "dark-boots", offHand: "wooden-shield" },
      { clothes: "steel-mail", hat: "iron-helmet", weaponHand: "sword" },
    );

    expect(look).toEqual({
      parts: {
        base: "body",
        shoes: "dark-boots",
        clothes: "steel-mail",
        head: "beard",
        hat: "iron-helmet",
        weaponHand: "sword",
        offHand: "wooden-shield",
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

describe("creature parts", () => {
  it("refuses a creature's head for a player's character", () => {
    expect(readAppearance({ skin: "pale", hair: "black", head: "beard" })).not.toBeNull();
    expect(readAppearance({ skin: "pale", hair: "black", head: "skull" })).toBeNull();
  });

  it("never rolls a creature's body or head into a random look", () => {
    const rolls = Array.from({ length: 50 }, (_, i) => randomLook(() => (i % 50) / 50));

    expect(rolls.map((look) => look.parts.base)).not.toContain("bones");
    expect(rolls.map((look) => look.parts.head)).not.toContain("skull");
  });
});
