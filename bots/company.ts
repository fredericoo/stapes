import type { ActorSnapshot } from "../app/game/GameSession";
import { PLAYER_TILE_ID } from "../app/game/constants";
import type { NavGoal } from "../app/game/navigation";
import type { Coord } from "../app/lib/types";
import { steps } from "./combat";

/** A player this close to the bot, or to a creature it fights, is counted as fighting beside it. */
export const ALLY_CELLS = 4;

/** A bot hunting with no prey in sight walks over to a leader no further than this. */
export const COMPANY_SEEK_CELLS = 30;

/** Within this many cells of its leader, a bot has caught up and waits. */
export const COMPANY_CELLS = 3;

type Body = Pick<ActorSnapshot, "id" | "tileId" | "x" | "y" | "z" | "hp">;

function isOtherPlayer(self: Body, actor: Body): boolean {
  if (actor.id === self.id || actor.tileId !== PLAYER_TILE_ID) return false;
  return actor.hp === null || actor.hp > 0;
}

/** Players other than the bot within `ALLY_CELLS` of it or of any of `foes`. */
export function alliesBeside(self: Body, actors: readonly Body[], foes: readonly Coord[]): number {
  const around = [self, ...foes];
  return actors.filter(
    (a) => isOtherPlayer(self, a) && around.some((at) => steps(a, at) <= ALLY_CELLS),
  ).length;
}

/**
 * The player this bot tags along with: the nearest on its level within
 * `COMPANY_SEEK_CELLS` whose id sorts before its own. Following only towards
 * lower ids means a group always has one player who follows nobody and leads;
 * two bots that each walked to the other would meet, part and meet again.
 */
export function leaderOf<T extends Body>(self: Body, actors: readonly T[]): T | null {
  const leaders = actors.filter(
    (a) =>
      isOtherPlayer(self, a) &&
      a.id < self.id &&
      a.z === self.z &&
      steps(self, a) <= COMPANY_SEEK_CELLS,
  );
  leaders.sort((a, b) => steps(self, a) - steps(self, b));
  return leaders[0] ?? null;
}

/** Any cell on the leader's level within `COMPANY_CELLS` of it. */
export function companyGoal(leader: Coord): NavGoal {
  const apart = (cell: Coord) => Math.abs(cell.x - leader.x) + Math.abs(cell.y - leader.y);
  return {
    reached: (cell) => cell.z === leader.z && apart(cell) <= COMPANY_CELLS,
    estimate: (cell) => Math.max(0, apart(cell) - COMPANY_CELLS),
  };
}
