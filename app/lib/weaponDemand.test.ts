import { describe, expect, it } from "vitest";
import { weaponDemand, weaponDemandFor } from "./weaponDemand";
import { MIN_HANDLING, weaponHandling } from "./battler";
import { xpForLevel } from "./mastery";
import { normalizeTileDef } from "./types";

/**
 * What a player is told about a weapon they cannot use.
 *
 * This replaced a sentence — "You can hardly wield it" — and the whole point of
 * the replacement is that the numbers are not guessable: the points missing are
 * pooled across every mastery a weapon asks for. So the assertions here are
 * about *the facts being present*, not about phrasing: which mastery, how short,
 * what that costs, and what it does not.
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
        mastery: "sharp",
        ...(requirements ? { requirements } : {}),
      },
    },
  });

describe("weaponDemand", () => {
  it("says nothing at all about a weapon that asks nothing", () => {
    expect(weaponDemand({ sharp: 50 }, undefined)).toEqual([]);
    expect(weaponDemand({ sharp: 50 }, {})).toEqual([]);
    // A requirement of zero reads as absent, as everywhere else.
    expect(weaponDemand({ sharp: 50 }, { sharp: 0 })).toEqual([]);
  });

  /** The question the sentence could not answer: *which* one, and by how much. */
  it("names every requirement and how far short of it you are", () => {
    const lines = weaponDemand({ sharp: 12 }, { sharp: 20, toughness: 10 });
    expect(lines).toContain("Sharp 20 — you have 12");
    expect(lines).toContain("Toughness 10 — you have 0");
  });

  it("says so when a requirement is met rather than going quiet", () => {
    const lines = weaponDemand({ sharp: 30 }, { sharp: 20 });
    expect(lines).toContain("Sharp 20 — met");
  });

  /**
   * The handling line is the load-bearing one, and it names damage because
   * damage is the surprising half: the points missing are pooled across every
   * mastery a weapon asks for, so nobody arrives at the percentage in their
   * head, and a player who is not told the weapon still hits for everything it
   * is written to hit for will put it back down.
   */
  it("states what falling short actually costs, and what it does not", () => {
    // Ten points short of Sharp 20, at a twentieth apiece.
    const lines = weaponDemand({ sharp: 10 }, { sharp: 20 });
    const handling = Math.round(weaponHandling(10) * 100);
    expect(lines).toContain(`${handling}% accuracy and swing rate; full damage`);
    expect(handling).toBe(50);
    expect(handling).toBeGreaterThan(Math.round(MIN_HANDLING * 100));
  });

  it("says so plainly once everything is met", () => {
    expect(weaponDemand({ sharp: 20, toughness: 10 }, { sharp: 20, toughness: 10 })).toContain(
      "Full accuracy and swing rate",
    );
  });

  /** A surplus in one mastery never covers a shortfall in another. */
  it("does not let a mastered sharp stand in for missing toughness", () => {
    const lines = weaponDemand({ sharp: 100, toughness: 0 }, { sharp: 20, toughness: 20 });
    expect(lines).toContain("Toughness 20 — you have 0");
    expect(lines).not.toContain("Full accuracy and swing rate");
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
    const demand = weaponDemandFor(sword({ sharp: 20 }), { sharp: xpForLevel(12) });
    expect(demand).toContain("Sharp 20 — you have 12");
  });
});
