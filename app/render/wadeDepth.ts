import type { ActorSnapshot } from "../game/GameSession";
import { surfaceWades, wadesAt } from "../game/movement";
import { getStack, stackHeight } from "../lib/mapData";
import { HEIGHT_PER_LEVEL, type MapFile, type TileDef } from "../lib/types";
import { tileInstanceKey } from "./WorldRenderer";

type WadingActor = Pick<
  ActorSnapshot,
  "x" | "y" | "z" | "stackIndex" | "walk" | "walkProgress" | "fall"
>;

/** How deep a body wades, and its id, which stays the same as it walks from cell to cell. */
export type Wading = { depth: number; id: string };

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

export function wadingFor(
  map: MapFile,
  actors: readonly (WadingActor & { id: string })[],
  tilesById: Record<string, TileDef>,
): Map<string, Wading> | undefined {
  let out: Map<string, Wading> | undefined;
  for (const actor of actors) {
    const depth = wadeDepth(map, actor, tilesById);
    if (depth > 0) (out ??= new Map()).set(tileInstanceKey(actor), { depth, id: actor.id });
  }
  return out;
}
