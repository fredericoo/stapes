import type { ActorSnapshot } from "../game/GameSession";
import type { SpriteState } from "../lib/types";
import { tileInstanceKey } from "./WorldRenderer";

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

function isMovingActor(actor: ActorSnapshot): boolean {
  return actor.walk != null;
}
