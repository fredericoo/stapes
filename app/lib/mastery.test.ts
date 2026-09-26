import { describe, expect, it } from "vitest";
import {
  BENEATH_YOU_EXPONENT,
  spellElements,
  experienceMultiplier,
  masteryMultiplier,
  standingIn,
  MAX_MASTERY,
  MAX_XP_MULTIPLIER,
  MIN_RATING,
  masteriesFromXp,
  meetsRequirements,
  requirementCoverage,
  requirementShare,
  NOTHING_BELOW_RATIO,
  rating,
  REQUIREMENTS_MET,
  levelForXp,
  progressToNextLevel,
  xpForLevel,
  xpFromMasteries,
} from "./mastery";

describe("requirementCoverage", () => {
  it("agrees with the capped share right up to the requirement", () => {
    const asks = { arcane: 8, fire: 2 };
    expect(requirementCoverage({ arcane: 8, fire: 2 }, asks)).toBe(REQUIREMENTS_MET);
    expect(requirementCoverage({ arcane: 4, fire: 1 }, asks)).toBe(0.5);
  });

  it("counts the surplus, where the capped share throws it away", () => {
    const asks = { arcane: 8, fire: 2 };
    expect(requirementShare({ arcane: 16, fire: 4 }, asks)).toBe(REQUIREMENTS_MET);
    expect(requirementCoverage({ arcane: 16, fire: 4 }, asks)).toBe(2);
  });

  it("pools the surplus across the block", () => {
    expect(requirementCoverage({ arcane: 11, fire: 2 }, { arcane: 8, fire: 2 })).toBeCloseTo(1.3);
  });

  it("is fully met by a stone that asks nothing, however good the caster", () => {
    expect(requirementCoverage({ arcane: 100 }, undefined)).toBe(REQUIREMENTS_MET);
    expect(requirementCoverage({ arcane: 100 }, {})).toBe(REQUIREMENTS_MET);
  });
});

describe("meetsRequirements", () => {
  it("asks nothing of a stone with no block", () => {
    expect(meetsRequirements({}, undefined)).toBe(true);
  });

  it("holds every named mastery, trained or not", () => {
    const asks = { arcane: 10, toughness: 5 };
    expect(meetsRequirements({ arcane: 10 }, asks)).toBe(false);
    expect(meetsRequirements({ arcane: 10, toughness: 5 }, asks)).toBe(true);
  });
});

describe("requirementShare", () => {
  it("is fully met when a weapon asks nothing", () => {
    expect(requirementShare({ sharp: 0 }, undefined)).toBe(REQUIREMENTS_MET);
    expect(requirementShare({ sharp: 50 }, {})).toBe(REQUIREMENTS_MET);
  });

  it("ignores a requirement of zero rather than counting it", () => {
    expect(requirementShare({ sharp: 10 }, { sharp: 0, blunt: 0 })).toBe(REQUIREMENTS_MET);
    expect(requirementShare({ sharp: 10, blunt: 10 }, { sharp: 0, blunt: 20 })).toBe(0.5);
  });

  it("is one when the wielder exactly meets what is asked", () => {
    expect(requirementShare({ blunt: 35 }, { blunt: 35 })).toBe(1);
  });

  it("pools every requirement rather than taking the worst", () => {
    const wielder = { blunt: 35, toughness: 10 };
    expect(requirementShare(wielder, { blunt: 35, toughness: 20 })).toBeCloseTo(45 / 55, 10);
  });

  it("never lets a surplus in one mastery cover a shortfall in another", () => {
    expect(
      requirementShare({ blunt: 100, toughness: 0 }, { blunt: 35, toughness: 20 }),
    ).toBeCloseTo(35 / 55, 10);
  });

  it("counts a mastery the wielder has never trained as nothing", () => {
    expect(requirementShare({ sharp: 40 }, { arcane: 20 })).toBe(0);
  });

  it("stops at fully met however far past it the wielder is", () => {
    expect(requirementShare({ blunt: 100 }, { blunt: 1 })).toBe(REQUIREMENTS_MET);
    expect(requirementShare({ blunt: 100 }, { blunt: 35 })).toBe(REQUIREMENTS_MET);
  });

  it("never goes below zero", () => {
    expect(requirementShare({}, { sharp: 30 })).toBe(0);
  });
});

describe("what a mastery is weighed against", () => {
  const veteran = { blunt: 80, sharp: 5, toughness: 40, agility: 40 };

  it("weighs a weapon mastery against itself", () => {
    expect(standingIn(veteran, "sharp")).toBe(5);
    expect(standingIn(veteran, "blunt")).toBe(80);
  });

  it("weighs an element against itself, on the same terms", () => {
    expect(standingIn({ ...veteran, fire: 3 }, "fire")).toBe(3);
  });

  it("weighs the two body masteries against the whole body", () => {
    expect(standingIn(veteran, "toughness")).toBe(rating(veteran));
    expect(standingIn(veteran, "agility")).toBe(rating(veteran));
  });

  it("makes a rat worth fighting for the mastery that is a novice's", () => {
    const rat = 8;
    expect(masteryMultiplier(rat, veteran, "sharp")).toBeGreaterThan(1);
    expect(masteryMultiplier(rat, veteran, "blunt")).toBe(0);
    expect(masteryMultiplier(rat, veteran, "agility")).toBe(0);
  });

  it("stops paying once the mastery has outgrown the creature", () => {
    expect(masteryMultiplier(8, { ...veteran, sharp: 20 }, "sharp")).toBeGreaterThan(0);
    expect(masteryMultiplier(8, { ...veteran, sharp: 25 }, "sharp")).toBe(0);
  });
});

describe("the experience curve", () => {
  it("reads back exactly the level it was seeded from", () => {
    for (const level of [0, 1, 5, 40, 99, MAX_MASTERY]) {
      expect(levelForXp(xpForLevel(level))).toBe(level);
    }
  });

  it("holds the level until the next point is paid for in full", () => {
    const level = 7;
    const nextPoint = xpForLevel(level + 1);
    expect(levelForXp(nextPoint - 1)).toBe(level);
    expect(levelForXp(nextPoint)).toBe(level + 1);
  });

  it("makes every point dearer than the one before", () => {
    for (let level = 1; level < 20; level++) {
      const thisPoint = xpForLevel(level) - xpForLevel(level - 1);
      const nextPoint = xpForLevel(level + 1) - xpForLevel(level);
      expect(nextPoint).toBeGreaterThan(thisPoint);
    }
  });

  it("stops at the top of the scale", () => {
    expect(levelForXp(xpForLevel(MAX_MASTERY) * 100)).toBe(MAX_MASTERY);
  });

  it("survives a round trip through a whole block", () => {
    const masteries = { sharp: 12, toughness: 8, agility: 16 };
    expect(masteriesFromXp(xpFromMasteries(masteries))).toEqual(masteries);
  });

  it("writes nothing down for a mastery nobody has trained", () => {
    expect(xpFromMasteries({ sharp: 0 })).toEqual({});
    expect(masteriesFromXp({ sharp: 0, blunt: 1 })).toEqual({});
  });
});

describe("rating", () => {
  it("rates a body that is 40 at everything at 40", () => {
    const even = Object.fromEntries(
      ["fist", "sharp", "blunt", "ranged", "arcane", "toughness", "agility"].map((mastery) => [
        mastery,
        40,
      ]),
    );
    expect(rating(even)).toBe(40);
  });

  it("counts only the best weapon mastery, so a second one is free", () => {
    const swordsman = { sharp: 40, toughness: 10, agility: 10 };
    expect(rating({ ...swordsman, ranged: 30 })).toBe(rating(swordsman));
  });

  it("takes whichever weapon mastery is highest", () => {
    expect(rating({ sharp: 10, blunt: 40 })).toBe(rating({ sharp: 40, blunt: 10 }));
  });

  it("never rates anything below the floor", () => {
    expect(rating({})).toBe(MIN_RATING);
  });
});

describe("experienceMultiplier", () => {
  it("pays the plain rate against something exactly your equal", () => {
    expect(experienceMultiplier(20, 20)).toBe(1);
  });

  it("meets itself at parity from both sides", () => {
    const yours = 100;
    const justBelow = experienceMultiplier(yours - 0.001, yours);
    const justAbove = experienceMultiplier(yours + 0.001, yours);
    expect(justBelow).toBeCloseTo(1, 3);
    expect(justAbove).toBeCloseTo(1, 3);
  });

  it("pays nothing at all beneath the cliff", () => {
    expect(experienceMultiplier(NOTHING_BELOW_RATIO * 20 - 0.001, 20)).toBe(0);
  });

  it("gives up a figure too small to read as a number", () => {
    expect(NOTHING_BELOW_RATIO ** BENEATH_YOU_EXPONENT).toBeLessThan(0.005);
  });

  it("falls away steeply for anything beneath you", () => {
    expect(experienceMultiplier(14, 20)).toBeLessThan(0.2);
    expect(experienceMultiplier(18, 20)).toBeLessThan(0.7);
  });

  it("does not collapse a starter target when your Rating rounds up", () => {
    const before = experienceMultiplier(8, 9);
    const after = experienceMultiplier(8, 10);
    expect(after).toBeGreaterThan(before / 2);
  });

  it("rises for anything above you and then stops", () => {
    expect(experienceMultiplier(24, 20)).toBeGreaterThan(1);
    expect(experienceMultiplier(200, 20)).toBe(MAX_XP_MULTIPLIER);
  });

  it("rises with the gap all the way to the cap", () => {
    let previous = 0;
    for (let theirs = 10; theirs <= 28; theirs++) {
      const paid = experienceMultiplier(theirs, 20);
      expect(paid).toBeGreaterThanOrEqual(previous);
      previous = paid;
    }
  });
});

describe("progressToNextLevel", () => {
  it("is nothing at all at a level exactly reached", () => {
    expect(progressToNextLevel(xpForLevel(9))).toBe(0);
  });

  it("is halfway at halfway", () => {
    const here = xpForLevel(9);
    const next = xpForLevel(10);
    expect(progressToNextLevel((here + next) / 2)).toBeCloseTo(0.5, 10);
  });

  it("climbs the whole way and resets on arrival", () => {
    const next = xpForLevel(10);
    expect(progressToNextLevel(next - 1)).toBeGreaterThan(0.9);
    expect(progressToNextLevel(next)).toBe(0);
  });

  it("is nothing at the top of the scale, however much is banked", () => {
    expect(progressToNextLevel(xpForLevel(MAX_MASTERY) * 10)).toBe(0);
  });
});

describe("spellElements", () => {
  it("is empty for a spell that asks for no element", () => {
    expect(spellElements(undefined)).toEqual([]);
    expect(spellElements({ arcane: 10 })).toEqual([]);
  });

  it("names every element the requirements name, however small", () => {
    expect(spellElements({ arcane: 2, fire: 1 })).toEqual(["fire"]);
    expect(spellElements({ arcane: 15, water: 8, nature: 8 })).toEqual(["water", "nature"]);
  });

  it("ignores an element written as nothing, exactly as every requirement does", () => {
    expect(spellElements({ fire: 0, water: 3 })).toEqual(["water"]);
  });
});
