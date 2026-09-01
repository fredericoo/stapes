import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import { resolveWeapon } from "../lib/item";
import { normalizeTiles } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { equipmentOf, fighterForTile, statsOf, swingsOf } from "./arena";

/**
 * The tuner's numbers, against the world we ship.
 *
 * **This file exists because the Arena silently stopped reading equipment and
 * nothing noticed.** When both hands learnt to swing, `statsOf` was handed
 * `null` for the hand — which does not mean "no hand in particular", it means
 * bare hands — so every fighter reported its natural weapon whatever was in its
 * hands, and every unit below `arena.ts` went on passing because none of them
 * went through it. A tuner that quietly answers a different question than the
 * one on screen is worse than no tuner, so the claims here are deliberately the
 * dull ones: that what you put in a hand is what the row reports.
 */
describe("what the Arena reports", () => {
  const tilesById = tilesByIdFromList(normalizeTiles(tilesJson as unknown[]));

  const armed = (weapon: string | null, offhand: string | null = null) => {
    const fighter = fighterForTile("player", tilesById);
    return {
      ...fighter,
      equipment: { ...fighter.equipment, weapon, offhand },
    };
  };

  /** The regression, stated as plainly as it can be. */
  it("reports the weapon in hand rather than the body's own", () => {
    const bare = statsOf(armed(null), tilesById)!;
    const sworded = statsOf(armed("knights-sword"), tilesById)!;
    const sword = resolveWeapon(tilesById["knights-sword"]!)!;

    expect(bare.mastery).toBe("fist");
    expect(sworded.mastery).toBe(sword.mastery);
    expect(sworded.damage).not.toBe(bare.damage);
  });

  it("swings once for a body with one weapon, or none", () => {
    expect(swingsOf(armed("knights-sword"), tilesById)).toHaveLength(1);
    expect(swingsOf(armed(null), tilesById)).toHaveLength(1);
  });

  /**
   * The case that sent somebody looking: a sword and a hammer, expecting to see
   * both. One row per hand, each answering to its own mastery.
   */
  it("swings once per hand for a body fighting with two", () => {
    const swings = swingsOf(armed("knights-sword", "simple-hammer"), tilesById);

    expect(swings).toHaveLength(2);
    expect(swings.map((swing) => swing.mastery)).toEqual(["blade", "blunt"]);
    expect(swings[0]!.damage).not.toBe(swings[1]!.damage);
  });

  /** A hand that will not swing is not a turn, so it is not a row either. */
  it("does not count a hand holding a shield or a torch", () => {
    for (const inert of ["iron-shield", "hand-lantern"]) {
      const swings = swingsOf(armed("knights-sword", inert), tilesById);
      expect(swings).toHaveLength(1);
      expect(swings[0]!.mastery).toBe("blade");
    }
  });

  /**
   * **The hand changes the blow and never the body.** The duel takes `maxHp`
   * off whichever entry it happens to hold, so a rotation that disagreed with
   * itself here would give a body two different amounts of health depending on
   * which fist it started with.
   */
  it("agrees with itself about what the body is", () => {
    const swings = swingsOf(armed("knights-sword", "simple-hammer"), tilesById);
    expect(swings[1]!.maxHp).toBe(swings[0]!.maxHp);
    expect(swings[1]!.flee).toBe(swings[0]!.flee);
    // Guard is both hands plus what is worn, so it does not move either.
    expect(swings[1]!.def).toBe(swings[0]!.def);
  });

  /** A shield still guards, even though it never takes a turn. */
  it("counts a shield's guard without giving it a swing", () => {
    const alone = statsOf(armed("knights-sword"), tilesById)!;
    const guarded = statsOf(armed("knights-sword", "iron-shield"), tilesById)!;
    const shield = tilesById["iron-shield"]!;

    expect(guarded.damage).toBe(alone.damage);
    expect(guarded.def).toBeGreaterThan(alone.def);
    expect(shield).toBeDefined();
  });

  /**
   * **A hand holds a tunic and fights with its fists**, which is two rules
   * meeting rather than a mistake: a hand takes anything you can carry — see
   * `./equipment`'s `handAccepts`, which refuses only a chest — and only a
   * weapon takes a turn. So the square keeps what it was given and the body
   * swings what it was born with.
   */
  it("holds what a hand will take, and swings only what is a weapon", () => {
    const carrying = armed("cloth-tunic");
    expect(equipmentOf(carrying, tilesById).weapon?.tileId).toBe("cloth-tunic");
    expect(swingsOf(carrying, tilesById)).toHaveLength(1);
    expect(statsOf(carrying, tilesById)!.mastery).toBe("fist");
  });

  /** A square that refuses on kind comes back empty rather than wrong. */
  it("ignores a worn square naming something it will not take", () => {
    const muddled = fighterForTile("player", tilesById);
    const wrong = {
      ...muddled,
      equipment: { ...muddled.equipment, armor: "knights-sword" },
    };
    expect(equipmentOf(wrong, tilesById).armor).toBeNull();
  });

  it("has nothing to say about a tile that is not a battler", () => {
    const rock = fighterForTile("stone-wall", tilesById);
    expect(statsOf(rock, tilesById)).toBeNull();
    expect(swingsOf(rock, tilesById)).toEqual([]);
  });
});
