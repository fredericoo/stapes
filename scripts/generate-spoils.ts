import { PNG } from "pngjs";
import type { TileDef } from "../app/lib/types";
import { paint, writeTileset } from "./tileset-output";

const CELL = 8;
const COLUMNS = 8;
const OUTLINE = 0;

/**
 * A spoil lies flat on the ground, so it is drawn from above. Each letter is a
 * palette index from `key`; a pixel with nothing under it gets the dark edge
 * the shipped food and hides have along their lower side.
 */
interface Spoil {
  id: string;
  name: string;
  pixels: readonly [string, string, string, string, string, string, string, string];
  key: Record<string, number>;
  /** Letters drawn floating above the ground, which cast no edge. */
  floating?: string;
}

const jelly = (dark: number, mid: number, light: number, glint: number) => ({
  pixels: [
    "........",
    "........",
    "...LL...",
    "..LgLM..",
    ".LMMMMd.",
    ".MMMMMd.",
    "..dddd..",
    "........",
  ] as const,
  key: { d: dark, M: mid, L: light, g: glint },
});

const dust = (dark: number, mid: number, light: number, spark: number) => ({
  pixels: [
    "........",
    "....h...",
    ".h....h.",
    "...mm...",
    "..mMMm.h",
    ".mMMMMm.",
    "..dddd..",
    "........",
  ] as const,
  key: { d: dark, M: mid, m: light, h: spark },
  floating: "h",
});

const SPOILS: Spoil[] = [
  {
    id: "rat-tail",
    name: "Rat Tail",
    pixels: [
      "........",
      ".....PP.",
      "....P..P",
      "....P...",
      ".....P..",
      "......P.",
      "..GG..P.",
      ".gGgPP..",
    ],
    key: { P: 14, G: 25, g: 22 },
  },
  {
    id: "bat-wing",
    name: "Bat Wing",
    pixels: [
      ".......b",
      "......bw",
      "....bbww",
      ".bbbwwbw",
      "bwwbwwbw",
      ".wwbww.w",
      "..w..w..",
      "........",
    ],
    key: { b: 25, w: 8 },
  },
  {
    id: "rabbit-foot",
    name: "Rabbit's Foot",
    pixels: [
      "........",
      "....WW..",
      "...WFWW.",
      "...WWWs.",
      "..WWWs..",
      ".WFWs...",
      ".pWs....",
      "..p.....",
    ],
    key: { W: 27, F: 28, s: 25, p: 14 },
  },
  {
    id: "snake-fang",
    name: "Snake Fang",
    pixels: [
      "........",
      ".FF.....",
      ".FWs....",
      "..FWs...",
      "...FWs..",
      "....Ws..",
      ".....s..",
      ".....G..",
    ],
    key: { F: 28, W: 27, s: 25, G: 16 },
  },
  {
    id: "imp-horn",
    name: "Imp Horn",
    pixels: [
      "........",
      "......t.",
      ".....Rt.",
      "....RRr.",
      "...RRr..",
      ".rRRr...",
      ".rRr....",
      "..r.....",
    ],
    key: { R: 11, r: 3, t: 13 },
  },
  {
    id: "bear-claw",
    name: "Bear Claw",
    pixels: [
      "........",
      ".ff.....",
      ".fCCc...",
      "..fCCc..",
      "....Cc..",
      "....Cc..",
      "...Tc...",
      "..T.....",
    ],
    key: { f: 11, C: 22, c: 4, T: 27 },
  },
  {
    id: "troll-tusk",
    name: "Troll Tusk",
    pixels: [
      ".....W..",
      "......W.",
      "......Ws",
      ".....WWs",
      "....WWs.",
      "...WWs..",
      ".TTWs...",
      ".TTs....",
    ],
    key: { W: 27, s: 18, T: 11 },
  },
  {
    id: "yeti-fur",
    name: "Yeti Fur",
    pixels: [
      "........",
      "..F.F...",
      ".FWFWF..",
      ".WFWFWF.",
      "FWWFWWs.",
      ".WWWWs..",
      "..sWs...",
      "........",
    ],
    key: { F: 28, W: 27, s: 25 },
  },
  {
    id: "cyclops-eye",
    name: "Cyclops Eye",
    pixels: [
      "........",
      "..sWWs..",
      ".WWWWWs.",
      ".WWbbWs.",
      ".WWbkWs.",
      ".sWWWss.",
      "..sss.p.",
      "......pp",
    ],
    key: { W: 28, s: 25, b: 24, k: 0, p: 14 },
  },
  {
    id: "nature-slime-jelly",
    name: "Slime Jelly",
    ...jelly(6, 16, 20, 29),
  },
  {
    id: "water-slime-jelly",
    name: "Water Slime Jelly",
    ...jelly(31, 23, 24, 29),
  },
  {
    id: "fire-slime-jelly",
    name: "Fire Slime Jelly",
    ...jelly(3, 9, 10, 19),
  },
  {
    id: "wisp-ash",
    name: "Wisp Ash",
    ...dust(11, 12, 17, 19),
  },
  {
    id: "wisp-dew",
    name: "Wisp Dew",
    ...dust(31, 24, 30, 28),
  },
  {
    id: "wisp-spore",
    name: "Wisp Spore",
    ...dust(6, 15, 20, 21),
  },
  {
    id: "boar-tusk",
    name: "Boar Tusk",
    pixels: [
      "........",
      "..W.....",
      ".WWs....",
      ".Ws.....",
      ".Ws.....",
      "..Ws..T.",
      "...WWsT.",
      "....ss..",
    ],
    key: { W: 27, s: 25, T: 11 },
  },
  {
    id: "raccoon-tail",
    name: "Raccoon Tail",
    pixels: [
      "........",
      "......gg",
      ".....kgk",
      "....gkg.",
      "...kgk..",
      "..gkg...",
      ".kgk....",
      ".gg.....",
    ],
    key: { g: 25, k: 1 },
  },
];

const sheet = new PNG({ width: COLUMNS * CELL, height: Math.ceil(SPOILS.length / COLUMNS) * CELL });

function draw(spoil: Spoil, cx: number, cy: number) {
  const letterAt = (x: number, y: number) => spoil.pixels[y]?.[x] ?? ".";
  const casts = (x: number, y: number) =>
    letterAt(x, y) in spoil.key && !spoil.floating?.includes(letterAt(x, y));
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const colour = spoil.key[letterAt(x, y)] ?? (casts(x, y - 1) ? OUTLINE : undefined);
      if (colour !== undefined) paint(sheet, cx * CELL + x, cy * CELL + y, colour);
    }
  }
}

const tiles: TileDef[] = SPOILS.map((spoil, i) => {
  const cx = i % COLUMNS;
  const cy = Math.floor(i / COLUMNS);
  draw(spoil, cx, cy);
  return {
    id: spoil.id,
    name: spoil.name,
    height: 0,
    type: "simple",
    kind: "item",
    attributes: {},
    anchor: { tilesetId: "spoils", x: cx, y: cy },
    lightPassing: true,
    intangible: true,
    affectedByGravity: true,
    interactions: { item: { type: "artifact", pile: 25 } },
    sprite: {
      frames: [
        { sprite: { rect: { x: 0, y: 0, w: 1, h: 1 }, base: { x: 0, y: 0 } }, durationMs: 200 },
      ],
    },
  } as TileDef;
});

await writeTileset("spoils", "Spoils", sheet, tiles);
