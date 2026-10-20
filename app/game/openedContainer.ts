import { getStack } from "../lib/mapData";
import { instanceFromPlacement } from "../lib/itemInstance";
import type { MapFile, TileDef } from "../lib/types";
import { canOpenFrom, type Actor, type ObjectRef } from "./affordances";
import { depotAt, stashIn, type Depots } from "./depot";
import { containerViewOf, type OpenedContainer } from "./itemMoves";

/**
 * `identity` tells this container from whatever takes its place: a ground
 * container's item id, or a depot's tag, since a depot is scenery with no id.
 */
export type OpenedContainerRead =
  | { kind: "open"; container: OpenedContainer; identity: string }
  | { kind: "closed" };

const CLOSED: OpenedContainerRead = { kind: "closed" };

export function readOpenedContainer(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  self: Actor,
  depots: Depots,
  ref: ObjectRef,
  openedIdentity: string | null,
): OpenedContainerRead {
  const placed = getStack(map, ref.x, ref.y, ref.z)[ref.stackIndex];
  if (!placed) return CLOSED;

  const depot = depotAt(map, tilesById, self, ref);
  const identity = depot ? `depot:${depot.tag}` : placed.itemId;
  if (!identity) return CLOSED;
  if (openedIdentity !== null && openedIdentity !== identity) return CLOSED;

  if (depot) {
    return {
      kind: "open",
      container: {
        location: { kind: "depot", ref },
        tileId: placed.tileId,
        size: depot.size,
        contents: stashIn(depots, depot.tag),
      },
      identity,
    };
  }

  if (!canOpenFrom(map, tilesById, self, ref)) return CLOSED;
  const instance = instanceFromPlacement(placed);
  if (!instance) return CLOSED;
  return {
    kind: "open",
    container: { ...containerViewOf(instance, tilesById), location: { kind: "ground", ref } },
    identity,
  };
}
