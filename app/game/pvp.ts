/**
 * Whether two people may hurt each other.
 *
 * **A switch each player holds, and both have to have it on.** The world is a
 * place you can walk around in with strangers, and most of what anybody is doing
 * in it — mining, building, feeding a deer — is not a fight. Somebody who has
 * not opted in cannot be hurt by another player, and cannot hurt one either: the
 * flag is not a shield you raise while you keep swinging.
 *
 * **Creatures are not in it at all.** A wolf is not somebody's decision, so
 * nothing here applies between a player and a creature or between two creatures.
 * That is what keeps the rule from quietly turning the game off: everything a
 * body does to a rat is unchanged, and so is everything a rat does back.
 *
 * ## Where it is read
 *
 * One function, at the four places harm can pass from one body to another:
 *
 * - a swing (`GameSession.tryAttack`),
 * - a bolt that takes health — refused before the cast starts, so the button
 *   says so rather than the cooldown being spent on nothing (`./casting`'s
 *   `castability`),
 * - a bad status from anybody (`GameSession.grantStatus`), which is the one
 *   that catches a curse, a weapon's poison and a bolt's,
 * - and a bad status from a tile somebody conjured, which is skipped in the
 *   stack rather than merely refused, so what is under it still gets its turn
 *   (`GameSession.grantStandingStatus` and `./conjured`).
 *
 * The interaction list reads it too, and reads it for the other reason: a fight
 * row on somebody you cannot fight is a button that does nothing, so the row is
 * simply not offered. @see `./interactionOptions`'s `battlerOptions`
 *
 * What is deliberately *not* in that list is targeting. Pointing at somebody is
 * how you read them — their name, their health, their ⭐ — and a player you
 * cannot fight is still a player you may want to look at. The watch row is
 * offered for everybody, and with no fight row beside it, it is the whole of
 * the control rather than half of one.
 */

import { PLAYER_TILE_ID } from "./constants";

/**
 * One body as the rule sees it, read off a snapshot.
 *
 * **Residency is read off the tile**, which is the same test identity is read
 * off everywhere a client works: a player wears the player tile and a creature
 * wears its own — see `./displayName`'s {@link bodyNameFor}. The simulation
 * knows residency as a fact recorded when the actor was made and builds its own
 * {@link Combatant} from that; the two agree because that is what the tile
 * means.
 *
 * Here rather than in each of the three callers, because a caller that built it
 * by hand is the one that would forget the residency and have a player refuse
 * to swing at a deer.
 */
export function combatantOf(body: { id: string; tileId: string; pvp: boolean }): Combatant {
  return {
    id: body.id,
    resident: body.tileId !== PLAYER_TILE_ID,
    pvp: body.pvp,
  };
}

/**
 * Just enough of a body to answer the question.
 *
 * Three fields rather than an `ActorRuntime`, because both ends ask it: the
 * simulation about two runtimes, and the browser about two things it has drawn.
 * @see `../net/RemoteSession`
 */
export type Combatant = {
  id: string;
  /** Whether this body is the world's rather than a player's. */
  resident: boolean;
  /** Whether this player has opted into fighting other players. */
  pvp: boolean;
};

/**
 * Whether harm from one body reaches another.
 *
 * True for everything that is not two players, which is the property to protect
 * here: a world with nobody's switch on plays exactly as it did before this
 * existed.
 *
 * **A body may always harm itself.** A stone authored to hurt its caster is a
 * curse somebody chose to press, and a flag about other people has no business
 * refusing it.
 */
export function mayHarm(from: Combatant, to: Combatant): boolean {
  if (from.id === to.id) return true;
  if (from.resident || to.resident) return true;
  return from.pvp && to.pvp;
}

/**
 * What marks the name of somebody who is fighting.
 *
 * **Four ASCII characters rather than crossed swords**, for the reason
 * `../lib/mastery`'s {@link RATING_GLYPH} is an asterisk rather than a star: the
 * world's text is typeset in NF Pixels, which is subset to printable ASCII, so a
 * ⚔ falls back to a colour emoji at the wrong metrics in a tag drawn at two CSS
 * pixels per font pixel. A word says what it means with no legend to learn,
 * which a single punctuation mark in that alphabet would not.
 */
export const PVP_MARK = "[PvP]";
