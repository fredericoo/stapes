import { describe, expect, it } from "vitest";
import type { FightingStats } from "../lib/battler";
import {
  DEFAULT_BATTLER,
  DEFAULT_MELEE_RANGE,
  fightingStats,
  fleeFrom,
  MAX_CHANCE,
  MIN_CHANCE,
} from "../lib/battler";
import {
  MAX_ATTACK_TICKS,
  MIN_ATTACK_TICKS,
  attackIntervalMs,
  damageFraction,
  dodgeChance,
  inAttackRange,
  rollAttack,
} from "./combat";
import { TICK_MS } from "./constants";
import { HEIGHT_PER_LEVEL } from "../lib/types";
import { reachDistanceSq } from "./distance";
import { Rng } from "./rng";

/**
 * The arithmetic of a blow, asserted rather than eyeballed.
 *
 * A damage curve is the kind of thing that is quietly wrong for months: it
 * produces plausible numbers whatever it does, so nothing about playing the game
 * tells you the peak drifted or that accuracy stopped mattering. These are the
 * claims the design actually makes, written down where they can fail.
 */

/**
 * A stat block to swing with, from the default body and its bare hands.
 *
 * Built through `fightingStats` rather than written out, so a change to how a
 * body becomes numbers reaches these tests instead of being papered over by a
 * fixture that still holds the old shape.
 */
const BARE_HANDED = fightingStats(DEFAULT_BATTLER, DEFAULT_BATTLER.naturalWeapon);

function battler(overrides: Partial<FightingStats> = {}): FightingStats {
  return { ...BARE_HANDED, ...overrides };
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
  it("is a single point when nothing varies", () => {
    for (const roll of [[0, 0], [0.5, 0.5], [1, 1]] as const) {
      expect(damageFraction(0, [...roll])).toBe(1);
    }
  });

  /**
   * Variance drags the *floor* down and leaves the ceiling where it is. That is
   * what "damage is the most a blow can do" means: a wild weapon is not one that
   * occasionally exceeds its damage, it is one that often falls short.
   */
  it("always tops out at full damage, whatever the variance", () => {
    for (const variance of [0, 25, 50, 100]) {
      expect(damageFraction(variance, [1, 1])).toBeCloseTo(1, 10);
    }
  });

  it("opens the floor as variance rises", () => {
    expect(damageFraction(100, [0, 0])).toBeCloseTo(0, 10);
    expect(damageFraction(50, [0, 0])).toBeCloseTo(0.5, 10);
    expect(damageFraction(20, [0, 0])).toBeCloseTo(0.8, 10);
  });

  it("puts the middle of the band at the middle of the roll", () => {
    expect(damageFraction(100, [0.5, 0.5])).toBeCloseTo(0.5, 10);
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
      const f = damageFraction(100, [rng.next(), rng.next()]);
      buckets[f < 1 / 3 ? 0 : f < 2 / 3 ? 1 : 2]!++;
    }
    expect(buckets[1]!).toBeGreaterThan(buckets[0]! * 1.5);
    expect(buckets[1]!).toBeGreaterThan(buckets[2]! * 1.5);
    // And symmetric, which is what makes the peak the *middle* rather than a
    // lean somebody would have to compensate for when authoring damage.
    expect(Math.abs(buckets[0]! - buckets[2]!)).toBeLessThan(buckets[1]! * 0.1);
  });
});

/**
 * A contest on a logistic curve, floored and capped.
 *
 * This replaced `flee - accuracy / 2`, which was linear and hit zero and stayed
 * there. Once accuracy also decided whether a blow landed at all, weapon
 * accuracies had to rise, and the linear rule drove every dodge in the game to
 * about two percent — Agility stopped being worth a single point.
 */
describe("dodging", () => {
  it("is a coin toss when evasion and accuracy are level", () => {
    expect(dodgeChance(50, 50)).toBeCloseTo(0.5, 10);
    expect(dodgeChance(100, 100)).toBeCloseTo(0.5, 10);
  });

  it("favours whichever side is ahead", () => {
    expect(dodgeChance(70, 50)).toBeGreaterThan(0.5);
    expect(dodgeChance(30, 50)).toBeLessThan(0.5);
  });

  /**
   * **Nothing is ever certain in either direction.** An outmatched defender is
   * never simply a target, and no amount of evasion makes anybody untouchable.
   */
  it("never reaches certainty at either end", () => {
    expect(dodgeChance(0, 1000)).toBe(MIN_CHANCE);
    expect(dodgeChance(1000, 0)).toBe(MAX_CHANCE);
  });

  /** Smooth: every point of evasion is worth something, with no cliff anywhere. */
  it("rises without a step, all the way along", () => {
    let previous = dodgeChance(0, 85);
    for (let flee = 1; flee <= 200; flee++) {
      const here = dodgeChance(flee, 85);
      expect(here).toBeGreaterThanOrEqual(previous);
      expect(here - previous).toBeLessThan(0.05);
      previous = here;
    }
  });

  /**
   * The stat has to pay across the whole mastery scale rather than being spent
   * by the time somebody is a third trained — which is exactly what the old rule
   * got wrong in the other direction.
   */
  it("keeps paying from an untrained body to a fully trained one", () => {
    const untrained = dodgeChance(fleeFrom(0), 85);
    const halfway = dodgeChance(fleeFrom(50), 85);
    const mastered = dodgeChance(fleeFrom(100), 85);

    expect(halfway).toBeGreaterThan(untrained * 3);
    expect(mastered).toBeGreaterThan(halfway * 1.5);
  });
});

describe("swinging", () => {
  /**
   * Over many seeds rather than one, because **nothing is certain any more**:
   * every probability is floored at {@link MIN_CHANCE}, so no stat block can
   * promise that a given swing connects. What is asserted is the invariant — a
   * blow that cannot get through armour is worth nothing, never a heal.
   */
  it("takes defence off the top and never heals", () => {
    const attacker = battler({ damage: 5, accuracy: 100, hitChance: 1 });
    const defender = battler({ def: 100, flee: 0 });
    for (let seed = 0; seed < 50; seed++) {
      expect(rollAttack(attacker, defender, new Rng(seed)).damage).toBe(0);
    }
  });

  /**
   * Every swing that actually lands, rather than every swing: with a floor under
   * both the whiff and the dodge, some of these fifty come to nothing however the
   * stats are written. The claim is about the arithmetic of a blow that connects.
   */
  it("deals exactly damage minus def when the blow connects", () => {
    const attacker = battler({
      damage: 9,
      variance: 0,
      accuracy: 100,
      hitChance: 1,
    });
    const defender = battler({ def: 2, flee: 0 });

    let landed = 0;
    for (let seed = 0; seed < 50; seed++) {
      const outcome = rollAttack(attacker, defender, new Rng(seed));
      if (outcome.missed || outcome.dodged) continue;
      landed++;
      expect(outcome.damage).toBe(7);
      expect(outcome.potentialDamage).toBe(9);
    }
    expect(landed).toBeGreaterThan(0);
  });

  it("always dodges a defender nothing can touch", () => {
    // Certain to connect, so what is asserted is the dodge rather than the
    // whiff — the two are distinguished in their own describe below.
    const attacker = battler({ accuracy: 0, hitChance: 1 });
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
  it("costs the same four draws whatever the stats", () => {
    const reference = new Rng(7);
    for (let i = 0; i < 4; i++) reference.next();
    const after = reference.save();

    for (const stats of [
      [battler({ accuracy: 100 }), battler({ flee: 0 })],
      [battler({ accuracy: 0 }), battler({ flee: 100 })],
      [battler({ accuracy: 37 }), battler({ flee: 63 })],
      // Both ends of the new term, which is the one that made this four: an
      // outcome decided on the first draw must still pay for the other three.
      [battler({ hitChance: 0 }), battler({ flee: 0 })],
      [battler({ hitChance: 1 }), battler({ flee: 0 })],
    ] as const) {
      const rng = new Rng(7);
      rollAttack(stats[0], stats[1], rng);
      expect(rng.save()).toBe(after);
    }
  });
});

/**
 * Missing and dodging are the same absence of damage and must never be the same
 * event: one is the swinger out of their depth, the other is the target being
 * quick, and in the phase after this they pay experience to opposite parties.
 */
describe("missing, as distinct from being dodged", () => {
  it("never lands a swing that cannot connect at all", () => {
    const attacker = battler({ hitChance: 0 });
    const defender = battler({ flee: 0 });
    for (let seed = 0; seed < 20; seed++) {
      const outcome = rollAttack(attacker, defender, new Rng(seed));
      expect(outcome).toEqual({
        missed: true,
        dodged: false,
        damage: 0,
        // Nothing was ever rolled: a swing that went nowhere was never worth
        // anything, so there is no potential for the defender to be paid for.
        potentialDamage: 0,
      });
    }
  });

  /**
   * A blow that never went where it was aimed gave the defender nothing to get
   * out of the way of, so the miss has to win — crediting the dodge would pay
   * agility for standing still.
   */
  it("reads as missed rather than dodged when both would have fired", () => {
    const attacker = battler({ hitChance: 0, accuracy: 0 });
    const defender = battler({ flee: 100 });
    for (let seed = 0; seed < 20; seed++) {
      const outcome = rollAttack(attacker, defender, new Rng(seed));
      expect(outcome.missed).toBe(true);
      expect(outcome.dodged).toBe(false);
    }
  });

  it("still dodges normally once the swing does connect", () => {
    const attacker = battler({ hitChance: 1, accuracy: 0 });
    const defender = battler({ flee: 100 });
    for (let seed = 0; seed < 20; seed++) {
      const outcome = rollAttack(attacker, defender, new Rng(seed));
      expect(outcome.missed).toBe(false);
      expect(outcome.dodged).toBe(true);
    }
  });

  /**
   * A dodge still knows what it dodged, which is what the phase after this pays
   * the defender's Agility out of — escaping something enormous has to be worth
   * more than escaping a scratch.
   */
  it("carries what the blow would have been worth through a dodge", () => {
    const attacker = battler({ hitChance: 1, damage: 6, variance: 0, accuracy: 0 });
    const defender = battler({ flee: 1000 });

    const outcome = rollAttack(attacker, defender, new Rng(3));
    expect(outcome.dodged).toBe(true);
    expect(outcome.damage).toBe(0);
    expect(outcome.potentialDamage).toBe(6);
  });
});

describe("reach", () => {
  const here = { x: 4, y: 4, elevAbs: 0 };
  const melee = DEFAULT_MELEE_RANGE;

  /** Elevation in height units; a level is two of them. */
  function at(dx: number, dy: number, dElev: number) {
    return { x: here.x + dx, y: here.y + dy, elevAbs: here.elevAbs + dElev };
  }

  it("covers the eight cells around you", () => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        expect(inAttackRange(here, at(dx, dy, 0), melee)).toBe(true);
      }
    }
  });

  it("stops at one cell", () => {
    expect(inAttackRange(here, at(2, 0, 0), melee)).toBe(false);
    expect(inAttackRange(here, at(1, 2, 0), melee)).toBe(false);
  });

  /**
   * Half a level either way, including on the diagonal — the shape the melee
   * default exists to draw. See `./distance` for why height costs a whole cell.
   */
  it("reaches half a level up and down, corners included", () => {
    for (const dElev of [1, -1]) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          expect(inAttackRange(here, at(dx, dy, dElev), melee)).toBe(true);
        }
      }
    }
  });

  it("stops short of a whole level away", () => {
    // Straight up is the nearest a full level ever gets, and it is still out.
    expect(inAttackRange(here, at(0, 0, HEIGHT_PER_LEVEL), melee)).toBe(false);
    expect(inAttackRange(here, at(1, 0, HEIGHT_PER_LEVEL), melee)).toBe(false);
    expect(inAttackRange(here, at(0, 0, -HEIGHT_PER_LEVEL), melee)).toBe(false);
  });

  /**
   * The corner of the box lands exactly on the radius, which is why the
   * comparison is squared and never square-rooted: 3 against 3.5, both exact.
   */
  it("keeps the boundary case inside", () => {
    expect(reachDistanceSq(here, at(1, 1, 1))).toBe(3);
    expect(melee * melee).toBeGreaterThan(3);
    expect(melee * melee).toBeLessThan(4);
  });

  it("grows into a sphere for anything with a longer reach", () => {
    const bow = 6;
    expect(inAttackRange(here, at(4, 0, 0), bow)).toBe(true);
    // Height costs a cell a unit, so a bow of six reaches three levels up.
    expect(inAttackRange(here, at(0, 0, 3 * HEIGHT_PER_LEVEL), bow)).toBe(true);
    expect(inAttackRange(here, at(0, 0, 4 * HEIGHT_PER_LEVEL), bow)).toBe(false);
  });
});
