import { IconX } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Equipment } from "../game/equipment";
import { slotIn, type ContainerRef } from "../game/itemMoves";
import { engravedName } from "../lib/engraving";
import { resolveContainer } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import type { MasteryXp } from "../lib/mastery";
import type { StatusDef } from "../lib/status";
import type { TileDef, TilesetDef } from "../lib/types";
import { useCoarsePointer } from "../lib/useMediaQuery";
import { tilesByIdFromList } from "../lib/validation";
import { ItemSlot } from "./ItemSlot";
import { TilePreview } from "./TilePreview";
import type { ItemDrag } from "./useItemDrag";

const FRONT = "s" as const;

const CLOSE_ICON_SIZE_PX = 12;

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
  className = "",
}: {
  container: ItemInstance;
  location: ContainerRef;
  equipment: Equipment;
  tiles: TileDef[];
  tilesets: TilesetDef[];
  title: string;
  onClose: () => void;
  drag: ItemDrag;
  masteryXp?: MasteryXp;
  statusDefs?: Record<string, StatusDef>;
  className?: string;
}) {
  const tilesById = useMemo(() => tilesByIdFromList(tiles), [tiles]);

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
  const captioned = useCoarsePointer();

  const def = tilesById[container.tileId];
  const size = def ? (resolveContainer(def)?.size ?? 0) : 0;
  const contents = container.contents ?? [];

  const slots: Array<ItemInstance | null> = Array.from(
    { length: size },
    (_, i) => contents[i] ?? null,
  );

  return (
    <section
      className={["flex flex-col gap-1 border-2 border-paper/25 bg-paper/5 p-1.5", className]
        .filter(Boolean)
        .join(" ")}
      aria-label={title}
    >
      <div className="flex items-center gap-1.5">
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
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${title}`}
          className="ml-auto grid h-5 w-5 shrink-0 place-items-center border-2 border-paper/40 text-paper/70 hover:border-paper hover:text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <IconX size={CLOSE_ICON_SIZE_PX} stroke={3} aria-hidden="true" />
        </button>
      </div>

      <div
        ref={rowRef}
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
              sizePx={slotPx}
            />
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
