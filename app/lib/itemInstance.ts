import type { Direction, PlacedTile } from "./types";

/**
 * One particular thing, as opposed to the kind of thing it is.
 *
 * ## An item instance is a placement without a position
 *
 * A {@link PlacedTile} is already a tile id plus the metadata belonging to the
 * *slot* rather than to the tile def — `channel`, `description`, `direction`. An
 * item carries exactly that, because a sign you pick up is still the sign that
 * said what it said, and a wired lever in your bag is still wired to its channel
 * when you put it down.
 *
 * So the two shapes are convertible in both directions with nothing lost, and
 * that correspondence is the thing to protect as either grows: a field added to
 * one and not the other is a field that silently disappears the first time
 * somebody picks the thing up and puts it down again. Both directions live in
 * this module for exactly that reason, next to each other, where the omission is
 * visible.
 *
 * ## Contents, and why they are not a tree
 *
 * A container's `contents` is a flat list, and it stays flat because no
 * container may hold a container — see `./item`. Depth is exactly one
 * everywhere, so nothing here recurses and every capacity check is a single
 * comparison.
 */
export type ItemInstance = {
  /**
   * Minted once and kept for the life of the thing, across every pickup and
   * drop. What makes an item traceable rather than merely typed: two
   * `rusty-sword` instances are two distinct swords, and stay distinguishable
   * after both have been in and out of a bag.
   */
  id: string;
  tileId: string;
  direction?: Direction;
  channel?: string;
  description?: string;
  /** Containers only. Flat, and never holds another container. */
  contents?: ItemInstance[];
};

/**
 * A fresh identity for a thing that has none.
 *
 * Random rather than derived from where it is standing, unlike an NPC's
 * `npc:12,3,0` owner id. That id names a *runtime*, which does not move; this
 * one names a thing whose whole purpose is to be carried around, and a
 * coordinate baked into it would be a lie one tick after it was minted.
 */
export function mintItemId(): string {
  return `itm_${crypto.randomUUID()}`;
}

/**
 * Lift a placement into an instance, or null when it is not carrying an
 * identity.
 *
 * Null rather than minting one on the spot: every item in a loaded world has
 * been given an id already (see `mintItemIds`), so an anonymous placement here
 * means something skipped that pass, and quietly inventing an id would hide it.
 *
 * Optional fields are omitted rather than set to `undefined`, because these are
 * serialized — into a checkpoint, into `data/map.json`, across the wire — and an
 * explicit `undefined` is a key that survives as `null` in some of those and not
 * others.
 */
export function instanceFromPlacement(placed: PlacedTile): ItemInstance | null {
  if (!placed.itemId) return null;
  return {
    id: placed.itemId,
    tileId: placed.tileId,
    ...(placed.direction ? { direction: placed.direction } : {}),
    ...(placed.channel ? { channel: placed.channel } : {}),
    ...(placed.description ? { description: placed.description } : {}),
    ...(placed.contents ? { contents: placed.contents } : {}),
  };
}

/**
 * Put an instance back on the board.
 *
 * The exact inverse of {@link instanceFromPlacement}, and deliberately not a
 * spread of it: `owner` is the one placement field an item must never carry, so
 * the fields are named here rather than copied wholesale. An item that arrived
 * with an owner would read as somebody's body.
 */
export function placementFromInstance(instance: ItemInstance): PlacedTile {
  return {
    tileId: instance.tileId,
    itemId: instance.id,
    ...(instance.direction ? { direction: instance.direction } : {}),
    ...(instance.channel ? { channel: instance.channel } : {}),
    ...(instance.description ? { description: instance.description } : {}),
    ...(instance.contents ? { contents: instance.contents } : {}),
  };
}
