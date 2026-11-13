import type { Depots } from "../app/game/depot";
import type { Equipment } from "../app/game/equipment";
import { carriedCount } from "../app/game/trade";
import { resolveBattler, type BattlerDef } from "../app/lib/battler";
import { resolveBrain } from "../app/lib/brain";
import { MAX_EXTRACT_CHANCE, resolveExtract } from "../app/lib/interactions";
import { MAX_KIT_CHANCE, type EquipSlot } from "../app/lib/kit";
import { countOf } from "../app/lib/piles";
import type { TileDef } from "../app/lib/types";
import { isCreature } from "./combat";
import type { Economy } from "./economy";
import type { Offer } from "./shops";

/** How a bot gets more of something: from what creatures drop, or from working a resource. */
export type Source = "hunt" | "gather";

/** One input of an objective's offer, and how much of it the bot has towards it. */
export type Need = {
  readonly tileId: string;
  readonly name: string;
  readonly want: number;
  readonly have: number;
  /** Where more comes from, or null once the bot has all it wants. */
  readonly via: Source | null;
  /** Seconds the bot expects to spend for each one more, by `via`; 0 once it has all it wants. */
  readonly seconds: number;
};

/**
 * An offer the bot works towards: what it buys, from whom, and its progress
 * on each input. `seconds` is how long the missing inputs are expected to
 * take, and `worth` the upgrade's gain for each of those seconds.
 */
export type Objective = {
  readonly key: string;
  readonly offer: Offer;
  readonly name: string;
  readonly needs: readonly Need[];
  readonly seconds: number;
  readonly worth: number;
};

export type Sources = {
  /** Whether the bot or the fleet knows where this offer's NPC is. */
  readonly sold: (offer: Offer) => boolean;
  /**
   * Seconds one kill of this creature is expected to take, the walk to one
   * included, or null when the bot would not or could not hunt it.
   */
  readonly killSeconds: (def: TileDef) => number | null;
  /** Seconds one pull of this resource is expected to take, the walk to one included, or null when the bot knows none it can reach. */
  readonly pullSeconds: (def: TileDef) => number | null;
};

/**
 * Every upgrade the bot could work towards, most gain a second first: one
 * whose seller somebody has found, and whose every missing input some
 * creature it would hunt drops, or some resource it can reach yields,
 * directly or as something an NPC pays money for. What its depots hold
 * counts as held.
 */
export function objectivesFor(
  economy: Economy,
  equipment: Equipment,
  body: BattlerDef,
  depots: Depots,
  sources: Sources,
): Objective[] {
  const { tilesById } = economy;
  const out: Objective[] = [];
  for (const { offer, gain } of economy.upgrades(equipment, body)) {
    if (!sources.sold(offer)) continue;
    const needs = offer.take.map((side): Need => {
      const have =
        carriedCount(tilesById, equipment, side.tileId) + stashedCount(depots, side.tileId);
      const source = have >= side.count ? null : sourceOf(economy, side.tileId, sources);
      return {
        tileId: side.tileId,
        name: tilesById[side.tileId]?.name ?? side.tileId,
        want: side.count,
        have,
        via: source?.via ?? null,
        seconds: source?.seconds ?? 0,
      };
    });
    if (needs.some((need) => need.have < need.want && need.via === null)) continue;
    const item = offer.give[0]?.tileId ?? "";
    const seconds = needs.reduce(
      (sum, need) => sum + Math.max(0, need.want - need.have) * need.seconds,
      0,
    );
    out.push({
      key: offerKey(offer),
      offer,
      name: tilesById[item]?.name ?? item,
      needs,
      seconds,
      worth: gain / Math.max(1, seconds),
    });
  }
  return out.sort((a, b) => b.worth - a.worth);
}

export function offerKey(offer: Offer): string {
  return `${offer.npc}:${offer.path.join(".")}`;
}

/** The input furthest from done, which is the one the bot works on next, or null when it has all of them. */
export function nextNeed(objective: Objective): Need | null {
  let next: Need | null = null;
  for (const need of objective.needs) {
    if (need.have >= need.want) continue;
    if (!next || need.have / need.want < next.have / next.want) next = need;
  }
  return next;
}

/** The share of every input the bot has, from 0 to 1. */
export function progressOf(objective: Objective): number {
  let have = 0;
  let want = 0;
  for (const need of objective.needs) {
    have += Math.min(need.have, need.want);
    want += need.want;
  }
  return want === 0 ? 1 : have / want;
}

export function describeObjective(objective: Objective): string {
  const needs = objective.needs.map(
    (need) => `${Math.min(need.have, need.want)} of ${need.want} ${need.name}`,
  );
  return `${objective.name} from the ${objective.offer.npcName}: ${needs.join(", ")}`;
}

/**
 * Where more of `tileId` comes quickest: the creature or resource with the
 * fewest seconds for each one expected, a kill's or a pull's seconds over
 * what it gives, counting what it gives at what an NPC pays when `tileId`
 * is the currency. Null when nothing the bot can reach gives any.
 */
export function sourceOf(
  economy: Economy,
  tileId: string,
  sources: Sources,
): { via: Source; seconds: number } | null {
  let best: { via: Source; seconds: number } | null = null;
  const consider = (via: Source, each: number | null, gives: number) => {
    if (each === null || gives <= 0) return;
    const seconds = each / gives;
    if (!best || seconds < best.seconds) best = { via, seconds };
  };
  for (const def of Object.values(economy.tilesById)) {
    if (isCreature(def)) {
      const gives = dropWorth(economy, def, tileId);
      if (gives > 0) consider("hunt", sources.killSeconds(def), gives);
    }
    const gives = pullWorth(economy, def, tileId);
    if (gives > 0) consider("gather", sources.pullSeconds(def), gives);
  }
  return best;
}

/** Whether a creature runs from what it is spooked by, as a deer does. */
export function flees(def: TileDef): boolean {
  const brain = resolveBrain(def);
  if (!brain) return false;
  return Object.values(brain.states).some((state) =>
    state.do.some((step) => step.action === "step_away_from"),
  );
}

/** What one kill of a creature is expected to give towards `tileId`. */
export function dropWorth(economy: Economy, def: TileDef, tileId: string): number {
  return yieldWorth(economy, kitYield(def), tileId);
}

/** What one pull of a resource is expected to give towards `tileId`. */
export function pullWorth(economy: Economy, def: TileDef, tileId: string): number {
  return yieldWorth(economy, pullYield(def), tileId);
}

/** What one of `yielded` is worth towards `tileId`: one if it is that, else what an NPC pays when `tileId` is the currency. */
export function worthTowards(economy: Economy, yielded: string, tileId: string): number {
  if (yielded === tileId) return 1;
  return tileId === economy.currency ? economy.salePrice(yielded) : 0;
}

function yieldWorth(economy: Economy, expected: ReadonlyMap<string, number>, tileId: string) {
  let worth = 0;
  for (const [yielded, count] of expected) worth += count * worthTowards(economy, yielded, tileId);
  return worth;
}

/**
 * How many of each thing a creature is expected to drop, from its authored
 * kit. An entry fills its square only if no earlier entry for that square
 * did, and a bag's contents come only with the bag.
 */
export function kitYield(def: TileDef): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  const empty = new Map<EquipSlot, number>();
  for (const entry of resolveBattler(def)?.kit ?? []) {
    const free = empty.get(entry.slot) ?? 1;
    const won = (entry.chance / MAX_KIT_CHANCE) * free;
    empty.set(entry.slot, free - won);
    add(out, entry.tileId, won);
    for (const content of entry.contents ?? []) {
      add(out, content.tileId, (won * content.chance) / MAX_KIT_CHANCE);
    }
  }
  return out;
}

/** How many of each thing one pull of a resource is expected to give; each slot is drawn on its own. */
export function pullYield(def: TileDef): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const slot of resolveExtract(def)?.slots ?? []) {
    add(out, slot.tileId, slot.chance / MAX_EXTRACT_CHANCE);
  }
  return out;
}

function add(out: Map<string, number>, tileId: string, count: number) {
  if (count > 0) out.set(tileId, (out.get(tileId) ?? 0) + count);
}

function stashedCount(depots: Depots, tileId: string): number {
  let total = 0;
  for (const stash of Object.values(depots)) {
    for (const instance of stash) if (instance.tileId === tileId) total += countOf(instance);
  }
  return total;
}
