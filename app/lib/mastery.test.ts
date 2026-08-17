import { describe, expect, it } from "vitest";
import {
  BENEATH_YOU_EXPONENT,
  experienceMultiplier,
  learningRate,
  MAX_MASTERY,
  MAX_MASTERY_RATIO,
  MAX_XP_MULTIPLIER,
  MIN_RATING,
  masteriesFromXp,
  masteryRatio,
  NOTHING_BELOW_RATIO,
  rating,
  trainingCeiling,
  UNREQUIRED_RATIO,
  levelForXp,
  progressToNextLevel,
  xpForLevel,
  xpFromMasteries,
} from "./mastery";

/**
 * How well a body meets what a weapon asks of it.
 *
 * One number, and almost every rule in the mastery design hangs off it — hit
 * chance, speed, damage, and in the phase after this the point at which a weapon
 * stops teaching you anything. It is also the kind of arithmetic that is quietly
 * wrong for months: it returns a plausible fraction whatever it does.
 */

describe("masteryRatio", () => {
  it("is neither a penalty nor a gift when a weapon asks nothing", () => {
    expect(masteryRatio({ blade: 0 }, undefined)).toBe(UNREQUIRED_RATIO);
    expect(masteryRatio({ blade: 50 }, {})).toBe(UNREQUIRED_RATIO);
  });

  /**
   * A requirement of zero reads as absent, on the same terms an unwritten
   * mastery reads as zero. Otherwise a block that had been through the editor
   * and back would divide by it.
   */
  it("ignores a requirement of zero rather than dividing by it", () => {
    expect(masteryRatio({ blade: 10 }, { blade: 0, blunt: 0 })).toBe(
      UNREQUIRED_RATIO,
    );
    // Blade is asked for zero and so is not asked for at all; if it counted,
    // the division would be by zero and the worst ratio would be Infinity.
    expect(masteryRatio({ blade: 10, blunt: 10 }, { blade: 0, blunt: 20 })).toBe(
      0.5,
    );
  });

  it("is one when the wielder exactly meets what is asked", () => {
    expect(masteryRatio({ blunt: 35 }, { blunt: 35 })).toBe(1);
  });

  /**
   * **The worst ratio decides**, and this is the rule most likely to surprise:
   * a secondary requirement on a mastery the weapon does not even train can
   * halve the whole thing, and the player only feels it as the weapon not
   * working.
   */
  it("takes the worst ratio across every requirement", () => {
    const wielder = { blunt: 35, toughness: 10 };
    // Blunt alone would be 1; Toughness alone would be 0.5.
    expect(masteryRatio(wielder, { blunt: 35, toughness: 20 })).toBe(0.5);
  });

  it("counts a mastery the wielder has never trained as nothing", () => {
    expect(masteryRatio({ blade: 40 }, { arcane: 20 })).toBe(0);
  });

  /**
   * The performance ceiling. Without it, a hero who had outgrown everything
   * could pick up the weakest weapon in the world and swing it like a god —
   * which is exactly the twinking the training ceiling exists to prevent, coming
   * back in through the other door.
   */
  it("caps however far past the requirement the wielder is", () => {
    expect(masteryRatio({ blunt: 100 }, { blunt: 1 })).toBe(MAX_MASTERY_RATIO);
    expect(masteryRatio({ blunt: 100 }, { blunt: 35 })).toBe(MAX_MASTERY_RATIO);
  });

  it("never goes below zero", () => {
    expect(masteryRatio({}, { blade: 30 })).toBe(0);
  });
});

/**
 * A weapon you have outgrown keeps teaching you, badly.
 *
 * This replaced a hard wall, and the reason is worth keeping in front of
 * whoever changes it next: the wall deadlocked in the other direction. A weapon
 * asking anything of a mastery you had none of could never teach that mastery,
 * because you could never land a blow with it — so there was no route from Blade
 * 0 to Blade 1 anywhere in the game.
 */
describe("learningRate", () => {
  it("is full rate all the way to the ceiling", () => {
    expect(learningRate(0, 40)).toBe(1);
    expect(learningRate(40, 40)).toBe(1);
    expect(learningRate(trainingCeiling(40), 40)).toBe(1);
  });

  it("halves for each doubling past the ceiling", () => {
    const requirement = 40;
    const ceiling = requirement * MAX_MASTERY_RATIO;
    expect(learningRate(ceiling * 2, requirement)).toBeCloseTo(0.5, 10);
    expect(learningRate(ceiling * 4, requirement)).toBeCloseTo(0.25, 10);
  });

  it("never reaches nothing, however far outgrown", () => {
    expect(learningRate(100, 1)).toBeGreaterThan(0);
  });

  /**
   * What gets a mastery off zero. A weapon that asks nothing has no ceiling to
   * fall off, so it teaches at full rate forever — absurd at the top end, and
   * the only way in at the bottom.
   */
  it("never fades for a weapon that asks nothing", () => {
    expect(learningRate(0, 0)).toBe(1);
    expect(learningRate(100, 0)).toBe(1);
  });

  /**
   * A weapon far *above* you is not discounted here, and must not be: you
   * already earn less from it by landing fewer blows. Charging twice for the
   * same difficulty is exactly what made the old wall a deadlock.
   */
  it("does not also discount a weapon that outclasses the wielder", () => {
    expect(learningRate(1, 90)).toBe(1);
  });
});

describe("trainingCeiling", () => {
  /** The worked example from the design, kept honest. */
  it("takes a Double Axe's Blunt 35 to 43", () => {
    expect(trainingCeiling(35)).toBe(43);
  });

  it("floors rather than rounding, since a mastery is a whole number", () => {
    // 10 × 1.25 is 12.5, and half a level is not a thing.
    expect(trainingCeiling(10)).toBe(12);
  });

  /**
   * The two ceilings are the same number on purpose: a weapon you have outgrown
   * is exactly a weapon that has stopped teaching you.
   */
  it("agrees with the performance cap", () => {
    const requirement = 40;
    expect(trainingCeiling(requirement)).toBe(
      Math.floor(requirement * MAX_MASTERY_RATIO),
    );
    expect(
      masteryRatio({ blunt: trainingCeiling(requirement) }, { blunt: requirement }),
    ).toBe(MAX_MASTERY_RATIO);
  });
});

/**
 * Experience, and the level read out of it.
 *
 * The pair has to round-trip exactly, because seeding is what a new player is:
 * the authored block becomes experience and the level is read straight back out
 * of it, and any drift there is a player who starts one point below what the
 * tile says.
 */
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

  /** Each point costs more than the last, which is the whole shape of it. */
  it("makes every point dearer than the one before", () => {
    for (let level = 1; level < 20; level++) {
      const thisPoint = xpForLevel(level) - xpForLevel(level - 1);
      const nextPoint = xpForLevel(level + 1) - xpForLevel(level);
      expect(nextPoint).toBeGreaterThan(thisPoint);
    }
  });

  /**
   * Spent rather than banked. Experience past the top of the scale buying an
   * invisible level would be a player wondering why nothing was happening.
   */
  it("stops at the top of the scale", () => {
    expect(levelForXp(xpForLevel(MAX_MASTERY) * 100)).toBe(MAX_MASTERY);
  });

  it("survives a round trip through a whole block", () => {
    const masteries = { blade: 12, toughness: 8, agility: 16 };
    expect(masteriesFromXp(xpFromMasteries(masteries))).toEqual(masteries);
  });

  /** Sparse in, sparse out — an untrained mastery is absent, not a zero. */
  it("writes nothing down for a mastery nobody has trained", () => {
    expect(xpFromMasteries({ blade: 0 })).toEqual({});
    expect(masteriesFromXp({ blade: 0, blunt: 1 })).toEqual({});
  });
});

describe("rating", () => {
  /** The weights sum to one, which is what puts ⭐ on the mastery scale. */
  it("rates a body that is 40 at everything at 40", () => {
    const even = Object.fromEntries(
      ["fist", "blade", "blunt", "ranged", "arcane", "toughness", "agility"].map(
        (mastery) => [mastery, 40],
      ),
    );
    expect(rating(even)).toBe(40);
  });

  /**
   * Breadth is free. A swordsman who takes up the bow is no harder to reward
   * for it, which is what stops hyper-specialisation being the only sane way to
   * play.
   */
  it("counts only the best weapon mastery, so a second one is free", () => {
    const swordsman = { blade: 40, toughness: 10, agility: 10 };
    expect(rating({ ...swordsman, ranged: 30 })).toBe(rating(swordsman));
  });

  it("takes whichever weapon mastery is highest", () => {
    expect(rating({ blade: 10, blunt: 40 })).toBe(rating({ blade: 40, blunt: 10 }));
  });

  /** Rating is a divisor, so nothing that fights is allowed to rate nothing. */
  it("never rates anything below the floor", () => {
    expect(rating({})).toBe(MIN_RATING);
  });
});

/**
 * What a fight is worth, by how far above or below you it is.
 *
 * The curve nobody can eyeball, and the one that decides whether the world has
 * anything worth fighting in it.
 */
describe("experienceMultiplier", () => {
  it("pays the plain rate against something exactly your equal", () => {
    expect(experienceMultiplier(20, 20)).toBe(1);
  });

  /** Continuous at parity: the two arms meet rather than step. */
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

  /**
   * The cliff is a cliff rather than a fade, and it lands where a payout would
   * have stopped reading as a payout — a fortieth of a percent.
   */
  it("gives up a figure too small to read as a number", () => {
    expect(NOTHING_BELOW_RATIO ** BENEATH_YOU_EXPONENT).toBeLessThan(0.005);
  });

  it("falls away steeply for anything beneath you", () => {
    expect(experienceMultiplier(14, 20)).toBeLessThan(0.1);
    expect(experienceMultiplier(18, 20)).toBeLessThan(0.5);
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

/**
 * The bar under a level.
 *
 * Worth its own arithmetic because it is the only part of a mastery a player
 * sees moving. A level changes a few times an hour; this changes on every landed
 * blow, and it is the whole of what makes ten minutes of fighting rats feel like
 * something rather than nothing.
 */
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

  /**
   * At the top there is no next point to be part of the way to, and a bar
   * creeping towards a level that cannot arrive is worse than no bar.
   */
  it("is nothing at the top of the scale, however much is banked", () => {
    expect(progressToNextLevel(xpForLevel(MAX_MASTERY) * 10)).toBe(0);
  });
});
