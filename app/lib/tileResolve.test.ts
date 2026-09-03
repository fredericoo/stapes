import { describe, expect, it } from "vitest";
import {
  normalizeTileDef,
  tileCanEmitLight,
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
      sprite: {
        frames: [
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
