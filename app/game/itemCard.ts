import type { BattlerDef } from "../lib/battler";
import { fightingStats, weaponReadiness } from "../lib/battler";
import {
  consumeVerb,
  isRanged,
  MELEE_REACH,
  reachOf,
  resolveItem,
  type ConsumableItem,
  type ContainerItem,
  type ItemDef,
  type StatusGrant,
  type WeaponItem,
} from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import {
  MASTERIES,
  masteriesFromXp,
  masteryLevel,
  type Mastery,
  type MasteryXp,
  requirementShare,
} from "../lib/mastery";
import type { StatusDef } from "../lib/status";
import type { SpriteRef } from "../lib/types";
import type { TileDef } from "../lib/types";
import { swingIntervalMs } from "./combat";

/**
 * Everything looking at one item has to say, as data rather than as a drawing.
 *
 * ## Why the numbers came back
 *
 * They were deliberately absent, and the argument was a good one: a panel that
 * ranked your weapons answers the only question the fighting has to offer. What
 * that argument got right is that nothing should *volunteer* a figure. What it
 * got wrong is that it turned the ones a player asked for into prose.
 *
 * `../lib/weaponDemand` settled that for the gate — a player holding a sword
 * that does nothing needs to know which mastery is short and by how much, and no
 * amount of atmosphere carries it. This is the same conclusion for the rest of
 * the profile. Somebody holding two swords is not asking to be told which is
 * better; they are asking what the difference *is*, and no sentence distinguishes
 * a fast light blade from a slow heavy one without saying how fast and how
 * heavy.
 *
 * ## In your hands, not on the shelf
 *
 * Every figure here is what the item is worth **to the body asking**, run
 * through the same `fightingStats` a swing is resolved with. A greataxe you
 * cannot lift says six damage rather than seventeen, because six is what you
 * would do with it. {@link ItemCardStat.base} carries the item's own number
 * alongside, so the gap between the two is visible rather than something the
 * reader has to know is there.
 *
 * That is also the whole reason this module derives nothing itself. Restating
 * `fightingStats`' arithmetic here would be a second definition of what a weapon
 * is worth, and the two would drift the first time somebody tuned the falloff.
 *
 * ## Data, not JSX
 *
 * `../components/ItemCard` draws this and knows no rules; this knows no colours.
 * The split is what makes the wording assertable in a unit test, which for text
 * a player reads off a weapon before betting their life on it is most of the
 * point.
 */

/** Which way a figure leans against the item's own. */
export type ItemCardTone = "plain" | "good" | "bad";

/** One line of the profile: what it is, what it comes to, how that reads. */
export type ItemCardStat = {
  /** Stable across renders and across items, so a list can key on it. */
  key: string;
  label: string;
  /** What the body asking gets. */
  value: string;
  /**
   * What is written on the item, where that differs from {@link value}.
   *
   * Absent when the two agree, which is the common case: a figure the mastery
   * ratio does not touch has nothing to compare against, and printing "8 (8)"
   * would invite the reader to look for a difference that is not there.
   */
  base?: string;
  tone: ItemCardTone;
};

/** One mastery an item asks for, against the one the reader has. */
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
  icon?: SpriteRef;
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

export type ItemCard = {
  /** The tile's name, never the instance's. See {@link ItemCard.description}. */
  name: string;
  /**
   * What kind of thing this is, in the terms the panel puts it in: "Main hand —
   * Blade", "Off hand — Blunt", "Food", "Container".
   *
   * Null for an item whose block does not parse, which is the same silence the
   * rest of this structure keeps about one.
   */
  kind: string | null;
  /**
   * What is written on *this* one, where anything is.
   *
   * Kept apart from {@link name} on the terms `../render/GameRenderer`'s
   * `lookLines` keeps them apart: "Left here by someone" answers a different
   * question from "Rusty Sword", and a card that swapped one for the other would
   * leave a player unable to find out what they had picked up.
   */
  description: string | null;
  stats: ItemCardStat[];
  requirements: ItemCardRequirement[];
  /**
   * How much of this item the reader actually gets, as a percentage.
   *
   * `weaponReadiness` of the pooled `requirementShare`, in the unit a player can
   * read — and the same number `../lib/weaponDemand` prints over the canvas, so
   * the sword on the floor and the sword in your bag cannot disagree about it.
   *
   * **Never above a hundred.** Requirements are a gate rather than a scaling
   * term: meeting them is worth all of the weapon and exceeding them is worth
   * nothing more. Being *good* with it is a separate matter and shows up in the
   * figures above — see `../lib/battler`'s `MASTERY_DAMAGE_BONUS`, which is why
   * a master's damage can exceed the number stamped on the blade while this
   * still reads 100%.
   *
   * Null for anything that is not a weapon, which has no such question.
   */
  effectiveness: number | null;
  effects: ItemCardEffect[];
  /**
   * The whole card as one string, for anything reading the page aloud.
   *
   * **Not a fallback and not a summary** — it is the same content by the other
   * route. A sighted reader gets a table; a screen reader gets these sentences,
   * and neither is told less than the other. The drawn card is `aria-hidden` for
   * exactly this reason: two copies of one fact in one accessible name reads it
   * twice.
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
 */
function bodyWith(masteries: BattlerDef["masteries"], weapon: WeaponItem): BattlerDef {
  return { masteries, naturalWeapon: weapon, sight: { up: 0, down: 0 }, kit: [] };
}

/**
 * Seconds, with a decimal only where one says something.
 *
 * A tenth matters at the bottom of the scale — the difference between a blow
 * every 0.3s and every 0.9s is the whole of what makes a weapon fast — and says
 * nothing at the top, where a range would otherwise read "5.0s–20s" and invite
 * the reader to wonder what happened to the other end's precision.
 */
function seconds(ms: number): string {
  const s = ms / 1000;
  return s < 10 ? `${Number(s.toFixed(1))}s` : `${Math.round(s)}s`;
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
 */
function reachLine(weapon: WeaponItem): string {
  const reach = reachOf(weapon);
  if (isRanged(weapon)) return `${reach.cells} cells, fired`;
  if (reach.cells <= MELEE_REACH.cells) return "Melee";
  return `${reach.cells} cells`;
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

/** Every mastery this asks for, against what the reader has, worst first. */
function requirementsFrom(
  weapon: WeaponItem,
  masteries: BattlerDef["masteries"],
): ItemCardRequirement[] {
  const rows: ItemCardRequirement[] = [];
  for (const mastery of MASTERIES) {
    const required = weapon.requirements?.[mastery] ?? 0;
    // A requirement of zero is not a requirement — the same reading
    // `masteryRatio` gives it, and the reason an absent key needs no special
    // case here.
    if (required <= 0) continue;
    const have = masteryLevel(masteries, mastery);
    rows.push({ mastery, required, have, met: have >= required });
  }
  // Furthest behind first, so the one thing standing between the reader and the
  // weapon is the first line they read — it is also the requirement the ratio
  // was decided by, and burying it under the ones already met would be showing
  // the answer below the working.
  return rows.sort((a, b) => a.have - a.required - (b.have - b.required));
}

function weaponStats(
  weapon: WeaponItem,
  masteries: BattlerDef["masteries"],
): ItemCardStat[] {
  // Through the engine rather than restated here: see the module doc. Both
  // profiles come out of the same function so the comparison cannot be between
  // two different definitions of what a weapon is worth.
  const yours = fightingStats(bodyWith(masteries, weapon), weapon);
  const own = fightingStats(bodyWith({}, weapon), { ...weapon, requirements: undefined });

  // Through `swingIntervalMs` rather than the weapon's curve alone, because
  // Agility is now a multiplier on the rate that `spd` has no room to carry —
  // see `../lib/battler`'s `haste`. A quick body swinging a heavy axe is a
  // hastened heavy axe, and the row has to say so.
  const yourIntervalMs = swingIntervalMs(yours);
  const ownIntervalMs = swingIntervalMs(own);
  const yourHit = percent(yours.hitChance);
  const ownHit = percent(own.hitChance);

  const stats: ItemCardStat[] = [
    {
      key: "damage",
      label: "Damage",
      value: `${yours.damage}`,
      ...(yours.damage === own.damage ? {} : { base: `${own.damage}` }),
      tone: toneOf(yours.damage, own.damage),
    },
    {
      key: "speed",
      label: "Blow every",
      value: seconds(yourIntervalMs),
      ...(yourIntervalMs === ownIntervalMs ? {} : { base: seconds(ownIntervalMs) }),
      // Backwards against every other row, and deliberately: a shorter wait is
      // a better weapon, so the comparison is inverted here rather than the
      // figure being turned into a rate nobody authors in.
      tone: toneOf(ownIntervalMs, yourIntervalMs),
    },
    {
      key: "hit",
      label: "Chance to land",
      value: `${yourHit}%`,
      ...(yourHit === ownHit ? {} : { base: `${ownHit}%` }),
      tone: toneOf(yourHit, ownHit),
    },
    {
      key: "spread",
      label: "Damage spread",
      // Untouched by mastery — how erratic a weapon is belongs to the weapon,
      // so there is never a second figure to compare against.
      value: `±${weapon.variance}%`,
      tone: "plain",
    },
    { key: "reach", label: "Reach", value: reachLine(weapon), tone: "plain" },
  ];

  // Only where there is any. Defence is the one number most weapons leave at
  // zero, and a row of zeroes on every sword in the game would bury the shields
  // that have something to say here.
  if (weapon.def > 0) {
    stats.push({
      key: "def",
      label: "Blocks",
      value: `${weapon.def} a blow`,
      tone: "good",
    });
  }

  return stats;
}

/** Better than the item's own reads well; worse reads badly; equal is silent. */
function toneOf(yours: number, own: number): ItemCardTone {
  if (yours > own) return "good";
  if (yours < own) return "bad";
  return "plain";
}

function consumableStats(consumable: ConsumableItem): ItemCardStat[] {
  if (consumable.hp === 0) return [];
  const healing = consumable.hp > 0;
  return [
    {
      key: "hp",
      label: healing ? "Restores" : "Costs",
      value: `${Math.abs(consumable.hp)} health`,
      tone: healing ? "good" : "bad",
    },
  ];
}

function containerStats(
  container: ContainerItem,
  instance: ItemInstance | null,
): ItemCardStat[] {
  const used = instance?.contents?.length ?? 0;
  return [
    {
      key: "slots",
      label: "Holds",
      // What is in *this* one against what it takes, because a four-slot bag
      // with one thing in it and a one-slot bag that is full are the same
      // contents and completely different situations to be in — the same fact
      // `../components/ContainerPanel` draws its empty squares for.
      value: `${used} / ${container.size}`,
      tone: "plain",
    },
    {
      key: "worn",
      label: "Worn",
      value: container.equippable ? "On your back" : "Not worn — opened where it lies",
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
    // How many hands it costs, because that is the fact that decides whether it
    // can be in a kit at all — a two-hander refuses the other square, and no
    // amount of reading the numbers tells you so. See `../lib/item`'s
    // `twoHanded`.
    const hands = item.twoHanded ? "Both hands" : "One hand";
    // The mastery it trains, capitalised: it is the name of a thing on the
    // stats panel, and a lower-case "blade" here would read as the noun.
    return `${hands} — ${item.mastery[0]!.toUpperCase()}${item.mastery.slice(1)}`;
  }
  if (item.type === "consumable") return consumeVerb(item);
  return "Container";
}

/**
 * What looking at one item says, for the hands doing the looking.
 *
 * Null for anything that is not an item at all, which is most of what a player
 * can point at — a card for a wall would be a window explaining that there is
 * nothing to look at.
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
  const weapon = item.type === "weapon" ? item : null;

  const card: ItemCard = {
    name: def.name || def.id,
    kind: kindOf(item),
    description: instance?.description?.trim() || null,
    stats:
      item.type === "weapon"
        ? weaponStats(item, masteries)
        : item.type === "consumable"
          ? consumableStats(item)
          : item.type === "container"
            ? containerStats(item, instance)
            : [],
    requirements: weapon ? requirementsFrom(weapon, masteries) : [],
    effectiveness: weapon
      ? percent(weaponReadiness(requirementShare(masteries, weapon.requirements)))
      : null,
    effects: effectsFrom(
      item.type === "weapon" || item.type === "consumable" ? item.statuses : undefined,
      statusDefs,
    ),
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

/** The card as sentences, in the order it is drawn. */
function speak(card: ItemCard): string {
  const lines: string[] = [card.name];
  if (card.kind) lines.push(card.kind);
  if (card.description) lines.push(card.description);
  for (const stat of card.stats) {
    // The item's own figure spoken as a clause rather than as a bracket, since
    // a screen reader reads "(8)" as "eight" and the comparison disappears.
    lines.push(
      stat.base
        ? `${stat.label}: ${stat.value}, where the item's own is ${stat.base}`
        : `${stat.label}: ${stat.value}`,
    );
  }
  for (const row of card.requirements) {
    lines.push(
      `Requires ${row.mastery} ${row.required}, you have ${row.have}`,
    );
  }
  if (card.effectiveness !== null && card.requirements.length > 0) {
    lines.push(`You get ${card.effectiveness}% out of it`);
  }
  for (const effect of card.effects) {
    lines.push(
      effect.chance === null
        ? `Grants ${effect.name} for ${effect.duration}. ${effect.description}`
        : `${effect.chance}% of blows inflict ${effect.name} for ${effect.duration}. ${effect.description}`,
    );
  }
  return lines.map(clause).join(". ");
}
