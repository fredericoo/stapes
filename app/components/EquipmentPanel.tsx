import {
  IconBackpack,
  IconDiamond,
  IconHandStop,
  IconHelmet,
  IconShirt,
  IconShoe,
} from "@tabler/icons-react";
import { useMemo, type ComponentType } from "react";
import type { Equipment } from "../game/equipment";
import type { BodySlotRef } from "../game/itemMoves";
import type { MasteryXp } from "../lib/mastery";
import type { TileDef, TilesetDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { ItemSlot, ITEM_SLOT_SIZE_PX } from "./ItemSlot";
import type { ItemDrag } from "./useItemDrag";

/**
 * What you are wearing, drawn as a body rather than as a row.
 *
 * ## The arrangement is the label
 *
 * Seven squares laid out where the things go: a helm above, the hands to either
 * side, the chest between them, a charm and the pack below, boots at the
 * bottom. **Nothing is captioned**, and the layout is why it does not have to
 * be — a square directly above the middle of a body is a hat, and a word saying
 * so underneath it would be the picture explaining itself. What an empty square
 * is for is drawn in it instead, faintly, which is a hint you stop noticing
 * once the square is full rather than a label you keep reading.
 *
 * It was a captioned wrapping row of four for as long as there *were* four, and
 * the captions were carrying it: `Main Offhand Body Back` in a line is an
 * arbitrary order somebody has to learn, and it stops being readable the moment
 * there are seven of them. A body is the arrangement everybody already knows.
 *
 * The squares still say what they are to anything reading the page aloud — see
 * `ItemSlot`'s `label` — because position is exactly the cue a screen reader
 * does not get.
 *
 * ## Which squares exist is the game's list, not this one's
 *
 * {@link SQUARES} names every one with its place on the grid, so a panel
 * pretending to more squares than the body has is a type error rather than a
 * drawing nobody can use. A slot added to `EQUIP_SLOTS` and not to that list is
 * a slot a player can never take a thing out of.
 *
 * ## Nothing in here is a number
 *
 * There was a table under the hand for a while listing every mastery the weapon
 * in it asked for against the one you had, and it is gone: what a weapon asks is
 * now a sentence you get by looking at it, on exactly the terms a sword on the
 * floor tells you — see `../lib/weaponFeel`. What a weapon is *worth* has always
 * been absent, and for the reason that decided the rest: this game is played by
 * picking things up and finding out, and a panel that ranked your weapons would
 * be answering the only question the fighting has to offer. What you are good at
 * is not here either — it moved to its own panel, since it answers a different
 * question and does not change when you move an item. See `./StatsPanel`.
 */

/** Between two squares side by side, and between two stacked in a column. */
const SQUARE_GAP_PX = 6;

/**
 * The grid's row, which is *half* a square tall.
 *
 * The whole of how the stagger is built: every square spans two of these, and
 * the columns beside the middle start one row down. That is the offset the
 * middle column's three squares and the sides' two each need in order to
 * interleave, and expressing it as a half-height row is what lets the browser
 * work out the rest rather than this file carrying six hand-computed offsets.
 */
const HALF_ROW_PX = (ITEM_SLOT_SIZE_PX + SQUARE_GAP_PX) / 2;

/** How many of those rows one square covers. */
const ROWS_PER_SQUARE = 2;

/** Left, middle, right — the body seen from the front. */
const LEFT_COLUMN = 1;
const MIDDLE_COLUMN = 2;
const RIGHT_COLUMN = 3;
const COLUMN_COUNT = 3;

type IconComponent = ComponentType<{
  size?: number;
  stroke?: number;
  className?: string;
}>;

type Square = {
  slot: BodySlotRef;
  /** What this square is, for anything reading the page aloud. */
  label: string;
  /** The browser's tooltip on an empty one — what belongs here. */
  emptyHint: string;
  /** Drawn faintly while the square is empty. */
  icon: IconComponent;
  column: number;
  /**
   * Which half-row it starts on, counting from one.
   *
   * Written down rather than derived from the order, because the arrangement is
   * a body and a body is not a sequence: the hands are level with each other and
   * one row below the head, which no walk of a list produces.
   */
  row: number;
};

const SQUARES: readonly Square[] = [
  {
    slot: { kind: "head" },
    label: "Head",
    emptyHint: "Head — nothing worn",
    icon: IconHelmet,
    column: MIDDLE_COLUMN,
    row: 1,
  },
  {
    slot: { kind: "offhand" },
    label: "Off hand",
    emptyHint: "Off hand — nothing held",
    icon: OffHandIcon,
    column: LEFT_COLUMN,
    row: 2,
  },
  {
    slot: { kind: "armor" },
    label: "Armour",
    emptyHint: "Armour — nothing worn",
    icon: IconShirt,
    column: MIDDLE_COLUMN,
    row: 3,
  },
  {
    slot: { kind: "weapon" },
    label: "Weapon",
    emptyHint: "Weapon — nothing in hand",
    icon: MainHandIcon,
    column: RIGHT_COLUMN,
    row: 2,
  },
  {
    slot: { kind: "charm" },
    label: "Charm",
    emptyHint: "Charm — nothing worn",
    icon: IconDiamond,
    column: LEFT_COLUMN,
    row: 4,
  },
  {
    slot: { kind: "footwear" },
    label: "Footwear",
    emptyHint: "Footwear — nothing on your feet",
    icon: IconShoe,
    column: MIDDLE_COLUMN,
    row: 5,
  },
  {
    slot: { kind: "bag" },
    label: "Bag",
    emptyHint: "Bag — nothing on your back",
    icon: IconBackpack,
    column: RIGHT_COLUMN,
    row: 4,
  },
];

/** The bottom of the deepest square, so the grid claims exactly its own height. */
const ROW_COUNT = Math.max(...SQUARES.map((square) => square.row)) + ROWS_PER_SQUARE - 1;

export function EquipmentPanel({
  equipment,
  masteryXp = {},
  bagOpen,
  handOpen = null,
  tiles,
  tilesets,
  drag,
  inspecting = false,
  className = "",
}: {
  equipment: Equipment;
  /**
   * What the viewer has learnt, as raw experience — see `GameSnapshot`.
   *
   * Defaulted to nothing, on the same terms `equipment` is defaulted upstream: a
   * route that has not wired it draws a panel saying nothing is practised yet,
   * which is true of a body that has never fought and harmless for one that has.
   *
   * Handed to the slots rather than read here: half of what a weapon has to say
   * is about the hands holding it, and the slot is where it gets said.
   */
  masteryXp?: MasteryXp;
  /**
   * Whether the panel showing the inside of that bag is on screen.
   *
   * Here because tapping the bag slot is what opens it, and a slot that opened
   * something without ever saying so would be a control with an invisible
   * effect — the panel it opens is somewhere else on the page, and on a phone it
   * has replaced this one entirely.
   */
  bagOpen: boolean;
  /**
   * Which hand is holding a container the player has open, if either is.
   *
   * A hand takes anything you can carry, a spare pack included — and a pack you
   * could hold but never look into would be a worse place to keep it than the
   * floor. So a hand is a third thing that can be open, and it wears the same
   * yellow the bag slot does.
   */
  handOpen?: "weapon" | "offhand" | null;
  tiles: TileDef[];
  tilesets: TilesetDef[];
  /** The one move in progress, page-wide. See `./useItemDrag`. */
  drag: ItemDrag;
  /** Look mode is on, so the slots describe rather than act. See `./ItemSlot`. */
  inspecting?: boolean;
  className?: string;
}) {
  const tilesById = useMemo(() => tilesByIdFromList(tiles), [tiles]);

  return (
    <section
      className={["flex flex-col gap-1", className].filter(Boolean).join(" ")}
      aria-label="Equipment"
    >
      <h2 className="text-[11px] font-bold uppercase tracking-wide text-paper/50">
        Equipment
      </h2>
      <div
        className="grid self-start"
        style={{
          gridTemplateColumns: `repeat(${COLUMN_COUNT}, ${ITEM_SLOT_SIZE_PX}px)`,
          gridTemplateRows: `repeat(${ROW_COUNT}, ${HALF_ROW_PX}px)`,
          columnGap: SQUARE_GAP_PX,
        }}
      >
        {SQUARES.map((square) => (
          <div
            key={square.slot.kind}
            style={{
              gridColumn: square.column,
              gridRow: `${square.row} / span ${ROWS_PER_SQUARE}`,
            }}
          >
            <ItemSlot
              slot={square.slot}
              instance={equipment[square.slot.kind]}
              tilesById={tilesById}
              tilesets={tilesets}
              label={square.label}
              emptyHint={square.emptyHint}
              emptyIcon={square.icon}
              open={isOpen(square.slot, { bagOpen, handOpen })}
              drag={drag}
              inspecting={inspecting}
              masteryXp={masteryXp}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Whether the thing in this square is a container the player is looking into.
 *
 * Only three squares can be, and only because a container can be in them: the
 * pack on your back and whatever either hand is holding. The four worn squares
 * take armour and nothing else, so there is nothing in one to open.
 */
function isOpen(
  slot: BodySlotRef,
  { bagOpen, handOpen }: { bagOpen: boolean; handOpen: "weapon" | "offhand" | null },
): boolean {
  if (slot.kind === "bag") return bagOpen;
  return slot.kind === handOpen;
}

/**
 * A hand, and the same hand the other way round.
 *
 * Tabler has no left and right hand, so the pair is one open palm mirrored —
 * which is what a left and a right hand *are*, and reads as a pair at 20px far
 * better than two unrelated glyphs would. Placeholders, and easy ones to
 * replace: the panel names them here and nothing else knows they are the same
 * icon twice.
 */
function MainHandIcon(props: { size?: number; stroke?: number; className?: string }) {
  return <IconHandStop {...props} />;
}

function OffHandIcon({
  className = "",
  ...props
}: {
  size?: number;
  stroke?: number;
  className?: string;
}) {
  return <IconHandStop {...props} className={`-scale-x-100 ${className}`} />;
}
