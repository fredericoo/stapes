import { describe, expect, it } from "vitest";
import type { TileDef, TileSprite, TilesetDef } from "./types";
import {
  nextFreeTileId,
  offsetFits,
  offsetTileSprites,
  spriteRefs,
} from "./spriteOffset";

function sprite(x: number, y: number, frames = 1): TileSprite {
  return {
    frames: Array.from({ length: frames }, (_, i) => ({
      sprite: {
        tilesetId: "chars",
        rect: { x: x + i, y, w: 1, h: 2 },
        base: { x: 0, y: 1 },
      },
      durationMs: 200,
    })),
  };
}

/** A four-way character with a second state, which is the case this is for. */
function villager(): TileDef {
  return {
    id: "villager",
    name: "Villager",
    height: 2,
    type: "directional",
    kind: "prop",
    attributes: {},
    sprites: {
      n: sprite(0, 0),
      e: sprite(0, 2),
      s: sprite(0, 4),
      w: sprite(0, 6),
    },
    states: {
      moving: {
        sprites: {
          n: sprite(0, 0, 2),
          e: sprite(0, 2, 2),
        },
      },
    },
  };
}

const CHARS: TilesetDef = {
  id: "chars",
  name: "Characters",
  file: "chars.png",
  width: 64,
  height: 128,
};

describe("offsetting a tile's sprites", () => {
  it("moves every facing and every state by the same cells", () => {
    const moved = offsetTileSprites(villager(), { x: 2, y: 0 });
    expect(moved.sprites?.n?.frames[0]?.sprite.rect).toMatchObject({ x: 2, y: 0 });
    expect(moved.sprites?.w?.frames[0]?.sprite.rect).toMatchObject({ x: 2, y: 6 });
    expect(
      moved.states?.moving?.sprites?.e?.frames[1]?.sprite.rect,
    ).toMatchObject({ x: 3, y: 2 });
  });

  it("leaves the size, the base and the sheet alone", () => {
    const before = villager().sprites!.s!.frames[0]!.sprite;
    const after = offsetTileSprites(villager(), { x: 1, y: 3 }).sprites!.s!
      .frames[0]!.sprite;
    expect(after.rect.w).toBe(before.rect.w);
    expect(after.rect.h).toBe(before.rect.h);
    expect(after.base).toEqual(before.base);
    expect(after.tilesetId).toBe(before.tilesetId);
  });

  it("does not touch the tile it was given", () => {
    const tile = villager();
    offsetTileSprites(tile, { x: 4, y: 4 });
    expect(tile.sprites?.n?.frames[0]?.sprite.rect.x).toBe(0);
  });

  it("carries the other sprite axes", () => {
    const autotile: TileDef = {
      id: "wall",
      name: "Wall",
      height: 1,
      type: "autotile",
      kind: "prop",
      attributes: {},
      slices: { 0: sprite(0, 0), 12: sprite(3, 0) },
    };
    const moved = offsetTileSprites(autotile, { x: 0, y: 5 });
    expect(moved.slices?.[0]?.frames[0]?.sprite.rect.y).toBe(5);
    expect(moved.slices?.[12]?.frames[0]?.sprite.rect).toMatchObject({
      x: 3,
      y: 5,
    });
  });
});

describe("whether an offset fits the sheet", () => {
  it("allows a move that stays inside", () => {
    expect(offsetFits(villager(), { x: 1, y: 8 }, [CHARS])).toBeNull();
  });

  it("refuses a move off the top-left", () => {
    expect(offsetFits(villager(), { x: -1, y: 0 }, [CHARS])).toMatch(/top or left/);
  });

  it("refuses a move past the far edge, naming the sheet", () => {
    // The tallest sprite sits at y 6 and is 2 cells tall; the sheet is 16.
    expect(offsetFits(villager(), { x: 0, y: 9 }, [CHARS])).toMatch(/Characters/);
  });

  it("says nothing about a sheet that is not in the library", () => {
    expect(offsetFits(villager(), { x: 0, y: 99 }, [])).toBeNull();
  });
});

describe("collecting a tile's sprite references", () => {
  it("finds idle and state frames alike", () => {
    expect(spriteRefs(villager())).toHaveLength(4 + 4);
  });
});

describe("naming a duplicate", () => {
  it("counts up from a plain id", () => {
    expect(nextFreeTileId("guard", new Set(["guard"]))).toBe("guard-2");
  });

  it("counts up from a numbered id", () => {
    expect(nextFreeTileId("guard-2", new Set(["guard", "guard-2"]))).toBe("guard-3");
  });

  it("skips ids already taken", () => {
    const taken = new Set(["guard", "guard-2", "guard-3"]);
    expect(nextFreeTileId("guard", taken)).toBe("guard-4");
  });
});
