import { describe, expect, it } from "vitest";
import type { TileDef, TileSprite, TilesetDef } from "./types";
import { spriteRect } from "./types";
import { anchorFits, nextFreeTileId, spriteRefAt } from "./spriteAnchor";

function sprite(x: number, y: number, frames = 1): TileSprite {
  return {
    frames: Array.from({ length: frames }, (_, i) => ({
      sprite: {
        rect: { x: x + i, y, w: 1, h: 2 },
        base: { x: 0, y: 1 },
      },
      durationMs: 200,
    })),
  };
}

/** A four-way character with a second state, which is the case this is for. */
function villager(anchor = { tilesetId: "chars", x: 0, y: 0 }): TileDef {
  return {
    id: "villager",
    name: "Villager",
    height: 2,
    type: "directional",
    kind: "prop",
    attributes: {},
    anchor,
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

/** 8 cells across, 16 down. The villager's block is 2 wide and 8 tall. */
const CHARS: TilesetDef = {
  id: "chars",
  name: "Characters",
  file: "chars.png",
  width: 64,
  height: 128,
};

describe("whether an anchor fits the sheet", () => {
  it("allows one whose block stays inside", () => {
    const anchor = { tilesetId: "chars", x: 1, y: 8 };
    expect(anchorFits(villager(), anchor, [CHARS])).toBeNull();
  });

  it("refuses one that would run off the top or left", () => {
    const anchor = { tilesetId: "chars", x: -1, y: 0 };
    expect(anchorFits(villager(), anchor, [CHARS])).toMatch(/top or left/);
  });

  it("refuses one that would run past the far edge, naming the sheet", () => {
    // The lowest sprite starts at y 6 and is 2 cells tall; the sheet is 16.
    const anchor = { tilesetId: "chars", x: 0, y: 9 };
    expect(anchorFits(villager(), anchor, [CHARS])).toMatch(/Characters/);
  });

  it("counts the block from the anchor, not from the sheet's corner", () => {
    // Sprites to the *left* of the anchor are art the author meant, so the far
    // edge is measured from the anchor and the near edge is checked too.
    const reachingBack: TileDef = {
      ...villager({ tilesetId: "chars", x: 1, y: 0 }),
      sprites: { n: sprite(-2, 0) },
      states: undefined,
    };
    expect(anchorFits(reachingBack, reachingBack.anchor, [CHARS])).toMatch(
      /top or left/,
    );
  });

  it("refuses a sheet that is not in the library", () => {
    const anchor = { tilesetId: "gone", x: 0, y: 0 };
    expect(anchorFits(villager(), anchor, [CHARS])).toMatch(/No such sheet/);
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

describe("picking a rectangle off the sheet", () => {
  const anchor = { tilesetId: "chars", x: 10, y: 6 };

  it("stores it measured from the anchor", () => {
    const picked = { rect: { x: 12, y: 8, w: 2, h: 2 }, base: { x: 1, y: 1 } };
    expect(spriteRefAt(anchor, picked)).toEqual({
      rect: { x: 2, y: 2, w: 2, h: 2 },
      base: { x: 1, y: 1 },
    });
  });

  it("round-trips against spriteRect, which is what the picker shows", () => {
    const picked = { rect: { x: 12, y: 8, w: 2, h: 2 }, base: { x: 1, y: 1 } };
    expect(spriteRect(anchor, spriteRefAt(anchor, picked))).toEqual(picked.rect);
  });

  it("keeps a pick above or to the left of the anchor, rather than clamping it", () => {
    const picked = { rect: { x: 8, y: 4, w: 1, h: 1 }, base: { x: 0, y: 0 } };
    expect(spriteRefAt(anchor, picked).rect).toMatchObject({ x: -2, y: -2 });
  });
});
