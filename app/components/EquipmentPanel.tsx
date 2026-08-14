import { useMemo } from "react";
import type { Equipment } from "../game/equipment";
import type { TileDef, TilesetDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { ItemSlot } from "./ItemSlot";
import type { ItemDrag } from "./useItemDrag";

/**
 * What you are wearing.
 *
 * The bag is deliberately not here. It has its own panel and its own opener in
 * the action strip, drawn as the literal tile of the bag on your back — a
 * backpack is the thing you reach for constantly and the thing you drag onto the
 * floor, and burying it a panel deep would put the most-used slot behind the
 * least-used one.
 *
 * So this is the weapon slot and, in time, whatever else is worn rather than
 * carried. One slot is a thin panel, and that is the honest state of the game
 * rather than a placeholder: armour is out of scope, and a panel pretending to
 * more slots than exist would be describing a game nobody can play yet.
 */
export function EquipmentPanel({
  equipment,
  tiles,
  tilesets,
  drag,
  className = "",
}: {
  equipment: Equipment;
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
      </div>
    </section>
  );
}
