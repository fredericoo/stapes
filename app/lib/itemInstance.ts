import type { Direction, PlacedTile } from "./types";

export type ItemInstance = {
  id: string;
  tileId: string;
  direction?: Direction;
  channel?: string;
  inscription?: string;
  description?: string;
  engraved?: string;
  contents?: ItemInstance[];
  count?: number;
  cooldownMs?: number;
};

export function mintItemId(): string {
  return `itm_${crypto.randomUUID()}`;
}

export function instanceFromPlacement(placed: PlacedTile): ItemInstance | null {
  if (!placed.itemId) return null;
  return {
    id: placed.itemId,
    tileId: placed.tileId,
    ...(placed.direction ? { direction: placed.direction } : {}),
    ...(placed.channel ? { channel: placed.channel } : {}),
    ...(placed.inscription ? { inscription: placed.inscription } : {}),
    ...(placed.description ? { description: placed.description } : {}),
    ...(placed.engraved ? { engraved: placed.engraved } : {}),
    ...(placed.contents ? { contents: placed.contents } : {}),
    ...(placed.count ? { count: placed.count } : {}),
  };
}

export function placementFromInstance(instance: ItemInstance): PlacedTile {
  return {
    tileId: instance.tileId,
    itemId: instance.id,
    ...(instance.direction ? { direction: instance.direction } : {}),
    ...(instance.channel ? { channel: instance.channel } : {}),
    ...(instance.inscription ? { inscription: instance.inscription } : {}),
    ...(instance.description ? { description: instance.description } : {}),
    ...(instance.engraved ? { engraved: instance.engraved } : {}),
    ...(instance.contents ? { contents: instance.contents } : {}),
    ...(instance.count ? { count: instance.count } : {}),
  };
}

export function sameInstance(a: ItemInstance, b: ItemInstance): boolean {
  if (a === b) return true;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => left[key] === right[key]);
}
