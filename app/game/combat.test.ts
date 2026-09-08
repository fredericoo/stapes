import { describe, expect, it } from "vitest";
import type { FightingStats } from "../lib/battler";
import {
  DEFAULT_BATTLER,
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
  defenceAgainst,
  dodgeChance,
  guardBand,
  guardFraction,
  GUARD_PEAK,
  guardRolled,
  guardShare,
  inAttackRange,
  MIN_GUARD_SHARE,
  rollAttack,
  underPressure,
} from "./combat";
import { TICK_MS } from "./constants";
import { HEIGHT_PER_LEVEL } from "../lib/types";
import { MELEE_REACH, type Reach } from "../lib/item";
import { planDistanceSq } from "./distance";
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

/**
 * The guard draw: a band with a hump in it.
 *
 * This is the half of armour that is not a number on a tile. A flat draw would
 * make a mail shirt that turned nothing aside exactly as common as one that
 * turned aside everything, so what is asserted is the *shape* — where the ends
 * are, and that the middle is where the weight sits.
 */
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

  /**
   * The peak is where the author put it, and it is a *mode* rather than a mean:
   * the mean of a triangle sits at the average of its three corners, which is
   * deliberately not the same number.
   */
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

    // And both ends are rare, which is the whole point of there being a hump.
    const atPeak = buckets.get(Math.floor(GUARD_PEAK * TENTHS))!;
    expect(buckets.get(Math.floor(MIN_GUARD_SHARE * TENTHS))!).toBeLessThan(atPeak / 2);
    expect(buckets.get(TENTHS - 1)!).toBeLessThan(atPeak / 2);
  });

  /**
   * A triangle's mean is the average of its three corners. Worth stating,
   * because it is the number an author is really choosing when they type a
   * defence — what armour is worth on average, rather than at its best.
   */
  it("is worth the average of its three corners over many draws", () => {
    const rng = new Rng(99);
    let total = 0;
    const draws = 200_000;
    for (let i = 0; i < draws; i++) total += guardFraction(rng.next());
    expect(total / draws).toBeCloseTo((MIN_GUARD_SHARE + GUARD_PEAK + 1) / 3, 2);
  });

  /** Whole numbers, because hit points are and this is subtracted from one. */
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
  /**
   * The fight every authored number was tuned against. One attacker has to leave
   * the block exactly as it was, or every creature in the world quietly changes
   * the day this lands.
   */
  it("costs a body nothing at all when only one thing is on it", () => {
    const defender = battler({ flee: 60, def: 10 });

    expect(guardShare(0)).toBe(1);
    expect(guardShare(1)).toBe(1);
    expect(underPressure(defender, 1)).toBe(defender);
  });

  /**
   * The reported bug, as arithmetic: eight rats were exactly one rat, eight
   * times over.
   */
  it("takes evasion and armour down together as the crowd grows", () => {
    const defender = battler({ flee: 60, def: 12, resist: { sharp: 8 } });
    const crowded = underPressure(defender, 8);

    expect(crowded.flee).toBeLessThan(defender.flee / 3);
    expect(crowded.def).toBeLessThan(defender.def / 3);
    // The resistances go with the flat armour, or being surrounded is survivable
    // by wearing the right coat. @see defenceAgainst
    expect(defenceAgainst(crowded, battler({ mastery: "sharp" }))).toBeLessThan(
      defenceAgainst(defender, battler({ mastery: "sharp" })) / 3,
    );
  });

  /** Hit points are whole, so what is subtracted from them has to be. */
  it("leaves a whole number of armour behind", () => {
    for (let assailants = 1; assailants <= 12; assailants++) {
      const crowded = underPressure(
        battler({ def: 17, resist: { blunt: 5 } }),
        assailants,
      );
      expect(Number.isInteger(crowded.def)).toBe(true);
      expect(Number.isInteger(crowded.resist.blunt ?? 0)).toBe(true);
    }
  });

  /**
   * The shape of the curve, which is the whole reason it is hyperbolic: the
   * second body on you is the one that costs, and no crowd is ever large enough
   * to leave you with nothing.
   */
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

  /**
   * End to end through the swing: a bite that armour swallowed on its own draws
   * blood once there are enough of them. This is the fight the player actually
   * had.
   *
   * Defence far above the blow, so that even {@link MIN_GUARD_SHARE} of it is
   * more than the whole bite — the point being made is about the crowd, and a
   * defence the low end of the band already lets through would make it about the
   * draw instead.
   */
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
  /**
   * Over many seeds rather than one, because **nothing is certain any more**:
   * every probability is floored at {@link MIN_CHANCE}, so no stat block can
   * promise that a given swing connects. What is asserted is the invariant — a
   * blow that cannot get through armour is worth nothing, never a heal.
   *
   * Armour twenty times the blow, so that even the shallowest draw is more than
   * the whole of it. That is what being untouchable costs now: not defence equal
   * to a blow, but defence whose {@link MIN_GUARD_SHARE} is.
   */
  it("takes defence off the top and never heals", () => {
    const attacker = battler({ damage: 5, accuracy: 100, hitChance: 1 });
    const defender = battler({ def: 100, flee: 0 });
    expect(guardBand(defender, attacker).lowest).toBeGreaterThanOrEqual(5);
    for (let seed = 0; seed < 50; seed++) {
      expect(rollAttack(attacker, defender, new Rng(seed)).damage).toBe(0);
    }
  });

  /**
   * And the flip side, which is the whole reason the draw exists: armour worth
   * exactly the blow no longer stops it. Under the old flat rule this was
   * immunity, and it was reachable in the starting kit.
   */
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

  /**
   * Every swing that actually lands, rather than every swing: with a floor under
   * both the whiff and the dodge, some of these come to nothing however the stats
   * are written. The claim is about the arithmetic of a blow that connects — a
   * fixed blow against a *drawn* guard, so what is fixed is the band it lands in
   * and both of that band's ends are reached.
   */
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
    // Every rung of the band, not merely a range that happens to hold: a draw
    // that never reached one end would be a wobble that is not really there.
    expect([...drawn].sort((a, b) => a - b)).toEqual([5, 6, 7, 8]);
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
  it("costs the same five draws whatever the stats", () => {
    const reference = new Rng(7);
    for (let i = 0; i < 5; i++) reference.next();
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
 * Armour that cares what hit it.
 *
 * **Two numbers, added, and the kind decides whether the second one counts.**
 * The claim these make is the asymmetry: the same armour has to be worth more
 * against one weapon than against another, or the whole feature is a flat bonus
 * with extra bookkeeping. The kind is the attacker's *weapon* mastery and never
 * the wielder's best skill, which is the second claim — a novice with a sword is
 * still striking with a blade, and mail should turn it aside on the same terms.
 */
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

  /**
   * The one that matters in play: the same shirt against two weapons that are
   * identical apart from what they are made of.
   */
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

    // The same seed both ways round, so the guard draw is the same draw and the
    // only thing left between the two numbers is which band it was drawn from.
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

  /** A resistance deeper than the blow is worth is a blow worth nothing. */
  it("never heals, however much of it there is", () => {
    const attacker = battler({ damage: 5, accuracy: 100, hitChance: 1, mastery: "arcane" });
    const warded = battler({ def: 0, resist: { arcane: 100 }, flee: 0 });
    for (let seed = 0; seed < 50; seed++) {
      expect(rollAttack(attacker, warded, new Rng(seed)).damage).toBe(0);
    }
  });

  /**
   * The dice again: resistance is read, never rolled for, so a warded defender
   * must cost a swing exactly what a bare one does.
   */
  it("costs the swing no extra draws", () => {
    const reference = new Rng(11);
    rollAttack(battler({ mastery: "sharp" }), battler(), reference);
    const after = reference.save();

    const rng = new Rng(11);
    rollAttack(
      battler({ mastery: "sharp" }),
      battler({ resist: { sharp: 40, blunt: 3 } }),
      rng,
    );
    expect(rng.save()).toBe(after);
  });
});

/**
 * What a blow leaves behind after the hit points have moved.
 *
 * A percentage is the kind of number nobody can eyeball: a venom that fires
 * every time and a venom that never fires both look like "a snake bit me" from
 * inside the game, and only a count over many swings can tell them apart. These
 * are the claims the field makes, written where they can fail.
 */
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

  /**
   * The one case that would otherwise be decided by the stat with least to do
   * with it: a fang that cannot get through armour still went in far enough to
   * be a fang.
   */
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
      accuracy: 0,
      hitChance: 1,
      statuses: [certain],
    });
    for (let seed = 0; seed < 20; seed++) {
      const missed = rollAttack(missing, battler({ flee: 0 }), new Rng(seed));
      const dodged = rollAttack(dodgeable, battler({ flee: 100 }), new Rng(seed));
      if (missed.missed) expect(missed.inflicted).toEqual([]);
      expect(dodged.dodged).toBe(true);
      expect(dodged.inflicted).toEqual([]);
    }
  });

  /**
   * A tenth, near enough — the snake's bite as `data/tiles.json` authors it.
   * Counted over blows that landed, since a miss was never eligible.
   */
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

  /**
   * The same discipline the four draws above are under, one step further: a
   * weapon's list decides how many draws a swing costs, and nothing about how
   * the swing turned out may. Otherwise a snake that missed and a snake that bit
   * would leave the world's dice in different places.
   */
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

  /**
   * Rolled per entry rather than once for the list, so a weapon that inflicts
   * two things is not a weapon that inflicts both or neither.
   */
  it("decides each authored status on its own draw", () => {
    const attacker = battler({
      ...connects,
      statuses: [certain, never, { id: "fed", chance: 100 }],
    });
    const defender = battler({ flee: 0 });
    for (let seed = 0; seed < 50; seed++) {
      const outcome = rollAttack(attacker, defender, new Rng(seed));
      if (outcome.missed || outcome.dodged) continue;
      expect(outcome.inflicted.map((status) => status.id)).toEqual([
        "poison",
        "fed",
      ]);
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
        // And nothing was left behind either — a blow that touched nobody
        // cannot have poisoned them.
        inflicted: [],
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
  const melee = MELEE_REACH;

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
   * default exists to draw, and the reason it takes two numbers rather than one
   * radius. See `./distance`.
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
   * The diagonal lands exactly on 2 and the cell two along exactly on 4, which
   * is why the plan comparison is squared and never square-rooted: both walls
   * are exact, and the radius sits between them with room on either side.
   */
  it("keeps the boundary case inside", () => {
    expect(planDistanceSq(here, at(1, 1, 0))).toBe(2);
    expect(melee.cells * melee.cells).toBeGreaterThan(2);
    expect(melee.cells * melee.cells).toBeLessThan(4);
  });

  /**
   * **The whole reason reach is two numbers.** A bow reaches across the yard
   * without also reaching three storeys straight up — a shape no single radius
   * can draw, whatever height is weighted at. @see `./distance`
   */
  it("widens the disc without raising the lid", () => {
    const bow: Reach = { cells: 6, height: HEIGHT_PER_LEVEL };
    expect(inAttackRange(here, at(4, 0, 0), bow)).toBe(true);
    expect(inAttackRange(here, at(6, 0, 0), bow)).toBe(true);
    expect(inAttackRange(here, at(7, 0, 0), bow)).toBe(false);

    // One storey either way, and the storey above that is out — however close
    // on the plan it is, and even directly overhead.
    expect(inAttackRange(here, at(0, 0, HEIGHT_PER_LEVEL), bow)).toBe(true);
    expect(inAttackRange(here, at(5, 0, HEIGHT_PER_LEVEL), bow)).toBe(true);
    expect(inAttackRange(here, at(0, 0, 2 * HEIGHT_PER_LEVEL), bow)).toBe(false);
  });

  /** A weapon that can only reach its own floor, which the pair can now say. */
  it("draws a flat disc when the height is nothing", () => {
    const flat: Reach = { cells: 4, height: 0 };
    expect(inAttackRange(here, at(3, 0, 0), flat)).toBe(true);
    expect(inAttackRange(here, at(3, 0, 1), flat)).toBe(false);
  });
});
