import type { TradeSide } from "../lib/dialog";
import { resolveContainer } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { countOf, fuses, stow, withCount } from "../lib/piles";
import type { TileDef } from "../lib/types";
import {
  carriedInstances,
  handAccepts,
  handHasRoomFor,
  type Equipment,
  type Hand,
} from "./equipment";
import { capacityOf } from "./itemMoves";

/**
 * Spending what a body carries and handing it something back, as one move.
 *
 * A dialog's `trade` effect — fourteen shards for a potion, a bottle for two
 * shards. The near neighbour of `./transmute`, and the differences are the
 * design:
 *
 * - **Several things on each side, counted.** A recipe spends exactly one thing
 *   and it is a decision; a price is a number, and a number is what a pile
 *   already is. Fourteen shards may be one pile or three, and this peels
 *   across them.
 * - **Every square a body has, bags in hands included.** A recipe deliberately
 *   does not rummage in a pack you happen to be holding — offering what you
 *   carry is a different act. A merchant you have asked to be paid is exactly
 *   the case where you meant everything on you.
 * - **The plan is the kit.** There is no separate run: finding room for every
 *   last thing *is* the check, and having found it there is nothing left to
 *   decide, so what this returns is the kit as it will be. Ids are minted on
 *   the way and a refused plan simply drops them, which a random id makes free.
 *
 * What is shared is the rule that matters: **all or nothing, and nothing ever
 * reaches the floor.** A trade short on either side leaves the kit exactly as
 * it was, and the dialog says so.
 */

/** A square on a body a trade may take from or give to. */
type Place =
  | { holder: Hand }
  | { holder: "weapon" | "offhand" | "bag"; index: number };

const HAND_HOLDERS: readonly Hand[] = ["weapon", "offhand"];

/**
 * How many of a tile the body carries, piles summed, containers excluded.
 *
 * Containers excluded because a pack is not a thing a trade may take, so
 * counting one would let `carries` say yes to a trade that then refuses.
 */
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

/**
 * The kit after taking `take` and receiving `give`, or null when it cannot be
 * done — short on anything taken, or nowhere for anything given.
 *
 * Takes first, so the squares the payment vacated are squares the goods can
 * land in: a potion bought with the last of a pile of shards goes where the
 * shards were.
 */
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
  for (const side of give) {
    for (let i = 0; i < side.count; i++) {
      kit = giveUnit(tilesById, kit, { id: mintId(), tileId: side.tileId });
      if (!kit) return null;
    }
  }
  return kit;
}

/** Is there room on this body for so many of a tile? `room_for` reads this. */
export function hasRoomFor(
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
  side: TradeSide,
  mintId: () => string,
): boolean {
  return planTrade(tilesById, equipment, [], [side], mintId) !== null;
}

/**
 * Everywhere a thing may be taken from, in the order it is looked for.
 *
 * Hands first, on transmute's grounds — what you are holding out is what you
 * meant — then the worn bag, then bags in either hand. Within a container the
 * squares are walked last to first so that emptying one never shifts an index
 * still to be read.
 */
function sources(equipment: Equipment): Place[] {
  const places: Place[] = HAND_HOLDERS.map((holder) => ({ holder }));
  for (const holder of ["bag", "weapon", "offhand"] as const) {
    const contents = equipment[holder]?.contents ?? [];
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

/**
 * Everywhere one thing may land, best first: the worn bag, then a bag in
 * either hand, then the off hand, then the weapon hand — `pickUpDestination`'s
 * order, with the hand-held bags where a pickup would not look.
 */
function giveUnit(
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
  unit: ItemInstance,
): Equipment | null {
  const def = tilesById[unit.tileId];
  if (!def || resolveContainer(def)) return null;
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

/** The container in this slot with the unit poured or appended, or null. */
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

/** This hand holding the unit — poured onto its pile, or taken up empty. */
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
    return {
      ...equipment,
      [hand]: withCount(held, countOf(held) + countOf(unit)),
    };
  }
  if (!handAccepts(def)) return null;
  if (!handHasRoomFor(equipment, tilesById, hand, def)) return null;
  return { ...equipment, [hand]: unit };
}

function at(equipment: Equipment, place: Place): ItemInstance | null {
  if (!("index" in place)) return equipment[place.holder];
  return equipment[place.holder]?.contents?.[place.index] ?? null;
}

function put(
  equipment: Equipment,
  place: Place,
  instance: ItemInstance | null,
): Equipment {
  if (!("index" in place)) return { ...equipment, [place.holder]: instance };
  const holder = equipment[place.holder]!;
  const contents = holder.contents ?? [];
  const next = instance
    ? contents.map((held, i) => (i === place.index ? instance : held))
    : contents.filter((_, i) => i !== place.index);
  return { ...equipment, [place.holder]: { ...holder, contents: next } };
}

function isContainer(
  tilesById: Record<string, TileDef>,
  tileId: string,
): boolean {
  const def = tilesById[tileId];
  return def != null && resolveContainer(def) != null;
}
