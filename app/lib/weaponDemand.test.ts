import { describe, expect, it } from "vitest";
import { weaponDemand, weaponDemandFor } from "./weaponDemand";
import { REQUIREMENT_FALLOFF } from "./battler";
import { xpForLevel } from "./mastery";
import { normalizeTileDef } from "./types";

/**
 * What a player is told about a weapon they cannot use.
 *
 * This replaced a sentence — "You can hardly wield it" — and the whole point of
 * the replacement is that the numbers are not guessable: requirements pool, and
 * the falloff is cubed. So the assertions here are about *the facts being
 * present*, not about phrasing: which mastery, how short, and what share of the
 * weapon that comes to.
 */

const sword = (requirements: Record<string, number> | undefined) =>
  normalizeTileDef({
    id: "sword",
    name: "Sword",
    kind: "item",
    interactions: {
      item: {
        type: "weapon",
        damage: 10,
        def: 0,
        accuracy: 80,
        variance: 20,
        spd: 50,
        mastery: "blade",
        ...(requirements ? { requirements } : {}),
      },
    },
  });

describe("weaponDemand", () => {
  it("says nothing at all about a weapon that asks nothing", () => {
    expect(weaponDemand({ blade: 50 }, undefined)).toEqual([]);
    expect(weaponDemand({ blade: 50 }, {})).toEqual([]);
    // A requirement of zero reads as absent, as everywhere else.
    expect(weaponDemand({ blade: 50 }, { blade: 0 })).toEqual([]);
  });

  /** The question the sentence could not answer: *which* one, and by how much. */
  it("names every requirement and how far short of it you are", () => {
    const lines = weaponDemand({ blade: 12 }, { blade: 20, toughness: 10 });
    expect(lines).toContain("Blade 20 — you have 12");
    expect(lines).toContain("Toughness 10 — you have 0");
  });

  it("says so when a requirement is met rather than going quiet", () => {
    const lines = weaponDemand({ blade: 30 }, { blade: 20 });
    expect(lines).toContain("Blade 20 — met");
  });

  /**
   * The share is the load-bearing line. Pooled requirements and a cubed falloff
   * mean nobody arrives at it in their head — being most of the way there is
   * emphatically not most of the weapon.
   */
  it("states the share of the weapon you are actually getting", () => {
    const lines = weaponDemand({ blade: 10 }, { blade: 20 });
    const share = Math.round(0.5 ** REQUIREMENT_FALLOFF * 100);
    expect(lines).toContain(`You get ${share}% out of it`);
    // And that it is well under the half a linear reading would suggest.
    expect(share).toBeLessThan(50);
  });

  it("reads a hundred percent once everything is met", () => {
    expect(weaponDemand({ blade: 20, toughness: 10 }, { blade: 20, toughness: 10 })).toContain(
      "You get 100% out of it",
    );
  });

  /** A surplus in one mastery never covers a shortfall in another. */
  it("does not let a mastered blade stand in for missing toughness", () => {
    const lines = weaponDemand({ blade: 100, toughness: 0 }, { blade: 20, toughness: 20 });
    expect(lines).toContain("Toughness 20 — you have 0");
    expect(lines).not.toContain("You get 100% out of it");
  });
});

describe("weaponDemandFor", () => {
  it("says nothing about anything that is not a weapon", () => {
    const rock = normalizeTileDef({ id: "rock", name: "Rock", kind: "prop" });
    expect(weaponDemandFor(rock, {})).toEqual([]);
    expect(weaponDemandFor(undefined, {})).toEqual([]);
  });

  /**
   * Levels are read out of experience rather than passed in, so the sword on the
   * floor and the sword in your bag cannot disagree about the same hands.
   */
  it("reads the wielder's level out of their experience", () => {
    const demand = weaponDemandFor(sword({ blade: 20 }), { blade: xpForLevel(12) });
    expect(demand).toContain("Blade 20 — you have 12");
  });
});
