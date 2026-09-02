import { describe, expect, it } from "vitest";
import type { FightingStats } from "../lib/battler";
import { MELEE_REACH } from "../lib/item";
import { damageFraction, rollAttack } from "./combat";
import { potentialDamages, swingOdds } from "./combatMetrics";
import { Rng } from "./rng";

/**
 * The metrics against the dice they describe.
 *
 * Every figure in `./combatMetrics` is a closed form over curves that are rolled
 * somewhere else, and the one failure mode that matters is the two drifting
 * apart — a formula that was right about the band before somebody widened it,
 * and a tuning session spent chasing a number that was never true. So the
 * assertions here are almost all the same shape: work it out, then roll it a
 * great many times, and insist the two agree.
 *
 * The tolerances are the sampling error of the roll, not of the formula: the
 * formula is exact, and anything it is out by is the Monte Carlo's fault.
 */

const SAMPLES = 200_000;

function statsOf(over: Partial<FightingStats>): FightingStats {
  return {
    maxHp: 20,
    damage: 10,
    def: 0,
    resist: {},
    mastery: "blade",
    accuracy: 80,
    variance: 40,
    spd: 50,
    haste: 1,
    hitChance: 0.8,
    flee: 30,
    reach: MELEE_REACH,
    projectile: null,
    sight: { up: 0, down: 0 },
    statuses: [],
    ...over,
  };
}

/** What `SAMPLES` swings actually came to, as shares of all of them. */
function sampled(attacker: FightingStats, defender: FightingStats) {
  const rng = new Rng(1234);
  let missed = 0;
  let dodged = 0;
  let connected = 0;
  let absorbed = 0;
  let damage = 0;

  for (let i = 0; i < SAMPLES; i++) {
    const outcome = rollAttack(attacker, defender, rng);
    if (outcome.missed) missed++;
    else if (outcome.dodged) dodged++;
    else {
      connected++;
      damage += outcome.damage;
      if (outcome.damage === 0) absorbed++;
    }
  }

  return {
    missed: missed / SAMPLES,
    dodged: dodged / SAMPLES,
    connected: connected / SAMPLES,
    absorbed: absorbed / SAMPLES,
    meanSwingDamage: damage / SAMPLES,
  };
}

describe("the damage band", () => {
  it("is a distribution, so its terms sum to one", () => {
    for (const variance of [0, 10, 25, 40, 60, 75, 100]) {
      const total = potentialDamages(statsOf({ damage: 17, variance })).reduce(
        (sum, odds) => sum + odds.chance,
        0,
      );
      expect(total).toBeCloseTo(1, 10);
    }
  });

  /**
   * The promise `damageFraction` makes in words: accuracy widens the band
   * *downward*, and full damage is always the ceiling.
   */
  it("tops out at full damage whatever the variance", () => {
    for (const variance of [0, 25, 60, 100]) {
      const band = potentialDamages(statsOf({ damage: 17, variance }));
      expect(band[band.length - 1]!.value).toBe(17);
    }
  });

  it("collapses to a single value when nothing varies", () => {
    expect(potentialDamages(statsOf({ damage: 17, variance: 0 }))).toEqual([
      { value: 17, chance: 1 },
    ]);
  });

  /**
   * The hump, asserted rather than assumed: a flat roll would make a glancing
   * blow exactly as likely as a shattering one, and the whole reason the roll is
   * two draws averaged is that it should not.
   */
  it("is likelier in the middle than at either end", () => {
    const band = potentialDamages(statsOf({ damage: 40, variance: 100 }));
    const middle = band[Math.floor(band.length / 2)]!;
    expect(middle.chance).toBeGreaterThan(band[0]!.chance);
    expect(middle.chance).toBeGreaterThan(band[band.length - 1]!.chance);
  });

  it("agrees with what the dice actually produce", () => {
    const attacker = statsOf({ damage: 13, variance: 55, hitChance: 1 });
    const defender = statsOf({ flee: 0, def: 0 });
    const rng = new Rng(99);
    const counts = new Map<number, number>();
    let connected = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const outcome = rollAttack(attacker, defender, rng);
      // **Counted over connecting blows, not over swings**, and the difference
      // is `MIN_CHANCE`: nothing in a fight is ever certain, so a defender with
      // no evasion at all still gets out of the way one time in twenty. Divide
      // by every swing and the band comes back five percent short everywhere,
      // which reads exactly like a formula with a bias in it.
      if (outcome.dodged) continue;
      connected++;
      counts.set(outcome.damage, (counts.get(outcome.damage) ?? 0) + 1);
    }

    for (const { value, chance } of potentialDamages(attacker)) {
      expect((counts.get(value) ?? 0) / connected).toBeCloseTo(chance, 2);
    }
  });
});

describe("swing odds", () => {
  /**
   * The four ways a swing can go, against the same four counted off a great
   * many rolls. This is the assertion the whole module exists for: if it holds,
   * the Arena's table is the fight.
   */
  it("predicts every outcome a swing can have", () => {
    const attacker = statsOf({ hitChance: 0.72, accuracy: 84, damage: 12, variance: 45 });
    const defender = statsOf({ flee: 46, def: 3 });

    const predicted = swingOdds(attacker, defender);
    const observed = sampled(attacker, defender);

    expect(observed.missed).toBeCloseTo(predicted.missed, 2);
    expect(observed.dodged).toBeCloseTo(predicted.dodged, 2);
    expect(observed.connected).toBeCloseTo(predicted.connected, 2);
    expect(observed.absorbed).toBeCloseTo(predicted.absorbed, 2);
    expect(observed.meanSwingDamage).toBeCloseTo(predicted.meanSwingDamage, 1);
  });

  /**
   * Armour that eats a blow whole is invisible in an average, which is the
   * entire reason `absorbed` is reported beside the mean rather than folded
   * into it.
   */
  it("counts a blow armour swallowed as absorbed rather than as a wound", () => {
    const attacker = statsOf({ hitChance: 1, damage: 4, variance: 100 });
    const defender = statsOf({ flee: 0, def: 3 });
    const odds = swingOdds(attacker, defender);

    expect(odds.absorbed).toBeGreaterThan(0);
    expect(odds.absorbed + odds.wounded).toBeCloseTo(odds.connected, 10);
    const observed = sampled(attacker, defender);
    expect(observed.absorbed).toBeCloseTo(odds.absorbed, 2);
  });

  it("accounts for every swing exactly once", () => {
    const odds = swingOdds(statsOf({ hitChance: 0.6 }), statsOf({ flee: 55 }));
    expect(odds.missed + odds.dodged + odds.connected).toBeCloseTo(1, 10);
  });

  /** A defenceless target takes the whole band; a mitigation of zero says so. */
  it("reports no mitigation when there is no defence", () => {
    const odds = swingOdds(statsOf({}), statsOf({ def: 0 }));
    expect(odds.mitigation).toBe(0);
    expect(odds.minDamage).toBeGreaterThan(0);
  });

  /**
   * Speed is geometric, so the rate is the one figure that cannot be read off
   * the stat — which is exactly why it is on the table.
   */
  it("turns speed into a rate", () => {
    const slow = swingOdds(statsOf({ spd: 0 }), statsOf({}));
    const quick = swingOdds(statsOf({ spd: 100 }), statsOf({}));
    expect(quick.attacksPerSecond).toBeGreaterThan(slow.attacksPerSecond);
    expect(quick.attacksPerSecond).toBeCloseTo(1000 / quick.intervalMs, 10);
  });

  it("has nothing to say about time to kill when nothing can get through", () => {
    const odds = swingOdds(
      statsOf({ damage: 2, variance: 0, hitChance: 1 }),
      statsOf({ def: 50 }),
    );
    expect(odds.secondsToKill).toBeNull();
    expect(odds.swingsToKill).toBeNull();
  });

  /** A weapon's venom is quoted at the rate it actually takes, not as authored. */
  it("discounts an authored status chance by how often the blow lands", () => {
    const attacker = statsOf({
      hitChance: 0.5,
      accuracy: 100,
      statuses: [{ id: "poison", chance: 50 }],
    });
    const odds = swingOdds(attacker, statsOf({ flee: 0 }));
    expect(odds.statuses[0]!.perSwing).toBeCloseTo(odds.connected * 0.5, 10);
    expect(odds.statuses[0]!.perSwing).toBeLessThan(0.5);
  });
});

/**
 * The two things `./combatMetrics` still works out for itself.
 *
 * Everything else in that module calls `./combat` — see its module note. What is
 * left are two properties of the *dice*, and a closed form built on them is only
 * exact for as long as they hold. Neither is likely to change; both would change
 * silently, and a silent one is precisely the kind this whole arrangement exists
 * to rule out. So they are written down here as the assumptions they are.
 */
describe("what the closed form assumes about the dice", () => {
  /**
   * The damage band's two draws enter only through their mean.
   *
   * This is what makes `[t, t]` a faithful probe: bisecting on it finds the same
   * boundary a real pair of draws would cross. Roll the band differently — three
   * draws, the higher of two, a curve on each — and this fails, which is the
   * signal to stop probing on the diagonal.
   */
  it("reads the damage band's two draws only through their mean", () => {
    for (const variance of [10, 40, 75, 100]) {
      for (let step = 0; step <= 20; step++) {
        const mean = step / 20;
        const spread = Math.min(mean, 1 - mean);
        expect(damageFraction(variance, [mean, mean])).toBeCloseTo(
          damageFraction(variance, [mean - spread, mean + spread]),
          12,
        );
      }
    }
  });

  /** The band's worth climbs with that mean, so each boundary is one crossing. */
  it("never gets less out of a better draw", () => {
    const attacker = statsOf({ damage: 23, variance: 65 });
    let last = -Infinity;
    for (let step = 0; step <= 500; step++) {
      const worth = Math.round(
        attacker.damage * damageFraction(attacker.variance, [step / 500, step / 500]),
      );
      expect(worth).toBeGreaterThanOrEqual(last);
      last = worth;
    }
  });

  /**
   * The mean of two `Rng` draws is triangular, which is the measure the band's
   * probabilities are integrated against.
   */
  it("averages two of the world's draws into a triangular distribution", () => {
    const rng = new Rng(2024);
    const cdf = (mean: number) =>
      mean <= 0.5 ? 2 * mean * mean : 1 - 2 * (1 - mean) * (1 - mean);
    const means: number[] = [];
    for (let i = 0; i < SAMPLES; i++) means.push((rng.next() + rng.next()) / 2);

    for (const at of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const below = means.filter((mean) => mean < at).length / SAMPLES;
      expect(below).toBeCloseTo(cdf(at), 2);
    }
  });
});
