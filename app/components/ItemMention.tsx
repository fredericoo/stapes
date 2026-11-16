import { createContext, useContext, useMemo, useState } from "react";
import { itemCard } from "../game/itemCard";
import type { MasteryXp } from "../lib/mastery";
import type { StatusDef } from "../lib/status";
import type { TileDef, TilesetDef } from "../lib/types";
import { useDwell } from "../lib/useDwell";
import { useCoarsePointer } from "../lib/useMediaQuery";
import { Tooltip } from "../ui";
import { ItemCard } from "./ItemCard";
import { TilePreview } from "./TilePreview";
import { swallowSynthesisedClick } from "./useTap";

export type ItemCatalogue = {
  tilesById: Record<string, TileDef>;
  tilesets: TilesetDef[];
  masteryXp: MasteryXp;
  statusDefs: Record<string, StatusDef>;
};

const NO_CATALOGUE: ItemCatalogue = { tilesById: {}, tilesets: [], masteryXp: {}, statusDefs: {} };

export const ItemCatalogueContext = createContext<ItemCatalogue>(NO_CATALOGUE);

const FINE_ICON_PX = 20;
const COARSE_ICON_PX = 16;

/**
 * An item named in running text: its icon and name, and its card on hover,
 * focus or a held touch. `focusable` is off inside a button, which cannot
 * hold a second tab stop.
 */
export function ItemMention({
  tileId,
  count,
  focusable = true,
}: {
  tileId: string;
  count?: number;
  focusable?: boolean;
}) {
  const { tilesById, tilesets, masteryXp, statusDefs } = useContext(ItemCatalogueContext);
  const def = tilesById[tileId];
  const coarse = useCoarsePointer();
  const { dwelling, handlers } = useDwell(coarse);
  const [pointedAt, setPointedAt] = useState(false);
  const card = useMemo(
    () => (def ? itemCard(def, null, masteryXp, statusDefs) : null),
    [def, masteryXp, statusDefs],
  );
  const amount = count === undefined ? "" : `x${count} `;

  if (!def || !card) {
    return (
      <span>
        {amount}
        {def?.name ?? tileId}
      </span>
    );
  }

  return (
    <Tooltip
      content={<ItemCard card={card} tile={def} tilesets={tilesets} />}
      side="top"
      open={dwelling || pointedAt}
      className="pointer-events-none"
    >
      <span
        {...handlers}
        /**
         * A touch held long enough to show the card is not also a press of the
         * button the mention sits in.
         */
        onPointerUp={(event) => {
          if (dwelling) {
            event.stopPropagation();
            swallowSynthesisedClick();
          }
          handlers.onPointerUp();
        }}
        onPointerEnter={() => setPointedAt(true)}
        onPointerLeave={() => {
          setPointedAt(false);
          handlers.onPointerLeave();
        }}
        tabIndex={focusable ? 0 : undefined}
        onFocus={() => setPointedAt(true)}
        onBlur={() => setPointedAt(false)}
        className="talk-item"
      >
        {amount}
        <TilePreview
          tile={def}
          tilesets={tilesets}
          size={coarse ? COARSE_ICON_PX : FINE_ICON_PX}
          still
          chrome={false}
          background={null}
          className="talk-item__icon"
        />
        <span className="talk-item__name">{def.name}</span>
      </span>
    </Tooltip>
  );
}
