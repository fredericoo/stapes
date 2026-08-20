import type { ActorSnapshot } from "../game/GameSession";
import type { SpriteState } from "../lib/types";
import { tileInstanceKey } from "./WorldRenderer";

/**
 * Which placements are in a non-idle {@link SpriteState}, and which one.
 *
 * Pure, and out here rather than inside the render loop, for the reason
 * `readOpenedContainer` is: it is a rule about the world — *is this thing moving*
 * — rather than about drawing. The loop's only job is to ask it once a frame and
 * hand the answer to the renderer.
 *
 * Sparse, holding only the actors who are actually doing something. Almost every
 * frame in almost every map returns nothing, and an absent key reads as `idle`
 * everywhere downstream — so the common case costs one allocation that never
 * happens rather than a walk of the board.
 *
 * `moving` is the only state there is, so this is total: everything absent from
 * the result is idle. When another state arrives it arrives here too, in the same
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
 * Whether this body is walking right now.
 *
 * A fall does not count, and that is the point: `moving` art is a walk cycle,
 * and a creature pumping its legs on the way down a cliff reads as comic rather
 * than as falling. Idle is the honest thing to draw with the art that exists —
 * a body holding its shape while the ground comes up at it. A real mid-air pose
 * wants a `falling` state of its own, authored alongside its driver the way
 * {@link SpriteState} asks.
 *
 * A slide does not count either, and that is not an omission. `slide` on an
 * actor is the motion of an *object they shoved*, not of the actor: reading it
 * here would put a walk cycle on somebody standing perfectly still with their
 * hands out. The crate's own `moving` sprite is a separate question, and it
 * needs the state keyed to the crate's cell rather than to the pusher's.
 */
function isMovingActor(actor: ActorSnapshot): boolean {
  return actor.walk != null;
}
