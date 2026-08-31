import * as v from "valibot";
import { ARMOR_SLOTS, MAX_CONTAINER_SIZE } from "./item";

/**
 * What a body is born carrying.
 *
 * Authored on the battler block beside the masteries and the natural weapon,
 * because that is where the rest of "what this body *is*" already lives — and
 * because being a battler is the one thing the player and a rat have in common.
 * A kit on the `player` tile is what puts a backpack on somebody's back the
 * first time they join; a kit on `rat` is what a rat is worth killing for. One
 * mechanism, no special case for people.
 *
 * ## The shape is the slots, not a loot table
 *
 * Every entry names an {@link EquipSlot} — the same squares a player drags
 * things between — rather than a bag of drops with no home. That is what
 * makes a creature's kit *work* rather than merely fall out of it: a wolf
 * authored with a torch in its off hand lights the wood it is standing in, and
 * one authored with a sword swings it, because the simulation reads a body's
 * equipment for both and has no idea a wolf is not a person.
 *
 * ## Chance is per entry, and rolled once
 *
 * Independent per entry, in percent, floats allowed — a quarter of a percent is
 * the shape a rare drop wants and a whole-number scale cannot say. Several
 * entries may name one slot, which is how a weighted table is written: they are
 * rolled in order and the first success takes the square, so putting the rare
 * blade above the rusty one is the whole of "prefer the good roll".
 *
 * **Every entry is drawn for, every time, whatever has already landed.** A draw
 * skipped because a slot was taken would make one creature's kit change what
 * every creature after it rolled, which is the same reason a swing always costs
 * three draws and a decay lifetime always costs one.
 */

/**
 * The squares on a body, in the order they are reached for.
 *
 * Here rather than beside `Equipment` in `../game/equipment` because `lib` may
 * not reach into `game`, and an authored file has to name a slot. The runtime
 * shape is checked against this list rather than the other way round — see
 * `EQUIPMENT_SLOTS` there, which is this list, and the guard beside it that
 * makes a slot added to one and not the other a type error.
 *
 * The order is roughly head to toe, with the hands where the hands are: what is
 * on your head, what you swing, what you hold, what you are wearing, what is
 * round your neck, what is on your feet, what you carry it all in. It is also
 * the order a kit is rolled in and the order a death puts things on the floor,
 * and neither of those cares — which is why it may as well read the way a
 * person would say it.
 *
 * **Four of these seven are armour squares**, and which four is `./item`'s
 * {@link ARMOR_SLOTS} rather than a second list here — see the guard below.
 */
export const EQUIP_SLOTS = [
  "head",
  "weapon",
  "offhand",
  "armor",
  "charm",
  "footwear",
  "bag",
] as const;

/** Which square a thing is worn in. */
export type EquipSlot = (typeof EQUIP_SLOTS)[number];

/**
 * An armour square that is not a square on a body would be a piece of armour
 * nothing can wear: `slotTakes` would accept it into a slot the runtime shape
 * has no field for. This is what makes that a type error here rather than a
 * `undefined` read somewhere in a fight.
 */
const _everyArmorSlotIsWorn: readonly EquipSlot[] = ARMOR_SLOTS;

/**
 * How the squares read to a person, rather than in code.
 *
 * Here beside the list itself, because two places in the editor name the same
 * squares — the kit table picks one for a row, the item tab picks one for a
 * piece of armour — and a square that was "Body" in one and "Armour" in the
 * other would be two names for one thing in a tool whose whole job is saying
 * where things go.
 *
 * Physical rather than mechanical: an author places things on a body, so the
 * words are parts of a body. The game's own panel captions nothing at all — see
 * `../components/EquipmentPanel`, where the arrangement says it instead.
 */
export const SLOT_LABELS: Record<EquipSlot, string> = {
  head: "Head",
  weapon: "Weapon hand",
  offhand: "Off hand",
  armor: "Body",
  charm: "Charm",
  footwear: "Feet",
  bag: "Back",
};

/** Percent, both ends included. Nothing is ever more certain than certain. */
export const MIN_KIT_CHANCE = 0;
export const MAX_KIT_CHANCE = 100;

/**
 * What a freshly added entry offers, before anybody has said otherwise.
 *
 * Certain, because the overwhelmingly common authoring is "this body has this"
 * — a player's backpack, a guard's sword — and a default of anything less would
 * make every one of those two edits instead of one.
 */
export const DEFAULT_KIT_CHANCE = MAX_KIT_CHANCE;

/**
 * One thing inside a container this body is born wearing.
 *
 * No slot of its own: a position inside a container is a position inside a
 * container, and which one it lands in is "the next free one" exactly as it is
 * for anything stashed in play. Rolled on its own chance, so a rat's pack can
 * be a certainty with a rare thing in it.
 *
 * Flat, and it stays flat: a container may not hold a container, so there is
 * nothing below this to nest. See `./item`.
 */
export type KitContent = {
  tileId: string;
  /** Percent. Floats allowed — see the module note. */
  chance: number;
};

/** One thing this body is born wearing, and how likely it is to be there. */
export type KitEntry = KitContent & {
  slot: EquipSlot;
  /**
   * What is inside it, when the tile is a container.
   *
   * Rolled whether or not the container itself landed, on the fixed-draw-count
   * rule the module note gives — what is rolled for a container that never
   * arrived is simply thrown away.
   */
  contents?: KitContent[];
};

/** Everything a body is born carrying, in the order it is rolled for. */
export type Kit = KitEntry[];

/**
 * Most entries one body may be authored with.
 *
 * Every slot plus what fits in the largest container there is, which is the
 * most a *rolled* kit could ever land, doubled so a weighted table has room to
 * offer alternatives for every square. A bound rather than a balance decision:
 * wide enough for anything worth authoring, narrow enough that a file with a
 * thousand entries in it reads as malformed.
 */
export const MAX_KIT_ENTRIES = (EQUIP_SLOTS.length + MAX_CONTAINER_SIZE) * 2;

const tileIdSchema = v.pipe(v.string(), v.trim(), v.minLength(1));

const chanceSchema = v.pipe(
  v.number(),
  v.finite(),
  v.minValue(MIN_KIT_CHANCE),
  v.maxValue(MAX_KIT_CHANCE),
);

const kitContentSchema = v.object({
  tileId: tileIdSchema,
  chance: chanceSchema,
});

const kitEntrySchema = v.object({
  slot: v.picklist(EQUIP_SLOTS),
  tileId: tileIdSchema,
  chance: chanceSchema,
  contents: v.optional(v.array(kitContentSchema)),
});

/**
 * A kit as it arrives from disk.
 *
 * **A malformed kit reads as no kit, not as a body that is not a battler.**
 * Wrapped in a fallback rather than left to fail the block it sits in, which is
 * the same rule one rung down: a typo'd chance on a wolf should cost the wolf
 * its drops, never turn it into scenery that cannot be fought. Nothing else in
 * the battler block can be recovered that way — a body with no masteries has no
 * numbers at all — which is why this is the only field that gets one.
 */
export const kitSchema = v.fallback(
  v.pipe(v.array(kitEntrySchema), v.maxLength(MAX_KIT_ENTRIES)),
  // A getter, so two tiles never share one mutable array.
  () => [],
);

/**
 * A kit on its way to `data/tiles.json`, or nothing when it is empty.
 *
 * Rebuilt entry by entry rather than passed through, on the terms the rest of
 * the battler block is rebuilt in `interactionsForSave`: a draft that has been
 * through the editor carries whatever the last shape left behind, and naming
 * the fields here is what stops a stray key reaching the file.
 *
 * An entry with no tile chosen is dropped rather than written blank — a row
 * somebody added and never filled in is not authoring, and `""` on disk would
 * be a second way of saying what an absent entry already says. An empty
 * contents list goes the same way, so a sword never carries `contents: []`.
 */
export function kitForSave(kit: Kit | undefined): Kit | undefined {
  const entries = (kit ?? []).flatMap((entry) => {
    const tileId = entry.tileId.trim();
    if (!tileId) return [];
    const contents = (entry.contents ?? []).flatMap((content) => {
      const contentTileId = content.tileId.trim();
      if (!contentTileId) return [];
      return [{ tileId: contentTileId, chance: content.chance }];
    });
    return [
      {
        slot: entry.slot,
        tileId,
        chance: entry.chance,
        ...(contents.length > 0 ? { contents } : {}),
      },
    ];
  });
  return entries.length > 0 ? entries : undefined;
}
