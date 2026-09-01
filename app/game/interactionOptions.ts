import { getStack } from "../lib/mapData";
import type { InteractionKind } from "../lib/interactions";
import {
  DEFAULT_EXTRACT_VERB,
  resolveAddStatus,
  resolveExtract,
  resolveRewardDef,
  resolveSwitch,
  resolveTeleportDef,
  transmuteVerb,
} from "../lib/interactions";
import {
  consumeVerb,
  EQUIP_FALLBACK_VERB,
  equipVerb,
  resolveConsumable,
} from "../lib/item";
import type { MapFile, TileDef } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import {
  canAddStatusFrom,
  canConsumeFrom,
  canOpenFrom,
  canPickUpFrom,
  canPushFrom,
  canRewardFrom,
  canSwitchFrom,
  canTeleportFrom,
  equipSlotFrom,
  INTERACT_LEVEL_SLACK,
  pickUpDestination,
  type EquipSlot,
  type ObjectRef,
} from "./affordances";
import { pileTally } from "../lib/piles";
import { bodyNameFor } from "./displayName";
import type { Equipment } from "./equipment";
import {
  canExtractFrom,
  extractCooldownAt,
  type CoolingResources,
  type ExtractCooling,
} from "./extract";
import { offeredTransmutations } from "./transmute";
import type { ActorSnapshot, PlaySession } from "./GameSession";

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
 * What an entry does. The push/switch pair plus the one thing a body offers.
 *
 * `target` and not `attack`: picking somebody out is its own act now, and
 * whether it turns into blows is attack mode's answer rather than this list's —
 * see {@link GameSnapshot.attacking}. The row is the same row either way, which
 * is the point: you choose who you are interested in once, and change your mind
 * about what to do with them without having to choose again.
 */
export type InteractionAction =
  | InteractionKind
  | "target"
  | "open"
  | "consume"
  /**
   * Putting a thing on where it lies — into a hand, or onto your back.
   *
   * One action rather than three, because a thing has one slot it belongs in
   * (`equipSlotOf`) and the row is named after that slot: "Wield" a sword,
   * "Hold" a torch, "Put on" a pack. Three actions would be three ranks to keep
   * ordered against each other for a choice nothing can ever present twice.
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
  /** Who to point at, for `target`; null for anything the board offers. */
  actorId: string | null;
  /**
   * Which of the tile's recipes this row runs, for `transmute`; null for every
   * other action.
   *
   * The one entry in the list that cannot be addressed by its `ref` alone — a
   * fire offers a row per thing you could cook at it, all on the same
   * placement — so the position of the recipe travels on the row exactly as
   * {@link actorId} does for a target. See `./transmute`'s
   * `offeredTransmutations` for why a position rather than a name.
   */
  recipeIndex: number | null;
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
   * How long before this row can be pressed, and how long the wait was — or
   * null for the rows that can be pressed now, which is nearly all of them.
   *
   * **The one thing in the list that says "not yet" rather than "not here".**
   * Every other refusal takes a row away: a chest you have emptied, a recipe you
   * have nothing to spend on, a crate out of reach. That is right when the
   * answer is about the *world*, because a missing row and a thing that is not
   * worth walking up to are the same fact. It is wrong when the answer is about
   * a clock, because the player did nothing and the row vanished — so a resource
   * on a wait keeps its row, greys it, and runs a bar under it. See
   * `./extract`'s {@link ExtractCooling}.
   *
   * **A row carrying one is not actionable**, and that is the whole of what it
   * means here: {@link topInteractionAt} passes over it, so a tap on the world
   * finds nothing and the outline stays off; {@link applyInteraction} refuses
   * it; and whatever draws the list disables the button. The server refuses it
   * too — this is presentation and never permission.
   *
   * Only an extract has one today. Nothing about the field is extract-shaped
   * though, and the next mechanism that makes a player wait rather than telling
   * them no should use it rather than inventing a second way to be grey.
   */
  cooldown: ExtractCooling | null;
};

const LABELS: Record<InteractionAction, string> = {
  target: "Target",
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
  // The fallback only, on a switch's and a reward's terms: nothing derivable
  // from a tile that hands you a shard says whether you chipped it off or
  // plucked it. See `ExtractInteraction.actionName`.
  extract: DEFAULT_EXTRACT_VERB,
  // Never actually read: a transmute row is named by its *recipe* rather than
  // by its tile — see `transmuteVerb` — because one fire may cook and trade.
  // Present because the record is exhaustive, which is what stops an action
  // being added without somebody deciding what it is called.
  transmute: "Transmute",
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
 * What a caller with no cooling list to offer gets.
 *
 * Everything ready, rather than every resource disabled: a list built without
 * the viewer's waits should show the world as it is and let the far end refuse
 * the one tap that is early, which is strictly better than greying out rows
 * nobody has said are grey.
 */
const NOTHING_COOLING: CoolingResources = { get: () => undefined };

/**
 * What a target row says while the sword is out.
 *
 * The row is the same row — picking somebody out is still one act, and attack
 * mode is still what decides whether it turns into blows — but "Target Rat" is
 * an honest description of a mechanism and a poor description of what is about
 * to happen. People read the list, tapped it, and were surprised to find
 * themselves in a fight, which is the report that put this here: in attack mode
 * the tap *is* the first swing, so the verb says so.
 *
 * A label rather than a second action, deliberately. Two actions would be two
 * ranks to keep in {@link ACTION_ORDER}, two icons, and two paths through
 * {@link applyInteraction} for one press that does one thing.
 */
const ATTACK_LABEL = "Attack";

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
 * Which verb comes first where two entries are the same distance away.
 *
 * Stated rather than left to the id's alphabet. It used to be exactly that
 * accident — "attack" sorted before "push" — and renaming the verb to "target"
 * silently reversed it, which is the whole argument for writing the order down:
 * a body you can both point at and shove offers the fight first because that is
 * the decision with consequences, and nothing about the spelling should be able
 * to change that again.
 */
const ACTION_ORDER: Record<InteractionAction, number> = {
  target: 0,
  // Above everything the board offers, and above `open` in particular: a chest
  // authored as both a reward and a container is one you are meant to be *given*
  // the contents of, and rummaging in it is the lesser reading of the same tap.
  reward: 1,
  // Above the switch, for the reason the session's own precedence puts it
  // there: a door authored to both open and lead through is one tap, and the
  // half that takes you somewhere is the one with consequences.
  teleport: 2,
  switch: 3,
  // Below the switch, on the session's own precedence: this is the only entry
  // here that changes the *presser* rather than the board, so a brazier that
  // both lights a room and burns the hand that lit it spends the tap on the
  // half the player can see.
  addStatus: 4,
  // Below the switch and above everything to do with carrying, which is where
  // an explicit authored act belongs — and it never competes with the tap
  // anyway, since a transmute row is reached by name and a tile that both
  // cooked and swung open would spend its tap on the hinge either way.
  transmute: 5,
  // Below the transmute and above everything to do with carrying, which is
  // where the session's own precedence puts it and for the same reason: an
  // explicit authored act comes before lifting a thing off the floor. It never
  // actually competes with the four above it — nobody authors a door you can
  // also mine — and if they did, the hinge is the half the player can see.
  extract: 6,
  // Above pick-up, and this is the one that decides what a plain tap on a sword
  // does. An empty hand is the strongest thing a player can be saying about what
  // they want done with a weapon on the floor, and stowing it afterwards is one
  // drag; the reverse — fishing a sword back out of a bag you did not mean it to
  // go into — is the annoying direction. It only ever appears when the slot is
  // free, so it cannot take a tap away from anybody who is already armed.
  equip: 7,
  // Above pick-up, and only ever up against it on a container: a pack you are
  // already wearing the twin of can be taken into a hand now, and a tap that
  // picked it up rather than looking inside would be answering the less
  // interesting of the two questions. Nothing else in the game is both.
  open: 8,
  pickUp: 9,
  // Below pick-up on purpose, and pick-up is what a plain tap on the tile runs:
  // eating destroys the thing where lifting it is reversible, so the row you
  // have to *find* is the destructive one and the gesture you can fire by
  // accident is the safe one.
  consume: 10,
  push: 11,
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
 * "First" is {@link ACTION_ORDER}, which is the order the list itself sorts by
 * once distance has been settled — and distance is settled here by construction,
 * since every candidate is the same object.
 */
export function topInteractionAt(
  options: readonly InteractionOption[],
  ref: ObjectRef,
): InteractionOption | null {
  let best: InteractionOption | null = null;
  const key = refKey(ref);
  for (const option of options) {
    if (refKey(option.ref) !== key) continue;
    // A row on a wait is passed over rather than named, and that is what keeps
    // the pointer and the list telling one story: the list draws the row greyed
    // with its bar running, and the world under the cursor offers nothing —
    // which is honest, because a click there would do nothing. Falling through
    // is deliberate too: a resource that is also shovable is still shovable
    // while you wait for it. See {@link InteractionOption.cooldown}.
    if (option.cooldown) continue;
    if (!best || ACTION_ORDER[option.action] < ACTION_ORDER[best.action]) {
      best = option;
    }
  }
  return best;
}

/**
 * How much a floor counts for when sorting by nearness.
 *
 * Big enough that anything on your own floor comes before anything that is not.
 * A body one storey up is drawn a couple of cells away and is nowhere near you,
 * and a list that interleaved the two by screen distance would put a creature
 * through a ceiling between you and the crate at your feet.
 */
const LEVEL_DISTANCE_WEIGHT = 100;

/**
 * Everything the viewer can act on, nearest first.
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
 * @param attacking whether the sword is out, which changes what a body's row is
 *   *called* and nothing else about it. See {@link ATTACK_LABEL}. Defaulted, so
 *   a caller that has no stance to report gets the neutral verb rather than
 *   having to invent an answer.
 * @param cooling the resources this viewer may not work yet, as
 *   `./extract`'s `extractKey`s. Their own, exactly as {@link tags} is theirs:
 *   the bush somebody just picked is still on offer to everybody else.
 *   Defaulted to nothing cooling, so a caller with no wire to hear it over — the
 *   local simulation's own snapshot carries one, but a test need not — gets the
 *   rows rather than having to invent an answer.
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
  attacking: boolean = false,
  cooling: CoolingResources = NOTHING_COOLING,
): InteractionOption[] {
  const bodies = bodiesByCell(self, visibleActors);

  return [
    ...targetOptions(tilesById, bodies, targetId, attacking),
    ...objectOptions(
      map,
      tilesById,
      self,
      bodies,
      equipment,
      openedRef,
      tags,
      cooling,
    ),
  ].sort(
    (a, b) =>
      distanceFrom(self, a.ref) - distanceFrom(self, b.ref) ||
      ACTION_ORDER[a.action] - ACTION_ORDER[b.action] ||
      // Whatever is left is settled by id, so two things equally far off never
      // trade places between frames.
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
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
 * standing for it rather than the placement alone. Almost everywhere those are
 * the same question; the exception is the one the transmute row already makes —
 * a fire offering to cook meat and to cook fish is two entries on one placement
 * wearing two different sprites and names, and a box that merged them would
 * have to pick one of the two to lie with.
 *
 * Order is the list's own, twice over: groups run in the order their first
 * entry does and entries keep their order inside one. Nothing is re-sorted
 * here, so what {@link listInteractionOptions} settled about nearness and about
 * {@link ACTION_ORDER} survives, and the first entry of the first group is
 * still the nearest thing you could do.
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

export function groupInteractionOptions(
  options: readonly InteractionOption[],
): InteractionGroup[] {
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
 * What a group is about: the placement, plus the thing being drawn for it.
 *
 * The tile and the name are in the key rather than assumed to follow from the
 * placement, because for a transmute row they do not — see
 * {@link InteractionGroup}. The name earns its place beside the tile for a
 * body: two people share one tile and are different subjects, and it is the
 * handle that says so.
 */
function subjectKey(option: InteractionOption): string {
  return `${refKey(option.ref)}|${option.tileId}|${option.name}`;
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
 * Run what an entry says it does.
 *
 * Here rather than in the component because it is the one place that knows an
 * entry is a session call, and both routes would otherwise write the same three
 * lines against sessions they hold differently. The list itself knows nothing
 * about pushing or fighting; it hands the option back and this decides.
 *
 * Tapping the one you are already pointing at drops it. That is the only way to
 * clear a target with a thumb — the keyboard has Escape and a touch screen has
 * nothing — and it is why the entry says which one is active at all.
 */
export function applyInteraction(
  session: PlaySession | null,
  option: InteractionOption,
) {
  if (!session) return;
  // Refused here as well as by the session, and by the session as well as by
  // the server — a spell bar's discipline, for its reason: a greyed row that
  // quietly sent anyway would be asking for something the far end is going to
  // throw away, and the grey is a promise that pressing it does nothing.
  if (option.cooldown) return;
  if (option.action === "target") {
    session.setTarget(option.active ? null : option.actorId);
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
  // Named because it has to be: a fire offering three recipes is three rows on
  // one placement, and `interact` has no way to say which. The index is the
  // row's own — see `InteractionOption.recipeIndex`.
  if (option.action === "transmute") {
    if (option.recipeIndex === null) return;
    session.transmute(option.ref, option.recipeIndex);
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

/** Squared plan distance, with a whole floor counting for far more than a cell. */
function distanceFrom(self: ActorSnapshot, ref: ObjectRef): number {
  const dx = ref.x - self.x;
  const dy = ref.y - self.y;
  const dz = (ref.z - self.z) * LEVEL_DISTANCE_WEIGHT;
  return dx * dx + dy * dy + dz * dz;
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
  equipment: Equipment,
  openedRef: ObjectRef | null,
  tags: readonly string[],
  cooling: CoolingResources,
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
              equipment,
              { x, y, z, stackIndex },
              openedRef,
              tags,
              cooling,
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
  equipment: Equipment,
  ref: ObjectRef,
  openedRef: ObjectRef | null,
  tags: readonly string[],
  cooling: CoolingResources,
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
    ? bodyNameFor({ actorId: body.id, tileId: body.tileId }, tilesById)
    : [tilesById[placed.tileId]?.name ?? placed.tileId, tally]
        .filter(Boolean)
        .join(" ");

  const out: InteractionOption[] = [];
  const add = (
    action: InteractionAction,
    label: string,
    active = false,
    cooldown: ExtractCooling | null = null,
  ) => {
    out.push({
      id: `${action}:${refKey(ref)}`,
      action,
      label,
      ref,
      actorId: null,
      recipeIndex: null,
      cooldown,
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
    // tap names — the verb is still "Pick", it simply cannot be pressed yet.
    const cooldown =
      action === "extract" ? extractCooldownAt(map, cooling, ref) : null;
    add(action, objectActionLabel(action, tilesById[placed.tileId]), false, cooldown);
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

  // One row per recipe the player could actually run, which is the only entry
  // in the list that is not one-per-verb-per-thing: a fire that cooks meat and
  // fish offers "Cook Raw Meat" and "Cook Raw Fish", and the verb alone would
  // not tell them apart. So the row is named for what is being *spent* — its
  // sprite and its name are the input's, while its `ref` stays the fire, which
  // is what the outline goes round.
  for (const { index, recipe } of offeredTransmutations(
    map,
    tilesById,
    self,
    equipment,
    ref,
  )) {
    const input = tilesById[recipe.fromTileId];
    out.push({
      // `action:ref` like every other row, plus the recipe — the one id in the
      // list that needs a third part, because one placement offers several.
      // `MAX_TRANSMUTATIONS` keeps the index a single digit, so the string sort
      // that settles ties between equal rows is also the authored order.
      id: `transmute:${refKey(ref)}:${index}`,
      action: "transmute",
      label: transmuteVerb(recipe),
      ref,
      actorId: null,
      recipeIndex: index,
      cooldown: null,
      tileId: recipe.fromTileId,
      name: input?.name ?? recipe.fromTileId,
      health: null,
      active: false,
    });
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
  // The wait is deliberately not asked here. A resource somebody is counting
  // down on is still the row a tap on it names — it simply cannot be pressed
  // yet, which is {@link InteractionOption.cooldown}'s job to say.
  if (canExtractFrom(map, tilesById, self, equipment, ref)) return "extract";
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
function objectActionLabel(
  action: InteractionAction,
  def: TileDef | undefined,
): string {
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
  // The whole of it is the def's too — a resource carries no placement half
  // that could name it differently, only one that says how much is left.
  if (action === "extract") {
    return resolveExtract(def)?.actionName?.trim() || LABELS.extract;
  }
  return LABELS[action];
}

/**
 * One entry per body the viewer can see, and whoever is already being pointed
 * at.
 *
 * **Range is deliberately not consulted.** Tapping a body does not swing at it —
 * it marks it as the target, and attack mode plus the session decide when and
 * whether a blow lands from there. So the question this answers is "who could I
 * single out", and the honest bound on that is what is on screen, not what is
 * already within arm's reach: choosing your target while walking towards it is
 * the normal way a fight starts, and an entry that only appeared once you were
 * beside them would arrive after the decision it exists for.
 *
 * A battler is anything with hit points, which the snapshot already says: `hp`
 * is null for a body that has none.
 */
function targetOptions(
  tilesById: Record<string, TileDef>,
  bodies: Map<string, ActorSnapshot>,
  targetId: string | null,
  attacking: boolean,
): InteractionOption[] {
  const out: InteractionOption[] = [];

  for (const actor of bodies.values()) {
    if (actor.hp === null) continue;

    const ref: ObjectRef = {
      x: actor.x,
      y: actor.y,
      z: actor.z,
      stackIndex: actor.stackIndex,
    };
    out.push({
      id: `target:${actor.id}`,
      action: "target",
      label: attacking ? ATTACK_LABEL : LABELS.target,
      ref,
      actorId: actor.id,
      recipeIndex: null,
      cooldown: null,
      tileId: actor.tileId,
      name: bodyNameFor(
        { actorId: actor.id, tileId: actor.tileId },
        tilesById,
      ),
      health: healthOf(actor),
      active: actor.id === targetId,
    });
  }

  return out;
}
