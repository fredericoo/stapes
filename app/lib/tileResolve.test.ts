import { describe, expect, it } from "vitest";
import {
  normalizeTileDef,
  tileCanEmitLight,
  type TileDef,
} from "./types";
import { getFrames, resolveLight, resolveTileSprite } from "./tileResolve";

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
      height: 1,
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
});
