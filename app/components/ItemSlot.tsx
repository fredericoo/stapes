import { useCallback } from "react";
import { slotKey, type SlotRef } from "../game/itemMoves";
import { itemUseFor } from "../game/itemUse";
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

/**
 * What a press on this would do, in a sentence.
 *
 * Read off the same function the press itself runs through, so a slot cannot
 * promise something a tap would not do. Null where a tap does nothing — a sign
 * in your bag is not *for* anything yet, and a button that announced an action
 * it does not have would be worse than one that stays quiet about it.
 */
function pressHintFor(
  instance: ItemInstance | null,
  slot: SlotRef,
  tilesById: Record<string, TileDef>,
  open: boolean | undefined,
): string | null {
  if (!instance) return null;
  const use = itemUseFor(instance, slot, tilesById);
  if (!use) return null;
  if (use.type === "open") return open ? "Press to close it." : "Press to open it.";
  return use.to.kind === "weapon"
    ? "Press to wield it."
    : "Press to put it away.";
}

export function ItemSlot({
  slot,
  instance,
  tilesById,
  tilesets,
  label,
  emptyHint,
  open,
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
   * This thing is currently open, and the panel showing its insides is on
   * screen.
   *
   * Yellow, and yellow is not decoration: it is the colour the outline in the
   * world wears on a box you have opened, and a bag open in two places at once
   * would be two colours for one state.
   */
  open?: boolean | undefined;
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
  const { register, startDrag, tap } = drag;
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
  /** Being dragged out of this very square, so it is drawn as where it came from. */
  const isSource = held != null && slotKey(held.from) === key;
  const wouldTake = drag.targets.has(key) && !isSource;
  const isOver = drag.over === key;
  const pressHint = pressHintFor(instance, slot, tilesById, open);

  return (
    <button
      type="button"
      ref={attach}
      onPointerDown={(event) => {
        if (instance) startDrag(event, slot, instance);
      }}
      onClick={() => tap(slot, instance)}
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
              : open
                ? // Open, in the one colour the game uses for a thing you have
                  // acted on. Above `instance` in this chain because a thing
                  // being open is a louder fact than its merely being there.
                  "border-interact bg-interact/20"
                : instance
                  ? "border-paper/60 bg-paper/10 hover:border-paper"
                  : // A dashed empty slot reads as a place something goes, where
                    // a solid one reads as a thing that is simply blank.
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
      // What is here, and what pressing it would do. The second half is the
      // whole of the label's job now that a press uses a thing rather than
      // moving it: "Rusty Sword" says what you are on, and only the hint says
      // what happens if you commit to it.
      aria-label={
        pressHint ? `${label}: ${name}. ${pressHint}` : `${label}: ${name}`
      }
      // Only where being pressed is a state the slot can be *in*. A bag is open
      // or shut; wielding a sword is something you do, not somewhere it stays,
      // and a weapon slot claiming a pressed state would be describing a toggle
      // nobody can toggle back.
      aria-pressed={open}
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
