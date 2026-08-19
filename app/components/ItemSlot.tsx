import { useCallback, useState, type ComponentType } from "react";
import { slotKey, type SlotRef } from "../game/itemMoves";
import { itemUseFor } from "../game/itemUse";
import { consumeVerb, equipVerb, resolveConsumable } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import type { MasteryXp } from "../lib/mastery";
import type { TileDef, TilesetDef } from "../lib/types";
import { weaponFeelFor } from "../lib/weaponFeel";
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
 *
 * ## Look mode turns a slot from a control into a label
 *
 * While the eye is on, a slot does nothing: it cannot be tapped to wield or eat
 * what is in it, and it cannot be dragged. What it does instead is describe
 * itself the moment a pointer is over it — see {@link SlotTooltip}.
 *
 * That trade is what makes the description reachable at all on a phone. There is
 * no hover on a touchscreen, so the words have to come from a press; but a press
 * that both eats your apple *and* tells you about it is a gesture nobody can use
 * to look at food they want to keep. Look mode already means "I am asking about
 * things rather than doing them" everywhere else on the screen — a tap on the
 * world reads a door instead of opening it — so the kit follows the same rule,
 * and the same gesture is safe because it no longer does the other thing.
 */

/** Which sprite stands for a tile in a slot — the one facing the reader. */
const FRONT: "s" = "s";

/** Big enough to read a 2×2 sprite at, small enough to sit four in a row. */
export const ITEM_SLOT_SIZE_PX = 44;

const SPRITE_SIZE_PX = 32;

/** Smaller than a sprite, so a hint never reads as the thing itself. */
const EMPTY_ICON_SIZE_PX = 20;

const EMPTY_ICON_STROKE = 1.5;

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
  if (use.type === "consume") {
    // The author's verb, in the middle of a sentence: "Eat" reads back as
    // "Press to eat it", so the hint and the row in the world use one word.
    const def = tilesById[instance.tileId];
    const consumable = def ? resolveConsumable(def) : null;
    const verb = consumable ? consumeVerb(consumable) : null;
    return verb ? `Press to ${verb.toLocaleLowerCase()} it.` : null;
  }
  // Named after the thing rather than after the square, on the same terms the
  // world's row is — see `equipVerb`. "Press to wield it" over a backpack is
  // what reading the destination instead used to produce.
  if (use.to.kind === "contents") return "Press to put it away.";
  const def = tilesById[instance.tileId];
  return def ? `Press to ${equipVerb(def).toLocaleLowerCase()} it.` : null;
}

export function ItemSlot({
  slot,
  instance,
  tilesById,
  tilesets,
  label,
  emptyHint,
  emptyIcon: EmptyIcon,
  open,
  drag,
  inspecting = false,
  masteryXp = {},
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
   * Drawn faintly in this square while it is empty — a hand, a pack.
   *
   * **Only the slots on a body have one.** A square inside a bag is a square:
   * anything goes in it, so an icon there would be picturing nothing. The three
   * on your kit are each *for* something, and an empty one saying so is the
   * difference between a panel you have to learn and one you can read.
   *
   * A component rather than a name, so nothing here has to hold a table of
   * icons: the panel that knows what its slots are is the panel that names them.
   */
  emptyIcon?: ComponentType<{ size?: number; stroke?: number; className?: string }>;
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
  /**
   * Look mode is on, so this square describes rather than acts.
   *
   * Passed down from whoever owns the mode rather than read from a store,
   * because it is the same flag the canvas is drawing its blue outlines from:
   * a slot that had its own idea of whether the player was looking would be a
   * second answer to a question the eye button already settles.
   */
  inspecting?: boolean;
  /**
   * What the viewer has learnt, as raw experience — see `GameSnapshot`.
   *
   * Here because half of what a weapon has to say is about the hands holding it.
   * Defaulted to nothing, on the same terms the panels default it: a body that
   * has never fought is told it can barely handle the sword, which is true.
   */
  masteryXp?: MasteryXp;
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

  /**
   * A pointer is resting on this square, or a keyboard has focused it.
   *
   * Only ever read while inspecting, and held here rather than lifted to the
   * panel because only one square can be under a pointer at a time and nothing
   * outside this one needs to know which. `pointerenter` and `pointerleave`
   * cover a mouse and a thumb in the same pair of events — a touch enters on the
   * finger landing and leaves when it lifts — which is what makes "held over"
   * mean the same thing on both.
   */
  const [pointedAt, setPointedAt] = useState(false);
  /**
   * What looking at this square says, in the order the world already says it:
   * what the thing is, what is written on it, and what it would be like to use.
   *
   * The tile's name heads it rather than {@link name}, which prefers whatever is
   * written on the instance. That preference is right for a one-line tooltip and
   * wrong here for the same reason `../render/GameRenderer`'s `lookLines` keeps
   * the two apart: "Left here by someone" answers a different question from
   * "Rusty Sword", and a look that swapped one for the other would leave a
   * player unable to find out what they had picked up.
   *
   * Behind the mode, because reading a weapon's block means parsing it and a
   * panel redraws with the board — the same reason `pressHintFor` is the only
   * other thing here that touches an item's interactions.
   */
  const inspectLines = !inspecting
    ? []
    : [
        tile?.name ?? instance?.tileId ?? "",
        instance?.description?.trim() ?? "",
        tile ? weaponFeelFor(tile, masteryXp) : null,
      ].filter((line): line is string => Boolean(line));

  const held = drag.held;
  /** Being dragged out of this very square, so it is drawn as where it came from. */
  const isSource = held != null && slotKey(held.from) === key;
  const wouldTake = drag.targets.has(key) && !isSource;
  const isOver = drag.over === key;
  // An empty square is not open and is not a toggle, whatever the panel beside
  // it is doing: the state belongs to the *thing* in the slot, and a slot whose
  // thing has been dropped has no state left to be in.
  const isOpen = instance ? open : undefined;
  // Nothing is pressed while looking, so nothing is promised either: a hint
  // saying "Press to wield it" over a square that will not is worse than silence.
  const pressHint = inspecting
    ? null
    : pressHintFor(instance, slot, tilesById, isOpen);
  const showTooltip = inspecting && pointedAt && instance != null;

  return (
    <button
      type="button"
      ref={attach}
      onPointerDown={(event) => {
        if (instance && !inspecting) startDrag(event, slot, instance);
      }}
      onClick={() => {
        if (!inspecting) tap(slot, instance);
      }}
      onPointerEnter={() => setPointedAt(true)}
      onPointerLeave={() => setPointedAt(false)}
      // A keyboard has no pointer to rest anywhere, and focus is the gesture it
      // has instead — so tabbing through a bag while looking reads it out.
      onFocus={() => setPointedAt(true)}
      onBlur={() => setPointedAt(false)}
      className={[
        "relative flex shrink-0 items-center justify-center border-2 transition-colors",
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
              : isOpen
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
      // The browser's own tooltip is what a slot says when you are *not*
      // looking, and it stands down while you are: its half-second delay is
      // precisely what look mode is promising to skip, and two tooltips over one
      // square would be the page answering a question twice.
      title={inspecting ? undefined : instance ? name : emptyHint}
      // What is here, and what pressing it would do. The second half is the
      // whole of the label's job now that a press uses a thing rather than
      // moving it: "Rusty Sword" says what you are on, and only the hint says
      // what happens if you commit to it.
      //
      // While looking, what the square would say aloud takes the hint's place —
      // the same swap the sighted reader gets, since a press does nothing and
      // what the thing is and would be like is the whole of what is left to say.
      aria-label={
        inspecting && instance
          ? `${label}: ${inspectLines.join(". ")}`
          : [`${label}: ${name}`, pressHint].filter(Boolean).join(". ")
      }
      // Only where being pressed is a state the slot can be *in*. A bag is open
      // or shut; wielding a sword is something you do, not somewhere it stays,
      // and a weapon slot claiming a pressed state would be describing a toggle
      // nobody can toggle back.
      aria-pressed={isOpen}
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
      ) : EmptyIcon ? (
        // Faint enough to read as a hint rather than as contents: the square is
        // empty, and an icon at full strength would be something in it.
        <EmptyIcon
          size={EMPTY_ICON_SIZE_PX}
          stroke={EMPTY_ICON_STROKE}
          className="text-paper/25"
        />
      ) : null}
      {showTooltip ? <SlotTooltip lines={inspectLines} /> : null}
    </button>
  );
}

/**
 * What a square says while you are looking at it.
 *
 * **Drawn rather than handed to the browser**, which is the whole point of it
 * existing: a `title` waits half a second and never appears under a thumb at
 * all, and look mode's promise is that pointing at something tells you about it
 * now.
 *
 * The name leads and everything after it is quieter, in the order and the shape
 * the world's look label already uses — see `../render/GameRenderer`'s
 * `lookLines`. A sword on the floor and the same sword in your bag are one thing
 * being asked one question, and the answer should not be laid out two ways.
 *
 * Above the square rather than below it, because a bag is a grid and a tooltip
 * hanging downward covers the row a reader is working along. Inert to the
 * pointer, so it cannot come between a finger and the square it is describing —
 * which would take the pointer off the slot and dismiss the very tooltip that
 * had just appeared.
 */
function SlotTooltip({ lines }: { lines: string[] }) {
  const [name, ...rest] = lines;
  return (
    <span
      // Announced by the button's own label instead: to a screen reader this is
      // a second copy of what `aria-label` already says, and the two together
      // read the name twice.
      aria-hidden
      className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 -translate-x-1/2 border border-paper/40 bg-ink px-1 py-0.5 text-center text-[11px] leading-tight whitespace-nowrap text-paper"
    >
      {name}
      {rest.map((line) => (
        <span key={line} className="block text-paper/70">
          {line}
        </span>
      ))}
    </span>
  );
}
