import { describe, expect, it } from "vitest";
import {
  DAMAGE_AT_ZERO_RATIO,
  DEFAULT_BATTLER,
  fightingStats,
  fleeFrom,
  hitChanceFrom,
  maxHpFrom,
  MAX_CHANCE,
  MIN_CHANCE,
  SPEED_AT_ZERO_RATIO,
} from "./battler";
import type { WeaponItem } from "./item";
import { MAX_MASTERY_RATIO } from "./mastery";

/**
 * A body plus what it is swinging, resolved into numbers.
 *
 * Every one of these is a curve, and a curve is the kind of thing that is
 * quietly wrong for months: it produces plausible numbers whatever it does, so
 * nothing about playing the game tells you the penalty stopped biting. These are
 * the claims the design makes, written where they can fail.
 */

/**
 * A weapon with round numbers, so a multiplier is legible in the result.
 *
 * Perfectly precise on purpose, which takes `acc` out of the hit chance and
 * leaves the mastery term alone in it — these tests are about what the *ratio*
 * does, and the weapon's own precision is covered above.
 */
function weapon(overrides: Partial<WeaponItem> = {}): WeaponItem {
  return {
    type: "weapon",
    damage: 100,
    def: 0,
    accuracy: 100,
    variance: 0,
    spd: 100,
    mastery: "blunt",
    ...overrides,
  };
}

function body(masteries: Record<string, number>) {
  return { ...DEFAULT_BATTLER, masteries };
}

describe("hit points and flee", () => {
  it("grow with the masteries they come from", () => {
    expect(maxHpFrom(0)).toBeLessThan(maxHpFrom(1));
    expect(fleeFrom(0)).toBeLessThan(fleeFrom(1));
  });

  /**
   * Neither floor is zero. A mastery of zero is a novice, not a corpse — and a
   * body has to survive long enough to train the thing.
   */
  it("leaves an untrained body something to start with", () => {
    expect(maxHpFrom(0)).toBeGreaterThan(0);
    expect(fleeFrom(0)).toBeGreaterThan(0);
  });

  /**
   * Evasion is deliberately unbounded, unlike every other percent stat: it is
   * one side of a contest rather than a probability, and the ceiling on the
   * outcome belongs to the chance band. Clamping here as well would put the
   * ceiling in two places and let the lower one win silently.
   */
  it("lets evasion run past the percent scale, since it is not a chance", () => {
    expect(fleeFrom(1000)).toBeGreaterThan(100);
  });
});

describe("hitChanceFrom", () => {
  it("is at its best when both halves are", () => {
    expect(hitChanceFrom(1, 100)).toBe(MAX_CHANCE);
    expect(hitChanceFrom(1, 50)).toBeCloseTo(0.5, 10);
    expect(hitChanceFrom(0, 100)).toBe(MIN_CHANCE);
  });

  /**
   * The floor is the whole reason a mastery can be started at all: experience
   * comes from landing blows, so a weapon that never lands can never teach the
   * mastery it asks for.
   */
  it("never drops to nothing however outclassed the wielder is", () => {
    expect(hitChanceFrom(0, 100)).toBe(MIN_CHANCE);
    expect(hitChanceFrom(0.0001, 100)).toBe(MIN_CHANCE);
  });

  /** Nothing is ever certain, so even a perfect swing can go wide. */
  it("never reaches certainty either", () => {
    expect(hitChanceFrom(5, 100)).toBe(MAX_CHANCE);
  });

  it("rises with mastery, and bites hardest low down", () => {
    const low = hitChanceFrom(0.3, 100) - hitChanceFrom(0, 100);
    const high = hitChanceFrom(1, 100) - hitChanceFrom(0.7, 100);
    // Squared, so the same step in q buys more the further up you already are.
    expect(high).toBeGreaterThan(low);
  });

  /**
   * The weapon's own precision, which mastery cannot make up for: a clumsy thing
   * whiffs in expert hands. This is what `acc` gained when it stopped being only
   * a damage band.
   */
  it("cannot be mastered past the weapon's own precision", () => {
    expect(hitChanceFrom(MAX_MASTERY_RATIO, 60)).toBeCloseTo(0.6, 10);
    expect(hitChanceFrom(5, 60)).toBeCloseTo(0.6, 10);
  });

  it("is as bad as it gets for a weapon with no precision", () => {
    expect(hitChanceFrom(1, 0)).toBe(MIN_CHANCE);
  });
});

describe("what the mastery ratio does to a weapon", () => {
  it("takes the profile at face value when nothing is asked", () => {
    const stats = fightingStats(body({ blunt: 0 }), weapon());
    expect(stats.damage).toBe(100);
    expect(stats.spd).toBe(100);
    expect(stats.hitChance).toBe(MAX_CHANCE);
  });

  /**
   * The character the whole system exists to produce: a novice with an oversized
   * axe rarely connects, and hits hard when they do. Speed and damage only sag —
   * which is why an unmastered weapon is still worth picking up, and the floor on
   * landing is why it can still teach.
   */
  it("makes a novice rarely land, but not feeble", () => {
    const stats = fightingStats(body({ blunt: 0 }), weapon({ requirements: { blunt: 40 } }));

    expect(stats.hitChance).toBe(MIN_CHANCE);
    // Rounded, because these are whole numbers a fight is fought in — and
    // `100 * 0.55` is not exactly 55 in binary floating point.
    expect(stats.damage).toBe(Math.round(100 * DAMAGE_AT_ZERO_RATIO));
    expect(stats.spd).toBe(Math.round(100 * SPEED_AT_ZERO_RATIO));
  });

  it("is exactly the authored profile at the requirement", () => {
    const stats = fightingStats(
      body({ blunt: 40 }),
      weapon({ requirements: { blunt: 40 } }),
    );
    expect(stats.damage).toBe(100);
    expect(stats.spd).toBe(100);
    expect(stats.hitChance).toBe(MAX_CHANCE);
  });

  it("pays a master in speed and damage, since landing is already certain", () => {
    const mastered = fightingStats(
      body({ blunt: 100 }),
      weapon({ damage: 100, spd: 50, requirements: { blunt: 40 } }),
    );
    const met = fightingStats(
      body({ blunt: 40 }),
      weapon({ damage: 100, spd: 50, requirements: { blunt: 40 } }),
    );

    expect(mastered.damage).toBeGreaterThan(met.damage);
    expect(mastered.spd).toBeGreaterThan(met.spd);
    expect(mastered.hitChance).toBe(met.hitChance);
  });

  /**
   * The ratio *reads* accuracy — it is half of the hit chance — but never scales
   * it. Accuracy is the weapon's own, and mastery does not sharpen the blade;
   * what mastery changes is whether you can point it, which the hit chance
   * already says. Scaling the stored value too would charge twice, and it is
   * also what a defender's evasion is contested against.
   */
  it("passes the weapon's accuracy through unscaled", () => {
    for (const blunt of [0, 20, 40, 100]) {
      const stats = fightingStats(
        body({ blunt }),
        weapon({ accuracy: 73, requirements: { blunt: 40 } }),
      );
      expect(stats.accuracy).toBe(73);
    }
  });

  /** Both halves multiply: a clumsy weapon caps what mastery can buy. */
  it("multiplies the wielder's control by the weapon's precision", () => {
    const stats = fightingStats(
      body({ blunt: 40 }),
      weapon({ accuracy: 50, requirements: { blunt: 40 } }),
    );
    expect(stats.hitChance).toBeCloseTo(0.5, 10);
  });

  /** `attackIntervalMs` reads speed as a position on a curve, not a free number. */
  it("holds speed inside the scale even for a master of a fast weapon", () => {
    const stats = fightingStats(
      body({ blunt: 100 }),
      weapon({ spd: 100, requirements: { blunt: 1 } }),
    );
    expect(stats.spd).toBeLessThanOrEqual(100);
  });

  it("leaves hit points and flee alone whatever is held", () => {
    const masteries = { toughness: 30, agility: 12, blunt: 0 };
    const bare = fightingStats(body(masteries), weapon());
    const gated = fightingStats(
      body(masteries),
      weapon({ requirements: { blunt: 90 } }),
    );

    expect(bare.maxHp).toBe(maxHpFrom(30));
    expect(gated.maxHp).toBe(bare.maxHp);
    expect(gated.flee).toBe(bare.flee);
  });

  /** The surprising rule, end to end: a gate on a mastery the weapon never trains. */
  it("is held back by a requirement the weapon does not train", () => {
    const stats = fightingStats(
      body({ blunt: 35, toughness: 10 }),
      weapon({ requirements: { blunt: 35, toughness: 20 } }),
    );
    // Toughness is the worse half at 0.5, so the control term is
    // 0.35 + 0.65 × 0.25 rather than a full 1.
    // q = 0.5 → control = 0.25, times a perfect weapon's precision.
    expect(stats.hitChance).toBeCloseTo(0.25, 10);
    expect(stats.hitChance).toBeLessThan(MAX_CHANCE);
  });
});
