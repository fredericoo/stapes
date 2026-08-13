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

export type WeaponItem = {
  type: "weapon";
  /** Added to the wielder's base atk. */
  atk: number;
  /** Added to the wielder's base def. */
  def: number;
  /**
   * What carrying it costs. Spends speed at full rate and accuracy at half —
   * see `../game/equipment`, which owns the arithmetic.
   */
  weight: number;
  mastery: ItemMastery;
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
export type ItemDef = WeaponItem | ContainerItem;

export type ItemType = ItemDef["type"];

export const ITEM_TYPES: ItemType[] = ["weapon", "container"];

/**
 * Heaviest a weapon may be.
 *
 * Bounded because weight is spent against the 0–100 stats, and a weapon heavier
 * than the whole range is not a heavier weapon — it is the same weapon as one at
 * the cap, with a number that reads as if it did something.
 */
export const MAX_ITEM_WEIGHT = 100;

/** Widest a container may be, so a contents grid stays a grid. */
export const MAX_CONTAINER_SIZE = 12;

export const DEFAULT_WEAPON: WeaponItem = {
  type: "weapon",
  atk: 3,
  def: 0,
  weight: 10,
  mastery: "blade",
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
  weight: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(MAX_ITEM_WEIGHT),
  ),
  mastery: v.picklist(ITEM_MASTERIES),
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

const itemSchema = v.variant("type", [weaponSchema, containerSchema]);

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
      weight: item.weight,
      mastery: item.mastery,
    };
  }
  return {
    type: "container",
    size: item.size,
    equippable: item.equippable,
  };
}
