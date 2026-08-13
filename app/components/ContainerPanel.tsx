import { useMemo } from "react";
import { resolveContainer } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import type { TileDef, TilesetDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { ItemSlot } from "./ItemSlot";

/**
 * What is inside a container.
 *
 * One panel for the bag on your back and for the chest on the floor, because
 * they are the same thing: a container is a container, and the only difference
 * between the two is where its instance is being read from. Building the
 * backpack view first and generalising it later would mean two panels drifting
 * apart in exactly the places a player would notice — how a full one reads, what
 * an empty slot looks like.
 *
 * The subject is the instance itself rather than a reference to look up. Whoever
 * opens the panel already has it: the bag comes off the snapshot's equipment,
 * and a ground container comes off its placement, which the client holds because
 * the cell patch that put it there carried its contents.
 */
export function ContainerPanel({
  container,
  tiles,
  tilesets,
  title,
  className = "",
}: {
  /** The container being looked into, or null when there is none to look into. */
  container: ItemInstance | null;
  tiles: TileDef[];
  tilesets: TilesetDef[];
  /** What to call it — "Bag" on your own, the tile's name on a chest. */
  title: string;
  className?: string;
}) {
  const tilesById = useMemo(() => tilesByIdFromList(tiles), [tiles]);

  const def = container ? tilesById[container.tileId] : undefined;
  const size = def ? (resolveContainer(def)?.size ?? 0) : 0;
  const contents = container?.contents ?? [];

  /**
   * One entry per slot the container *has*, not per thing in it.
   *
   * Capacity is the fact worth drawing: a four-slot bag holding one thing and a
   * one-slot bag that is full are the same list of contents and completely
   * different situations to be in.
   *
   * Slots fill in order and cannot be reordered, so the index is only ever a
   * position in a list — nothing may come to treat it as an item's identity.
   */
  const slots: Array<ItemInstance | null> = Array.from(
    { length: size },
    (_, i) => contents[i] ?? null,
  );

  return (
    <section
      className={["flex flex-col gap-1", className].filter(Boolean).join(" ")}
      aria-label={title}
    >
      <h2 className="text-[11px] font-bold uppercase tracking-wide text-paper/50">
        {title}
        {container ? (
          <span className="ml-1 tabular-nums text-paper/40">
            {contents.length}/{size}
          </span>
        ) : null}
      </h2>

      {container ? (
        <div className="flex flex-wrap gap-1" role="list">
          {slots.map((instance, i) => (
            <ItemSlot
              // By position, because that is what a slot *is* here. Keying by
              // instance id would be keying the container on its contents, and
              // an empty slot has no id to key by at all.
              key={i}
              instance={instance}
              tilesById={tilesById}
              tilesets={tilesets}
              label={`Slot ${i + 1}`}
              emptyHint="Empty"
            />
          ))}
        </div>
      ) : (
        // A sentence rather than an empty grid: with no bag there are no slots
        // to draw, and a blank box reads as something that failed to load.
        <p className="px-1 py-2 text-xs text-paper/50">Nothing to carry things in.</p>
      )}
    </section>
  );
}
