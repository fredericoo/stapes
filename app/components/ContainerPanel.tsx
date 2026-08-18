import { IconX } from "@tabler/icons-react";
import { useMemo } from "react";
import { slotIn, type ContainerRef } from "../game/itemMoves";
import { resolveContainer } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import type { MasteryXp } from "../lib/mastery";
import type { TileDef, TilesetDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { ItemSlot } from "./ItemSlot";
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

      <div className="flex flex-wrap gap-1">
        {slots.map((instance, i) => (
          <ItemSlot
            // By position, because that is what a slot *is* here. Keying by
            // instance id would be keying the container on its contents, and
            // an empty slot has no id to key by at all.
            key={i}
            slot={slotIn(location, i)}
            instance={instance}
            tilesById={tilesById}
            tilesets={tilesets}
            label={`${title}, slot ${i + 1}`}
            emptyHint="Empty"
            drag={drag}
            inspecting={inspecting}
            masteryXp={masteryXp}
          />
        ))}
      </div>
    </section>
  );
}
