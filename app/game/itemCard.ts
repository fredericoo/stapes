import type { BattlerDef } from "../lib/battler";
import { DEFAULT_BASE_HP, fightingStats } from "../lib/battler";
import {
  armorSlotOf,
  consumeVerb,
  isRanged,
  MELEE_REACH,
  reachOf,
  resolveItem,
  type ArcaneStoneItem,
  type ArmorItem,
  type ArmorSlot,
  type CharmItem,
  type ConsumableItem,
  type ContainerItem,
  type ItemDef,
  type Reach,
  type ShieldItem,
  type StatusGrant,
  type WeaponItem,
} from "../lib/item";
import type { Element } from "../lib/element";
import { engravedName } from "../lib/engraving";
import type { ItemInstance } from "../lib/itemInstance";
import { seconds } from "../lib/duration";
import { countOf } from "../lib/piles";
import {
  MASTERIES,
  MASTERY_LABELS,
  masteriesFromXp,
  masteryLevel,
  type Masteries,
  type Mastery,
  type MasteryXp,
  WEAPON_MASTERIES,
  type WeaponMastery,
} from "../lib/mastery";
import type { StatusDef } from "../lib/status";
import { bandLabel, HEADINGS, termSpoken, type TermKey } from "../lib/terms";
import type { AnchoredSprite } from "../lib/types";
import type { TileDef } from "../lib/types";
import { damageBand, damageBandOf, swingIntervalMs, type DamageBand } from "./combat";

/**
 * Everything an inspected item has to say, as data rather than as a drawing.
 *
 * ## Why the card carries numbers
 *
 * Player-facing surfaces here describe rather than tabulate, and that default is
 * about what a surface *volunteers*. A panel that listed every weapon's numbers
 * at rest would rank your swords for you whether or not you asked. A card only
 * exists while you are holding a slot, so it is free to answer in full.
 *
 * `../lib/weaponDemand` made the same argument for the requirement gate: a
 * player holding a sword that does nothing needs to know which mastery is short
 * and by how much, and prose cannot carry that. This module extends it to the
 * rest of the profile. Somebody comparing two swords wants the difference
 * between them, and there is no sentence that separates a fast light blade from
 * a slow heavy one without giving the two numbers.
 *
 * ## The figures are the reader's, not the shelf's
 *
 * Every figure is what the item is worth to the body asking, computed by the
 * same `fightingStats` a swing is resolved with. A greataxe you are short of
 * reports its full damage and a blow every 3.2s rather than every 2.4s, because
 * slow is what being short of it costs you. {@link ItemCardStat.base} carries
 * what a **just-qualified** wielder gets alongside, so the gap is visible rather
 * than something the reader has to already know about — and meeting a
 * requirement exactly closes it, because at that point you are that wielder.
 *
 * That is also why this module computes nothing itself. Restating the combat
 * arithmetic here would be a second definition of what a weapon is worth, and
 * the two would diverge the next time somebody changed the handling rule.
 *
 * ## Data, not JSX
 *
 * `../components/ItemCard` draws this and applies no rules; this chooses no
 * colours. The split is what makes the wording testable, which matters for text
 * a player reads before deciding what to fight with.
 */

/** Which way a figure leans against the item's own. */
export type ItemCardTone = "plain" | "good" | "bad";

/** One line of the profile: what it is, what it comes to, how that reads. */
export type ItemCardStat = {
  /**
   * Which measurement this row reports, and so what it is called.
   *
   * The wording is not here. `../lib/terms` holds it, because the stats panel
   * heads the same measurements for a *body* and the two surfaces have to meet
   * the reader with the same word — see that module for what the abbreviations
   * this used to carry cost. It doubles as the row's identity: stable across
   * renders and across items, so a list keys on it and a test looks a row up by
   * it. One item never reports one measurement twice, which is what makes a
   * separate key unnecessary.
   */
  term: TermKey;
  /** What the body asking gets. */
  value: string;
  /**
   * What somebody who has **just earned** this item gets, where that differs
   * from {@link value}.
   *
   * Not the authored figure, which is a number nobody is ever dealt — see the
   * `own` profile in {@link itemCard}. A fresh owner is a real body, so the pair
   * answers a question a player has: am I getting more out of this than
   * somebody who has only just qualified for it.
   *
   * Absent when the two agree, which is what meeting a requirement exactly now
   * looks like: you *are* the fresh owner, there is no gap, and printing
   * "76 (76)" would invite the reader to look for one.
   */
  base?: string;
  tone: ItemCardTone;
};

/**
 * One mastery an item asks for, against the one the reader has.
 *
 * Both figures, because the pooled share cannot be worked back to them: "63%"
 * on its own leaves a player who wants to fix it with nowhere to start. See
 * `../lib/weaponDemand`, which reports the same pair over the canvas.
 */
export type ItemCardRequirement = {
  mastery: Mastery;
  required: number;
  have: number;
  met: boolean;
};

/** Something an item hands over — a venom on a blade, a Fed off a loaf. */
export type ItemCardEffect = {
  /** The status id, so a list keys on the thing rather than on its name. */
  id: string;
  name: string;
  description: string;
  tone: "good" | "bad";
  /**
   * The status's own picture, where it has been drawn.
   *
   * Carried through rather than looked up again where the card is drawn: the
   * strip, the stats panel and this all show one status, and three routes to
   * its icon is two chances for them to show different ones. Absent for a
   * status nobody has drawn yet — see `../lib/status`, which allows that.
   */
  icon?: AnchoredSprite;
  /**
   * How often a connecting blow leaves it, as a percentage, or null for
   * something that always happens.
   *
   * Null is a consumable: you chose to swallow it and it went down. See
   * `../lib/item`'s `WeaponStatus`, which owns that distinction.
   */
  chance: number | null;
  /** How long it runs — "30s", or "10–30s" where the draw has a range. */
  duration: string;
};

/**
 * One kind of blow a piece of armour is unusually good against.
 *
 * **The total, not the bonus.** A resistance is authored as extra on top of the
 * flat number — see `../lib/item`'s `ArmorItem.resist` — but "+3" is a figure a
 * reader has to add to something else before it means anything, and what they
 * actually want to know is what a blade loses when it lands. {@link extra} rides
 * along so the card can still say which kinds are the special ones.
 */
export type ItemCardResist = {
  mastery: WeaponMastery;
  /** Everything a blow of this kind loses: the flat defence plus the extra. */
  total: number;
  /** What this kind gets over and above every other. Always above zero. */
  extra: number;
};

export type ItemCard = {
  /** The tile's name, never the instance's. See {@link ItemCard.inscription}. */
  name: string;
  /**
   * How many of it this square holds, or null for a single thing.
   *
   * Beside the name rather than as a row, because it is part of what the reader
   * is looking at rather than a property of the kind. Read through
   * `../lib/piles`' `countOf`, which is the same count the badge on the square
   * draws.
   */
  count: number | null;
  /**
   * What holding or wearing this attunes its bearer to, if anything.
   *
   * Named rather than resolved into a multiplier because a card has nobody to
   * compare against: the wheel decides an exchange between two bodies, and which
   * side of it you are on depends on what you are fighting. See
   * `../lib/element`.
   */
  elements: Element[];
  /**
   * What kind of thing this is, in the terms the panel puts it in: "One hand —
   * Sharp", "Armour", "Either hand", "Container".
   *
   * Null for an item whose block does not parse, which is the same silence the
   * rest of this structure keeps about one.
   */
  kind: string | null;
  /**
   * What is written on *this* one, where anything is.
   *
   * Separate from {@link name} for the same reason `../render/GameRenderer`'s
   * `lookLines` keeps them separate: "Left here by someone" answers a different
   * question from "Rusty Sword", and a card that showed one in place of the
   * other would leave a player unable to find out what they picked up.
   */
  inscription: string | null;
  /**
   * What examining *this* one tells you — how its owner died, on a skull.
   *
   * **The card is the only place this is guaranteed to appear**, which is the
   * whole of the split: an inscription is recited to anybody who walks past and
   * this is not. See `../lib/types`' {@link PlacedTile.description}.
   */
  description: string | null;
  stats: ItemCardStat[];
  /**
   * What this asks, and what the reader has.
   *
   * **There is no handling figure beside it, and that is deliberate.** The card
   * used to end on a bar reading "Accuracy & swing rate — 50%", which is
   * `weaponHandling` of the pooled shortfall. Everything it said, the card
   * already says twice over and in better units: {@link requirements} names
   * which mastery is short and by how many points, which is the half a player
   * can act on, and the {@link stats} rows carry what the shortfall costs as
   * `Swing 2.9s → 5.2s` and `Hit 90% → 46%` — the figures themselves, struck
   * through against the weapon's own. A pooled percentage is the one form of it
   * nobody can work back to a mastery.
   *
   * `../lib/weaponDemand` still prints that sentence over the canvas, and the
   * two do not disagree: a look label has no room for a profile, so the summary
   * is all the cost it can carry. This has the profile, so it does not need the
   * summary. @see `../lib/battler`'s `weaponHandling`
   */
  requirements: ItemCardRequirement[];
  effects: ItemCardEffect[];
  /**
   * What to head the effects list with.
   *
   * Here rather than in the drawing because it is wording, and because the
   * spoken card has to use the same one: a stone's grants have a chance like a
   * weapon's, so a heading picked from that alone would tell a player their
   * necklace burns people "on hit".
   */
  effectsTitle: string;
  /**
   * The kinds of blow this is unusually good against, worst-hit first.
   *
   * Empty for everything that is not armour, and for the plain clothing that is
   * the common case: a piece that says nothing about kinds is the same against
   * all of them, and a table of five equal rows would be five ways of writing
   * the flat number again.
   */
  resists: ItemCardResist[];
  /**
   * The whole card as one string, for anything reading the page aloud.
   *
   * The same content by a different route, not a summary. A sighted reader gets
   * a table; a screen reader gets these sentences. The drawn card is
   * `aria-hidden` so the two do not both appear in one accessible name.
   */
  speech: string;
};

/** What the mastery ratio comes to as a percentage a reader can hold. */
function percent(fraction: number): number {
  return Math.round(fraction * 100);
}

/**
 * A body carrying nothing but these masteries, so `fightingStats` can be asked.
 *
 * The natural weapon is the weapon being inspected rather than a stand-in: it
 * is never read on this path — a held weapon replaces it, and here there is
 * nothing else to hold — and putting the real one there means no invented
 * profile can leak into an answer if that ever changes.
 *
 * The base is the editor's default for the opposite reason: an item card says
 * what a *weapon* is worth, never how much killing its holder takes, so the one
 * field of `fightingStats` this cannot honestly answer is the one nothing here
 * reads. Anything other than a fixed number would be a body's size leaking into
 * a card about a sword.
 */
function bodyWith(masteries: BattlerDef["masteries"], weapon: WeaponItem): BattlerDef {
  return {
    baseHp: DEFAULT_BASE_HP,
    masteries,
    naturalWeapon: weapon,
    sight: { up: 0, down: 0 },
    kit: [],
  };
}

/** How long a grant runs, read off the override or off the status itself. */
function durationOf(grant: StatusGrant, def: StatusDef): string {
  const fromMs = grant.fromMs ?? def.fromMs;
  const toMs = grant.toMs ?? def.toMs;
  return fromMs === toMs ? seconds(toMs) : `${seconds(fromMs)}–${seconds(toMs)}`;
}

/**
 * What a weapon reaches, in words.
 *
 * An arm's length is named rather than measured, because "1.5 cells" is a
 * number nobody can picture and "Melee" is the thing every player already knows
 * — and every melee weapon in the game shares the one figure. Anything longer
 * says how far, and says whether it throws something, because a six-cell reach
 * that fires an arrow and a six-cell reach that does not are different weapons.
 *
 * **A floor is stated as a span**, because it is the one number on the card that
 * says what a weapon *cannot* do. A bow reading "8 cells, fired" and a bow
 * reading "2–8 cells, fired" are the same weapon everywhere except the fight
 * you are about to lose, and a player who has to discover the hole by standing
 * in it has been told nothing. @see `../lib/item`'s `Reach.min`
 *
 * The stats panel asks the same question of a *body* and answers it shorter —
 * see `./attributes`'s `Attributes.reach`, which has about fourteen characters
 * to say it in. Both name an arm's length rather than measuring it, and both
 * state a floor as a span; only this one has room for the arrow.
 */
function reachLine(thing: {
  reach?: Reach;
  projectile?: string;
}): string {
  const reach = reachOf(thing);
  const far = reach.min ? `${reach.min}–${reach.cells}` : `${reach.cells}`;
  if (isRanged(thing)) return `${far} cells, fired`;
  // The floor decides before the ceiling does: a weapon you cannot use in
  // somebody's face is not "Melee" however short its reach, and saying so would
  // be the card contradicting the one thing it is there to warn about.
  if (!reach.min && reach.cells <= MELEE_REACH.cells) return "Melee";
  return `${far} cells`;
}

/**
 * Statuses named against the catalogue, in the order they were authored.
 *
 * An id the catalogue does not hold is **skipped**, which is the same answer
 * every other reader of a status id gives: renamed content should read as an
 * effect that did not happen, not as a card that will not draw.
 */
function effectsFrom(
  grants: readonly (StatusGrant & { chance?: number })[] | undefined,
  statusDefs: Record<string, StatusDef>,
): ItemCardEffect[] {
  if (!grants?.length) return [];
  const effects: ItemCardEffect[] = [];
  for (const grant of grants) {
    const def = statusDefs[grant.id];
    if (!def) continue;
    effects.push({
      id: def.id,
      name: def.name,
      description: def.description,
      tone: def.tone,
      ...(def.icon ? { icon: def.icon } : {}),
      chance: grant.chance ?? null,
      duration: durationOf(grant, def),
    });
  }
  return effects;
}

/**
 * Every mastery this asks for, against what the reader has, worst first.
 *
 * "Worst" means most points missing, not furthest behind proportionally,
 * because points are what `requirementShare` sums: it pools points brought over
 * points asked, so an axe wanting Toughness 20 from a body with 8 is held back
 * by those twelve missing points regardless of its other requirements. Sorting
 * this way puts the requirement worth training first.
 *
 * Requirements already met still get a row and sort to the bottom. What a
 * weapon asks is part of what it is: somebody choosing between two swords wants
 * to know what the better one will ask before they have it. This is the same
 * choice `../lib/weaponDemand` makes for the world's look label.
 */
function requirementsFrom(
  requirements: Masteries | undefined,
  masteries: BattlerDef["masteries"],
): ItemCardRequirement[] {
  const rows: ItemCardRequirement[] = [];
  for (const mastery of MASTERIES) {
    const required = requirements?.[mastery] ?? 0;
    // A requirement of zero is not a requirement — the same reading
    // `requirementShare` gives it, and the reason an absent key needs no special
    // case here.
    if (required <= 0) continue;
    const have = masteryLevel(masteries, mastery);
    rows.push({ mastery, required, have, met: have >= required });
  }
  const missing = (row: ItemCardRequirement) =>
    Math.max(0, row.required - row.have);
  return rows.sort((a, b) => missing(b) - missing(a));
}

function weaponStats(
  weapon: WeaponItem,
  masteries: BattlerDef["masteries"],
): ItemCardStat[] {
  // Through the engine rather than restated here: see the module doc. Both
  // profiles come out of the same function so the comparison cannot be between
  // two different definitions of what a weapon is worth.
  const yours = fightingStats(bodyWith(masteries, weapon), weapon);
  // **The weapon in the hands of somebody who has just earned it**, which is the
  // only body it can honestly be compared against.
  //
  // This used to be a body that had learnt *nothing*, holding a copy with its
  // requirements stripped — the profile the editor's Damage box holds. That
  // number is nobody's: `../lib/battler`'s `damageAtMastery` scales its terms by
  // the absolute level of the weapon's mastery, so the authored figure belongs
  // to a wielder at mastery zero, and for any weapon asking anything at all such
  // a wielder cannot pick it up. A battleaxe written as 64 struck through
  // against your 76 was inviting you to compare yourself with a hand that has
  // never held one.
  //
  // Against a just-qualified wielder the row answers a question a player has —
  // "am I getting more out of this than somebody who just picked it up" — and,
  // at exactly the requirement, the two agree and the comparison disappears,
  // which is the honest reading of having only just earned the thing. See
  // {@link ItemCardStat.base}, which is dropped wherever the pair matches.
  const own = fightingStats(bodyWith(weapon.requirements ?? {}, weapon), weapon);

  // Through `swingIntervalMs` rather than the weapon's curve alone, because
  // Agility is now a multiplier on the rate that `spd` has no room to carry —
  // see `../lib/battler`'s `haste`. A quick body swinging a heavy axe is a
  // hastened heavy axe, and the row has to say so.
  const yourIntervalMs = swingIntervalMs(yours);
  const ownIntervalMs = swingIntervalMs(own);
  const yourHit = percent(yours.hitChance);
  const ownHit = percent(own.hitChance);
  const yourDamage = damageBand(yours);
  const ownDamage = damageBand(own);
  const yourDamageLabel = bandLabel(yourDamage.min, yourDamage.max);
  const ownDamageLabel = bandLabel(ownDamage.min, ownDamage.max);

  const stats: ItemCardStat[] = [
    {
      // **The band, and there is no variance row underneath it.** The card used
      // to print `dmg 12` and `spread ±35%`, which is a face value nobody ever
      // takes and a percentage of it to subtract — two rows asking the reader to
      // multiply before they know what the weapon does. "8–12" is the same fact
      // as the answer, and it is also how a player thinks about the fight: what
      // it takes to kill the thing in front of you is worked out from both ends
      // at once. The panel has reported a body's damage this way all along; this
      // is the weapon agreeing with it. @see `./combat`'s `damageBand`
      term: "damage",
      value: yourDamageLabel,
      ...(yourDamageLabel === ownDamageLabel ? {} : { base: ownDamageLabel }),
      tone: bandTone(yourDamage, ownDamage),
    },
    {
      term: "swing",
      value: seconds(yourIntervalMs),
      ...(yourIntervalMs === ownIntervalMs ? {} : { base: seconds(ownIntervalMs) }),
      // Inverted against every other row: a shorter wait is the better
      // weapon. Comparing backwards here is simpler than converting the figure
      // to a rate, which is not the unit weapons are authored in.
      tone: toneOf(ownIntervalMs, yourIntervalMs),
    },
    {
      // The probability rather than the accuracy behind it, and the choice is
      // worth recording because accuracy does two jobs: it sets this, and it is
      // what a defender's evasion is contested against. Only the first depends
      // on nothing but you and the weapon; the second needs an opponent, which
      // is what the Arena is for. This figure is clamped to the band every
      // chance in a fight is held to, so a master and a grandmaster both read
      // 95% here and differ only against a real defender. It is "Hit" rather
      // than "Accuracy" on both surfaces for exactly that reason — see
      // `../lib/terms`.
      term: "hit",
      value: `${yourHit}%`,
      ...(yourHit === ownHit ? {} : { base: `${ownHit}%` }),
      tone: toneOf(yourHit, ownHit),
    },
    { term: "range", value: reachLine(weapon), tone: "plain" },
  ];

  // Only where there is any. Defence is the one number most weapons leave at
  // zero, and a row of zeroes on every sword in the game would bury the shields
  // that have something to say here.
  if (weapon.def > 0) {
    stats.push({
      term: "defence",
      // The weapon's own, never `yours.def` — which now carries the body's
      // Toughness as well (see `../lib/battler`'s `defFrom`) and would have a
      // sword in a veteran's hand claiming credit for their ribs.
      value: `${weapon.def}`,
      tone: "good",
    });
  }

  return stats;
}

/**
 * Which way a band leans against the item's own.
 *
 * The top end decides, and the floor only breaks a tie. Mastery scales `damage`
 * and leaves `variance` alone, so both ends move together and the top is the one
 * that always moves: a point of damage raises the ceiling by a point and may
 * leave the rounded floor exactly where it was.
 */
function bandTone(yours: DamageBand, own: DamageBand): ItemCardTone {
  const ceiling = toneOf(yours.max, own.max);
  return ceiling === "plain" ? toneOf(yours.min, own.min) : ceiling;
}

/** Better than a fresh owner reads well; worse reads badly; equal is silent. */
function toneOf(yours: number, own: number): ItemCardTone {
  if (yours > own) return "good";
  if (yours < own) return "bad";
  return "plain";
}

/**
 * What a worn thing does: one number, and sometimes a table.
 *
 * There is no "in your hands" figure here because armour has no requirements to
 * meet — see `../lib/item`'s `ArmorItem` — so nothing about the reader changes
 * what it is worth.
 */
function armorStats(armor: ArmorItem): ItemCardStat[] {
  return [
    {
      // The same word a shield's row uses, so a thing you hold and a thing you
      // wear read alike — they are the same field and they add up. See
      // `./equipment`'s `wornDefence`, which is where the adding happens. One
      // term, so that cannot come apart. @see `../lib/terms`
      term: "defence",
      value: `${armor.def}`,
      tone: "good",
    },
  ];
}

/**
 * What each kind of blow loses against this, for the kinds that lose more.
 *
 * Totals rather than bonuses, and sorted by how much they stop — the piece's
 * best answer first, because "what is this *for*" is the question a resistance
 * table exists to answer.
 */
function resistsFrom(armor: ArmorItem): ItemCardResist[] {
  const rows: ItemCardResist[] = [];
  for (const mastery of WEAPON_MASTERIES) {
    const extra = armor.resist?.[mastery] ?? 0;
    // Zero is not a resistance, the same way a requirement of zero is not a
    // requirement: an editor round trip writes the key either way, and a row
    // saying this armour is ordinary against blades restates the flat number.
    if (extra <= 0) continue;
    rows.push({ mastery, total: armor.def + extra, extra });
  }
  return rows.sort((a, b) => b.total - a.total);
}

/** A minus that matches the figures beside it, rather than a hyphen. */
const MINUS = "\u2212";

/**
 * What swallowing this moves, signed.
 *
 * **The sign rather than a verb**, and it is doing the work "Restores" and
 * "Costs" used to: a reader who cannot separate the green from the red sees a
 * bare figure, and a bare figure beside a loaf could be either. The same
 * argument, and the same arithmetic, as `../render/damageNumbers`' `MEND_SIGN`.
 */
function consumableStats(consumable: ConsumableItem): ItemCardStat[] {
  if (consumable.hp === 0) return [];
  const healing = consumable.hp > 0;
  return [
    {
      term: "health",
      value: `${healing ? "+" : MINUS}${Math.abs(consumable.hp)}`,
      tone: healing ? "good" : "bad",
    },
  ];
}

/**
 * What a charm does, and how often it does it.
 *
 * **The interval is not decoration here, it is the whole cost of the thing** —
 * see `../lib/item`'s `CharmItem.everyMs`. A trinket mending one point every ten
 * seconds and one mending it every ten minutes are the same `hp` row and
 * completely different objects to be wearing.
 *
 * The health row is dropped where there is none, because a charm that only
 * grants statuses is an ordinary thing to author and a row of `+0` would say it
 * mends nothing rather than that mending is not what it is for. The statuses
 * themselves are the effects list, not a row.
 */
function charmStats(charm: CharmItem): ItemCardStat[] {
  const stats: ItemCardStat[] = [];
  if (charm.hp) {
    // Signed like a consumable's, though a charm's may only ever be positive:
    // the two rows sit under the same heading on a body's worth of kit, and one
    // of them wearing its sign would read as the other having lost it.
    stats.push({
      term: "health",
      value: `+${charm.hp}`,
      tone: "good",
    });
  }
  stats.push({
    term: "cadence",
    value: seconds(charm.everyMs),
    tone: "plain",
  });
  return stats;
}

function containerStats(
  container: ContainerItem,
  instance: ItemInstance | null,
): ItemCardStat[] {
  const used = instance?.contents?.length ?? 0;
  return [
    {
      term: "slots",
      // What is in *this* one against what it takes, because a four-slot bag
      // with one thing in it and a one-slot bag that is full are the same
      // contents and completely different situations to be in — the same fact
      // `../components/ContainerPanel` draws its empty squares for.
      value: `${used} / ${container.size}`,
      tone: "plain",
    },
    {
      term: "worn",
      // The square it goes in, or nothing — which is the whole answer for a
      // crate: a container that cannot be worn is opened where it lies, and
      // saying so was the row explaining its own empty half.
      value: container.equippable ? "Back" : "No",
      tone: "plain",
    },
  ];
}

/**
 * What kind of thing this is, in one phrase.
 *
 * A weapon says which hand and which mastery, because those are the two facts
 * that decide whether it is even a candidate: a shield cannot go where a sword
 * goes, and a blade in the hands of an archer is a different weapon from the
 * same blade in a swordsman's. A consumable says the author's own verb, so the
 * card and the row in the world use one word for one act.
 */
function kindOf(item: ItemDef): string {
  if (item.type === "weapon") {
    // How many hands it costs. A two-handed weapon refuses the other square
    // outright, and nothing in the numbers says so. See `../lib/item`'s
    // `twoHanded`.
    const hands = item.twoHanded ? "Both hands" : "One hand";
    // Through the shared label table rather than upper-casing the key here, so
    // the card and the editor field that authored it use one spelling.
    return `${hands} — ${MASTERY_LABELS[item.mastery]}`;
  }
  if (item.type === "armor") return ARMOR_SLOT_LABELS[armorSlotOf(item)];
  if (item.type === "shield") return "Either hand";
  if (item.type === "stone") return "Arcane stone";
  if (item.type === "charm") return "Charm";
  if (item.type === "artifact") return "Carried";
  if (item.type === "consumable") return consumeVerb(item);
  return "Container";
}

/**
 * What each worn square is called on screen.
 *
 * The player's word rather than the stored key. The chest square is `armor` on
 * the wire because it was the only one when it was named — see `../lib/item`'s
 * `ARMOR_SLOTS` — and a card reading "armor" would be showing a field name.
 *
 * **The square's own caption**, matching `../components/EquipmentPanel`'s
 * squares exactly. A card that said "worn on your body" while the square it
 * goes in said "Armour" made the reader match a sentence to a picture; the
 * caption is already the shortest true answer to what kind of thing this is.
 */
const ARMOR_SLOT_LABELS: Record<ArmorSlot, string> = {
  head: "Head",
  armor: "Armour",
  footwear: "Footwear",
  // The square, not the kind. A {@link CharmItem} is a "Charm" — see
  // {@link kindOf} — and the square it goes in takes three other kinds besides.
  charm: "Accessory",
};

/** What the list of statuses an item hands over should be called. */
function effectsTitleFor(item: ItemDef): string {
  if (item.type === "weapon") return HEADINGS.onHit;
  if (item.type === "stone") return HEADINGS.onCast;
  return HEADINGS.grants;
}

/**
 * What this item asks of whoever uses it, for the two kinds that ask anything.
 *
 * A stone's requirements are reported even though it has no share to go with
 * them, and they matter more than a weapon's: an unmet requirement refuses the
 * cast outright rather than weakening it. See `../lib/item`'s
 * `ArcaneStoneItem.requirements`.
 */
function demandsOf(item: ItemDef): Masteries | undefined {
  if (item.type === "weapon" || item.type === "stone") return item.requirements;
  return undefined;
}

/**
 * Whatever statuses this item hands over, wherever its kind keeps them.
 *
 * A stone's are inside its bolt rather than on the block, because a conjure
 * touches a cell and has nobody to put a status on. Everything else that grants
 * one keeps the list at the top level.
 */
function grantsOn(item: ItemDef): readonly (StatusGrant & { chance?: number })[] | undefined {
  if (item.type === "weapon" || item.type === "consumable") return item.statuses;
  // A charm's list is the consumable's, validated by the consumable's schema
  // and rolled by the same `inflictedBy` — see `../lib/item`'s `CharmItem`. Its
  // cadence is the `every` row rather than part of the heading.
  if (item.type === "charm") return item.statuses;
  if (item.type === "stone" && item.effect.kind === "bolt") return item.effect.statuses;
  return undefined;
}

/**
 * What holding or wearing this attunes its bearer to.
 *
 * Only four kinds carry elements, and the rest have none rather than an empty
 * opinion. See `../lib/item`'s `WeaponItem.elements`.
 */
function elementsOf(item: ItemDef): Element[] {
  if (
    item.type === "weapon" ||
    item.type === "armor" ||
    item.type === "shield" ||
    item.type === "stone"
  ) {
    return item.elements ?? [];
  }
  return [];
}

/**
 * The rows for whichever kind of item this is.
 *
 * A function rather than a chain of ternaries at the call site: there are seven
 * kinds now, and an eighth would push the expression past the nesting this
 * codebase allows. Kinds with nothing to say return no rows, which is the right
 * answer for an artifact — see {@link artifactStats}.
 */
function statsFor(
  item: ItemDef,
  instance: ItemInstance | null,
  masteries: BattlerDef["masteries"],
): ItemCardStat[] {
  if (item.type === "weapon") return weaponStats(item, masteries);
  if (item.type === "armor") return armorStats(item);
  if (item.type === "shield") return shieldStats(item);
  if (item.type === "stone") return stoneStats(item);
  if (item.type === "consumable") return consumableStats(item);
  if (item.type === "charm") return charmStats(item);
  if (item.type === "container") return containerStats(item, instance);
  // An artifact is the kind with no fields at all — a torch, a key, a shard —
  // and everything it does it does by being a placement: its light, its sprite,
  // its being in the way. Inventing a figure for one would describe a weapon,
  // which is what a torch stopped being.
  return [];
}

/**
 * What a shield does, which is the flat half of what armour does.
 *
 * Its own arm rather than armour's because a shield is held and has no `resist`
 * to go with it. See `../lib/item`'s `ShieldItem` for why neither hand has an
 * opinion about what kind of blow it stops.
 */
function shieldStats(shield: ShieldItem): ItemCardStat[] {
  return [
    {
      term: "defence",
      value: `${shield.def}`,
      tone: "good",
    },
  ];
}

/**
 * What a stone does when it is pressed.
 *
 * A bolt reports what it moves and on whom; a conjure reports that it puts
 * something in a cell, and not what — the tile id is an authoring detail and the
 * player finds out by casting. Both report the cooldown, which is the cost, and
 * the reach, which decides whether the thing you are pointing at is in range.
 *
 * No "in your hands" share, unlike a weapon. A stone's requirements refuse the
 * cast outright rather than weakening it — see `../lib/item`'s
 * `ArcaneStoneItem.requirements` — so there is no partial figure to report. The
 * requirement rows still appear, because whether you can cast it at all is
 * exactly what a reader wants to know.
 */
function stoneStats(stone: ArcaneStoneItem): ItemCardStat[] {
  const stats: ItemCardStat[] = [];

  if (stone.effect.kind === "bolt") {
    const { damage = 0, on, variance = 0 } = stone.effect;
    if (damage !== 0) {
      // A band, on the terms `weaponStats` states at length: a bolt rolls the
      // same `damageFraction` a blow does, so it had the same face value and the
      // same percentage to subtract underneath it.
      const band = damageBandOf(Math.abs(damage), variance);
      // The sign is the difference between a stone of embers and a stone of
      // life. See `../lib/item`'s `StoneEffect`, which is one signed number
      // rather than two arms for that reason.
      const mending = damage < 0;
      stats.push({
        term: mending ? "heal" : "damage",
        value: bandLabel(band.min, band.max),
        tone: mending ? "good" : "plain",
      });
    }
    stats.push({
      term: "subject",
      value: on === "caster" ? "You" : "Your target",
      tone: "plain",
    });
  } else {
    stats.push({
      term: "conjure",
      // Not which tile: that is an authoring detail, and the player finds out
      // by casting.
      value: "A tile",
      tone: "plain",
    });
  }

  stats.push({
    term: "cooldown",
    value: seconds(stone.cooldownMs),
    tone: "plain",
  });
  stats.push({
    term: "range",
    value: reachLine(stone),
    tone: "plain",
  });
  return stats;
}

/**
 * What looking at one item says, for the hands doing the looking.
 *
 * Null for anything that is not an item, which is most of what a player can
 * point at. There is nothing to show for a wall.
 *
 * @param def the tile, which is where everything shared lives.
 * @param instance this particular one, or null when there is no copy in hand —
 *   a card can be asked about a thing on the floor.
 * @param masteryXp what the *reader* has learnt, never what the item's owner
 *   has: a sword in a chest is inspected by whoever is standing over it.
 */
export function itemCard(
  def: TileDef,
  instance: ItemInstance | null,
  masteryXp: MasteryXp,
  statusDefs: Record<string, StatusDef> = {},
): ItemCard | null {
  const item = resolveItem(def);
  if (!item) return null;

  const masteries = masteriesFromXp(masteryXp);

  const count = instance ? countOf(instance) : 1;

  const card: ItemCard = {
    // The engraving filled in, which for a skull is the whole of what it is.
    // Free for everything else — see `../lib/engraving`.
    name: engravedName(def.name || def.id, instance?.engraved),
    // Null rather than 1, so the drawing has nothing to suppress: a single
    // apple is an apple, and "×1" is a badge that says what its absence says.
    count: count > 1 ? count : null,
    elements: elementsOf(item),
    kind: kindOf(item),
    inscription: instance?.inscription?.trim() || null,
    description: instance?.description?.trim() || null,
    stats: statsFor(item, instance, masteries),
    requirements: requirementsFrom(demandsOf(item), masteries),
    effects: effectsFrom(grantsOn(item), statusDefs),
    resists: item.type === "armor" ? resistsFrom(item) : [],
    effectsTitle: effectsTitleFor(item),

    speech: "",
  };

  return { ...card, speech: speak(card) };
}

/**
 * A clause, ready to be joined by the full stop {@link speak} puts between them.
 *
 * Whatever a line already ends with is dropped, because these are authored
 * strings — a status description ends in a full stop of its own, and two in a row
 * is a stutter in the middle of a sentence nobody can see to fix.
 */
function clause(line: string): string {
  return line.replace(/[.\s]+$/, "");
}

/**
 * A caption written for a column, at the start of a sentence.
 *
 * A term's spoken form is a clause written to sit mid-sentence — "a blow every"
 * — because that is what it is read against. {@link speak} joins its clauses
 * with full stops, so each one begins a sentence and has to look like it.
 */
function sentenceCase(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** The card as sentences, in the order it is drawn. */
function speak(card: ItemCard): string {
  const lines: string[] = [
    card.count === null ? card.name : `${card.name}, ${card.count} of them`,
  ];
  if (card.kind) lines.push(card.kind);
  if (card.elements.length > 0) {
    lines.push(`Attuned to ${card.elements.join(" and ")}`);
  }
  if (card.inscription) lines.push(card.inscription);
  if (card.description) lines.push(card.description);
  for (const stat of card.stats) {
    // The clause where the caption is not one — "Swing: 1.2s" read out is not
    // a sentence and "A blow every: 1.2s" is. Most terms need no second
    // form, which is what whole words bought over the abbreviations the rows
    // used to carry. @see `../lib/terms`'s `termSpoken`
    const said = sentenceCase(termSpoken(stat.term));
    // The other figure spoken as a clause rather than as a bracket, since a
    // screen reader reads "(8)" as "eight" and the comparison disappears. The
    // body it belongs to is named, because "the item's own" was the old
    // baseline's wording and this one is somebody rather than something.
    lines.push(
      stat.base
        ? `${said}: ${stat.value}, where somebody who has just earned it gets ${stat.base}`
        : `${said}: ${stat.value}`,
    );
  }
  for (const row of card.resists) {
    // The flat number restated rather than looked up off the stat row, which
    // carries the reader's own arithmetic and a label written for a column.
    lines.push(
      `${MASTERY_LABELS[row.mastery]} blows lose ${row.total} rather than ${row.total - row.extra}`,
    );
  }
  for (const row of card.requirements) {
    lines.push(
      `Requires ${MASTERY_LABELS[row.mastery]} ${row.required}, you have ${row.have}`,
    );
  }
  for (const effect of card.effects) {
    lines.push(
      effect.chance === null
        ? `${card.effectsTitle}: ${effect.name} for ${effect.duration}. ${effect.description}`
        : `${card.effectsTitle}: ${effect.name}, ${effect.chance}% of the time, for ${effect.duration}. ${effect.description}`,
    );
  }
  return lines.map(clause).join(". ");
}
