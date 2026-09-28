import { describe, expect, it } from "vitest";
import {
  CLOAK_STYLES,
  DEFAULT_LOOK,
  FRAME_PX,
  HAIR_STYLES,
  SHEET_FACINGS,
  SHEET_HEIGHT_PX,
  SHEET_POSES,
  SHEET_WIDTH_PX,
  renderFigureFrame,
  renderFigureSheet,
  type FigureLook,
} from "./figure";
import { STAPES_PALETTE } from "./palette";
import { CELL_SIZE } from "./types";

function hexAt(rgba: Uint8ClampedArray, i: number): string {
  return `#${[rgba[i]!, rgba[i + 1]!, rgba[i + 2]!].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function sameArt(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  return a.every((value, i) => value === b[i]);
}

describe("renderFigureSheet", () => {
  const sheet = renderFigureSheet(DEFAULT_LOOK);

  it("fills a block the size of one character in people.png", () => {
    expect(sheet.length).toBe(SHEET_WIDTH_PX * SHEET_HEIGHT_PX * 4);
    expect([SHEET_WIDTH_PX, SHEET_HEIGHT_PX]).toEqual([48, 64]);
  });

  it("draws only palette colours", () => {
    const palette = new Set(STAPES_PALETTE);
    for (let i = 0; i < sheet.length; i += 4) {
      if (sheet[i + 3] === 0) continue;
      expect(sheet[i + 3]).toBe(255);
      expect(palette.has(hexAt(sheet, i))).toBe(true);
    }
  });
});

describe("renderFigureFrame", () => {
  it("stands on the bottom-right cell, which a base of (1, 1) puts on the map cell", () => {
    for (const facing of SHEET_FACINGS) {
      const frame = renderFigureFrame(DEFAULT_LOOK, facing, "stand");
      let lowest = -1;
      for (let y = 0; y < FRAME_PX; y++) {
        for (let x = 0; x < FRAME_PX; x++) if (frame[(y * FRAME_PX + x) * 4 + 3]) lowest = y;
      }
      expect(lowest).toBeGreaterThanOrEqual(CELL_SIZE);
      expect(lowest).toBeLessThan(FRAME_PX);
    }
  });

  it("draws every facing and every step of the walk differently", () => {
    const frames = SHEET_FACINGS.flatMap((facing) =>
      SHEET_POSES.map((pose) => ({
        key: `${facing}/${pose}`,
        art: renderFigureFrame(DEFAULT_LOOK, facing, pose),
      })),
    );
    for (let a = 0; a < frames.length; a++) {
      for (let b = a + 1; b < frames.length; b++) {
        expect(
          sameArt(frames[a]!.art, frames[b]!.art),
          `${frames[a]!.key} vs ${frames[b]!.key}`,
        ).toBe(false);
      }
    }
  });

  it("keeps the top of the head on a step, a whole pixel lower", () => {
    const top = (art: Uint8ClampedArray) => {
      for (let y = 0; y < FRAME_PX; y++) {
        let row = "";
        for (let x = 0; x < FRAME_PX; x++) row += art[(y * FRAME_PX + x) * 4 + 3] ? "x" : ".";
        if (row.includes("x")) return { y, row };
      }
      return null;
    };
    for (const facing of SHEET_FACINGS) {
      const standing = top(renderFigureFrame(DEFAULT_LOOK, facing, "stand"))!;
      for (const pose of ["stepA", "stepB"] as const) {
        const stepping = top(renderFigureFrame(DEFAULT_LOOK, facing, pose))!;
        expect(stepping, `${facing}/${pose}`).toEqual({
          y: standing.y + 1,
          row: `.${standing.row.slice(0, -1)}`,
        });
      }
    }
  });

  const bald: FigureLook = { ...DEFAULT_LOOK, hair: { ...DEFAULT_LOOK.hair, style: "bald" } };
  const bare: FigureLook = { ...DEFAULT_LOOK, cloak: { ...DEFAULT_LOOK.cloak, style: "none" } };
  const variants: { name: string; look: FigureLook; without: FigureLook }[] = [
    ...HAIR_STYLES.filter((s) => s !== "bald").map((style) => ({
      name: `${style} hair`,
      look: { ...bald, hair: { ...bald.hair, style } },
      without: bald,
    })),
    ...CLOAK_STYLES.filter((s) => s !== "none").map((style) => ({
      name: `a ${style}`,
      look: { ...bare, cloak: { ...bare.cloak, style } },
      without: bare,
    })),
    { name: "a beard", look: { ...DEFAULT_LOOK, beard: true }, without: DEFAULT_LOOK },
    {
      name: "a robe",
      look: { ...DEFAULT_LOOK, lower: { ...DEFAULT_LOOK.lower, style: "robe" } },
      without: DEFAULT_LOOK,
    },
  ];

  it.each(variants)("shows $name from at least one facing", ({ look, without }) => {
    const visible = SHEET_FACINGS.some(
      (facing) =>
        !sameArt(
          renderFigureFrame(look, facing, "stand"),
          renderFigureFrame(without, facing, "stand"),
        ),
    );
    expect(visible).toBe(true);
  });
});
