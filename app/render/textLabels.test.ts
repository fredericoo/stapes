import { describe, expect, it } from "vitest";
import { PLAYER_TILE_ID } from "../game/constants";
import { displayNameFor, bodyNameFor, sizedUpName } from "../game/displayName";
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
        expect(
          Number.isInteger(at.left),
          `left for ${worldX} @ ${cssScale}`,
        ).toBe(true);
        expect(
          Number.isInteger(at.top),
          `top for ${worldX} @ ${cssScale}`,
        ).toBe(true);
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
    expect(
      stackingOrder([{ id: "speech" }, { id: "name", order: 10 }]),
    ).toEqual(["name", "speech"]);
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

describe("display names", () => {
  const uuid = "3f9ac1d2-55b7-4a0e-9c31-8a2b6f0e1d44";
  const twoCapitalisedWords = /^[A-Z][a-z]+ [A-Z][a-z]+$/;

  it("names an actor after a colour and an animal", () => {
    expect(displayNameFor(uuid)).toMatch(twoCapitalisedWords);
  });

  it("gives the same actor the same name every time", () => {
    expect(displayNameFor(uuid)).toBe(displayNameFor(uuid));
  });

  it("tells two actors apart", () => {
    expect(displayNameFor(uuid)).not.toBe(
      displayNameFor("aa11bb22-55b7-4a0e-9c31-8a2b6f0e1d44"),
    );
  });

  /**
   * The reason the id is hashed rather than handed to the generator's own
   * `seed`, which sums char codes: uuids differing only in the order of their
   * digits are exactly what a cookie mints, and summing gives every one of them
   * the same name.
   */
  it("tells apart two ids made of the same characters", () => {
    expect(displayNameFor("3f9ac1d2-55b7-4a0e-9c31-8a2b6f0e1d44")).not.toBe(
      displayNameFor("2d1ca9f3-55b7-4a0e-9c31-8a2b6f0e1d44"),
    );
  });

  /**
   * A name is drawn from a fixed pair of word lists, so the odd ids have
   * nothing to fall back to and nothing to fail at — but the arithmetic that
   * indexes those lists can still walk off the end of one.
   */
  it("names an actor whatever its id looks like", () => {
    for (const id of ["", "-", "ab", "----------", "z"]) {
      expect(displayNameFor(id)).toMatch(twoCapitalisedWords);
    }
  });

  /**
   * Both halves have to keep moving. Everything above would still pass if one
   * of the two words were drawn from a handful of entries — the names would be
   * distinct and it would be the *other* word doing all the work — so this
   * counts what a hundred ids actually get.
   *
   * The thresholds are well under what a uniform draw gives (≈45 of 52 colours,
   * ≈87 of 355 animals, both by the birthday effect rather than by any flaw), so
   * they fail on a stuck word list rather than on an unlucky run.
   */
  it("draws on the breadth of both word lists", () => {
    const names = Array.from({ length: 100 }, (_, i) =>
      displayNameFor(`actor-${i}`),
    );

    const colours = new Set(names.map((name) => name.split(" ")[0]));
    const beasts = new Set(names.map((name) => name.split(" ")[1]));
    expect(new Set(names).size).toBe(100);
    expect(colours.size).toBeGreaterThan(30);
    expect(beasts.size).toBeGreaterThan(70);
  });
});

/**
 * Who a bubble is attributed to, which is a different question for a person and
 * for a deer: one is a stranger behind a cookie, the other is a tile somebody
 * authored and named.
 */
describe("naming a speaker", () => {
  const tilesById = {
    deer: { id: "deer", name: "Deer" } as TileDef,
    [PLAYER_TILE_ID]: { id: PLAYER_TILE_ID, name: "Player" } as TileDef,
  };
  const uuid = "3f9ac1d2-55b7-4a0e-9c31-8a2b6f0e1d44";

  it("calls a person by their generated name", () => {
    expect(
      bodyNameFor({ actorId: uuid, tileId: PLAYER_TILE_ID }, tilesById),
    ).toBe(displayNameFor(uuid));
  });

  /**
   * Not the tile's name — a player body is called "Player", and every visitor
   * would be it.
   */
  it("does not call a person after the tile they stand up in", () => {
    expect(
      bodyNameFor({ actorId: uuid, tileId: PLAYER_TILE_ID }, tilesById),
    ).not.toBe("Player");
  });

  it("calls a creature what its tile is called", () => {
    expect(
      bodyNameFor({ actorId: "npc:1,2,0,1", tileId: "deer" }, tilesById),
    ).toBe("Deer");
  });

  /**
   * The point of naming a creature after its tile rather than its owner id:
   * every deer is the same deer, and two of them yelping should not read as two
   * individuals with names.
   */
  it("calls every creature of a kind the same thing", () => {
    expect(
      bodyNameFor({ actorId: "npc:1,2,0,1", tileId: "deer" }, tilesById),
    ).toBe(bodyNameFor({ actorId: "npc:8,4,0,1", tileId: "deer" }, tilesById));
  });

  /** A map holding a deleted tile id is a bug elsewhere, not a blank label. */
  it("still attributes the words when the tile is unknown", () => {
    expect(
      bodyNameFor({ actorId: "npc:1,2,0,1", tileId: "ghost" }, tilesById),
    ).toBeTruthy();
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
