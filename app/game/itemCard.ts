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

export type ItemCardTone = "plain" | "good" | "bad";

export type ItemCardStat = {
  term: TermKey;
  value: string;
  base?: string;
  tone: ItemCardTone;
};

export type ItemCardRequirement = {
  mastery: Mastery;
  required: number;
  have: number;
  met: boolean;
};

export type ItemCardEffect = {
  id: string;
  name: string;
  description: string;
  tone: "good" | "bad";
  icon?: AnchoredSprite;
  chance: number | null;
  duration: string;
};

export type ItemCardResist = {
  mastery: WeaponMastery;
  total: number;
  extra: number;
};

export type ItemCard = {
  name: string;
  count: number | null;
  elements: Element[];
  kind: string | null;
  inscription: string | null;
  description: string | null;
  stats: ItemCardStat[];
  requirements: ItemCardRequirement[];
  effects: ItemCardEffect[];
  effectsTitle: string;
  resists: ItemCardResist[];
  speech: string;
};

function percent(fraction: number): number {
  return Math.round(fraction * 100);
}

function bodyWith(masteries: BattlerDef["masteries"], weapon: WeaponItem): BattlerDef {
  return {
    baseHp: DEFAULT_BASE_HP,
    masteries,
    naturalWeapon: weapon,
    sight: { up: 0, down: 0 },
    kit: [],
  };
}

function durationOf(grant: StatusGrant, def: StatusDef): string {
  const fromMs = grant.fromMs ?? def.fromMs;
  const toMs = grant.toMs ?? def.toMs;
  return fromMs === toMs ? seconds(toMs) : `${seconds(fromMs)}–${seconds(toMs)}`;
}

function reachLine(thing: { reach?: Reach; projectile?: string }): string {
  const reach = reachOf(thing);
  const far = reach.min ? `${reach.min}–${reach.cells}` : `${reach.cells}`;
  if (isRanged(thing)) return `${far} cells, fired`;
  if (!reach.min && reach.cells <= MELEE_REACH.cells) return "Melee";
  return `${far} cells`;
}

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

function requirementsFrom(
  requirements: Masteries | undefined,
  masteries: BattlerDef["masteries"],
): ItemCardRequirement[] {
  const rows: ItemCardRequirement[] = [];
  for (const mastery of MASTERIES) {
    const required = requirements?.[mastery] ?? 0;
    if (required <= 0) continue;
    const have = masteryLevel(masteries, mastery);
    rows.push({ mastery, required, have, met: have >= required });
  }
  const missing = (row: ItemCardRequirement) => Math.max(0, row.required - row.have);
  return rows.sort((a, b) => missing(b) - missing(a));
}

function weaponStats(weapon: WeaponItem, masteries: BattlerDef["masteries"]): ItemCardStat[] {
  const yours = fightingStats(bodyWith(masteries, weapon), weapon);
  const own = fightingStats(bodyWith(weapon.requirements ?? {}, weapon), weapon);

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
      term: "damage",
      value: yourDamageLabel,
      ...(yourDamageLabel === ownDamageLabel ? {} : { base: ownDamageLabel }),
      tone: bandTone(yourDamage, ownDamage),
    },
    {
      term: "swing",
      value: seconds(yourIntervalMs),
      ...(yourIntervalMs === ownIntervalMs ? {} : { base: seconds(ownIntervalMs) }),
      tone: toneOf(ownIntervalMs, yourIntervalMs),
    },
    {
      term: "hit",
      value: `${yourHit}%`,
      ...(yourHit === ownHit ? {} : { base: `${ownHit}%` }),
      tone: toneOf(yourHit, ownHit),
    },
    { term: "range", value: reachLine(weapon), tone: "plain" },
  ];

  if (weapon.def > 0) {
    stats.push({
      term: "defence",
      value: `${weapon.def}`,
      tone: "good",
    });
  }

  return stats;
}

function bandTone(yours: DamageBand, own: DamageBand): ItemCardTone {
  const ceiling = toneOf(yours.max, own.max);
  return ceiling === "plain" ? toneOf(yours.min, own.min) : ceiling;
}

function toneOf(yours: number, own: number): ItemCardTone {
  if (yours > own) return "good";
  if (yours < own) return "bad";
  return "plain";
}

function armorStats(armor: ArmorItem): ItemCardStat[] {
  return [
    {
      term: "defence",
      value: `${armor.def}`,
      tone: "good",
    },
  ];
}

function resistsFrom(armor: ArmorItem): ItemCardResist[] {
  const rows: ItemCardResist[] = [];
  for (const mastery of WEAPON_MASTERIES) {
    const extra = armor.resist?.[mastery] ?? 0;
    if (extra <= 0) continue;
    rows.push({ mastery, total: armor.def + extra, extra });
  }
  return rows.sort((a, b) => b.total - a.total);
}

const MINUS = "\u2212";

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

function charmStats(charm: CharmItem): ItemCardStat[] {
  const stats: ItemCardStat[] = [];
  if (charm.hp) {
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

function containerStats(container: ContainerItem, instance: ItemInstance | null): ItemCardStat[] {
  const used = instance?.contents?.length ?? 0;
  return [
    {
      term: "slots",
      value: `${used} / ${container.size}`,
      tone: "plain",
    },
    {
      term: "worn",
      value: container.equippable ? "Back" : "No",
      tone: "plain",
    },
  ];
}

function kindOf(item: ItemDef): string {
  if (item.type === "weapon") {
    const hands = item.twoHanded ? "Both hands" : "One hand";
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

const ARMOR_SLOT_LABELS: Record<ArmorSlot, string> = {
  head: "Head",
  armor: "Armour",
  footwear: "Footwear",
  charm: "Accessory",
};

function effectsTitleFor(item: ItemDef): string {
  if (item.type === "weapon") return HEADINGS.onHit;
  if (item.type === "stone") return HEADINGS.onCast;
  return HEADINGS.grants;
}

function demandsOf(item: ItemDef): Masteries | undefined {
  if (item.type === "weapon" || item.type === "stone") return item.requirements;
  return undefined;
}

function grantsOn(item: ItemDef): readonly (StatusGrant & { chance?: number })[] | undefined {
  if (item.type === "weapon" || item.type === "consumable") return item.statuses;
  if (item.type === "charm") return item.statuses;
  if (item.type === "stone" && item.effect.kind === "bolt") return item.effect.statuses;
  return undefined;
}

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
  return [];
}

function shieldStats(shield: ShieldItem): ItemCardStat[] {
  return [
    {
      term: "defence",
      value: `${shield.def}`,
      tone: "good",
    },
  ];
}

function stoneStats(stone: ArcaneStoneItem): ItemCardStat[] {
  const stats: ItemCardStat[] = [];

  if (stone.effect.kind === "bolt") {
    const { damage = 0, on, variance = 0 } = stone.effect;
    if (damage !== 0) {
      const band = damageBandOf(Math.abs(damage), variance);
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
    name: engravedName(def.name || def.id, instance?.engraved),
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

function clause(line: string): string {
  return line.replace(/[.\s]+$/, "");
}

function sentenceCase(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function speak(card: ItemCard): string {
  const lines: string[] = [card.count === null ? card.name : `${card.name}, ${card.count} of them`];
  if (card.kind) lines.push(card.kind);
  if (card.elements.length > 0) {
    lines.push(`Attuned to ${card.elements.join(" and ")}`);
  }
  if (card.inscription) lines.push(card.inscription);
  if (card.description) lines.push(card.description);
  for (const stat of card.stats) {
    const said = sentenceCase(termSpoken(stat.term));
    lines.push(
      stat.base
        ? `${said}: ${stat.value}, where somebody who has just earned it gets ${stat.base}`
        : `${said}: ${stat.value}`,
    );
  }
  for (const row of card.resists) {
    lines.push(
      `${MASTERY_LABELS[row.mastery]} blows lose ${row.total} rather than ${row.total - row.extra}`,
    );
  }
  for (const row of card.requirements) {
    lines.push(`Requires ${MASTERY_LABELS[row.mastery]} ${row.required}, you have ${row.have}`);
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
