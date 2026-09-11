import { describe, expect, it } from "vitest";
import { normalizeTileDef, type TileDef, type TileSprite } from "./types";
import { getFrames, resolveTileSprite } from "./tileResolve";
import { pickVariantSprite, variantKeys } from "./variant";
import { animationKey } from "../render/spriteQuad";

/**
 * A sprite identifiable by where it sits, so a resolution can be checked against
 * which art came back rather than only against something coming back.
 *
 * The row is the marker: `sprite(3)` is the fourth row of the block, and its
 * frames run along it. One sheet for the whole tile — see `TileDef.anchor` — so
 * the sheet cannot be the marker any more.
 */
function sprite(row: number, frames = 1): TileSprite {
  return {
    frames: Array.from({ length: frames }, (_, i) => ({
      sprite: {
        rect: { x: i, y: row, w: 1, h: 1 },
        base: { x: 0, y: 0 },
      },
      durationMs: 200,
    })),
  };
}

const GRASS = 0;
const PLANKS = 1;
const SAND = 2;
const PLANKS_MOVING = 3;

function hole(): TileDef {
  return {
    id: "hole",
    name: "Hole",
    height: 0,
    type: "variant",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: "holes", x: 0, y: 0 },
    variants: {
      grass: sprite(GRASS),
      planks: sprite(PLANKS, 4),
      sand: sprite(SAND),
    },
  };
}

/** Which face came back, read off the row its art sits on. */
function rowOf(def: TileDef, variant: string | undefined): number | undefined {
  return resolveTileSprite(def, { variant })?.frames[0]?.sprite.rect.y;
}

describe("a variant tile draws the face its placement names", () => {
  it("keeps the authored order", () => {
    expect(variantKeys(hole())).toEqual(["grass", "planks", "sand"]);
  });

  it("draws the named face", () => {
    expect(rowOf(hole(), "planks")).toBe(PLANKS);
    expect(rowOf(hole(), "sand")).toBe(SAND);
  });

  it("falls back to the first authored face when the placement names none", () => {
    expect(rowOf(hole(), undefined)).toBe(GRASS);
  });

  // A face renamed in the tile editor leaves every placement naming the old one
  // pointing at nothing. Drawing the wrong hole reads as art not finished;
  // drawing nothing reads as a hole in the world, which for this tile is
  // indistinguishable from it working.
  it("falls back rather than blanking when the name is gone", () => {
    expect(rowOf(hole(), "gravel")).toBe(GRASS);
    expect(pickVariantSprite({ variants: {} }, "grass")).toBeUndefined();
  });

  it("reads nothing off the cell", () => {
    const def = hole();
    const at = (x: number, y: number, z: number) =>
      resolveTileSprite(def, { variant: "sand", x, y, z })?.frames[0]?.sprite
        .rect.y;
    expect(at(0, 0, 0)).toBe(SAND);
    expect(at(97, -13, -2)).toBe(SAND);
  });
});

describe("a state may redraw one face without taking the others", () => {
  const def: TileDef = {
    ...hole(),
    states: { moving: { variants: { planks: sprite(PLANKS_MOVING) } } },
  };

  it("uses the state's face where it has one", () => {
    expect(
      resolveTileSprite(def, { state: "moving", variant: "planks" })?.frames[0]
        ?.sprite.rect.y,
    ).toBe(PLANKS_MOVING);
  });

  it("falls through to idle's same face, never to the state's other faces", () => {
    expect(
      resolveTileSprite(def, { state: "moving", variant: "sand" })?.frames[0]
        ?.sprite.rect.y,
    ).toBe(SAND);
  });

  // The key is settled against idle before either holder answers, so a
  // placement naming no face does not change face when it starts moving.
  it("settles an unnamed face against idle, not against the state", () => {
    expect(
      resolveTileSprite(def, { state: "moving" })?.frames[0]?.sprite.rect.y,
    ).toBe(GRASS);
  });
});

describe("the frame clock is keyed per face", () => {
  it("separates two placements of one tile wearing different faces", () => {
    const def = hole();
    const planks = animationKey(def, { tileId: "hole", variant: "planks" }, 0, 0, 0);
    const sand = animationKey(def, { tileId: "hole", variant: "sand" }, 9, 9, 0);
    expect(planks).not.toBe(sand);
    // Two placements wearing the same face share one clock wherever they stand:
    // the face is the whole of what decides the frame list.
    expect(animationKey(def, { tileId: "hole", variant: "sand" }, 1, 2, 3)).toBe(
      sand,
    );
  });
});

describe("normalizeTileDef and the two meanings of `variants`", () => {
  it("keeps a variant tile's faces", () => {
    const def = normalizeTileDef(hole());
    expect(def.type).toBe("variant");
    expect(variantKeys(def)).toEqual(["grass", "planks", "sand"]);
  });

  // A tile written before `type` existed keys `variants` by facing and holds
  // `Frame[]`, not `TileSprite`. Half-migrated data carrying both would hand
  // every sprite walker the wrong shape.
  it("drops a legacy variants table off a tile that is not a variant tile", () => {
    const def = normalizeTileDef({
      id: "rock",
      name: "Rock",
      height: 2,
      type: "simple",
      kind: "prop",
      attributes: {},
      anchor: { tilesetId: "props", x: 0, y: 0 },
      sprite: sprite(GRASS),
      variants: { default: [{ durationMs: 200 }] },
    });
    expect(def.variants).toBeUndefined();
    // The tile's real art survives the drop, rather than the legacy table
    // overwriting it on the way through.
    expect(getFrames(def)?.[0]?.sprite.rect.y).toBe(GRASS);
  });

  it("still migrates a legacy tile that has no type at all", () => {
    const def = normalizeTileDef({
      id: "rock",
      name: "Rock",
      height: 2,
      directional: false,
      attributes: {},
      variants: {
        default: [
          {
            sprite: {
              tilesetId: "props",
              rect: { x: 0, y: 0, w: 1, h: 1 },
              base: { x: 0, y: 0 },
            },
            durationMs: 200,
          },
        ],
      },
    });
    expect(def.type).toBe("simple");
    expect(def.anchor.tilesetId).toBe("props");
  });
});
