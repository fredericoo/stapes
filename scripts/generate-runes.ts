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
    lit: 7,
    dark: 0,
    /** Glass shows a sharp glint where stone would show a soft highlight. */
    marks: [
      {
        colour: 28,
        at: [
          [1, 0],
          [2, 0],
          [0, 1],
        ],
      },
      {
        colour: 25,
        at: [
          [3, 0],
          [0, 2],
        ],
      },
      { colour: 22, at: [[6, 6]] },
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

const ESSENCE_FRAMES = 8;
const ESSENCE_FRAME_MS = 140;
/**
 * The star's bright centre at rest. It floats a pixel above and below this,
 * and its longest arms come only at rest, so no arm leaves the cell.
 */
const STAR_X = 3;
const STAR_Y = 4;
/**
 * Every frame carries the same light. A light that changed with the frame
 * would make each chunk it reaches hold one lighting bake per frame.
 */
const ESSENCE_LIGHT = { radius: 2, intensity: 0.8 };
/** Alpha is snapped to these, as the wisps' glow is, so the fade steps rather than blurs. */
const ALPHA_STEPS = [1, 0.7, 0.45, 0.25];
/** Each spark's place and how far its twinkle runs behind the star's, as a share of a cycle. */
const SPARKS: readonly { x: number; y: number; lag: number }[] = [
  { x: 6, y: 1, lag: 0.35 },
  { x: 1, y: 6, lag: 0.7 },
];

/**
 * Essence is a rare drop from a creature of its element, so it is drawn as a
 * glint of that creature's light rather than as something carved. The ramps
 * are the wisps' colours a step deeper, brightest first, so fire reads red
 * rather than orange and water and nature do not share a mint core.
 */
const ESSENCES: { id: string; name: string; ramp: readonly string[] }[] = [
  {
    id: "essence-fire",
    name: "Fire Essence",
    ramp: ["#ffffff", "#fb6b1d", "#e83b3b", "#ae2334", "#6e2727"],
  },
  {
    id: "essence-water",
    name: "Water Essence",
    ramp: ["#ffffff", "#53d5cf", "#4d9be6", "#225ac0", "#362281"],
  },
  {
    id: "essence-nature",
    name: "Nature Essence",
    ramp: ["#ffffff", "#91db69", "#1ebc73", "#239063", "#165a4c"],
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

const ROWS = RUNES.length + 1;
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

const essences = new PNG({ width: ESSENCE_FRAMES * CELL, height: ESSENCES.length * CELL });

function glow(
  ramp: readonly string[],
  left: number,
  top: number,
  x: number,
  y: number,
  shade: number,
  alpha: number,
) {
  if (x < 0 || y < 0 || x >= CELL || y >= CELL) return;
  const i = (essences.width * (top + y) + left + x) << 2;
  if (essences.data[i + 3]! >= alpha * 255) return;
  const n = Number.parseInt(ramp[shade]!.slice(1), 16);
  essences.data[i] = (n >> 16) & 0xff;
  essences.data[i + 1] = (n >> 8) & 0xff;
  essences.data[i + 2] = n & 0xff;
  essences.data[i + 3] = Math.round(alpha * 255);
}

/**
 * One frame of an essence: a four-pointed star that floats up and down as
 * its arms grow and shrink, and two single-pixel sparks that flare out of
 * step with it.
 * Frame 0 is the star at its fullest, since that is the frame a still slot shows.
 */
function drawEssence(ramp: readonly string[], frame: number, row: number) {
  const left = frame * CELL;
  const top = row * CELL;
  const phase = (frame / ESSENCE_FRAMES) * Math.PI * 2;
  const reach = Math.cos(phase) > 0.8 ? 3 : Math.cos(phase) > -0.8 ? 2 : 1;
  const cx = STAR_X;
  const cy = STAR_Y - Math.round(Math.sin(phase));
  glow(ramp, left, top, cx, cy, 0, 1);
  for (let k = 1; k <= reach; k++) {
    const alpha = ALPHA_STEPS[k - 1]!;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      glow(ramp, left, top, cx + dx * k, cy + dy * k, k, alpha);
    }
  }
  const diagonal = reach >= 2 ? ALPHA_STEPS[2]! : ALPHA_STEPS[3]!;
  for (const [dx, dy] of [
    [1, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
  ] as const) {
    glow(ramp, left, top, cx + dx, cy + dy, 3, diagonal);
  }
  for (const spark of SPARKS) {
    const flare = Math.cos(phase - spark.lag * Math.PI * 2);
    if (flare < 0) continue;
    glow(ramp, left, top, spark.x, spark.y, 1, flare > 0.7 ? 1 : ALPHA_STEPS[1]!);
    if (flare <= 0.7) continue;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      glow(ramp, left, top, spark.x + dx, spark.y + dy, 3, ALPHA_STEPS[3]!);
    }
  }
}

const essenceTiles: TileDef[] = ESSENCES.map((essence, row) => {
  for (let frame = 0; frame < ESSENCE_FRAMES; frame++) drawEssence(essence.ramp, frame, row);
  return {
    ...newItem(essence.id, essence.name, 0, row),
    anchor: { tilesetId: "essences", x: 0, y: row },
    sprite: {
      frames: Array.from({ length: ESSENCE_FRAMES }, (_, frame) => ({
        sprite: { rect: { x: frame, y: 0, w: 1, h: 1 }, base: { x: 0, y: 0 } },
        durationMs: ESSENCE_FRAME_MS,
        light: { ...ESSENCE_LIGHT, color: essence.ramp[2]! },
      })),
    },
  } as TileDef;
});

await writeTileset("runes", "Runes", sheet, tiles);
await writeTileset("essences", "Essences", essences, essenceTiles, { translucent: true });
