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

type Place = { holder: Hand } | { holder: "weapon" | "offhand" | "bag"; index: number };

const HAND_HOLDERS: readonly Hand[] = ["weapon", "offhand"];

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

export function hasRoomFor(
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
  side: TradeSide,
  mintId: () => string,
): boolean {
  return planTrade(tilesById, equipment, [], [side], mintId) !== null;
}

function sources(equipment: Equipment): Place[] {
  const places: Place[] = HAND_HOLDERS.map((holder) => ({ holder }));
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
