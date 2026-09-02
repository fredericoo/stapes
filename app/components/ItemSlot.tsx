import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { slotKey, type SlotRef } from "../game/itemMoves";
import { itemUseFor } from "../game/itemUse";
import { consumeVerb, equipVerb, resolveConsumable } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { pileTally } from "../lib/piles";
import type { MasteryXp } from "../lib/mastery";
import type { TileDef, TilesetDef } from "../lib/types";
import { useCoarsePointer } from "../lib/useMediaQuery";
import { weaponDemandFor } from "../lib/weaponDemand";
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
const FRONT = "s" as const;

/**
 * How long a finger has to rest on a square before it is asking about it.
 *
 * Long enough that a tap never trips it — a tap is a tenth of a second and this
 * is four — and short enough that it does not feel like waiting. It also has to
 * clear the drag threshold in *practice* rather than in principle: a thumb on
 * its way to another slot has crossed six pixels long before this is up.
 */
const DWELL_MS = 400;

/**
 * Big enough to read a 2×2 sprite at, small enough to sit four in a row.
 *
 * The **natural** size rather than the only one: a container works out how big
 * its squares should be from the column it was given — see `./ContainerPanel`'s
 * `containerSlotGrid` — because a bag on a phone gets half the width the same
 * bag gets in a desktop column and a square that ignored that is either cramped
 * or lost. This is what everything that has no opinion draws at, which is the
 * equipment panel and anything with a fixed row to fill.
 */
export const ITEM_SLOT_SIZE_PX = 44;

/**
 * How much of the square the sprite takes, leaving the rest as its mount.
 *
 * A share rather than a size, because the square is no longer one size. The
 * sprite itself stays chunky at any of them: `drawSprite` snaps to an integer
 * scale internally and centres what is left over, so a fluid number here buys
 * bigger art without ever buying interpolated art.
 */
const SPRITE_SHARE = 32 / ITEM_SLOT_SIZE_PX;

/** Smaller than a sprite, so a hint never reads as the thing itself. */
const EMPTY_ICON_SHARE = 20 / ITEM_SLOT_SIZE_PX;

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
  sizePx = ITEM_SLOT_SIZE_PX,
  spilledInto = null,
}: {
  /** Where this square is, in the terms a move is expressed in. */
  slot: SlotRef;
  instance: ItemInstance | null;
  /**
   * A thing in the *other* hand that has spoken for this one — a two-handed
   * weapon, which occupies one square and claims its partner.
   *
   * **Drawn rather than held.** The square is genuinely empty in the model, and
   * has to be: an instance stored in two slots would be two references to a
   * thing there is one of. What this draws is a picture of where the weapon
   * goes, faint enough that nobody reads it as a second sword, and the square
   * stays untappable and undraggable because there is nothing in it to take.
   *
   * Null for every square that is not a hand, and for a hand nobody is reaching
   * into. See `../game/equipment`'s `handClaimedByTwoHander`.
   */
  spilledInto?: ItemInstance | null;
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
  /**
   * How big to draw, where the caller has worked that out from the room it has.
   * Defaults to the natural size — see {@link ITEM_SLOT_SIZE_PX}.
   */
  sizePx?: number;
}) {
  const tile = instance ? (tilesById[instance.tileId] ?? null) : null;
  const spilledTile =
    !instance && spilledInto ? (tilesById[spilledInto.tileId] ?? null) : null;
  // What this square *is*, which for a hand a two-hander has reached into is
  // "taken by that weapon" rather than "empty" — a screen reader hearing "empty"
  // over a square nothing may go in would be told the opposite of what is true.
  /** "×3" over a pile of three, or nothing at all over one of anything. */
  const tally = instance ? pileTally(instance) : null;
  const name = instance
    ? [instance.description?.trim() || tile?.name || instance.tileId, tally]
        .filter(Boolean)
        .join(" ")
    : spilledTile
      ? `both hands on the ${spilledTile.name}`
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
  // The one question the interface asks about the device, asked here because a
  // held finger is a gesture a mouse does not make. See `../lib/useMediaQuery`.
  const coarse = useCoarsePointer();
  const [pointedAt, setPointedAt] = useState(false);
  /**
   * A finger has been resting on this square long enough to be asking about it.
   *
   * **The thumb's version of hovering.** Look mode was the only way to read a
   * square without also using what was in it, and on a phone that means finding
   * a mode before you can find out what you are carrying — where a mouse gets
   * the same sentence for free by not clicking. A held finger is the gesture
   * that already means "this one, but wait": it costs no mode, and it is the one
   * press a player can make that unambiguously is not a tap.
   *
   * Only ever set on a coarse pointer. A mouse held down on a square is the
   * start of a drag and nothing else, and it has hover for the asking.
   */
  const [dwelling, setDwelling] = useState(false);
  /**
   * The same fact as {@link dwelling}, readable *now*.
   *
   * A state updater does not run when it is called — React defers it — so a
   * handler that decided "was I dwelling?" inside `setDwelling` would be
   * deciding after the event it was deciding about. That is not hypothetical:
   * written that way, the flag below was raised after the click it existed to
   * swallow, and went on to eat the next honest tap instead.
   */
  const dwellingRef = useRef(false);
  const dwellTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The lift that ends a hold must not also use the thing.
   *
   * The whole point of the gesture is looking at food you want to keep — the
   * same trade look mode makes — so once the square has answered, the click the
   * browser synthesises behind the finger is swallowed rather than eaten.
   */
  const swallowClick = useRef(false);

  const endDwell = useCallback(() => {
    if (dwellTimer.current !== null) {
      clearTimeout(dwellTimer.current);
      dwellTimer.current = null;
    }
    if (!dwellingRef.current) return;
    dwellingRef.current = false;
    swallowClick.current = true;
    setDwelling(false);
  }, []);

  // A press that turned into a drag is not a question. `held` goes up six
  // pixels into the gesture — see `./useItemDrag` — which is well before the
  // dwell is up, so a thumb on its way somewhere never gets a tooltip.
  const dragging = drag.held != null;
  useEffect(() => {
    if (dragging) endDwell();
  }, [dragging, endDwell]);

  // A square taken off the screen mid-hold — a bag closing under the finger —
  // must not leave its timer running against a component that is gone.
  useEffect(() => endDwell, [endDwell]);
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
  const asking = inspecting || dwelling;
  const inspectLines = !asking
    ? []
    : [
        // The count rides on the name rather than taking a line of its own: it
        // is part of what the thing *is*, and the lines under a name are for
        // what it says and what it asks of you.
        [tile?.name ?? instance?.tileId ?? "", tally].filter(Boolean).join(" "),
        instance?.description?.trim() ?? "",
        ...(tile ? weaponDemandFor(tile, masteryXp) : []),
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
  // Dwelling is already "a finger is on this square", so it needs no second
  // test that the pointer is here; looking wants one, because every square in
  // the bag is in look mode at once and only the pointed-at one has a question.
  const showTooltip =
    instance != null && (dwelling || (inspecting && pointedAt));

  return (
    <button
      type="button"
      ref={attach}
      onPointerDown={(event) => {
        if (instance && !inspecting) startDrag(event, slot, instance);
        // Started alongside the drag rather than instead of it, because which
        // gesture this is has not been decided yet: whichever of the two
        // resolves first — six pixels of travel, or {@link DWELL_MS} of
        // stillness — calls the other off.
        if (coarse && instance && !inspecting) {
          dwellTimer.current = setTimeout(() => {
            dwellTimer.current = null;
            dwellingRef.current = true;
            setDwelling(true);
          }, DWELL_MS);
        }
      }}
      onPointerUp={endDwell}
      onPointerCancel={endDwell}
      onClick={() => {
        if (swallowClick.current) {
          swallowClick.current = false;
          return;
        }
        if (!inspecting) tap(slot, instance);
      }}
      onPointerEnter={() => setPointedAt(true)}
      onPointerLeave={() => {
        setPointedAt(false);
        endDwell();
      }}
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
        width: sizePx,
        height: sizePx,
        // Without this a finger dragging off a slot scrolls the panel instead of
        // moving the item, and the pointermove events stop arriving entirely.
        touchAction: "none",
      }}
      // The browser's own tooltip is what a slot says when you are *not*
      // looking, and it stands down while you are: its half-second delay is
      // precisely what look mode is promising to skip, and two tooltips over one
      // square would be the page answering a question twice.
      title={asking ? undefined : instance ? name : emptyHint}
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
          size={Math.round(sizePx * SPRITE_SHARE)}
          direction={FRONT}
          still
          chrome={false}
          background={null}
        />
      ) : spilledTile ? (
        // The other hand's two-hander reaching into this square. Faint, and
        // above the empty icon in this chain, because a hand that is spoken for
        // is not a hand you can put anything in — drawing the "nothing here yet"
        // hint over it would be offering a square that is already taken.
        <span aria-hidden className="opacity-30">
          <TilePreview
            tile={spilledTile}
            tilesets={tilesets}
            size={Math.round(sizePx * SPRITE_SHARE)}
            direction={FRONT}
            still
            chrome={false}
            background={null}
          />
        </span>
      ) : EmptyIcon ? (
        // Faint enough to read as a hint rather than as contents: the square is
        // empty, and an icon at full strength would be something in it.
        <EmptyIcon
          size={Math.round(sizePx * EMPTY_ICON_SHARE)}
          stroke={EMPTY_ICON_STROKE}
          className="text-paper/25"
        />
      ) : null}
      {tally ? (
        // Announced through the square's own label instead — it is part of the
        // name up there, and a badge with its own text would read the count
        // twice. Bottom right, over the corner of the sprite, which is where a
        // count has been drawn on a stack of things since inventories had
        // squares at all.
        <span
          aria-hidden
          className="pointer-events-none absolute right-0 bottom-0 px-0.5 text-[10px] leading-none font-bold text-paper [text-shadow:1px_1px_0_var(--color-ink),-1px_1px_0_var(--color-ink),1px_-1px_0_var(--color-ink),-1px_-1px_0_var(--color-ink)]"
        >
          {tally}
        </span>
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
 *
 * **And nudged back on screen when centring would take it off.** It is wider
 * than the square it names and the leftmost column of a phone's panel sits
 * against the edge of the display, so centred it read "asic Bag". One
 * measurement when it appears, not per frame: it is up for as long as a finger
 * rests, and nothing about it moves in between.
 */

/** How close to the edge of the screen a tooltip may come before it is nudged. */
const TOOLTIP_MARGIN_PX = 8;

function SlotTooltip({ lines }: { lines: string[] }) {
  const [name, ...rest] = lines;
  const ref = useRef<HTMLSpanElement>(null);
  /** How far to slide it back from whichever edge it was about to fall off. */
  const [shiftPx, setShiftPx] = useState(0);

  // Measured on the way in, while the shift is still zero — the tooltip is
  // mounted fresh every time it appears, so this reads the centred position
  // rather than one it has already been moved to.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const offLeft = TOOLTIP_MARGIN_PX - rect.left;
    const offRight = rect.right - (window.innerWidth - TOOLTIP_MARGIN_PX);
    // Left wins a tie, which only happens on a tooltip wider than the screen:
    // the beginning of a name is the half worth keeping.
    if (offLeft > 0) setShiftPx(offLeft);
    else if (offRight > 0) setShiftPx(-offRight);
  }, [lines]);

  return (
    <span
      ref={ref}
      // Announced by the button's own label instead: to a screen reader this is
      // a second copy of what `aria-label` already says, and the two together
      // read the name twice.
      aria-hidden
      className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 border border-paper/40 bg-ink px-1 py-0.5 text-center text-[11px] leading-tight whitespace-nowrap text-paper"
      style={{ transform: `translateX(calc(-50% + ${shiftPx}px))` }}
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
