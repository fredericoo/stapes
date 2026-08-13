import type { ItemInstance } from "../lib/itemInstance";
import type { TileDef, TilesetDef } from "../lib/types";
import { TilePreview } from "./TilePreview";

/**
 * One square that either holds a thing or does not.
 *
 * Shared by both panels because a weapon slot and a slot in a bag are the same
 * square with a different rule about what may go in it — and the rules live
 * where items move, not here. This draws.
 *
 * Empty slots are drawn rather than omitted. A bag's capacity is a fact about
 * the bag, and a grid that only showed what was in it would make a four-slot bag
 * holding one thing indistinguishable from a one-slot bag that is full.
 */

/** Which sprite stands for a tile in a slot — the one facing the reader. */
const FRONT: "s" = "s";

/** Big enough to read a 2×2 sprite at, small enough to sit four in a row. */
export const ITEM_SLOT_SIZE_PX = 44;

const SPRITE_SIZE_PX = 32;

export function ItemSlot({
  instance,
  tilesById,
  tilesets,
  label,
  emptyHint,
}: {
  instance: ItemInstance | null;
  tilesById: Record<string, TileDef>;
  tilesets: TilesetDef[];
  /**
   * What this slot is, for anything reading the page aloud. A sighted reader
   * gets it from position and sprite; a screen reader gets nothing without it,
   * since an empty square has no text at all.
   */
  label: string;
  /** Shown in the tooltip of an empty slot — what belongs here. */
  emptyHint?: string;
}) {
  const tile = instance ? (tilesById[instance.tileId] ?? null) : null;
  const name = instance
    ? (instance.description?.trim() || tile?.name || instance.tileId)
    : "empty";

  return (
    <div
      className={[
        "flex shrink-0 items-center justify-center border-2",
        instance
          ? "border-paper/60 bg-paper/10"
          : // A dashed empty slot reads as a place something goes, where a solid
            // one reads as a thing that is simply blank.
            "border-dashed border-paper/25 bg-transparent",
      ].join(" ")}
      style={{ width: ITEM_SLOT_SIZE_PX, height: ITEM_SLOT_SIZE_PX }}
      title={instance ? name : emptyHint}
      // A list item rather than a button: nothing here is clickable yet, and a
      // button that does nothing is worse than no button — it invites a tap and
      // then ignores it.
      role="listitem"
      aria-label={`${label}: ${name}`}
    >
      {tile ? (
        <TilePreview
          tile={tile}
          tilesets={tilesets}
          size={SPRITE_SIZE_PX}
          direction={FRONT}
          still
          chrome={false}
          background={null}
        />
      ) : null}
    </div>
  );
}
