import { PNG } from "pngjs";
import type { TileDef } from "../app/lib/types";
import { paint, writeTileset } from "./tileset-output";

const CELL = 8;

/**
 * The coin lies flat, so its face is drawn from above: a raised rim lit on its
 * south-west side, and a sunken middle whose north-east wall catches the light.
 * Its thickness shows as a crescent below and right of the face, bright to the
 * south and dark to the east. The bar stands 2 px tall: its top is moved 2 px
 * up and left of its footprint, and the south and east faces fill the gap.
 */
const SHAPES: Record<string, readonly string[]> = {
  gold: [
    "..DDD...",
    ".DMMMD..",
    "DLMMLMD.",
    "MLDMLMDE",
    "MWDDMLDE",
    ".MLLLDEC",
    "..MMDEC.",
    "...CCC..",
  ],
  "gold-bar": [
    "........",
    "........",
    "TWWTTT..",
    "TTTTTTE.",
    "SSSSSSEE",
    ".SSSSSSE",
    "..SSSSSS",
    "..KKKKKK",
  ],
};

const INK: Record<string, number> = {
  W: 28,
  L: 19,
  T: 19,
  M: 17,
  S: 17,
  C: 13,
  D: 13,
  E: 11,
  K: 11,
};

const TILES: Array<{ id: string; name: string; worth: number }> = [
  { id: "gold", name: "Gold", worth: 1 },
  { id: "gold-bar", name: "Gold Bar", worth: 100 },
];

const sheet = new PNG({ width: CELL * TILES.length, height: CELL });
/** pngjs leaves the buffer opaque black; the sheet needs a transparent backdrop. */
sheet.data.fill(0);

TILES.forEach(({ id }, column) => {
  SHAPES[id]!.forEach((row, y) => {
    [...row].forEach((key, x) => {
      if (key === ".") return;
      const index = INK[key];
      if (index === undefined) throw new Error(`no ink for '${key}'`);
      paint(sheet, column * CELL + x, y, index);
    });
  });
});

const tiles: TileDef[] = TILES.map(({ id, name, worth }, column) => ({
  id,
  name,
  height: 0,
  type: "simple",
  kind: "item",
  attributes: {},
  anchor: { tilesetId: "gold", x: column, y: 0 },
  sprite: {
    frames: [
      {
        sprite: { rect: { x: 0, y: 0, w: 1, h: 1 }, base: { x: 0, y: 0 } },
        durationMs: 200,
      },
    ],
  },
  lightPassing: true,
  interactions: { item: { type: "artifact", pile: 100, worth } },
}));

await writeTileset("gold", "Gold", sheet, tiles);
