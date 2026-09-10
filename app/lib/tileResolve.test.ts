import { describe, expect, it } from "vitest";
import {
  normalizeTileDef,
  spriteRect,
  tileCanEmitLight,
  type SpriteRef,
  type TileDef,
} from "./types";
import { getFrames, resolveLight, resolveTileSprite } from "./tileResolve";
import { DEFAULT_PARTICLES } from "./particleVfx";

describe("normalizeTileDef", () => {
  it("migrates simple variants and tile light onto frames", () => {
    const def = normalizeTileDef({
      id: "torch",
      name: "Torch",
      height: 0,
      directional: false,
      variants: {
        default: [
          {
            sprite: {
              tilesetId: "t",
              rect: { x: 0, y: 0, w: 1, h: 1 },
              base: { x: 0, y: 0 },
            },
            durationMs: 200,
          },
        ],
      },
      attributes: {},
      light: { radius: 5, intensity: 1, color: "#ffcc88" },
    });
    expect(def.type).toBe("simple");
    expect(def.sprite?.frames[0].light?.radius).toBe(5);
    expect(tileCanEmitLight(def)).toBe(true);
    expect(resolveLight(def)).toEqual({
      radius: 5,
      intensity: 1,
      color: "#ffcc88",
    });
  });

  it("migrates directional variants to sprites", () => {
    const frame = {
      sprite: {
        tilesetId: "t",
        rect: { x: 0, y: 0, w: 1, h: 1 },
        base: { x: 0, y: 0 },
      },
      durationMs: 200,
    };
    const def = normalizeTileDef({
      id: "ramp",
      name: "Ramp",
      height: 2,
      directional: true,
      variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
      attributes: {},
    });
    expect(def.type).toBe("directional");
    expect(resolveTileSprite(def, { direction: "e" })?.frames).toHaveLength(1);
    expect(getFrames(def, "e")).toHaveLength(1);
  });

  it("is idempotent on new tiles", () => {
    const def: TileDef = {
      id: "g",
      name: "G",
      height: 0,
      type: "simple",
      kind: "prop",
      attributes: {},
      anchor: { tilesetId: "t", x: 0, y: 0 },
      sprite: {
        frames: [
          {
            sprite: {
              rect: { x: 0, y: 0, w: 1, h: 1 },
              base: { x: 0, y: 0 },
            },
            durationMs: 200,
          },
        ],
      },
    };
    expect(normalizeTileDef(def)).toEqual(def);
  });

  it("fills in an emitter field the authored plume predates", () => {
    // A plume written before there was a wind was written in still air, and the
    // renderer reads a complete emitter rather than checking for holes in one.
    const { windX: _x, windY: _y, ...stillAir } = DEFAULT_PARTICLES;
    const def = normalizeTileDef({
      id: "chimney",
      name: "Chimney",
      height: 4,
      type: "simple",
      kind: "prop",
      attributes: {},
      particles: stillAir,
    });
    expect(def.particles?.windX).toBe(0);
    expect(def.particles?.windY).toBe(0);
  });

  it("drops a malformed plume rather than refusing the tile", () => {
    // Nothing parses a tile on the way in, so a hand-edited `tiles.json` is the
    // way a `ratePerSecond` of "lots" reaches the emission loop. A world that
    // would not load over a smoke plume is worse than a chimney that has
    // stopped smoking.
    const def = normalizeTileDef({
      id: "chimney",
      name: "Chimney",
      height: 4,
      type: "simple",
      kind: "prop",
      attributes: {},
      particles: { ...DEFAULT_PARTICLES, ratePerSecond: "lots" },
    });
    expect(def.id).toBe("chimney");
    expect(def.particles).toBeUndefined();
  });
});

describe("a tile written before it had an anchor", () => {
  /** The old encoding: a sheet on every sprite, rects from the sheet's corner. */
  const legacyFrame = (x: number, y: number, tilesetId = "chars") => ({
    sprite: {
      tilesetId,
      rect: { x, y, w: 2, h: 2 },
      base: { x: 1, y: 1 },
    },
    durationMs: 200,
  });

  const legacyVillager = () =>
    normalizeTileDef({
      id: "villager",
      name: "Villager",
      height: 2,
      type: "directional",
      kind: "prop",
      attributes: {},
      sprites: {
        n: { frames: [legacyFrame(10, 6), legacyFrame(12, 6)] },
        e: { frames: [legacyFrame(10, 8)] },
      },
      states: { moving: { sprites: { n: { frames: [legacyFrame(14, 6)] } } } },
    });

  it("takes its sheet off its sprites and its anchor off their corner", () => {
    expect(legacyVillager().anchor).toEqual({ tilesetId: "chars", x: 10, y: 6 });
  });

  it("draws every sprite from exactly where it drew before", () => {
    const def = legacyVillager();
    const at = (sprite: { rect: { x: number; y: number } }) =>
      spriteRect(def.anchor, sprite as SpriteRef);
    expect(at(def.sprites!.n!.frames[0]!.sprite)).toMatchObject({ x: 10, y: 6 });
    expect(at(def.sprites!.n!.frames[1]!.sprite)).toMatchObject({ x: 12, y: 6 });
    expect(at(def.sprites!.e!.frames[0]!.sprite)).toMatchObject({ x: 10, y: 8 });
    // States are walked too, which is where a migration led by `type` would have
    // left half the tile absolute and half of it relative.
    expect(
      at(def.states!.moving!.sprites!.n!.frames[0]!.sprite),
    ).toMatchObject({ x: 14, y: 6 });
  });

  it("leaves no sheet behind on a sprite", () => {
    const frames = legacyVillager().sprites!.n!.frames;
    for (const frame of frames) {
      expect(frame.sprite).not.toHaveProperty("tilesetId");
    }
  });

  it("keeps the size and the base, which are inside the rect", () => {
    const sprite = legacyVillager().sprites!.n!.frames[0]!.sprite;
    expect(sprite.rect).toMatchObject({ w: 2, h: 2 });
    expect(sprite.base).toEqual({ x: 1, y: 1 });
  });

  it("leaves a tile that already has an anchor alone", () => {
    const anchored = legacyVillager();
    expect(normalizeTileDef(anchored)).toEqual(anchored);
  });

  it("gives a tile with no art at all an anchor it can be given one from", () => {
    const blank = normalizeTileDef({
      id: "blank",
      name: "Blank",
      height: 0,
      type: "simple",
      kind: "prop",
      attributes: {},
    });
    expect(blank.anchor).toEqual({ tilesetId: "", x: 0, y: 0 });
  });
});
