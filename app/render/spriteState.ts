import type { ActorSnapshot } from "../game/GameSession";
import type { SpriteState } from "../lib/types";
import { tileInstanceKey } from "./WorldRenderer";

/**
 * Which placements are in a non-idle {@link SpriteState}, and which one.
 *
 * Sparse: only actors doing something are present, and an absent key reads as
 * `idle` downstream, so the common all-idle frame allocates nothing.
 *
 * `moving` is the only state there is. Another state arrives here in the same
 * change as whatever drives it — see {@link SpriteState}.
 */
export function spriteStatesFor(
  actors: readonly ActorSnapshot[],
): Map<string, SpriteState> | undefined {
  let states: Map<string, SpriteState> | undefined;
  for (const actor of actors) {
    if (!isMovingActor(actor)) continue;
    const { x, y, z, stackIndex } = actor;
    states ??= new Map();
    states.set(tileInstanceKey({ x, y, z, stackIndex }), "moving");
  }
  return states;
}

/**
 * A fall does not count: `moving` art is a walk cycle, and a creature pumping
 * its legs on the way down reads as comic. A mid-air pose wants a `falling`
 * state of its own, authored with its driver as {@link SpriteState} asks.
 *
 * A slide does not count either: `slide` on an actor is the motion of an
 * object they shoved, not of the actor. The crate's own `moving` sprite is a
 * separate question, keyed to the crate's cell rather than the pusher's.
 */
function isMovingActor(actor: ActorSnapshot): boolean {
  return actor.walk != null;
}
