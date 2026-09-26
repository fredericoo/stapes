import { resolveBattler } from "../lib/battler";
import { resolveContainer } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { mintItemId } from "../lib/itemInstance";
import type { Kit, KitContent } from "../lib/kit";
import { MAX_KIT_CHANCE } from "../lib/kit";
import type { TileDef } from "../lib/types";
import { emptyEquipment, type Equipment, handHasRoomFor } from "./equipment";
import { slotAccepts } from "./itemMoves";

export function equipmentForBody(
  tileId: string,
  tilesById: Record<string, TileDef>,
  random: () => number,
): Equipment {
  const def = tilesById[tileId];
  const battler = def ? resolveBattler(def) : null;
  if (!battler) return emptyEquipment();
  return equipmentFromKit(battler.kit ?? [], tilesById, random);
}

export function equipmentFromKit(
  kit: Kit,
  tilesById: Record<string, TileDef>,
  random: () => number,
): Equipment {
  const equipment = emptyEquipment();

  for (const entry of kit) {
    const won = draw(entry, random);
    const contents = (entry.contents ?? []).filter((content) => draw(content, random));

    if (!won) continue;
    if (equipment[entry.slot]) continue;
    const instance = instantiate(entry.tileId, tilesById);
    if (!instance || !slotAccepts(entry.slot, instance, tilesById)) continue;
    const def = tilesById[entry.tileId];
    if (
      def &&
      (entry.slot === "weapon" || entry.slot === "offhand") &&
      !handHasRoomFor(equipment, tilesById, entry.slot, def)
    ) {
      continue;
    }

    equipment[entry.slot] = fill(instance, contents, tilesById);
  }

  return equipment;
}

function draw(entry: KitContent, random: () => number): boolean {
  return random() * MAX_KIT_CHANCE < entry.chance;
}

function instantiate(tileId: string, tilesById: Record<string, TileDef>): ItemInstance | null {
  if (!tilesById[tileId]) return null;
  return { id: mintItemId(), tileId };
}

function fill(
  instance: ItemInstance,
  contents: KitContent[],
  tilesById: Record<string, TileDef>,
): ItemInstance {
  const size = resolveContainer(tilesById[instance.tileId]!)?.size ?? 0;
  if (size === 0) return instance;

  const inside: ItemInstance[] = [];
  for (const content of contents) {
    if (inside.length >= size) break;
    const held = instantiate(content.tileId, tilesById);
    if (!held || !slotAccepts("contents", held, tilesById)) continue;
    inside.push(held);
  }
  return { ...instance, contents: inside };
}
