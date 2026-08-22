import { IconBackpack, IconHandStop, IconShirt } from "@tabler/icons-react";
import { useMemo, type ReactNode } from "react";
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
 * Four slots, and the panel says exactly what the game has: what you swing,
 * what you hold, what you are wearing, what you carry it all in — the order
 * `EQUIP_SLOTS` is written in, because that is the order a person would say it.
 * A panel pretending to more squares than exist would be describing a game
 * nobody can play yet, which is why this one grew only when the body square
 * did.
 *
 * **Each square is captioned and each empty one is pictured**, which the bag's
 * grid deliberately is not. A slot inside a bag is a square — anything goes in
 * it and there is nothing to say — where these are each *for* something,
 * and a panel of identical dashed squares is one you have to be taught
 * rather than one you can read. The caption is the short name (`Main`,
 * `Offhand`, `Body`, `Back`) rather than the accessible one, which stays the
 * longer phrase a screen reader wants.
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
      <div className="flex flex-wrap gap-1">
        <CaptionedSlot caption="Main">
          <ItemSlot
            slot={{ kind: "weapon" }}
            instance={equipment.weapon}
            tilesById={tilesById}
            tilesets={tilesets}
            label="Weapon"
            emptyHint="Weapon — nothing in hand"
            emptyIcon={MainHandIcon}
            open={handOpen === "weapon"}
            drag={drag}
            inspecting={inspecting}
            masteryXp={masteryXp}
          />
        </CaptionedSlot>
        <CaptionedSlot caption="Offhand">
          <ItemSlot
            slot={{ kind: "offhand" }}
            instance={equipment.offhand}
            tilesById={tilesById}
            tilesets={tilesets}
            label="Off hand"
            emptyHint="Off hand — nothing held"
            emptyIcon={OffHandIcon}
            open={handOpen === "offhand"}
            drag={drag}
            inspecting={inspecting}
            masteryXp={masteryXp}
          />
        </CaptionedSlot>
        <CaptionedSlot caption="Body">
          <ItemSlot
            slot={{ kind: "armor" }}
            instance={equipment.armor}
            tilesById={tilesById}
            tilesets={tilesets}
            label="Armour"
            emptyHint="Armour — nothing worn"
            emptyIcon={IconShirt}
            drag={drag}
            inspecting={inspecting}
            masteryXp={masteryXp}
          />
        </CaptionedSlot>
        <CaptionedSlot caption="Back">
          <ItemSlot
            slot={{ kind: "bag" }}
            instance={equipment.bag}
            tilesById={tilesById}
            tilesets={tilesets}
            label="Bag"
            emptyHint="Bag — nothing on your back"
            emptyIcon={IconBackpack}
            open={bagOpen}
            drag={drag}
            inspecting={inspecting}
            masteryXp={masteryXp}
          />
        </CaptionedSlot>
      </div>
    </section>
  );
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

/**
 * One equipment square with its name over it.
 *
 * `aria-hidden`, because the square underneath already says what it is — a
 * screen reader that heard "Main" and then "Weapon: empty" would be hearing the
 * same fact twice, in two vocabularies.
 */
function CaptionedSlot({
  caption,
  children,
}: {
  caption: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span
        aria-hidden
        className="text-[9px] font-bold uppercase leading-none tracking-wide text-paper/40"
      >
        {caption}
      </span>
      {children}
    </div>
  );
}
