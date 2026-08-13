import { IconShirt } from "@tabler/icons-react";
import type { ItemInstance } from "../lib/itemInstance";
import type { TileDef, TilesetDef } from "../lib/types";
import { Tooltip } from "../ui/Tooltip";
import { MODE_TOGGLE_SIZE_CLASS, type ModeToggleSize } from "./ModeToggle";
import { TilePreview } from "./TilePreview";

/**
 * The buttons that open what you are carrying.
 *
 * Drawn in the same row and at the same size as the mode toggles, and
 * deliberately *not* coloured like them. A mode toggle wears the colour of the
 * outline it puts in the world, which is a promise these cannot keep: opening a
 * panel changes nothing out there. So on is plain paper — clearly a state, and
 * clearly not one of the two modes.
 */

/** Which sprite stands for a tile on a button — the one facing the reader. */
const FRONT: "s" = "s";

const BAG_SPRITE_SIZE_PX: Record<ModeToggleSize, number> = {
  touch: 34,
  compact: 24,
};

function toggleClass(on: boolean, size: ModeToggleSize): string {
  return [
    "flex shrink-0 items-center justify-center border-2 shadow-hard",
    MODE_TOGGLE_SIZE_CLASS[size],
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
    on
      ? "border-paper bg-paper text-ink"
      : "border-paper/40 bg-transparent text-paper",
  ].join(" ");
}

/** Show or hide what you are wearing. */
export function EquipmentToggle({
  open,
  onChange,
  size = "touch",
}: {
  open: boolean;
  onChange: (open: boolean) => void;
  size?: ModeToggleSize;
}) {
  return (
    <Tooltip content="Equipment">
      <button
        type="button"
        aria-pressed={open}
        aria-label="Equipment"
        onClick={() => onChange(!open)}
        className={toggleClass(open, size)}
      >
        <IconShirt
          size={size === "touch" ? 24 : 18}
          stroke={2}
          aria-hidden="true"
        />
      </button>
    </Tooltip>
  );
}

/**
 * Open the bag on your back, drawn as the bag on your back.
 *
 * The icon is the literal tile rather than a generic rucksack glyph, which is
 * the one place in this UI where that is worth the trouble: bags differ from
 * each other, the difference is the whole reason to swap one, and a button that
 * looked the same whichever you were wearing would hide the only fact about it
 * you can see at a glance.
 *
 * Rendered disabled with no sprite when there is no bag. Absent would be
 * tidier and would also make the row jump by a button's width the moment
 * somebody drops their pack, in a strip whose other buttons a thumb has learned
 * the position of.
 */
export function BagButton({
  bag,
  open,
  onChange,
  tilesById,
  tilesets,
  size = "touch",
}: {
  bag: ItemInstance | null;
  open: boolean;
  onChange: (open: boolean) => void;
  tilesById: Record<string, TileDef>;
  tilesets: TilesetDef[];
  size?: ModeToggleSize;
}) {
  const tile = bag ? (tilesById[bag.tileId] ?? null) : null;
  const name = tile?.name ?? "Bag";

  return (
    <Tooltip content={bag ? name : "No bag"}>
      <button
        type="button"
        aria-pressed={open}
        aria-label={bag ? name : "No bag"}
        disabled={!bag}
        onClick={() => onChange(!open)}
        className={[
          toggleClass(open, size),
          bag ? "" : "opacity-40",
        ].join(" ")}
      >
        {tile ? (
          <TilePreview
            tile={tile}
            tilesets={tilesets}
            size={BAG_SPRITE_SIZE_PX[size]}
            direction={FRONT}
            still
            chrome={false}
            background={null}
          />
        ) : null}
      </button>
    </Tooltip>
  );
}
