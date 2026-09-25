import { describe, expect, it } from "vitest";
import { PLAYER_TILE_ID } from "../game/constants";
import { bodyNameFor, sizedUpName, UNNAMED_BODY } from "../game/displayName";
import { RATING_GLYPH } from "../lib/mastery";
import type { TileDef } from "../lib/types";
import { labelScreenPosition, stackingOrder } from "./textLabels";

/**
 * Where a label lands, without a browser.
 *
 * The drawing is now the browser's job — a webfont in a div, which is the whole
 * point of the change that put it there. What is still ours, and still able to
 * be wrong in a way nobody notices until it looks slightly soft, is the
 * arithmetic that turns a world position into a screen one.
 */

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

  /**
   * The font's bricks have to sit on whole pixels — a half pixel of offset is
   * the browser antialiasing a pixel font, which is the one thing 1-bit type
   * cannot absorb. `cssScale` is deliberately fractional (the buffer is
   * stretched to fill the pane), so this is the case that actually happens
   * rather than a defensive one.
   */
  it("lands on whole CSS pixels at every scale", () => {
    for (const cssScale of [1, 4, 5.333333, 6.6875, 0.25]) {
      for (const worldX of [100, 103, 110.5, 87.25, 199.99]) {
        const at = labelScreenPosition(worldX, worldX * 2, camera, cssScale);
        expect(Number.isInteger(at.left), `left for ${worldX} @ ${cssScale}`).toBe(true);
        expect(Number.isInteger(at.top), `top for ${worldX} @ ${cssScale}`).toBe(true);
      }
    }
  });

  /** A label behind the camera is still placed; the layer clips it, not this. */
  it("places a label outside the view rather than dropping it", () => {
    expect(labelScreenPosition(0, 0, camera, 2)).toEqual({
      left: -200,
      top: -400,
    });
  });
});

/**
 * Which name is on top when two of them cross.
 *
 * It used to be whoever's element was created first, so a cat that had been on
 * screen longer had its tag drawn over the player standing in front of it —
 * chrome contradicting the very sprites it is attached to. The key comes from
 * `drawOrder`, the same painter's key the world sorts bodies by; what is
 * asserted here is only that the layer honours it.
 */
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

  /** Speech and looks say nothing about depth, and are drawn over names anyway. */
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

/**
 * Who a bubble is attributed to, which is a different question for a person and
 * for a deer: one typed a name when they made their character, the other is a
 * tile somebody authored and named.
 */
describe("naming a speaker", () => {
  const tilesById = {
    deer: { id: "deer", name: "Deer" } as TileDef,
    [PLAYER_TILE_ID]: { id: PLAYER_TILE_ID, name: "Player" } as TileDef,
  };

  it("calls a person by the name they chose", () => {
    expect(bodyNameFor({ tileId: PLAYER_TILE_ID, name: "Arthur" }, tilesById)).toBe("Arthur");
  });

  /**
   * Not the tile's name — a player body is called "Player", and every visitor
   * would be it.
   */
  it("does not call a person after the tile they stand up in", () => {
    expect(bodyNameFor({ tileId: PLAYER_TILE_ID, name: "Arthur" }, tilesById)).not.toBe("Player");
  });

  /**
   * A body with no name is a body from a session that has no character table —
   * `/play`'s single local player — or one whose name never reached this
   * client. Either way the words still have to be attributed to something, and
   * a blank label is worse than an obviously placeholder one.
   */
  it("still attributes the words when a person has no name", () => {
    expect(bodyNameFor({ tileId: PLAYER_TILE_ID }, tilesById)).toBe(UNNAMED_BODY);
  });

  it("calls a creature what its tile is called", () => {
    expect(bodyNameFor({ tileId: "deer" }, tilesById)).toBe("Deer");
  });

  /**
   * The point of naming a creature after its tile: every deer is the same
   * deer, and two of them yelping should not read as two individuals with
   * names.
   */
  it("calls every creature of a kind the same thing", () => {
    expect(bodyNameFor({ tileId: "deer" }, tilesById)).toBe(
      bodyNameFor({ tileId: "deer" }, tilesById),
    );
  });

  /** A map holding a deleted tile id is a bug elsewhere, not a blank label. */
  it("still attributes the words when the tile is unknown", () => {
    expect(bodyNameFor({ tileId: "ghost" }, tilesById)).toBeTruthy();
  });
});

/**
 * Sizing something up before swinging at it.
 *
 * The rating over a head is the only place the reward curve's own number reaches
 * a player, and it is the one label nobody can check by reading the renderer:
 * confirming it in the world means walking to a rat.
 */
describe("sizedUpName", () => {
  it("adds the rating to everything while you are looking", () => {
    expect(sizedUpName("Rat", 8, true)).toBe(`Rat ${RATING_GLYPH}8`);
  });

  /**
   * A number over every head all the time turns a field into a spreadsheet, and
   * it is not what a name tag is for. Look mode is the question being asked.
   */
  it("says nothing extra when nobody is looking", () => {
    expect(sizedUpName("Rat", 8, false)).toBe("Rat");
  });

  /** A crate is lookable and has no opinion about fighting. */
  it("says nothing extra about a body with no rating to give", () => {
    expect(sizedUpName("Barrel", null, true)).toBe("Barrel");
  });

  /**
   * ASCII, because the world's font is. A ⭐ has no glyph in NF Pixels and the
   * browser answers with a colour emoji at the wrong metrics — which is what
   * this shipped as, and what it looked like.
   */
  it("is written in something the world's font can draw", () => {
    const label = sizedUpName("Rat", 8, true);
    for (const char of label) {
      const code = char.codePointAt(0) ?? 0;
      expect(code).toBeGreaterThanOrEqual(0x20);
      expect(code).toBeLessThanOrEqual(0x7d);
    }
  });
});
