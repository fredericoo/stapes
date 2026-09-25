import { describe, expect, it } from "vitest";
import {
  ACCURACY_AT_MAX_MASTERY,
  battlerIssues,
  castingSkill,
  DAMAGE_AT_MAX_MASTERY,
  DEFAULT_BASE_HP,
  DEFAULT_BATTLER,
  fightingStats,
  fleeFrom,
  hitChanceFrom,
  maxHpFrom,
  MAX_CHANCE,
  MIN_CHANCE,
  MASTERY_ACCURACY_BONUS,
  MASTERY_DAMAGE_BONUS,
  MIN_HANDLING,
  weaponHandling,
  spellPower,
  resolveBattler,
} from "./battler";
import { MELEE_REACH, MIN_STONE_COOLDOWN_MS, type WeaponItem } from "./item";
import { tile } from "./testTile";

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
    reach: MELEE_REACH,
    mastery: "blunt",
    ...overrides,
  };
}

function body(masteries: Record<string, number>) {
  return { ...DEFAULT_BATTLER, masteries };
}

describe("hit points and flee", () => {
  it("grow with the masteries they come from", () => {
    expect(maxHpFrom(DEFAULT_BASE_HP, 0)).toBeLessThan(maxHpFrom(DEFAULT_BASE_HP, 1));
    expect(fleeFrom(0)).toBeLessThan(fleeFrom(1));
  });

  /**
   * Neither floor is zero. A mastery of zero is a novice, not a corpse — and a
   * body has to survive long enough to train the thing.
   */
  it("leaves an untrained body something to start with", () => {
    expect(maxHpFrom(DEFAULT_BASE_HP, 0)).toBeGreaterThan(0);
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
  it("reads accuracy straight off as a probability", () => {
    expect(hitChanceFrom(100)).toBe(MAX_CHANCE);
    expect(hitChanceFrom(50)).toBeCloseTo(0.5, 10);
  });

  /**
   * The floor is the whole reason a mastery can be started at all: experience
   * comes from landing blows, so a weapon that never lands can never teach the
   * mastery it asks for.
   */
  it("never drops to nothing however outclassed the wielder is", () => {
    expect(hitChanceFrom(0)).toBe(MIN_CHANCE);
    expect(hitChanceFrom(0.01)).toBe(MIN_CHANCE);
  });

  /** Nothing is ever certain, so even a perfect swing can go wide. */
  it("never reaches certainty either", () => {
    expect(hitChanceFrom(100)).toBe(MAX_CHANCE);
    expect(hitChanceFrom(500)).toBe(MAX_CHANCE);
  });
});

/**
 * What a weapon is worth in a given pair of hands.
 *
 * Two axes, and keeping them apart is the whole design:
 *
 * - **Handling** — how many points of what the weapon asks you are missing, at a
 *   flat slice off each. It scales accuracy and the swing rate and never damage,
 *   and it caps at fully met. A requirement is a gate on how well you swing the
 *   thing, not on how hard it lands.
 * - **Skill** — the absolute level of the mastery the weapon answers to. It adds
 *   damage and accuracy and never speed, and it goes on paying long after the
 *   requirement stopped mattering.
 */
describe("what a weapon is worth in the hand", () => {
  it("takes the profile at face value when nothing is asked of an untrained body", () => {
    const stats = fightingStats(body({ blunt: 0 }), weapon());
    expect(stats.damage).toBe(100);
    expect(stats.spd).toBe(100);
    expect(stats.accuracy).toBe(100);
    expect(stats.hitChance).toBe(MAX_CHANCE);
  });

  /**
   * **A weapon you have not earned is clumsy and slow, and never weak.** This is
   * the fairness rule the whole shortfall is now built around: the weapon you
   * are short of is the harder-hitting weapon — that is why you reached for it —
   * so taking its damage away made the rung below strictly better and left the
   * requirement a wall to wait behind rather than a thing to reach for.
   *
   * Handling floors at {@link MIN_HANDLING} rather than at zero, so even a
   * wielder who brings nothing at all still swings — slowly and wildly, and for
   * the blade's full damage.
   *
   * **The rate is `haste` and never `spd`.** `spd` is a position on a curve
   * running 100:1 from end to end, so docking it by a half is not half the rate
   * but a third of it — and handling is quoted to the player as a share of their
   * swing rate. The weapon keeps its authored `spd`; the share goes where a
   * share of the rate is what it means.
   *
   * Forty points short is well past the floor, which is reached at seventeen.
   */
  it("leaves a weapon far beyond its wielder clumsy and slow, not weak", () => {
    const asked = weapon({ requirements: { blunt: 40 } });
    const stats = fightingStats(body({ blunt: 0 }), asked);
    const unasked = fightingStats(body({ blunt: 0 }), weapon());

    expect(stats.damage).toBe(unasked.damage);
    expect(stats.spd).toBe(asked.spd);
    expect(stats.accuracy).toBe(Math.round(100 * MIN_HANDLING));
    expect(stats.haste).toBeCloseTo(unasked.haste * MIN_HANDLING, 10);
    expect(stats.hitChance).toBeLessThan(unasked.hitChance);
  });

  /**
   * **A flat slice per point short, so two points short means the same thing
   * wherever a player is standing.** That is what a share could not do: two
   * points short of Blunt 10 is 80% of it and two short of Blunt 33 is 94%, so
   * any curve on the share charges the same shortfall differently at every rung.
   */
  it("costs a flat slice of accuracy and rate for each point short", () => {
    const short = body({ blunt: 20 });
    const twenty = fightingStats(short, weapon({ requirements: { blunt: 40 } }));
    const two = fightingStats(short, weapon({ requirements: { blunt: 22 } }));
    const whole = fightingStats(short, weapon());

    expect(twenty.accuracy).toBe(Math.round(whole.accuracy * weaponHandling(20)));
    expect(twenty.haste).toBeCloseTo(whole.haste * weaponHandling(20), 10);
    expect(two.haste).toBeCloseTo(whole.haste * weaponHandling(2), 10);
    // Two points is a tenth off, twenty is all the way down to the floor.
    expect(weaponHandling(2)).toBeCloseTo(0.9, 10);
    expect(weaponHandling(20)).toBe(MIN_HANDLING);
    // And the damage is untouched by any of it.
    expect(twenty.damage).toBe(whole.damage);
    expect(two.damage).toBe(whole.damage);
  });

  /**
   * At the requirement the weapon is *whole* — every one of its authored numbers
   * is on the table. Anything beyond that is the wielder rather than the weapon.
   */
  it("is the authored profile the moment the requirement is met", () => {
    const barely = fightingStats(body({ blunt: 40 }), weapon({ requirements: { blunt: 40 } }));
    const far = fightingStats(body({ blunt: 100 }), weapon({ requirements: { blunt: 40 } }));
    expect(barely.spd).toBe(100);
    // The rate is handling and Agility only — no skill term — so meeting the
    // requirement is all the weapon can give.
    expect(far.haste).toBe(barely.haste);
  });

  /**
   * **Being good with a weapon keeps paying after its requirement has stopped.**
   * The half of mastery a gate cannot express: a hundred-Sharp hero and a
   * five-Sharp novice both meet a requirement-1 dagger in full, and should not
   * swing it identically.
   */
  it("pays skill on damage and accuracy long past the requirement", () => {
    const master = fightingStats(body({ blunt: 100 }), weapon({ requirements: { blunt: 1 } }));
    const novice = fightingStats(body({ blunt: 1 }), weapon({ requirements: { blunt: 1 } }));

    expect(master.damage).toBeGreaterThan(novice.damage);
    expect(master.accuracy).toBeGreaterThan(novice.accuracy);
    // A flat share plus a quarter of what the weapon brings.
    expect(master.damage).toBe(
      Math.round(100 + 100 * MASTERY_DAMAGE_BONUS + DAMAGE_AT_MAX_MASTERY),
    );
    expect(master.accuracy).toBe(
      Math.round(100 + 100 * MASTERY_ACCURACY_BONUS + ACCURACY_AT_MAX_MASTERY),
    );
  });

  /**
   * **A hole in the gate, closed.** The skill bonus has a flat term that does not
   * depend on the weapon, and while it sat outside handling a Blunt 100 hero
   * could pick up something whose *other* requirement they came nowhere near and
   * still aim it as well as anything else. Handling multiplies the accuracy side
   * of the skill bonus as well, so being good with maces cannot cancel out being
   * short of this one.
   *
   * Damage is exempt on purpose — see the shortfall rule above — so what a
   * master loses on a weapon they cannot lift is aim and pace, not force.
   */
  it("gives a master no extra aim from a weapon they cannot lift", () => {
    const requirements = { blunt: 5, toughness: 100 };
    // Blunt mastered outright, and not one point of the Toughness the weapon
    // also asks for.
    const stats = fightingStats(body({ blunt: 100, toughness: 0 }), weapon({ requirements }));
    // And the same body with the Toughness for it gets everything.
    const able = fightingStats(body({ blunt: 100, toughness: 100 }), weapon({ requirements }));

    // A hundred points of Toughness short, which is long past the floor.
    expect(stats.accuracy).toBe(Math.round(able.accuracy * weaponHandling(100)));
    expect(stats.hitChance).toBeLessThan(able.hitChance);
    expect(stats.damage).toBe(able.damage);
    expect(able.damage).toBeGreaterThan(100);
  });

  /**
   * **An author's zero is the author speaking.** A shield goes in the main hand,
   * where it replaces what you swing — that is what makes taking one up a
   * decision rather than three free points. The flat half of the skill bonus
   * does not depend on the weapon's own damage, so without this rule a skilled
   * body chipped away at things with a shield, and the trade quietly stopped
   * being a trade.
   */
  it("leaves a weapon authored at no damage doing none, however skilled", () => {
    for (const blunt of [0, 50, 100]) {
      const shield = fightingStats(body({ blunt }), weapon({ damage: 0 }));
      expect(shield.damage).toBe(0);
    }
    // And a weapon that does *any* damage is still paid the bonus in full.
    expect(fightingStats(body({ blunt: 100 }), weapon({ damage: 1 })).damage).toBeGreaterThan(1);
  });

  /** Speed is Agility's to give, and mastery of the weapon may not pay it twice. */
  it("gives skill no say over speed", () => {
    const master = fightingStats(
      body({ blunt: 100 }),
      weapon({ spd: 50, requirements: { blunt: 40 } }),
    );
    const met = fightingStats(
      body({ blunt: 40 }),
      weapon({ spd: 50, requirements: { blunt: 40 } }),
    );
    expect(master.spd).toBe(met.spd);
  });

  /**
   * **Accuracy is scaled now, where it used to pass through untouched.** It is
   * both the input to a hit chance and what a defender's evasion is contested
   * against, so a master is harder to dodge as well as harder to escape — and a
   * body swinging something it cannot lift is easy to read.
   */
  it("moves accuracy with both handling and skill", () => {
    const outclassed = fightingStats(
      body({ blunt: 10 }),
      weapon({ accuracy: 80, requirements: { blunt: 40 } }),
    );
    const met = fightingStats(
      body({ blunt: 40 }),
      weapon({ accuracy: 80, requirements: { blunt: 40 } }),
    );
    const master = fightingStats(
      body({ blunt: 100 }),
      weapon({ accuracy: 80, requirements: { blunt: 40 } }),
    );

    expect(outclassed.accuracy).toBeLessThan(met.accuracy);
    expect(master.accuracy).toBeGreaterThan(met.accuracy);
    // Past the percent scale, deliberately: the ceiling on a *chance* is
    // `MAX_CHANCE`, and holding accuracy at 100 as well would be a second one.
    expect(master.accuracy).toBeGreaterThan(100);
    expect(master.hitChance).toBe(MAX_CHANCE);
  });

  it("is as bad as it gets for a weapon with no precision at all", () => {
    const stats = fightingStats(body({ blunt: 0 }), weapon({ accuracy: 0 }));
    expect(stats.hitChance).toBe(MIN_CHANCE);
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
    const gated = fightingStats(body(masteries), weapon({ requirements: { blunt: 90 } }));

    expect(bare.maxHp).toBe(maxHpFrom(DEFAULT_BATTLER.baseHp, 30));
    expect(gated.maxHp).toBe(bare.maxHp);
    expect(gated.flee).toBe(bare.flee);
  });

  /**
   * A requirement on a mastery the weapon never trains still counts, and it is
   * pooled with the rest: what a wielder is short of is added up across every
   * mastery a weapon asks for, so a surplus of Blunt cannot pay for the missing
   * Toughness.
   */
  it("counts a requirement the weapon does not train, pooled with the others", () => {
    const stats = fightingStats(
      body({ blunt: 35, toughness: 10 }),
      weapon({ requirements: { blunt: 35, toughness: 20 } }),
    );
    // Asserted on `haste`, which is the one of the two that is not rounded on
    // the way out. Ten points of Toughness missing and none of Blunt, so the
    // pooled shortfall is ten however mastered the Blunt is.
    const whole = fightingStats(body({ blunt: 35, toughness: 10 }), weapon());
    expect(stats.haste).toBeCloseTo(whole.haste * weaponHandling(10), 10);
    expect(stats.accuracy).toBeLessThan(whole.accuracy);
    expect(stats.hitChance).toBeLessThan(MAX_CHANCE);
  });
});

/**
 * What a stone is worth in somebody's hands.
 *
 * The caster's half of the same question the suite above asks about a weapon,
 * and the cases are chosen for what makes it a *different* question: two
 * masteries rather than one, a sign that can go either way, and a requirement
 * block that is read for what the spell is made of rather than for whether it
 * may be cast at all.
 */
describe("what a spell is worth in the hand", () => {
  /** A spell made of nothing is thrown as well as you throw magic. */
  it("reads Arcane alone for a spell with no element", () => {
    expect(castingSkill({ arcane: 40 }, undefined)).toBeCloseTo(0.4, 6);
    expect(castingSkill({ arcane: 40 }, { toughness: 10 })).toBeCloseTo(0.4, 6);
  });

  /**
   * **Both halves, averaged, and neither can stand in for the other.** A great
   * arcanist who has never thrown fire throws mediocre fire, and somebody with
   * nothing but Fire has nothing to point it with.
   */
  it("averages Arcane with the elements the stone asks for", () => {
    expect(castingSkill({ arcane: 100, fire: 0 }, { fire: 1 })).toBeCloseTo(0.5, 6);
    expect(castingSkill({ arcane: 0, fire: 100 }, { fire: 1 })).toBeCloseTo(0.5, 6);
    expect(castingSkill({ arcane: 60, fire: 40 }, { fire: 1 })).toBeCloseTo(0.5, 6);
  });

  /**
   * A two-element spell is thrown at the average of three numbers, which is what
   * makes breadth genuinely harder rather than merely more expensive: training
   * one half of it buys you a third of the spell.
   */
  it("counts every element a two-element stone names", () => {
    expect(castingSkill({ arcane: 90, water: 90, nature: 0 }, { water: 8, nature: 8 })).toBeCloseTo(
      0.6,
      6,
    );
  });

  /**
   * The same two terms a weapon gets, against the same two constants — which is
   * the whole of "a spell scales like a weapon".
   */
  it("pays a share of the stone and a flat amount, exactly as a weapon does", () => {
    expect(spellPower(20, { fire: 1 }, { arcane: 100, fire: 100 })).toBeCloseTo(
      20 * (1 + MASTERY_DAMAGE_BONUS) + DAMAGE_AT_MAX_MASTERY,
      6,
    );
  });

  /** Somebody who has learnt nothing gets exactly what the author wrote. */
  it("is the authored number for a body with nothing trained", () => {
    expect(spellPower(20, { fire: 1 }, {})).toBe(20);
    expect(spellPower(-20, { fire: 1 }, {})).toBe(-20);
  });

  /**
   * **The sign survives and the magnitude grows.** A mend is a harm with a minus
   * in front of it, so mastery has to make it *deeper* — a flat term added
   * without regard to the sign would have a master's stone of life mending less
   * than a novice's, and eventually mending nothing at all.
   */
  it("makes a mend deeper rather than shallower", () => {
    const novice = spellPower(-20, undefined, {});
    const master = spellPower(-20, undefined, { arcane: 100 });
    expect(master).toBeLessThan(novice);
    expect(master).toBeCloseTo(-(20 * (1 + MASTERY_DAMAGE_BONUS) + DAMAGE_AT_MAX_MASTERY), 6);
  });
});

describe("battlerIssues", () => {
  /** A spell that parses, for each case below to break one field of. */
  const SPELL = {
    type: "stone",
    name: "Snap",
    effect: { kind: "bolt", on: "caster", damage: -1 },
    cooldownMs: MIN_STONE_COOLDOWN_MS,
  };

  function beast(spell: Record<string, unknown>) {
    return tile({
      id: "beast",
      kind: "battler",
      interactions: { battler: { ...DEFAULT_BATTLER, spells: [spell] } },
    });
  }

  it("says nothing about a block that resolves", () => {
    const def = beast(SPELL);
    expect(resolveBattler(def)).not.toBeNull();
    expect(battlerIssues(def)).toEqual([]);
  });

  it.each([
    ["a cast time of zero", { castTimeMs: 0 }, "spells[0].castTimeMs"],
    [
      "a cooldown under the floor",
      { cooldownMs: MIN_STONE_COOLDOWN_MS - 1 },
      "spells[0].cooldownMs",
    ],
    ["a bolt that does nothing", { effect: { kind: "bolt", on: "caster" } }, "spells[0].effect"],
    [
      "a status override with one end",
      {
        effect: {
          kind: "bolt",
          on: "caster",
          statuses: [{ id: "burn", chance: 100, fromMs: 1000 }],
        },
      },
      "spells[0].effect.statuses[0]",
    ],
  ])("names the field when %s drops the whole block", (_, broken, path) => {
    const def = beast({ ...SPELL, ...broken });
    expect(resolveBattler(def)).toBeNull();
    // Every line, not one: a status override missing an end fails two checks
    // on the same object, and both belong to it.
    const issues = battlerIssues(def);
    expect(issues).not.toHaveLength(0);
    for (const line of issues) expect(line.startsWith(`${path}: `)).toBe(true);
  });

  it("reports a battler with no block, since that resolves to nothing too", () => {
    const def = tile({ id: "beast", kind: "battler" });
    expect(resolveBattler(def)).toBeNull();
    expect(battlerIssues(def)).toHaveLength(1);
  });

  it("ignores a block on a tile whose kind is not battler, as the resolver does", () => {
    const def = tile({
      id: "rock",
      interactions: { battler: { ...DEFAULT_BATTLER, spells: [{ ...SPELL, castTimeMs: 0 }] } },
    });
    expect(battlerIssues(def)).toEqual([]);
  });
});
