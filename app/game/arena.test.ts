import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import { resolveBattler } from "../lib/battler";
import { resolveWeapon } from "../lib/item";
import { normalizeTiles } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { duelSetupOf, equipmentOf, fighterForTile, statsOf, swingsOf } from "./arena";

describe("what the Arena reports", () => {
  const tilesById = tilesByIdFromList(normalizeTiles(tilesJson as unknown[]));

  const armed = (weapon: string | null, offhand: string | null = null) => {
    const fighter = fighterForTile("player", tilesById);
    return {
      ...fighter,
      equipment: { ...fighter.equipment, weapon, offhand },
    };
  };

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

  it("swings once per hand for a body fighting with two", () => {
    const swings = swingsOf(armed("knights-sword", "simple-hammer"), tilesById);

    expect(swings).toHaveLength(2);
    expect(swings.map((swing) => swing.mastery)).toEqual(["sharp", "blunt"]);
    expect(swings[0]!.damage).not.toBe(swings[1]!.damage);
  });

  it("does not count a hand holding a shield or a torch", () => {
    for (const inert of ["iron-shield", "hand-lantern"]) {
      const swings = swingsOf(armed("knights-sword", inert), tilesById);
      expect(swings).toHaveLength(1);
      expect(swings[0]!.mastery).toBe("sharp");
    }
  });

  it("agrees with itself about what the body is", () => {
    const swings = swingsOf(armed("knights-sword", "simple-hammer"), tilesById);
    expect(swings[1]!.maxHp).toBe(swings[0]!.maxHp);
    expect(swings[1]!.flee).toBe(swings[0]!.flee);
    expect(swings[1]!.def).toBe(swings[0]!.def);
  });

  it("counts a shield's guard without giving it a swing", () => {
    const alone = statsOf(armed("knights-sword"), tilesById)!;
    const guarded = statsOf(armed("knights-sword", "iron-shield"), tilesById)!;
    const shield = tilesById["iron-shield"]!;

    expect(guarded.damage).toBe(alone.damage);
    expect(guarded.def).toBeGreaterThan(alone.def);
    expect(shield).toBeDefined();
  });

  it("holds what a hand will take, and swings only what is a weapon", () => {
    const carrying = armed("cloth-tunic");
    expect(equipmentOf(carrying, tilesById).weapon?.tileId).toBe("cloth-tunic");
    expect(swingsOf(carrying, tilesById)).toHaveLength(1);
    expect(statsOf(carrying, tilesById)!.mastery).toBe("fist");
  });

  it("ignores a worn square naming something it will not take", () => {
    const muddled = fighterForTile("player", tilesById);
    const wrong = {
      ...muddled,
      equipment: { ...muddled.equipment, armor: "knights-sword" },
    };
    expect(equipmentOf(wrong, tilesById).armor).toBeNull();
  });

  it("brings the body's immunities into the duel", () => {
    const immune = resolveBattler(tilesById.cyclops!)!.immuneTo;
    expect(immune?.length).toBeGreaterThan(0);
    expect(duelSetupOf(fighterForTile("cyclops", tilesById), tilesById).immuneTo).toEqual(immune);
  });

  it("has nothing to say about a tile that is not a battler", () => {
    const rock = fighterForTile("stone-wall", tilesById);
    expect(statsOf(rock, tilesById)).toBeNull();
    expect(swingsOf(rock, tilesById)).toEqual([]);
  });
});
