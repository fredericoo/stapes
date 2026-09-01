import { describe, expect, it } from "vitest";
import {
  BENEATH_YOU_EXPONENT,
  spellElements,
  experienceMultiplier,
  learningRate,
  MAX_MASTERY,
  MAX_XP_MULTIPLIER,
  MIN_RATING,
  masteriesFromXp,
  requirementShare,
  NOTHING_BELOW_RATIO,
  rating,
  OUTGROWN_FALLOFF,
  REQUIREMENTS_MET,
  levelForXp,
  progressToNextLevel,
  xpForLevel,
  xpFromMasteries,
} from "./mastery";

/**
 * How much of what a weapon asks a body actually brings.
 *
 * One number, and what a weapon is worth in the hand hangs off it — damage,
 * accuracy and speed all fall on it together. It is also the kind of arithmetic
 * that is quietly wrong for months: it returns a plausible fraction whatever it
 * does.
 */

describe("requirementShare", () => {
  it("is fully met when a weapon asks nothing", () => {
    expect(requirementShare({ blade: 0 }, undefined)).toBe(REQUIREMENTS_MET);
    expect(requirementShare({ blade: 50 }, {})).toBe(REQUIREMENTS_MET);
  });

  /**
   * A requirement of zero reads as absent, on the same terms an unwritten
   * mastery reads as zero. Otherwise a block that had been through the editor
   * and back would count a requirement nobody wrote.
   */
  it("ignores a requirement of zero rather than counting it", () => {
    expect(requirementShare({ blade: 10 }, { blade: 0, blunt: 0 })).toBe(
      REQUIREMENTS_MET,
    );
    expect(
      requirementShare({ blade: 10, blunt: 10 }, { blade: 0, blunt: 20 }),
    ).toBe(0.5);
  });

  it("is one when the wielder exactly meets what is asked", () => {
    expect(requirementShare({ blunt: 35 }, { blunt: 35 })).toBe(1);
  });

  /**
   * **Pooled, not weakest-link.** Every point asked for counts once, wherever it
   * was asked, so partial progress towards a second requirement is visible
   * rather than invisible until it is complete. Under the rule this replaced,
   * being one point short of a secondary requirement halved the weapon outright.
   */
  it("pools every requirement rather than taking the worst", () => {
    const wielder = { blunt: 35, toughness: 10 };
    // 35 of 35 Blunt and 10 of 20 Toughness: 45 of the 55 points asked.
    expect(requirementShare(wielder, { blunt: 35, toughness: 20 })).toBeCloseTo(
      45 / 55,
      10,
    );
  });

  /**
   * **A surplus never carries.** The cap is what keeps each requirement
   * genuinely required: a brute with enormous Blunt and no Toughness must not be
   * able to muscle past the half of a weapon that is about being able to hold
   * it.
   */
  it("never lets a surplus in one mastery cover a shortfall in another", () => {
    expect(
      requirementShare({ blunt: 100, toughness: 0 }, { blunt: 35, toughness: 20 }),
    ).toBeCloseTo(35 / 55, 10);
  });

  it("counts a mastery the wielder has never trained as nothing", () => {
    expect(requirementShare({ blade: 40 }, { arcane: 20 })).toBe(0);
  });

  /**
   * **A gate, not a scale.** However far past the requirement a wielder is, a
   * met requirement is met and nothing further is owed here — being good with a
   * weapon is paid by `../lib/battler`, against the absolute mastery rather than
   * against the requirement.
   */
  it("stops at fully met however far past it the wielder is", () => {
    expect(requirementShare({ blunt: 100 }, { blunt: 1 })).toBe(REQUIREMENTS_MET);
    expect(requirementShare({ blunt: 100 }, { blunt: 35 })).toBe(REQUIREMENTS_MET);
  });

  it("never goes below zero", () => {
    expect(requirementShare({}, { blade: 30 })).toBe(0);
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
  it("pays in full anywhere at or below what the weapon asks", () => {
    expect(learningRate(0, 40)).toBe(1);
    expect(learningRate(20, 40)).toBe(1);
    expect(learningRate(40, 40)).toBe(1);
  });

  /**
   * **The cap is the important half.** Below the requirement the ratio is
   * greater than one, and paying a bonus for swinging something you cannot use
   * would be exactly backwards — you are already earning less there, because
   * experience is counted in damage and an unready weapon barely does any.
   */
  it("never pays more than full, however far beneath the weapon the wielder is", () => {
    expect(learningRate(1, 90)).toBe(1);
    expect(learningRate(0, 90)).toBe(1);
  });

  /**
   * The whole point of the sixth power: standing still with one weapon stops
   * being worth it almost immediately, so climbing means picking up the next
   * one rather than swinging this one for longer.
   */
  it("falls away steeply the moment the requirement is passed", () => {
    expect(learningRate(48, 40)).toBeCloseTo((40 / 48) ** OUTGROWN_FALLOFF, 10);
    expect(learningRate(48, 40)).toBeLessThan(0.4);
    expect(learningRate(80, 40)).toBeLessThan(0.02);
  });

  it("keeps falling rather than stopping", () => {
    // Never a wall: a wall here is what deadlocked the design once already.
    expect(learningRate(100, 1)).toBeGreaterThan(0);
    expect(learningRate(100, 40)).toBeGreaterThan(0);
  });

  it("teaches forever at full rate when the weapon asks nothing", () => {
    expect(learningRate(0, 0)).toBe(1);
    expect(learningRate(100, 0)).toBe(1);
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

  /**
   * Steep, but no longer a trapdoor. The thresholds moved with
   * `BENEATH_YOU_EXPONENT` going 8 → 5: something at 70% of your Rating pays a
   * sixth rather than a sixteenth, which is what keeps the first safe target a
   * player finds worth more than a single point of progress.
   */
  it("falls away steeply for anything beneath you", () => {
    expect(experienceMultiplier(14, 20)).toBeLessThan(0.2);
    expect(experienceMultiplier(18, 20)).toBeLessThan(0.7);
  });

  /**
   * The reason the exponent was softened rather than the cliff moved: a rounded
   * Rating ticking over used to more than halve what a starter target was worth,
   * which reads as a punishment for levelling up.
   */
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

/**
 * Which elements a spell is made of.
 *
 * The casting side, and the only side masteries have an opinion about: what a
 * body counts as when a spell lands on it is authored rather than practised —
 * see `../game/equipment`'s `bodyElements`, which is tested beside the squares
 * it walks.
 */
describe("spellElements", () => {
  it("is empty for a spell that asks for no element", () => {
    expect(spellElements(undefined)).toEqual([]);
    expect(spellElements({ arcane: 10 })).toEqual([]);
  });

  it("names every element the requirements name, however small", () => {
    expect(spellElements({ arcane: 2, fire: 1 })).toEqual(["fire"]);
    expect(spellElements({ arcane: 15, water: 8, nature: 8 })).toEqual([
      "water",
      "nature",
    ]);
  });

  it("ignores an element written as nothing, exactly as every requirement does", () => {
    expect(spellElements({ fire: 0, water: 3 })).toEqual(["water"]);
  });
});
