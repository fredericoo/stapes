import { describe, expect, it } from "vitest";
import { DEFAULT_BASE_HP, fightingStats } from "../lib/battler";
import { MELEE_REACH, type ItemDef, type WeaponItem } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { MASTERY_LABELS, masteriesFromXp, xpForLevel, type MasteryXp } from "../lib/mastery";
import { constantFormula } from "../lib/formula";
import type { StatusDef } from "../lib/status";
import { bandLabel, termLabel, type TermKey } from "../lib/terms";
import { weaponDemandFor } from "../lib/weaponDemand";
import type { TileDef } from "../lib/types";
import { attackIntervalMs, damageBand, damageBandOf, swingIntervalMs } from "./combat";
import { itemCard, type ItemCardStat } from "./itemCard";

/**
 * What a player is told about a thing before they bet their life on it.
 *
 * The figures are asserted **against the engine that produces them** rather than
 * against hard-coded numbers wherever one exists — `fightingStats`,
 * `swingIntervalMs` and `damageBand` are re-run here and the card is checked to
 * agree with them.
 * Pinning literals instead would turn every balance change into a failing card
 * test, and worse, would let the card go on being confidently wrong the day
 * somebody tuned the handling rule without touching this file.
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
  mastery: "sharp",
  requirements: { sharp: 20 },
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

function statAt(stats: ItemCardStat[], term: TermKey): ItemCardStat {
  const stat = stats.find((row) => row.term === term);
  if (!stat) {
    throw new Error(`no ${term} row: ${stats.map((s) => s.term).join(", ")}`);
  }
  return stat;
}

const NOTHING_LEARNT: MasteryXp = {};

/** What a weapon asks of its own mastery, which is the card's baseline body. */
const GATE = SWORD.requirements!.sharp!;

/** A body carrying nothing but these masteries — what the card is asked *for*. */
function bodyWith(masteryXp: MasteryXp) {
  return {
    // Never read: a card is about a weapon, and hit points are the one figure
    // on it that belongs to whoever is holding it.
    baseHp: DEFAULT_BASE_HP,
    masteries: masteriesFromXp(masteryXp),
    naturalWeapon: SWORD,
    sight: { up: 0, down: 0 },
  };
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
    expect(card?.kind).toBe("One hand — Sharp");
  });

  it("says how many hands it costs", () => {
    // The fact that decides whether it can be in a kit at all: a two-hander
    // refuses the other square outright — see `../lib/item`'s `twoHanded`.
    const card = itemCard(tileWith({ ...SWORD, twoHanded: true }), null, NOTHING_LEARNT);
    expect(card?.kind).toBe("Both hands — Sharp");
  });

  /**
   * **The whole point of the card.** Every figure is what the reader would get,
   * and what rides alongside is what somebody who has *just earned* the weapon
   * gets — a real body, and the thing to aim at.
   *
   * **Not the authored figure, which is nobody's.** `../lib/battler`'s
   * `damageAtMastery` scales its terms by the absolute level of the weapon's
   * mastery, so `SWORD.damage` belongs to a wielder at Sharp 0 — who, since the
   * sword asks Sharp 20, cannot hold it. A card striking that through against
   * yours was asking you to compare yourself with a hand that never held one.
   */
  it("gives the figures the reader would get, against a wielder who has just earned it", () => {
    const novice = { sharp: xpForLevel(5) };
    const card = itemCard(tileWith(SWORD), null, novice)!;
    const yours = fightingStats(bodyWith(novice), SWORD);
    const fresh = fightingStats(bodyWith({ sharp: xpForLevel(GATE) }), SWORD);

    expect(statAt(card.stats, "hit").value).toBe(`${Math.round(yours.hitChance * 100)}%`);
    expect(statAt(card.stats, "hit").base).toBe(`${Math.round(fresh.hitChance * 100)}%`);
    expect(statAt(card.stats, "hit").tone).toBe("bad");

    // The band rather than the face value, through the same `damageBand` the
    // stats panel reports a body's blow with — a card that quoted `damage` on
    // its own would be quoting a number no blow is ever worth.
    const band = damageBand(yours);
    const theirs = damageBand(fresh);
    expect(statAt(card.stats, "damage").value).toBe(bandLabel(band.min, band.max));
    expect(statAt(card.stats, "damage").base).toBe(bandLabel(theirs.min, theirs.max));
  });

  /**
   * **Meeting a requirement exactly leaves one figure on the rows the gate
   * governs**, which is the whole of what the baseline is for. You *are* the
   * wielder the card compares against, so there is no gap, and a second number
   * would be inviting a reader to look for one.
   *
   * This is the case that kept being reported as a bug: a battleaxe at exactly
   * Sharp 33 read "32–64" struck through against "38–76", and the 32–64 was the
   * figure a body at Sharp 0 would roll if one could lift it.
   */
  it("strikes nothing through for a wielder who exactly meets the gate", () => {
    const card = itemCard(tileWith(SWORD), null, { sharp: xpForLevel(GATE) })!;

    for (const row of card.stats) expect(row.base).toBeUndefined();
    expect(card.stats.every((row) => row.tone !== "bad")).toBe(true);
    expect(card.speech).not.toContain("just earned");
  });

  /**
   * **Agility is not part of any gate, so it still shows a gap — and should.**
   *
   * The baseline body is built out of the weapon's requirements and nothing
   * else, so it has whatever Agility those name, which for every weapon in the
   * world today is none. A quick player therefore swings a weapon they have
   * exactly earned faster than its fresh owner does, and the row says so.
   *
   * That is the right answer rather than an exception to the rule above: how
   * fast you are is yours and not the weapon's, so it is a real difference
   * between two bodies rather than a figure nobody is dealt. See
   * `../lib/battler`'s `haste`, which is where Agility enters the rate.
   */
  it("still reports Agility as a gap at a gate that does not ask for it", () => {
    const quick = { sharp: xpForLevel(GATE), agility: xpForLevel(60) };
    const card = itemCard(tileWith(SWORD), null, quick)!;

    expect(statAt(card.stats, "swing")).toMatchObject({ tone: "good" });
    expect(statAt(card.stats, "swing").base).toBeDefined();
    // And the rows the gate does govern still agree, because the gate is met.
    expect(statAt(card.stats, "damage").base).toBeUndefined();
    expect(statAt(card.stats, "hit").base).toBeUndefined();
  });

  /**
   * The one row that reads the other way round: a shorter wait between blows is
   * a better weapon, so the tone has to be inverted where the figure is not.
   *
   * **Both directions come from different places now.** Falling short of what a
   * weapon asks drags `spd` down through `weaponHandling`; going *faster* than
   * the weapon's own rate is Agility's doing and nothing else's — see
   * `../lib/battler`'s `haste`, which `spd` has no room to carry. So the slow
   * case is a novice and the fast case is a quick body that has met the gate.
   */
  it("reads a shorter wait between blows as the better one", () => {
    const novice = itemCard(tileWith(SWORD), null, { sharp: xpForLevel(5) })!;
    expect(statAt(novice.stats, "swing").tone).toBe("bad");

    const quick = { sharp: xpForLevel(20), agility: xpForLevel(60) };
    const card = itemCard(tileWith(SWORD), null, quick)!;
    const hastened = swingIntervalMs(fightingStats(bodyWith(quick), SWORD));

    expect(statAt(card.stats, "swing").tone).toBe("good");
    expect(statAt(card.stats, "swing").value).toBe(`${Number((hastened / 1000).toFixed(1))}s`);
    expect(hastened).toBeLessThan(attackIntervalMs(SWORD.spd));
  });

  it("leaves the other figure off a row that matches it", () => {
    // A weapon that asks nothing, in hands that have learnt nothing: the gate is
    // at zero, so the reader *is* the baseline body and every row agrees with
    // it. A card printing "12 (12)" would invite a reader to look for a
    // difference that is not there.
    const plain: WeaponItem = { ...SWORD, requirements: undefined };
    const card = itemCard(tileWith(plain), null, NOTHING_LEARNT)!;

    const own = damageBandOf(plain.damage, plain.variance);
    expect(statAt(card.stats, "damage").value).toBe(bandLabel(own.min, own.max));
    expect(statAt(card.stats, "damage").base).toBeUndefined();
    expect(statAt(card.stats, "damage").tone).toBe("plain");
  });

  /**
   * **A band, and no variance row under it.** The card used to print the face
   * value and `spread ±40%` beneath it, which is a number no blow is ever worth
   * and a percentage of it to subtract. The reader does that arithmetic to find
   * out what the weapon does, so the card does it instead.
   */
  it("reports damage as the band a blow can land in, and never as a spread", () => {
    const card = itemCard(tileWith(SWORD), null, NOTHING_LEARNT)!;
    const band = damageBand(fightingStats(bodyWith(NOTHING_LEARNT), SWORD));

    expect(band.min).toBeLessThan(band.max);
    expect(statAt(card.stats, "damage").value).toBe(`${band.min}\u2013${band.max}`);
    expect(card.stats.map((row) => row.term)).not.toContain("spread");
    expect(card.speech).not.toContain("\u00b1");
  });

  /**
   * A weapon authored with no variance is always worth exactly its damage, and
   * "12–12" is a range with nothing in it — an invitation to look for a spread
   * that is not there.
   */
  it("gives a weapon with no variance one figure rather than a range", () => {
    const flat: WeaponItem = { ...SWORD, variance: 0, requirements: undefined };
    const card = itemCard(tileWith(flat), null, NOTHING_LEARNT)!;

    expect(statAt(card.stats, "damage").value).toBe(`${flat.damage}`);
  });

  /**
   * **Meeting the gate is not the ceiling, and the card has to show that.**
   * Requirements stop paying the moment they are met, but being good with a
   * blade goes on paying — see `../lib/battler`'s `MASTERY_DAMAGE_BONUS`. So a
   * master's figures run *past* the numbers stamped on the weapon, which is the
   * one case where the struck-through base is the smaller of the two.
   */
  it("runs past a fresh owner's numbers in a master's hands", () => {
    const master = { sharp: xpForLevel(90) };
    const card = itemCard(tileWith(SWORD), null, master)!;
    const yours = fightingStats(bodyWith(master), SWORD);
    const fresh = fightingStats(bodyWith({ sharp: xpForLevel(GATE) }), SWORD);

    expect(yours.damage).toBeGreaterThan(fresh.damage);
    const band = damageBand(yours);
    const theirs = damageBand(fresh);
    expect(statAt(card.stats, "damage")).toMatchObject({
      value: bandLabel(band.min, band.max),
      base: bandLabel(theirs.min, theirs.max),
      tone: "good",
    });
    // And no row leans the other way, because the gate is open: what is left is
    // skill, and skill only ever pays.
    expect(card.stats.every((row) => row.tone !== "bad")).toBe(true);
  });

  it("names an arm's length rather than measuring it, and says when something is fired", () => {
    expect(statAt(itemCard(tileWith(SWORD), null, NOTHING_LEARNT)!.stats, "range").value).toBe(
      "Melee",
    );

    const bow: WeaponItem = {
      ...SWORD,
      mastery: "ranged",
      reach: { cells: 6, height: 2 },
      projectile: "arrow",
    };
    expect(statAt(itemCard(tileWith(bow), null, NOTHING_LEARNT)!.stats, "range").value).toBe(
      "6 cells, fired",
    );
  });

  /**
   * The floor is the one number on the card that says what a weapon *cannot*
   * do, so it is stated rather than left to be discovered by standing in it.
   * @see `../lib/item`'s `Reach.min`
   */
  it("states a minimum as a span", () => {
    const bow: WeaponItem = {
      ...SWORD,
      mastery: "ranged",
      reach: { cells: 8, min: 2, height: 2 },
      projectile: "arrow",
    };
    expect(statAt(itemCard(tileWith(bow), null, NOTHING_LEARNT)!.stats, "range").value).toBe(
      "2–8 cells, fired",
    );
  });

  /**
   * A short weapon with a hole in it is not "Melee", however short. Saying so
   * would be the card contradicting the one thing the minimum is there to warn
   * about.
   */
  it("refuses to call a weapon with a minimum a melee one", () => {
    const pike: WeaponItem = { ...SWORD, reach: { cells: 1.5, min: 1, height: 2 } };
    expect(statAt(itemCard(tileWith(pike), null, NOTHING_LEARNT)!.stats, "range").value).toBe(
      "1–1.5 cells",
    );
  });

  it("keeps quiet about defence until there is some", () => {
    const plain = itemCard(tileWith(SWORD), null, NOTHING_LEARNT)!;
    expect(plain.stats.some((row) => row.term === "defence")).toBe(false);

    const shield = itemCard(tileWith({ ...SWORD, def: 3 }), null, NOTHING_LEARNT)!;
    expect(statAt(shield.stats, "defence")).toMatchObject({ value: "3" });
  });

  /**
   * **The requirement costing the most leads**, and "most" is points missing
   * rather than how far behind proportionally — which is the term
   * `requirementShare` is built out of now that requirements pool. Here Blunt is
   * a single point short and Toughness twelve, so Toughness is what a player
   * should go and train and Toughness is the first line they read.
   */
  it("puts the requirement costing the most first, and marks what is met", () => {
    const axe: WeaponItem = { ...SWORD, requirements: { blunt: 35, toughness: 20 } };
    const card = itemCard(tileWith(axe), null, {
      blunt: xpForLevel(34),
      toughness: xpForLevel(8),
    })!;

    expect(card.requirements.map((row) => row.mastery)).toEqual(["toughness", "blunt"]);
    expect(card.requirements[0]).toMatchObject({ required: 20, have: 8, met: false });
    expect(card.requirements[1]).toMatchObject({ required: 35, have: 34, met: false });

    // Proportionally Blunt is the *closer* of the two (34 of 35 against 8 of
    // 20), so a sort by ratio would put it first and point the player at the
    // one point rather than at the twelve.
    expect(20 - 8).toBeGreaterThan(35 - 34);

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
      tileWith({ ...SWORD, requirements: { sharp: 0 } }),
      null,
      NOTHING_LEARNT,
    )!;
    expect(card.requirements).toEqual([]);
  });

  /**
   * **The card has no handling figure, and does not need one.**
   *
   * It used to end on a bar reading "Accuracy & swing rate — 50%", which is
   * `weaponHandling` of the pooled shortfall. Three parts of the card were then
   * saying one thing: the requirement row in red, the rows the shortfall
   * actually scales, and the bar restating those rows as a percentage.
   *
   * What is asserted here is the two that survived, because they are the two a
   * player can act on. Every row trails the wielder who has just earned the
   * weapon, and the requirement says which mastery to go and train and by how
   * many points — which no pooled percentage can be worked back to.
   *
   * **The damage row trails for a different reason from the others**, and the
   * card does not distinguish them: `Swing` and `Hit` are docked by
   * `weaponHandling`, while `Damage` is only lower because the fresh owner has
   * more mastery. Falling short never takes damage away — that is
   * `../lib/battler`'s rule and *is the authored profile the moment the
   * requirement is met* in `battler.test.ts` is where it is pinned, because it
   * is a fact about the engine rather than about a card.
   */
  it("shows what falling short costs in the rows rather than as a share", () => {
    const short = { sharp: xpForLevel(10) };
    const card = itemCard(tileWith(SWORD), null, short)!;

    for (const term of ["swing", "hit", "damage"] as const) {
      expect(statAt(card.stats, term).base).toBeDefined();
      expect(statAt(card.stats, term).tone).toBe("bad");
    }

    expect(card.requirements).toEqual([{ mastery: "sharp", required: GATE, have: 10, met: false }]);
    // No percentage anywhere, drawn or spoken.
    expect(card.speech).not.toMatch(/\d+% accuracy/);
  });

  it("has no such question about anything that is not a weapon", () => {
    const card = itemCard(
      tileWith({ type: "consumable", label: "Eat", hp: 5 }),
      null,
      NOTHING_LEARNT,
    )!;
    expect(card.kind).toBe("Eat");
    expect(statAt(card.stats, "health")).toMatchObject({
      value: "+5",
      tone: "good",
    });
  });

  describe("something worn", () => {
    it("says what it is and what it stops", () => {
      const card = itemCard(tileWith({ type: "armor", def: 4 }), null, NOTHING_LEARNT)!;
      // The caption on the square it goes in — see
      // `../components/EquipmentPanel` — rather than a sentence about a body.
      expect(card.kind).toBe("Armour");
      // The same word a shield's row uses, because they are the same field and
      // `../game/equipment`'s `wornDefence` adds them.
      expect(statAt(card.stats, "defence")).toMatchObject({ value: "4" });
    });

    /**
     * **No requirements and no share.** Armour asks nothing of a body — see
     * `../lib/item`'s `ArmorItem` — so there is no gate to state and no scale to
     * place the reader on, and a card offering one would be inventing a
     * mechanic.
     */
    it("names which square it goes in", () => {
      // The player's word, not the stored key: the chest square is `armor` on
      // the wire because it was the only one when it was named.
      const helm = itemCard(
        tileWith({ type: "armor", slot: "head", def: 2 }),
        null,
        NOTHING_LEARNT,
      )!;
      expect(helm.kind).toBe("Head");
    });

    it("has nothing to say about the hands wearing it", () => {
      const card = itemCard(tileWith({ type: "armor", def: 4 }), null, {
        sharp: xpForLevel(60),
      })!;
      expect(card.requirements).toEqual([]);
    });

    it("gives a resistance as the total, best first", () => {
      const card = itemCard(
        tileWith({ type: "armor", def: 4, resist: { blunt: 2, sharp: 5 } }),
        null,
        NOTHING_LEARNT,
      )!;
      // Sorted by what it actually stops rather than by declaration order: what
      // a piece is *for* is the first thing a reader wants off the table.
      expect(card.resists).toEqual([
        { mastery: "sharp", total: 9, extra: 5 },
        { mastery: "blunt", total: 6, extra: 2 },
      ]);
      expect(card.speech).toContain("Sharp blows lose 9 rather than 4");
    });

    it("reads a resistance of zero as no resistance at all", () => {
      // An editor round trip writes the key either way, and a row saying this
      // armour is ordinary against blades is the flat number under another name.
      const card = itemCard(
        tileWith({ type: "armor", def: 4, resist: { sharp: 0 } }),
        null,
        NOTHING_LEARNT,
      )!;
      expect(card.resists).toEqual([]);
    });

    it("leaves the table empty for everything that is not armour", () => {
      expect(itemCard(tileWith(SWORD), null, NOTHING_LEARNT)!.resists).toEqual([]);
    });
  });

  it("says a poison costs you rather than restores you", () => {
    const card = itemCard(tileWith({ type: "consumable", hp: -6 }), null, NOTHING_LEARNT)!;
    // Signed rather than worded, on the terms `../render/damageNumbers`' mend
    // sign is: a reader who cannot separate the red from the green still has
    // the arithmetic written down.
    expect(statAt(card.stats, "health")).toMatchObject({
      value: "\u22126",
      tone: "bad",
    });
  });

  describe("an engraved thing", () => {
    const skull = tileWith({ type: "artifact" }, { name: "%s's skull" });

    it("is named after whoever it was", () => {
      const card = itemCard(
        skull,
        { id: "itm_1", tileId: "thing", engraved: "Green Fox" },
        NOTHING_LEARNT,
      )!;
      expect(card.name).toBe("Green Fox's skull");
    });

    /**
     * The name and the note under it are two different lines, and a skull is the
     * case that proves it: what killed them goes in the description, and reading
     * it as the name would put "Fangs by Wolf" on the square.
     */
    it("keeps what killed them out of the name", () => {
      const card = itemCard(
        skull,
        {
          id: "itm_1",
          tileId: "thing",
          engraved: "Green Fox",
          description: "Fangs by Wolf",
        },
        NOTHING_LEARNT,
      )!;
      expect(card.name).toBe("Green Fox's skull");
      expect(card.description).toBe("Fangs by Wolf");
      // Nothing is written on it, so nobody walking past says anything.
      expect(card.inscription).toBeNull();
    });

    /**
     * The card is the one surface that shows both, because it is the one place
     * somebody has asked about this particular object.
     */
    it("shows what is written on it beside what examining it says", () => {
      const card = itemCard(
        skull,
        {
          id: "itm_1",
          tileId: "thing",
          engraved: "Green Fox",
          inscription: "Rest well",
          description: "Fangs by Wolf",
        },
        NOTHING_LEARNT,
      )!;
      expect(card.inscription).toBe("Rest well");
      expect(card.description).toBe("Fangs by Wolf");
      expect(card.speech).toContain("Rest well");
      expect(card.speech).toContain("Fangs by Wolf");
    });

    it("is somebody's even when nobody wrote on it", () => {
      const card = itemCard(skull, null, NOTHING_LEARNT)!;
      expect(card.name).toBe("Someone's skull");
    });
  });

  describe("the kinds that are not weapons or armour", () => {
    it("gives a shield the same defence row a weapon's def gets", () => {
      const card = itemCard(tileWith({ type: "shield", def: 4 }), null, NOTHING_LEARNT)!;
      expect(card.kind).toBe("Either hand");
      expect(statAt(card.stats, "defence")).toMatchObject({ value: "4" });
      // No requirements: a shield asks nothing and is not swung.
      expect(card.requirements).toEqual([]);
    });

    /**
     * **The interval is the whole cost of a charm** — see `../lib/item`'s
     * `CharmItem.everyMs`. One that mends a point every ten seconds and one that
     * mends it every ten minutes are the same `hp` row and completely different
     * things to be wearing, so a card giving the first without the second would
     * be the more useful half of the answer missing.
     */
    it("says what a charm does and how often it does it", () => {
      const card = itemCard(
        tileWith({ type: "charm", everyMs: 10_000, hp: 1 }),
        null,
        NOTHING_LEARNT,
      )!;

      expect(card.kind).toBe("Charm");
      expect(statAt(card.stats, "health")).toMatchObject({ value: "+1" });
      expect(statAt(card.stats, "cadence").value).toBe("10s");
      // Nothing is asked of a body wearing one, and there is no share of it to
      // get: a charm acts on its own.
      expect(card.requirements).toEqual([]);
    });

    it("leaves the health row off a charm that only grants statuses", () => {
      const luck: StatusDef = {
        id: "luck",
        name: "Luck",
        description: "Fortune favours you",
        tone: "good",
        fromMs: 70_000,
        toMs: 70_000,
        stacks: false,
        maxMs: 70_000,
        everyMs: constantFormula(1_000),
        effects: {},
        modifiers: {},
        walkSpeedPercent: 0,
        incapacitates: false,
        endsOnDamage: false,
        vfx: { tint: null, particles: null, light: null, taperMs: 0 },
      };
      const card = itemCard(
        tileWith({ type: "charm", everyMs: 60_000, statuses: [{ id: "luck" }] }),
        null,
        NOTHING_LEARNT,
        { luck },
      )!;

      // A charm that mends nothing is an ordinary thing to author, and "+0"
      // would say it mends nothing rather than that mending is not its job.
      expect(card.stats.some((row) => row.term === "health")).toBe(false);
      expect(statAt(card.stats, "cadence").value).toBe("1m");
      // Its list is the consumable's, rolled by the same `inflictedBy` — so the
      // card has to read it from the same place. See `../lib/item`'s `CharmItem`.
      expect(card.effects).toMatchObject([{ name: "Luck", chance: null }]);
    });

    /**
     * An artifact is the kind with no fields. Everything it does it does by
     * being a placement — its light, its sprite, its being in the way — so
     * there is nothing for a profile to report.
     */
    it("gives an artifact a name and nothing else", () => {
      const card = itemCard(tileWith({ type: "artifact" }), null, NOTHING_LEARNT)!;
      expect(card.kind).toBe("Carried");
      expect(card.stats).toEqual([]);
    });

    it("says what a stone does, to whom, and when it is ready again", () => {
      const card = itemCard(
        tileWith({
          type: "stone",
          cooldownMs: 8_000,
          requirements: { arcane: 12 },
          effect: { kind: "bolt", on: "target", damage: 9, variance: 20 },
        }),
        null,
        { arcane: xpForLevel(4) },
      )!;

      expect(card.kind).toBe("Arcane stone");
      // A band, on the same terms a weapon's is: a bolt rolls the same
      // `damageFraction` a blow does, so it had the same face value and the
      // same percentage underneath it.
      const bolt = damageBandOf(9, 20);
      expect(statAt(card.stats, "damage").value).toBe(bandLabel(bolt.min, bolt.max));
      expect(statAt(card.stats, "subject").value).toBe("Your target");
      expect(statAt(card.stats, "cooldown").value).toBe("8s");
      // The requirements are reported because they decide whether it fires at
      // all, and there is nothing partial about an unmet stone: it refuses the
      // cast rather than weakening it.
      expect(card.requirements).toEqual([{ mastery: "arcane", required: 12, have: 4, met: false }]);
    });

    it("reads a mending stone as mending rather than as negative damage", () => {
      const card = itemCard(
        tileWith({
          type: "stone",
          cooldownMs: 30_000,
          effect: { kind: "bolt", on: "caster", damage: -12 },
        }),
        null,
        NOTHING_LEARNT,
      )!;
      // Its own term rather than damage's, so the caption reads "Heal" — see
      // `../lib/terms`. No variance authored, so the band is one figure.
      expect(statAt(card.stats, "heal")).toMatchObject({
        value: "12",
        tone: "good",
      });
      expect(statAt(card.stats, "subject").value).toBe("You");
    });

    it("heads the list with the act that causes it", () => {
      // A stone's grants carry a chance just as a weapon's do, so a heading
      // picked from the chance alone would say a necklace burns people "on hit".
      expect(itemCard(tileWith(SWORD), null, NOTHING_LEARNT)!.effectsTitle).toBe("On hit");
      expect(
        itemCard(
          tileWith({
            type: "stone",
            cooldownMs: 1_000,
            effect: { kind: "bolt", on: "target", damage: 1 },
          }),
          null,
          NOTHING_LEARNT,
        )!.effectsTitle,
      ).toBe("On cast");
      expect(
        itemCard(tileWith({ type: "consumable", hp: 1 }), null, NOTHING_LEARNT)!.effectsTitle,
      ).toBe("Grants");
    });

    it("names what a stone leaves behind, wherever its kind keeps the list", () => {
      const venom: StatusDef = {
        id: "venom",
        name: "Venom",
        description: "Saps a little health",
        tone: "bad",
        fromMs: 10_000,
        toMs: 10_000,
        stacks: false,
        maxMs: 60_000,
        everyMs: constantFormula(1_000),
        effects: {},
        modifiers: {},
        walkSpeedPercent: 0,
        incapacitates: false,
        endsOnDamage: false,
        vfx: { tint: null, particles: null, light: null, taperMs: 0 },
      };
      const card = itemCard(
        tileWith({
          type: "stone",
          cooldownMs: 5_000,
          effect: {
            kind: "bolt",
            on: "target",
            damage: 1,
            statuses: [{ id: "venom", chance: 40 }],
          },
        }),
        null,
        NOTHING_LEARNT,
        { venom },
      )!;
      expect(card.effects).toMatchObject([{ name: "Venom", chance: 40 }]);
    });
  });

  it("names what holding it attunes you to", () => {
    const card = itemCard(tileWith({ ...SWORD, elements: ["fire"] }), null, NOTHING_LEARNT)!;
    expect(card.elements).toEqual(["fire"]);
    expect(card.speech).toContain("Attuned to fire");
    // Only the kinds a fight can see carry them.
    expect(itemCard(tileWith({ type: "artifact" }), null, NOTHING_LEARNT)!.elements).toEqual([]);
  });

  it("puts the count beside the name rather than in a row", () => {
    const pile: ItemInstance = { id: "1", tileId: "thing", count: 6 };
    const card = itemCard(tileWith({ type: "artifact", pile: 20 }), pile, NOTHING_LEARNT)!;
    expect(card.count).toBe(6);
    expect(card.speech).toContain("Thing, 6 of them");

    // A single thing has no count to show, and "×1" would say what its absence
    // already says.
    const one: ItemInstance = { id: "2", tileId: "thing" };
    expect(itemCard(tileWith({ type: "artifact" }), one, NOTHING_LEARNT)!.count).toBeNull();
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
    expect(statAt(card.stats, "worn").value).toBe("Back");
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
      everyMs: constantFormula(1_000),
      effects: {},
      modifiers: {},
      walkSpeedPercent: 0,
      incapacitates: false,
      endsOnDamage: false,
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
      expect(card.effects[0]).toMatchObject({ duration: "1m", chance: null });
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
        itemCard(tileWith(snack), null, NOTHING_LEARNT, { venom: VENOM })!.effects[0]!.duration,
      ).toBe("5s–20s");

      const brief: ItemDef = {
        type: "consumable",
        hp: 1,
        statuses: [{ id: "venom", fromMs: 1_500, toMs: 1_500 }],
      };
      expect(
        itemCard(tileWith(brief), null, NOTHING_LEARNT, { venom: VENOM })!.effects[0]!.duration,
      ).toBe("1.5s");

      // Past a minute, seconds stop being a unit anybody reads in: an hour-long
      // status reported as "3600s" is a number to convert rather than to read.
      const blessing: ItemDef = {
        type: "consumable",
        hp: 1,
        statuses: [{ id: "venom", fromMs: 3_600_000, toMs: 3_600_000 }],
      };
      expect(
        itemCard(tileWith(blessing), null, NOTHING_LEARNT, { venom: VENOM })!.effects[0]!.duration,
      ).toBe("60m");
    });

    /**
     * A status the catalogue has lost reads as an effect that did not happen —
     * the same answer every other reader of a status id gives, and the reason a
     * renamed status cannot take a card down with it.
     */
    it("says nothing about a status the world no longer has", () => {
      const fang: WeaponItem = { ...SWORD, statuses: [{ id: "gone", chance: 10 }] };
      expect(itemCard(tileWith(fang), null, NOTHING_LEARNT, { venom: VENOM })!.effects).toEqual([]);
    });
  });

  /**
   * **The card and the world's look label must never disagree.**
   *
   * A sword on the floor and the same sword in your bag are one thing being
   * asked one question. `weaponDemand` answers it over the canvas in the pixel
   * font and this answers it in a panel; they say a different *amount* — the
   * card has a whole profile around it — and they must not say a different
   * thing. Asserted against the other module's output rather than against
   * literals, so a rebalance that moves the gate moves both or fails here.
   *
   * **The handling sentence is the one line the card does not echo, and that is
   * the asymmetry rather than a hole in it.** A look label is a few lines of
   * pixel font over a tile: it has no room for a profile, so a pooled percentage
   * is the only way it can say what falling short costs. The card has the
   * profile — a slower `Swing`, a worse `Hit`, each struck through against the
   * weapon's own — so it says the cost in the units a blow is fought in and does
   * not also summarise it. Saying less than the label is allowed; saying
   * something else is not.
   */
  it("agrees with what the world's look label says", () => {
    const learnt = { sharp: xpForLevel(12) };
    const card = itemCard(tileWith(SWORD), null, learnt)!;
    const lines = weaponDemandFor(tileWith(SWORD), learnt);

    // The label carries the summary, because it has nothing else to carry the
    // cost with. The card carries the figures instead — see below.
    expect(lines.some((line) => /accuracy and swing rate/.test(line))).toBe(true);
    expect(card.speech).not.toMatch(/accuracy and swing rate/);
    expect(statAt(card.stats, "swing").base).toBeDefined();
    expect(statAt(card.stats, "hit").base).toBeDefined();

    for (const row of card.requirements) {
      expect(lines).toContain(
        row.met
          ? `${MASTERY_LABELS[row.mastery]} ${row.required} — met`
          : `${MASTERY_LABELS[row.mastery]} ${row.required} — you have ${row.have}`,
      );
    }
  });

  /**
   * The whole card by the other route. A screen reader is told the same content
   * as a sighted one, which is what lets the drawing be `aria-hidden` — see
   * `../components/ItemCard`.
   */
  it("says the same thing aloud", () => {
    const card = itemCard(tileWith(SWORD), null, { sharp: xpForLevel(5) })!;
    expect(card.speech).toContain("Thing");
    expect(card.speech).toContain("One hand — Sharp");
    expect(card.speech).toContain("Requires Sharp 20, you have 5");
    // The clause, not the caption the card is drawn with: "Swing: 1.2s" read
    // out is not a sentence, and "A blow every 1.2s" is. Most terms need no
    // second form, which is what whole words bought over the abbreviations the
    // rows used to carry — see `../lib/terms`.
    expect(card.speech).toContain(`${termLabel("damage")}: `);
    expect(card.speech).toContain("A blow every: ");
    expect(card.speech).not.toContain(termLabel("swing"));
    // The other figure as a clause, because a screen reader reads "(12)" as
    // "twelve" and the comparison disappears — and the body it belongs to is
    // named, since it is somebody rather than something.
    const fresh = damageBand(fightingStats(bodyWith({ sharp: xpForLevel(GATE) }), SWORD));
    expect(card.speech).toContain(
      `where somebody who has just earned it gets ${bandLabel(fresh.min, fresh.max)}`,
    );
  });
});
