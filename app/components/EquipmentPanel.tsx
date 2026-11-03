import {
  IconBackpack,
  IconBoot,
  IconDiamond,
  IconFace,
  IconHand,
  IconShirt,
  type PixelIcon,
  type PixelIconProps,
} from "./pixelIcons";
import { useMemo } from "react";
import { handClaimedByTwoHander, otherHand, type Equipment } from "../game/equipment";
import type { BodySlotRef } from "../game/itemMoves";
import type { MasteryXp } from "../lib/mastery";
import type { StatusDef } from "../lib/status";
import type { TileDef, TilesetDef } from "../lib/types";
import { useCoarsePointer } from "../lib/useMediaQuery";
import { tilesByIdFromList } from "../lib/validation";
import { ItemSlot, ITEM_SLOT_SIZE_PX } from "./ItemSlot";
import type { ItemDrag } from "./useItemDrag";

const SQUARE_GAP_PX = 6;

/**
 * On a phone the panels share the bottom third of the screen with the
 * joystick, and the seven squares at desktop size did not fit it.
 */
const TOUCH_SLOT_SIZE_PX = 36;

const TOUCH_SQUARE_GAP_PX = 4;

const ROWS_PER_SQUARE = 2;

const LEFT_COLUMN = 1;
const MIDDLE_COLUMN = 2;
const RIGHT_COLUMN = 3;
const COLUMN_COUNT = 3;

type Square = {
  slot: BodySlotRef;
  label: string;
  emptyHint: string;
  icon: PixelIcon;
  column: number;
  row: number;
};

const SQUARES: readonly Square[] = [
  {
    slot: { kind: "head" },
    label: "Head",
    emptyHint: "Head — nothing worn",
    icon: IconFace,
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
    label: "Accessory",
    emptyHint: "Accessory — nothing worn",
    icon: IconDiamond,
    column: LEFT_COLUMN,
    row: 4,
  },
  {
    slot: { kind: "footwear" },
    label: "Footwear",
    emptyHint: "Footwear — nothing on your feet",
    icon: IconBoot,
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

const ROW_COUNT = Math.max(...SQUARES.map((square) => square.row)) + ROWS_PER_SQUARE - 1;

export function EquipmentPanel({
  equipment,
  masteryXp = {},
  statusDefs,
  bagOpen,
  handOpen = null,
  tiles,
  tilesets,
  drag,
  className = "",
}: {
  equipment: Equipment;
  masteryXp?: MasteryXp;
  statusDefs?: Record<string, StatusDef>;
  bagOpen: boolean;
  handOpen?: "weapon" | "offhand" | null;
  tiles: TileDef[];
  tilesets: TilesetDef[];
  drag: ItemDrag;
  className?: string;
}) {
  const tilesById = useMemo(() => tilesByIdFromList(tiles), [tiles]);
  const coarse = useCoarsePointer();
  const slotPx = coarse ? TOUCH_SLOT_SIZE_PX : ITEM_SLOT_SIZE_PX;
  const gapPx = coarse ? TOUCH_SQUARE_GAP_PX : SQUARE_GAP_PX;
  const claimed = handClaimedByTwoHander(equipment, tilesById);
  const spilling = claimed ? equipment[otherHand(claimed)] : null;

  return (
    <section
      className={["gump flex flex-col gap-1", className].filter(Boolean).join(" ")}
      aria-label="Equipment"
    >
      <div
        className="grid self-center"
        style={{
          gridTemplateColumns: `repeat(${COLUMN_COUNT}, ${slotPx}px)`,
          gridTemplateRows: `repeat(${ROW_COUNT}, ${(slotPx + gapPx) / 2}px)`,
          columnGap: gapPx,
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
              equipment={equipment}
              tilesById={tilesById}
              tilesets={tilesets}
              label={square.label}
              emptyHint={square.emptyHint}
              emptyIcon={square.icon}
              open={isOpen(square.slot, { bagOpen, handOpen })}
              spilledInto={square.slot.kind === claimed ? spilling : null}
              drag={drag}
              masteryXp={masteryXp}
              statusDefs={statusDefs}
              sizePx={slotPx}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function isOpen(
  slot: BodySlotRef,
  { bagOpen, handOpen }: { bagOpen: boolean; handOpen: "weapon" | "offhand" | null },
): boolean {
  if (slot.kind === "bag") return bagOpen;
  return slot.kind === handOpen;
}

function MainHandIcon(props: PixelIconProps) {
  return <IconHand {...props} />;
}

function OffHandIcon({ className = "", ...props }: PixelIconProps) {
  return <IconHand {...props} className={`-scale-x-100 ${className}`} />;
}
