import { describe, expect, it } from "vitest";
import { MELEE_REACH } from "./item";
import {
  learningRate,
  MASTERY_BRIDGE,
  MAX_MASTERY,
  trainingCeiling,
  xpForLevel,
} from "./mastery";
import { masteryMargin, weaponFeel, weaponFeelFor } from "./weaponFeel";
import type { TileDef } from "./types";

/**
 * The sentence a player is told instead of a table.
 *
 * Worth asserting for the same reason `masteryRatio` is: it returns a plausible
 * line whatever it does, so a band that has quietly moved reads as a copy choice
 * rather than as a bug. What is pinned here is the *shape* of the ladder — which
 * requirement speaks, and where the rungs are relative to `MASTERY_BRIDGE` —
 * rather than the wording, which is free to change without any of this moving.
 */

describe("masteryMargin", () => {
  it("has nothing to say about a weapon that asks nothing", () => {
    expect(masteryMargin({ blade: 50 }, undefined)).toBeNull();
    expect(masteryMargin({ blade: 50 }, {})).toBeNull();
    // Asked for zero is not asked for at all, on the same terms `masteryRatio`
    // reads it — otherwise a block that had been through the editor and back
    // would report a margin of 50 against a requirement nobody wrote.
    expect(masteryMargin({ blade: 50 }, { blade: 0 })).toBeNull();
  });

  it("is how far past the requirement you stand", () => {
    expect(masteryMargin({ blade: 8 }, { blade: 5 })).toBe(3);
    expect(masteryMargin({ blade: 2 }, { blade: 5 })).toBe(-3);
    expect(masteryMargin({}, { blade: 5 })).toBe(-5);
  });

  /**
   * **The worst requirement decides**, which is the rule most likely to
   * surprise: an axe asking for a mastery it does not train is held back by it
   * exactly as `masteryRatio` says it is, and a line read off the mastery the
   * weapon teaches would tell a player their Blunt is fine while the thing stays
   * unliftable.
   */
  it("answers for whichever requirement is furthest behind", () => {
    expect(masteryMargin({ blunt: 40, toughness: 12 }, { blunt: 35, toughness: 20 })).toBe(-8);
  });
});

describe("weaponFeel", () => {
  it("says nothing at all about a weapon that asks nothing", () => {
    expect(weaponFeel({ blade: 50 }, undefined)).toBeNull();
  });

  /**
   * Every rung, as the band it opens and the one it closes. The distances are
   * one, two and four bridges, the same either side of the gate — and the band
   * around the gate itself is a bridge wide in both directions, which is what
   * makes "you can wield it" the answer for a wielder who merely meets it.
   */
  it("puts its rungs one, two and four bridges either side", () => {
    const REQUIREMENT = 40;
    const asks = { blade: REQUIREMENT };
    const at = (margin: number) =>
      weaponFeel({ blade: REQUIREMENT + margin }, asks);

    const rungs = [
      4 * MASTERY_BRIDGE,
      2 * MASTERY_BRIDGE,
      MASTERY_BRIDGE,
      1 - MASTERY_BRIDGE,
      1 - 2 * MASTERY_BRIDGE,
      1 - 4 * MASTERY_BRIDGE,
    ];

    for (const rung of rungs) {
      // The band a rung opens runs from it up to the next one, and the point
      // just below it belongs to the band underneath.
      expect(at(rung)).not.toBe(at(rung - 1));
    }
    // Seven bands, each distinct, from the top of the scale to the bottom.
    const said = new Set([
      at(MAX_MASTERY),
      ...rungs.map(at),
      at(-MAX_MASTERY),
    ]);
    expect(said.size).toBe(7);
  });

  /** Nothing past the ends of the ladder says anything new. */
  it("reads alike however far past either end you are", () => {
    expect(weaponFeel({ blade: 100 }, { blade: 20 })).toBe(
      weaponFeel({ blade: 60 }, { blade: 20 }),
    );
    expect(weaponFeel({}, { blade: 40 })).toBe(weaponFeel({}, { blade: 100 }));
  });

  /** Meeting a requirement exactly is meeting it, and reads as nothing else. */
  it("is plain about a wielder who exactly meets what is asked", () => {
    expect(weaponFeel({ blade: 5 }, { blade: 5 })).toBe("You can wield it");
  });

  /**
   * The ladder is the same height at every tier, which is the whole reason the
   * bands are counted in points rather than as fractions of what is asked. A
   * quarter short is one point on a dagger and twenty on an endgame blade; five
   * short is five short.
   */
  it("reads the same for the same shortfall whatever the weapon asks", () => {
    expect(weaponFeel({ blade: 3 }, { blade: 5 })).toBe(
      weaponFeel({ blade: 78 }, { blade: 80 }),
    );
  });

  it("distinguishes a weapon you have outgrown from one that merely fits", () => {
    expect(weaponFeel({ blade: 5 }, { blade: 5 })).not.toBe(
      weaponFeel({ blade: 80 }, { blade: 5 }),
    );
  });

  /**
   * The rung a bridge above what a weapon asks is its training ceiling — see
   * `./mastery`'s `learningRate`. Pinned here because the two are one decision:
   * the point a weapon stops teaching you at full rate is the point it starts
   * feeling easy, and a band that drifted off it would say otherwise.
   */
  it("turns confident exactly where the weapon stops teaching at full rate", () => {
    const ceiling = trainingCeiling(20);
    expect(learningRate(ceiling, 20)).toBe(1);
    expect(learningRate(ceiling + 1, 20)).toBeLessThan(1);
    expect(weaponFeel({ blade: ceiling }, { blade: 20 })).not.toBe(
      weaponFeel({ blade: ceiling - 1 }, { blade: 20 }),
    );
  });
});

/** A tile carrying nothing but the block the sentence is read out of. */
function weaponTile(requirements: Record<string, number> | undefined): TileDef {
  return {
    id: "test-sword",
    name: "Test Sword",
    height: 0,
    type: "simple",
    kind: "item",
    attributes: {},
    sprite: { frames: [] },
    interactions: {
      item: {
        type: "weapon",
        damage: 8,
        def: 0,
        spd: 50,
        accuracy: 80,
        variance: 20,
        reach: MELEE_REACH,
        mastery: "blade",
        ...(requirements ? { requirements } : {}),
      },
    },
  } as TileDef;
}

describe("weaponFeelFor", () => {
  it("says nothing about a tile that is not a weapon", () => {
    expect(weaponFeelFor(undefined, { blade: xpForLevel(50) })).toBeNull();
  });

  /**
   * Levels come out of the experience rather than being passed in, so a slot and
   * the world's look label cannot come to disagree about what a player has —
   * which is the same reason the experience is what travels on the wire.
   */
  it("reads the wielder's level out of what they have earned", () => {
    const sword = weaponTile({ blade: 5 });
    expect(weaponFeelFor(sword, { blade: xpForLevel(5) })).toBe(
      weaponFeel({ blade: 5 }, { blade: 5 }),
    );
    expect(weaponFeelFor(sword, {})).toBe(weaponFeel({}, { blade: 5 }));
  });

  it("stays quiet about a weapon with no requirements at all", () => {
    expect(weaponFeelFor(weaponTile(undefined), { blade: xpForLevel(9) })).toBeNull();
  });
});
