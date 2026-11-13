import path from "node:path";
import { PNG } from "pngjs";
import { scatterSeedMatching } from "../app/lib/scatter";
import { CELL_SIZE, type TileDef } from "../app/lib/types";
import type { Vec3 } from "./limb-caster";
import { castModel, outlineBelow, writeCast } from "./model-caster";
import { paint, writeTileset } from "./tileset-output";

const TILESET_ID = "mushrooms";

/**
 * Two cells square with the ground in the south-east one, as `crate-chest` and
 * `sack` are: anything with height leans up and to the left out of its own
 * cell, and an 8-pixel sprite would cut its top off.
 */
const SPRITE_CELLS = 2;
const SPRITE_PX = SPRITE_CELLS * CELL_SIZE;
const PROJECTION = { spritePx: SPRITE_PX, groundPx: SPRITE_PX - CELL_SIZE, topPx: SPRITE_PX - 1 };

/** Palette indices, light to dark. */
const GILLS = 22;
const STEM_RAMP = [27, 25, 22];
const SPOT = 28;
const CUT = 28;
const OUTLINE = 0;

/**
 * A mushroom, in pixels of its own cell with `z` up. A cap is the top half of
 * an ellipsoid with a flat underside, which `limb-caster` cannot make: every
 * shape it has is a capsule, and a capsule's round ends hang a ball down over
 * the stem. The projection draws height as a lean up and to the left, so a
 * stem much shorter than its cap is wide is hidden under the cap.
 */
type Mushroom = {
  at: [number, number];
  stem: number;
  capRadius: number;
  capHeight: number;
  spots: number;
};

/**
 * One scatter face per entry. Where a face has more than one mushroom they
 * stand along the line from south-west to north-east, because one to the
 * south-east of another is drawn over its stem.
 */
const FACES: Mushroom[][] = [
  [{ at: [4, 4.2], stem: 3.7, capRadius: 3, capHeight: 2, spots: 4 }],
  [
    { at: [3, 5.2], stem: 3.4, capRadius: 2.5, capHeight: 1.7, spots: 3 },
    { at: [6.4, 2.6], stem: 2.4, capRadius: 1.6, capHeight: 1.1, spots: 1 },
  ],
  [
    { at: [1.6, 6.6], stem: 2.4, capRadius: 1.6, capHeight: 1.2, spots: 2 },
    { at: [4.6, 3.9], stem: 3, capRadius: 1.8, capHeight: 1.3, spots: 2 },
    { at: [7.2, 1.2], stem: 1.9, capRadius: 1.3, capHeight: 1, spots: 1 },
  ],
];

/** Spots on a cap, as directions out from the cap's centre; a cap wears the first `spots` of them. */
const SPOTS: Vec3[] = [
  [-0.35, 0.25, 0.9],
  [0.45, -0.2, 0.87],
  [-0.15, -0.6, 0.78],
  [-0.75, 0.35, 0.55],
];
const SPOT_SIZE = 0.24;

type Hit = { part: "cap" | "gills" | "stem" | "cut"; normal: Vec3; spots: number };

function normalise(v: Vec3): Vec3 {
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** How much of a stem is left once its mushroom has been picked. */
const STUB_SHARE = 0.6;

/**
 * What a mushroom is made of at `p`, if anything, and which way its surface
 * faces there. A `picked` one is the stub of its stem, cut flat.
 */
function sampleOne(m: Mushroom, p: Vec3, scale: number, picked: boolean): Hit | null {
  const dx = p[0] - m.at[0] * scale;
  const dy = p[1] - m.at[1] * scale;
  if (picked) {
    const stubTop = m.stem * STUB_SHARE * scale;
    if (p[2] < 0 || p[2] > stubTop) return null;
    if (Math.hypot(dx, dy) > 0.37 * m.capRadius * scale) return null;
    if (p[2] > stubTop - 0.25 * scale) return { part: "cut", normal: [0, 0, 1], spots: 0 };
    return { part: "stem", normal: normalise([dx, dy, 0]), spots: 0 };
  }
  const r = m.capRadius * scale;
  const h = m.capHeight * scale;
  /** The flat underside of the cap sits a quarter of its height below the top of the stem. */
  const dz = p[2] - (m.stem - m.capHeight / 4) * scale;
  if (dz >= 0 && (dx / r) ** 2 + (dy / r) ** 2 + (dz / h) ** 2 <= 1) {
    if (dz < 0.3 * h) return { part: "gills", normal: [0, 0, -1], spots: 0 };
    const normal = normalise([dx / r ** 2, dy / r ** 2, dz / h ** 2]);
    return { part: "cap", normal, spots: m.spots };
  }

  const stemTop = m.stem * scale;
  if (p[2] >= 0 && p[2] <= stemTop) {
    const foot = 0.37 * m.capRadius;
    const top = 0.28 * m.capRadius;
    const radius = (foot + (top - foot) * (p[2] / stemTop)) * scale;
    if (Math.hypot(dx, dy) <= radius) {
      return { part: "stem", normal: normalise([dx, dy, 0]), spots: 0 };
    }
  }
  return null;
}

function sampler(face: readonly Mushroom[], picked: boolean) {
  return (p: Vec3, scale: number): Hit | null => {
    for (const m of face) {
      const hit = sampleOne(m, p, scale, picked);
      if (hit) return hit;
    }
    return null;
  };
}

/** Lit from the south-west, as every other block here, with the top of the cap the brightest part. */
function shade(hit: Hit, capRamp: readonly number[]): number {
  if (hit.part === "gills") return GILLS;
  if (hit.part === "cut") return CUT;
  if (hit.part === "cap") {
    const spotted = SPOTS.slice(0, hit.spots).some(
      (s) => Math.hypot(...normalise(s).map((c, i) => c - hit.normal[i]!)) < SPOT_SIZE,
    );
    if (spotted) return SPOT;
  }
  const ramp = hit.part === "cap" ? capRamp : STEM_RAMP;
  const across = (hit.normal[0] - hit.normal[1]) / Math.SQRT2 - hit.normal[2] * 0.8;
  const band = Math.floor(((across + 1) / 2) * ramp.length);
  return ramp[Math.max(0, Math.min(ramp.length - 1, band))]!;
}

type Item = NonNullable<TileDef["interactions"]>["item"];

/**
 * A kind is three tiles from one cap colour: the item a player carries, the
 * patch it is picked from, and the picked patch that grows back into it.
 */
type Kind = {
  itemId: string;
  name: string;
  patchName: string;
  capRamp: readonly number[];
  item: Item;
};

const KINDS: Kind[] = [
  {
    itemId: "mushroom",
    name: "Mushroom",
    patchName: "Mushrooms",
    capRamp: [10, 9, 3],
    item: {
      type: "consumable",
      label: "Eat",
      sound: "squish",
      hp: 0,
      /** A short meal: an apple gives 45 to 75 seconds. */
      statuses: [{ id: "fed", fromMs: 20000, toMs: 40000 }],
      pile: 32,
    },
  },
  {
    itemId: "blue-mushroom",
    name: "Blue Mushroom",
    patchName: "Blue mushrooms",
    capRamp: [24, 23, 32],
    /** Only the colour says it is poison: it feeds nobody and poisons whoever eats it, as the green potion does. */
    item: {
      type: "consumable",
      label: "Eat",
      sound: "squish",
      hp: 0,
      statuses: [{ id: "poison" }],
      pile: 32,
    },
  },
];

const patchId = (kind: Kind) => `${kind.itemId}-patch`;
const pickedId = (kind: Kind) => `picked-${kind.itemId}-patch`;

/** The sheet's last row is the stubs, shared by every kind's picked patch. */
const STUB_ROW = KINDS.length;

const GROW_BACK = { fromMs: 240000, toMs: 480000 };

function faceSprite(column: number) {
  return {
    frames: [
      {
        sprite: {
          rect: { x: column * SPRITE_CELLS, y: 0, w: SPRITE_CELLS, h: SPRITE_CELLS },
          base: { x: SPRITE_CELLS - 1, y: SPRITE_CELLS - 1 },
        },
        durationMs: 200,
      },
    ],
  };
}

function kindTiles(kind: Kind, row: number): TileDef[] {
  const anchor = { tilesetId: TILESET_ID, x: 0, y: row * SPRITE_CELLS };
  const item = {
    id: kind.itemId,
    name: kind.name,
    height: 0,
    type: "simple",
    kind: "item",
    attributes: {},
    lightPassing: true,
    affectedByGravity: true,
    interactions: { item: kind.item },
    anchor,
    sprite: faceSprite(0),
  };
  /**
   * A patch is flat and walkable, unlike a bush, so one grown in a cave
   * passage never closes it. Both patches have height 0, so swapping one for
   * the other changes nothing the light or the walk reads.
   */
  const patch = {
    id: patchId(kind),
    name: kind.patchName,
    height: 0,
    type: "scatter",
    kind: "prop",
    attributes: {},
    lightPassing: true,
    interactions: {
      extract: {
        actionName: "Pick",
        durability: 1,
        tileId: pickedId(kind),
        durationMs: 1500,
        slots: [
          { tileId: kind.itemId, chance: 100 },
          { tileId: kind.itemId, chance: 60 },
          { tileId: kind.itemId, chance: 30 },
        ],
        mastery: "agility",
      },
    },
    anchor,
    scatter: FACES.map((_, column) => faceSprite(column)),
  };
  /** The picked patch keeps the patch's face, so the stubs stand where the mushrooms did. */
  const picked = {
    id: pickedId(kind),
    name: kind.patchName,
    height: 0,
    type: "scatter",
    kind: "prop",
    attributes: {},
    lightPassing: true,
    scatterSeed: scatterSeedMatching(pickedId(kind), patchId(kind)),
    interactions: { decay: { tileId: patchId(kind), ...GROW_BACK } },
    anchor: { tilesetId: TILESET_ID, x: 0, y: STUB_ROW * SPRITE_CELLS },
    scatter: FACES.map((_, column) => faceSprite(column)),
  };
  return [item, patch, picked] as TileDef[];
}

async function paintFace(
  sheet: PNG,
  row: number,
  column: number,
  model: { sample: (p: Vec3, scale: number) => Hit | null; shade: (hit: Hit) => number },
  name: string,
) {
  const pixels = outlineBelow(castModel(model, PROJECTION), SPRITE_PX, OUTLINE);
  for (let i = 0; i < pixels.length; i++) {
    const x = column * SPRITE_PX + (i % SPRITE_PX);
    const y = row * SPRITE_PX + Math.floor(i / SPRITE_PX);
    if (pixels[i]! >= 0) paint(sheet, x, y, pixels[i]!);
  }
  /** `PREVIEW=<dir>` also writes each face cast four times larger, to look at its shape before it is pixels. */
  if (process.env.PREVIEW) {
    const file = path.join(process.env.PREVIEW, `${name}-${column}-4x.png`);
    await writeCast(file, castModel(model, PROJECTION, 4), SPRITE_PX * 4);
  }
}

async function main() {
  const sheet = new PNG({ width: FACES.length * SPRITE_PX, height: (STUB_ROW + 1) * SPRITE_PX });
  sheet.data.fill(0);
  for (const [column, face] of FACES.entries()) {
    for (const [row, kind] of KINDS.entries()) {
      const model = { sample: sampler(face, false), shade: (hit: Hit) => shade(hit, kind.capRamp) };
      await paintFace(sheet, row, column, model, kind.itemId);
    }
    const stubs = { sample: sampler(face, true), shade: (hit: Hit) => shade(hit, []) };
    await paintFace(sheet, STUB_ROW, column, stubs, "stubs");
  }
  const tiles = KINDS.flatMap((kind, row) => kindTiles(kind, row));
  await writeTileset(TILESET_ID, "Mushrooms", sheet, tiles);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
