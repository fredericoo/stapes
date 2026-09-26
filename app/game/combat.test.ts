import { describe, expect, it } from "vitest";
import tilesRaw from "../../data/tiles.json";
import { emptyMap, replaceStack } from "../lib/mapData";
import { HEIGHT_PER_LEVEL, type MapFile, normalizeTiles, type TileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { emptyEquipment, type Equipment } from "./equipment";
import type { FightingStats } from "../lib/battler";
import { DEFAULT_BATTLER, fightingStats, fleeFrom, MAX_CHANCE, MIN_CHANCE } from "../lib/battler";
import {
  MAX_ATTACK_TICKS,
  MIN_ATTACK_TICKS,
  attackIntervalMs,
  cappedToHealth,
  damageFraction,
  defenceAgainst,
  dodgeChance,
  guardBand,
  guardFraction,
  GUARD_PEAK,
  guardRolled,
  guardShare,
  inAttackRange,
  MIN_GUARD_SHARE,
  REFLEX_EDGE,
  reflex,
  rollAttack,
  SWING_WINDUP_SHARE,
  swingIntervalMs,
  swingWindupMs,
  underPressure,
  rangedWeaponReaches,
} from "./combat";
import { TICK_MS } from "./constants";
import { MELEE_REACH, type Reach } from "../lib/item";
import { planDistanceSq } from "./distance";
import { Rng } from "./rng";

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
      expect(attackIntervalMs(spd)).toBeLessThanOrEqual(attackIntervalMs(spd - 1));
    }
  });

  it("makes a merely decent speed genuinely decent", () => {
    const halfway = attackIntervalMs(50);
    const linear = ((MIN_ATTACK_TICKS + MAX_ATTACK_TICKS) / 2) * TICK_MS;
    expect(halfway).toBeLessThan(linear / 4);
    expect(halfway / TICK_MS).toBe(Math.round(Math.sqrt(MIN_ATTACK_TICKS * MAX_ATTACK_TICKS)));
  });

  it("clamps a stat somebody hand-edited out of range", () => {
    expect(attackIntervalMs(-50)).toBe(attackIntervalMs(0));
    expect(attackIntervalMs(500)).toBe(attackIntervalMs(100));
  });
});

describe("the approach", () => {
  it("is half of whatever this body's own interval is", () => {
    for (const spd of [0, 1, 25, 50, 75, 99, 100]) {
      const stats = battler({ spd });
      const half = swingIntervalMs(stats) * SWING_WINDUP_SHARE;
      expect(swingWindupMs(stats)).toBeGreaterThanOrEqual(half - TICK_MS / 2);
      expect(swingWindupMs(stats)).toBeLessThanOrEqual(half + TICK_MS / 2);
    }
  });

  it("lands on a whole tick", () => {
    for (let spd = 0; spd <= 100; spd++) {
      const ticks = swingWindupMs(battler({ spd })) / TICK_MS;
      expect(ticks).toBeCloseTo(Math.round(ticks), 6);
    }
  });

  it("never gets longer as speed goes up", () => {
    for (let spd = 1; spd <= 100; spd++) {
      expect(swingWindupMs(battler({ spd }))).toBeLessThanOrEqual(
        swingWindupMs(battler({ spd: spd - 1 })),
      );
    }
  });

  it("follows haste, not spd alone", () => {
    const hastened = battler({ spd: 50, haste: 2 });
    const plain = battler({ spd: 50, haste: 1 });
    expect(swingWindupMs(hastened)).toBeLessThan(swingWindupMs(plain));
  });
});

describe("the damage band", () => {
  it("is a single point when nothing varies", () => {
    for (const roll of [
      [0, 0],
      [0.5, 0.5],
      [1, 1],
    ] as const) {
      expect(damageFraction(0, [...roll])).toBe(1);
    }
  });

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

  it("is common in the middle and rare at both ends", () => {
    const rng = new Rng(12345);
    const buckets = [0, 0, 0];
    for (let i = 0; i < 30_000; i++) {
      const f = damageFraction(100, [rng.next(), rng.next()]);
      buckets[f < 1 / 3 ? 0 : f < 2 / 3 ? 1 : 2]!++;
    }
    expect(buckets[1]!).toBeGreaterThan(buckets[0]! * 1.5);
    expect(buckets[1]!).toBeGreaterThan(buckets[2]! * 1.5);
    expect(Math.abs(buckets[0]! - buckets[2]!)).toBeLessThan(buckets[1]! * 0.1);
  });
});

describe("dodging", () => {
  it("favours the swinger when the two are level", () => {
    expect(dodgeChance(50, 50)).toBeCloseTo(dodgeChance(100, 100), 10);
    expect(dodgeChance(50, 50)).toBeLessThan(0.5);
  });

  it("is a coin toss once the defender is ahead by the swinger's edge", () => {
    expect(dodgeChance(50 + REFLEX_EDGE, 50)).toBeCloseTo(0.5, 10);
    expect(dodgeChance(100 + REFLEX_EDGE, 100)).toBeCloseTo(0.5, 10);
  });

  it("favours whichever side is ahead, from that point", () => {
    expect(dodgeChance(70 + REFLEX_EDGE, 50)).toBeGreaterThan(0.5);
    expect(dodgeChance(30 + REFLEX_EDGE, 50)).toBeLessThan(0.5);
  });

  it("is unmoved by what the swinger is holding", () => {
    const quick = battler({ flee: 60 });
    const clumsyWeapon = { ...quick, accuracy: 5, hitChance: 0.05 };
    const fineWeapon = { ...quick, accuracy: 100, hitChance: 0.95 };
    const defender = battler({ flee: 80 });

    expect(dodgeChance(defender.flee, reflex(clumsyWeapon))).toBe(
      dodgeChance(defender.flee, reflex(fineWeapon)),
    );
  });

  it("never reaches certainty at either end", () => {
    expect(dodgeChance(0, 1000)).toBe(MIN_CHANCE);
    expect(dodgeChance(1000, 0)).toBe(MAX_CHANCE);
  });

  it("rises without a step, all the way along", () => {
    let previous = dodgeChance(0, 30);
    for (let flee = 1; flee <= 200; flee++) {
      const here = dodgeChance(flee, 30);
      expect(here).toBeGreaterThanOrEqual(previous);
      expect(here - previous).toBeLessThan(0.05);
      previous = here;
    }
  });

  it("keeps paying from an untrained body to a fully trained one", () => {
    const swinger = fleeFrom(10);
    const untrained = dodgeChance(fleeFrom(0), swinger);
    const halfway = dodgeChance(fleeFrom(50), swinger);
    const mastered = dodgeChance(fleeFrom(100), swinger);

    expect(halfway).toBeGreaterThan(untrained * 3);
    expect(mastered).toBeGreaterThan(halfway * 1.5);
  });

  it("pays the swinger for training it as well as the defender", () => {
    const bat = fleeFrom(45);
    const novice = dodgeChance(bat, fleeFrom(10));
    const trained = dodgeChance(bat, fleeFrom(50));

    expect(trained).toBeLessThan(novice / 2);
  });
});

describe("the guard a blow draws", () => {
  it("spans the share of its face value the rule names", () => {
    expect(guardFraction(0)).toBeCloseTo(MIN_GUARD_SHARE, 10);
    expect(guardFraction(1)).toBeCloseTo(1, 10);
  });

  it("climbs without a step, all the way along", () => {
    let previous = guardFraction(0);
    for (let step = 1; step <= 1000; step++) {
      const here = guardFraction(step / 1000);
      expect(here).toBeGreaterThanOrEqual(previous);
      previous = here;
    }
  });

  it("comes up most often around the peak", () => {
    const rng = new Rng(4242);
    const buckets = new Map<number, number>();
    const TENTHS = 10;
    for (let i = 0; i < 60_000; i++) {
      const tenth = Math.min(TENTHS - 1, Math.floor(guardFraction(rng.next()) * TENTHS));
      buckets.set(tenth, (buckets.get(tenth) ?? 0) + 1);
    }
    const commonest = [...buckets.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    expect(commonest / TENTHS).toBeCloseTo(GUARD_PEAK, 1);

    const atPeak = buckets.get(Math.floor(GUARD_PEAK * TENTHS))!;
    expect(buckets.get(Math.floor(MIN_GUARD_SHARE * TENTHS))!).toBeLessThan(atPeak / 2);
    expect(buckets.get(TENTHS - 1)!).toBeLessThan(atPeak / 2);
  });

  it("is worth the average of its three corners over many draws", () => {
    const rng = new Rng(99);
    let total = 0;
    const draws = 200_000;
    for (let i = 0; i < draws; i++) total += guardFraction(rng.next());
    expect(total / draws).toBeCloseTo((MIN_GUARD_SHARE + GUARD_PEAK + 1) / 3, 2);
  });

  it("hands back whole numbers of defence inside the band", () => {
    const defender = battler({ def: 17 });
    const attacker = battler({ mastery: "sharp" });
    const { lowest, highest } = guardBand(defender, attacker);
    for (let step = 0; step <= 100; step++) {
      const guard = guardRolled(defender, attacker, step / 100);
      expect(Number.isInteger(guard)).toBe(true);
      expect(guard).toBeGreaterThanOrEqual(lowest);
      expect(guard).toBeLessThanOrEqual(highest);
    }
  });
});

describe("being outnumbered", () => {
  it("costs a body nothing at all when only one thing is on it", () => {
    const defender = battler({ flee: 60, def: 10 });

    expect(guardShare(0)).toBe(1);
    expect(guardShare(1)).toBe(1);
    expect(underPressure(defender, 1)).toBe(defender);
  });

  it("takes evasion and armour down together as the crowd grows", () => {
    const defender = battler({ flee: 60, def: 12, resist: { sharp: 8 } });
    const crowded = underPressure(defender, 8);

    expect(crowded.flee).toBeLessThan(defender.flee / 3);
    expect(crowded.def).toBeLessThan(defender.def / 3);
    expect(defenceAgainst(crowded, battler({ mastery: "sharp" }))).toBeLessThan(
      defenceAgainst(defender, battler({ mastery: "sharp" })) / 3,
    );
  });

  it("leaves a whole number of armour behind", () => {
    for (let assailants = 1; assailants <= 12; assailants++) {
      const crowded = underPressure(battler({ def: 17, resist: { blunt: 5 } }), assailants);
      expect(Number.isInteger(crowded.def)).toBe(true);
      expect(Number.isInteger(crowded.resist.blunt ?? 0)).toBe(true);
    }
  });

  it("costs less for every further body, and never reaches nothing", () => {
    let previous = guardShare(1);
    let lastCost = Infinity;
    for (let assailants = 2; assailants <= 40; assailants++) {
      const here = guardShare(assailants);
      const cost = previous - here;
      expect(here).toBeGreaterThan(0);
      expect(here).toBeLessThan(previous);
      expect(cost).toBeLessThan(lastCost);
      previous = here;
      lastCost = cost;
    }
  });

  it("lets a blow through that one attacker could never land", () => {
    const attacker = battler({ damage: 6, accuracy: 100, hitChance: 1 });
    const defender = battler({ def: 40, flee: 0 });

    let aloneDrew = 0;
    let crowdDrew = 0;
    for (let seed = 0; seed < 50; seed++) {
      aloneDrew += rollAttack(attacker, underPressure(defender, 1), new Rng(seed)).damage;
      crowdDrew += rollAttack(attacker, underPressure(defender, 8), new Rng(seed)).damage;
    }

    expect(aloneDrew).toBe(0);
    expect(crowdDrew).toBeGreaterThan(0);
  });
});

describe("swinging", () => {
  it("takes defence off the top and never heals", () => {
    const attacker = battler({ damage: 5, accuracy: 100, hitChance: 1 });
    const defender = battler({ def: 100, flee: 0 });
    expect(guardBand(defender, attacker).lowest).toBeGreaterThanOrEqual(5);
    for (let seed = 0; seed < 50; seed++) {
      expect(rollAttack(attacker, defender, new Rng(seed)).damage).toBe(0);
    }
  });

  it("no longer makes armour worth the blow a wall against it", () => {
    const attacker = battler({
      damage: 9,
      variance: 0,
      accuracy: 100,
      hitChance: 1,
    });
    const defender = battler({ def: 9, flee: 0 });

    let landed = 0;
    let wounded = 0;
    for (let seed = 0; seed < 200; seed++) {
      const outcome = rollAttack(attacker, defender, new Rng(seed));
      if (outcome.missed || outcome.dodged) continue;
      landed++;
      if (outcome.damage > 0) wounded++;
    }
    expect(landed).toBeGreaterThan(0);
    expect(wounded).toBeGreaterThan(landed / 2);
  });

  it("takes a draw against defence off a blow that connects", () => {
    const attacker = battler({
      damage: 9,
      variance: 0,
      accuracy: 100,
      hitChance: 1,
    });
    const defender = battler({ def: 4, flee: 0 });
    const { lowest, highest } = guardBand(defender, attacker);
    expect([lowest, highest]).toEqual([1, 4]);

    const drawn = new Set<number>();
    for (let seed = 0; seed < 400; seed++) {
      const outcome = rollAttack(attacker, defender, new Rng(seed));
      if (outcome.missed || outcome.dodged) continue;
      expect(outcome.potentialDamage).toBe(9);
      expect(outcome.damage).toBeGreaterThanOrEqual(9 - highest);
      expect(outcome.damage).toBeLessThanOrEqual(9 - lowest);
      drawn.add(outcome.damage);
    }
    expect([...drawn].sort((a, b) => a - b)).toEqual([5, 6, 7, 8]);
  });

  it("always dodges a defender nothing can touch", () => {
    const attacker = battler({ flee: 0, hitChance: 1 });
    const defender = battler({ flee: 1000 });
    for (let seed = 0; seed < 20; seed++) {
      expect(rollAttack(attacker, defender, new Rng(seed)).dodged).toBe(true);
    }
  });

  it("costs the same five draws whatever the stats", () => {
    const reference = new Rng(7);
    for (let i = 0; i < 5; i++) reference.next();
    const after = reference.save();

    for (const stats of [
      [battler({ accuracy: 100 }), battler({ flee: 0 })],
      [battler({ accuracy: 0 }), battler({ flee: 100 })],
      [battler({ accuracy: 37 }), battler({ flee: 63 })],
      [battler({ hitChance: 0 }), battler({ flee: 0 })],
      [battler({ hitChance: 1 }), battler({ flee: 0 })],
    ] as const) {
      const rng = new Rng(7);
      rollAttack(stats[0], stats[1], rng);
      expect(rng.save()).toBe(after);
    }
  });
});

describe("resisting a kind of blow", () => {
  const mailed = battler({ def: 2, resist: { sharp: 5 } });

  it("adds the matching resistance to the flat defence", () => {
    expect(defenceAgainst(mailed, battler({ mastery: "sharp" }))).toBe(7);
  });

  it("charges the flat defence alone for anything else", () => {
    expect(defenceAgainst(mailed, battler({ mastery: "blunt" }))).toBe(2);
    expect(defenceAgainst(mailed, battler({ mastery: "arcane" }))).toBe(2);
  });

  it("is the flat defence for a body wearing nothing opinionated", () => {
    const plain = battler({ def: 3, resist: {} });
    expect(defenceAgainst(plain, battler({ mastery: "sharp" }))).toBe(3);
  });

  it("makes one blow worth less than the other through the same armour", () => {
    const sword = battler({
      damage: 9,
      variance: 0,
      accuracy: 100,
      hitChance: 1,
      mastery: "sharp",
    });
    const hammer = { ...sword, mastery: "blunt" } as const;
    const defender = battler({ def: 2, resist: { sharp: 5 }, flee: 0 });

    let landed = 0;
    for (let seed = 0; seed < 50; seed++) {
      const cut = rollAttack(sword, defender, new Rng(seed));
      const thump = rollAttack(hammer, defender, new Rng(seed));
      if (cut.missed || cut.dodged) continue;
      landed++;
      expect(cut.damage).toBeLessThan(thump.damage);
    }
    expect(landed).toBeGreaterThan(0);
  });

  it("never heals, however much of it there is", () => {
    const attacker = battler({ damage: 5, accuracy: 100, hitChance: 1, mastery: "arcane" });
    const warded = battler({ def: 0, resist: { arcane: 100 }, flee: 0 });
    for (let seed = 0; seed < 50; seed++) {
      expect(rollAttack(attacker, warded, new Rng(seed)).damage).toBe(0);
    }
  });

  it("costs the swing no extra draws", () => {
    const reference = new Rng(11);
    rollAttack(battler({ mastery: "sharp" }), battler(), reference);
    const after = reference.save();

    const rng = new Rng(11);
    rollAttack(battler({ mastery: "sharp" }), battler({ resist: { sharp: 40, blunt: 3 } }), rng);
    expect(rng.save()).toBe(after);
  });
});

describe("statuses a weapon inflicts", () => {
  const certain = { id: "poison", chance: 100 };
  const never = { id: "poison", chance: 0 };
  const connects = { accuracy: 100, hitChance: 1 };

  it("leaves nothing behind for the weapons that inflict nothing", () => {
    const attacker = battler(connects);
    const defender = battler({ flee: 0 });
    for (let seed = 0; seed < 20; seed++) {
      expect(rollAttack(attacker, defender, new Rng(seed)).inflicted).toEqual([]);
    }
  });

  it("inflicts a certainty on every blow that lands, and a zero on none", () => {
    const defender = battler({ flee: 0 });
    let landed = 0;
    for (let seed = 0; seed < 50; seed++) {
      const always = rollAttack(
        battler({ ...connects, statuses: [certain] }),
        defender,
        new Rng(seed),
      );
      const nothing = rollAttack(
        battler({ ...connects, statuses: [never] }),
        defender,
        new Rng(seed),
      );
      expect(nothing.inflicted).toEqual([]);
      if (always.missed || always.dodged) continue;
      landed++;
      expect(always.inflicted).toEqual([certain]);
    }
    expect(landed).toBeGreaterThan(0);
  });

  it("still inflicts through armour that ate the whole blow", () => {
    const attacker = battler({ ...connects, damage: 5, statuses: [certain] });
    const defender = battler({ def: 100, flee: 0 });
    let landed = 0;
    for (let seed = 0; seed < 50; seed++) {
      const outcome = rollAttack(attacker, defender, new Rng(seed));
      if (outcome.missed || outcome.dodged) continue;
      landed++;
      expect(outcome.damage).toBe(0);
      expect(outcome.inflicted).toEqual([certain]);
    }
    expect(landed).toBeGreaterThan(0);
  });

  it("leaves nothing on a miss or on a dodge", () => {
    const missing = battler({ hitChance: 0, statuses: [certain] });
    const dodgeable = battler({
      flee: 0,
      hitChance: 1,
      statuses: [certain],
    });
    for (let seed = 0; seed < 20; seed++) {
      const missed = rollAttack(missing, battler({ flee: 0 }), new Rng(seed));
      const dodged = rollAttack(dodgeable, battler({ flee: 1000 }), new Rng(seed));
      if (missed.missed) expect(missed.inflicted).toEqual([]);
      expect(dodged.dodged).toBe(true);
      expect(dodged.inflicted).toEqual([]);
    }
  });

  it("fires about as often as it says", () => {
    const attacker = battler({ ...connects, statuses: [{ id: "poison", chance: 10 }] });
    const defender = battler({ flee: 0 });
    let landed = 0;
    let poisoned = 0;
    for (let seed = 0; seed < 3000; seed++) {
      const outcome = rollAttack(attacker, defender, new Rng(seed));
      if (outcome.missed || outcome.dodged) continue;
      landed++;
      if (outcome.inflicted.length > 0) poisoned++;
    }
    expect(poisoned / landed).toBeGreaterThan(0.08);
    expect(poisoned / landed).toBeLessThan(0.12);
  });

  it("costs one draw per authored status, whatever the blow came to", () => {
    const reference = new Rng(7);
    for (let i = 0; i < 7; i++) reference.next();
    const after = reference.save();

    for (const [attacker, defender] of [
      [battler({ hitChance: 0, statuses: [certain, never] }), battler({ flee: 0 })],
      [battler({ ...connects, statuses: [certain, never] }), battler({ flee: 100 })],
      [battler({ ...connects, statuses: [certain, never] }), battler({ flee: 0 })],
      [battler({ ...connects, statuses: [never, never] }), battler({ flee: 0 })],
    ] as const) {
      const rng = new Rng(7);
      rollAttack(attacker, defender, rng);
      expect(rng.save()).toBe(after);
    }
  });

  it("decides each authored status on its own draw", () => {
    const attacker = battler({
      ...connects,
      statuses: [certain, never, { id: "fed", chance: 100 }],
    });
    const defender = battler({ flee: 0 });
    for (let seed = 0; seed < 50; seed++) {
      const outcome = rollAttack(attacker, defender, new Rng(seed));
      if (outcome.missed || outcome.dodged) continue;
      expect(outcome.inflicted.map((status) => status.id)).toEqual(["poison", "fed"]);
    }
  });
});

describe("a blow trimmed to what the body had left", () => {
  const landed = {
    missed: false,
    dodged: false,
    damage: 60,
    potentialDamage: 72,
    inflicted: [],
  };

  it("takes off no more than the body was standing up with", () => {
    expect(cappedToHealth(landed, 9).damage).toBe(9);
    expect(cappedToHealth(landed, 0).damage).toBe(0);
  });

  it("leaves a blow the body could survive exactly as it was", () => {
    expect(cappedToHealth(landed, 60)).toBe(landed);
    expect(cappedToHealth(landed, 200)).toBe(landed);
  });

  it("leaves what the blow threatened alone", () => {
    expect(cappedToHealth(landed, 9).potentialDamage).toBe(72);
  });

  it("has nothing to trim on a miss or a dodge", () => {
    const missed = { ...landed, missed: true, damage: 0, potentialDamage: 0 };
    const dodged = { ...landed, dodged: true, damage: 0 };
    expect(cappedToHealth(missed, 0)).toBe(missed);
    expect(cappedToHealth(dodged, 0)).toBe(dodged);
  });
});

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
        potentialDamage: 0,
        inflicted: [],
      });
    }
  });

  it("reads as missed rather than dodged when both would have fired", () => {
    const attacker = battler({ hitChance: 0, flee: 0 });
    const defender = battler({ flee: 1000 });
    for (let seed = 0; seed < 20; seed++) {
      const outcome = rollAttack(attacker, defender, new Rng(seed));
      expect(outcome.missed).toBe(true);
      expect(outcome.dodged).toBe(false);
    }
  });

  it("still dodges normally once the swing does connect", () => {
    const attacker = battler({ hitChance: 1, flee: 0 });
    const defender = battler({ flee: 1000 });
    for (let seed = 0; seed < 20; seed++) {
      const outcome = rollAttack(attacker, defender, new Rng(seed));
      expect(outcome.missed).toBe(false);
      expect(outcome.dodged).toBe(true);
    }
  });

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
  const melee = MELEE_REACH;

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
    expect(inAttackRange(here, at(0, 0, HEIGHT_PER_LEVEL), melee)).toBe(false);
    expect(inAttackRange(here, at(1, 0, HEIGHT_PER_LEVEL), melee)).toBe(false);
    expect(inAttackRange(here, at(0, 0, -HEIGHT_PER_LEVEL), melee)).toBe(false);
  });

  it("keeps the boundary case inside", () => {
    expect(planDistanceSq(here, at(1, 1, 0))).toBe(2);
    expect(melee.cells * melee.cells).toBeGreaterThan(2);
    expect(melee.cells * melee.cells).toBeLessThan(4);
  });

  it("widens the disc without raising the lid", () => {
    const bow: Reach = { cells: 6, height: HEIGHT_PER_LEVEL };
    expect(inAttackRange(here, at(4, 0, 0), bow)).toBe(true);
    expect(inAttackRange(here, at(6, 0, 0), bow)).toBe(true);
    expect(inAttackRange(here, at(7, 0, 0), bow)).toBe(false);

    expect(inAttackRange(here, at(0, 0, HEIGHT_PER_LEVEL), bow)).toBe(true);
    expect(inAttackRange(here, at(5, 0, HEIGHT_PER_LEVEL), bow)).toBe(true);
    expect(inAttackRange(here, at(0, 0, 2 * HEIGHT_PER_LEVEL), bow)).toBe(false);
  });

  it("draws a flat disc when the height is nothing", () => {
    const flat: Reach = { cells: 4, height: 0 };
    expect(inAttackRange(here, at(3, 0, 0), flat)).toBe(true);
    expect(inAttackRange(here, at(3, 0, 1), flat)).toBe(false);
  });

  describe("a minimum", () => {
    const bow: Reach = { cells: 8, min: 2, height: HEIGHT_PER_LEVEL };

    it("refuses what is too close and keeps what is far enough", () => {
      expect(inAttackRange(here, at(0, 0, 0), bow)).toBe(false);
      expect(inAttackRange(here, at(1, 0, 0), bow)).toBe(false);
      expect(inAttackRange(here, at(1, 1, 0), bow)).toBe(false);
      expect(inAttackRange(here, at(2, 0, 0), bow)).toBe(true);
      expect(inAttackRange(here, at(8, 0, 0), bow)).toBe(true);
    });

    it("keeps the cell it names, and drops the diagonal below it", () => {
      expect(planDistanceSq(here, at(2, 0, 0))).toBe(4);
      expect(planDistanceSq(here, at(1, 1, 0))).toBe(2);
      expect(inAttackRange(here, at(2, 0, 0), bow)).toBe(true);
      expect(inAttackRange(here, at(1, 1, 0), bow)).toBe(false);
    });

    it("measures the floor on the plan and never on the height", () => {
      expect(inAttackRange(here, at(0, 0, HEIGHT_PER_LEVEL), bow)).toBe(false);
      expect(inAttackRange(here, at(3, 0, HEIGHT_PER_LEVEL), bow)).toBe(true);
    });

    it("leaves a weapon with no minimum exactly as it was", () => {
      const open: Reach = { cells: 8, height: HEIGHT_PER_LEVEL };
      expect(inAttackRange(here, at(0, 0, 0), open)).toBe(true);
      expect(inAttackRange(here, at(1, 0, 0), open)).toBe(true);
    });
  });
});

describe("rangedWeaponReaches", () => {
  const catalogue: Record<string, TileDef> = tilesByIdFromList(
    normalizeTiles(tilesRaw as unknown[]),
  );
  const holding = (tileId: string): Equipment => ({
    ...emptyEquipment(),
    weapon: { id: `held-${tileId}`, tileId },
  });
  const at = (x: number) => ({ x, y: 0, z: 0, stackIndex: 1 });

  function row(length: number, blocked: number[] = []): MapFile {
    let map = emptyMap();
    for (let x = 0; x < length; x++) {
      const wall = blocked.includes(x) ? [{ tileId: "stone-wall" }] : [];
      map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }, ...wall]);
    }
    return map;
  }

  it("reaches a target inside the bow's reach", () => {
    expect(rangedWeaponReaches(row(8), catalogue, holding("simple-bow"), at(0), at(4))).toBe(true);
  });

  it("does not reach a target inside the bow's minimum", () => {
    expect(rangedWeaponReaches(row(8), catalogue, holding("simple-bow"), at(0), at(1))).toBe(false);
  });

  it("does not reach past the bow's reach", () => {
    expect(rangedWeaponReaches(row(12), catalogue, holding("simple-bow"), at(0), at(10))).toBe(
      false,
    );
  });

  it("does not reach through a wall", () => {
    const map = row(8, [2]);
    expect(rangedWeaponReaches(map, catalogue, holding("simple-bow"), at(0), at(4))).toBe(false);
  });

  it("does not count a melee weapon", () => {
    expect(rangedWeaponReaches(row(8), catalogue, holding("rusty-sword"), at(0), at(1))).toBe(
      false,
    );
  });
});
