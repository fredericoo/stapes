import { PNG } from "pngjs";
import type { TileDef } from "../app/lib/types";
import { paint, writeTileset } from "./tileset-output";

const CELL = 8;
const COLUMNS = 8;

type Material = "bone" | "crystal" | "obsidian";
type Essence = "fire" | "water" | "nature" | "neutral";

/** `#` is the mark, on the 5×6 interior of a rune's face. */
type Glyph = readonly [string, string, string, string, string, string];

/**
 * A rune lies flat on the ground, so it is drawn from above and casts no
 * shadow. The world is lit from the south-west, which on a face lying flat
 * lights its north-west rim and darkens its south-east one.
 */
interface Base {
  mask: readonly string[];
  fill: number;
  lit: number;
  dark: number;
  /** Extra pixels painted after the rim, such as a glint or a fleck. */
  marks?: { colour: number; at: readonly [number, number][] }[];
}

const BASES: Record<Material, Base> = {
  bone: {
    mask: [
      "..#####.",
      ".#######",
      "########",
      "#######.",
      "########",
      "########",
      ".#######",
      "..####..",
    ],
    fill: 27,
    lit: 28,
    dark: 25,
  },
  crystal: {
    mask: [
      "..####..",
      ".######.",
      "########",
      "########",
      "########",
      "########",
      ".######.",
      "..####..",
    ],
    fill: 26,
    lit: 28,
    dark: 32,
    marks: [
      {
        colour: 28,
        at: [
          [2, 0],
          [1, 1],
        ],
      },
    ],
  },
  obsidian: {
    mask: [
      ".#######",
      "########",
      "########",
      "########",
      "########",
      "########",
      "########",
      "#######.",
    ],
    fill: 4,
    lit: 22,
    dark: 0,
    marks: [
      {
        colour: 25,
        at: [
          [6, 1],
          [6, 5],
          [2, 6],
        ],
      },
    ],
  },
};

type Shape = Pick<Base, "mask" | "marks">;

/**
 * Bone is broken off whatever it came from, so no two pieces are the same.
 * Each bone rune takes the next of these in turn; every one keeps the 5×6
 * interior whole for the mark.
 */
const BONE_SHAPES: Shape[] = [
  {
    mask: [
      "..#####.",
      ".#######",
      "########",
      "#######.",
      "########",
      "########",
      ".#######",
      "..####..",
    ],
    marks: [
      { colour: 25, at: [[6, 3]] },
      { colour: 22, at: [[7, 4]] },
    ],
  },
  {
    mask: [
      ".######.",
      "########",
      "#######.",
      "########",
      "########",
      "########",
      "#######.",
      ".####...",
    ],
  },
  {
    mask: [
      "..######",
      ".#######",
      "########",
      "########",
      "#######.",
      "########",
      ".######.",
      "...####.",
    ],
    marks: [{ colour: 25, at: [[6, 4]] }],
  },
  {
    mask: [
      ".#####..",
      "#######.",
      "########",
      "########",
      "########",
      "#######.",
      "########",
      ".######.",
    ],
  },
  {
    mask: [
      "...####.",
      ".#######",
      "########",
      "########",
      "########",
      "########",
      ".#######",
      ".#####..",
    ],
    marks: [
      {
        colour: 25,
        at: [
          [1, 0],
          [2, 1],
        ],
      },
    ],
  },
  {
    mask: [
      ".######.",
      "#######.",
      "########",
      ".#######",
      "########",
      "########",
      "########",
      "..#####.",
    ],
  },
  {
    mask: [
      "..####..",
      ".######.",
      "########",
      "########",
      "########",
      "#######.",
      ".######.",
      "..###...",
    ],
  },
];

/**
 * Crystal is translucent, so a crystal rune takes the colour of the essence
 * carved into it. One with no essence keeps the crystal's own lavender.
 */
const CRYSTAL_TINTS: Record<Exclude<Essence, "neutral">, Pick<Base, "fill" | "lit" | "dark">> = {
  fire: { fill: 10, lit: 12, dark: 3 },
  water: { fill: 24, lit: 30, dark: 31 },
  nature: { fill: 16, lit: 20, dark: 6 },
};

/**
 * Each element takes the shade of its colour that stands out most on the
 * material. No essence is carved as a bare groove: dark in bone and crystal,
 * bright in the dark obsidian.
 */
const MARK: Record<Material, Record<Essence, number>> = {
  bone: { fire: 9, water: 31, nature: 15, neutral: 4 },
  crystal: { fire: 28, water: 28, nature: 28, neutral: 0 },
  obsidian: { fire: 12, water: 30, nature: 20, neutral: 28 },
};

const GLYPHS = {
  caret: ["..#..", "..#..", ".#.#.", ".#.#.", "#...#", "#...#"],
  dots: ["..#..", "..#..", ".....", "#...#", "#...#", "....."],
  diamond: ["..#..", ".#.#.", "#...#", "#...#", ".#.#.", "..#.."],
  logs: ["..#..", ".#.#.", ".....", "#####", ".....", "#####"],
  star: ["#.#.#", ".###.", "..#..", "..#..", ".###.", "#.#.#"],
  teeth: ["#...#", "##.##", "#.#.#", "#...#", "#...#", "#...#"],
  slashes: ["...#.", "..#..", ".#..#", "#..#.", "..#..", ".#..."],
  cross: ["..#..", "..#..", "#####", "..#..", "..#..", "..#.."],
  saltire: ["#...#", ".#.#.", "..#..", "..#..", ".#.#.", "#...#"],
  zed: ["#####", "...#.", "..#..", "..#..", ".#...", "#####"],
  barbed: ["..#..", "#.#..", "..#.#", "#.#..", "..#.#", "..#.."],
  arrow: ["..#..", ".#.#.", "#.#.#", "..#..", "..#..", "..#.."],
  fence: [".#.#.", "#####", ".#.#.", ".#.#.", "#####", ".#.#."],
  sprout: ["#...#", ".#.#.", "..#..", "..#..", "..#..", ".###."],
  eye: [".###.", "#...#", "#.#.#", "#.#.#", "#...#", ".###."],
  trident: ["#.#.#", "#.#.#", ".###.", "..#..", "..#..", "..#.."],
  eight: [".###.", ".#.#.", ".###.", ".#.#.", ".#.#.", ".###."],
  beam: ["#####", "..#..", "..#..", "..#..", "..#..", ".###."],
  spark: [".....", "..#..", ".###.", "..#..", ".....", "....."],
  zigzag: ["...#.", "..#..", ".###.", "...#.", "..#..", ".#..."],
  spear: ["..#..", ".###.", "..#..", "..#..", "..#..", "..#.."],
  impact: ["..#..", "..#..", "..#..", "#####", "#...#", "#...#"],
} satisfies Record<string, Glyph>;

interface Rune {
  id: string;
  essence: Essence;
  material: Material;
  glyph: keyof typeof GLYPHS;
}

/**
 * One row per essence, crude to high. The tier follows the stone forge's
 * chain: a blank forges into a crude rune, two of a kind into the next.
 */
const RUNES: Rune[][] = [
  [
    { id: "flame", essence: "fire", material: "bone", glyph: "caret" },
    { id: "cinder", essence: "fire", material: "bone", glyph: "dots" },
    { id: "ember", essence: "fire", material: "crystal", glyph: "diamond" },
    { id: "pyre", essence: "fire", material: "crystal", glyph: "logs" },
    { id: "inferno", essence: "fire", material: "obsidian", glyph: "star" },
    { id: "berserk", essence: "fire", material: "obsidian", glyph: "teeth" },
  ],
  [
    { id: "sleet", essence: "water", material: "bone", glyph: "slashes" },
    { id: "frost", essence: "water", material: "crystal", glyph: "cross" },
    { id: "rime", essence: "water", material: "crystal", glyph: "saltire" },
    { id: "shatter", essence: "water", material: "obsidian", glyph: "zed" },
    { id: "crystallise", essence: "water", material: "obsidian", glyph: "diamond" },
  ],
  [
    { id: "barbs", essence: "nature", material: "bone", glyph: "barbed" },
    { id: "thorns", essence: "nature", material: "crystal", glyph: "arrow" },
    { id: "bramble", essence: "nature", material: "crystal", glyph: "fence" },
    { id: "verdance", essence: "nature", material: "crystal", glyph: "sprout" },
    { id: "bloom", essence: "nature", material: "crystal", glyph: "eye" },
    { id: "overgrowth", essence: "nature", material: "obsidian", glyph: "trident" },
    { id: "blossom", essence: "nature", material: "obsidian", glyph: "eight" },
  ],
  [
    { id: "light", essence: "neutral", material: "bone", glyph: "beam" },
    { id: "spark", essence: "neutral", material: "bone", glyph: "spark" },
    { id: "bolt", essence: "neutral", material: "crystal", glyph: "zigzag" },
    { id: "lance", essence: "neutral", material: "crystal", glyph: "spear" },
    { id: "stomp", essence: "neutral", material: "obsidian", glyph: "impact" },
  ],
];

const BLANKS: { id: string; name: string; material: Material }[] = [
  { id: "rune-blank-bone", name: "Bone Blank", material: "bone" },
  { id: "rune-blank-crystal", name: "Crystal Blank", material: "crystal" },
  { id: "rune-blank-obsidian", name: "Obsidian Blank", material: "obsidian" },
];

/** Rows of palette indices; `.` is empty. Essences are lumps of a creature, so they are drawn, not built from a base. */
const ESSENCES: {
  id: string;
  name: string;
  pixels: readonly string[];
  key: Record<string, number>;
}[] = [
  {
    id: "essence-fire",
    name: "Fire Essence",
    pixels: [
      "...a....",
      "..ab....",
      "..abb...",
      ".abccb..",
      ".bcwcb..",
      ".bccbd..",
      "..bbdd..",
      "........",
    ],
    key: { a: 17, b: 12, c: 19, w: 28, d: 9 },
  },
  {
    id: "essence-water",
    name: "Water Essence",
    pixels: [
      "........",
      "...a....",
      "..aba...",
      ".abwba..",
      ".abbbd..",
      ".acbdd..",
      "..ddd...",
      "........",
    ],
    key: { a: 30, b: 24, w: 28, c: 29, d: 31 },
  },
  {
    id: "essence-nature",
    name: "Nature Essence",
    pixels: [
      "....ll..",
      "...lk...",
      "..aab...",
      ".abwbb..",
      ".abbbd..",
      ".abbdd..",
      "..ddd...",
      "........",
    ],
    key: { a: 20, b: 16, w: 29, d: 15, l: 21, k: 6 },
  },
];

/** The stone the current forge takes: an uncut field stone, so it does not pass for one of the three blanks. */
const FIELD_STONE = {
  pixels: [
    "........",
    "..aaa...",
    ".abbba..",
    ".bbbbbc.",
    ".bbbbcc.",
    "..bccc..",
    "........",
    "........",
  ],
  key: { a: 27, b: 25, c: 22 },
};

const ROWS = RUNES.length + 2;
const sheet = new PNG({ width: COLUMNS * CELL, height: ROWS * CELL });

let bones = 0;

function drawRune(
  cx: number,
  cy: number,
  material: Material,
  essence: Essence,
  mark?: { glyph: Glyph; colour: number },
) {
  const base = {
    ...BASES[material],
    ...(material === "crystal" && essence !== "neutral" ? CRYSTAL_TINTS[essence] : {}),
    ...(material === "bone" ? BONE_SHAPES[bones++ % BONE_SHAPES.length] : {}),
  };
  const x0 = cx * CELL;
  const y0 = cy * CELL;
  const on = (x: number, y: number) => base.mask[y]?.[x] === "#";
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      if (!on(x, y)) continue;
      const facing =
        Number(!on(x - 1, y)) +
        Number(!on(x, y - 1)) -
        Number(!on(x + 1, y)) -
        Number(!on(x, y + 1));
      paint(sheet, x0 + x, y0 + y, facing > 0 ? base.lit : facing < 0 ? base.dark : base.fill);
    }
  }
  for (const { colour, at } of base.marks ?? [])
    for (const [x, y] of at) paint(sheet, x0 + x, y0 + y, colour);
  if (!mark) return;
  mark.glyph.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (c === "#") paint(sheet, x0 + 1 + x, y0 + 1 + y, mark.colour);
    }),
  );
}

function drawPixels(
  cx: number,
  cy: number,
  pixels: readonly string[],
  key: Record<string, number>,
) {
  pixels.forEach((row, y) =>
    [...row].forEach((c, x) => {
      const colour = key[c];
      if (colour !== undefined) paint(sheet, cx * CELL + x, cy * CELL + y, colour);
    }),
  );
}

function cellSprite(cx: number, cy: number): Pick<TileDef, "type" | "anchor" | "sprite"> {
  return {
    type: "simple",
    anchor: { tilesetId: "runes", x: cx, y: cy },
    sprite: {
      frames: [
        { sprite: { rect: { x: 0, y: 0, w: 1, h: 1 }, base: { x: 0, y: 0 } }, durationMs: 200 },
      ],
    },
  };
}

function newItem(id: string, name: string, cx: number, cy: number): TileDef {
  return {
    id,
    name,
    height: 0,
    kind: "item",
    attributes: {},
    lightPassing: true,
    intangible: true,
    affectedByGravity: true,
    interactions: { item: { type: "artifact", pile: 99 } },
    ...cellSprite(cx, cy),
  } as TileDef;
}

const tiles: TileDef[] = [];

RUNES.forEach((row, cy) =>
  row.forEach((rune, cx) => {
    drawRune(cx, cy, rune.material, rune.essence, {
      glyph: GLYPHS[rune.glyph],
      colour: MARK[rune.material][rune.essence],
    });
    tiles.push({ id: `arcane-stone-of-${rune.id}`, ...cellSprite(cx, cy) } as TileDef);
  }),
);

const blankRow = RUNES.length;
BLANKS.forEach((blank, cx) => {
  drawRune(cx, blankRow, blank.material, "neutral");
  tiles.push(newItem(blank.id, blank.name, cx, blankRow));
});
drawPixels(BLANKS.length, blankRow, FIELD_STONE.pixels, FIELD_STONE.key);
tiles.push({ id: "arcane-stone", ...cellSprite(BLANKS.length, blankRow) } as TileDef);

const essenceRow = RUNES.length + 1;
ESSENCES.forEach((essence, cx) => {
  drawPixels(cx, essenceRow, essence.pixels, essence.key);
  tiles.push(newItem(essence.id, essence.name, cx, essenceRow));
});

await writeTileset("runes", "Runes", sheet, tiles);
