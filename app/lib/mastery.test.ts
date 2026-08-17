import { describe, expect, it } from "vitest";
import {
  learningRate,
  MAX_MASTERY_RATIO,
  masteryRatio,
  trainingCeiling,
  UNREQUIRED_RATIO,
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
