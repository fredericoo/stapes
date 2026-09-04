import { describe, expect, it } from "vitest";
import { AnimationTable, ANIM_MAX_FRAMES, NO_ANIMATION, tableCanHold } from "./animTable";
import { CELL_SIZE, type Frame, type TilesetDef } from "../lib/types";

const SHEET: TilesetDef = {
  id: "sheet",
  name: "sheet",
  file: "sheet.png",
  width: 128,
  height: 64,
};

function frame(x: number, y: number, durationMs: number, w = 1, h = 1): Frame {
  return {
    sprite: {
      tilesetId: "sheet",
      rect: { x, y, w, h },
      base: { x: 0, y: 0 },
    },
    durationMs,
  };
}

/** The texel the shader would read for `col` of `row`. */
function texel(table: AnimationTable, row: number, col: number) {
  const data = table.bake().image.data as Float32Array;
  const o = (row * table.width + col) * 4;
  return { du: data[o]!, dv: data[o + 1]!, endMs: data[o + 2]! };
}

describe("AnimationTable", () => {
  it("measures every frame's atlas offset from frame 0", () => {
    const table = new AnimationTable();
    const row = table.add([frame(2, 1, 80), frame(3, 1, 80), frame(2, 3, 80)], SHEET);

    expect(row).toBe(0);
    expect(texel(table, 0, 0).du).toBeCloseTo(0);
    // `toBeCloseTo` rather than `toBe`: negating the zero row gives -0, which
    // is the same offset and a different value to `Object.is`.
    expect(texel(table, 0, 0).dv).toBeCloseTo(0);
    expect(texel(table, 0, 1).du).toBeCloseTo(CELL_SIZE / SHEET.width);
    // Down the sheet is *down* in v, because a rect's v is flipped when it
    // becomes a UV. Getting this sign wrong draws a frame from the wrong row.
    expect(texel(table, 0, 2).dv).toBeCloseTo((-2 * CELL_SIZE) / SHEET.height);
  });

  it("stores frame ends cumulatively, so the shader needs one comparison", () => {
    const table = new AnimationTable();
    table.add([frame(0, 0, 100), frame(1, 0, 50), frame(2, 0, 250)], SHEET);

    expect(texel(table, 0, 0).endMs).toBe(100);
    expect(texel(table, 0, 1).endMs).toBe(150);
    expect(texel(table, 0, 2).endMs).toBe(400);
  });

  it("pads a short row with its last frame, ending at the cycle length", () => {
    const table = new AnimationTable();
    table.add([frame(0, 0, 80), frame(1, 0, 80)], SHEET);
    const long = [frame(0, 1, 10), frame(1, 1, 10), frame(2, 1, 10), frame(3, 1, 10)];
    table.add(long, SHEET);

    expect(table.width).toBe(4);
    // The short row's padding repeats frame 1 and ends where the cycle does, so
    // a clock taken modulo the cycle always matches before reaching it.
    expect(texel(table, 0, 3).du).toBeCloseTo(texel(table, 0, 1).du);
    expect(texel(table, 0, 3).endMs).toBe(160);
  });

  it("gives one row to every placement of the same animation", () => {
    const table = new AnimationTable();
    const frames = [frame(0, 0, 80), frame(1, 0, 80)];

    expect(table.add(frames, SHEET)).toBe(0);
    expect(table.add(frames, SHEET)).toBe(0);
    expect(table.height).toBe(1);
  });

  it("refuses what it cannot draw, rather than drawing it wrong", () => {
    const table = new AnimationTable();
    // A frame of a different size would need the quad's geometry to change.
    expect(table.add([frame(0, 0, 80), frame(1, 0, 80, 2, 1)], SHEET)).toBe(NO_ANIMATION);
    // A frame from another sheet would need another texture, and a merged batch
    // is one texture.
    const elsewhere = frame(1, 0, 80);
    elsewhere.sprite.tilesetId = "other";
    expect(table.add([frame(0, 0, 80), elsewhere], SHEET)).toBe(NO_ANIMATION);
    // A still sprite is not an animation.
    expect(table.add([frame(0, 0, 80)], SHEET)).toBe(NO_ANIMATION);
    expect(table.empty).toBe(true);
  });

  it("refuses a cycle longer than the shader's loop can walk", () => {
    const tooLong = Array.from({ length: ANIM_MAX_FRAMES + 1 }, (_, i) =>
      frame(i % 16, 0, 10),
    );
    expect(tableCanHold(tooLong)).toBe(false);
    expect(new AnimationTable().add(tooLong, SHEET)).toBe(NO_ANIMATION);
  });

  describe("crossedFrame", () => {
    const table = new AnimationTable();
    table.add([frame(0, 0, 100), frame(1, 0, 100)], SHEET);

    it("is false between two readings inside one frame", () => {
      expect(table.crossedFrame(10, 90)).toBe(false);
    });

    it("is true across a boundary", () => {
      expect(table.crossedFrame(90, 110)).toBe(true);
    });

    it("is true across the loop", () => {
      expect(table.crossedFrame(190, 210)).toBe(true);
    });
  });
});
