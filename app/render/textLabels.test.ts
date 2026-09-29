import { describe, expect, it } from "vitest";
import { PLAYER_TILE_ID } from "../game/constants";
import { bodyNameFor, sizedUpName, UNNAMED_BODY } from "../game/displayName";
import { RATING_GLYPH } from "../lib/mastery";
import type { TileDef } from "../lib/types";
import { labelScreenPosition, stackingOrder } from "./textLabels";

describe("label placement", () => {
  const camera = { x: 100, y: 200 };

  it("measures from the camera's top left", () => {
    expect(labelScreenPosition(100, 200, camera, 1)).toEqual({
      left: 0,
      top: 0,
    });
    expect(labelScreenPosition(110, 220, camera, 1)).toEqual({
      left: 10,
      top: 20,
    });
  });

  it("scales world pixels into CSS pixels", () => {
    expect(labelScreenPosition(110, 220, camera, 4)).toEqual({
      left: 40,
      top: 80,
    });
  });

  it("lands on whole CSS pixels at every scale", () => {
    for (const cssScale of [1, 4, 5.333333, 6.6875, 0.25]) {
      for (const worldX of [100, 103, 110.5, 87.25, 199.99]) {
        const at = labelScreenPosition(worldX, worldX * 2, camera, cssScale);
        expect(Number.isInteger(at.left), `left for ${worldX} @ ${cssScale}`).toBe(true);
        expect(Number.isInteger(at.top), `top for ${worldX} @ ${cssScale}`).toBe(true);
      }
    }
  });

  it("places a label outside the view rather than dropping it", () => {
    expect(labelScreenPosition(0, 0, camera, 2)).toEqual({
      left: -200,
      top: -400,
    });
  });
});

describe("stacking order", () => {
  it("puts the nearer label last, so it paints on top", () => {
    expect(
      stackingOrder([
        { id: "far", order: 10 },
        { id: "near", order: 20 },
        { id: "middle", order: 15 },
      ]),
    ).toEqual(["far", "middle", "near"]);
  });

  it("leaves a label with no order on top", () => {
    expect(stackingOrder([{ id: "speech" }, { id: "name", order: 10 }])).toEqual([
      "name",
      "speech",
    ]);
  });

  it("keeps the caller's order where two labels tie", () => {
    expect(
      stackingOrder([
        { id: "a", order: 5 },
        { id: "b", order: 5 },
      ]),
    ).toEqual(["a", "b"]);
  });
});

describe("naming a speaker", () => {
  const tilesById = {
    deer: { id: "deer", name: "Deer" } as TileDef,
    [PLAYER_TILE_ID]: { id: PLAYER_TILE_ID, name: "Player" } as TileDef,
  };

  it("calls a person by the name they chose", () => {
    expect(bodyNameFor({ tileId: PLAYER_TILE_ID, name: "Arthur" }, tilesById)).toBe("Arthur");
  });

  it("does not call a person after the tile they stand up in", () => {
    expect(bodyNameFor({ tileId: PLAYER_TILE_ID, name: "Arthur" }, tilesById)).not.toBe("Player");
  });

  it("still attributes the words when a person has no name", () => {
    expect(bodyNameFor({ tileId: PLAYER_TILE_ID }, tilesById)).toBe(UNNAMED_BODY);
  });

  it("calls a creature what its tile is called", () => {
    expect(bodyNameFor({ tileId: "deer" }, tilesById)).toBe("Deer");
  });

  it("calls every creature of a kind the same thing", () => {
    expect(bodyNameFor({ tileId: "deer" }, tilesById)).toBe(
      bodyNameFor({ tileId: "deer" }, tilesById),
    );
  });

  it("still attributes the words when the tile is unknown", () => {
    expect(bodyNameFor({ tileId: "ghost" }, tilesById)).toBeTruthy();
  });
});

describe("sizedUpName", () => {
  it("adds the rating to everything while you are looking", () => {
    expect(sizedUpName("Rat", 8, true)).toBe(`Rat ${RATING_GLYPH}8`);
  });

  it("says nothing extra when nobody is looking", () => {
    expect(sizedUpName("Rat", 8, false)).toBe("Rat");
  });

  it("says nothing extra about a body with no rating to give", () => {
    expect(sizedUpName("Barrel", null, true)).toBe("Barrel");
  });

  it("is written in something the world's font can draw", () => {
    const label = sizedUpName("Rat", 8, true);
    for (const char of label) {
      const code = char.codePointAt(0) ?? 0;
      expect(code).toBeGreaterThanOrEqual(0x20);
      expect(code).toBeLessThanOrEqual(0x7d);
    }
  });
});
