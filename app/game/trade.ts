import { denominations, splitCash } from "../lib/cash";
import type { DialogTrade, TradeSide, TradeTerms } from "../lib/dialog";
import { resolveContainer, resolveWorth } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { countOf, fuses, stow, withCount } from "../lib/piles";
import type { TileDef } from "../lib/types";
import {
  carriedInstances,
  EQUIPMENT_SLOTS,
  handAccepts,
  handHasRoomFor,
  type Equipment,
  type Hand,
} from "./equipment";
import { capacityOf } from "./itemMoves";

type Place = { holder: keyof Equipment } | { holder: "weapon" | "offhand" | "bag"; index: number };

const HAND_HOLDERS: readonly Hand[] = ["weapon", "offhand"];

const WORN_HOLDERS = EQUIPMENT_SLOTS.filter((slot) => slot !== "weapon" && slot !== "offhand");

export function carriedCount(
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
  tileId: string,
): number {
  let total = 0;
  for (const instance of carriedInstances(equipment)) {
    if (instance.tileId !== tileId) continue;
    if (isContainer(tilesById, instance.tileId)) continue;
    total += countOf(instance);
  }
  return total;
}

/** The worth of everything carried that has one. */
export function carriedCash(tilesById: Record<string, TileDef>, equipment: Equipment): number {
  let total = 0;
  for (const instance of carriedInstances(equipment)) {
    const def = tilesById[instance.tileId];
    if (!def || isContainer(tilesById, instance.tileId)) continue;
    total += countOf(instance) * resolveWorth(def);
  }
  return total;
}

export function planTrade(
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
  take: readonly TradeSide[],
  give: readonly TradeSide[],
  mintId: () => string,
): Equipment | null {
  let kit: Equipment | null = equipment;
  for (const side of take) {
    kit = takeUnits(tilesById, kit, side);
    if (!kit) return null;
  }
  return giveSides(tilesById, kit, give, mintId);
}

/** `planTrade` with the cash a trade takes paid first and the cash it gives handed over last. */
export function planDeal(
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
  terms: TradeTerms,
  mintId: () => string,
): Equipment | null {
  const paid = terms.takeCash ? payCash(tilesById, equipment, terms.takeCash, mintId) : equipment;
  if (!paid) return null;
  const traded = planTrade(tilesById, paid, terms.take, terms.give, mintId);
  if (!traded || !terms.giveCash) return traded;
  return giveSides(tilesById, traded, splitCash(tilesById, terms.giveCash), mintId);
}

export function scaleTerms(terms: TradeTerms, amount: number): TradeTerms {
  const times = (side: TradeSide) => ({ tileId: side.tileId, count: side.count * amount });
  return {
    take: terms.take.map(times),
    give: terms.give.map(times),
    ...(terms.takeCash ? { takeCash: terms.takeCash * amount } : {}),
    ...(terms.giveCash ? { giveCash: terms.giveCash * amount } : {}),
  };
}

function giveSides(
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
  give: readonly TradeSide[],
  mintId: () => string,
): Equipment | null {
  let kit: Equipment | null = equipment;
  for (const side of give) {
    for (let i = 0; i < side.count; i++) {
      kit = giveUnit(tilesById, kit, { id: mintId(), tileId: side.tileId });
      if (!kit) return null;
    }
  }
  return kit;
}

/**
 * Pays with the largest coins that do not overshoot, then, if that falls
 * short, breaks the smallest coin worth more than what is still owed and
 * gives the difference back. Whatever is left unpaid after the first pass is
 * less than every coin still carried, so one coin always settles it.
 */
function payCash(
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
  amount: number,
  mintId: () => string,
): Equipment | null {
  let kit = equipment;
  let owed = amount;
  for (const { tileId, worth } of denominations(tilesById)) {
    const units = Math.min(Math.floor(owed / worth), carriedCount(tilesById, kit, tileId));
    if (units === 0) continue;
    const paid = takeUnits(tilesById, kit, { tileId, count: units });
    if (!paid) return null;
    kit = paid;
    owed -= units * worth;
  }
  if (owed === 0) return kit;
  const carried = kit;
  const broken = [...denominations(tilesById)]
    .reverse()
    .find(({ tileId, worth }) => worth > owed && carriedCount(tilesById, carried, tileId) > 0);
  if (!broken) return null;
  const paid = takeUnits(tilesById, kit, { tileId: broken.tileId, count: 1 });
  if (!paid) return null;
  return giveSides(tilesById, paid, splitCash(tilesById, broken.worth - owed), mintId);
}

/**
 * The price caps the scan, then each amount below it is planned in full, since
 * room for what is given is not monotone: paying can empty a square.
 */
export function largestTradeAmount(
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
  trade: TradeTerms & Pick<DialogTrade, "min" | "max">,
  mintId: () => string,
): number | null {
  let ceiling = trade.max;
  for (const side of trade.take) {
    const affordable = Math.floor(carriedCount(tilesById, equipment, side.tileId) / side.count);
    ceiling = Math.min(ceiling, affordable);
  }
  if (trade.takeCash) {
    ceiling = Math.min(ceiling, Math.floor(carriedCash(tilesById, equipment) / trade.takeCash));
  }
  for (let amount = ceiling; amount >= trade.min; amount--) {
    if (planDeal(tilesById, equipment, scaleTerms(trade, amount), mintId)) return amount;
  }
  return null;
}

export function hasRoomFor(
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
  side: TradeSide,
  mintId: () => string,
): boolean {
  return planTrade(tilesById, equipment, [], [side], mintId) !== null;
}

function sources(equipment: Equipment): Place[] {
  /**
   * Every square `carriedCount` counts, or a price it reports as met could
   * still fail to be paid — a glowing pile worn in the charm slot is one.
   */
  const places: Place[] = [...HAND_HOLDERS, ...WORN_HOLDERS].map((holder) => ({ holder }));
  for (const holder of ["bag", "weapon", "offhand"] as const) {
    const contents = equipment[holder]?.contents ?? [];
    /**
     * Last to first, so emptying one square as it is taken from never shifts
     * the index of a square still to be read.
     */
    for (let index = contents.length - 1; index >= 0; index--) {
      places.push({ holder, index });
    }
  }
  return places;
}

function takeUnits(
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
  side: TradeSide,
): Equipment | null {
  if (isContainer(tilesById, side.tileId)) return null;
  let kit = equipment;
  let remaining = side.count;
  for (const place of sources(equipment)) {
    if (remaining === 0) break;
    const held = at(kit, place);
    if (!held || held.tileId !== side.tileId) continue;
    const taken = Math.min(countOf(held), remaining);
    const left = countOf(held) - taken;
    kit = put(kit, place, left === 0 ? null : withCount(held, left));
    remaining -= taken;
  }
  return remaining === 0 ? kit : null;
}

function giveUnit(
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
  unit: ItemInstance,
): Equipment | null {
  const def = tilesById[unit.tileId];
  if (!def) return null;
  if (resolveContainer(def)) return carryContainer(tilesById, equipment, unit, def);
  for (const holder of ["bag", "weapon", "offhand"] as const) {
    const stowed = stowIn(tilesById, equipment, holder, unit);
    if (stowed) return stowed;
  }
  for (const hand of ["offhand", "weapon"] as const) {
    const held = holdIn(tilesById, equipment, hand, unit, def);
    if (held) return held;
  }
  return null;
}

/**
 * Nothing nests, so a given container goes on the back when the bag slot is
 * free and into an empty hand otherwise — never into another container.
 */
function carryContainer(
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
  unit: ItemInstance,
  def: TileDef,
): Equipment | null {
  if (!equipment.bag) return { ...equipment, bag: unit };
  for (const hand of ["offhand", "weapon"] as const) {
    if (equipment[hand]) continue;
    const held = holdIn(tilesById, equipment, hand, unit, def);
    if (held) return held;
  }
  return null;
}

function stowIn(
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
  holder: "bag" | Hand,
  unit: ItemInstance,
): Equipment | null {
  const container = equipment[holder];
  if (!container || !isContainer(tilesById, container.tileId)) return null;
  const contents = stow(
    container.contents ?? [],
    unit,
    capacityOf(container, tilesById),
    tilesById,
  );
  if (!contents) return null;
  return { ...equipment, [holder]: { ...container, contents } };
}

function holdIn(
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
  hand: Hand,
  unit: ItemInstance,
  def: TileDef,
): Equipment | null {
  const held = equipment[hand];
  if (held) {
    if (!fuses(held, unit, tilesById)) return null;
    return { ...equipment, [hand]: withCount(held, countOf(held) + countOf(unit)) };
  }
  if (!handAccepts(def)) return null;
  if (!handHasRoomFor(equipment, tilesById, hand, def)) return null;
  return { ...equipment, [hand]: unit };
}

function at(equipment: Equipment, place: Place): ItemInstance | null {
  if (!("index" in place)) return equipment[place.holder];
  return equipment[place.holder]?.contents?.[place.index] ?? null;
}

function put(equipment: Equipment, place: Place, instance: ItemInstance | null): Equipment {
  if (!("index" in place)) return { ...equipment, [place.holder]: instance };
  const holder = equipment[place.holder]!;
  const contents = holder.contents ?? [];
  const next = instance
    ? contents.map((held, i) => (i === place.index ? instance : held))
    : contents.filter((_, i) => i !== place.index);
  return { ...equipment, [place.holder]: { ...holder, contents: next } };
}

function isContainer(tilesById: Record<string, TileDef>, tileId: string): boolean {
  const def = tilesById[tileId];
  return def != null && resolveContainer(def) != null;
}
