import { describe, expect, it } from "vitest";
import type { FightingStats } from "../lib/battler";
import { MELEE_REACH } from "../lib/item";
import { damageFraction, rollAttack } from "./combat";
import { potentialDamages, rotationOdds, swingOdds } from "./combatMetrics";
import { TICK_MS } from "./constants";
import { Duel } from "./duel";
import { Rng } from "./rng";

const SAMPLES = 200_000;

function statsOf(over: Partial<FightingStats>): FightingStats {
  return {
    maxHp: 20,
    damage: 10,
    def: 0,
    resist: {},
    mastery: "sharp",
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

  it("reports no mitigation when there is no defence", () => {
    const odds = swingOdds(statsOf({}), statsOf({ def: 0 }));
    expect(odds.mitigation).toBe(0);
    expect(odds.minDamage).toBeGreaterThan(0);
  });

  it("turns speed into a rate", () => {
    const slow = rotationOdds([statsOf({ spd: 0 })], statsOf({}));
    const quick = rotationOdds([statsOf({ spd: 100 })], statsOf({}));
    expect(quick.attacksPerSecond).toBeGreaterThan(slow.attacksPerSecond);
    expect(quick.attacksPerSecond).toBeCloseTo(1000 / quick.swings[0]!.intervalMs, 10);
  });

  it("has nothing to say about time to kill when nothing can get through", () => {
    const odds = rotationOdds(
      [statsOf({ damage: 2, variance: 0, hitChance: 1 })],
      statsOf({ def: 50 }),
    );
    expect(odds.swings[0]!.absorbed).toBeCloseTo(odds.swings[0]!.connected, 10);
    expect(odds.secondsToKill).toBeNull();
    expect(odds.swingsToKill).toBeNull();
  });

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

describe("a body with a weapon in each hand", () => {
  /**
   * Both speeds give intervals the duel's cooldown counts down to exactly zero.
   * At about half of all speeds, subtracting `TICK_MS` leaves a float remainder
   * that holds each blow back one tick, which would fail this test for a reason
   * other than the rotation.
   */
  const light = statsOf({ damage: 5, variance: 40, spd: 72, hitChance: 0.9 });
  const heavy = statsOf({ damage: 24, variance: 30, spd: 62, hitChance: 0.7, mastery: "blunt" });
  const target = statsOf({ maxHp: Number.MAX_SAFE_INTEGER, def: 2, flee: 25, damage: 0, spd: 0 });

  function dueled(swings: FightingStats[], seconds = 20_000) {
    const duel = new Duel({ swings }, { swings: [target] }, new Rng(7));
    let blows = 0;
    let damage = 0;
    for (let tick = 0; tick < (seconds * 1000) / TICK_MS; tick++) {
      for (const event of duel.tick()) {
        if (event.kind !== "swing" || event.by !== "a") continue;
        blows++;
        damage += event.outcome.damage;
      }
    }
    return { attacksPerSecond: blows / seconds, damagePerSecond: damage / seconds };
  }

  it("matches the duel's attacks and damage per second, swinging both in turn", () => {
    const predicted = rotationOdds([light, heavy], target);
    const observed = dueled([light, heavy]);

    expect(observed.attacksPerSecond).toBeCloseTo(predicted.attacksPerSecond, 3);
    expect(observed.damagePerSecond / predicted.damagePerSecond).toBeCloseTo(1, 1);
  });
});

describe("what the closed form assumes about the dice", () => {
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

  it("averages two of the world's draws into a triangular distribution", () => {
    const rng = new Rng(2024);
    const cdf = (mean: number) => (mean <= 0.5 ? 2 * mean * mean : 1 - 2 * (1 - mean) * (1 - mean));
    const means: number[] = [];
    for (let i = 0; i < SAMPLES; i++) means.push((rng.next() + rng.next()) / 2);

    for (const at of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const below = means.filter((mean) => mean < at).length / SAMPLES;
      expect(below).toBeCloseTo(cdf(at), 2);
    }
  });
});
