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

  it("leaves an untrained body something to start with", () => {
    expect(maxHpFrom(DEFAULT_BASE_HP, 0)).toBeGreaterThan(0);
    expect(fleeFrom(0)).toBeGreaterThan(0);
  });

  it("lets evasion run past the percent scale, since it is not a chance", () => {
    expect(fleeFrom(1000)).toBeGreaterThan(100);
  });
});

describe("hitChanceFrom", () => {
  it("reads accuracy straight off as a probability", () => {
    expect(hitChanceFrom(100)).toBe(MAX_CHANCE);
    expect(hitChanceFrom(50)).toBeCloseTo(0.5, 10);
  });

  it("never drops to nothing however outclassed the wielder is", () => {
    expect(hitChanceFrom(0)).toBe(MIN_CHANCE);
    expect(hitChanceFrom(0.01)).toBe(MIN_CHANCE);
  });

  it("never reaches certainty either", () => {
    expect(hitChanceFrom(100)).toBe(MAX_CHANCE);
    expect(hitChanceFrom(500)).toBe(MAX_CHANCE);
  });
});

describe("what a weapon is worth in the hand", () => {
  it("takes the profile at face value when nothing is asked of an untrained body", () => {
    const stats = fightingStats(body({ blunt: 0 }), weapon());
    expect(stats.damage).toBe(100);
    expect(stats.spd).toBe(100);
    expect(stats.accuracy).toBe(100);
    expect(stats.hitChance).toBe(MAX_CHANCE);
  });

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

  it("costs a flat slice of accuracy and rate for each point short", () => {
    const short = body({ blunt: 20 });
    const twenty = fightingStats(short, weapon({ requirements: { blunt: 40 } }));
    const two = fightingStats(short, weapon({ requirements: { blunt: 22 } }));
    const whole = fightingStats(short, weapon());

    expect(twenty.accuracy).toBe(Math.round(whole.accuracy * weaponHandling(20)));
    expect(twenty.haste).toBeCloseTo(whole.haste * weaponHandling(20), 10);
    expect(two.haste).toBeCloseTo(whole.haste * weaponHandling(2), 10);
    expect(weaponHandling(2)).toBeCloseTo(0.9, 10);
    expect(weaponHandling(20)).toBe(MIN_HANDLING);
    expect(twenty.damage).toBe(whole.damage);
    expect(two.damage).toBe(whole.damage);
  });

  it("is the authored profile the moment the requirement is met", () => {
    const barely = fightingStats(body({ blunt: 40 }), weapon({ requirements: { blunt: 40 } }));
    const far = fightingStats(body({ blunt: 100 }), weapon({ requirements: { blunt: 40 } }));
    expect(barely.spd).toBe(100);
    expect(far.haste).toBe(barely.haste);
  });

  it("pays skill on damage and accuracy long past the requirement", () => {
    const master = fightingStats(body({ blunt: 100 }), weapon({ requirements: { blunt: 1 } }));
    const novice = fightingStats(body({ blunt: 1 }), weapon({ requirements: { blunt: 1 } }));

    expect(master.damage).toBeGreaterThan(novice.damage);
    expect(master.accuracy).toBeGreaterThan(novice.accuracy);
    expect(master.damage).toBe(
      Math.round(100 + 100 * MASTERY_DAMAGE_BONUS + DAMAGE_AT_MAX_MASTERY),
    );
    expect(master.accuracy).toBe(
      Math.round(100 + 100 * MASTERY_ACCURACY_BONUS + ACCURACY_AT_MAX_MASTERY),
    );
  });

  it("gives a master no extra aim from a weapon they cannot lift", () => {
    const requirements = { blunt: 5, toughness: 100 };
    const stats = fightingStats(body({ blunt: 100, toughness: 0 }), weapon({ requirements }));
    const able = fightingStats(body({ blunt: 100, toughness: 100 }), weapon({ requirements }));

    expect(stats.accuracy).toBe(Math.round(able.accuracy * weaponHandling(100)));
    expect(stats.hitChance).toBeLessThan(able.hitChance);
    expect(stats.damage).toBe(able.damage);
    expect(able.damage).toBeGreaterThan(100);
  });

  it("leaves a weapon authored at no damage doing none, however skilled", () => {
    for (const blunt of [0, 50, 100]) {
      const shield = fightingStats(body({ blunt }), weapon({ damage: 0 }));
      expect(shield.damage).toBe(0);
    }
    expect(fightingStats(body({ blunt: 100 }), weapon({ damage: 1 })).damage).toBeGreaterThan(1);
  });

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
    expect(master.accuracy).toBeGreaterThan(100);
    expect(master.hitChance).toBe(MAX_CHANCE);
  });

  it("is as bad as it gets for a weapon with no precision at all", () => {
    const stats = fightingStats(body({ blunt: 0 }), weapon({ accuracy: 0 }));
    expect(stats.hitChance).toBe(MIN_CHANCE);
  });

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

  it("counts a requirement the weapon does not train, pooled with the others", () => {
    const stats = fightingStats(
      body({ blunt: 35, toughness: 10 }),
      weapon({ requirements: { blunt: 35, toughness: 20 } }),
    );
    const whole = fightingStats(body({ blunt: 35, toughness: 10 }), weapon());
    expect(stats.haste).toBeCloseTo(whole.haste * weaponHandling(10), 10);
    expect(stats.accuracy).toBeLessThan(whole.accuracy);
    expect(stats.hitChance).toBeLessThan(MAX_CHANCE);
  });
});

describe("what a spell is worth in the hand", () => {
  it("reads Arcane alone for a spell with no element", () => {
    expect(castingSkill({ arcane: 40 }, undefined)).toBeCloseTo(0.4, 6);
    expect(castingSkill({ arcane: 40 }, { toughness: 10 })).toBeCloseTo(0.4, 6);
  });

  it("averages Arcane with the elements the stone asks for", () => {
    expect(castingSkill({ arcane: 100, fire: 0 }, { fire: 1 })).toBeCloseTo(0.5, 6);
    expect(castingSkill({ arcane: 0, fire: 100 }, { fire: 1 })).toBeCloseTo(0.5, 6);
    expect(castingSkill({ arcane: 60, fire: 40 }, { fire: 1 })).toBeCloseTo(0.5, 6);
  });

  it("counts every element a two-element stone names", () => {
    expect(castingSkill({ arcane: 90, water: 90, nature: 0 }, { water: 8, nature: 8 })).toBeCloseTo(
      0.6,
      6,
    );
  });

  it("pays a share of the stone and a flat amount, exactly as a weapon does", () => {
    expect(spellPower(20, { fire: 1 }, { arcane: 100, fire: 100 })).toBeCloseTo(
      20 * (1 + MASTERY_DAMAGE_BONUS) + DAMAGE_AT_MAX_MASTERY,
      6,
    );
  });

  it("is the authored number for a body with nothing trained", () => {
    expect(spellPower(20, { fire: 1 }, {})).toBe(20);
    expect(spellPower(-20, { fire: 1 }, {})).toBe(-20);
  });

  it("makes a mend deeper rather than shallower", () => {
    const novice = spellPower(-20, undefined, {});
    const master = spellPower(-20, undefined, { arcane: 100 });
    expect(master).toBeLessThan(novice);
    expect(master).toBeCloseTo(-(20 * (1 + MASTERY_DAMAGE_BONUS) + DAMAGE_AT_MAX_MASTERY), 6);
  });
});

describe("battlerIssues", () => {
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
