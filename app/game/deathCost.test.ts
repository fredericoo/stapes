import { describe, expect, it } from "vitest";
import { xpForLevel } from "../lib/mastery";
import { deathCost } from "./deathCost";
import { experienceAfterDeath } from "./experience";

describe("deathCost", () => {
  it("names each mastery that fell a level, and where it went", () => {
    const cost = deathCost(
      { sharp: xpForLevel(10), agility: xpForLevel(5), arcane: xpForLevel(5) },
      { sharp: xpForLevel(9), agility: xpForLevel(5), arcane: xpForLevel(5) },
      true,
    );

    expect(cost).toEqual({ bagLeft: true, levelsLost: [{ mastery: "sharp", from: 10, to: 9 }] });
  });
});

describe("experienceAfterDeath", () => {
  it("takes a tenth of every mastery's whole experience, not of the level's progress", () => {
    expect(experienceAfterDeath({ sharp: xpForLevel(20) })).toEqual({
      sharp: xpForLevel(20) * 0.9,
    });
  });

  it("lets a mastery fall all the way to level 1", () => {
    const cost = deathCost(
      { fist: xpForLevel(2) },
      experienceAfterDeath({ fist: xpForLevel(2) }),
      false,
    );
    expect(cost.levelsLost).toEqual([{ mastery: "fist", from: 2, to: 1 }]);
  });
});
