import { IconX } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { slotIn, type ContainerRef } from "../game/itemMoves";
import { resolveContainer } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import type { MasteryXp } from "../lib/mastery";
import type { TileDef, TilesetDef } from "../lib/types";
import { useCoarsePointer } from "../lib/useMediaQuery";
import { tilesByIdFromList } from "../lib/validation";
import { ItemSlot, ITEM_SLOT_SIZE_PX } from "./ItemSlot";
import { TilePreview } from "./TilePreview";
import type { ItemDrag } from "./useItemDrag";

/** Which sprite stands for the container in its own heading. */
const FRONT: "s" = "s";

/**
 * How big the ✕ is drawn, inside a 20px button.
 *
 * An icon rather than the character, because the character could not be
 * centred: `button { font: inherit }` in `app.css` is unlayered, so it beats
 * every Tailwind `text-*` and `leading-*` utility a button carries — the glyph
 * was laid out at 16px in a 24px line box and hung out of the bottom of a 20px
 * square. An SVG has no line box to hang out of.
 */
const CLOSE_ICON_SIZE_PX = 12;

/**
 * Big enough to tell a chest from a bag, small enough to sit in a heading.
 *
 * Exported because `./StatusStrip` and the panel's effects list are sized off it
 * rather than off {@link ITEM_SLOT_SIZE_PX}: a status icon is a mark beside a
 * name, which is exactly this, and not a thing you could pick up, which is the
 * slot.
 */
export const TITLE_SPRITE_SIZE_PX = 18;

/**
 * The gap between squares across a row, in the units the arithmetic below counts
 * in. It is the column gap alone: see {@link SLOT_ROW_GAP_PX}.
 */
const SLOT_GAP_PX = 4;

/**
 * The gap between *rows*, which is wider than the one between columns.
 *
 * Every square carries its name under it now, so a row is a square plus a word
 * and the two gaps stopped being the same problem. Across, four pixels keeps
 * squares apart. Down, four pixels would put the next row's square as close to
 * this row's caption as the caption is to the square it belongs to — and a label
 * sitting equidistant between two things is a label attached to neither.
 */
const SLOT_ROW_GAP_PX = 10;

/**
 * How many squares a dense row holds, and the width that earns it.
 *
 * Four is what a desktop column has always shown and what the natural slot size
 * was picked for — see {@link ITEM_SLOT_SIZE_PX}. Below the width four of them
 * need, the row halves rather than degrading: three-and-an-orphan is what a
 * four-slot bag actually did in the phone's column, and a bag drawn as a ragged
 * shape is a bag you have to count.
 */
const DENSE_COLUMNS = 4;
const SPARSE_COLUMNS = 2;

/**
 * The smallest a square in a dense row may be, which is what decides where the
 * row halves.
 *
 * A little under the natural size rather than equal to it, and the slack is the
 * point. The desktop aside leaves this row 190px and four naturals plus their
 * gaps want 188: a threshold set at exactly "four fit" would have the column
 * count hinge on two pixels, and two pixels is a scrollbar, a border, or
 * somebody adding a pixel of padding to the panel — after which the desktop
 * would silently drop to two columns and nobody would know which change did it.
 */
const DENSE_MIN_SLOT_PX = 40;

/**
 * As big as a square is worth being.
 *
 * Roughly a thumb. Without a ceiling, two columns of a wide panel would give a
 * bag two enormous squares with a 32px sprite marooned in the middle of each —
 * the art has a size it is drawn at, and past a point the square stops being a
 * bigger target and starts being a bigger *frame*.
 */
const MAX_SLOT_SIZE_PX = 72;


/**
 * What a square is captioned with — the thing's *kind*, not what is written on
 * it.
 *
 * The tile's name rather than the instance's description, which is the opposite
 * preference to the square's own tooltip and deliberately so: it is the same
 * split `./ItemSlot`'s inspect lines already make. "Left here by someone"
 * answers a different question from "Rusty Sword", and a caption is answering
 * "which of these is which" — a shelf of identical silhouettes labelled with
 * three different people's notes is a shelf you still have to open.
 *
 * The description is the fallback rather than nothing, for an instance whose
 * tile has gone from the catalogue: a wrong-but-present word beats a blank.
 */
export function slotCaptionFor(
  instance: ItemInstance | null,
  tilesById: Record<string, TileDef>,
): string {
  if (!instance) return "";
  const def = tilesById[instance.tileId];
  return def?.name || instance.description?.trim() || instance.tileId;
}

/**
 * How a container lays its squares out in the room it has been given.
 *
 * Arithmetic rather than layout, and that is why it is a function here instead
 * of CSS in the component: one length in, a column count and a square size out,
 * and it can be asserted without a browser. The same trade `./StatusStrip`
 * makes, measured the same way.
 *
 * **The squares fill the row rather than sitting at a fixed size in it.** A
 * container appears in two columns of very different widths — the phone's
 * reading column and the desktop aside — and a fixed square either wastes the
 * wide one or wraps ragged in the narrow one. Both were happening. So the count
 * comes from the width and the size comes from the count, and the last row is
 * only ever short by whatever the *capacity* leaves over.
 */
export function containerSlotGrid(availablePx: number): {
  columns: number;
  slotPx: number;
} {
  const dense =
    availablePx >=
    DENSE_COLUMNS * DENSE_MIN_SLOT_PX + (DENSE_COLUMNS - 1) * SLOT_GAP_PX;
  const columns = dense ? DENSE_COLUMNS : SPARSE_COLUMNS;
  const fit = Math.floor(
    (availablePx - (columns - 1) * SLOT_GAP_PX) / columns,
  );
  // Floored at the dense minimum as well as capped: a panel measured at zero —
  // the first render, before the observer has said anything — must not draw a
  // row of nothing.
  const slotPx = Math.max(DENSE_MIN_SLOT_PX, Math.min(MAX_SLOT_SIZE_PX, fit));
  return { columns, slotPx };
}

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
  location,
  tiles,
  tilesets,
  title,
  onClose,
  drag,
  inspecting = false,
  masteryXp = {},
  className = "",
}: {
  /**
   * The container being looked into.
   *
   * Never null. A panel is a thing you opened, so there is no such state as one
   * with nothing in it to look at — whoever renders this closes it instead. It
   * used to take a null and print "Nothing to carry things in", which is a
   * window explaining why it is not a window.
   */
  container: ItemInstance;
  /**
   * Which container this is, in the terms a move is expressed in.
   *
   * The whole of the difference between the bag on your back and the chest at
   * your feet: the panel draws the same either way, and this is what its slots
   * are called when something is moved out of one of them.
   */
  location: ContainerRef;
  tiles: TileDef[];
  tilesets: TilesetDef[];
  /** What to call it — "Bag" on your own, the tile's name on a chest. */
  title: string;
  /**
   * Shut it.
   *
   * Required, and the same gesture for every container: a chest on the floor has
   * no other way out, and the bag on your back gains one that is nearer than the
   * button in the strip. What it *means* differs — a chest stops being watched,
   * a bag is only put away — and neither of those is this component's business.
   */
  onClose: () => void;
  /** The one move in progress, page-wide. See `./useItemDrag`. */
  drag: ItemDrag;
  /** Look mode is on, so the slots describe rather than act. See `./ItemSlot`. */
  inspecting?: boolean;
  /**
   * What the viewer has learnt — theirs, not the container's, and that is the
   * point: a sword in a chest on the floor is inspected by the person standing
   * over it, so what it says depends on whose hands are asking.
   */
  masteryXp?: MasteryXp;
  className?: string;
}) {
  const tilesById = useMemo(() => tilesByIdFromList(tiles), [tiles]);

  /**
   * The row measures itself, and the squares are sized from what it says.
   *
   * A `ResizeObserver` rather than a CSS container query because the answer has
   * to reach *React*, not only the stylesheet: a sprite is drawn into a canvas
   * at a number of pixels — see `./TilePreview` — so a square whose size only
   * CSS knew about would grow around art that stayed the size it always was.
   * The observer is on the row itself, so what is measured is the room the
   * squares actually have rather than the panel's width minus a guess at its
   * padding.
   */
  const rowRef = useRef<HTMLDivElement>(null);
  const [widthPx, setWidthPx] = useState(0);

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const observer = new ResizeObserver(() => setWidthPx(row.clientWidth));
    observer.observe(row);
    setWidthPx(row.clientWidth);
    return () => observer.disconnect();
  }, []);

  const { columns, slotPx } = containerSlotGrid(widthPx);
  /**
   * Whether the squares say what is in them.
   *
   * **On a finger, and not on a mouse.** It is the same fact the whole layout
   * turns on rather than anything about how wide the squares came out: a mouse
   * gets a name by resting on a square and a finger has nothing to rest, so the
   * caption is filling a hole that only exists on one of the two devices. On a
   * desktop the same words are a hover away and the column is better spent on
   * squares — which is also why the dense layout there is left exactly as it
   * was.
   */
  const captioned = useCoarsePointer();

  const def = tilesById[container.tileId];
  const size = def ? (resolveContainer(def)?.size ?? 0) : 0;
  const contents = container.contents ?? [];

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
      // Walled and floored, name and all, so the panel reads as *being* the box
      // rather than as a list that happens to be about one. The heading and the
      // way out are inside it for the same reason: they belong to this
      // container, and a title sitting outside the walls would be a label on a
      // shelf rather than the lid of a chest.
      className={[
        "flex flex-col gap-1 border-2 border-paper/25 bg-paper/5 p-1.5",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={title}
    >
      <div className="flex items-center gap-1.5">
        {/* The thing itself, beside its name. Two chests and a backpack are
            three panels that would otherwise differ only by a word, and the
            sprite is how you know at a glance which box you are looking into —
            the same reason the strip's button is the literal bag. */}
        {def ? (
          <TilePreview
            tile={def}
            tilesets={tilesets}
            size={TITLE_SPRITE_SIZE_PX}
            direction={FRONT}
            still
            chrome={false}
            background={null}
          />
        ) : null}
        <h2 className="text-[11px] font-bold uppercase tracking-wide text-paper/50">
          {title}
          <span className="ml-1 tabular-nums text-paper/40">
            {contents.length}/{size}
          </span>
        </h2>
        {/* Square, and always there. Every box shuts the same way — the one on
            your back included, where it only puts the panel away — because a
            close button that came and went by which container you were looking
            at would be a control you have to find rather than one you know. */}
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${title}`}
          className="ml-auto grid h-5 w-5 shrink-0 place-items-center border-2 border-paper/40 text-paper/70 hover:border-paper hover:text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <IconX size={CLOSE_ICON_SIZE_PX} stroke={3} aria-hidden="true" />
        </button>
      </div>

      {/* A grid rather than a wrapping row, so the columns are a decision rather
          than a consequence: what wraps depends on how wide a square happens to
          be, and what a container wants to say is "this many across". */}
      <div
        ref={rowRef}
        className="grid"
        style={{
          columnGap: SLOT_GAP_PX,
          // The wider row gap is the caption's, so it goes when the caption
          // does: an unlabelled grid wants its squares evenly spaced in both
          // directions, and would otherwise carry a gap paying for text that is
          // not there.
          rowGap: captioned ? SLOT_ROW_GAP_PX : SLOT_GAP_PX,
          gridTemplateColumns: `repeat(${columns}, ${slotPx}px)`,
          // Left, so a part-full last row hangs off the same edge every other
          // row starts at. Centring it would put the odd square out of line with
          // the column above it.
          justifyContent: "start",
        }}
      >
        {slots.map((instance, i) => (
          <div
            // By position, because that is what a slot *is* here. Keying by
            // instance id would be keying the container on its contents, and
            // an empty slot has no id to key by at all.
            key={i}
            className="flex flex-col gap-0.5"
          >
            <ItemSlot
              slot={slotIn(location, i)}
              instance={instance}
              tilesById={tilesById}
              tilesets={tilesets}
              label={`${title}, slot ${i + 1}`}
              emptyHint="Empty"
              drag={drag}
              inspecting={inspecting}
              masteryXp={masteryXp}
              sizePx={slotPx}
            />
            {/* What the thing is, under it.
                A sprite is a handful of pixels, and a lantern and a sword are
                the same handful at this size; the word is what turns a wall of
                silhouettes into a bag you can read without opening anything.

                **One line, and never wrapped.** The box is there whether or not
                the square holds something, so a bag with one thing in it keeps
                its rows level with a full one — and a name too long for the
                column is cut rather than allowed to shove the row below it down.

                Absent entirely on a pointer that can hover, where the same
                words are already a rest away and the room is better spent on
                the squares.

                Hidden from anything reading the page aloud: the square's own
                label already says what is in it, and a caption repeating it
                would have every slot read out twice. */}
            {captioned ? (
              <span
                aria-hidden="true"
                className="block h-4 truncate text-[11px] leading-4 text-paper/60"
              >
                {slotCaptionFor(instance, tilesById)}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
