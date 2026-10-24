import { readFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { HUMAN_PARTS, LAYERS } from "./humanParts";
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
