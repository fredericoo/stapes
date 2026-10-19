import { describe, expect, it } from "vitest";
import { xpForLevel } from "../lib/mastery";
import { deathCost } from "./deathCost";

describe("deathCost", () => {
  it("names each mastery the life had above the next one's, and where it goes", () => {
    const cost = deathCost(
      { sharp: xpForLevel(10), agility: xpForLevel(5), arcane: xpForLevel(5) },
      { arcane: xpForLevel(5) },
    );

    expect(cost.levelsLost).toEqual([
      { mastery: "sharp", from: 10, to: 1 },
      { mastery: "agility", from: 5, to: 1 },
    ]);
  });
});
