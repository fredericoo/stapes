import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import {
  CLOAK_STYLES,
  DEFAULT_LOOK,
  HAIR_STYLES,
  PART_IDS,
  SHEET_FACINGS,
  SHEET_HEIGHT_PX,
  SHEET_POSES,
  SHEET_WIDTH_PX,
  renderFigureFrame,
  renderFigureSheet,
  type FigureLook,
} from "./figure";
import FIGURE_PARTS from "./figureParts.json";
import { STAPES_PALETTE } from "./palette";

function hexAt(rgba: Uint8Array | Uint8ClampedArray, i: number): string {
  return `#${[rgba[i]!, rgba[i + 1]!, rgba[i + 2]!].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function sameArt(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  return a.every((value, i) => value === b[i]);
}

/** The colours `people.png` draws its player in, as a look. */
const PLAYER: FigureLook = {
  skin: "#cd683d",
  hair: { style: "short", colour: "#2e222f" },
  beard: false,
  shirt: "#c7dcd0",
  trim: "#ae2334",
  lower: { style: "trousers", colour: "#7f708a" },
  shoes: "#2e222f",
  cloak: { style: "none", colour: "#2e222f" },
};

describe("figureParts.json", () => {
  it("holds every part as 64 rows of 48 cells", () => {
    const parts = FIGURE_PARTS as Record<string, string[]>;
    expect(Object.keys(parts).sort()).toEqual([...PART_IDS].sort());
    for (const id of PART_IDS) {
      expect(parts[id], id).toHaveLength(SHEET_HEIGHT_PX);
      for (const row of parts[id]!) expect(row, id).toMatch(/^[.#123]{48}$/);
    }
  });
});

describe("renderFigureSheet", () => {
  it("dressed as the player, draws the player in people.png pixel for pixel", () => {
    const people = PNG.sync.read(readFileSync("data/tilesets/people.png"));
    const sheet = renderFigureSheet(PLAYER);
    for (let y = 0; y < SHEET_HEIGHT_PX; y++) {
      for (let x = 0; x < SHEET_WIDTH_PX; x++) {
        const mine = (y * SHEET_WIDTH_PX + x) * 4;
        const theirs = (y * people.width + x) * 4;
        const want = people.data[theirs + 3] ? hexAt(people.data, theirs) : "none";
        const got = sheet[mine + 3] ? hexAt(sheet, mine) : "none";
        expect(got, `${x}, ${y}`).toBe(want);
      }
    }
  });

  it("draws only palette colours", () => {
    const palette = new Set(STAPES_PALETTE);
    const sheet = renderFigureSheet({
      ...DEFAULT_LOOK,
      hair: { style: "long", colour: "#fbb954" },
      beard: true,
      cloak: { style: "hooded", colour: "#165a4c" },
    });
    for (let i = 0; i < sheet.length; i += 4) {
      if (sheet[i + 3] === 0) continue;
      expect(palette.has(hexAt(sheet, i))).toBe(true);
    }
  });
});

describe("renderFigureFrame", () => {
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
