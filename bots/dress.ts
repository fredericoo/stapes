import { carriedLightTileIds, type Equipment } from "../app/game/equipment";
import { equipDestination, type BodySlotRef, type SlotRef } from "../app/game/itemMoves";
import { resolveItem } from "../app/lib/item";
import type { ItemInstance } from "../app/lib/itemInstance";
import { resolveLight } from "../app/lib/tileResolve";
import type { TileDef } from "../app/lib/types";

export type Dressing = { readonly from: SlotRef; readonly to: BodySlotRef };

/**
 * The next thing a bot should put on out of its bag, or null. A light comes
 * first, whenever nothing worn gives one, so a bot carries light wherever it
 * goes; then a weapon, while both hands are empty, preferring one that
 * strikes from beside since that is how the bot fights. Only an empty square
 * is filled: the bot never takes something off to make room.
 */
export function nextDressing(
  equipment: Equipment,
  tilesById: Record<string, TileDef>,
): Dressing | null {
  const bag = equipment.bag?.contents ?? [];
  const into = (index: number): Dressing | null => {
    const to = equipDestination(equipment, tilesById, bag[index]!);
    return to && equipment[to.kind] === null ? { from: { kind: "contents", index }, to } : null;
  };

  if (carriedLightTileIds(equipment, tilesById).length === 0) {
    for (let index = 0; index < bag.length; index++) {
      if (!givesLight(bag[index]!, tilesById)) continue;
      const dressing = into(index);
      if (dressing) return dressing;
    }
  }

  if (!equipment.weapon && !equipment.offhand) {
    const weapons = bag
      .map((instance, index) => ({ index, item: itemOf(instance, tilesById) }))
      .filter(({ item }) => item?.type === "weapon")
      .sort((a, b) => ranged(a.item) - ranged(b.item));
    for (const { index } of weapons) {
      const dressing = into(index);
      if (dressing) return dressing;
    }
  }
  return null;
}

function givesLight(instance: ItemInstance, tilesById: Record<string, TileDef>): boolean {
  const def = tilesById[instance.tileId];
  return def !== undefined && resolveLight(def, { direction: instance.direction }) !== undefined;
}

function itemOf(instance: ItemInstance, tilesById: Record<string, TileDef>) {
  const def = tilesById[instance.tileId];
  return def ? resolveItem(def) : null;
}

function ranged(item: ReturnType<typeof itemOf>): number {
  return item?.type === "weapon" && item.projectile ? 1 : 0;
}
