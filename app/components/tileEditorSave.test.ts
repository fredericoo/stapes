import { describe, expect, it } from "vitest";
import { sanitizeSprite } from "./TileEditorDialog";
import type { TileSprite } from "../lib/types";

function sprite(extra: Partial<TileSprite> = {}): TileSprite {
  return {
    frames: [
      {
        sprite: {
          rect: { x: 0, y: 0, w: 1, h: 1 },
          base: { x: 0, y: 0 },
        },
        durationMs: 80,
      },
    ],
    ...extra,
  };
}

/**
 * Every sprite the dialog saves goes through here, so anything this function
 * fails to carry across is a field the editor can show you and never write.
 * That is how water lost the phase it was authored with: the sprite was
 * rebuilt from its frames, and `phase` sits beside them.
 */
describe("sanitizeSprite", () => {
  it("carries the phase across", () => {
    const phased = sprite({ phase: { x: 3, y: -1 } });
    expect(sanitizeSprite(phased).phase).toEqual({ x: 3, y: -1 });
  });

  it("leaves an unphased sprite unphased", () => {
    expect(sanitizeSprite(sprite())).not.toHaveProperty("phase");
  });

  it("still writes a light colour in one case", () => {
    const lit = sprite();
    lit.frames[0]!.light = { radius: 4, intensity: 0.5, color: "#FFCC88" };
    expect(sanitizeSprite(lit).frames[0]!.light?.color).toBe("#ffcc88");
  });
});
