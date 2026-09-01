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
   * **What a thing turns aside by being in the way of it** — a shield, a
   * bracer, a blade held up. It was once the only source of defence in the game
   * because armour had no slot; it is now the *other* one, and the split is
   * worth keeping: {@link ArmorItem} is what you wear and this is what you
   * hold, and a body wearing mail behind a shield should get both.
   *
   * **Read off whichever hand is holding it**, and both hands are read the
   * same way now that both of them swing — see `../game/equipment`'s
   * `heldDefence`. A parrying sword parries in either fist.
   * `../game/equipment`'s `wornDefence` is where every source is added, along
   * with what is worn, and is the only honest answer to "how protected is this
   * body".
   *
   * A comment here once said the opposite — that a main-hand `def` was
   * authorable and did nothing — which was false on the day it was written and
   * is worth leaving a scar over: the arithmetic lived in two functions and
   * neither one's name admitted the other existed.
   */
  def: number;
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
  /**
   * Whether swinging this takes both hands — a greatsword, a bow, a pike.
   *
   * **It occupies one square and claims the other**, rather than being stored
   * in two. A slot holds one instance; putting the same one in both would be two
   * references to a thing there is one of, and every rule that empties a slot
   * would have to learn to empty its twin. So the weapon sits in whichever hand
   * took it, the other hand is genuinely empty, and what a player sees in that
   * empty square is a picture rather than an item — see
   * `../components/EquipmentPanel`.
   *
   * **The first rule in the game where one square's answer depends on another.**
   * Both hands take anything you can carry, and this is the single exception:
   * `../game/itemMoves`' `slotHasRoom` refuses a hand whose partner is holding
   * one of these, and refuses one of these to a hand whose partner is occupied.
   * That asymmetry is worth it because the alternative is a body wielding a pike
   * and a shield, which nothing about a pike can be read to allow.
   *
   * It follows that a two-handed weapon never takes turns with anything: there
   * is no second weapon to alternate with, so `handToSwing` finds one hand and
   * stops. What it trades a second swing for is whatever the author wrote on it.
   *
   * Absent means one-handed, which is every weapon authored before this existed
   * and most of them after.
   */
  twoHanded?: boolean;
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
 * The squares on a body that armour goes in.
 *
 * Here rather than in `./kit` beside `EQUIP_SLOTS` — the list this is a subset
 * of — because `./kit` already imports this module, and an edge back the other
 * way would be a cycle. The guard that holds the two lists together lives
 * there, where both are in scope.
 *
 * **A helmet, a boot and an amulet are all armour.** They are worn, they take
 * the edge off what lands, and the only thing that separates them is which
 * square they go in. Four arms of {@link ItemDef} with the same two fields
 * would be four places to fix the day resistances change, and four kinds an
 * author has to learn where one would do.
 *
 * The body's square is called `armor` rather than `body` because that is what
 * it has been called since it was the only one: on the wire, in every saved
 * kit, and in every authored file. Renaming it now would take a breastplate off
 * everybody who is wearing one.
 */
export const ARMOR_SLOTS = ["head", "armor", "footwear", "charm"] as const;

/** Which of the worn squares a piece of armour belongs in. */
export type ArmorSlot = (typeof ARMOR_SLOTS)[number];

/**
 * Where armour is worn when it does not say.
 *
 * The body, because every armour authored before there was anywhere else to put
 * one is on a chest. An absent field has to mean what the file already meant,
 * or the merge that adds a head turns every mail shirt into a hat.
 */
export const DEFAULT_ARMOR_SLOT: ArmorSlot = "armor";

/**
 * Which square this armour is worn in, with the default applied.
 *
 * Read through here rather than off {@link ArmorItem.slot}, so "absent means the
 * body" is written down once instead of at every call site that has to allow
 * for it.
 */
export function armorSlotOf(armor: ArmorItem): ArmorSlot {
  return armor.slot ?? DEFAULT_ARMOR_SLOT;
}

/**
 * Something worn, and the only thing it does is stop blows.
 *
 * **One number, on purpose.** Armour that also weighed you down, or slowed a
 * swing, or asked a mastery of you would be a second stat block arguing with the
 * weapon's over the same fight — and the mastery model exists precisely so that
 * one block decides. What a body is good at is its masteries, what it fights
 * with is its weapon, and what it is wearing takes the edge off what lands. Three
 * questions, three answers, none of them opinions about the others.
 *
 * It is deliberately the *same* field a shield's {@link WeaponItem.def} is, and
 * they add: a shield is what you put in the way and this is what you have on,
 * and a body with both is protected by both. See `../game/equipment`'s
 * `wornDefence`, which is the one place they are summed.
 *
 * No `requirements` block, unlike a weapon. A requirement scales what a weapon
 * is *worth* through `masteryRatio`, and there is no such scale here to hang it
 * on — a half-understood breastplate is a breastplate. The dials an author has
 * are {@link def} and {@link resist}, and a heavy armour nobody should have yet
 * is one they cannot reach rather than one that punishes them for wearing it.
 */
export type ArmorItem = {
  type: "armor";
  /**
   * Which square it is worn in — a helmet on the head, boots on the feet, a
   * ring or an amulet on the charm.
   *
   * **The only thing separating a helmet from a breastplate.** Both are a `def`
   * and a `resist` on a thing you put on; what a player feels is that you can
   * wear one of each, and that is a fact about the squares rather than about
   * the objects. See {@link ARMOR_SLOTS}.
   *
   * Absent means the body — see {@link DEFAULT_ARMOR_SLOT} — and is read
   * through {@link armorSlotOf} rather than off the field.
   */
  slot?: ArmorSlot;
  /**
   * Flat reduction on every blow that lands on the wearer, whatever struck it.
   *
   * Flat rather than a share, because that is what defence already is in this
   * game — `../game/combat` subtracts it — and a second kind of defence that
   * scaled would be two rules for one word. It follows that armour is worth most
   * against a swarm of small blows and least against one big one, which is a
   * real characterisation and the right way round: a mail shirt is why a rat is
   * no longer a threat, and it is not why a bear is.
   */
  def: number;
  /**
   * Extra reduction against blows of one *kind*, on top of {@link def}.
   *
   * **Keyed by the attacking weapon's mastery, because that is already the game's
   * word for what kind of blow a thing strikes.** A weapon names one — see
   * {@link WeaponItem.mastery} — and it is not a label bolted on for this: it is
   * the same field that decides how the weapon scales and what swinging it
   * teaches. Inventing a damage-type axis beside it would be a second taxonomy
   * of weapons to keep in step with the first, and the first is authored on
   * every weapon in the world already.
   *
   * This is what makes armour a *choice* rather than a ladder. With `def` alone
   * every piece is strictly better or worse than every other and the only
   * decision is which you have found; a mail shirt that shrugs off blades and
   * does nothing about a hammer is a thing you pick for the fight in front of
   * you. It also gives a boss a real answer — a creature spawned in warded robes
   * is a creature you do not beat with the staff.
   *
   * **Additive with {@link def} and never a multiplier or a share.** Defence is
   * subtracted from a blow, so a resistance expressed as a percentage would be
   * a second arithmetic nobody reading a fight could hold beside the first. It
   * follows that the *most* an armour can do is `def + resist[kind]`, which is a
   * number an author can read straight off the block.
   *
   * Absent is the common case and means "the same against everything", which is
   * what plain clothing is. Only weapon masteries can be named: Toughness and
   * Agility are what a body *is*, and nothing swings them.
   */
  resist?: WeaponResistances;
};

/**
 * Extra defence, kind by kind. Every entry optional, so a block says only what
 * the armour has an opinion about — an absent kind means the flat {@link
 * ArmorItem.def} and nothing more.
 */
export type WeaponResistances = Partial<Record<WeaponMastery, number>>;

/**
 * Something you carry that the fight knows nothing about.
 *
 * **An arm with no fields at all, and that is the whole of it.** A torch had to
 * be authored as a {@link WeaponItem} because holding a thing needed a block and
 * that was the only block with an off hand — which made the torch a weapon, so a
 * body holding one *fought with it*, and fought worse than with its own hands:
 * `../game/equipment`'s `weaponInHand` replaces the natural weapon with whatever
 * is held, and the numbers somebody had to invent to get a stick into a hand
 * were beneath a pair of fists. The light was coming off the sprite the entire
 * time. Nothing about that block was ever wanted.
 *
 * So the numbers are gone rather than tuned upward. **A body holding one of
 * these has, as far as a fight is concerned, an empty hand** — `resolveWeapon`
 * refuses it, so a hand holding one takes no turn in the rotation and adds no
 * defence — and everything the thing does it does by being a placement: its
 * light, its sprite, its weight, its being in the way. That is what `./kit` is
 * relying on when it hands a wolf a torch.
 *
 * **It belongs in a hand, and it does not have to say which.** Neither hand is
 * the swinging one any more, so "which hand was meant" stopped being a question
 * an author could be asked — see `../game/equipment`'s `HANDS`. What separates
 * this from {@link ShieldItem} is only that a fight cannot see it at all, where
 * a shield stops blows.
 */
export type ArtifactItem = {
  type: "artifact";
};

/**
 * Something held in the way of a blow that is not swung at anybody — a shield,
 * a buckler, a warding charm on a strap.
 *
 * **A kind of its own because both hands swing now.** It was a
 * {@link WeaponItem} carrying `damage: 0` and an `offhand: true` flag, which
 * worked only for exactly as long as the off hand was decorative: the moment a
 * body takes turns between its hands, a shield authored as a weapon is a weapon
 * in the rotation, and half your swings are a `damage: 0` blow. The flag is gone
 * rather than repurposed — nothing in the world ever set it, so there was
 * nothing to migrate and no reason to keep two ways of saying "held".
 *
 * **It is deliberately not {@link ArmorItem}.** A shield is a thing you *hold*,
 * and making it armour would put it in the square a breastplate belongs in and
 * let a body wear one instead of the other. Two kinds, two squares, and
 * `../game/equipment`'s `wornDefence` adds them.
 *
 * **And deliberately not {@link ArtifactItem} with a number bolted on.** An
 * artifact is a thing a fight knows nothing about — that is the entirety of what
 * it is for, and it is the reason a torch stopped being a weapon. A shield is a
 * thing a fight very much knows about; it simply never attacks.
 *
 * One number, on the terms armour has one: `def`, flat, subtracted from every
 * blow whatever struck it. No `resist`, because neither hand has an opinion
 * about what *kind* of blow it is stopping — see `../game/equipment`'s
 * `armorResistances`, which is where that half lives and why it is worn only.
 */
export type ShieldItem = {
  type: "shield";
  /**
   * Flat reduction on every blow that lands on whoever is holding it.
   *
   * The same field a weapon's {@link WeaponItem.def} is and they add: a body
   * with a parrying sword in one fist and a shield in the other is protected by
   * both, which is the whole reason a hand is a square rather than a slot with
   * a rule.
   */
  def: number;
};

/**
 * What a stone does when it is pressed, as one of exactly three things.
 *
 * **A closed vocabulary, and the closure is the design.** Every arm here is a
 * thing the simulation could already do to somebody — heal them, put a status
 * on them, put a tile on the board — so casting adds no new physics at all: a
 * stone of light is an authored status whose visual block carries a light, and
 * it rides the same emitter path a carried torch does. What cannot be said with
 * these three is not a spell this game has; the obvious next one is an area,
 * and it is deliberately absent because nothing here touches more than one
 * target or more than one cell.
 */
export type StoneEffect =
  /**
   * Put health back into whoever cast it, and nobody else.
   *
   * Always the caster, never the target, and that is not an omission: a stone
   * that could heal what you are pointing at would be the first thing in the
   * game whose usefulness depended on picking an ally, and there are no allies.
   * What it is worth is what it *restores* rather than what it names — see
   * `../game/experience`'s `casterEarnings`, where a heal at full health teaches
   * nothing.
   */
  | { kind: "heal"; hp: number }
  /**
   * Start an authored status, on the caster or on whatever they are pointing at.
   *
   * The duration override means here exactly what it means on a consumable —
   * see {@link StatusGrant} — and for the same reason: two stones may start one
   * status and differ only in how long it runs.
   *
   * `on` is a fact about the stone rather than about the square it is in. A
   * charm may only ever reach its holder, so a `target` charm is refused where
   * the squares are decided rather than here; a hand stone can honestly be
   * either, and which it is is the whole difference between a ward and a curse.
   */
  | {
      kind: "status";
      on: StoneSubject;
      id: string;
      fromMs?: number;
      toMs?: number;
    }
  /**
   * Put a tile on the board — at the target's cell, or in front of the caster.
   *
   * **The only sense in which a spell touches a cell, and the player never picks
   * that cell.** A conjure with a target lands on the target; a conjure without
   * one lands on the cell the caster is facing. There is no tile-targeted
   * casting, so the two hard questions an arbitrary cell would raise — how a
   * phone picks one, and what stops somebody dropping fire on the far side of a
   * wall — never come up.
   *
   * What is conjured should **decay**, and that is the author's business rather
   * than this block's: the decay system already expires placements, so a
   * conjured flame is an ordinary tile with a lifetime on it. A tile with no
   * decay authored is a permanent one, which is a battlefield nobody wants and
   * a mistake the editor can say out loud.
   */
  | { kind: "conjure"; tileId: string };

/**
 * Whose body an effect lands on.
 *
 * Two answers rather than a boolean, so an authored block reads as what it is
 * — `"on": "caster"` says something a `"self": true` does not — and so a third
 * subject, if the design ever grows one, is a value rather than a second flag
 * arguing with the first.
 */
export type StoneSubject = "caster" | "target";

export const STONE_SUBJECTS: StoneSubject[] = ["caster", "target"];

/** The kinds of thing a stone can be authored to do. @see StoneEffect */
export const STONE_EFFECT_KINDS = ["heal", "status", "conjure"] as const;

export type StoneEffectKind = (typeof STONE_EFFECT_KINDS)[number];

/**
 * A thing you carry that casts, and the whole of what magic is in this game.
 *
 * **A kind of its own for the reason a shield is one: both hands swing.** A
 * stone is held and never swung at anybody, so the rotation has to be able to
 * refuse it — and `../game/equipment`'s `weaponSwungBy` refuses everything that
 * is not a {@link WeaponItem}, which is the entirety of what stories about
 * carrying one instead of a sword needed. One stone and a sword is a body that
 * swings the sword every turn; two stones is a body back on its fists, and
 * neither of those is a rule anybody had to write.
 *
 * **There is no mana and there are no spell slots.** What a caster can do is
 * decided by which stones they are carrying and how recently each was used —
 * see {@link cooldownMs}, which is per *instance* rather than per tile, so two
 * identical stones in two hands cool independently. Two hands and a charm is
 * three stones, which is the whole of a loadout and the reason the desktop
 * binding is `1`, `2`, `3` and nothing more.
 *
 * Stones are accepted by the two hand squares and by the charm, and refused
 * everywhere a piece of armour would be — see `../game/equipment`'s
 * `wornAccepts`. What separates the squares is reach: a hand stone may act on
 * whatever the caster has targeted, and a charm may only ever act on its holder.
 */
export type ArcaneStoneItem = {
  type: "stone";
  /** What pressing it does. @see StoneEffect */
  effect: StoneEffect;
  /**
   * How long after a cast before this particular stone may be pressed again, in
   * milliseconds.
   *
   * **Per instance and durable**, which is the opposite of how a fight's hit
   * points are treated and deliberately so: a cooldown rebuilt on load would
   * make reconnecting the cheapest spell in the game. It is carried on the
   * {@link ItemInstance} — see `./itemInstance` — so it rides the kit into
   * storage and out onto the equipment message with nothing to keep in step.
   *
   * Spent whether or not the cast accomplished anything, on the same terms a
   * swing's cooldown is spent before the dice are rolled: what a cast costs must
   * not depend on luck.
   *
   * A stone that is cooling is **locked in its square** — see
   * `../game/equipment`'s `stoneLocked`, which is what stops a caster carrying
   * six stones in a bag and rotating through them.
   */
  cooldownMs: number;
  /**
   * What this asks of whoever casts it, mastery by mastery.
   *
   * The same block a weapon's {@link WeaponItem.requirements} is, read the same
   * way and by the same code: the worst ratio decides, and a requirement on a
   * mastery the stone does not train is a real gate rather than a footnote. It
   * is also what scales what casting *teaches* — see `../game/experience`'s
   * `casterEarnings` — so a stone you have outgrown keeps paying and keeps
   * paying less.
   *
   * Unlike a weapon, an unmet requirement **refuses the cast outright** rather
   * than merely making it feeble. A weapon half-understood still swings, badly,
   * because a swing is a body doing what bodies do; a stone is a thing that
   * either answers you or does not, and "it fires but does a third of what it
   * says" is a worse thing to learn from than "not yet".
   *
   * Absent means it asks nothing, which is not the same as asking zero of
   * everything — see `./mastery`'s `masteryRatio`.
   */
  requirements?: Masteries;
  /**
   * How far it reaches, as a disc on the plan and a height either side of it.
   *
   * The same shape and the same machinery a weapon's {@link WeaponItem.reach}
   * is, checked with `../game/combat`'s `canReach` — so a spell out of range
   * fails exactly the way a swing does, and a wall stops one as surely as it
   * stops an arrow.
   *
   * Only ever asked of a stone that reaches somebody *else*: a heal, a charm and
   * a status on the caster are all at arm's length by construction. Absent means
   * an arm's length, which is the same default a weapon takes.
   */
  reach?: Reach;
  /**
   * Whether it fires on its own the moment it can, rather than being pressed.
   *
   * **Charm only**, and refused in a hand where the squares are decided: a hand
   * is a thing you act with, and a hand that acted by itself would be a body
   * casting spells nobody asked it to. What it buys is a passive worth a square
   * — a trinket that tops you up on its own clock — without inventing a second
   * kind of item to hold one.
   *
   * An automatic stone gets **no button**, on either device, because there is
   * nothing to press. That is the one thing separating the two kinds of charm,
   * and it is behaviour rather than position — see `../components/SpellBar`.
   *
   * Absent means pressed, which is every stone worth authoring in a hand.
   */
  automatic?: boolean;
};

/**
 * A discriminated union rather than a flat block of optional fields, so a weapon
 * cannot have a size and a container cannot have a mastery. The editor picks the
 * arm and the schema refuses anything else.
 */
export type ItemDef =
  | WeaponItem
  | ConsumableItem
  | ContainerItem
  | ArmorItem
  | ShieldItem
  | ArtifactItem
  | ArcaneStoneItem;

export type ItemType = ItemDef["type"];

export const ITEM_TYPES: ItemType[] = [
  "weapon",
  "armor",
  "shield",
  "consumable",
  "container",
  "artifact",
  "stone",
];

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
 * Most a piece of armour may turn aside.
 *
 * A sanity bound rather than a balance one, on the terms {@link MAX_WEAPON_DAMAGE}
 * is — and deliberately the *same* number, because the two are subtracted from
 * each other. A ceiling below the widest authorable blow would be this constant
 * quietly deciding that no armour can stop the heaviest weapon, which is a
 * balance opinion and not a bound's to hold; a ceiling above it would let a typo
 * author invulnerability. Equal is the one value that says only "these are the
 * same scale".
 */
export const MAX_ARMOR_DEF = MAX_WEAPON_DAMAGE;

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
 * to add: the kinds of item are the verbs, and "Wield" is what every weapon in
 * every game has always been called. There is no distinction left *inside* a
 * kind — a shield is its own kind now, so the verb falls out of the type alone.
 */
export function equipVerb(def: TileDef): string {
  const item = resolveItem(def);
  if (!item) return EQUIP_FALLBACK_VERB;
  if (item.type === "container") return "Put on";
  if (item.type === "armor") return "Wear";
  if (item.type === "weapon") return "Wield";
  // A torch and everything like it, plus the consumable that has no slot to
  // belong in at all. Holding is the whole of what an artifact is for, so it is
  // the word the floor's row says; a consumable never reaches this through the
  // interaction list, but a hand will take one and the square it lands in has to
  // be able to name it.
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

/**
 * What a tile gets the moment somebody makes it armour.
 *
 * Small, and the smallness is the point: armour is subtracted from every blow
 * that lands, so a generous default would make the first thing an author ticks
 * the box on stronger than the mail shirt they were about to write. Two is
 * roughly a padded coat — plainly better than nothing and plainly not plate.
 */
export const DEFAULT_ARMOR: ArmorItem = {
  type: "armor",
  def: 2,
};

/** The starting backpack's shape, and what a fresh container tile gets. */
export const DEFAULT_CONTAINER: ContainerItem = {
  type: "container",
  size: 4,
  equippable: true,
};

/**
 * Nothing to author, so this exists only so the editor's type select has
 * something to write when somebody picks the arm.
 *
 * Spread at the call site like every other default, out of the same care rather
 * than any real need: an object with no fields cannot be mutated into a
 * different one, but "some defaults are copied and some are shared" is not a
 * rule anybody can keep.
 */
export const DEFAULT_ARTIFACT: ArtifactItem = { type: "artifact" };

/**
 * What a tile gets the moment somebody makes it a shield.
 *
 * Two, matching {@link DEFAULT_ARMOR} and for the same reason: a shield and a
 * padded coat are the two obvious first answers to being hit, and neither should
 * arrive stronger than the thing an author was about to write.
 */
export const DEFAULT_SHIELD: ShieldItem = { type: "shield", def: 2 };

/**
 * Shortest and longest a stone's cooldown may be authored at.
 *
 * The floor is a second, and it is a *design* bound rather than a sanity one:
 * the whole of what decides a caster's rhythm is how recently each stone was
 * used, and a stone that were ready again on the next tick would be a spell with
 * no cost at all. The ceiling is an hour, on the terms
 * {@link MAX_STATUS_DURATION_MS} is: longer than anything worth authoring, and
 * near enough that a typo'd extra digit reads as malformed.
 */
export const MIN_STONE_COOLDOWN_MS = 1_000;
export const MAX_STONE_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Most health one press of a stone may put back.
 *
 * The same bound a consumable's shift is under and the same argument: hit points
 * have no authored ceiling, so this is wide enough for anything worth writing
 * and narrow enough that an extra digit reads as a mistake.
 */
export const MAX_STONE_HEAL = MAX_CONSUMABLE_HP_SHIFT;

/**
 * What a tile gets the moment somebody makes it an arcane stone.
 *
 * A small heal on a short cooldown, because it is the one effect that needs
 * nothing else authored to work: a status arm would open on an id naming
 * nothing and a conjure on a tile that does not exist, and both would make a
 * fresh stone a thing that silently does nothing the first time it is pressed.
 * An author who wants fire is one select away.
 *
 * Ten seconds rather than the minute the shipped stones carry: a default is a
 * thing somebody is about to test, and waiting a minute to find out whether it
 * works is the editor arguing with them.
 */
export const DEFAULT_STONE: ArcaneStoneItem = {
  type: "stone",
  effect: { kind: "heal", hp: 5 },
  cooldownMs: 10_000,
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
 * A disc on the plan and a height either side of it, bounded.
 *
 * Written down once because two kinds of item now reach: a weapon and a stone
 * ask the same question with the same numbers, and the whole reason a spell's
 * range works like a bow's is that it *is* a bow's. A second copy here would be
 * the first place the two could quietly disagree about what sixty-four cells
 * means.
 *
 * Undefaulted, unlike the weapon's use of it: a weapon's reach is a number every
 * weapon has an opinion about, and a stone's is only ever read for one that
 * reaches somebody else. {@link reachOf} is where "absent is an arm's length"
 * is written, and it is the one place either kind is read through.
 */
const reachEntries = v.object({
  cells: v.pipe(v.number(), v.minValue(0), v.maxValue(MAX_REACH_CELLS)),
  height: v.pipe(v.number(), v.minValue(0), v.maxValue(MAX_REACH_HEIGHT)),
});

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
  // Optional, and absent means one-handed — the overwhelmingly common case, and
  // every weapon authored before both hands could hold one thing.
  twoHanded: v.optional(v.boolean()),
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
  reach: v.optional(reachEntries, () => ({ ...MELEE_REACH })),
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

/**
 * Every weapon mastery optional, and body masteries deliberately absent.
 *
 * Built from {@link WEAPON_MASTERIES} rather than written out, on exactly the
 * terms `masteriesSchema` is built from `MASTERIES`: a kind of weapon added to
 * the union should be a kind of blow armour can be authored against, without
 * anybody remembering to come back here.
 */
const weaponResistancesSchema = v.object(
  Object.fromEntries(
    WEAPON_MASTERIES.map((mastery) => [
      mastery,
      v.optional(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(0),
          v.maxValue(MAX_ARMOR_DEF),
        ),
      ),
    ]),
  ) as Record<
    WeaponMastery,
    v.OptionalSchema<
      v.SchemaWithPipe<
        [
          v.NumberSchema<undefined>,
          v.IntegerAction<number, undefined>,
          v.MinValueAction<number, number, undefined>,
          v.MaxValueAction<number, number, undefined>,
        ]
      >,
      undefined
    >
  >,
);

const armorSchema = v.object({
  type: v.literal("armor"),
  // Optional rather than defaulted here, so the parsed shape is the authored
  // one and there stays a single answer to "where is this worn" — see
  // `armorSlotOf`. A schema default would be a second copy of that rule, in the
  // one place a stale copy is hardest to notice.
  slot: v.optional(v.picklist(ARMOR_SLOTS)),
  // Unsigned, unlike a consumable's `hp`: armour that made blows land harder is
  // a curse, and a curse is a status rather than a negative on a worn thing —
  // `../game/combat` subtracts this, so a negative here would read as the
  // attacker's weapon getting better and nothing in the panel would say why.
  def: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(MAX_ARMOR_DEF),
  ),
  // Optional, and absent is the overwhelmingly common case: most armour is the
  // same against everything. An empty object is allowed through rather than
  // refused, on the terms a weapon's empty `requirements` is — it says what no
  // key says, and refusing it would make a round trip through the editor a
  // validation error.
  resist: v.optional(weaponResistancesSchema),
});

/**
 * The discriminator and nothing beside it.
 *
 * Unknown keys are dropped rather than refused, on the terms every other arm
 * here treats them — so a block that used to be a weapon parses clean and its
 * leftover `damage` stops meaning anything the moment the type changes. What
 * actually keeps it out of the file is {@link itemForSave}, which names fields
 * rather than passing a draft through.
 */
const artifactSchema = v.object({ type: v.literal("artifact") });

const shieldSchema = v.object({
  type: v.literal("shield"),
  // Unsigned and bounded on exactly the terms armour's is: a shield that made
  // blows land harder is a curse, and a curse is a status rather than a negative
  // on a held thing.
  def: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(MAX_ARMOR_DEF),
  ),
});

/**
 * One of the three things a stone can be authored to do.
 *
 * A variant rather than a block of optional fields, on exactly the terms
 * {@link itemSchema} is one: a heal cannot carry a tile id and a conjure cannot
 * carry an amount of health, so a half-edited draft is a parse failure here
 * rather than a stone that does two things at once.
 */
const stoneEffectSchema = v.variant("kind", [
  v.object({
    kind: v.literal("heal"),
    // Unsigned, unlike a consumable's `hp`: harming yourself is a status, and a
    // negative here would be a stone that reads as a heal and is a curse.
    hp: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_STONE_HEAL)),
  }),
  v.pipe(
    v.object({
      kind: v.literal("status"),
      on: v.picklist(STONE_SUBJECTS),
      // Whether an id names anything is the catalogue's question, asked where
      // the status is granted — this module resolves no statuses, on exactly the
      // terms a consumable's grants are left alone here.
      ...statusGrantEntries,
    }),
    // The same two rules every other duration override is under, and refused
    // here for the same reason: half an override would have to be ordered
    // against a number from somewhere else.
    v.check((raw) => overrideIsWhole(raw), BOTH_ENDS_MESSAGE),
    v.check((raw) => overrideIsOrdered(raw), ORDERED_MESSAGE),
  ),
  v.object({
    kind: v.literal("conjure"),
    // Whether the id names anything is the catalogue's question too, asked where
    // the placement is made: a stone naming a tile an author has since deleted
    // is out of date rather than corrupt, and it fails as a cast that places
    // nothing rather than as a world that will not load.
    tileId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  }),
]);

const stoneSchema = v.object({
  type: v.literal("stone"),
  effect: stoneEffectSchema,
  // Required and floored, unlike almost everything else optional here: a stone
  // with no cooldown is not a stone somebody forgot to finish, it is a spell
  // with no cost, and there is no defensible number to guess on an author's
  // behalf between a second and an hour.
  cooldownMs: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(MIN_STONE_COOLDOWN_MS),
    v.maxValue(MAX_STONE_COOLDOWN_MS),
  ),
  // Optional, and an empty object allowed through rather than refused — the
  // same tolerance a weapon's requirements block is under, and for the same
  // reason: it says what no key says, and refusing it would make a round trip
  // through the editor a validation error.
  requirements: v.optional(masteriesSchema),
  // Optional and *un*defaulted, unlike a weapon's — see {@link reachEntries}.
  reach: v.optional(reachEntries),
  // Optional, and absent means pressed, which is every stone worth authoring in
  // a hand. Whether a hand will actually take an automatic one is a question
  // about the squares and is asked there.
  automatic: v.optional(v.boolean()),
});

const itemSchema = v.variant("type", [
  weaponSchema,
  armorSchema,
  shieldSchema,
  consumableSchema,
  containerSchema,
  artifactSchema,
  stoneSchema,
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

/** Parsed armour config, or null when this tile is not a piece of it. */
export function resolveArmor(def: TileDef): ArmorItem | null {
  const item = resolveItem(def);
  return item?.type === "armor" ? item : null;
}

/**
 * Whether this tile is a weapon that needs both hands.
 *
 * False for everything that is not a weapon at all, which is what lets the move
 * rules ask it of any instance without narrowing first: a loaf of bread does not
 * need two hands, and neither does a shield.
 */
export function isTwoHanded(def: TileDef): boolean {
  return resolveWeapon(def)?.twoHanded === true;
}

/** Held config for a tile, or null when it is not a shield. */
export function resolveShield(def: TileDef): ShieldItem | null {
  const item = resolveItem(def);
  return item?.type === "shield" ? item : null;
}

/**
 * Parsed stone config for a tile, or null when it is not one.
 *
 * The one question the rest of the game asks about being an arcane stone, and
 * it is a lookup rather than a flag — every square that has to refuse a stone,
 * every rotation that has to skip one and every button that has to draw one goes
 * through here, so no caller is tempted to test the discriminator itself and
 * quietly disagree with the next one.
 */
export function resolveStone(def: TileDef): ArcaneStoneItem | null {
  const item = resolveItem(def);
  return item?.type === "stone" ? item : null;
}

/**
 * Whether this stone fires on its own rather than being pressed.
 *
 * False for everything that is not a stone at all, which is what lets the
 * squares ask it of any tile without narrowing first — the same shape
 * {@link isTwoHanded} has, and for the same reason: a hand refuses an automatic
 * stone and has no opinion about a loaf of bread.
 */
export function isAutomaticStone(def: TileDef): boolean {
  return resolveStone(def)?.automatic === true;
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
/**
 * A weapon's reach, with the default the schema would have applied.
 *
 * Every weapon reaches — the type says so — but a weapon *draft* need not,
 * because a draft is the authored block and the schema's default has not run on
 * it. Nearly every weapon in `tiles.json` predates reach moving off the body and
 * omits the key, so anything reading `weapon.reach` straight off a draft is
 * reading `undefined` for almost all of them.
 *
 * Its own function rather than a `??` at each site because there are three, in
 * two modules, and the one that got it wrong was silent until somebody pressed
 * Save. A fresh object every call, so no two weapons can end up sharing one
 * mutable block — the same care {@link DEFAULT_WEAPON} takes.
 */
export function reachOf(weapon: { reach?: Reach }): Reach {
  return { ...MELEE_REACH, ...weapon.reach };
}

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
    //
    // Through `reachOf`, because what arrives is the editor's *draft* — the
    // authored block, never parsed — so the schema's default has not run on it.
    reach: reachOf(weapon),
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
    ...(weapon.twoHanded ? { twoHanded: true } : {}),
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

/**
 * An armour's fields, named, with the zeroes dropped.
 *
 * The same rule a weapon's requirements block is saved under and for the same
 * reason: a resistance of zero is not a resistance, and a breastplate carrying
 * `resist: {}` would read as "resists something" to anybody skimming the file.
 * A draft that has been through the editor collects a key per mastery the moment
 * anybody touches one of the fields, so this is what stops all five reaching
 * disk to say nothing.
 */
function armorForSave(armor: ArmorItem): ArmorItem {
  const resist = Object.fromEntries(
    WEAPON_MASTERIES.filter((mastery) => (armor.resist?.[mastery] ?? 0) > 0).map(
      (mastery) => [mastery, armor.resist?.[mastery]],
    ),
  );
  const slot = armorSlotOf(armor);
  return {
    type: "armor",
    // Written only when it is not the body, on the terms the zeroed resistances
    // above are dropped: absent already says "worn on the chest", and spelling
    // it out would rewrite every armour in the file to say what it said before.
    ...(slot === DEFAULT_ARMOR_SLOT ? {} : { slot }),
    def: armor.def,
    ...(Object.keys(resist).length > 0 ? { resist } : {}),
  };
}

export function itemForSave(item: ItemDef | undefined): ItemDef | undefined {
  if (!item) return undefined;
  if (item.type === "weapon") return weaponForSave(item);
  if (item.type === "armor") return armorForSave(item);
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
  // Nothing to name, and it is still rebuilt rather than passed through: the
  // draft arriving here is whatever the last arm left behind, and an artifact
  // carrying a dead weapon's `damage` onto disk would read as a weapon somebody
  // half-edited.
  if (item.type === "artifact") return { type: "artifact" };
  if (item.type === "shield") return { type: "shield", def: item.def };
  if (item.type === "stone") return stoneForSave(item);
  return {
    type: "container",
    size: item.size,
    equippable: item.equippable,
  };
}

/**
 * A stone's fields, named, with the zeroes and the falsehoods dropped.
 *
 * Rebuilt for the reason every other arm is — a draft carries whatever the last
 * arm left behind — and its effect rebuilt inside that for one more: the three
 * effects are a union too, so a stone switched from a conjure to a heal in the
 * editor is a draft holding both a tile id and an amount of health until this
 * names the fields.
 */
function stoneForSave(stone: ArcaneStoneItem): ArcaneStoneItem {
  // The same rule a weapon's requirements block is saved under: a requirement of
  // zero is not a requirement, and a stone carrying `requirements: {}` would read
  // as "asks something" to anybody skimming the file.
  const requirements = Object.fromEntries(
    MASTERIES.filter((mastery) => (stone.requirements?.[mastery] ?? 0) > 0).map(
      (mastery) => [mastery, stone.requirements?.[mastery]],
    ),
  );

  return {
    type: "stone",
    effect: stoneEffectForSave(stone.effect),
    cooldownMs: Math.round(stone.cooldownMs),
    // Written only when it says something, on the terms a weapon's `twoHanded`
    // is: an explicit `false` on every stone in the file is a field to skim past
    // that says exactly what its absence says.
    ...(stone.automatic ? { automatic: true } : {}),
    ...(Object.keys(requirements).length > 0 ? { requirements } : {}),
    // Written whenever it is stated, and absent stays absent — unlike a weapon's,
    // which is always spelled out. A stone that reaches only its holder has no
    // opinion about range, and writing an arm's length onto one would read as an
    // author having decided something they never thought about.
    ...(stone.reach ? { reach: { ...stone.reach } } : {}),
  };
}

/** One effect, field by field, with a blank id or tile dropping the block. */
function stoneEffectForSave(effect: StoneEffect): StoneEffect {
  if (effect.kind === "heal") return { kind: "heal", hp: Math.round(effect.hp) };
  if (effect.kind === "conjure") {
    return { kind: "conjure", tileId: effect.tileId.trim() };
  }
  const id = effect.id.trim();
  // Both ends or neither — half an override is malformed and the schema refuses
  // it, which is the same walk `statusGrantsForSave` makes over a list.
  return effect.fromMs !== undefined && effect.toMs !== undefined
    ? {
        kind: "status",
        on: effect.on,
        id,
        fromMs: Math.round(effect.fromMs),
        toMs: Math.round(effect.toMs),
      }
    : { kind: "status", on: effect.on, id };
}
