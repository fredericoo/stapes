import type { ActorSnapshot } from "../game/GameSession";
import { surfaceWades, wadesAt } from "../game/movement";
import { getStack, stackHeight } from "../lib/mapData";
import { HEIGHT_PER_LEVEL, type MapFile, type TileDef } from "../lib/types";
import { tileInstanceKey } from "./WorldRenderer";

type WadingActor = Pick<
  ActorSnapshot,
  "x" | "y" | "z" | "stackIndex" | "walk" | "walkProgress" | "fall"
>;

/**
 * How deep this body is standing in a `wade` tile right now: 0 is dry, 1 is
 * all the way in. @see TileDef.wade
 *
 * A step between dry ground and water goes from one to the other over the
 * step, so a body wading out rises as it walks rather than on the frame it
 * arrives. The far end is read off the surface of the cell it is walking into,
 * which is where the renderer draws it landing.
 *
 * A falling body is dry until it lands. Whatever it lands in decides the rest.
 */
export function wadeDepth(
  map: MapFile,
  actor: WadingActor,
  tilesById: Record<string, TileDef>,
): number {
  if (actor.fall) return 0;
  const here = wadesAt(map, actor, tilesById) ? 1 : 0;
  if (!actor.walk) return here;
  const { to } = actor.walk;
  const destAbs = to.z * HEIGHT_PER_LEVEL + stackHeight(getStack(map, to.x, to.y, to.z), tilesById);
  const there = surfaceWades(map, to.x, to.y, destAbs, tilesById) ? 1 : 0;
  return here + (there - here) * actor.walkProgress;
}

/**
 * Every body that is at least partly in the water, keyed the way the renderer
 * keys placements, or undefined on the usual frame where nobody is.
 * @see WorldView.wading
 */
export function wadingFor(
  map: MapFile,
  actors: readonly WadingActor[],
  tilesById: Record<string, TileDef>,
): Map<string, number> | undefined {
  let out: Map<string, number> | undefined;
  for (const actor of actors) {
    const depth = wadeDepth(map, actor, tilesById);
    if (depth > 0) (out ??= new Map()).set(tileInstanceKey(actor), depth);
  }
  return out;
}
