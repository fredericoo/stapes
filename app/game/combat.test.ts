import { describe, expect, it } from "vitest";
import type { BattlerDef } from "../lib/battler";
import { DEFAULT_BATTLER } from "../lib/battler";
import {
  ATTACK_RANGE_CELLS,
  MAX_ATTACK_TICKS,
  MIN_ATTACK_TICKS,
  attackIntervalMs,
  damageFraction,
  dodgeChance,
  inAttackRange,
  rollAttack,
} from "./combat";
import { SIGHT_LEVEL_SLACK, TICK_MS } from "./constants";
import { Rng } from "./rng";

/**
 * The arithmetic of a blow, asserted rather than eyeballed.
 *
 * A damage curve is the kind of thing that is quietly wrong for months: it
 * produces plausible numbers whatever it does, so nothing about playing the game
 * tells you the peak drifted or that accuracy stopped mattering. These are the
 * claims the design actually makes, written down where they can fail.
 */

function battler(overrides: Partial<BattlerDef> = {}): BattlerDef {
  return { ...DEFAULT_BATTLER, ...overrides };
}

describe("attack speed", () => {
  it("hits both ends of the band exactly", () => {
    expect(attackIntervalMs(100)).toBe(MIN_ATTACK_TICKS * TICK_MS);
    expect(attackIntervalMs(0)).toBe(MAX_ATTACK_TICKS * TICK_MS);
  });

  it("never gets slower as speed goes up", () => {
    for (let spd = 1; spd <= 100; spd++) {
      expect(attackIntervalMs(spd)).toBeLessThanOrEqual(
        attackIntervalMs(spd - 1),
      );
    }
  });

  /**
   * The whole reason the curve is geometric. On a straight line 50 speed would
   * be ~101 ticks — indistinguishable from 0 to anybody watching — and the stat
   * would be worthless for its entire lower half.
   */
  it("makes a merely decent speed genuinely decent", () => {
    const halfway = attackIntervalMs(50);
    const linear = ((MIN_ATTACK_TICKS + MAX_ATTACK_TICKS) / 2) * TICK_MS;
    expect(halfway).toBeLessThan(linear / 4);
    // The geometric mean of the two bounds, which is what "halfway along a
    // curve" means — and stays true whatever the bounds are scaled to.
    expect(halfway / TICK_MS).toBe(
      Math.round(Math.sqrt(MIN_ATTACK_TICKS * MAX_ATTACK_TICKS)),
    );
  });

  it("clamps a stat somebody hand-edited out of range", () => {
    expect(attackIntervalMs(-50)).toBe(attackIntervalMs(0));
    expect(attackIntervalMs(500)).toBe(attackIntervalMs(100));
  });
});

describe("the damage band", () => {
  it("is a single point at full accuracy", () => {
    for (const roll of [[0, 0], [0.5, 0.5], [1, 1]] as const) {
      expect(damageFraction(100, [...roll])).toBe(1);
    }
  });

  /**
   * Accuracy drags the *floor* down and leaves the ceiling where it is. That is
   * what "atk is the most a blow can do" means: an inaccurate creature is not
   * one that occasionally exceeds its attack, it is one that often falls short.
   */
  it("always tops out at full damage, whatever the accuracy", () => {
    for (const acc of [0, 25, 50, 75]) {
      expect(damageFraction(acc, [1, 1])).toBeCloseTo(1, 10);
    }
  });

  it("opens the floor as accuracy falls", () => {
    expect(damageFraction(0, [0, 0])).toBeCloseTo(0, 10);
    expect(damageFraction(50, [0, 0])).toBeCloseTo(0.5, 10);
    expect(damageFraction(80, [0, 0])).toBeCloseTo(0.8, 10);
  });

  it("puts the middle of the band at the middle of the roll", () => {
    expect(damageFraction(0, [0.5, 0.5])).toBeCloseTo(0.5, 10);
    expect(damageFraction(50, [0.5, 0.5])).toBeCloseTo(0.75, 10);
  });

  /**
   * The hump. Both tails have to be rarer than the middle — a flat roll would
   * make a shattering blow exactly as likely as a glancing one, which reads as
   * noise rather than as a fight.
   *
   * Bucketed over a seeded stream, so this is a claim about the distribution and
   * not about one lucky draw.
   */
  it("is common in the middle and rare at both ends", () => {
    const rng = new Rng(12345);
    const buckets = [0, 0, 0];
    for (let i = 0; i < 30_000; i++) {
      const f = damageFraction(0, [rng.next(), rng.next()]);
      buckets[f < 1 / 3 ? 0 : f < 2 / 3 ? 1 : 2]!++;
    }
    expect(buckets[1]!).toBeGreaterThan(buckets[0]! * 1.5);
    expect(buckets[1]!).toBeGreaterThan(buckets[2]! * 1.5);
    // And symmetric, which is what makes the peak the *middle* rather than a
    // lean somebody would have to compensate for when authoring atk.
    expect(Math.abs(buckets[0]! - buckets[2]!)).toBeLessThan(buckets[1]! * 0.1);
  });
});

describe("dodging", () => {
  it("reads flee against half the attacker's accuracy", () => {
    expect(dodgeChance(50, 50)).toBeCloseTo(0.25, 10);
    expect(dodgeChance(60, 40)).toBeCloseTo(0.4, 10);
  });

  it("cannot go below nothing", () => {
    expect(dodgeChance(10, 100)).toBe(0);
    expect(dodgeChance(0, 0)).toBe(0);
  });

  /**
   * Halving is what keeps accuracy from erasing the stat. A perfectly accurate
   * attacker still leaves a nimble defender half their flee.
   */
  it("leaves a nimble defender something against perfect accuracy", () => {
    expect(dodgeChance(100, 100)).toBeCloseTo(0.5, 10);
  });
});

describe("swinging", () => {
  it("takes defence off the top and never heals", () => {
    const attacker = battler({ atk: 5, acc: 100, flee: 0 });
    const defender = battler({ def: 100, flee: 0 });
    const { dodged, damage } = rollAttack(attacker, defender, new Rng(1));
    expect(dodged).toBe(false);
    expect(damage).toBe(0);
  });

  it("deals exactly atk minus def when nothing is uncertain", () => {
    const attacker = battler({ atk: 9, acc: 100 });
    const defender = battler({ def: 2, flee: 0 });
    for (let seed = 0; seed < 20; seed++) {
      expect(rollAttack(attacker, defender, new Rng(seed)).damage).toBe(7);
    }
  });

  it("always dodges a defender nothing can touch", () => {
    const attacker = battler({ acc: 0 });
    const defender = battler({ flee: 100 });
    for (let seed = 0; seed < 20; seed++) {
      expect(rollAttack(attacker, defender, new Rng(seed)).dodged).toBe(true);
    }
  });

  /**
   * The dice are seeded so a world is reproducible, which only holds if a swing
   * always costs the same number of draws. If the count varied with the stats,
   * one creature's accuracy would change what every creature after it rolled.
   */
  it("costs the same three draws whatever the stats", () => {
    const reference = new Rng(7);
    for (let i = 0; i < 3; i++) reference.next();
    const after = reference.save();

    for (const stats of [
      [battler({ acc: 100 }), battler({ flee: 0 })],
      [battler({ acc: 0 }), battler({ flee: 100 })],
      [battler({ acc: 37 }), battler({ flee: 63 })],
    ] as const) {
      const rng = new Rng(7);
      rollAttack(stats[0], stats[1], rng);
      expect(rng.save()).toBe(after);
    }
  });
});

describe("reach", () => {
  const here = { x: 4, y: 4, z: 0 };

  it("covers the eight cells around you", () => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        expect(
          inAttackRange(here, { x: here.x + dx, y: here.y + dy, z: 0 }),
        ).toBe(true);
      }
    }
  });

  it("stops at one cell", () => {
    expect(
      inAttackRange(here, { x: here.x + ATTACK_RANGE_CELLS + 1, y: here.y, z: 0 }),
    ).toBe(false);
    expect(inAttackRange(here, { x: here.x + 1, y: here.y + 2, z: 0 })).toBe(
      false,
    );
  });

  it("reaches the step above and below, and no further", () => {
    expect(
      inAttackRange(here, { x: here.x + 1, y: here.y, z: SIGHT_LEVEL_SLACK }),
    ).toBe(true);
    expect(
      inAttackRange(here, { x: here.x + 1, y: here.y, z: SIGHT_LEVEL_SLACK + 1 }),
    ).toBe(false);
  });
});
