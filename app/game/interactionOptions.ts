import { getStack } from "../lib/mapData";
import type { InteractionKind } from "../lib/interactions";
import {
  DEFAULT_EXTRACT_VERB,
  resolveAddStatus,
  resolveRemoveStatus,
  resolveExtract,
  resolveRewardDef,
  resolveSetSpawn,
  resolveSwitch,
  resolveTeleportDef,
  craftVerb,
  DEFAULT_CRAFT_VERB,
} from "../lib/interactions";
import { consumeVerb, EQUIP_FALLBACK_VERB, equipVerb, resolveConsumable } from "../lib/item";
import type { Coord, MapFile, TileDef } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import type { Progress } from "./progress";
import {
  canAddStatusFrom,
  canRemoveStatusFrom,
  canConsumeFrom,
  canTalkFrom,
  canOpenFrom,
  canPickUpFrom,
  canPushFrom,
  canRewardFrom,
  canSetSpawnFrom,
  canSwitchFrom,
  canTeleportFrom,
  equipSlotFrom,
  INTERACT_LEVEL_SLACK,
  pickUpDestination,
  type EquipSlot,
  type ObjectRef,
} from "./affordances";
import { conjuredName } from "./conjured";
import { combatantOf, mayHarm } from "./pvp";
import { engravedName } from "../lib/engraving";
import { pileTally } from "../lib/piles";
import { bodyNameFor, bodyNameIn } from "./displayName";
import type { Equipment } from "./equipment";
import {
  extractFits,
  extractOfferedAt,
  extractionAt,
  pullsFreeAt,
  type Extraction,
} from "./extract";
import { offeredRecipes } from "./craft";
import type { ActorSnapshot, PlaySession } from "./GameSession";
import type { Conversation } from "./dialogRuntime";
import { hasLineOfSight } from "./sight";

/**
 * Everything the player could do right now, as a list rather than as something
 * to be found by pointing.
 *
 * The world already answers this question — the outline under the cursor is the
 * same answer — but only for one object at a time, and only once you have aimed
 * at it. A thumb has no hover to aim with, so on a phone the affordance was
 * invisible until it was already being used. Reading the same rules out into a
 * list makes what is reachable something you can *see* instead of something you
 * discover, which is as useful with a mouse as it is with a finger.
 *
 * Pure, and deliberately in the same place and on the same terms as
 * `./affordances`: it asks the identical questions the renderer's pick and the
 * server's validation ask, so the list can never offer something a tap would
 * refuse.
 *
 * **One entry per action, and the entries about one thing travel together.**
 * A body you can both shove and fight is two entries, because the verb is what
 * is being scanned for — but it is one body, and saying its name and drawing
 * its sprite twice spends two rows of a narrow column on one creature. So the
 * list is built a verb at a time and read a subject at a time: see
 * {@link groupInteractionOptions}, which is what the panel draws from.
 */

/**
 * What an entry does. The push/switch pair plus the three things a body offers.
 *
 * `target` and `attack` are two rows rather than one row read through a mode.
 * They used to be one: a body offered "Target", and whether pressing it started
 * a fight came from a switch elsewhere on the screen — which nobody found, so
 * nobody could say what their next tap on a creature was going to do. Two rows
 * side by side say it in the only place a player is already looking.
 */
export type InteractionAction =
  | InteractionKind
  | "target"
  /**
   * Single this body out *and* swing at it.
   *
   * Target plus the stance, in one press, because those are the two halves of
   * one decision — see `./GameSession`'s {@link setAttackMode}, which is still
   * where the stance lives and still the server's to honour. Never what a plain
   * press on the world runs: it is the row beside the target, the right mouse
   * button, and space. Pressing it again changes nothing: the way out of a fight
   * is the target beside it, or Escape, and a button that stopped a fight when
   * mashed mid-fight would be the worst possible answer to the gesture people
   * actually make.
   */
  | "attack"
  /**
   * Walk after this body until told otherwise.
   *
   * Beside `target` rather than folded into it, and that separation is the
   * feature: they are two things you can want about one body and every pair of
   * them is meaningful. Chase a rabbit with a sword out, keep up with a friend
   * with it away, or single out the wolf across the room while standing still.
   *
   * The only entry here that never reaches the session or the wire. Following
   * is walking, and walking is already predicted and validated a step at a time
   * — so this presses the same directions a held key does and there is nothing
   * for a server to be told. @see ../game/walkTo
   */
  | "follow"
  | "talk"
  | "open"
  | "consume"
  /**
   * Putting a thing on where it lies — into a hand, or onto your back.
   *
   * One action rather than three, because there is only ever one square on
   * offer — the first free one on `equipSlotsFor`'s list — and the row is named
   * after the *thing* rather than after that square: "Wield" a sword, "Hold" a
   * torch, "Put on" a pack. Three actions would be three ranks to keep ordered
   * against each other for a choice nothing can ever present twice.
   */
  | "equip";

export type InteractionOption = {
  /** Identity across frames, so the list can be diffed rather than compared. */
  id: string;
  action: InteractionAction;
  /**
   * What to call it. "Push" and "Attack" belong to the interaction and are the
   * same everywhere; a switch is named by its author — see
   * {@link SwitchInteraction.actionName} — because only they know whether this
   * half of the door opens or shuts.
   */
  label: string;
  /** The placement to act on. `target` carries one too, for its sprite. */
  ref: ObjectRef;
  /**
   * Who is in the body this row is about — for `target`, `follow` and `talk`,
   * and for a shove at somebody — or null for anything the board offers that
   * nobody is standing in.
   *
   * On the shove row as well as the fight because it is what a subject is
   * *identified* by across frames: a body walks, its placement changes every
   * step, and a row keyed on the placement alone would be a new subject — a
   * new box, remounted under the thumb — every stride. See {@link subjectKey}.
   * Only `target` and `follow` act on it.
   */
  actorId: string | null;
  /** The tile standing for this entry — its front sprite is what gets drawn. */
  tileId: string;
  /** A person by their handle, anything else by what its tile is called. */
  name: string;
  /**
   * How hurt the body this entry acts on is, or null where there is no body —
   * a crate has no health to report.
   *
   * Carried on the entry rather than looked up again by whoever draws it: the
   * list is the one place that already holds the actor, and a second lookup
   * from a component would be a second answer that can disagree with this one.
   *
   * The reading is the same reading the bar over the creature's head is drawn
   * from, which is the point of showing it here at all: a row that says only
   * *what* something is cannot answer "the rat I have nearly killed, or the one
   * that just walked in", and that is the question being asked of a list of
   * bodies you could pick a fight with.
   */
  health: { hp: number; maxHp: number } | null;
  /**
   * The state this row names is the one you are already in — the body you are
   * pointing at, or the box you have open. Rows for things that simply *happen*,
   * like a shove, are never active: there is no state to be in afterwards.
   */
  active: boolean;
  /**
   * Why this row cannot be pressed, or null for the rows that can be, which is
   * nearly all of them.
   *
   * **The one thing in the list that says "not you" rather than "not here".**
   * Every other refusal takes a row away: a chest you have emptied, a recipe you
   * have nothing to spend on, a crate out of reach. That is right when the
   * answer is about the *world*, because a missing row and a thing that is not
   * worth walking up to are the same fact. It is wrong when the answer is about
   * the player, because then the thing is still worth walking up to and the row
   * vanished anyway — so those keep their row, grey it, and say what is in the
   * way. See {@link OptionBlock}.
   *
   * **A row carrying one is not actionable**, and that is the whole of what it
   * means here: {@link topInteractionAt} passes over it, so a tap on the world
   * finds nothing and the outline stays off; {@link applyInteraction} refuses
   * it; and whatever draws the list disables the button. The server refuses it
   * too — this is presentation and never permission.
   *
   * Only an extract has one today. Nothing about the field is extract-shaped
   * though, and the next mechanism that tells a player "not you, not now"
   * should add an arm here rather than inventing a second way to be grey.
   */
  blocked: OptionBlock | null;
  /**
   * The wait before the next blow of the fight this row *is*, or null — which
   * is every row but one.
   *
   * **Only ever on the lit fight row**, because that is the only row that names
   * a wait anybody is serving: a fight row on a body you have not picked is an
   * offer, and drawing a clock on it would promise a blow nobody has asked for.
   * See `../game/GameSession`'s `ActorRuntime.nextBlow` for what the figure is —
   * the longer of the windup and the cooldown, measured against the swing
   * interval, so a fight that has just opened starts the bar half full.
   *
   * Carried by reference rather than copied, exactly as {@link OptionBlock}'s
   * extraction is: the session winds one object in place for the whole wait and
   * replaces it only when the wait changes, so identity is what says a new blow
   * is being waited on and a copy here would throw that away.
   */
  wait: Progress | null;
};

/**
 * Why a row is offered and still cannot be pressed.
 *
 * Three arms, and the split is what each one gives the player to do about it: a
 * pull already running is drawn as a bar filling, one somebody else is making
 * resolves on its own and is said in words, and a refusal about what they are
 * carrying stands until they go and fix it. Nothing here grants anything — see
 * {@link InteractionOption.blocked}.
 */
export type OptionBlock =
  /**
   * This player is part-way through this very pull. See `./extract`'s
   * {@link Extraction}, which is what the bar is a fraction of.
   */
  | { kind: "working"; extraction: Extraction }
  /**
   * Nothing they are carrying could hold what comes out of it.
   *
   * A bag with no square left in it, or no bag at all — one arm for both,
   * because they are one fact to the player, who can see which by looking at
   * what they are wearing.
   */
  | { kind: "noRoom" }
  /**
   * Every pull still in it is one somebody else is already making.
   *
   * The one arm here that is about *other people* rather than about the player,
   * and it earns its row for the reason the others do: the vein is standing
   * there with something left in it, so a row that vanished would read as a
   * crystal that had stopped being a crystal. It resolves itself the moment
   * they finish or are knocked off, which is why it is ranked below
   * {@link noRoom}.
   */
  | { kind: "taken" }
  /**
   * This *is* where they come back — the one respawn point they are already
   * anchored to.
   *
   * The odd one out here, and the difference is worth naming: the three above
   * are reasons a row cannot do what it says, and this is a row that has
   * already been done. Nothing resolves it but walking to another marker, which
   * is why the row carrying it is also *renamed* — see {@link objectActionLabel}
   * — rather than left reading "Set respawn point" with a grey reason beside
   * it. A verb somebody cannot press should not still be asking them to.
   */
  | { kind: "here" };

const LABELS: Record<InteractionAction, string> = {
  target: "Target",
  // What the row beside it does, in the word the rest of the game uses for it.
  attack: "Attack",
  // The verb, not the state: every other row here is named for what pressing it
  // does, and a row reading "Following" would be the one that named a condition.
  // Which of the two it is in is the lit border's job. @see InteractionOption.active
  follow: "Follow",
  // A body with a dialog: one verb, the same on every such body, because what
  // is said is the panel's business and the row only opens it. "Talk to"
  // because `interactionText` puts the name straight after the verb, and
  // "Talk Pie Maker" is not a sentence.
  talk: "Talk to",
  open: "Open",
  pickUp: "Pick up",
  // Only the fallback: an equip row is named for the *thing*, not for the slot
  // it fills. See `equipVerb`.
  equip: EQUIP_FALLBACK_VERB,
  push: "Push",
  switch: "Switch",
  // The fallback only — a consumable's row is named by its author ("Eat",
  // "Drink"), on the same terms a switch's is. See `consumeVerb`.
  consume: "Use",
  // What an unnamed reward reads as. "Take" rather than "Reward", because the
  // fallback has to name what the *player* does, and every other label here
  // does: the tile being a reward is the author's word for it, not theirs.
  reward: "Take",
  // The fallback only, on the same terms a switch's and a reward's are: a
  // portal is "Enter" and a ladder is "Climb", and nothing derivable from a
  // tile that moves you says which. See `TeleportInteraction.actionName`.
  teleport: "Enter",
  // The fallback only, on the same terms: nothing derivable from a tile that
  // leaves you burning says whether you reached into it or knelt at it. See
  // `AddStatusInteraction.actionName`.
  addStatus: "Touch",
  // The fallback only, on the terms the status above is. See
  // `RemoveStatusInteraction.actionName`.
  removeStatus: "Touch",
  // The fallback only, on the same terms: nothing derivable from a tile that
  // changes where you wake up says whether you slept in it or knelt at it. See
  // `SetSpawnInteraction.actionName`. "Mark" rather than "Rest", because the
  // fallback has to name what the *player* does to every tile that could carry
  // the block, and only half of them are things you lie down in.
  setSpawn: "Mark",
  // The fallback only, on a switch's and a reward's terms: nothing derivable
  // from a tile that hands you a shard says whether you chipped it off or
  // plucked it. See `ExtractInteraction.actionName`.
  extract: DEFAULT_EXTRACT_VERB,
  // The fallback only, on a switch's terms: nothing derivable from a tile that
  // turns stones into stones says whether you forge at it or cook at it. See
  // `CraftInteraction.actionName`.
  craft: DEFAULT_CRAFT_VERB,
};

/**
 * What the open row says once the box it names is open.
 *
 * The row is a toggle, so it is named for what pressing it would *do* rather
 * than for what the thing is — the same rule a switch follows, where the label
 * is the authored verb and not the tile. A row that went on saying "Open" beside
 * an open chest would be offering something already true.
 */
const CLOSE_LABEL = "Close";

/**
 * What a caller with no pull of the viewer's own to report gets.
 *
 * Nobody working anything, rather than every resource disabled: a list built
 * without the viewer's own pull should show the world as it is and let the far
 * end refuse the one tap that is wrong, which is strictly better than greying
 * out rows nobody has said are grey.
 */
const NOTHING_EXTRACTING: Extraction | null = null;

/**
 * One entry as a sentence: the verb and what it is about.
 *
 * The list draws these on two lines because it has a column to fill; anything
 * with one line to say it in — the label under the pointer, a tooltip, anything
 * read aloud — says it this way. Written once so "Pick up Rusty Sword" cannot
 * come out as "Rusty Sword: pick up" somewhere else.
 */
export function interactionText(option: InteractionOption): string {
  return `${option.label} ${option.name}`;
}

/**
 * Which of a subject's verbs comes first.
 *
 * Stated rather than left to the id's alphabet. It used to be exactly that
 * accident — "attack" sorted before "push" — and renaming the verb to "target"
 * silently reversed it, which is the whole argument for writing the order down:
 * a body you can both point at and shove offers the fight first because that is
 * the decision with consequences, and nothing about the spelling should be able
 * to change that again.
 */
const ACTION_ORDER: Record<InteractionAction, number> = {
  // Above the target, so a plain tap on a body with a dialog talks to it. That
  // only matters for an NPC authored with both a dialog and hit points: with
  // the target first, a tap on it would pick it out — or, in attack mode, which
  // is where a player starts, swing at it — and the conversation could only be
  // reached from the list. Only offered within `TALK_REACH_CELLS`, so the same
  // NPC tapped from across the room is still targeted.
  talk: 0,
  // **What a plain press on the world runs**, which on a body is picking it out
  // rather than hitting it: the left button chooses and the right button
  // fights, the arrangement every game with a mouse in it uses. A tap on a
  // phone is the left button, so a thumb cannot start a fight by accident
  // either — the row in the list is how it starts one.
  target: 1,
  // Never what a plain press runs, and reached three other ways: the row beside
  // the target in the list, the right button on the world (see
  // `../render/GameRenderer`'s `fightAt`), and space.
  attack: 2,
  // Directly under the pair, which is the only place it can go: they are the
  // rows about the same body and they are read together. Below rather than
  // above because a tap on a body has to be about the body — this order is what
  // a plain tap on the world runs, and a tap that set off walking after a wolf
  // instead of fighting it would be answering a question nobody asked.
  follow: 3,
  // Above everything the board offers, and above `open` in particular: a chest
  // authored as both a reward and a container is one you are meant to be *given*
  // the contents of, and rummaging in it is the lesser reading of the same tap.
  reward: 4,
  // Above the switch, for the reason the session's own precedence puts it
  // there: a door authored to both open and lead through is one tap, and the
  // half that takes you somewhere is the one with consequences.
  teleport: 5,
  switch: 6,
  // Below the switch, on the session's own precedence: this is the only entry
  // here that changes the *presser* rather than the board, so a brazier that
  // both lights a room and burns the hand that lit it spends the tap on the
  // half the player can see.
  addStatus: 7,
  // Directly under its inverse, which it would only meet on a tile authored to
  // do both — and there the status handed over is the half that shows.
  removeStatus: 8,
  // Directly under the status, because it is the same kind of entry — the
  // other one that changes the *presser* rather than the board — and below it
  // because a tile authored as both would be a shrine that blesses you and
  // takes you as its own, and the blessing is the half you can see happen.
  setSpawn: 9,
  // Below the switch and above everything to do with carrying, which is where
  // an explicit authored act belongs — and it never competes with the tap
  // anyway, since a craft row is reached by name and a tile that both
  // cooked and swung open would spend its tap on the hinge either way.
  craft: 10,
  // Below the craft and above everything to do with carrying, which is
  // where the session's own precedence puts it and for the same reason: an
  // explicit authored act comes before lifting a thing off the floor. It never
  // actually competes with the four above it — nobody authors a door you can
  // also mine — and if they did, the hinge is the half the player can see.
  extract: 11,
  // Above pick-up, and this is the one that decides what a plain tap on a sword
  // does. An empty hand is the strongest thing a player can be saying about what
  // they want done with a weapon on the floor, and stowing it afterwards is one
  // drag; the reverse — fishing a sword back out of a bag you did not mean it to
  // go into — is the annoying direction. It only ever appears when the slot is
  // free, so it cannot take a tap away from anybody who is already armed.
  equip: 12,
  // Above pick-up, and only ever up against it on a container: a pack you are
  // already wearing the twin of can be taken into a hand now, and a tap that
  // picked it up rather than looking inside would be answering the less
  // interesting of the two questions. Nothing else in the game is both.
  open: 13,
  pickUp: 14,
  // Below pick-up on purpose, and pick-up is what a plain tap on the tile runs:
  // eating destroys the thing where lifting it is reversible, so the row you
  // have to *find* is the destructive one and the gesture you can fire by
  // accident is the safe one.
  consume: 15,
  push: 16,
};

/**
 * The row a tap on this object runs — the first one the list offers for it.
 *
 * **The pointer and the list are the same list.** Whatever is under the cursor
 * is looked up here, and what comes back decides all three things at once: the
 * colour of the outline, the words in the label over it, and what happens if you
 * click. So a chest that reads "Open Chest" opens, and cannot quietly shove
 * instead — there is no second precedence anywhere to disagree with this one.
 *
 * "First" is {@link ACTION_ORDER}, which is the order the list itself sorts a
 * subject's own rows by — and every candidate here is one subject, so nothing
 * the list ranks above that applies.
 */
export function topInteractionAt(
  options: readonly InteractionOption[],
  ref: ObjectRef,
): InteractionOption | null {
  let best: InteractionOption | null = null;
  const key = refKey(ref);
  for (const option of options) {
    if (refKey(option.ref) !== key) continue;
    // A blocked row is passed over rather than named, and that is what keeps
    // the pointer and the list telling one story: the list draws the row greyed
    // with its reason on it, and the world under the cursor offers nothing —
    // which is honest, because a click there would do nothing. Falling through
    // is deliberate too: a resource that is also shovable is still shovable
    // while you wait for it. See {@link InteractionOption.blocked}.
    if (option.blocked) continue;
    if (!best || ACTION_ORDER[option.action] < ACTION_ORDER[best.action]) {
      best = option;
    }
  }
  return best;
}

/**
 * Where a subject sits in the column, decided before anything about its
 * neighbours is.
 *
 * A tier rather than a distance. The list used to be sorted by squared plan
 * distance on every rebuild, and a rebuild happens on every step anybody takes,
 * so two rats pacing swapped rows continuously and walking past anything
 * shuffled the whole column. On a phone the list is what you tap instead of
 * aiming, and a row that slides under a thumb is a tap on the wrong thing.
 *
 * So distance decides only which of these a subject is in, and inside one the
 * order is the order subjects arrived in — see {@link listInteractionOptions}.
 * A subject moves when it changes tier and at no other time: you target it, it
 * steps up to you, it walks behind a wall, it changes floor.
 */
const TIER = {
  /**
   * What you are already doing: a target, a follow, a conversation, an open
   * box, or the pull you are standing still for. The row is lit for it
   * already; it is first as well, because it is what the list is about while
   * it lasts.
   */
  engaged: 0,
  /** On your floor, in a cell you can act on from where you stand. */
  adjacent: 1,
  /** On your floor, further off, and in sight. */
  inSight: 2,
  /**
   * On your floor, further off, behind something. Still offered and still a
   * target — see the wall case in `targetableActors` — just below what you can
   * see.
   */
  outOfSight: 3,
  /**
   * Another floor. A body one storey up is drawn a couple of cells away and is
   * nowhere near you, and a list that interleaved the two by screen distance
   * would put a creature through a ceiling between you and the crate at your
   * feet.
   */
  otherFloor: 4,
} as const;

/**
 * Squared plan distance within which a cell is one you can act on from where
 * you stand: your own cell, the four neighbours, and the diagonals a pick-up
 * reaches. Every object row is within it by construction, so in practice this
 * tier is "objects, and bodies close enough to shove".
 */
const ADJACENT_DISTANCE_SQUARED = 2;

/**
 * The held position of a subject the previous list did not have. After every
 * subject it did, so a newcomer joins the end of its tier rather than cutting
 * in.
 */
const UNSEEN_SUBJECT_INDEX = Number.MAX_SAFE_INTEGER;

/**
 * Everything the viewer can act on, in tiers, with the order inside a tier
 * held from the last list.
 *
 * The sort is {@link TIER} first, then the subject's position in `previous`,
 * and only for subjects `previous` did not have — which is every subject when
 * nothing is passed — squared plan distance, so a batch appearing together is
 * still nearest first. Then {@link ACTION_ORDER} and the id, between a
 * subject's own rows and, where two subjects are still level, between their
 * leading rows — so a body that offers a fight and a shove stands as one run
 * of rows beside a crate that only offers a shove, rather than the two shoves
 * sorting together. Everything up to the verb belongs to the *subject* rather
 * than the row: a body you have targeted is engaged on its shove row too,
 * because the column draws the two as one box and a box cannot be in two
 * places.
 *
 * Bounded by construction: four neighbouring cells across three floors for the
 * board's own affordances, plus whichever actors the caller has already decided
 * are on screen. Nothing here sweeps the map — the list is rebuilt whenever the
 * board or the player moves, which during a walk is every commit, and an O(map)
 * answer at that rate is the mistake this codebase keeps having to un-make.
 *
 * Motion is not consulted. An actor mid-step cannot act, but an entry that
 * disappeared for the 200ms of every stride would flicker its way through a
 * walk and be unhittable at the end of one; the session re-asks on the tap, so
 * the worst a stale entry can do is nothing at all.
 *
 * @param visibleActors actors the viewer can *see* — on a drawn floor and
 *   inside the view. Attacking is picking a target rather than swinging, so it
 *   is offered at any distance you can point at, and how far the view reaches
 *   is the renderer's question rather than this one's.
 * @param attacking whether the viewer is swinging at whoever they have picked,
 *   which decides *which* of a body's two rows is lit and nothing else: the
 *   rows are the same rows, with the same verbs, in every stance. Defaulted, so
 *   a caller with no stance to report lights the watching one rather than having
 *   to invent an answer.
 * @param extracting the pull this viewer is part-way through, if any — see
 *   `./extract`'s {@link Extraction}. Theirs alone, exactly as {@link tags} is:
 *   what somebody else is half way through mining reaches this list through the
 *   board instead, as the reservation it is holding. Defaulted to none, so a
 *   caller with no wire to hear it over — the local simulation's own snapshot
 *   carries one, but a test need not — gets the rows rather than having to
 *   invent an answer.
 * @param followId who the viewer is walking after, or null. Beside
 *   {@link targetId} and never derived from it: they are two separate choices
 *   about one body, and a follow that came along with a target would take away
 *   the only two combinations anybody asked for — chasing what you are fighting
 *   and keeping up with somebody you are not. The state lives in
 *   `../game/walkTo`, which is the thing doing the walking.
 * @param previous the list as it was last handed over, so subjects still in it
 *   keep their place inside their tier. Defaulted to none, which is the
 *   deterministic order a caller with no history — a test, a first frame —
 *   should get.
 * @param nextBlow the wait before this viewer's next blow, if they are in a
 *   fight — see `./GameSession`'s `GameSnapshot.nextBlow`. Theirs alone on
 *   {@link extracting}'s terms, and handed on by reference for its reason: the
 *   session winds one object in place, and the bar on the row is drawn from it.
 *   Defaulted to none, so a caller with nothing to report gets a fight row with
 *   no clock on it rather than having to invent one.
 */
export function listInteractionOptions(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  self: ActorSnapshot,
  visibleActors: readonly ActorSnapshot[],
  targetId: string | null,
  equipment: Equipment,
  openedRef: ObjectRef | null = null,
  tags: readonly string[] = [],
  spawnAt: Coord | null = null,
  attacking: boolean = false,
  extracting: Extraction | null = NOTHING_EXTRACTING,
  conversation: Conversation | null = null,
  followId: string | null = null,
  previous: readonly InteractionOption[] = [],
  nextBlow: Progress | null = null,
  craftingRef: ObjectRef | null = null,
): InteractionOption[] {
  const bodies = bodiesByCell(self, visibleActors);
  // Who a conjured tile belongs to, named off the bodies this viewer can see —
  // their own included, since the flame in front of them is very often theirs.
  // @see ./conjured's `conjuredName`
  const nameOf = bodyNameIn([self, ...visibleActors], tilesById);

  const options = [
    ...battlerOptions(tilesById, self, bodies, targetId, followId, attacking, nextBlow),
    ...talkOptions(map, tilesById, self, bodies, conversation),
    ...objectOptions(
      map,
      tilesById,
      self,
      bodies,
      nameOf,
      equipment,
      openedRef,
      tags,
      spawnAt,
      extracting,
      craftingRef,
    ),
  ];
  const tiers = tiersBySubject(map, tilesById, self, options);
  const held = subjectOrder(previous);
  const leads = leadsBySubject(options);

  return options
    .map((option) => {
      const subject = subjectKey(option);
      return {
        option,
        subject,
        tier: tiers.get(subject) ?? TIER.otherFloor,
        held: held.get(subject) ?? UNSEEN_SUBJECT_INDEX,
        distance: distanceFrom(self, option.ref),
        lead: leads.get(subject) ?? option,
      };
    })
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        a.held - b.held ||
        a.distance - b.distance ||
        (a.subject === b.subject ? compareRows(a.option, b.option) : compareRows(a.lead, b.lead)),
    )
    .map((ranked) => ranked.option);
}

/** {@link ACTION_ORDER}, then the id, so two rows never trade places on a whim. */
function compareRows(a: InteractionOption, b: InteractionOption): number {
  return (
    ACTION_ORDER[a.action] - ACTION_ORDER[b.action] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Each subject's leading row — the one {@link compareRows} puts first — which
 * is what two otherwise level subjects are compared by, so a subject's rows
 * stay together in the flat list and not only once the column groups them.
 */
function leadsBySubject(options: readonly InteractionOption[]): Map<string, InteractionOption> {
  const leads = new Map<string, InteractionOption>();
  for (const option of options) {
    const subject = subjectKey(option);
    const lead = leads.get(subject);
    if (!lead || compareRows(option, lead) < 0) leads.set(subject, option);
  }
  return leads;
}

/**
 * Each subject's {@link TIER}, the highest any of its rows reaches.
 *
 * Computed once per subject rather than in the comparator, because the sight
 * half is a walk across the board and a comparator runs it n log n times. The
 * engaged flag is the only thing that differs between a subject's rows — the
 * placement, and so the reach and the sight, is the same for all of them —
 * which is why the fold is a minimum and not anything cleverer.
 */
function tiersBySubject(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  self: ActorSnapshot,
  options: readonly InteractionOption[],
): Map<string, number> {
  const tiers = new Map<string, number>();
  for (const option of options) {
    const subject = subjectKey(option);
    const tier = tierOf(map, tilesById, self, option);
    const best = tiers.get(subject);
    if (best === undefined || tier < best) tiers.set(subject, tier);
  }
  return tiers;
}

function tierOf(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  self: ActorSnapshot,
  option: InteractionOption,
): number {
  if (option.active || option.blocked?.kind === "working") return TIER.engaged;
  if (option.ref.z !== self.z) return TIER.otherFloor;
  if (distanceFrom(self, option.ref) <= ADJACENT_DISTANCE_SQUARED) {
    return TIER.adjacent;
  }
  return hasLineOfSight(map, tilesById, self, option.ref) ? TIER.inSight : TIER.outOfSight;
}

/**
 * Where each subject stood in a list, by the key the column groups on, so the
 * thing being held in place is the box the player is looking at and not one
 * row of it.
 */
function subjectOrder(previous: readonly InteractionOption[]): Map<string, number> {
  const order = new Map<string, number>();
  for (const option of previous) {
    const subject = subjectKey(option);
    if (!order.has(subject)) order.set(subject, order.size);
  }
  return order;
}

/**
 * One subject and everything you could do to it, which is how the list is read.
 *
 * The options are built one verb at a time — that is what a player scans for,
 * and it is what keeps a row the same size as its neighbours — but a body you
 * can shove and fight is still one body. Drawn flat, it says "Rat" twice and
 * draws the same sprite twice, which in a column this narrow is a whole row
 * spent repeating what the row above it already said. So the verbs stay
 * separate and the *subject* is said once.
 *
 * Grouped by what the entry is **about**, which is its placement and the thing
 * standing for it rather than the placement alone. Today those are the same
 * question everywhere; the tile and name stay in the key so that a row which
 * one day wears a different sprite from its placement gets a box of its own
 * rather than one that has to pick a sprite to lie with.
 *
 * Order is the list's own, twice over: groups run in the order their first
 * entry does and entries keep their order inside one. Nothing is re-sorted
 * here, so what {@link listInteractionOptions} settled about tiers, about
 * held positions and about {@link ACTION_ORDER} survives, and the first entry
 * of the first group is still the thing you are engaged with, or failing that
 * the first thing in reach.
 */
export type InteractionGroup = {
  /** Identity across frames, on the same terms an option's id is. */
  key: string;
  /**
   * The entries, in list order. Never empty — a group exists because an entry
   * put it there.
   */
  options: InteractionOption[];
};

export function groupInteractionOptions(options: readonly InteractionOption[]): InteractionGroup[] {
  const groups: InteractionGroup[] = [];
  const byKey = new Map<string, InteractionGroup>();

  for (const option of options) {
    const key = subjectKey(option);
    const existing = byKey.get(key);
    if (existing) {
      existing.options.push(option);
      continue;
    }
    const group: InteractionGroup = { key, options: [option] };
    byKey.set(key, group);
    groups.push(group);
  }

  return groups;
}

/**
 * What a group is about: the body, or failing that the placement, plus the
 * thing being drawn for it.
 *
 * A body is keyed by who is in it rather than by where it stands, because it
 * moves: keyed on the placement, a walking deer was a fresh subject every
 * step, which remounted its box under the pointer and made "the place it held
 * last time" a place it never held. The placement is the key for everything
 * else, which does not walk. The tile and the name are in the key rather than
 * assumed to follow from either — see {@link InteractionGroup}.
 */
function subjectKey(option: InteractionOption): string {
  const subject = option.actorId ?? refKey(option.ref);
  return `${subject}|${option.tileId}|${option.name}`;
}

/**
 * The entry a group is drawn from — its sprite, its name, and what is left of
 * it. The first, which is the list's own answer to "the most interesting thing
 * about this": see {@link ACTION_ORDER}.
 *
 * Written here rather than read off `group.options[0]` at the point of use so
 * that a group is never indexed into by a caller that would then have to know
 * it cannot be empty.
 */
export function groupSubject(group: InteractionGroup): InteractionOption {
  return group.options[0];
}

/**
 * One box's verbs, cut into the lines they are drawn on.
 *
 * **One verb per line everywhere except on a body, where fighting and watching
 * share one.** They are the two positions of a single decision about that
 * creature, and stacking them read as two unrelated things you might do — which
 * is the reading that had people pressing "Target" and wondering why nothing was
 * happening. Side by side, the pair is one control with two ends, and which end
 * you are at is which one is lit.
 *
 * Written here rather than in the component because the adjacency it relies on
 * is {@link ACTION_ORDER}'s: the pair sorts together, so a row is closed by the
 * first verb that is not one of them. Order inside the line is stated rather
 * than inherited — watching on the left, fighting on the right, so the pair
 * reads as an escalation in the direction it is read.
 */
export function actionRows(options: readonly InteractionOption[]): InteractionOption[][] {
  const rows: InteractionOption[][] = [];
  let pair: InteractionOption[] | null = null;

  for (const option of options) {
    if (option.action !== "attack" && option.action !== "target") {
      pair = null;
      rows.push([option]);
      continue;
    }
    if (!pair) {
      pair = [];
      rows.push(pair);
    }
    if (option.action === "target") pair.unshift(option);
    else pair.push(option);
  }

  return rows;
}

/**
 * Every line of the list, top to bottom across all its boxes — the order the
 * number keys count in.
 *
 * Written here beside {@link actionRows} rather than in the component, because
 * two readers need the same answer: the list, to draw a digit beside each line,
 * and the key handler, to find the line a digit names. Worked out twice, the
 * badge and the press could disagree about which line is "3".
 */
export function listedActionRows(options: readonly InteractionOption[]): InteractionOption[][] {
  return groupInteractionOptions(options).flatMap((group) => actionRows(group.options));
}

/**
 * Which entry a key pressed on a line runs, or null for a line nothing on it
 * can run.
 *
 * A line of one verb runs that verb. **The watch-or-fight pair walks along
 * itself**: nobody picked runs the watch end, so the first press on a body picks
 * it without swinging; watching runs the fight end; fighting runs the fight end
 * again, which stops the fight and keeps the body (see {@link applyInteraction}).
 * So the second and later presses are exactly what space does to whoever is
 * picked, and the first press is the one thing space never does — choose a body.
 */
export function rowPress(row: readonly InteractionOption[]): InteractionOption | null {
  const watch = row.find((option) => option.action === "target");
  const fight = row.find((option) => option.action === "attack");
  if (watch && fight) return watch.active || fight.active ? fight : watch;
  const only = row[0];
  if (!only || only.blocked) return null;
  return only;
}

/**
 * Where a follow is turned on and off.
 *
 * A shape rather than the renderer itself, because that is the whole of what
 * this file needs from it and naming the class here would have the interaction
 * list importing the thing that draws it. `../render/GameRenderer` satisfies it
 * by having the method.
 */
export type Follower = {
  /** Walk after this body until told otherwise, or stop. @see ../game/walkTo */
  setFollow(actorId: string | null): void;
  /**
   * Open the crafting window on this crafter, or close it. The window is the
   * client's own — which recipes you can afford is worked out on this side
   * from the kit it already holds — so like following it never reaches a
   * session until a recipe inside it is pressed.
   */
  setCrafting(ref: ObjectRef | null): void;
};

/**
 * Run what an entry says it does.
 *
 * Here rather than in the component because it is the one place that knows an
 * entry is a session call, and both routes would otherwise write the same three
 * lines against sessions they hold differently. The list itself knows nothing
 * about pushing or fighting; it hands the option back and this decides.
 *
 * @param follower who does the walking, for the one row that is not the board's
 *   business. Optional, and a route that leaves it out simply has a follow row
 *   that does nothing rather than a crash — the same trade every defaulted
 *   argument in this file makes.
 */
export function applyInteraction(
  session: PlaySession | null,
  option: InteractionOption,
  follower: Follower | null = null,
) {
  // Refused here as well as by the session, and by the session as well as by
  // the server — a spell bar's discipline, for its reason: a greyed row that
  // quietly sent anyway would be asking for something the far end is going to
  // throw away, and the grey is a promise that pressing it does nothing.
  // First of all, because it is true of every row including the one below that
  // never reaches a session at all.
  if (option.blocked) return;
  // Ahead of the session check, because this is the one row that has nothing to
  // do with a session: following is walking, and walking is a client's own
  // business until the steps go over the wire. @see InteractionAction
  if (option.action === "follow") {
    follower?.setFollow(option.active ? null : option.actorId);
    return;
  }
  // The same, for the same reason: the row opens a window, and the window is
  // this side's. Pressing it again while lit closes it, on Talk's terms.
  if (option.action === "craft") {
    follower?.setCrafting(option.active ? null : option.ref);
    return;
  }
  if (!session) return;
  // The two halves of one decision, and the pair is why neither has to ask what
  // the other left behind: fighting says who *and* that you are swinging, and
  // watching says who and that you are not. Nothing can end up swinging at
  // somebody it never picked, which is exactly what the old mode allowed.
  if (option.action === "attack") {
    // **Pressing the lit one stops the fight without letting the body go**, and
    // the watch row beside it lights instead. The same toggle the keyboard's
    // half has always been — see `../render/GameRenderer`'s `toggleSwing` — and
    // the reason both ends of the pair now answer a second press: a row that is
    // lit and does nothing when pressed is a row nobody can tell from a dropped
    // tap. Backing out of a fight without losing sight of what you backed out
    // of is what {@link PlaySession.setAttackMode} is for.
    if (option.active) {
      session.setAttackMode(false);
      return;
    }
    session.setTarget(option.actorId);
    session.setAttackMode(true);
    return;
  }
  if (option.action === "target") {
    // Pressing the lit one drops the body. That is the only way to let go of a
    // target with a thumb — the keyboard has Escape and a touch screen has
    // nothing — and it is why the row says which one is active at all.
    session.setTarget(option.active ? null : option.actorId);
    session.setAttackMode(false);
    return;
  }
  // Opens the panel; pressing it again while lit closes it, on the target's
  // own thumb-friendly terms. Everything said after is the panel's, through
  // the same verb.
  if (option.action === "talk") {
    session.talk(option.active ? { kind: "close" } : { kind: "open", ref: option.ref });
    return;
  }
  // Named rather than left to `interact`'s precedence. The row says "Pick up",
  // and a row that ran whatever the tap would have chosen would be lying on any
  // tile that is both an item and something else.
  if (option.action === "pickUp") {
    session.pickUp(option.ref);
    return;
  }
  // Named for the same reason, and more sharply: `interact` would try this
  // first anyway, but a row saying "Wield" has to wield rather than run
  // whatever the precedence currently happens to put in front.
  if (option.action === "equip") {
    session.equip(option.ref);
    return;
  }
  // Named for the same reason pick-up is: the row says "Eat", and `interact`'s
  // precedence would have the tap lift the thing into a bag instead.
  if (option.action === "consume") {
    session.consume({ kind: "floor", ref: option.ref });
    return;
  }
  // `open` never reaches here — it is panel state, and the view intercepts it
  // before handing anything to the session. See `GameViewport`.
  if (option.action === "open") return;
  session.interact(option.ref);
}

function refKey(ref: ObjectRef): string {
  return `${ref.x},${ref.y},${ref.z},${ref.stackIndex}`;
}

/**
 * Who is standing where, so a shove and a swing at the same body agree on what
 * to call it.
 *
 * Without this the push entry for another player would be named after their
 * *tile* — "Player" — beside an attack entry naming the person in it. The body
 * is what answers the question, exactly as it does for a name tag and for
 * speech, so both entries ask it the same way.
 *
 * The viewer's own body is left out: they are neither somebody to fight nor,
 * standing on themselves, somebody to shove.
 */
function bodiesByCell(
  self: ActorSnapshot,
  visibleActors: readonly ActorSnapshot[],
): Map<string, ActorSnapshot> {
  const bodies = new Map<string, ActorSnapshot>();
  for (const actor of visibleActors) {
    if (actor.id === self.id) continue;
    bodies.set(refKey(actor), actor);
  }
  return bodies;
}

/**
 * What a body has left, or null for one that has none to lose.
 *
 * Both halves or neither: the snapshot promises `maxHp` is null exactly when
 * `hp` is, and reading them as a pair here means nothing downstream has to
 * carry a half-answer it cannot draw.
 */
function healthOf(actor: ActorSnapshot): { hp: number; maxHp: number } | null {
  if (actor.hp === null || actor.maxHp === null) return null;
  return { hp: actor.hp, maxHp: actor.maxHp };
}

/**
 * Squared plan distance. Floors are not in it: which floor a thing is on is a
 * {@link TIER}, so by the time two things are being compared by distance they
 * are on the same one.
 */
function distanceFrom(self: ActorSnapshot, ref: ObjectRef): number {
  const dx = ref.x - self.x;
  const dy = ref.y - self.y;
  return dx * dx + dy * dy;
}

/**
 * One entry per reachable object, carrying what a tap would actually run.
 *
 * A tile can be authored with both a switch and a push, and `PlaySession.interact`
 * tries the switch first — so listing both would put an entry on screen that does
 * something other than what it says. The precedence is read here rather than
 * restated: whichever the tap would take is the one named.
 */
function objectOptions(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  self: ActorSnapshot,
  bodies: Map<string, ActorSnapshot>,
  nameOf: (actorId: string) => string | null,
  equipment: Equipment,
  openedRef: ObjectRef | null,
  tags: readonly string[],
  spawnAt: Coord | null,
  extracting: Extraction | null,
  craftingRef: ObjectRef | null,
): InteractionOption[] {
  const out: InteractionOption[] = [];
  const zMin = Math.max(MIN_LEVEL, self.z - INTERACT_LEVEL_SLACK);
  const zMax = Math.min(MAX_LEVEL, self.z + INTERACT_LEVEL_SLACK);

  // The 3×3 around the actor, their own cell included, because reaching for a
  // thing is round (see `REACH_CELLS`) where a shove is orthogonal. Still
  // bounded by construction — nine cells across three floors, and nothing here
  // ever sweeps the map.
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const x = self.x + dx;
      const y = self.y + dy;

      for (let z = zMin; z <= zMax; z++) {
        // Every slot, and the affordances decide. Which of them a cell actually
        // offers is `./affordances`' question and it has three different
        // answers — a flat thing does not bury what is under it, a body buries
        // nothing at all, and a shove reaches under anything because the column
        // rides with it — so restating any of them here would be a second
        // opinion that can disagree. A stack is a handful of tiles and this is
        // nine cells across three floors; nothing here sweeps the map.
        const stack = getStack(map, x, y, z);
        for (let stackIndex = 0; stackIndex < stack.length; stackIndex++) {
          out.push(
            ...slotOptions(
              map,
              tilesById,
              self,
              bodies,
              nameOf,
              equipment,
              { x, y, z, stackIndex },
              openedRef,
              tags,
              spawnAt,
              extracting,
              craftingRef,
            ),
          );
        }
      }
    }
  }

  return out;
}

/** Every row one slot of one cell offers. */
function slotOptions(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  self: ActorSnapshot,
  bodies: Map<string, ActorSnapshot>,
  nameOf: (actorId: string) => string | null,
  equipment: Equipment,
  ref: ObjectRef,
  openedRef: ObjectRef | null,
  tags: readonly string[],
  spawnAt: Coord | null,
  extracting: Extraction | null,
  craftingRef: ObjectRef | null,
): InteractionOption[] {
  const placed = getStack(map, ref.x, ref.y, ref.z)[ref.stackIndex];
  if (!placed) return [];
  // Your own body is the one subject that is never worth a row: everything the
  // list offers is something to do to something *else*, and the tile a player
  // stands in happens to be shovable.
  if (placed.owner === self.id) return [];

  const body = bodies.get(refKey(ref));
  // "Pick up Berry ×3", so the row says what taking it would actually get you —
  // the same phrasing the look label and the bag square use. A body never
  // carries a count, which is why the tally is only on this arm. See
  // `../lib/piles`' `pileTally`.
  const tally = pileTally(placed);
  const name = body
    ? bodyNameFor(body, tilesById)
    : [
        // Whoever conjured it in front of the name, so the row reads "Touch
        // Green Fox's Arcane Flame" — the same answer the look label gives,
        // through the same call. @see ./conjured's `conjuredName`
        conjuredName(
          engravedName(tilesById[placed.tileId]?.name ?? placed.tileId, placed.engraved),
          placed,
          nameOf,
        ),
        tally,
      ]
        .filter(Boolean)
        .join(" ");

  const out: InteractionOption[] = [];
  const add = (
    action: InteractionAction,
    label: string,
    active = false,
    blocked: OptionBlock | null = null,
  ) => {
    out.push({
      id: `${action}:${refKey(ref)}`,
      action,
      label,
      ref,
      actorId: body?.id ?? null,
      blocked,
      wait: null,
      tileId: placed.tileId,
      name,
      // A shove at a creature reports its health for the same reason the fight
      // does: it is the same creature, and which of two identical rats this row
      // means is the question a bar answers. A crate has none.
      health: body ? healthOf(body) : null,
      active,
    });
  };

  // The one thing a tap would run, named by what it would actually be — the
  // precedence is read out of the session's own order rather than restated here.
  const equipSlot = equipSlotFrom(map, tilesById, self, ref, equipment);
  const stow = pickUpDestination(map, tilesById, self, ref, equipment) != null;
  const action = objectAction(map, tilesById, self, ref, equipment, tags, equipSlot);
  if (action) {
    // The one row that can arrive already disabled. Read here rather than
    // inside `objectAction`, because it is not part of deciding *which* verb a
    // tap names — the verb is still "Pick", it simply cannot be pressed.
    const blocked =
      action === "extract"
        ? extractBlock(map, tilesById, self, equipment, ref, extracting)
        : action === "setSpawn"
          ? spawnBlock(ref, spawnAt)
          : null;
    add(
      action,
      // **The block renames this one rather than annotating it.** Every other
      // grey row keeps its verb and takes a reason beside it, because the verb
      // is still what pressing it would do once the reason lifts. Nothing lifts
      // this one — it says the press has already happened — so a row still
      // reading "Set respawn point" would be asking for something the player
      // has. @see OptionBlock's `here` arm.
      blocked?.kind === "here"
        ? SPAWN_HERE_LABEL
        : objectActionLabel(action, tilesById[placed.tileId]),
      false,
      blocked,
    );
  }

  // Beside a tap that would arm you, the row that merely puts the thing away:
  // "Wield" and "Pick up" are different things to want. They can never mean the
  // same slot — `pickUpDestination` reaches for a hand only once the equip row
  // has none to offer — so neither row has to ask about the other.
  if (action === "equip" && stow) add("pickUp", LABELS.pickUp);

  // And, beside it, opening — which is not something a tap runs at all. A bag on
  // the floor is therefore two rows, "Open" and "Pick up", which is the same
  // one-row-per-verb rule bodies already follow.
  //
  // One row for both halves of the toggle, lit and renamed while it is the box
  // you have open. A second "Close" row beside the first would be two entries
  // for one box, and the list's whole promise is that a row is a thing you can
  // do to a thing you can see.
  if (canOpenFrom(map, tilesById, self, ref)) {
    const isOpen = openedRef != null && refKey(openedRef) === refKey(ref);
    add("open", isOpen ? CLOSE_LABEL : LABELS.open, isOpen);
  }

  // One row per crafter, whatever it offers, and only while something on it is
  // affordable: the recipes live in a window behind the row, on Talk's terms,
  // because a forge with ten of them would otherwise be ten rows crowding
  // everything else in reach. Lit and left named while its window is the one
  // open, on Talk's terms too — the verb is still what pressing it does.
  const offered = offeredRecipes(map, tilesById, self, equipment, ref);
  if (offered) {
    const isCrafting = craftingRef != null && refKey(craftingRef) === refKey(ref);
    add("craft", craftVerb(offered.craft), isCrafting);
  }

  // The other beside-a-tap row: a cherry on the floor is "Pick up" and "Eat",
  // one row per verb exactly as a bag on the floor is. The verb is the
  // author's — see `ConsumableItem.label` — because nothing derivable from the
  // tile says whether this is drunk or eaten.
  if (canConsumeFrom(map, tilesById, self, ref)) {
    const def = tilesById[placed.tileId];
    const consumable = def ? resolveConsumable(def) : null;
    add("consume", consumable ? consumeVerb(consumable) : LABELS.consume);
  }

  return out;
}

/**
 * What is standing between this player and a pull, or null when nothing is.
 *
 * **Ranked, and the order is what makes each answer worth reading.** The pull
 * they are already making comes first, because that is what the row is drawing
 * and everything else about it is beside the point while it runs. Then the bag,
 * because a refusal about what they are carrying stands until they go and fix
 * it. Then the reservation, last, because it is the only one that resolves
 * itself: a row saying "in use" while the bag was full would be pointing at
 * somebody else's problem instead of theirs.
 *
 * Whichever is shown, the others are still true and still checked — this
 * decides what the row *says*, and `./extract`'s `canBeginExtract` decides what
 * may happen.
 */
function extractBlock(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  self: ActorSnapshot,
  equipment: Equipment,
  ref: ObjectRef,
  extracting: Extraction | null,
): OptionBlock | null {
  const extract = extractOfferedAt(map, tilesById, self, ref);
  if (!extract) return null;
  const mine = extractionAt(map, extracting, ref);
  if (mine) return { kind: "working", extraction: mine };
  if (!extractFits(extract, tilesById, equipment)) return { kind: "noRoom" };
  if (pullsFreeAt(map, tilesById, extract, ref) <= 0) return { kind: "taken" };
  return null;
}

function objectAction(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  self: ActorSnapshot,
  ref: ObjectRef,
  equipment: Equipment,
  tags: readonly string[],
  equipSlot: EquipSlot | null,
): InteractionAction | null {
  if (canRewardFrom(map, tilesById, self, ref, equipment, tags)) return "reward";
  // Asked against the viewer's *own* body, because whether the far end has room
  // is a question about who is making the trip — see `teleportFits`. The list
  // is built for one viewer, so the one body it could ever mean is theirs.
  const selfDef = tilesById[self.tileId];
  if (selfDef && canTeleportFrom(map, tilesById, self, ref, selfDef)) {
    return "teleport";
  }
  if (canSwitchFrom(map, tilesById, self, ref)) return "switch";
  if (canAddStatusFrom(map, tilesById, self, ref)) return "addStatus";
  if (canRemoveStatusFrom(map, tilesById, self, ref)) return "removeStatus";
  // Below the status, on the session's own precedence. Whether pressing it
  // would actually *move* the mark is not asked: the row names what a tap on
  // this tile is for, and a bed you are already anchored to is still a bed.
  if (canSetSpawnFrom(map, tilesById, self, ref)) return "setSpawn";
  // Neither the pull in progress nor the room is asked here. A resource
  // somebody is already working — or that this player has nowhere to put — is
  // still the row a tap on it names; it simply cannot be pressed, which is
  // {@link InteractionOption.blocked}'s job to say.
  if (extractOfferedAt(map, tilesById, self, ref)) return "extract";
  if (equipSlot) return "equip";
  if (canPickUpFrom(map, tilesById, self, ref, equipment)) return "pickUp";
  if (canPushFrom(map, tilesById, self, ref)) return "push";
  return null;
}

/**
 * The two actions whose verb is the author's rather than the mechanism's, and
 * they are the same case: a switch is "Open" or "Pull" because only the author
 * knows which half of the door this is, and a reward is "Open" or "Receive"
 * because only they know whether it is a box or a person.
 */
function objectActionLabel(action: InteractionAction, def: TileDef | undefined): string {
  if (!def) return LABELS[action];
  // Named for the thing rather than for the square it lands in — see
  // `equipVerb`. Both hands take anything now, so a verb read off the slot
  // would have to call putting a pack in your fist "wielding" it.
  if (action === "equip") return equipVerb(def);
  if (action === "switch") {
    return resolveSwitch(def)?.actionName?.trim() || LABELS.switch;
  }
  if (action === "reward") {
    // The def's half, because the verb is the only part of a reward that lives
    // on the tile — what this particular chest gives is on its placement, and
    // the row does not name it.
    return resolveRewardDef(def)?.actionName?.trim() || LABELS.reward;
  }
  // The def's half for the same reason a reward's is: the verb describes the
  // gesture, which is what the tile is, and where this particular portal leads
  // is on its placement.
  if (action === "teleport") {
    return resolveTeleportDef(def)?.actionName?.trim() || LABELS.teleport;
  }
  // The whole of it is the def's, there being no placement half at all — see
  // `resolveAddStatus`.
  if (action === "addStatus") {
    return resolveAddStatus(def)?.actionName?.trim() || LABELS.addStatus;
  }
  if (action === "removeStatus") {
    return resolveRemoveStatus(def)?.actionName?.trim() || LABELS.removeStatus;
  }
  // The whole of it is the def's too, and more completely than any of the
  // above: there is no placement half of this block at all, not even a
  // destination — see `resolveSetSpawn`.
  if (action === "setSpawn") {
    return resolveSetSpawn(def)?.actionName?.trim() || LABELS.setSpawn;
  }
  // The whole of it is the def's too — a resource carries no placement half
  // that could name it differently, only one that says how much is left.
  if (action === "extract") {
    return resolveExtract(def)?.actionName?.trim() || LABELS.extract;
  }
  return LABELS[action];
}

/**
 * What a row on a respawn point reads when it is *the* respawn point.
 *
 * A state rather than a verb, which every other label in this file refuses to
 * be — see {@link LABELS}, where "Follow" is deliberately not "Following". The
 * exception is earned by the row being unpressable: the rule exists so that a
 * row you can press says what pressing it does, and this is the one row in the
 * game that appears only in order to say that pressing it is unnecessary.
 *
 * Reads "You respawn here" rather than naming the marker, because the marker's
 * name is already the heading of the box this row sits in — see
 * `../components/InteractionList`, which draws a subject once and its verbs
 * under it. "Respawn Point / You respawn here" says it; "Respawn Point / You
 * respawn at the Respawn Point" is the same sentence twice.
 */
const SPAWN_HERE_LABEL = "You respawn here";

/**
 * Is this the marker the viewer already comes back to?
 *
 * Asked of **the marker's own cell**, which is what a press would record — see
 * `SetSpawnInteraction`. That makes this the same comparison
 * `GameSession.markSpawn` runs before refusing a move, which is the property
 * worth having: the grey row and the refused press agree because they are one
 * question asked in two places, rather than two questions that happen to line
 * up.
 *
 * Null `spawnAt` is "nothing has told us yet" and never blocks. A grey button
 * that would have worked is a worse lie than a live one that turns out to be a
 * no-op, and the server answers the no-op in words.
 */
function spawnBlock(ref: ObjectRef, spawnAt: Coord | null): OptionBlock | null {
  if (!spawnAt) return null;
  const here = ref.x === spawnAt.x && ref.y === spawnAt.y && ref.z === spawnAt.z;
  return here ? { kind: "here" } : null;
}

/**
 * One entry per body the viewer could talk to, lit for the one they are.
 *
 * Reach is the Talk row's own — `canTalkFrom`, further than an arm and
 * measured in elevation — and it is asked here rather than left to the tap so
 * that a row is offered exactly where pressing it will open a panel. The body
 * has to be somebody's: an authored placement nobody has adopted is scenery
 * shaped like a salesman, and the session would find no actor behind it.
 */
function talkOptions(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  self: ActorSnapshot,
  bodies: Map<string, ActorSnapshot>,
  conversation: Conversation | null,
): InteractionOption[] {
  const out: InteractionOption[] = [];
  for (const actor of bodies.values()) {
    const ref: ObjectRef = { x: actor.x, y: actor.y, z: actor.z, stackIndex: actor.stackIndex };
    if (!canTalkFrom(map, tilesById, self, ref)) continue;
    out.push({
      id: `talk:${actor.id}`,
      action: "talk",
      label: LABELS.talk,
      ref,
      actorId: actor.id,
      blocked: null,
      wait: null,
      tileId: actor.tileId,
      name: bodyNameFor(actor, tilesById),
      health: healthOf(actor),
      active: conversation?.npcId === actor.id,
    });
  }
  return out;
}

/**
 * Three entries per body the viewer can see — fight it, single it out, and walk
 * after it — each saying whether it is the one already in force.
 *
 * **Range is deliberately not consulted.** Tapping a body does not swing at it —
 * it marks it as the target, and attack mode plus the session decide when and
 * whether a blow lands from there. So the question this answers is "who could I
 * single out", and the honest bound on that is what is on screen, not what is
 * already within arm's reach: choosing your target while walking towards it is
 * the normal way a fight starts, and an entry that only appeared once you were
 * beside them would arrive after the decision it exists for.
 *
 * The follow row is under the same bound for a stronger version of the same
 * reason: a body you are beside is the one body there is no point setting off
 * after.
 *
 * All three rows for every battler, with no rule about which pairs with which. A
 * battler is anything with hit points, which the snapshot already says: `hp` is
 * null for a body that has none.
 *
 * **Exactly one of the fight row and the target row is ever lit**, because they
 * are the two positions of one decision about this body: swinging at it, or
 * watching it. Neither is lit for a body that is not the one you have picked.
 *
 * **Two of the three on somebody there is no fight to be had with.** A player
 * who has not opted into fighting other players — or a viewer who has not —
 * gets no fight row, because the row would be a button that does nothing. What
 * is left is watching them and walking after them, which are exactly the two
 * things that still work. @see `./pvp`
 */
function battlerOptions(
  tilesById: Record<string, TileDef>,
  self: ActorSnapshot,
  bodies: Map<string, ActorSnapshot>,
  targetId: string | null,
  followId: string | null,
  attacking: boolean,
  nextBlow: Progress | null,
): InteractionOption[] {
  const out: InteractionOption[] = [];
  const me = combatantOf(self);

  for (const actor of bodies.values()) {
    if (actor.hp === null) continue;

    const ref: ObjectRef = {
      x: actor.x,
      y: actor.y,
      z: actor.z,
      stackIndex: actor.stackIndex,
    };
    const name = bodyNameFor(actor, tilesById);
    const health = healthOf(actor);
    const picked = actor.id === targetId;
    // **No fight row where there is no fight to be had.** Two players who have
    // not both opted in cannot hurt each other, so the row would be a button
    // that does nothing — and this list's whole promise is that a row does what
    // it says. Everything else about the body stays: watching it and walking
    // after it are what you can still do. @see `./pvp`
    const fightable = mayHarm(me, combatantOf(actor));
    const fighting = fightable && picked && attacking;
    if (fightable) {
      out.push({
        id: `attack:${actor.id}`,
        action: "attack",
        label: LABELS.attack,
        ref,
        actorId: actor.id,
        blocked: null,
        // The lit fight row and no other: a fight row on a body nobody has
        // picked is an offer, and a clock drawn on it would be counting down to
        // a blow nobody has asked for. @see {@link InteractionOption.wait}
        wait: fighting ? nextBlow : null,
        tileId: actor.tileId,
        name,
        health,
        active: fighting,
      });
    }
    out.push({
      id: `target:${actor.id}`,
      action: "target",
      label: LABELS.target,
      ref,
      actorId: actor.id,
      blocked: null,
      wait: null,
      tileId: actor.tileId,
      name,
      health,
      // Lit whenever this body is the one picked, unless the fight row beside
      // it is lit instead. With no fight row there is nothing to share the
      // decision with, so a picked body reads as picked however the attack mode
      // happens to be set — which it can be, from a fight with somebody else.
      active: fightable ? picked && !attacking : picked,
    });
    out.push({
      id: `follow:${actor.id}`,
      action: "follow",
      // The same word with a sword out and without one, unlike the target row
      // above. Drawing a weapon changes what pointing at somebody *means* and
      // changes nothing about walking after them.
      label: LABELS.follow,
      ref,
      actorId: actor.id,
      blocked: null,
      wait: null,
      tileId: actor.tileId,
      name,
      health,
      active: actor.id === followId,
    });
  }

  return out;
}
