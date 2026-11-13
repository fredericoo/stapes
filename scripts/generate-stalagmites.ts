import { PNG } from "pngjs";
import { CELL_SIZE, type TileDef } from "../app/lib/types";
import { castSprite, type Capsule, type Hit, type Vec3 } from "./limb-caster";
import { paint, writeTileset } from "./tileset-output";

const TILESET_ID = "stalagmites";
const FRAME_MS = 200;

/**
 * Three units: the tallest a prop can be and still leave the cell above it
 * walkable, since a level-tall tile tops out on the floor plane above.
 */
const HEIGHT = 3;

const CELL = CELL_SIZE;
const SPRITE_CELLS = 2;
const SPRITE_PX = SPRITE_CELLS * CELL;
const GROUND_PX = SPRITE_PX - CELL;
const PROJECTION = { spritePx: SPRITE_PX, groundPx: GROUND_PX, topPx: SPRITE_PX - 1 };

/** One tile per tone, each a row of the sheet. A ramp is palette indices, light to dark. */
type Tone = { tileId: string; name: string; ramp: readonly number[] };

const TONES: Tone[] = [
  /** The ramp `cave-wall` and `half-stone` are painted in. */
  { tileId: "stalagmite", name: "Stalagmite", ramp: [18, 13, 11, 3] },
  /** The ramp of `cave-wall-grey`. */
  { tileId: "stalagmite-grey", name: "Grey Stalagmite", ramp: [25, 22, 8, 4] },
];

/** A cone standing on the floor at `x, y` (pixels of its own cell), `heightPx` tall. */
type Cone = { x: number; y: number; radiusPx: number; heightPx: number; lean?: [number, number] };

/**
 * One cluster per scatter variant. The tallest cone in each is close to the
 * tile's height, and the smaller ones round it keep the four from reading as
 * one sprite repeated.
 */
const VARIANTS: Cone[][] = [
  [
    { x: 4, y: 4.2, radiusPx: 3.1, heightPx: 7 },
    { x: 6, y: 5.6, radiusPx: 1.7, heightPx: 3 },
  ],
  [
    { x: 3.4, y: 3.8, radiusPx: 2.6, heightPx: 6, lean: [-0.4, 0] },
    { x: 5, y: 5, radiusPx: 2.5, heightPx: 4.5, lean: [0.3, 0.2] },
    { x: 2.6, y: 6.2, radiusPx: 1.3, heightPx: 2 },
  ],
  [
    { x: 3.9, y: 4, radiusPx: 3.6, heightPx: 5 },
    { x: 2, y: 5.6, radiusPx: 1.6, heightPx: 2.5 },
    { x: 6.2, y: 2.4, radiusPx: 1.4, heightPx: 2.2 },
  ],
  [
    { x: 3, y: 4.6, radiusPx: 2.3, heightPx: 5.5 },
    { x: 5, y: 3.6, radiusPx: 2.1, heightPx: 6.5, lean: [0.2, -0.3] },
    { x: 5.6, y: 6.2, radiusPx: 1.4, heightPx: 2 },
  ],
];

const TIP_RADIUS_PX = 0.2;

function coneLimb(cone: Cone): Capsule {
  const [leanX, leanY] = cone.lean ?? [0, 0];
  const to: Vec3 = [cone.x + leanX, cone.y + leanY, cone.heightPx];
  return { from: [cone.x, cone.y, 0], to, radiusFrom: cone.radiusPx, radiusTo: TIP_RADIUS_PX };
}

/** Distance between the mineral bands that ring every cone, in pixels of height. */
const BAND_PX = 2.2;

/**
 * Lit from the south-west, as every other block here, and a band darker every
 * `BAND_PX` up the cone, which is what reads as dripped stone rather than a
 * smooth spike at this size.
 */
function shader(ramp: readonly number[]) {
  return ({ normal, at }: Hit<Capsule>): number => {
    const across = (normal[0] - normal[1]) / Math.SQRT2 - normal[2] * 0.5;
    let band = Math.floor(((across + 1) / 2) * ramp.length);
    if (at[2] % BAND_PX < 0.55) band++;
    return ramp[Math.max(0, Math.min(ramp.length - 1, band))]!;
  };
}

function stalagmiteTile(tone: Tone, row: number): TileDef {
  return {
    id: tone.tileId,
    name: tone.name,
    height: HEIGHT,
    type: "scatter",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET_ID, x: 0, y: row * SPRITE_CELLS },
    walkable: false,
    lightPassing: true,
    scatter: VARIANTS.map((_, column) => ({
      frames: [
        {
          sprite: {
            rect: { x: column * SPRITE_CELLS, y: 0, w: SPRITE_CELLS, h: SPRITE_CELLS },
            base: { x: SPRITE_CELLS - 1, y: SPRITE_CELLS - 1 },
          },
          durationMs: FRAME_MS,
        },
      ],
    })),
  };
}

async function main() {
  const sheet = new PNG({ width: VARIANTS.length * SPRITE_PX, height: TONES.length * SPRITE_PX });
  sheet.data.fill(0);
  TONES.forEach((tone, row) => {
    VARIANTS.forEach((cones, column) => {
      castSprite(cones.map(coneLimb), PROJECTION, shader(tone.ramp), (u, v, index) =>
        paint(sheet, column * SPRITE_PX + u, row * SPRITE_PX + v, index),
      );
    });
  });
  const tiles = TONES.map((tone, row) => stalagmiteTile(tone, row));
  await writeTileset(TILESET_ID, "Stalagmites", sheet, tiles);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
