import { resolveBattler } from "../lib/battler";
import type { TileDef } from "../lib/types";
import { PLAYER_TILE_ID } from "./constants";

/**
 * A player's `pvp` is their own switch. A resident's is its battler's `pvp`
 * flag, fixed by the author: a townsperson that only somebody with PvP on may
 * harm.
 */
export function combatantOf(
  body: { id: string; tileId: string; pvp: boolean },
  tilesById: Record<string, TileDef>,
): Combatant {
  const resident = body.tileId !== PLAYER_TILE_ID;
  const def = tilesById[body.tileId];
  return {
    id: body.id,
    resident,
    pvp: resident ? (def ? resolveBattler(def)?.pvp === true : false) : body.pvp,
  };
}

export type Combatant = {
  id: string;
  resident: boolean;
  pvp: boolean;
};

/**
 * A resident's flag binds only the players who swing at it. Residents harm
 * anybody, so a wolf still bites a townsperson and a guard still answers a
 * player who struck first.
 */
export function mayHarm(from: Combatant, to: Combatant): boolean {
  if (from.id === to.id) return true;
  if (from.resident) return true;
  if (to.resident) return !to.pvp || from.pvp;
  return from.pvp && to.pvp;
}

export const PVP_MARK = "[PvP]";
