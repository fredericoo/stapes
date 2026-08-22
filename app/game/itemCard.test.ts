import { describe, expect, it } from "vitest";
import { fightingStats, weaponReadiness } from "../lib/battler";
import { MELEE_REACH, type ItemDef, type WeaponItem } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { masteriesFromXp, xpForLevel, type MasteryXp } from "../lib/mastery";
import type { StatusDef } from "../lib/status";
import type { TileDef } from "../lib/types";
import { attackIntervalMs, swingIntervalMs } from "./combat";
import { itemCard, type ItemCardStat } from "./itemCard";

/**
 * What a player is told about a thing before they bet their life on it.
 *
 * The figures are asserted **against the engine that produces them** rather than
 * against hard-coded numbers wherever one exists — `fightingStats`,
 * `swingIntervalMs` and `weaponReadiness` are re-run here and the card is
 * checked to agree with them.
 * Pinning literals instead would turn every balance change into a failing card
 * test, and worse, would let the card go on being confidently wrong the day
 * somebody tuned the falloff without touching this file.
 *
 * What *is* pinned literally is the shape a reader depends on: which rows
 * appear, in which order, which of them carry the item's own figure alongside
 * yours, and that nothing is ever said about a status the catalogue has lost.
 */

const SWORD: WeaponItem = {
  type: "weapon",
  damage: 12,
  def: 0,
  accuracy: 86,
  variance: 40,
  spd: 52,
  reach: { ...MELEE_REACH },
  mastery: "blade",
  requirements: { blade: 20 },
};

function tileWith(item: ItemDef, over: Partial<TileDef> = {}): TileDef {
  return {
    id: "thing",
    name: "Thing",
    kind: "item",
    interactions: { item },
    ...over,
  } as TileDef;
}

function statAt(stats: ItemCardStat[], key: string): ItemCardStat {
  const stat = stats.find((row) => row.key === key);
  if (!stat) throw new Error(`no ${key} row: ${stats.map((s) => s.key).join(", ")}`);
  return stat;
}

const NOTHING_LEARNT: MasteryXp = {};

/** A body carrying nothing but these masteries — what the card is asked *for*. */
function bodyWith(masteryXp: MasteryXp) {
  return {
    masteries: masteriesFromXp(masteryXp),
    naturalWeapon: SWORD,
    sight: { up: 0, down: 0 },
  };
}

/** The card's own rounding, so an expectation cannot disagree about a half. */
function percentOf(fraction: number): number {
  return Math.round(fraction * 100);
}

describe("itemCard", () => {
  it("says nothing about a tile that is not an item", () => {
    expect(itemCard(tileWith(SWORD, { kind: "prop" }), null, NOTHING_LEARNT)).toBeNull();
  });

  it("names the tile and the hand, never the instance", () => {
    const instance: ItemInstance = {
      id: "1",
      tileId: "thing",
      description: "Left here by someone",
    };
    const card = itemCard(tileWith(SWORD), instance, NOTHING_LEARNT);

    // The two are kept apart on the terms `../render/GameRenderer`'s `lookLines`
    // keeps them apart: what it is and what is written on it are two questions,
    // and a card answering the second in place of the first would leave a player
    // unable to find out what they had picked up.
    expect(card?.name).toBe("Thing");
    expect(card?.description).toBe("Left here by someone");
    expect(card?.kind).toBe("One hand — Blade");
  });

  it("says how many hands it costs", () => {
    // The fact that decides whether it can be in a kit at all: a two-hander
    // refuses the other square outright — see `../lib/item`'s `twoHanded`.
    const card = itemCard(tileWith({ ...SWORD, twoHanded: true }), null, NOTHING_LEARNT);
    expect(card?.kind).toBe("Both hands — Blade");
  });

  /**
   * **The whole point of the card.** Every figure is what the reader would get,
   * not what is stamped on the weapon — so a novice holding a sword they cannot
   * swing is told what they would actually do with it, and the weapon's own
   * number rides alongside as the thing to aim at.
   */
  it("gives the figures the reader would actually get, with the weapon's own beside them", () => {
    const novice = { blade: xpForLevel(5) };
    const card = itemCard(tileWith(SWORD), null, novice);
    const yours = fightingStats(
      { masteries: masteriesFromXp(novice), naturalWeapon: SWORD, sight: { up: 0, down: 0 } },
      SWORD,
    );

    expect(statAt(card!.stats, "damage").value).toBe(`${yours.damage}`);
    expect(statAt(card!.stats, "damage").base).toBe(`${SWORD.damage}`);
    expect(statAt(card!.stats, "damage").tone).toBe("bad");
    expect(yours.damage).toBeLessThan(SWORD.damage);

    expect(statAt(card!.stats, "hit").value).toBe(`${Math.round(yours.hitChance * 100)}%`);
    expect(statAt(card!.stats, "hit").base).toBe(`${SWORD.accuracy}%`);
  });

  /**
   * The one row that reads the other way round: a shorter wait between blows is
   * a better weapon, so the tone has to be inverted where the figure is not.
   *
   * **Both directions come from different places now.** Falling short of what a
   * weapon asks drags `spd` down through `weaponReadiness`; going *faster* than
   * the weapon's own rate is Agility's doing and nothing else's — see
   * `../lib/battler`'s `haste`, which `spd` has no room to carry. So the slow
   * case is a novice and the fast case is a quick body that has met the gate.
   */
  it("reads a shorter wait between blows as the better one", () => {
    const novice = itemCard(tileWith(SWORD), null, { blade: xpForLevel(5) })!;
    expect(statAt(novice.stats, "speed").tone).toBe("bad");

    const quick = { blade: xpForLevel(20), agility: xpForLevel(60) };
    const card = itemCard(tileWith(SWORD), null, quick)!;
    const hastened = swingIntervalMs(fightingStats(bodyWith(quick), SWORD));

    expect(statAt(card.stats, "speed").tone).toBe("good");
    expect(statAt(card.stats, "speed").value).toBe(
      `${Number((hastened / 1000).toFixed(1))}s`,
    );
    expect(hastened).toBeLessThan(attackIntervalMs(SWORD.spd));
  });

  it("leaves the item's own figure off a row that matches it", () => {
    // A weapon that asks nothing, in hands that have learnt nothing: readiness
    // is full, the skill bonus is zero, and what comes out is the weapon as
    // written. A card printing "12 (12)" would invite a reader to look for a
    // difference that is not there.
    const plain: WeaponItem = { ...SWORD, requirements: undefined };
    const card = itemCard(tileWith(plain), null, NOTHING_LEARNT)!;

    expect(statAt(card.stats, "damage").value).toBe(`${plain.damage}`);
    expect(statAt(card.stats, "damage").base).toBeUndefined();
    expect(statAt(card.stats, "damage").tone).toBe("plain");
    // Variance is never scaled by anything, so this row has no second figure to
    // compare against whoever is holding it.
    expect(statAt(card.stats, "spread").base).toBeUndefined();
  });

  /**
   * **Meeting the gate is not the ceiling, and the card has to show that.**
   * Requirements stop paying the moment they are met, but being good with a
   * blade goes on paying — see `../lib/battler`'s `MASTERY_DAMAGE_BONUS`. So a
   * master's figures run *past* the numbers stamped on the weapon, which is the
   * one case where the struck-through base is the smaller of the two.
   */
  it("runs past the weapon's own numbers in a master's hands", () => {
    const master = { blade: xpForLevel(90) };
    const card = itemCard(tileWith(SWORD), null, master)!;
    const yours = fightingStats(bodyWith(master), SWORD);

    expect(yours.damage).toBeGreaterThan(SWORD.damage);
    expect(statAt(card.stats, "damage")).toMatchObject({
      value: `${yours.damage}`,
      base: `${SWORD.damage}`,
      tone: "good",
    });
    // And the share still reads a flat hundred, because the gate is open and
    // there is nothing further to open.
    expect(card.effectiveness).toBe(100);
  });

  it("names an arm's length rather than measuring it, and says when something is fired", () => {
    expect(statAt(itemCard(tileWith(SWORD), null, NOTHING_LEARNT)!.stats, "reach").value).toBe(
      "Melee",
    );

    const bow: WeaponItem = {
      ...SWORD,
      mastery: "ranged",
      reach: { cells: 6, height: 2 },
      projectile: { tileId: "arrow", cellsPerSecond: 20 },
    };
    expect(statAt(itemCard(tileWith(bow), null, NOTHING_LEARNT)!.stats, "reach").value).toBe(
      "6 cells, fired",
    );
  });

  it("keeps quiet about defence until there is some", () => {
    const plain = itemCard(tileWith(SWORD), null, NOTHING_LEARNT)!;
    expect(plain.stats.some((row) => row.key === "def")).toBe(false);

    const shield = itemCard(tileWith({ ...SWORD, def: 3 }), null, NOTHING_LEARNT)!;
    expect(statAt(shield.stats, "def").value).toBe("3 a blow");
  });

  /**
   * **The worst requirement leads**, on exactly the terms `masteryRatio` and
   * `weaponFeel` use it: the one thing standing between a reader and the weapon
   * is the first line they read, and a list in declaration order would bury it
   * under the ones already met.
   */
  it("puts the requirement furthest behind first, and marks what is met", () => {
    const axe: WeaponItem = { ...SWORD, requirements: { blunt: 35, toughness: 20 } };
    const card = itemCard(tileWith(axe), null, {
      blunt: xpForLevel(34),
      toughness: xpForLevel(8),
    })!;

    expect(card.requirements.map((row) => row.mastery)).toEqual(["toughness", "blunt"]);
    expect(card.requirements[0]).toMatchObject({ required: 20, have: 8, met: false });
    expect(card.requirements[1]).toMatchObject({ required: 35, have: 34, met: false });

    const met = itemCard(tileWith(axe), null, {
      blunt: xpForLevel(40),
      toughness: xpForLevel(40),
    })!;
    expect(met.requirements.every((row) => row.met)).toBe(true);
  });

  it("reads a requirement of zero as no requirement at all", () => {
    // The same reading `masteryRatio` gives it — otherwise a block that had been
    // through the editor and back would grow a row nobody authored.
    const card = itemCard(
      tileWith({ ...SWORD, requirements: { blade: 0 } }),
      null,
      NOTHING_LEARNT,
    )!;
    expect(card.requirements).toEqual([]);
    expect(card.effectiveness).toBe(100);
  });

  /**
   * The number the requirements alone cannot tell you, and the reason it is
   * worth printing: the share is pooled and the falloff is cubed, so nobody is
   * arriving at it by arithmetic in their head. Half way to what the sword asks
   * is an eighth of the sword.
   */
  it("puts how much of the weapon you get in the unit the player asked for", () => {
    const share = (level: number) =>
      itemCard(tileWith(SWORD), null, { blade: xpForLevel(level) })!.effectiveness;

    expect(share(10)).toBe(percentOf(weaponReadiness(0.5)));
    expect(share(10)).toBe(13);
    expect(share(16)).toBe(percentOf(weaponReadiness(0.8)));

    // **A gate, not a scaling term.** Meeting every requirement is worth all of
    // the weapon, and exceeding them is worth nothing more here — being good
    // with a blade goes on paying through the figures above instead. See
    // `../lib/mastery`'s `REQUIREMENTS_MET`.
    expect(share(20)).toBe(100);
    expect(share(99)).toBe(100);
  });

  it("has no such question about anything that is not a weapon", () => {
    const card = itemCard(
      tileWith({ type: "consumable", label: "Eat", hp: 5 }),
      null,
      NOTHING_LEARNT,
    )!;
    expect(card.effectiveness).toBeNull();
    expect(card.kind).toBe("Eat");
    expect(statAt(card.stats, "hp")).toMatchObject({
      label: "Restores",
      value: "5 health",
      tone: "good",
    });
  });

  it("says a poison costs you rather than restores you", () => {
    const card = itemCard(
      tileWith({ type: "consumable", hp: -6 }),
      null,
      NOTHING_LEARNT,
    )!;
    expect(statAt(card.stats, "hp")).toMatchObject({
      label: "Costs",
      value: "6 health",
      tone: "bad",
    });
  });

  it("counts a container against its capacity, not its contents", () => {
    const instance: ItemInstance = {
      id: "1",
      tileId: "thing",
      contents: [{ id: "2", tileId: "apple" }],
    };
    const card = itemCard(
      tileWith({ type: "container", size: 4, equippable: true }),
      instance,
      NOTHING_LEARNT,
    )!;
    expect(statAt(card.stats, "slots").value).toBe("1 / 4");
    expect(statAt(card.stats, "worn").value).toBe("On your back");
  });

  describe("what an item leaves behind", () => {
    const VENOM: StatusDef = {
      id: "venom",
      name: "Venom",
      description: "Saps a little health",
      tone: "bad",
      fromMs: 10_000,
      toMs: 30_000,
      stacks: false,
      maxMs: 60_000,
      everyMs: 1_000,
      effects: {},
      modifiers: {},
      vfx: { tint: null, particles: null, light: null, taperMs: 0 },
    };

    it("names it, and how often and how long", () => {
      const fang: WeaponItem = { ...SWORD, statuses: [{ id: "venom", chance: 10 }] };
      const card = itemCard(tileWith(fang), null, NOTHING_LEARNT, { venom: VENOM })!;

      expect(card.effects).toEqual([
        {
          id: "venom",
          name: "Venom",
          description: "Saps a little health",
          tone: "bad",
          chance: 10,
          duration: "10s–30s",
        },
      ]);
    });

    it("prefers the item's own duration over the status's", () => {
      const loaf: ItemDef = {
        type: "consumable",
        hp: 2,
        statuses: [{ id: "venom", fromMs: 60_000, toMs: 60_000 }],
      };
      const card = itemCard(tileWith(loaf), null, NOTHING_LEARNT, { venom: VENOM })!;
      expect(card.effects[0]).toMatchObject({ duration: "60s", chance: null });
    });

    /**
     * A tenth is worth printing at the bottom of the scale and is noise at the
     * top — "5.0s–20s" reads as one end having lost its precision.
     */
    it("shows a decimal only where one says something", () => {
      const snack: ItemDef = {
        type: "consumable",
        hp: 1,
        statuses: [{ id: "venom", fromMs: 5_000, toMs: 20_000 }],
      };
      expect(
        itemCard(tileWith(snack), null, NOTHING_LEARNT, { venom: VENOM })!.effects[0]!
          .duration,
      ).toBe("5s–20s");

      const brief: ItemDef = {
        type: "consumable",
        hp: 1,
        statuses: [{ id: "venom", fromMs: 1_500, toMs: 1_500 }],
      };
      expect(
        itemCard(tileWith(brief), null, NOTHING_LEARNT, { venom: VENOM })!.effects[0]!
          .duration,
      ).toBe("1.5s");
    });

    /**
     * A status the catalogue has lost reads as an effect that did not happen —
     * the same answer every other reader of a status id gives, and the reason a
     * renamed status cannot take a card down with it.
     */
    it("says nothing about a status the world no longer has", () => {
      const fang: WeaponItem = { ...SWORD, statuses: [{ id: "gone", chance: 10 }] };
      expect(itemCard(tileWith(fang), null, NOTHING_LEARNT, { venom: VENOM })!.effects).toEqual(
        [],
      );
    });
  });

  /**
   * The whole card by the other route. A screen reader is told the same content
   * as a sighted one, which is what lets the drawing be `aria-hidden` — see
   * `../components/ItemCard`.
   */
  it("says the same thing aloud", () => {
    const card = itemCard(tileWith(SWORD), null, { blade: xpForLevel(5) })!;
    expect(card.speech).toContain("Thing");
    expect(card.speech).toContain("One hand — Blade");
    expect(card.speech).toContain("Requires blade 20, you have 5");
    expect(card.speech).toContain(`You get ${card.effectiveness}% out of it`);
    // The item's own figure as a clause, because a screen reader reads "(12)" as
    // "twelve" and the comparison disappears.
    expect(card.speech).toContain("where the item's own is 12");
  });
});
