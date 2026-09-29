import { PLAYER_TILE_ID } from "./constants";

export function combatantOf(body: { id: string; tileId: string; pvp: boolean }): Combatant {
  return {
    id: body.id,
    resident: body.tileId !== PLAYER_TILE_ID,
    pvp: body.pvp,
  };
}

export type Combatant = {
  id: string;
  resident: boolean;
  pvp: boolean;
};

export function mayHarm(from: Combatant, to: Combatant): boolean {
  if (from.id === to.id) return true;
  if (from.resident || to.resident) return true;
  return from.pvp && to.pvp;
}

export const PVP_MARK = "[PvP]";
