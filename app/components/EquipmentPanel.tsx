import {
  IconBackpack,
  IconDiamond,
  IconHandStop,
  IconMoodEmpty,
  IconShirt,
  IconShoe,
} from "@tabler/icons-react";
import { useMemo, type ComponentType } from "react";
import { handClaimedByTwoHander, otherHand, type Equipment } from "../game/equipment";
import type { BodySlotRef } from "../game/itemMoves";
import type { MasteryXp } from "../lib/mastery";
import type { StatusDef } from "../lib/status";
import type { TileDef, TilesetDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { ItemSlot, ITEM_SLOT_SIZE_PX } from "./ItemSlot";
import type { ItemDrag } from "./useItemDrag";

const SQUARE_GAP_PX = 6;

const HALF_ROW_PX = (ITEM_SLOT_SIZE_PX + SQUARE_GAP_PX) / 2;

const ROWS_PER_SQUARE = 2;

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
  label: string;
  emptyHint: string;
  icon: IconComponent;
  column: number;
  row: number;
};

const SQUARES: readonly Square[] = [
  {
    slot: { kind: "head" },
    label: "Head",
    emptyHint: "Head — nothing worn",
    icon: IconMoodEmpty,
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
  const claimed = handClaimedByTwoHander(equipment, tilesById);
  const spilling = claimed ? equipment[otherHand(claimed)] : null;

  return (
    <section
      className={["flex flex-col gap-1", className].filter(Boolean).join(" ")}
      aria-label="Equipment"
    >
      <h2 className="text-[11px] font-bold uppercase tracking-wide text-paper/50">Equipment</h2>
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
