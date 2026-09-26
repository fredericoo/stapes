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

const GATE = SWORD.requirements!.sharp!;

function bodyWith(masteryXp: MasteryXp) {
  return {
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

    expect(card?.name).toBe("Thing");
    expect(card?.description).toBe("Left here by someone");
    expect(card?.kind).toBe("One hand — Sharp");
  });

  it("says how many hands it costs", () => {
    const card = itemCard(tileWith({ ...SWORD, twoHanded: true }), null, NOTHING_LEARNT);
    expect(card?.kind).toBe("Both hands — Sharp");
  });

  it("gives the figures the reader would get, against a wielder who has just earned it", () => {
    const novice = { sharp: xpForLevel(5) };
    const card = itemCard(tileWith(SWORD), null, novice)!;
    const yours = fightingStats(bodyWith(novice), SWORD);
    const fresh = fightingStats(bodyWith({ sharp: xpForLevel(GATE) }), SWORD);

    expect(statAt(card.stats, "hit").value).toBe(`${Math.round(yours.hitChance * 100)}%`);
    expect(statAt(card.stats, "hit").base).toBe(`${Math.round(fresh.hitChance * 100)}%`);
    expect(statAt(card.stats, "hit").tone).toBe("bad");

    const band = damageBand(yours);
    const theirs = damageBand(fresh);
    expect(statAt(card.stats, "damage").value).toBe(bandLabel(band.min, band.max));
    expect(statAt(card.stats, "damage").base).toBe(bandLabel(theirs.min, theirs.max));
  });

  it("strikes nothing through for a wielder who exactly meets the gate", () => {
    const card = itemCard(tileWith(SWORD), null, { sharp: xpForLevel(GATE) })!;

    for (const row of card.stats) expect(row.base).toBeUndefined();
    expect(card.stats.every((row) => row.tone !== "bad")).toBe(true);
    expect(card.speech).not.toContain("just earned");
  });

  it("still reports Agility as a gap at a gate that does not ask for it", () => {
    const quick = { sharp: xpForLevel(GATE), agility: xpForLevel(60) };
    const card = itemCard(tileWith(SWORD), null, quick)!;

    expect(statAt(card.stats, "swing")).toMatchObject({ tone: "good" });
    expect(statAt(card.stats, "swing").base).toBeDefined();
    expect(statAt(card.stats, "damage").base).toBeUndefined();
    expect(statAt(card.stats, "hit").base).toBeUndefined();
  });

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
    const plain: WeaponItem = { ...SWORD, requirements: undefined };
    const card = itemCard(tileWith(plain), null, NOTHING_LEARNT)!;

    const own = damageBandOf(plain.damage, plain.variance);
    expect(statAt(card.stats, "damage").value).toBe(bandLabel(own.min, own.max));
    expect(statAt(card.stats, "damage").base).toBeUndefined();
    expect(statAt(card.stats, "damage").tone).toBe("plain");
  });

  it("reports damage as the band a blow can land in, and never as a spread", () => {
    const card = itemCard(tileWith(SWORD), null, NOTHING_LEARNT)!;
    const band = damageBand(fightingStats(bodyWith(NOTHING_LEARNT), SWORD));

    expect(band.min).toBeLessThan(band.max);
    expect(statAt(card.stats, "damage").value).toBe(`${band.min}\u2013${band.max}`);
    expect(card.stats.map((row) => row.term)).not.toContain("spread");
    expect(card.speech).not.toContain("\u00b1");
  });

  it("gives a weapon with no variance one figure rather than a range", () => {
    const flat: WeaponItem = { ...SWORD, variance: 0, requirements: undefined };
    const card = itemCard(tileWith(flat), null, NOTHING_LEARNT)!;

    expect(statAt(card.stats, "damage").value).toBe(`${flat.damage}`);
  });

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

  it("puts the requirement costing the most first, and marks what is met", () => {
    const axe: WeaponItem = { ...SWORD, requirements: { blunt: 35, toughness: 20 } };
    const card = itemCard(tileWith(axe), null, {
      blunt: xpForLevel(34),
      toughness: xpForLevel(8),
    })!;

    expect(card.requirements.map((row) => row.mastery)).toEqual(["toughness", "blunt"]);
    expect(card.requirements[0]).toMatchObject({ required: 20, have: 8, met: false });
    expect(card.requirements[1]).toMatchObject({ required: 35, have: 34, met: false });

    expect(20 - 8).toBeGreaterThan(35 - 34);

    const met = itemCard(tileWith(axe), null, {
      blunt: xpForLevel(40),
      toughness: xpForLevel(40),
    })!;
    expect(met.requirements.every((row) => row.met)).toBe(true);
  });

  it("reads a requirement of zero as no requirement at all", () => {
    const card = itemCard(
      tileWith({ ...SWORD, requirements: { sharp: 0 } }),
      null,
      NOTHING_LEARNT,
    )!;
    expect(card.requirements).toEqual([]);
  });

  it("shows what falling short costs in the rows rather than as a share", () => {
    const short = { sharp: xpForLevel(10) };
    const card = itemCard(tileWith(SWORD), null, short)!;

    for (const term of ["swing", "hit", "damage"] as const) {
      expect(statAt(card.stats, term).base).toBeDefined();
      expect(statAt(card.stats, term).tone).toBe("bad");
    }

    expect(card.requirements).toEqual([{ mastery: "sharp", required: GATE, have: 10, met: false }]);
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
      expect(card.kind).toBe("Armour");
      expect(statAt(card.stats, "defence")).toMatchObject({ value: "4" });
    });

    it("names which square it goes in", () => {
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
      expect(card.resists).toEqual([
        { mastery: "sharp", total: 9, extra: 5 },
        { mastery: "blunt", total: 6, extra: 2 },
      ]);
      expect(card.speech).toContain("Sharp blows lose 9 rather than 4");
    });

    it("reads a resistance of zero as no resistance at all", () => {
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
      expect(card.inscription).toBeNull();
    });

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
      expect(card.requirements).toEqual([]);
    });

    it("says what a charm does and how often it does it", () => {
      const card = itemCard(
        tileWith({ type: "charm", everyMs: 10_000, hp: 1 }),
        null,
        NOTHING_LEARNT,
      )!;

      expect(card.kind).toBe("Charm");
      expect(statAt(card.stats, "health")).toMatchObject({ value: "+1" });
      expect(statAt(card.stats, "cadence").value).toBe("10s");
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

      expect(card.stats.some((row) => row.term === "health")).toBe(false);
      expect(statAt(card.stats, "cadence").value).toBe("1m");
      expect(card.effects).toMatchObject([{ name: "Luck", chance: null }]);
    });

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
      const bolt = damageBandOf(9, 20);
      expect(statAt(card.stats, "damage").value).toBe(bandLabel(bolt.min, bolt.max));
      expect(statAt(card.stats, "subject").value).toBe("Your target");
      expect(statAt(card.stats, "cooldown").value).toBe("8s");
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
      expect(statAt(card.stats, "heal")).toMatchObject({
        value: "12",
        tone: "good",
      });
      expect(statAt(card.stats, "subject").value).toBe("You");
    });

    it("heads the list with the act that causes it", () => {
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
    expect(itemCard(tileWith({ type: "artifact" }), null, NOTHING_LEARNT)!.elements).toEqual([]);
  });

  it("puts the count beside the name rather than in a row", () => {
    const pile: ItemInstance = { id: "1", tileId: "thing", count: 6 };
    const card = itemCard(tileWith({ type: "artifact", pile: 20 }), pile, NOTHING_LEARNT)!;
    expect(card.count).toBe(6);
    expect(card.speech).toContain("Thing, 6 of them");

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

      const blessing: ItemDef = {
        type: "consumable",
        hp: 1,
        statuses: [{ id: "venom", fromMs: 3_600_000, toMs: 3_600_000 }],
      };
      expect(
        itemCard(tileWith(blessing), null, NOTHING_LEARNT, { venom: VENOM })!.effects[0]!.duration,
      ).toBe("60m");
    });

    it("says nothing about a status the world no longer has", () => {
      const fang: WeaponItem = { ...SWORD, statuses: [{ id: "gone", chance: 10 }] };
      expect(itemCard(tileWith(fang), null, NOTHING_LEARNT, { venom: VENOM })!.effects).toEqual([]);
    });
  });

  it("agrees with what the world's look label says", () => {
    const learnt = { sharp: xpForLevel(12) };
    const card = itemCard(tileWith(SWORD), null, learnt)!;
    const lines = weaponDemandFor(tileWith(SWORD), learnt);

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

  it("says the same thing aloud", () => {
    const card = itemCard(tileWith(SWORD), null, { sharp: xpForLevel(5) })!;
    expect(card.speech).toContain("Thing");
    expect(card.speech).toContain("One hand — Sharp");
    expect(card.speech).toContain("Requires Sharp 20, you have 5");
    expect(card.speech).toContain(`${termLabel("damage")}: `);
    expect(card.speech).toContain("A blow every: ");
    expect(card.speech).not.toContain(termLabel("swing"));
    const fresh = damageBand(fightingStats(bodyWith({ sharp: xpForLevel(GATE) }), SWORD));
    expect(card.speech).toContain(
      `where somebody who has just earned it gets ${bandLabel(fresh.min, fresh.max)}`,
    );
  });
});
