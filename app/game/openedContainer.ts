import { getStack } from "../lib/mapData";
import { instanceFromPlacement } from "../lib/itemInstance";
import type { Coord, MapFile, TileDef } from "../lib/types";
import { canOpenFrom, type ObjectRef } from "./affordances";
import type { OpenedContainer } from "./itemMoves";

export type OpenedContainerRead =
  | { kind: "open"; container: OpenedContainer; itemId: string }
  | { kind: "closed" };

export function readOpenedContainer(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  self: Coord,
  ref: ObjectRef,
  openedItemId: string | null,
): OpenedContainerRead {
  const placed = getStack(map, ref.x, ref.y, ref.z)[ref.stackIndex];
  const itemId = placed?.itemId;
  if (!placed || !itemId) return { kind: "closed" };
  if (openedItemId !== null && openedItemId !== itemId) {
    return { kind: "closed" };
  }

  if (!canOpenFrom(map, tilesById, self, ref)) return { kind: "closed" };

  const instance = instanceFromPlacement(placed);
  if (!instance) return { kind: "closed" };
  return { kind: "open", container: { instance, ref }, itemId };
}
