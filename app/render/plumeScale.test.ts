import { describe, expect, it } from "vitest";
import { normalizeTileDef, type TileDef } from "../lib/types";
import { plumeScale } from "./plumeScale";

const drawn = (w: number, h: number) => ({
  frames: [{ sprite: { rect: { x: 0, y: 0, w, h }, base: { x: 0, y: 0 } }, durationMs: 200 }],
});

const body = (fields: Partial<TileDef>): TileDef =>
  normalizeTileDef({
    id: "body",
    name: "Body",
    height: 3,
    type: "simple",
    kind: "battler",
    attributes: {},
    anchor: { tilesetId: "animals", x: 0, y: 0 },
    ...fields,
  });

describe("plumeScale", () => {
  it("draws a plume at the ratio of the body's side to the player's 2×2", () => {
    for (const [w, h, scale] of [
      [2, 2, 1],
      [3, 3, 1.5],
      [4, 4, 2],
    ] as const) {
      expect(plumeScale(body({ sprite: drawn(w, h) }))).toBeCloseTo(scale);
    }
  });

  it("measures a body that is not square by its area, so a rat is one size either way round", () => {
    expect(plumeScale(body({ sprite: drawn(1, 2) }))).toBeCloseTo(Math.SQRT1_2);
    expect(plumeScale(body({ sprite: drawn(2, 1) }))).toBeCloseTo(Math.SQRT1_2);
  });

  it("measures a directional body on the frame it faces south with", () => {
    const facing = body({
      type: "directional",
      sprites: { n: drawn(4, 4), e: drawn(4, 2), s: drawn(3, 3), w: drawn(4, 2) },
    });
    expect(plumeScale(facing)).toBeCloseTo(1.5);
  });

  it("draws a plume as authored when there is no body to measure", () => {
    expect(plumeScale(undefined)).toBe(1);
  });
});
