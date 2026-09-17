import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import { normalizeTiles } from "./types";
import { resolveBattler } from "./battler";
import { pileMax } from "./item";
import {
  ENGRAVING_TOKEN,
  UNKNOWN_ENGRAVING,
  engravedName,
  isEngravable,
} from "./engraving";

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
   * What a body leaves is authored ({@link BattlerDef.remains} in
   * `./battler`), so the whole feature is one field in `data/tiles.json` and
   * nothing in the engine would notice it going. A tile id naming nothing
   * leaves nothing, silently and by design.
   */
  it("is what the player is authored to leave, and it exists", () => {
    const byId = new Map(tiles.map((def) => [def.id, def]));
    for (const id of ["player", "cave-troll"]) {
      const remains = resolveBattler(byId.get(id)!)?.remains;
      expect(remains).toBeTruthy();
      expect(byId.get(remains!)).toBeDefined();
    }
  });

  /**
   * A pile is several of one thing that cannot be told apart afterwards, which
   * is the one thing a skull must never be: two of them are two people.
   */
  it("does not pile", () => {
    expect(pileMax(skull)).toBe(1);
  });
});
