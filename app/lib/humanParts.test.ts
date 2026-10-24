import { readFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { HUMAN_PARTS, LAYERS, wornPartOf } from "./humanParts";
import type { ArmorItem } from "./item";
import { splitBlocks } from "./humanSprite";

const TILESETS = path.resolve(import.meta.dirname, "../../data/tilesets");
const ALPHA_OFFSET = 3;
const RGBA_CHANNELS = 4;

function drawnBlocks(file: string): number[] {
  const png = PNG.sync.read(readFileSync(path.join(TILESETS, file)));
  const blocks = splitBlocks({
    width: png.width,
    height: png.height,
    data: new Uint8ClampedArray(png.data),
  });
  return blocks.flatMap((block, i) =>
    block.data.some((value, at) => at % RGBA_CHANNELS === ALPHA_OFFSET && value !== 0) ? [i] : [],
  );
}

describe("HUMAN_PARTS", () => {
  it("gives every part its own id", () => {
    const ids = HUMAN_PARTS.map((p) => p.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(LAYERS)("names exactly the drawn blocks of $file", ({ id, file }) => {
    const named = HUMAN_PARTS.filter((p) => p.layer === id)
      .map((p) => p.block)
      .sort((a, b) => a - b);

    expect(named).toEqual(drawnBlocks(file));
  });
});

describe("wornPartOf", () => {
  const armor = (fields: Partial<ArmorItem>): ArmorItem => ({ type: "armor", def: 1, ...fields });

  it("finds the part on the layer the slot dresses", () => {
    expect(wornPartOf(armor({ slot: "head", humanPart: "iron-helmet" }))).toEqual({
      layer: "hat",
      id: "iron-helmet",
    });
    expect(wornPartOf(armor({ humanPart: "steel-mail" }))).toEqual({
      layer: "clothes",
      id: "steel-mail",
    });
  });

  it("draws nothing for a part on another layer, an unknown part, or a charm", () => {
    expect(wornPartOf(armor({ slot: "footwear", humanPart: "iron-helmet" }))).toBeNull();
    expect(wornPartOf(armor({ slot: "head", humanPart: "crown" }))).toBeNull();
    expect(wornPartOf(armor({ slot: "charm", humanPart: "iron-helmet" }))).toBeNull();
  });
});
