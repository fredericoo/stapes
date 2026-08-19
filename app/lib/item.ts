import * as v from "valibot";
import {
  type Masteries,
  MASTERIES,
  masteriesSchema,
  WEAPON_MASTERIES,
  type WeaponMastery,
} from "./mastery";
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
 * How a weapon fights, and which mastery decides how well it is used.
 *
 * **These numbers are the fight, not a bonus on top of one.** They used to be
 * signed deltas added to whatever the wielder's tile already said — a sword was
 * `+3 atk, -10 spd` on top of a body that had its own attack and speed. That
 * arrangement had no room for masteries: if a body already carries a full stat
 * block, a mastery can only be a second modifier on it, and the authored numbers
 * and the earned ones fight over the same ground.
 *
 * So the body stopped having them. A body has masteries and a *natural weapon*
 * — a bite, a claw, a pair of fists — and whatever it is holding replaces that
 * weapon rather than adjusting it. What the mastery does is scale the profile
 * written here, which is what lets a rat be fast and light while a snake is slow
 * and heavy: one Fist number could never have said that, because a higher one
 * would make the harder-hitting animal the faster one by construction.
 *
 * See `./battler` for the derivation and `plans/masteries.md` for the argument.
 */
export type WeaponItem = {
  type: "weapon";
  /**
   * The most one blow with this can do, before the defender's {@link def}.
   *
   * A ceiling rather than an average, on the terms `../game/combat` sets out —
   * {@link acc} decides how much of it a given swing is worth. Was `atk`, and
   * the rename is the whole change in one word: it is the weapon's damage now,
   * not an increment to somebody else's.
   */
  damage: number;
  /**
   * Flat reduction on every blow that lands on the wielder.
   *
   * The only source of defence in the game, and deliberately a thin one: armour
   * is where this belongs and armour has no slot yet. A parrying weapon is the
   * one honest way to author it in the meantime.
   */
  def: number;
  /**
   * This belongs in the *other* hand — a shield, a torch, a lantern.
   *
   * **Authored rather than derived, and that is the whole point.** The off hand
   * used to take anything that was not a container, which made every sword in
   * the game a second sword you could hold: dual wielding, arrived at by
   * accident, with no rule anywhere for what two weapons do. Nothing about a
   * tile says whether it is meant for that hand — a torch and a sword are both
   * weapons here, because defence and light both ride on this block — so the
   * author says it.
   *
   * The exact counterpart of {@link ContainerItem.equippable}: a container is
   * only a backpack if somebody said so, and a weapon is only off-hand kit if
   * somebody said so. Absent is the common case and means the main hand.
   *
   * It does not *exclude* the main hand. A shield in your fist is legal, just
   * not what the game offers you; what this decides is which slot a thing goes
   * to when it is equipped off the floor, and which slot will accept it at all.
   */
  offhand?: boolean;
  /**
   * 0–100. How reliably this finds its target.
   *
   * **Only that.** It used to answer three questions at once — whether a blow
   * landed, how true it was when it did, and how hard it was to dodge — which
   * made it by far the most load-bearing number on a weapon and left no way to
   * author a thing that lands often and hits unpredictably. Most melee weapons
   * should sit high here; how *risky* they are is {@link variance}.
   */
  accuracy: number;
  /**
   * 0–100. How much a connecting blow varies, as a share of {@link damage}.
   *
   * Zero is a weapon that always deals exactly its damage. A hundred is one that
   * might deal anything from nothing to everything. This is the risk dial, and
   * splitting it out of accuracy is what makes a heavy weapon expressible: a
   * greataxe finds its target as reliably as a sword and is far less predictable
   * about what it does when it gets there.
   *
   * The roll inside the band is triangular rather than flat — see
   * `../game/combat`'s `damageFraction` — so the middle is common and both ends
   * are rare whatever this is set to.
   */
  variance: number;
  /** 0–100. How often this can be swung. See `../game/combat`. */
  spd: number;
  mastery: WeaponMastery;
  /**
   * What this asks of whoever swings it, mastery by mastery.
   *
   * Absent means it asks nothing, which is not the same as asking zero of
   * everything — see `./mastery`'s `masteryRatio`. **The worst ratio decides**,
   * so a requirement on a mastery this weapon does not even train is a real gate
   * and not a footnote: a Double Axe asking Blunt 35 and Toughness 20 is held
   * back by whichever of the wielder's is further behind.
   *
   * Requirements on other masteries are deliberately allowed. Its Blunt is what
   * the axe *teaches*; its Toughness is what it takes to hold the thing up, and
   * you go and get that somewhere else.
   */
  requirements?: Masteries;
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
  /**
   * The noise using it makes — "crunch", "glug" — called out by whoever used
   * it, where they used it.
   *
   * Text rather than a file, because there is no audio in this game: a sound
   * here is the comic-book kind, drawn over the eater's head on exactly the
   * path a spoken line takes. That is also why it is authored per tile and not
   * derived from the verb — "Eat" is what the button says to the player, and
   * "crunch" is what the room hears.
   *
   * Optional like {@link label}. Blank is silent, and silence is the honest
   * default: a potion that says nothing is a potion nobody heard.
   */
  sound?: string;
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
 * Both ends of the 0–100 stats, named so the editor and the schema agree.
 *
 * Here rather than on the battler, which is where they used to live: a body no
 * longer has percent stats of its own — it has masteries — so a weapon's `acc`
 * and `spd` are now the only authored numbers on this scale.
 */
export const MIN_PERCENT_STAT = 0;
export const MAX_PERCENT_STAT = 100;

/**
 * Ceiling on a weapon's damage.
 *
 * A sanity bound rather than a balance one, on the terms
 * {@link MAX_CONSUMABLE_HP_SHIFT} is: wide enough for anything worth authoring,
 * narrow enough that a typo'd extra digit reads as malformed rather than as a
 * weapon that deletes whatever it touches.
 */
export const MAX_WEAPON_DAMAGE = 999;

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

/**
 * Longest noise a consumable may make.
 *
 * Short on purpose, and the shortness is the documentation: this field is for
 * "crunch", not for a line of dialogue. The drawn text is capped again by the
 * chat rules it is rendered through, which is the looser of the two — so this
 * is the bound that actually decides, and it decides in favour of a noise.
 */
export const MAX_CONSUMABLE_SOUND_LENGTH = 32;

/** The authored verb, or the fallback where there is none to read. */
export function consumeVerb(consumable: ConsumableItem): string {
  return consumable.label?.trim() || CONSUME_FALLBACK_VERB;
}

/**
 * What putting this thing on is called.
 *
 * **Read off the item, never off the slot it is heading for.** The hands take
 * anything now — a pack in your fist instead of a shield is a choice the game
 * lets you make — so a verb named after the square would have to call that
 * "wielding a backpack". What the word describes is the *thing*: you wield a
 * sword, you hold a torch, you put on a pack, whichever hand ends up with it.
 *
 * Not authored, unlike a consumable's, because there is nothing for an author
 * to add: the three kinds of item are the three verbs, and "Wield" is what every
 * weapon in every game has always been called. `offhand` is the one distinction
 * inside a kind, and it is already written down for other reasons.
 */
export function equipVerb(def: TileDef): string {
  const item = resolveItem(def);
  if (!item) return EQUIP_FALLBACK_VERB;
  if (item.type === "container") return "Put on";
  if (item.type === "weapon") return item.offhand ? "Hold" : "Wield";
  // Anything you are merely carrying rather than using. Nothing reaches this
  // through the interaction list — a consumable has no slot it belongs in — but
  // a hand will take one, and the square it lands in has to be able to say so.
  return "Hold";
}

/** What an item nothing else can name reads as when it is put on. */
export const EQUIP_FALLBACK_VERB = "Equip";

/**
 * What a tile gets the moment somebody makes it a weapon.
 *
 * Middling and complete, where it used to be a list of small deltas: every field
 * is now absolute, so a default of zero accuracy would be a weapon that cannot
 * be aimed rather than one that changes nothing. These are roughly a pair of
 * competent fists — a fresh weapon should be usable on the tick it is authored,
 * and an author who wants a greatsword is a few keystrokes away.
 */
export const DEFAULT_WEAPON: WeaponItem = {
  type: "weapon",
  damage: 4,
  def: 0,
  accuracy: 85,
  variance: 20,
  spd: 50,
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
  // Something rather than nothing, so a fresh consumable shows what the field
  // is for the moment it is used. It goes with the "Eat" above.
  sound: "crunch",
};

/** The starting backpack's shape, and what a fresh container tile gets. */
export const DEFAULT_CONTAINER: ContainerItem = {
  type: "container",
  size: 4,
  equippable: true,
};

/** Both percent stats, on the one scale a fight reads them against. */
const percent = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(MIN_PERCENT_STAT),
  v.maxValue(MAX_PERCENT_STAT),
);

/**
 * Exported because a body's natural weapon is validated by it too.
 *
 * "A bite is a weapon like any other" has to be literally true, including in
 * what it is allowed to say — a second schema for natural weapons would be two
 * definitions of a weapon that could drift.
 */
export const weaponSchema = v.object({
  type: v.literal("weapon"),
  damage: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(MAX_WEAPON_DAMAGE),
  ),
  def: v.pipe(v.number(), v.integer(), v.minValue(0)),
  // Optional, and absent means the main hand — the overwhelmingly common case,
  // and every weapon authored before the slot existed.
  offhand: v.optional(v.boolean()),
  // Unsigned, where both were signed shifts: these are the wielder's accuracy
  // and speed now, not adjustments to numbers the body brought with it, and a
  // negative accuracy is not a worse one — it is a broken one.
  accuracy: percent,
  variance: percent,
  spd: percent,
  mastery: v.picklist(WEAPON_MASTERIES),
  // Optional, and absent is the overwhelmingly common case: most weapons ask
  // nothing. An empty object is allowed through rather than rejected — it says
  // the same thing as no key, and refusing it would make a round trip through
  // the editor a validation error.
  requirements: v.optional(masteriesSchema),
});

const consumableSchema = v.object({
  type: v.literal("consumable"),
  // Optional on the same grounds as a switch's actionName: a consumable with
  // no verb written on it is still a consumable, and whoever offers the action
  // falls back to the generic verb.
  label: v.optional(v.string()),
  // Bounded where the verb is not: a verb is a word by construction, and this
  // is free text that ends up drawn over somebody's head.
  sound: v.optional(v.pipe(v.string(), v.maxLength(MAX_CONSUMABLE_SOUND_LENGTH))),
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
/**
 * A weapon's fields, named, and nothing else.
 *
 * Split out of {@link itemForSave} because a body's natural weapon is saved
 * through it too, and that caller knows it has a weapon — going via the union
 * would hand it back an `ItemDef` it would have to re-narrow for no reason.
 */
export function weaponForSave(weapon: WeaponItem): WeaponItem {
  // Zeroes dropped along with the absent keys, and the whole block dropped when
  // nothing survives: a requirement of zero is not a requirement, and a weapon
  // carrying `requirements: {}` would read as "asks something" to anybody
  // skimming the file.
  const requirements = Object.fromEntries(
    MASTERIES.filter((mastery) => (weapon.requirements?.[mastery] ?? 0) > 0).map(
      (mastery) => [mastery, weapon.requirements?.[mastery]],
    ),
  );

  return {
    type: "weapon",
    damage: weapon.damage,
    def: weapon.def,
    accuracy: weapon.accuracy,
    variance: weapon.variance,
    spd: weapon.spd,
    mastery: weapon.mastery,
    // Written only when true, on the same terms the requirements block is: an
    // explicit `false` on every weapon in the file is a field to skim past that
    // says exactly what its absence says.
    ...(weapon.offhand ? { offhand: true } : {}),
    ...(Object.keys(requirements).length > 0 ? { requirements } : {}),
  };
}

export function itemForSave(item: ItemDef | undefined): ItemDef | undefined {
  if (!item) return undefined;
  if (item.type === "weapon") return weaponForSave(item);
  if (item.type === "consumable") {
    // A blank verb is dropped rather than written as `""`, exactly as a
    // switch's actionName is: an empty string that means "no name" is a second
    // way of saying what an absent key already says.
    const label = item.label?.trim();
    const sound = item.sound?.trim();
    return {
      type: "consumable",
      ...(label ? { label } : {}),
      ...(sound ? { sound } : {}),
      hp: item.hp,
    };
  }
  return {
    type: "container",
    size: item.size,
    equippable: item.equippable,
  };
}
