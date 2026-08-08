import type { GameServer } from "../../workers/GameServer";

/**
 * The one world.
 *
 * A fixed name because there is a single shared world: `getByName` routes every
 * request for it to the same instance, which is the whole point — the map, the
 * actors on it and the sockets watching them have to live together to be
 * consistent. Sharding would mean more than one world, which is a product
 * decision rather than a scaling knob.
 */
const WORLD_NAME = "world";

export function gameServer(env: Env): DurableObjectStub<GameServer> {
  return env.GAME.getByName(WORLD_NAME);
}
