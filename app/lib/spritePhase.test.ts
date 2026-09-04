import { describe, expect, it } from "vitest";
import tiles from "../../data/tiles.json";
import {
  cellPhaseMs,
  cycleMs,
  frameStartMs,
  spritePhase,
  tilePhase,
  withSpritePhase,
  type Frame,
  type TileDef,
  type TileSprite,
} from "./types";
import { allTileSprites, normalizeTiles } from "./types";

function frames(count: number, durationMs = 80): Frame[] {
  return Array.from({ length: count }, (_, i) => ({
    sprite: { tilesetId: "sheet", rect: { x: i, y: 0, w: 1, h: 1 }, base: { x: 0, y: 0 } },
    durationMs,
  }));
}

function sprite(count: number, phase?: { x: number; y: number }): TileSprite {
  return { frames: frames(count), ...(phase ? { phase } : {}) };
}

describe("cellPhaseMs", () => {
  it("is zero everywhere for a sprite that declares no phase", () => {
    const s = sprite(14);
    expect(cellPhaseMs(s, 0, 0)).toBe(0);
    expect(cellPhaseMs(s, 7, -3)).toBe(0);
  });

  it("advances the declared frames per cell", () => {
    const s = sprite(14, { x: 3, y: -1 });
    expect(cellPhaseMs(s, 0, 0)).toBe(0);
    expect(cellPhaseMs(s, 1, 0)).toBe(3 * 80);
    expect(cellPhaseMs(s, 0, 1)).toBe(13 * 80);
  });

  it("wraps rather than running off the end of the cycle", () => {
    const s = sprite(14, { x: 3, y: -1 });
    // 5 * 3 = 15, which is one past the cycle: the 15th frame is the 1st.
    expect(cellPhaseMs(s, 5, 0)).toBe(1 * 80);
    // Negative coordinates are as ordinary as positive ones on this map.
    expect(cellPhaseMs(s, -1, 0)).toBe(11 * 80);
  });

  it("counts in milliseconds, so uneven frames still land on a boundary", () => {
    const uneven: TileSprite = {
      frames: [frames(1, 100)[0]!, frames(1, 50)[0]!, frames(1, 250)[0]!],
      phase: { x: 1, y: 0 },
    };
    expect(cellPhaseMs(uneven, 1, 0)).toBe(100);
    expect(cellPhaseMs(uneven, 2, 0)).toBe(150);
    expect(cycleMs(uneven.frames)).toBe(400);
    expect(frameStartMs(uneven.frames, 3)).toBe(400);
  });
});

describe("spritePhase", () => {
  it("refuses a phase on a sprite whose light varies", () => {
    const flicker: TileSprite = {
      frames: frames(2).map((f, i) => ({
        ...f,
        light: { radius: i === 0 ? 4 : 2, intensity: 1, color: "#ffcc88" },
      })),
      phase: { x: 1, y: 0 },
    };
    expect(spritePhase(flicker)).toBeUndefined();
    expect(cellPhaseMs(flicker, 3, 0)).toBe(0);
  });

  it("allows one on a sprite that emits the same light throughout", () => {
    const steady: TileSprite = {
      frames: frames(2).map((f) => ({
        ...f,
        light: { radius: 4, intensity: 1, color: "#ffcc88" },
      })),
      phase: { x: 1, y: 0 },
    };
    expect(spritePhase(steady)).toEqual({ x: 1, y: 0 });
  });

  it("refuses one on a sprite with nothing to phase", () => {
    expect(spritePhase({ frames: frames(1), phase: { x: 1, y: 0 } })).toBeUndefined();
  });
});

describe("withSpritePhase", () => {
  const autotile = (): TileDef =>
    ({
      id: "water",
      name: "Water",
      height: 0,
      type: "autotile",
      kind: "prop",
      attributes: {},
      slices: { 0: sprite(14), 5: sprite(14), 46: sprite(14) },
      states: { moving: { slices: { 0: sprite(14) } } },
    }) as unknown as TileDef;

  it("puts one phase on every sprite the tile has, states included", () => {
    const out = withSpritePhase(autotile(), { x: 3, y: -1 });
    const all = allTileSprites(out);
    expect(all).toHaveLength(4);
    for (const s of all) expect(s.phase).toEqual({ x: 3, y: -1 });
  });

  it("reads back as one answer for the tile", () => {
    expect(tilePhase(withSpritePhase(autotile(), { x: 3, y: -1 }))).toEqual({
      x: 3,
      y: -1,
    });
    expect(tilePhase(autotile())).toBeUndefined();
  });

  it("takes the phase off rather than storing a zero", () => {
    const phased = withSpritePhase(autotile(), { x: 3, y: -1 });
    const cleared = withSpritePhase(phased, { x: 0, y: 0 });
    for (const s of allTileSprites(cleared)) expect(s.phase).toBeUndefined();
    expect(tilePhase(cleared)).toBeUndefined();
  });

  it("leaves a tile with no sprites alone", () => {
    const bare = { id: "x", name: "X", height: 0, type: "simple", kind: "prop", attributes: {} } as unknown as TileDef;
    expect(withSpritePhase(bare, { x: 1, y: 0 })).toEqual(bare);
  });
});

describe("the shipped catalogue", () => {
  const catalogue = normalizeTiles(tiles as unknown[]) as TileDef[];

  /**
   * The pairing `spritePhase` refuses, asserted here so that refusing it is a
   * guard rather than the only thing standing between an author and a lamp
   * whose glow has quietly stopped matching its own flame. A tile that wants
   * both wants per-cell light bakes, which is a decision, not an oversight.
   */
  it("never phases a sprite whose light varies", () => {
    const offenders: string[] = [];
    for (const tile of catalogue) {
      for (const s of allTileSprites(tile)) {
        if (s.phase && !spritePhase(s)) offenders.push(tile.id);
      }
    }
    expect(offenders).toEqual([]);
  });
});
