import { describe, expect, it, vi } from "vitest";
import type { TileDef } from "../lib/types";
import { HumanTextures } from "./humanTextures";

vi.mock("../lib/humanSheets", () => ({ humanSheetCanvas: () => new Promise(() => {}) }));

const FRAME_CELLS = 2;

function walker(id: string, human?: TileDef["human"]): TileDef {
  const sprite = {
    frames: [
      {
        sprite: { rect: { x: 0, y: 0, w: FRAME_CELLS, h: FRAME_CELLS }, base: { x: 1, y: 1 } },
        durationMs: 200,
      },
    ],
  };
  const sprites = { s: sprite, e: sprite, w: sprite, n: sprite };
  return {
    id,
    name: id,
    height: 3,
    type: "directional",
    kind: "battler",
    attributes: {},
    anchor: { tilesetId: "people", x: 0, y: 0 },
    sprites,
    states: { moving: { sprites } },
    human,
  };
}

describe("HumanTextures.dress", () => {
  const catalogue = {
    baker: walker("baker", { skin: "default", hair: "red", head: "bald" }),
    wolf: walker("wolf"),
  };

  it("re-anchors human tiles in a copy and never touches the catalogue it was given", () => {
    const dressed = new HumanTextures(() => {}).dress(catalogue);

    expect(dressed).not.toBe(catalogue);
    expect(dressed.baker!.anchor.tilesetId).toMatch(/^human:/);
    expect(dressed.wolf).toBe(catalogue.wolf);
    expect(catalogue.baker.anchor.tilesetId).toBe("people");
  });

  it("hands back the same copy for the same catalogue, and the catalogue itself when nobody is human", () => {
    const humans = new HumanTextures(() => {});
    const plain = { wolf: walker("wolf") };

    expect(humans.dress(catalogue)).toBe(humans.dress(catalogue));
    expect(humans.dress(plain)).toBe(plain);
  });
});
