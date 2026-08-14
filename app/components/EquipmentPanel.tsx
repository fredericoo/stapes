import { useMemo } from "react";
import type { Equipment } from "../game/equipment";
import type { TileDef, TilesetDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { ItemSlot } from "./ItemSlot";
import type { ItemDrag } from "./useItemDrag";

/**
 * What you are wearing: what is in your hand, and what is on your back.
 *
 * The bag was deliberately *not* here for a while — it had its own opener in the
 * action strip, and burying the most-used slot behind the least-used panel would
 * have been backwards. What changed is that a bag became something you take
 * *off*: dragging a thing out of its slot is how everything else is removed, and
 * a bag that needed its own gesture would be the one exception. So it is a slot,
 * beside the hand, and the strip button went back to being only an opener.
 *
 * Two slots is a thin panel, and that is the honest state of the game rather
 * than a placeholder: armour is out of scope, and a panel pretending to more
 * slots than exist would be describing a game nobody can play yet.
 */
export function EquipmentPanel({
  equipment,
  bagOpen,
  tiles,
  tilesets,
  drag,
  className = "",
}: {
  equipment: Equipment;
  /**
   * Whether the panel showing the inside of that bag is on screen.
   *
   * Here because tapping the bag slot is what opens it, and a slot that opened
   * something without ever saying so would be a control with an invisible
   * effect — the panel it opens is somewhere else on the page, and on a phone it
   * has replaced this one entirely.
   */
  bagOpen: boolean;
  tiles: TileDef[];
  tilesets: TilesetDef[];
  /** The one move in progress, page-wide. See `./useItemDrag`. */
  drag: ItemDrag;
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
      <div className="flex flex-wrap gap-1">
        <ItemSlot
          slot={{ kind: "weapon" }}
          instance={equipment.weapon}
          tilesById={tilesById}
          tilesets={tilesets}
          label="Weapon"
          emptyHint="Weapon — nothing in hand"
          drag={drag}
        />
        <ItemSlot
          slot={{ kind: "bag" }}
          instance={equipment.bag}
          tilesById={tilesById}
          tilesets={tilesets}
          label="Bag"
          emptyHint="Bag — nothing on your back"
          open={bagOpen}
          drag={drag}
        />
      </div>
    </section>
  );
}
