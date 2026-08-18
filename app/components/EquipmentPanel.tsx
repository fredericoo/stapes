import { useMemo } from "react";
import type { Equipment } from "../game/equipment";
import type { MasteryXp } from "../lib/mastery";
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
 * Three slots is a thin panel, and that is the honest state of the game rather
 * than a placeholder: armour is out of scope, and a panel pretending to more
 * slots than exist would be describing a game nobody can play yet.
 *
 * The off hand sits between them because that is the order they are reached for:
 * what you swing, what you hold, what you carry it all in.
 *
 * **Nothing in here is a number.** There was a table under the hand for a while
 * listing every mastery the weapon in it asked for against the one you had, and
 * it is gone: what a weapon asks is now a sentence you get by looking at it, on
 * exactly the terms a sword on the floor tells you — see `../lib/weaponFeel`.
 * What a weapon is *worth* has always been absent, and for the reason that
 * decided the rest: this game is played by picking things up and finding out,
 * and a panel that ranked your weapons would be answering the only question the
 * fighting has to offer. What you are good at is not here either — it moved to
 * its own panel, since it answers a different question and does not change when
 * you move an item. See `./StatsPanel`.
 */
export function EquipmentPanel({
  equipment,
  masteryXp = {},
  bagOpen,
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
      <div className="flex flex-wrap gap-1">
        <ItemSlot
          slot={{ kind: "weapon" }}
          instance={equipment.weapon}
          tilesById={tilesById}
          tilesets={tilesets}
          label="Weapon"
          emptyHint="Weapon — nothing in hand"
          drag={drag}
          inspecting={inspecting}
          masteryXp={masteryXp}
        />
        <ItemSlot
          slot={{ kind: "offhand" }}
          instance={equipment.offhand}
          tilesById={tilesById}
          tilesets={tilesets}
          label="Off hand"
          emptyHint="Off hand — nothing held"
          drag={drag}
          inspecting={inspecting}
          masteryXp={masteryXp}
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
          inspecting={inspecting}
          masteryXp={masteryXp}
        />
      </div>
    </section>
  );
}
