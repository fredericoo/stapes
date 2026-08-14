import { useCallback } from "react";
import { slotKey, type SlotRef } from "../game/itemMoves";
import type { ItemInstance } from "../lib/itemInstance";
import type { TileDef, TilesetDef } from "../lib/types";
import type { ItemDrag } from "./useItemDrag";
import { TilePreview } from "./TilePreview";

/**
 * One square that either holds a thing or does not.
 *
 * Shared by both panels because a weapon slot and a slot in a bag are the same
 * square with a different rule about what may go in it — and the rules live
 * where items move, not here. This draws, and reports what was pressed.
 *
 * Empty slots are drawn rather than omitted. A bag's capacity is a fact about
 * the bag, and a grid that only showed what was in it would make a four-slot bag
 * holding one thing indistinguishable from a one-slot bag that is full. It is
 * also what makes an empty slot a place to *drop* something, which a missing
 * square could not be.
 */

/** Which sprite stands for a tile in a slot — the one facing the reader. */
const FRONT: "s" = "s";

/** Big enough to read a 2×2 sprite at, small enough to sit four in a row. */
export const ITEM_SLOT_SIZE_PX = 44;

const SPRITE_SIZE_PX = 32;

export function ItemSlot({
  slot,
  instance,
  tilesById,
  tilesets,
  label,
  emptyHint,
  drag,
}: {
  /** Where this square is, in the terms a move is expressed in. */
  slot: SlotRef;
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
  /**
   * The one drag in progress, page-wide.
   *
   * Passed in rather than owned here because a move has two ends: a square has
   * to know what is in hand to say whether it would take it, and no square can
   * know that on its own.
   */
  drag: ItemDrag;
}) {
  const tile = instance ? (tilesById[instance.tileId] ?? null) : null;
  const name = instance
    ? (instance.description?.trim() || tile?.name || instance.tileId)
    : "empty";

  const key = slotKey(slot);
  const { register, startDrag, activate } = drag;
  // Keyed on the string rather than the slot object, which is rebuilt every
  // render: a ref callback whose identity changed each time would be torn down
  // and re-attached on every frame the panel drew.
  const attach = useCallback(
    (el: HTMLElement | null) => register(key, slot, el),
    // `slot` is deliberately absent: the key is derived from it, so two slot
    // objects with one key are the same slot and rebinding for the new object
    // would be work with no answer attached to it.
    [key, register],
  );

  const held = drag.held;
  /** Lifted out of this very square, so it is drawn as somewhere to put it back. */
  const isSource = held != null && slotKey(held.from) === key;
  const wouldTake = drag.targets.has(key) && !isSource;
  const isOver = drag.over === key;

  return (
    <button
      type="button"
      ref={attach}
      onPointerDown={(event) => {
        if (instance) startDrag(event, slot, instance);
      }}
      onClick={() => activate(slot, instance)}
      className={[
        "flex shrink-0 items-center justify-center border-2 transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        isOver
          ? // Under the pointer and legal: the strongest state on screen, because
            // it is the one answering "will it land here".
            "border-accent bg-accent/30"
          : wouldTake
            ? "border-accent/60 bg-accent/10"
            : isSource
              ? // Where it came from, dimmed rather than emptied: the thing is
                // still yours until you let go of it somewhere.
                "border-dashed border-paper/60 bg-paper/5 opacity-50"
              : instance
                ? "border-paper/60 bg-paper/10 hover:border-paper"
                : // A dashed empty slot reads as a place something goes, where a
                  // solid one reads as a thing that is simply blank.
                  "border-dashed border-paper/25 bg-transparent",
      ].join(" ")}
      style={{
        width: ITEM_SLOT_SIZE_PX,
        height: ITEM_SLOT_SIZE_PX,
        // Without this a finger dragging off a slot scrolls the panel instead of
        // moving the item, and the pointermove events stop arriving entirely.
        touchAction: "none",
      }}
      title={instance ? name : emptyHint}
      // The highlight says "this one would take it" to somebody who can see it;
      // this is the same sentence for somebody who cannot. Written into the
      // label rather than left to the colour, because with something in hand the
      // only question a slot is answering is whether it is a place to put it.
      aria-label={
        isSource
          ? `${label}: ${name}, lifted. Press again to put it back.`
          : held && wouldTake
            ? `${label}: ${name}. Press to place here.`
            : `${label}: ${name}`
      }
      // Said rather than implied by the dimming, so the two-step is followable
      // without seeing it: pressing a slot announces that it is now lifted.
      aria-pressed={isSource}
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
    </button>
  );
}
