import { useEffect, useMemo, useState } from "react";
import type { Equipment } from "../game/equipment";
import { slotIn, type ContainerRef, type ContainerView } from "../game/itemMoves";
import { engravedName } from "../lib/engraving";
import type { ItemInstance } from "../lib/itemInstance";
import type { MasteryXp } from "../lib/mastery";
import type { StatusDef } from "../lib/status";
import type { TileDef, TilesetDef } from "../lib/types";
import { useCoarsePointer } from "../lib/useMediaQuery";
import { tilesByIdFromList } from "../lib/validation";
import { HudWindow } from "./HudWindow";
import { type HeldStatus, ItemSlot } from "./ItemSlot";
import { TilePreview } from "./TilePreview";
import type { ItemDrag } from "./useItemDrag";

const FRONT = "s" as const;

export const TITLE_SPRITE_SIZE_PX = 18;

const SLOT_GAP_PX = 4;

const SLOT_ROW_GAP_PX = 10;

const DENSE_COLUMNS = 4;
const SPARSE_COLUMNS = 2;

const DENSE_MIN_SLOT_PX = 40;

const MAX_SLOT_SIZE_PX = 72;

export function slotCaptionFor(
  instance: ItemInstance | null,
  tilesById: Record<string, TileDef>,
): string {
  if (!instance) return "";
  const def = tilesById[instance.tileId];
  if (!def?.name) return instance.inscription?.trim() || instance.tileId;
  return engravedName(def.name, instance.engraved);
}

export function containerSlotGrid(availablePx: number): {
  columns: number;
  slotPx: number;
} {
  const dense =
    availablePx >= DENSE_COLUMNS * DENSE_MIN_SLOT_PX + (DENSE_COLUMNS - 1) * SLOT_GAP_PX;
  const columns = dense ? DENSE_COLUMNS : SPARSE_COLUMNS;
  const fit = Math.floor((availablePx - (columns - 1) * SLOT_GAP_PX) / columns);
  const slotPx = Math.max(DENSE_MIN_SLOT_PX, Math.min(MAX_SLOT_SIZE_PX, fit));
  return { columns, slotPx };
}

export function ContainerPanel({
  container,
  location,
  equipment,
  tiles,
  tilesets,
  title,
  onClose,
  drag,
  masteryXp = {},
  statusDefs,
  statuses,
  className = "",
}: {
  container: ContainerView;
  location: ContainerRef;
  equipment: Equipment;
  tiles: TileDef[];
  tilesets: TilesetDef[];
  title: string;
  onClose: () => void;
  drag: ItemDrag;
  masteryXp?: MasteryXp;
  statusDefs?: Record<string, StatusDef>;
  statuses?: readonly HeldStatus[];
  className?: string;
}) {
  const tilesById = useMemo(() => tilesByIdFromList(tiles), [tiles]);

  /**
   * State rather than a ref, so the observer follows the grid when a minimised
   * window unmounts it and an expanded one mounts a new one.
   */
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const [widthPx, setWidthPx] = useState(0);

  useEffect(() => {
    if (!row) return;
    const observer = new ResizeObserver(() => setWidthPx(row.clientWidth));
    observer.observe(row);
    setWidthPx(row.clientWidth);
    return () => observer.disconnect();
  }, [row]);

  const { columns, slotPx } = containerSlotGrid(widthPx);
  const captioned = useCoarsePointer();

  const def = tilesById[container.tileId];
  const { size, contents } = container;

  /**
   * A depot shares its stash with every placement of its tag, and a smaller
   * one can be holding more than it has slots for: show it all, so what is
   * over can still be taken out.
   */
  const slots: Array<ItemInstance | null> = Array.from(
    { length: Math.max(size, contents.length) },
    (_, i) => contents[i] ?? null,
  );

  return (
    <HudWindow
      label={title}
      title={title}
      icon={
        def ? (
          <TilePreview
            tile={def}
            tilesets={tilesets}
            size={TITLE_SPRITE_SIZE_PX}
            direction={FRONT}
            still
            chrome={false}
            background={null}
          />
        ) : null
      }
      meta={
        <span>
          {contents.length}/{size}
        </span>
      }
      onClose={onClose}
      className={className}
    >
      <div
        ref={setRow}
        className="grid"
        style={{
          columnGap: SLOT_GAP_PX,
          rowGap: captioned ? SLOT_ROW_GAP_PX : SLOT_GAP_PX,
          gridTemplateColumns: `repeat(${columns}, ${slotPx}px)`,
          justifyContent: "start",
        }}
      >
        {slots.map((instance, i) => (
          <div key={i} className="flex flex-col gap-0.5">
            <ItemSlot
              slot={slotIn(location, i)}
              instance={instance}
              equipment={equipment}
              tilesById={tilesById}
              tilesets={tilesets}
              label={`${title}, slot ${i + 1}`}
              emptyHint="Empty"
              drag={drag}
              masteryXp={masteryXp}
              statusDefs={statusDefs}
              statuses={statuses}
              sizePx={slotPx}
            />
            {captioned ? (
              <span
                aria-hidden="true"
                className="block h-4 truncate text-detail leading-4 text-paper/60"
              >
                {slotCaptionFor(instance, tilesById)}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </HudWindow>
  );
}
