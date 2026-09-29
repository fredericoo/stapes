import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import { normalizeTiles } from "./types";
import { resolveBattler } from "./battler";
import { pileMax } from "./item";
import { ENGRAVING_TOKEN, UNKNOWN_ENGRAVING, engravedName, isEngravable } from "./engraving";

describe("engravedName", () => {
  it("puts the engraving where the token is", () => {
    expect(engravedName(`${ENGRAVING_TOKEN}'s skull`, "Green Fox")).toBe("Green Fox's skull");
  });

  it("fills the hole with somebody when nobody wrote in it", () => {
    expect(engravedName(`${ENGRAVING_TOKEN}'s skull`)).toBe(`${UNKNOWN_ENGRAVING}'s skull`);
    expect(engravedName(`${ENGRAVING_TOKEN}'s skull`, "   ")).toBe(`${UNKNOWN_ENGRAVING}'s skull`);
  });

  it("trims what was written, because a name is not its whitespace", () => {
    expect(engravedName(`${ENGRAVING_TOKEN}'s skull`, " Green Fox ")).toBe("Green Fox's skull");
  });

  it("hands back a name with no hole in it untouched", () => {
    expect(engravedName("Rusty Sword", "Green Fox")).toBe("Rusty Sword");
    expect(isEngravable("Rusty Sword")).toBe(false);
  });

  it("fills every hole, so a name may say it twice", () => {
    expect(engravedName(`${ENGRAVING_TOKEN}, by ${ENGRAVING_TOKEN}`, "Green Fox")).toBe(
      "Green Fox, by Green Fox",
    );
  });
});

describe("the shipped skull", () => {
  const tiles = normalizeTiles(tilesJson);
  const skull = tiles.find((def) => def.id === "skull-player")!;

  it("is named with a hole for whoever it was", () => {
    expect(isEngravable(skull.name)).toBe(true);
  });

  it("is what the player is authored to leave, and it exists", () => {
    const byId = new Map(tiles.map((def) => [def.id, def]));
    for (const id of ["player", "cave-troll"]) {
      const remains = resolveBattler(byId.get(id)!)?.remains;
      expect(remains).toBeTruthy();
      expect(byId.get(remains!)).toBeDefined();
    }
  });

  it("does not pile", () => {
    expect(pileMax(skull)).toBe(1);
  });
});
