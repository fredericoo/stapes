import * as v from "valibot";
import type { TileDef } from "./types";

/**
 * What it takes to be carried.
 *
 * Authored on the tile def beside the other interaction blocks, and parsed
 * rather than trusted on exactly the terms `battler` and `push` are: a malformed
 * block reads as "not an item", never as a crashed world.
 *
 * ## An item is a tile
 *
 * A sword on the floor is a placement like any other — it has sprites, gravity
 * can drop it, a crate can be shoved onto it — and picking it up lifts that
 * placement off the board rather than translating it into some other model of a
 * thing. That is what keeps this module small: there is no item registry, no
 * second art pipeline, and nothing here knows what a map is.
 *
 * ## Def versus instance
 *
 * What is here is what every copy of a tile *shares*: a sword's `atk`, a bag's
 * `size`. What one particular copy carries — its identity, its description, what
 * is inside it — is an `ItemInstance`, and lives on the placement rather than on
 * the def. Two `rusty-sword` placements share this block and are still two
 * distinct swords.
 */

/**
 * Which skill a weapon answers to.
 *
 * `magic` is authorable and does nothing yet. It is a slot in the model on
 * purpose: the enum is written into `data/tiles.json` the moment anybody saves a
 * weapon, and widening it later is a file migration where leaving room now is
 * free.
 */
export type ItemMastery = "blade" | "ranged" | "blunt" | "magic";

export const ITEM_MASTERIES: ItemMastery[] = [
  "blade",
  "ranged",
  "blunt",
  "magic",
];

/**
 * Every number on a weapon is added to the wielder's own, and may be negative.
 *
 * **Zero is no effect**, which makes a weapon's block read as a list of what it
 * changes rather than as four settings that all mean something. A blade that is
 * slower and less accurate than bare hands says exactly that, in the units the
 * fight is fought in.
 *
 * This replaced a single `weight` that was spent against speed at full rate and
 * accuracy at half. One number encoding two effects meant an author who wanted a
 * fast inaccurate weapon could not have one, and the ratio between the two costs
 * was a balance decision buried in arithmetic. Two numbers say it outright, and
 * they can go up: a rapier that makes you *faster* is now authorable, where
 * "negative weight" would have been a nonsense nobody could read.
 */
export type WeaponItem = {
  type: "weapon";
  /** Added to the wielder's base atk. */
  atk: number;
  /** Added to the wielder's base def. */
  def: number;
  /** Added to the wielder's accuracy. Negative makes it harder to land. */
  acc: number;
  /** Added to the wielder's speed. Negative makes it slower to swing. */
  spd: number;
  mastery: ItemMastery;
};

/**
 * Something used up in one go, and what using it does.
 *
 * The scope is deliberately narrow: a consumable changes the eater's hit
 * points, and that is all it does. Signed for the reason a weapon's `spd` is —
 * a poison apple is the same mechanism as a cherry with the number pointing the
 * other way, and two blocks for the two directions would be one block with a
 * flag hidden in its name.
 */
export type ConsumableItem = {
  type: "consumable";
  /**
   * The verb doing it is called by — "Eat", "Drink", "Read".
   *
   * A consumable's verb belongs to the tile on exactly the terms a switch's
   * {@link SwitchInteraction.actionName} does: nothing derivable from the def
   * says whether this is drunk or eaten, and only the author knows. Optional on
   * the same grounds too — blank falls back to {@link CONSUME_FALLBACK_VERB}
   * wherever the action is offered.
   */
  label?: string;
  /** Added to the eater's hit points. Negative poisons; the cap still holds. */
  hp: number;
};

/**
 * Something that holds other things.
 *
 * "Container" rather than "bag" because a corpse is one too: a body with a slot
 * or two in it is the same mechanism as a backpack with four, and the only
 * difference between them is {@link ContainerItem.equippable}. Naming the
 * general case costs nothing here and saves renaming the wire, the panels and
 * the authored file later.
 *
 * **Containers do not nest.** Not "no nested backpacks" — no container may hold
 * a container at all, so depth is exactly one everywhere. That is what lets
 * contents be a flat list rather than a tree and every capacity check be a
 * single comparison. The rule is enforced where items move, not here.
 */
export type ContainerItem = {
  type: "container";
  /** How many instances fit inside it. */
  size: number;
  /**
   * Whether it can go in the bag slot. A backpack can; a chest or a corpse is a
   * container you open where it lies.
   */
  equippable: boolean;
};

/**
 * A discriminated union rather than a flat block of optional fields, so a weapon
 * cannot have a size and a container cannot have a mastery. The editor picks the
 * arm and the schema refuses anything else.
 */
export type ItemDef = WeaponItem | ConsumableItem | ContainerItem;

export type ItemType = ItemDef["type"];

export const ITEM_TYPES: ItemType[] = ["weapon", "consumable", "container"];

/**
 * Furthest a weapon may push a percent stat, in either direction.
 *
 * Bounded because `acc` and `spd` are spent against 0–100 stats, and a weapon
 * that moves one further than the whole range is not a stronger weapon — it is
 * the same weapon as one at the cap, wearing a number that reads as if it did
 * something.
 */
export const MAX_WEAPON_STAT_SHIFT = 100;

/** Widest a container may be, so a contents grid stays a grid. */
export const MAX_CONTAINER_SIZE = 12;

/**
 * Furthest a consumable may move hit points, in either direction.
 *
 * Hit points have no authored ceiling the way percent stats do, so this is a
 * sanity bound rather than a balance one: wider than any body's health needs to
 * be, and narrow enough that a typo'd extra digit reads as malformed instead of
 * as an instant-kill nobody meant to write.
 */
export const MAX_CONSUMABLE_HP_SHIFT = 999;

/**
 * What doing it is called when the author left {@link ConsumableItem.label}
 * blank. Honest about knowing nothing: "Use" claims neither eating nor
 * drinking, only that the thing is spent.
 */
export const CONSUME_FALLBACK_VERB = "Use";

/** The authored verb, or the fallback where there is none to read. */
export function consumeVerb(consumable: ConsumableItem): string {
  return consumable.label?.trim() || CONSUME_FALLBACK_VERB;
}

export const DEFAULT_WEAPON: WeaponItem = {
  type: "weapon",
  atk: 3,
  def: 0,
  // A little slower to swing than bare hands, and no harder to aim. Something
  // rather than nothing, so a fresh weapon demonstrates that these can be
  // negative — but small, since a default is a starting point and not a design.
  acc: 0,
  spd: -5,
  mastery: "blade",
};

export const DEFAULT_CONSUMABLE: ConsumableItem = {
  type: "consumable",
  // The commonest verb, not a guess at the tile: an author who wants "Drink"
  // is one word away, and a default of the fallback "Use" would make the field
  // look optional-in-spirit rather than worth writing.
  label: "Eat",
  // Positive and small, so a fresh consumable demonstrates the ordinary case —
  // food — and poisoning is the deliberate act of flipping the sign.
  hp: 5,
};

/** The starting backpack's shape, and what a fresh container tile gets. */
export const DEFAULT_CONTAINER: ContainerItem = {
  type: "container",
  size: 4,
  equippable: true,
};

const weaponSchema = v.object({
  type: v.literal("weapon"),
  atk: v.pipe(v.number(), v.integer(), v.minValue(0)),
  def: v.pipe(v.number(), v.integer(), v.minValue(0)),
  // Signed, unlike atk and def: a weapon may make you worse at swinging it, and
  // that is most of what tells two weapons apart.
  acc: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(-MAX_WEAPON_STAT_SHIFT),
    v.maxValue(MAX_WEAPON_STAT_SHIFT),
  ),
  spd: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(-MAX_WEAPON_STAT_SHIFT),
    v.maxValue(MAX_WEAPON_STAT_SHIFT),
  ),
  mastery: v.picklist(ITEM_MASTERIES),
});

const consumableSchema = v.object({
  type: v.literal("consumable"),
  // Optional on the same grounds as a switch's actionName: a consumable with
  // no verb written on it is still a consumable, and whoever offers the action
  // falls back to the generic verb.
  label: v.optional(v.string()),
  // Signed, unlike a battler's own numbers: harming is authored with the same
  // field healing is.
  hp: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(-MAX_CONSUMABLE_HP_SHIFT),
    v.maxValue(MAX_CONSUMABLE_HP_SHIFT),
  ),
});

const containerSchema = v.object({
  type: v.literal("container"),
  // At least one, because a container nothing fits in is not a container
  // anybody meant to author — it would read as a prop that opens onto nothing.
  size: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(MAX_CONTAINER_SIZE),
  ),
  equippable: v.boolean(),
});

const itemSchema = v.variant("type", [
  weaponSchema,
  consumableSchema,
  containerSchema,
]);

const itemCache = new WeakMap<TileDef, ItemDef | null>();

/**
 * Parsed item config for a tile def, or null when it is not one.
 *
 * **Gated on the kind**, unlike the other resolvers, and that gate is the point
 * of {@link TileKind} being a stored field: a tile whose kind is not `item` has
 * no item block as far as anything here is concerned, however much of one is
 * sitting in the file. Otherwise the select in the editor and the truth in the
 * data could disagree, and the data would win silently.
 *
 * Memoised on def identity like every other resolver: this is asked once per
 * reachable cell per frame by whatever offers a pick-up.
 */
export function resolveItem(def: TileDef): ItemDef | null {
  const cached = itemCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.kind === "item" ? def.interactions?.item : undefined;
  const parsed = raw == null ? null : v.safeParse(itemSchema, raw);
  const item = parsed?.success ? (parsed.output as ItemDef) : null;
  itemCache.set(def, item);
  return item;
}

/** Whether this tile can be carried at all. */
export function isItem(def: TileDef): boolean {
  return resolveItem(def) !== null;
}

/** Parsed container config, or null when this tile is not one. */
export function resolveContainer(def: TileDef): ContainerItem | null {
  const item = resolveItem(def);
  return item?.type === "container" ? item : null;
}

/** Parsed weapon config, or null when this tile is not one. */
export function resolveWeapon(def: TileDef): WeaponItem | null {
  const item = resolveItem(def);
  return item?.type === "weapon" ? item : null;
}

/** Parsed consumable config, or null when this tile is not one. */
export function resolveConsumable(def: TileDef): ConsumableItem | null {
  const item = resolveItem(def);
  return item?.type === "consumable" ? item : null;
}

/**
 * Persist an item block, field by field.
 *
 * Rebuilt rather than passed through for the reason the battler block is: the
 * editor draft carries whatever the last arm of the union left behind — switch a
 * weapon to a container and back and its `size` is still in the object — and
 * naming the fields here is what stops that reaching the file. Living in this
 * module rather than in `./interactions` keeps knowledge of the union's arms in
 * the one place that defines them.
 */
export function itemForSave(item: ItemDef | undefined): ItemDef | undefined {
  if (!item) return undefined;
  if (item.type === "weapon") {
    return {
      type: "weapon",
      atk: item.atk,
      def: item.def,
      acc: item.acc,
      spd: item.spd,
      mastery: item.mastery,
    };
  }
  if (item.type === "consumable") {
    // A blank verb is dropped rather than written as `""`, exactly as a
    // switch's actionName is: an empty string that means "no name" is a second
    // way of saying what an absent key already says.
    const label = item.label?.trim();
    return {
      type: "consumable",
      ...(label ? { label } : {}),
      hp: item.hp,
    };
  }
  return {
    type: "container",
    size: item.size,
    equippable: item.equippable,
  };
}
