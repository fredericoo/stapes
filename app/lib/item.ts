import * as v from "valibot";
import {
  type Masteries,
  MASTERIES,
  masteriesSchema,
  WEAPON_MASTERIES,
  type WeaponMastery,
} from "./mastery";
import { CELL_SIZE, type TileDef } from "./types";

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
/**
 * How far something reaches: a disc on the plan, and a height either side.
 *
 * **Two numbers rather than one radius, and the split is the whole point.** A
 * single radius cannot say "everything on my floor for six cells, but only half
 * a level up" — the shape does not exist, because any radius wide enough to
 * include a cell six away also includes everything within six of you upward.
 * Weighting height more heavily only moves where the argument happens; it never
 * produces the shape, and the sphere this replaced spent its whole module doc
 * discovering that.
 *
 * Two independent tests draw it exactly, and it is the shape everything else in
 * the game was already using in private: `../game/affordances` measures what you
 * can touch as a disc plus a level slack, and a brain's `in_range` measures plan
 * steps plus its sight's up and down. This is those, written down once.
 *
 * @see `../game/distance` for the metric, and {@link MELEE_REACH} for the shape
 *   an arm draws.
 */
export type Reach = {
  /**
   * Radius on the plan in cells, with height ignored entirely.
   *
   * Compared squared, and the interesting values land *on* boundaries: the
   * diagonal neighbour is exactly 2 squared and the cell two along is exactly 4,
   * so a radius meant to include one and exclude the other wants room on both
   * sides rather than a value sitting on either.
   */
  cells: number;
  /**
   * How far up or down it reaches, in height units — two to a level.
   *
   * Height units rather than levels, because the question is answered against an
   * absolute elevation and not against a floor: somebody standing on a crate is
   * half a level above the floor they share with you, and a rule counting floors
   * cannot see the crate at all. It is also the only unit in which an arm's
   * half-level reach can be said.
   */
  height: number;
};

/**
 * What an arm draws: the eight cells around you, half a level up and down.
 *
 * `1.5` on the plan squares to 2.25 — the diagonal neighbour is 2 and the cell
 * two along is 4, so this is the 3×3 box and nothing else, with room on both
 * sides of the value rather than sitting on a boundary. The same number, for the
 * same reason, as `../game/affordances`'s `REACH_CELLS`: what you can hit and
 * what you can touch are one shape, and they were two constants agreeing by
 * luck.
 *
 * One height unit is half a level, which is exactly the step you can climb — so
 * anything you could walk up onto in one move, you can also hit.
 */
export const MELEE_REACH: Reach = { cells: 1.5, height: 1 };

/**
 * The thing a ranged weapon puts in the air.
 *
 * **Entirely a drawing, and deliberately so.** It collides with nothing, it can
 * be walked through, and it cannot miss on the way — the whole fight was already
 * settled on the tick it was loosed, and the arrow is a receipt in flight rather
 * than the blow itself. That is not a shortcut taken to avoid the physics: a
 * blow that lands when the arrow arrives is a blow whose outcome depends on
 * frames, and two clients drawing at different rates would disagree about
 * whether somebody died. Damage now and the arrow after is the one arrangement
 * where the picture can lag the truth without ever contradicting it.
 *
 * Which also means a shot at a body that dies before the arrow lands still
 * finishes its flight, and should: the arrow was loosed, and taking it back out
 * of the air would be the picture editing itself after the fact.
 */
export type ProjectileDef = {
  /**
   * The tile drawn in flight.
   *
   * A tile id rather than sprites inlined here, so an arrow is an ordinary thing
   * in the catalogue: it animates, it can carry a light, and it is authored with
   * the same picker as everything else. A `directional8` tile — see
   * `./types` — because a shot travels on any of eight bearings and a four-way
   * facing would make half of them point somewhere the arrow is not going.
   *
   * A tile the catalogue has lost draws nothing, on the terms every other id in
   * a kit is honoured: the fact is out of date, not corrupt, and a fight is not
   * worth refusing over the art.
   */
  tileId: string;
  /**
   * How fast it travels, in cells per second.
   *
   * A speed rather than a duration, so a long shot takes longer than a short one
   * — which is the only thing in the animation carrying any information about
   * distance. A fixed duration would make an arrow crossing six cells look
   * exactly like one crossing two, at wildly different apparent speeds.
   *
   * **Cells per second, and it was world pixels per millisecond.** That unit is
   * the reason the first arrows in this game floated: `0.03` is three and three
   * quarter cells a second — slower than a person walks — and nothing about the
   * number says so. A speed is only authorable in the unit the map is drawn in,
   * where "twenty" is plainly an arrow and "four" is plainly a thrown pebble,
   * and where anybody can check it against the five cells a second a body walks
   * at. See {@link DEFAULT_PROJECTILE_SPEED}.
   */
  cellsPerSecond: number;
};

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
  /**
   * How far this reaches, as a disc on the plan and a height either side of it.
   *
   * **On the weapon, where it used to be on the body.** `BattlerDef.range` said
   * in its own doc that this was the wrong home and that ranged weapons would
   * move it; this is that move. A bow's reach is the bow's, so a rat that picks
   * one up shoots as far as the bow carries rather than as far as a rat's teeth
   * go, and the natural weapon a body is born with carries its own reach like
   * any other weapon.
   *
   * See `../game/distance` for the shape and why it is two numbers rather than
   * one radius.
   */
  reach: Reach;
  mastery: WeaponMastery;
  /**
   * What this throws at what it is aimed at, or absent for anything that
   * reaches its target itself.
   *
   * **This block is the whole definition of "ranged".** There is no `ranged`
   * flag beside it and there must not be one: two fields saying the same thing
   * is a bow authored to fire nothing, or a sword that lunges half a tile and
   * also puts an arrow in the air. What fires something does not lunge — see
   * `../game/strike` — and what does not, does.
   *
   * Purely a drawing. Nothing here collides, and the damage is settled on the
   * tick the shot is loosed rather than when the arrow arrives; see
   * {@link ProjectileDef}.
   */
  projectile?: ProjectileDef;
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
  /**
   * What landing a blow with this may leave on whoever was hit.
   *
   * **A fact about the weapon, never about the wielder.** A snake's venom is in
   * its fangs; how well the snake uses them is its Fist mastery, and that has
   * already had its say twice over — on whether the bite landed and on how hard.
   * Scaling the chance by mastery as well would pay one skill three times, and
   * would make a venomous fang in a novice's hand a *less venomous fang*, which
   * is not a thing venom does.
   *
   * Every entry is rolled on every swing and read only on a blow that connected
   * — see `../game/combat`'s `rollAttack`, which owns both halves of that
   * sentence and explains why the draws are taken either way.
   *
   * Absent is the overwhelmingly common case: most weapons do nothing but
   * damage. The duration override means here what it means on a consumable —
   * see {@link StatusGrant}.
   */
  statuses?: WeaponStatus[];
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
  /**
   * Statuses this puts on whoever uses it, applied in order.
   *
   * **Beside {@link hp} rather than instead of it.** A potion still heals on the
   * spot and a poison apple still bites on the spot; a berry now does neither and
   * hands over a `Fed` instead. Two fields because they are two things: one
   * happens and is over, the other is a condition you are in.
   *
   * Whether an id names anything is the catalogue's question, asked where the
   * status is granted. An id it does not hold is skipped, in the same breath a
   * reward naming a missing tile is left alone: renamed content should read as an
   * effect that did not happen, not as a world that will not start.
   */
  statuses?: StatusGrant[];
};

/**
 * One status something hands over, and how long for.
 *
 * Shared by a consumable and by a weapon, because the two say the same thing:
 * *this* status, for *this* long. What differs is whether it is certain, and
 * that is the one field {@link WeaponStatus} adds.
 *
 * **The range belongs to the food, not only to the condition.** Bread and a berry
 * both leave you Fed — same icon, same line, same 1% a second — and the whole
 * difference between a snack and a meal is how long it lasts. Without an override
 * here that difference could only be expressed by authoring a second status, and
 * then two identical conditions would sit in the panel refusing to stack with
 * each other.
 *
 * So the status owns what it *does* and the item owns how much of it you get,
 * which is also the split that keeps stacking meaningful: eat a berry then a
 * loaf and you have one Fed, longer.
 *
 * Absent means the status's own range, which is what every consumable wants
 * until somebody has a reason to differ.
 */
export type StatusGrant = {
  id: string;
  /**
   * Overrides the status's authored range, both ends included.
   *
   * **Both or neither.** Half an override would have to be ordered against a
   * number from somewhere else, and "the item's floor against the status's
   * ceiling" is a rule nobody could hold in their head while authoring.
   */
  fromMs?: number;
  toMs?: number;
};

/**
 * A status a weapon may inflict, and how often it actually does.
 *
 * The one thing a blow has that a drink does not: **a drink always works.** You
 * chose to swallow it and it went down; a bite has to get through, and then the
 * venom has to take. So a weapon's grant carries a probability and a
 * consumable's does not, rather than both carrying one and every consumable in
 * the world being authored at a hundred percent.
 */
export type WeaponStatus = StatusGrant & {
  /**
   * 0-100. How often a connecting blow leaves this behind.
   *
   * **Not held inside the band every other chance in a fight lives in.** A hit
   * chance and a dodge are contests, and `MIN_CHANCE`/`MAX_CHANCE` keep both
   * ends of a contest in doubt; this is neither. It is an authored constant, and
   * an author who writes 100 means a brand that always burns while one who
   * writes 0 means an entry they have switched off.
   */
  chance: number;
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

/**
 * Furthest a weapon may reach, on the plan and in height.
 *
 * Sanity bounds rather than balance ones, like {@link MAX_WEAPON_DAMAGE}: a bow
 * that carries most of a screen is authorable, and a typo'd extra digit reads as
 * malformed rather than as a weapon that hits everything on the floor. The
 * height bound is generous in the same spirit — ten units is five levels, taller
 * than anything the map is authored with.
 */
export const MAX_REACH_CELLS = 64;
export const MAX_REACH_HEIGHT = 10;

/**
 * How fast a projectile may travel, in cells per second.
 *
 * The floor is not zero: a speed of zero is an arrow that never arrives and a
 * flight that never ends, which is a hang rather than a slow shot. One cell a
 * second is as slow as anything could want to be and still be going somewhere —
 * and it is slow enough to be a real cost, since a flight holds the world's tick
 * loop open for as long as it lasts.
 *
 * The ceiling is a thousand, which crosses the widest authorable reach inside a
 * single tick. Anything past that is a shot nobody sees at all and may as well
 * have no projectile authored.
 */
export const MIN_PROJECTILE_SPEED = 1;
export const MAX_PROJECTILE_SPEED = 1000;

/**
 * What a fresh projectile travels at, in cells per second.
 *
 * **Read against the two speeds already in the game.** A body walks a cell every
 * `WALK_DURATION_MS`, which is five cells a second, and a melee lean is out and
 * back in 150ms. Twenty is four times walking pace and crosses a six-cell reach
 * in about three hundred milliseconds — near enough to the length of one swing
 * that a shot reads as a blow struck rather than as an object drifting across
 * the yard.
 *
 * The first value here was three and three quarter cells a second, written in a
 * unit that hid it. An arrow slower than the archer could walk is the failure
 * this constant exists to make impossible to write by accident.
 */
export const DEFAULT_PROJECTILE_SPEED = 20;

/**
 * What a status a weapon has just been given happens at, until somebody says.
 *
 * Uncommon rather than certain, because that is what the field is *for*: a
 * status that always lands is a second damage number, and an author who wanted
 * one would have reached for damage. Ten percent is roughly "now and again",
 * which is the shape of every venom worth authoring.
 */
export const DEFAULT_WEAPON_STATUS_CHANCE = 10;

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
  // Spread rather than the constant itself, so a draft edited in the tile editor
  // cannot write through this default into every other weapon that took it.
  reach: { ...MELEE_REACH },
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

/** The id, and the duration override when the granter overrides one. */
const statusGrantEntries = {
  id: v.pipe(v.string(), v.trim(), v.minLength(1)),
  fromMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  toMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
};

/**
 * Both or neither, and ordered — the same two rules a decay lifetime is under,
 * and refused here for the same reason: an inverted range authored by hand
 * should read as a malformed block rather than as a status that never lands.
 *
 * Predicates over the two fields alone rather than finished validations, so the
 * weapon's shape and the consumable's are held to one copy of each rule: a
 * built `v.check` is pinned to the object it was built against, where a
 * predicate takes anything that has the two ends on it.
 */
type DurationOverride = { fromMs?: number; toMs?: number };

const overrideIsWhole = (raw: DurationOverride) =>
  (raw.fromMs === undefined) === (raw.toMs === undefined);

const overrideIsOrdered = (raw: DurationOverride) =>
  raw.fromMs === undefined || raw.toMs! >= raw.fromMs;

const BOTH_ENDS_MESSAGE = "give both ends of a duration override, or neither";
const ORDERED_MESSAGE = "duration range is inverted";

/** How long a consumable's status runs, when it differs from the status's own. */
const statusGrantSchema = v.pipe(
  v.object(statusGrantEntries),
  // Wrapped rather than passed by reference: `v.check` reads its input type off
  // the callback, so handing it a predicate over the two ends alone would pin
  // the whole action to that narrower shape.
  v.check((raw) => overrideIsWhole(raw), BOTH_ENDS_MESSAGE),
  v.check((raw) => overrideIsOrdered(raw), ORDERED_MESSAGE),
);

/**
 * The same, plus the chance a connecting blow leaves it behind.
 *
 * On the percent scale the rest of a weapon is authored on, and required rather
 * than defaulted: a chance somebody forgot to write is the one number nobody can
 * guess for them — a hundred and a one are both defensible defaults and they are
 * a different weapon.
 */
const weaponStatusSchema = v.pipe(
  v.object({ ...statusGrantEntries, chance: percent }),
  // Wrapped rather than passed by reference: `v.check` reads its input type off
  // the callback, so handing it a predicate over the two ends alone would pin
  // the whole action to that narrower shape.
  v.check((raw) => overrideIsWhole(raw), BOTH_ENDS_MESSAGE),
  v.check((raw) => overrideIsOrdered(raw), ORDERED_MESSAGE),
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
  // Optional, and absent is an arm's length — every weapon authored before reach
  // moved off the body, which is all of them. A getter for the reason the
  // battler's `sight` default is one: two tiles must never share one mutable
  // block.
  reach: v.optional(
    v.object({
      cells: v.pipe(v.number(), v.minValue(0), v.maxValue(MAX_REACH_CELLS)),
      height: v.pipe(v.number(), v.minValue(0), v.maxValue(MAX_REACH_HEIGHT)),
    }),
    () => ({ ...MELEE_REACH }),
  ),
  mastery: v.picklist(WEAPON_MASTERIES),
  // Absent for every melee weapon, which is the overwhelming majority, and
  // present is the entire definition of a ranged one. Whether the tile id names
  // anything is the catalogue's question and is asked where the arrow is drawn —
  // this module resolves no tiles, on exactly the terms a consumable's status
  // ids are left alone here.
  projectile: v.optional(
    v.object({
      tileId: v.pipe(v.string(), v.trim(), v.minLength(1)),
      cellsPerSecond: v.pipe(
        v.number(),
        v.minValue(MIN_PROJECTILE_SPEED),
        v.maxValue(MAX_PROJECTILE_SPEED),
      ),
    }),
  ),
  // Optional, and absent is the overwhelmingly common case: most weapons ask
  // nothing. An empty object is allowed through rather than rejected — it says
  // the same thing as no key, and refusing it would make a round trip through
  // the editor a validation error.
  requirements: v.optional(masteriesSchema),
  // Whether an id names anything is the catalogue's question, asked where the
  // status is granted — see the consumable's list, which this deliberately
  // mirrors down to the shape of one entry.
  statuses: v.optional(v.array(weaponStatusSchema)),
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
  // Whether an id names anything is the catalogue's question, asked where the
  // status is granted — this module knows nothing about statuses and must not
  // start resolving them to answer a schema.
  //
  // **One shape, not two.** A bare-string shorthand was tempting for
  // hand-authoring and was a trap: `resolveConsumable` normalised it, but the
  // tile editor works on the *raw* block, so the picker saw strings where it
  // expected entries and silently reported every status as unknown. A tolerance
  // that only half the readers apply is worse than eight extra characters.
  statuses: v.optional(v.array(statusGrantSchema)),
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

/**
 * Does this weapon put something in the air?
 *
 * The one question the rest of the game asks about ranged-ness, and it is a
 * lookup rather than a flag — see {@link WeaponItem.projectile}. Written down
 * here so no caller is tempted to test `projectile != null` itself and quietly
 * disagree with the next one about what counts.
 *
 * Structural rather than taking a {@link WeaponItem}, because the question is
 * asked of a resolved `FightingStats` too — the fight holds the projectile
 * beside the numbers it rolls with, and a second spelling of this over there is
 * exactly the disagreement the paragraph above is about.
 */
export function isRanged(weapon: {
  projectile?: ProjectileDef | null;
}): boolean {
  return weapon.projectile != null;
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

  const statuses = statusGrantsForSave(weapon.statuses);

  return {
    type: "weapon",
    damage: weapon.damage,
    def: weapon.def,
    accuracy: weapon.accuracy,
    variance: weapon.variance,
    spd: weapon.spd,
    // Written whatever it says, unlike the optionals below: reach is a number
    // every weapon has an opinion about now, and omitting the melee default
    // would make "an arm's length" and "nobody has said" the same line in the
    // file — which is fine until somebody changes what an arm's length is.
    reach: { cells: weapon.reach.cells, height: weapon.reach.height },
    mastery: weapon.mastery,
    ...(weapon.projectile
      ? {
          projectile: {
            tileId: weapon.projectile.tileId.trim(),
            cellsPerSecond: weapon.projectile.cellsPerSecond,
          },
        }
      : {}),
    // Written only when true, on the same terms the requirements block is: an
    // explicit `false` on every weapon in the file is a field to skim past that
    // says exactly what its absence says.
    ...(weapon.offhand ? { offhand: true } : {}),
    ...(Object.keys(requirements).length > 0 ? { requirements } : {}),
    ...(statuses ? { statuses } : {}),
  };
}

/**
 * A list of grants, named field by field, or nothing where none survive.
 *
 * Generic over what one entry carries so a weapon's chance rides along with it:
 * the fields this function knows about are the ones every grant has, and
 * whatever else the caller put on an entry is preserved rather than dropped.
 * A single walk for both kinds, because the rules it enforces — a blank id is
 * not a grant, half an override is not an override — are the same rules.
 */
function statusGrantsForSave<Grant extends StatusGrant>(
  statuses: Grant[] | undefined,
): Grant[] | undefined {
  if (!statuses?.length) return undefined;
  const saved: Grant[] = [];
  for (const entry of statuses) {
    const id = entry.id.trim();
    if (!id) continue;
    const fromMs = entry.fromMs;
    const toMs = entry.toMs;
    // Both or neither — half an override is malformed and the schema refuses it.
    if (fromMs !== undefined && toMs !== undefined) {
      saved.push({ ...entry, id, fromMs: Math.round(fromMs), toMs: Math.round(toMs) });
    } else {
      // Spread minus the two ends, so a draft that carried half an override
      // does not smuggle it onto disk under a key the schema would refuse.
      const { fromMs: _from, toMs: _to, ...rest } = entry;
      saved.push({ ...rest, id } as Grant);
    }
  }
  return saved.length ? saved : undefined;
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
    const statuses = statusGrantsForSave(item.statuses);
    return {
      type: "consumable",
      ...(label ? { label } : {}),
      ...(sound ? { sound } : {}),
      hp: item.hp,
      ...(statuses ? { statuses } : {}),
    };
  }
  return {
    type: "container",
    size: item.size,
    equippable: item.equippable,
  };
}
