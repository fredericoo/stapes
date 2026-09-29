import { describe, expect, it } from "vitest";
import { coordKey } from "../lib/types";
import { cutMaskFor } from "./cutMask";

const cells = (...at: Array<[number, number]>) => new Set(at.map(([x, y]) => coordKey(x, y)));

function grid(mask: NonNullable<ReturnType<typeof cutMaskFor>>): string[] {
  const rows: string[] = [];
  for (let row = 0; row < mask.h; row++) {
    let line = "";
    for (let col = 0; col < mask.w; col++) {
      line += mask.data[row * mask.w + col] === 255 ? "1" : "0";
    }
    rows.push(line);
  }
  return rows;
}

describe("cutMaskFor", () => {
  it("has nothing to say about a level with no cut", () => {
    expect(cutMaskFor(undefined)).toBeNull();
    expect(cutMaskFor(new Set())).toBeNull();
  });

  it("wraps one cell in a ring of zeros", () => {
    const mask = cutMaskFor(cells([4, 7]))!;

    expect({ x0: mask.x0, y0: mask.y0, w: mask.w, h: mask.h }).toEqual({
      x0: 3,
      y0: 6,
      w: 3,
      h: 3,
    });
    expect(grid(mask)).toEqual(["000", "010", "000"]);
  });

  it("puts x along the row and y down the column", () => {
    const mask = cutMaskFor(cells([0, 0], [1, 0]))!;

    expect(grid(mask)).toEqual(["0000", "0110", "0000"]);
  });

  it("indexes a cell by its offset from the origin", () => {
    const mask = cutMaskFor(cells([10, 10], [10, 11], [11, 11]))!;

    expect({ x0: mask.x0, y0: mask.y0 }).toEqual({ x0: 9, y0: 9 });
    expect(grid(mask)).toEqual(["0000", "0100", "0110", "0000"]);
  });

  it("holds negative coordinates, which half the map has", () => {
    const mask = cutMaskFor(cells([-3, -8]))!;

    expect({ x0: mask.x0, y0: mask.y0 }).toEqual({ x0: -4, y0: -9 });
    expect(grid(mask)).toEqual(["000", "010", "000"]);
  });

  it("covers a gap inside the bounding box without cutting it", () => {
    const mask = cutMaskFor(cells([0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2]))!;

    expect(grid(mask)).toEqual(["00000", "01110", "01010", "01110", "00000"]);
  });
});
