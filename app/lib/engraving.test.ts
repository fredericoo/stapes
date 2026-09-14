import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import { normalizeTiles } from "./types";
import { pileMax } from "./item";
import {
  ENGRAVING_TOKEN,
  UNKNOWN_ENGRAVING,
  engravedName,
  isEngravable,
} from "./engraving";

/**
 * A name with somebody's name written into it.
 *
 * The shipped skull is asserted against the real catalogue on
 * `data/tiles.json`'s own terms — its name has to keep its hole in it, and it
 * has to keep refusing to pile, or every skull in a cell fuses into one nobody
 * can tell apart.
 */

describe("engravedName", () => {
  it("puts the engraving where the token is", () => {
    expect(engravedName(`${ENGRAVING_TOKEN}'s skull`, "Green Fox")).toBe(
      "Green Fox's skull",
    );
  });

  it("fills the hole with somebody when nobody wrote in it", () => {
    expect(engravedName(`${ENGRAVING_TOKEN}'s skull`)).toBe(
      `${UNKNOWN_ENGRAVING}'s skull`,
    );
    expect(engravedName(`${ENGRAVING_TOKEN}'s skull`, "   ")).toBe(
      `${UNKNOWN_ENGRAVING}'s skull`,
    );
  });

  it("trims what was written, because a name is not its whitespace", () => {
    expect(engravedName(`${ENGRAVING_TOKEN}'s skull`, " Green Fox ")).toBe(
      "Green Fox's skull",
    );
  });

  /** The property every other tile in the world depends on. */
  it("hands back a name with no hole in it untouched", () => {
    expect(engravedName("Rusty Sword", "Green Fox")).toBe("Rusty Sword");
    expect(isEngravable("Rusty Sword")).toBe(false);
  });

  it("fills every hole, so a name may say it twice", () => {
    expect(
      engravedName(`${ENGRAVING_TOKEN}, by ${ENGRAVING_TOKEN}`, "Green Fox"),
    ).toBe("Green Fox, by Green Fox");
  });
});

describe("the shipped skull", () => {
  const tiles = normalizeTiles(tilesJson);
  const skull = tiles.find((def) => def.id === "skull-player")!;

  it("is named with a hole for whoever it was", () => {
    expect(isEngravable(skull.name)).toBe(true);
  });

  /**
   * A pile is several of one thing that cannot be told apart afterwards, which
   * is the one thing a skull must never be: two of them are two people.
   */
  it("does not pile", () => {
    expect(pileMax(skull)).toBe(1);
  });
});
