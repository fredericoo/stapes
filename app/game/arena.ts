import { type BattlerDef, type FightingStats, resolveBattler } from "../lib/battler";
import { EQUIP_SLOTS, type EquipSlot } from "../lib/kit";
import { type Masteries, MASTERIES } from "../lib/mastery";
import type { TileDef } from "../lib/types";
import {
  effectiveBattler,
  emptyEquipment,
  type Equipment,
  type Hand,
  HANDS,
  weaponSwungBy,
} from "./equipment";
import { slotTakes } from "./itemMoves";

export type ArenaFighter = {
  tileId: string;
  masteries: Masteries;
  equipment: Record<EquipSlot, string | null>;
};

function emptySlots(): Record<EquipSlot, string | null> {
  return Object.fromEntries(EQUIP_SLOTS.map((slot) => [slot, null])) as Record<
    EquipSlot,
    string | null
  >;
}

export function fighterForTile(tileId: string, tilesById: Record<string, TileDef>): ArenaFighter {
  const def = tilesById[tileId];
  const battler = def ? resolveBattler(def) : null;
  const masteries: Masteries = {};
  for (const mastery of MASTERIES) {
    masteries[mastery] = battler?.masteries[mastery] ?? 0;
  }
  return { tileId, masteries, equipment: emptySlots() };
}

export function bodyOf(
  fighter: ArenaFighter,
  tilesById: Record<string, TileDef>,
): BattlerDef | null {
  const def = tilesById[fighter.tileId];
  const battler = def ? resolveBattler(def) : null;
  if (!battler) return null;
  return { ...battler, masteries: fighter.masteries };
}

export function equipmentOf(fighter: ArenaFighter, tilesById: Record<string, TileDef>): Equipment {
  const equipment = emptyEquipment();
  for (const slot of EQUIP_SLOTS) {
    const tileId = fighter.equipment[slot];
    if (!tileId) continue;
    const def = tilesById[tileId];
    if (!def || !slotTakes(slot, def)) continue;
    equipment[slot] = { id: `arena:${slot}`, tileId };
  }
  return equipment;
}

export function statsOf(
  fighter: ArenaFighter,
  tilesById: Record<string, TileDef>,
): FightingStats | null {
  return swingsOf(fighter, tilesById)[0] ?? null;
}

export function swingsOf(
  fighter: ArenaFighter,
  tilesById: Record<string, TileDef>,
): FightingStats[] {
  const body = bodyOf(fighter, tilesById);
  if (!body) return [];
  const equipment = equipmentOf(fighter, tilesById);
  const hands = HANDS.filter((hand) => weaponSwungBy(equipment, tilesById, hand));
  const rotation: (Hand | null)[] = hands.length > 0 ? hands : [null];
  return rotation.map((hand) => effectiveBattler(body, equipment, tilesById, hand));
}

export function battlerTiles(tiles: TileDef[]): TileDef[] {
  return tiles.filter((tile) => resolveBattler(tile) !== null);
}

export function tilesForSlot(slot: EquipSlot, tiles: TileDef[]): TileDef[] {
  return tiles.filter((tile) => slotTakes(slot, tile));
}
