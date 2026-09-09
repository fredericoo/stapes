import {
  ANY_STATE,
  type BrainCondition,
  type BrainActionDef,
  type BrainConditionDef,
  type BrainDef,
  type BrainTransitionDef,
  type Selector,
  type SpeakerFilter,
} from "../lib/brain";
import { evaluateCondition } from "../lib/conditions";
import type { BattlerDef } from "../lib/battler";
import { DIRECTIONS, type Coord, type Direction } from "../lib/types";
import { DIR_DELTA } from "./movement";
import type { Rng } from "./rng";

/** Floors a creature looks up and down. @see BattlerDef.sight */
export type SightLevels = BattlerDef["sight"];

/**
 * Running a brain for one tick.
 *
 * Kept apart from the session for the same reason `affordances` is: this is a
 * function of a board and a creature's memory, and nothing here knows how a
 * step is committed or how the world is broadcast. The session hands it a
 * context with the few capabilities an action needs and applies whatever comes
 * back.
 */

/**
 * What a selector resolves to: somebody, or something.
 *
 * The two are kept apart all the way through rather than flattened to a
 * coordinate, because the verbs care which they have. `attack` wants a body and
 * has nothing to swing at otherwise; `extract` wants a thing and cannot work a
 * body; the distance conditions want a cell and take either.
 *
 * **A thing is a cell and a tile id, never a stack index.** That is
 * `./extract`'s `extractKey` rule and it is here for its reason: an index
 * shifts the moment anything is placed under it, and what should end a
 * commitment to a bush is the bush ceasing to be a bush. A deer holding a cell
 * that now reads `picked-bush` is holding nothing, which every condition already
 * knows how to answer.
 */
export type Bound =
  | { readonly kind: "body"; readonly id: string }
  | { readonly kind: "thing"; readonly at: Coord; readonly tileId: string };

/** The actor a bound target names, or null when it names a place. */
export function boundBody(bound: Bound | null): string | null {
  return bound?.kind === "body" ? bound.id : null;
}

/**
 * Where a creature is in its machine.
 *
 * Lives on the actor runtime and nowhere else — deliberately absent from the
 * checkpoint, because a world nobody is looking at owes no continuity. A deer
 * that forgets it was halfway through a wander while the room was empty is
 * unfalsifiable, and not persisting it deletes both a serialization surface and
 * the problem of a saved state naming a state an edited brain no longer has.
 */
export type BrainMemory = {
  state: string;
  /** Milliseconds spent in {@link state}, which is all `after` reads. */
  msInState: number;
  /**
   * What this creature has its eye on, as `slot -> body or thing`.
   *
   * Written by a transition's `bind` and read by whatever state it leads to.
   * Outlives the state that set it, deliberately: a chase is one commitment
   * held across several states, not a question re-asked in each. A deer's
   * commitment to one bush out of a hedge of them is the same thing said about
   * a place. @see Bound
   */
  blackboard: Record<string, Bound>;
  /**
   * Every action failed the last time this state had a turn.
   *
   * Recorded rather than asked, because the transition table is consulted
   * *before* the actions run — so what a `stuck` condition reads is the
   * previous tick's verdict. A creature therefore tries once more before giving
   * up, which is a beat rather than a stall, and it is why this is one flag and
   * not a re-run of the whole list from inside the condition.
   *
   * Cleared on the way into a state, so one dead end is never inherited by the
   * state that rescued it.
   */
  stuck: boolean;
  /**
   * How far the action at each position in the current state's `do` list has
   * got — milliseconds waited or steps taken, whichever that action counts.
   *
   * Keyed by position rather than by anything about the action itself, because
   * position is what an author is looking at: two `wait`s in one list are two
   * separate waits, and the same list in another state is a fresh start.
   *
   * Discarded wholesale on leaving a state, and below the selected line on
   * every tick — see {@link stepBrain}. Nowhere near the checkpoint: this is
   * brain state, and brain state does not survive a reload.
   */
  scratch: Record<number, number>;
  /**
   * Whether this creature has ever been ticked.
   *
   * The initial state is entered too, and its `onEnter` is owed the same single
   * firing as any other's — but there is no transition into it to hang that on.
   * This flag is that entry: false until the first tick, which runs the initial
   * effects and flips it. Fresh on every load, so a resumed creature greets its
   * initial state once more, which is the right amount for a mind that resets.
   */
  started: boolean;
  /**
   * Who the `heard` or `heard_noise` condition that just matched was about, for
   * the length of one transition.
   *
   * The plumbing behind the `speaker` selector, and it lives here rather than in
   * the blackboard because it is not a commitment — it is cleared at the top of
   * every tick, so a `bind` reading it on a transition that heard nothing writes
   * nothing. A creature keeps whoever called it by *binding* them to a slot,
   * which is a decision the author makes and can see in the table.
   */
  heardFrom: string | null;
  /**
   * Who hit this creature since its last turn, for the length of one transition.
   *
   * The plumbing behind the `attacker` selector, and it lives beside
   * {@link heardFrom} for the same reason and on the same terms: cleared at the
   * top of every tick, so a `bind` on a transition where nobody swung writes
   * nothing. Holding a grudge is done by *binding* it to a slot, which is a
   * decision the author makes and can see in the table.
   */
  hurtBy: string | null;
};

/**
 * What an action did.
 *
 * The behaviour-tree leaf protocol, and it is the tri-state that earns its
 * keep: `failure` is what lets a priority list fall through to its next line,
 * and `running` is what stops the scan while a body finishes a step it cannot
 * take twice.
 */
export type ActionStatus = "success" | "failure" | "running";

/**
 * The world as one action sees it.
 *
 * Narrow on purpose. An action can look at where it is, roll a die, and ask to
 * move; it cannot reach the map, the other actors, or the session. Widening
 * this is how a registry of small declarative verbs would quietly become a
 * scripting language.
 */
/**
 * Somewhere a creature has set off for.
 *
 * A body or a place, because those are the only two things a selector can name
 * — see {@link Bound}, whose two arms these are once a thing has been resolved
 * to the cell it stands in. The distinction is kept all the way through rather
 * than flattened to a coordinate at the moment of asking, and that is the point
 * of the type: a chase re-reads where its quarry *is* on every leg, so a wolf
 * follows a player across a courtyard instead of walking to where they were
 * standing when it decided.
 */
export type WalkGoal =
  | { readonly of: "body"; readonly id: string }
  | { readonly of: "cell"; readonly at: Coord };

/** What became of a standing walk order. @see BrainContext.walkTo */
export type WalkOrderState = "walking" | "arrived" | "blocked";

/**
 * A placement a search turned up: where it is, and which of the asked-for tiles
 * it turned out to be.
 *
 * The tile travels back because the question may have named several — see
 * {@link Selector}'s `nearest` — and what gets written into a slot is the one
 * thing that answered. A bound "carcass or haunch" that remembered the *list*
 * would still be there after the carcass was eaten.
 */
export type FoundThing = { readonly at: Coord; readonly tileId: string };

export type BrainContext = {
  /** Still finishing a walk, a fall, or a shove. */
  busy: boolean;
  rng: Rng;
  /** Where this creature is standing. */
  self: Coord;
  /**
   * The cell this body was authored on, or null for one the world did not
   * author — every player, and anything seated without a home.
   *
   * A fact about the body rather than a question about the board, which is why
   * it is a field beside `self` and not a method beside `positionOf`: nothing
   * has to be looked up to answer it, and nothing can change it while the
   * creature lives. @see ../lib/brain HOME_SELECTOR
   */
  home: Coord | null;
  /**
   * Nearest other body standing on any of these tiles, or null when there is
   * none — a world with nobody in it, or a creature that is the last of its
   * kind. Nearest across the whole list rather than the first tile that answers,
   * because the list is one question. Never this creature itself.
   */
  nearestOnTile(tileIds: readonly string[]): string | null;
  /**
   * Nearest placement of any of these tiles, or null when there is none near
   * enough — and which tile it turned out to be. @see FoundThing
   *
   * {@link nearestOnTile}'s opposite number — a thing rather than a body — and
   * the one capability here with a search radius baked in rather than passed.
   * The radius is the brain's own `brainReach`, which the session closes over,
   * because a placement further off than the furthest question in the brain
   * cannot change any answer it gives. @see ../lib/brain
   */
  nearestThing(tileIds: readonly string[]): FoundThing | null;
  /** Where an actor is, or null once they are off the board. */
  positionOf(actorId: string): Coord | null;
  /**
   * Is `tileId` still standing at this cell?
   *
   * What makes a bound thing expire. A body is asked after through
   * {@link positionOf}, which answers null once it has left the board; a place
   * cannot leave, so what has to be re-asked is whether it is still the thing
   * that was bound. Both answers feed the same conditions, so a picked bush
   * reads exactly as a quarry that walked off.
   */
  thingStillThere(at: Coord, tileId: string): boolean;
  /**
   * Is this body mid-conversation? What the `talking` condition reads.
   *
   * A question rather than a field, because the answer is the dialog's and the
   * dialog is stepped on the same tick, just ahead of the brain: a greeting
   * heard this pass is a conversation the brain can already act on.
   * @see ./dialogRuntime
   */
  talking(): boolean;
  /**
   * Would stepping this way leave nothing underfoot? The board allows it — that
   * is how walking into a hole works — so refusing is a creature's own caution.
   */
  wouldDrop(direction: Direction): boolean;
  /**
   * Would stepping this way land the body in something that fires on arrival —
   * a flame, a portal? Asked of where the leg *ends*, so a step off a ledge is
   * judged by what is at the bottom of the fall.
   *
   * `./pathfinding`'s `unsafeToStepOn` asked of one leg instead of a whole
   * search, and deliberately the same reading: a bad status or a teleport, a
   * blessing and an unknown id neither. @see footing for why no action opts out.
   */
  wouldStepIntoHazard(direction: Direction): boolean;
  /**
   * Ask to walk one cell. False when the board refuses, which is the whole of
   * how an action learns it is blocked.
   */
  step(direction: Direction): boolean;
  /**
   * Set off for `goal`, and keep going until told otherwise.
   *
   * **The one action here that outlives the turn that asked for it**, and the
   * reason is the clock. A brain decides every `BRAIN_TICK_MS`; an action that
   * pressed one direction per decision therefore took a step per *round*, which
   * rounded every creature's pace up to a whole number of rounds. A bat
   * authored at 90ms walked at 200, a snake authored at 320 walked at 400, and
   * of everything we ship only the cat — authored at exactly 400 — moved at the
   * pace it was written to.
   *
   * So this states an intent rather than taking a step. The session holds it
   * and presses the next leg the moment the body is free, at whatever pace that
   * body walks — see `GameSession.driveWalkOrder`. What the brain keeps is the
   * decision that is actually its own: *whom* to follow, reconsidered every
   * round.
   *
   * **The intent lives exactly one round unless it is asked for again.** Every
   * turn starts with the standing order dropped, so a creature that transitions
   * out of chasing stops chasing rather than walking out a plan the state that
   * wanted it has left. @see GameSession.tickOneBrain
   *
   * Three answers, and the difference between the last two is what a priority
   * list reads: `"walking"` for a body on its way, `"arrived"` for one already
   * standing beside what it wanted, and `"blocked"` for somewhere there is no
   * way to. Only the first is a line that ran. @see ./pathfinding
   */
  walkTo(goal: WalkGoal, allowDrops: boolean | undefined): WalkOrderState;
  /**
   * Set off away from `threat`, and keep going.
   *
   * {@link walkTo}'s opposite number and the same kind of thing — an intent the
   * session holds and presses the legs of — but the question it asks the board
   * is inside out. There is no goal, so what happens is a flood outward from the
   * animal that scores every cell it reaches and runs to the best: furthest from
   * the threat, and out of its sight where two are equally far.
   * @see ./pathfinding's `findRefuge`
   *
   * **The refuge is kept until it is reached or cut off**, which is the half of
   * this that stops the flickering. An animal that re-decided every round took
   * whichever of four cells was momentarily best, and that flips between two of
   * them as the threat moves — a rabbit shuffling on the spot rather than one
   * running. Committing to somewhere is what a run is.
   *
   * Two answers rather than three, and the missing one is the point: arriving is
   * not something this reports, because an animal that reaches its refuge with
   * the threat still about has simply not finished fleeing, and the next flood
   * is run from where it now stands. `"blocked"` is the only failure, and it
   * means genuinely nowhere better than here — the `stuck` an author transitions
   * on to get to a cornered state.
   */
  fleeFrom(threat: Coord, allowDrops: boolean | undefined): WalkOrderState;
  /**
   * Say something over this creature's head.
   *
   * The only capability here that is not a question or a step: an effect, run on
   * the way into a state, that always lands. What becomes of the words — a
   * bubble broadcast to a level, sanitised and capped — is the session's to
   * arrange, on exactly the terms a player's chat already gets.
   */
  say(text: string): void;
  /**
   * Make a noise, which is not the same as saying something.
   *
   * The sibling of {@link say} and the one most creatures want: a hiss or a
   * meow is a sound the room heard, not a line anybody uttered, so it goes out
   * unattributed rather than as "Snake says: sss". @see NoiseEmission
   */
  noise(text: string): void;
  /**
   * Is there a clear line from here to there?
   *
   * A question about the board, so it belongs to whoever holds the board — this
   * side only decides what to do with the answer. @see ./sight
   */
  canSee(at: Coord): boolean;
  /**
   * Floors this creature looks up and down, from its own stat block.
   *
   * Beside `canSee` rather than folded into it, because they answer different
   * halves and only one of them is about the world: `canSee` says whether
   * anything is in the way, and this says whether the creature was ever going to
   * look. A rat under an open sky fails this one and passes that one.
   */
  sight: SightLevels;
  /**
   * Everything said since this creature last had a turn, oldest first.
   *
   * Words and a speaker, nothing more: how far away they were and whether they
   * can be seen are questions this module already knows how to ask, and asking
   * them here keeps `cells` meaning the same thing in every condition.
   *
   * Empty on almost every tick. It is a list rather than the latest line because
   * two people can call a creature between two of its ticks, and dropping one of
   * them would make the machine's behaviour depend on how the brain clock
   * happened to fall.
   */
  heard(): readonly Utterance[];
  /**
   * Every sound made within this creature's earshot since it last had a turn,
   * oldest first — and never one of its own.
   *
   * Its own list rather than utterances with a blank speaker, because a sound is
   * not a degenerate sentence: nothing about it is a word, and the conditions
   * that read the two ask different questions. What they share is the shape of
   * the answer — a maker, resolved to a position through
   * {@link BrainContext.positionOf}, so `cells` means the same thing here as
   * everywhere else.
   *
   * Empty on almost every tick, and a list for the reason {@link heard} is one:
   * two things can make a noise between one brain tick and the next, and
   * dropping either would make behaviour depend on where the brain clock fell.
   */
  heardNoise(): readonly Sound[];
  /**
   * Everybody who has hit this creature since it last had a turn, oldest first.
   *
   * The mirror of {@link heard}, and a list for the same reason: two things can
   * land a blow between one brain tick and the next, and dropping one of them
   * would make who a creature turns on depend on where the brain clock happened
   * to fall. Empty on almost every tick.
   */
  hurtBy(): readonly string[];
  /**
   * Swing at somebody. False when there was nothing to swing at, when they are
   * out of reach, or when this creature is still recovering from its last blow
   * — the three ways the `attack` action falls through to the next line.
   */
  attack(actorId: string): boolean;
  /**
   * Work a thing for what it is made of, and keep working it.
   *
   * True while a pull is being made — started on this turn, or already running
   * from an earlier one. That single answer is what the `extract` action reports
   * as `running`, and running is what stops the priority list from wandering off
   * mid-pick: a pull ends the moment the body moves, so a lower line that
   * stepped would undo the line above it every time.
   *
   * False for every way there is nothing to work: out of reach, spent, every
   * remaining pull held by somebody else, or no room in the bag for the best
   * roll. The action falls through and the author's next line gets its turn.
   * @see ../game/extract
   */
  extract(at: Coord, tileId: string): boolean;
  /**
   * Eat or drink something out of the bag. False when there was nothing to eat.
   *
   * A tile id picks what; absent takes the first consumable in the bag. Both
   * refusals — an empty bag and a body with no hit points for the food to land
   * on — read the same to an author, because both are a line with nothing to
   * offer.
   */
  consume(tileId: string | undefined): boolean;
  /**
   * Eat something lying at a cell. False when it is out of reach, buried, or no
   * longer the thing that was bound.
   *
   * {@link consume}'s other half rather than a widened version of it, because
   * the two cross different lines: this is a board action with the reach and
   * cover a pickup runs, where that one is a kit action. The split is
   * `ConsumeSource`'s own, kept all the way out to here.
   */
  consumeOn(at: Coord, tileId: string): boolean;
  /**
   * Is there something in the bag? What the `carrying` condition reads.
   *
   * A tile id narrows it; absent asks whether the bag holds anything at all.
   * @see ../lib/brain's `carrying`
   */
  carrying(tileId: string | undefined): boolean;
  /**
   * Is a named status running on this body, with at least `atLeastMs` left?
   *
   * What the `status` condition reads. Absent asks only whether it is running.
   * @see ../lib/brain's `status`
   */
  hasStatus(id: string, atLeastMs: number | undefined): boolean;
  /**
   * What to call somebody out loud, or null once they are off the board.
   *
   * The one capability here that exists purely for words. Everything else an
   * action can ask is about position or reach; this is about how a body is
   * *addressed*, which is a question the session already answers for every name
   * tag and every speech bubble. Asking it rather than re-deriving it is what
   * keeps an NPC calling you exactly what the label over your head calls you.
   */
  nameOf(actorId: string): string | null;
};

/** Something somebody said, as a listening brain sees it. */
export type Utterance = {
  /** Who said it. Resolved to a position through {@link BrainContext.positionOf}. */
  speakerId: string;
  text: string;
};

/**
 * Something that made a sound, as a listening brain sees it.
 *
 * The maker rather than the cell it happened in, which is the one decision in
 * this type. A sound is drawn as a thing that happened at a place — see
 * `NoiseEmission`, which is what reaches a screen and carries no maker at all —
 * but a creature going to look for it wants a body to walk towards, and a body
 * moves. Following the place would send a wolf to where the crunch *was* and
 * leave it standing there sniffing the grass.
 */
export type Sound = {
  /** Who made it. Resolved to a position through {@link BrainContext.positionOf}. */
  sourceId: string;
  text: string;
};

export function initialMemory(brain: BrainDef): BrainMemory {
  return {
    state: brain.initial,
    msInState: 0,
    blackboard: {},
    stuck: false,
    scratch: {},
    started: false,
    heardFrom: null,
    hurtBy: null,
  };
}

/**
 * A slot name in braces, anywhere in an authored line.
 *
 * The one place a brain has a syntax rather than a shape, and it is confined to
 * the inside of a sentence — which is the one thing an object could not express,
 * because what an author is positioning is a *word within a line*. The charset
 * is the slot name's own, so `{partner}` is a placeholder and `{ }` or `{3d6}`
 * is text somebody typed.
 */
const SLOT_PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

/**
 * Who a line means when the slot it names is empty.
 *
 * A sentence has to survive its subject going missing: an NPC whose partner
 * logged out mid-word still has to finish saying something, and "I'm busy with
 * {partner}" leaking a brace onto the screen is worse than a vaguer sentence.
 * Deliberately indistinguishable from an author's typo — a misspelt slot is an
 * unbound slot, and at the moment the words are spoken there is nothing to tell
 * them apart.
 */
export const NOBODY = "someone";

/**
 * An authored line with its slots filled in.
 *
 * Slots only, not selectors: the thing worth naming out loud is always somebody
 * the creature has *committed* to, which is exactly what a bind wrote down. A
 * live query would let a line name whoever happened to be nearest as it was
 * spoken, and a sentence whose subject can change between the state deciding to
 * say it and the words appearing is not a sentence anybody meant to author.
 */
function fillSlots(
  text: string,
  memory: BrainMemory,
  ctx: BrainContext,
): string {
  // The overwhelmingly common line has no placeholder at all, and this keeps it
  // from touching the regex on every state entry in the world.
  if (!text.includes("{")) return text;
  return text.replace(SLOT_PLACEHOLDER, (_whole, name: string) => {
    // A thing has no name to say out loud, so it reads as {@link NOBODY} on the
    // same terms an empty slot does — the sentence still has to be a sentence,
    // and "I'm busy with the bush" is not what the placeholder is for.
    const id = boundBody(memory.blackboard[name] ?? null);
    return (id === null ? null : ctx.nameOf(id)) ?? NOBODY;
  });
}

/** Run a state's entry effects — once, when it is entered. */
function runOnEnter(brain: BrainDef, memory: BrainMemory, ctx: BrainContext) {
  const onEnter = brain.states[memory.state]?.onEnter;
  if (!onEnter) return;
  for (const effect of onEnter) {
    const text = fillSlots(effect.text, memory, ctx);
    if (effect.effect === "say") ctx.say(text);
    else ctx.noise(text);
  }
}

/**
 * Directions worth trying at all: never one that lands the body in something.
 *
 * Two refusals with different standing. A ledge is the author's to decide —
 * `allowDrops` is on the action because a bat is meant to fly off one — while a
 * flame or a portal is nobody's: a creature that blunders into fire is not
 * exhibiting a behaviour, and a wander that teleports has ended somewhere the
 * state that started it never considered. That is `./pathfinding`'s argument
 * for `unsafeToStepOn` word for word, so it is settled here rather than
 * authored, and where a creature can end up no longer depends on which action
 * moved it.
 *
 * The ledge check goes first, and the order is the saving: it is one column
 * scan, while a hazard costs a step check and a stack scan on top of it.
 */
function footing(
  directions: Direction[],
  allowDrops: boolean | undefined,
  ctx: BrainContext,
): Direction[] {
  return directions.filter((direction) => {
    if (!allowDrops && ctx.wouldDrop(direction)) return false;
    return !ctx.wouldStepIntoHazard(direction);
  });
}

/**
 * What a selector names, right now.
 *
 * One arm per kind, exhaustively — which is the half of the tagged shape that
 * pays off here: a new kind added to the union is a type error in this switch
 * rather than a selector that silently answers nothing.
 *
 * A `home` is a place the *session* holds rather than one a selector carries,
 * which is why it is the one kind with no arm: it is answered a level up, by
 * {@link locate} and {@link aim}, both of which already have to know the
 * difference between a place and a body. Answering nothing here is what makes
 * `attack: home` fall through and `bind: { x: home }` clear its slot, without
 * either needing a case.
 */
function identify(
  selector: Selector,
  memory: BrainMemory,
  ctx: BrainContext,
): Bound | null {
  switch (selector.type) {
    case "slot":
      return memory.blackboard[selector.data.name] ?? null;
    case "speaker":
      return asBody(memory.heardFrom);
    case "attacker":
      return asBody(memory.hurtBy);
    case "nearest":
      return asBody(ctx.nearestOnTile(selector.data.tileIds));
    case "thing": {
      const found = ctx.nearestThing(selector.data.tileIds);
      // The tile that *answered*, not the list that was asked: what a bound
      // thing has to remember is the one standing there, so a wolf that bound
      // "the nearest carcass or haunch" is committed to the particular thing it
      // found rather than to either of them.
      return found === null
        ? null
        : { kind: "thing", at: found.at, tileId: found.tileId };
    }
    case "home":
      return null;
  }
}

/** An actor id as a bound target, or null for nobody. */
function asBody(id: string | null): Bound | null {
  return id === null ? null : { kind: "body", id };
}

/** Where a selector's subject is, or null when there is nothing to point at. */
function locate(
  selector: Selector,
  memory: BrainMemory,
  ctx: BrainContext,
): Coord | null {
  // The one selector that is a place the session holds rather than one a bind
  // wrote down.
  if (selector.type === "home") return ctx.home;
  return whereIs(identify(selector, memory, ctx), ctx);
}

/**
 * Where a bound target is now, or null once it is gone.
 *
 * Both kinds have a way of going, and both answer null for it: a body walks off
 * the board, and a thing stops being the thing that was bound. That one answer
 * is why a picked bush and a quarry who logged out read identically to every
 * distance condition. @see Bound
 */
function whereIs(bound: Bound | null, ctx: BrainContext): Coord | null {
  if (!bound) return null;
  if (bound.kind === "body") return ctx.positionOf(bound.id);
  return ctx.thingStillThere(bound.at, bound.tileId) ? bound.at : null;
}

/**
 * What a selector names as somewhere to walk to.
 *
 * The sibling of {@link locate}, and the difference between them is the whole
 * of why a chase keeps up: `locate` answers where the subject is *now*, which
 * is what a flight has to measure against, while this answers *what* to follow
 * and leaves the looking-up to whoever presses the next leg. @see WalkGoal
 *
 * A thing is handed over as the cell it stands in, because it is not going
 * anywhere — the re-reading a body needs is exactly what it does not. Its cell
 * is still checked first, so a creature does not set off across a field towards
 * a bush that has since been picked.
 */
function aim(
  selector: Selector,
  memory: BrainMemory,
  ctx: BrainContext,
): WalkGoal | null {
  // The one selector that is a place the session holds, on {@link locate}'s
  // terms.
  if (selector.type === "home") {
    return ctx.home ? { of: "cell", at: ctx.home } : null;
  }
  const bound = identify(selector, memory, ctx);
  if (!bound) return null;
  if (bound.kind === "body") return { of: "body", id: bound.id };
  return ctx.thingStillThere(bound.at, bound.tileId)
    ? { of: "cell", at: bound.at }
    : null;
}

/** Steps apart on the plan, ignoring elevation. */
function stepsApart(a: Coord, b: Coord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Near enough to notice, by this creature's own reckoning.
 *
 * Two questions, and only one of them is about distance. The floors are
 * {@link BattlerDef.sight}: a rat is authored to mind its own storey, so a body
 * on the ledge above is not near it at any distance at all, while a hawk given
 * `{ up: 2, down: 2 }` is watching the whole stairwell. That is a
 * characterisation rather than a fact about the air between them, which is why
 * it lives on the creature and not in `./sight`.
 *
 * The plan distance is unchanged and stays counted in steps rather than as the
 * crow flies — a creature that thinks in cells it could walk is a creature whose
 * behaviour matches the board, and every authored `cells` already means that.
 */
export function within(
  self: Coord,
  other: Coord,
  cells: number,
  sight: SightLevels,
): boolean {
  const dz = other.z - self.z;
  if (dz > sight.up || -dz > sight.down) return false;
  return stepsApart(self, other) <= cells;
}

/** Within `cells` and with nothing in the way. */
function inSight(
  at: Coord | null,
  cells: number,
  ctx: BrainContext,
): at is Coord {
  return at !== null && within(ctx.self, at, cells, ctx.sight) && ctx.canSee(at);
}

/**
 * Whoever just said something matching, near enough to have been heard.
 *
 * Oldest first, and the first match wins: two people calling a cat between one
 * tick and the next is a real race, and resolving it by who spoke first is the
 * only answer that does not depend on iteration order somewhere else.
 *
 * The speaker is remembered for the length of this tick even though the caller
 * only wanted a yes or no — that is how `bind: { caller: "speaker" }` gets an
 * id, and doing it here means the condition and the bind cannot disagree about
 * who was heard.
 */
function heardFrom(
  condition: Extract<BrainConditionDef, { cond: "heard" }>,
  memory: BrainMemory,
  ctx: BrainContext,
): boolean {
  const wanted = condition.text.toLowerCase();
  for (const utterance of ctx.heard()) {
    if (!utterance.text.toLowerCase().includes(wanted)) continue;
    if (!voiceCounts(condition.from, utterance.speakerId, memory, ctx)) continue;
    const at = ctx.positionOf(utterance.speakerId);
    if (at === null) continue;
    if (!within(ctx.self, at, condition.cells, ctx.sight)) continue;
    if (condition.los && !ctx.canSee(at)) continue;
    memory.heardFrom = utterance.speakerId;
    return true;
  }
  return false;
}

/**
 * Whatever just made a sound, near enough to have been heard.
 *
 * Oldest first and the first match wins, on the grounds {@link heardFrom}
 * resolves two callers by who spoke first: two things making a noise between one
 * tick and the next is a real race, and oldest-first is the only tie-break that
 * does not smuggle in an iteration order from somewhere else.
 *
 * No word to match is not a bug in the caller — it is the authored way to say
 * "any sound at all", so the text test is skipped rather than defaulted. And no
 * sight test anywhere in here: a sound goes round a corner, which is most of
 * what makes hearing worth having beside looking.
 *
 * The maker is remembered for the length of this tick even though the caller
 * only wanted a yes or no, so `bind: { quarry: "speaker" }` on this transition
 * has an id to write.
 */
function heardNoiseFrom(
  condition: Extract<BrainConditionDef, { cond: "heard_noise" }>,
  memory: BrainMemory,
  ctx: BrainContext,
): boolean {
  const wanted = condition.text?.toLowerCase();
  for (const sound of ctx.heardNoise()) {
    if (wanted !== undefined && !sound.text.toLowerCase().includes(wanted)) {
      continue;
    }
    const at = ctx.positionOf(sound.sourceId);
    if (at === null) continue;
    if (!within(ctx.self, at, condition.cells, ctx.sight)) continue;
    memory.heardFrom = sound.sourceId;
    return true;
  }
  return false;
}

/**
 * Is this a voice the condition was listening for?
 *
 * Asked before the distance and sight tests rather than after, because it is the
 * cheapest of the four and the one most likely to say no — a creature deep in a
 * conversation rejects every word its partner did not say, and that is most of
 * what it hears.
 *
 * A filter whose selector names nobody resolves to `null`, and both matches read
 * correctly against it without a case of their own: nobody *is* the person, and
 * everybody is *not* them. @see SpeakerFilter
 */
function voiceCounts(
  filter: SpeakerFilter | undefined,
  speakerId: string,
  memory: BrainMemory,
  ctx: BrainContext,
): boolean {
  if (!filter) return true;
  // A filter naming a *thing* names nobody, on exactly the terms one naming an
  // unbound slot does: nobody is the bush, and every voice is not it.
  const wanted = boundBody(identify(filter.of, memory, ctx));
  return filter.match === "is" ? wanted === speakerId : wanted !== speakerId;
}

/**
 * Does a transition's `if` hold — one question or a tree of them?
 *
 * The negated branch is the whole reason this is not a bare call to
 * {@link evaluateCondition}. Two leaves record *who* set them off as they
 * answer, and that recording is what the `speaker` and `attacker` selectors
 * read on the same transition. A branch under an odd number of `not`s is asking
 * whether something did **not** happen, so a match inside it is precisely the
 * case where there is nobody to name — and leaving a fingerprint there would let
 * `bind: { partner: speaker }` on a transition that fired for some other reason
 * write down whoever the negated half happened to hear.
 *
 * Putting back what was there, rather than clearing, is what keeps a sibling's
 * legitimate match from being wiped by a negated one asked after it.
 */
function holds(
  condition: BrainCondition,
  memory: BrainMemory,
  ctx: BrainContext,
): boolean {
  return evaluateCondition(condition, (leaf, negated) => {
    if (!negated) return leafHolds(leaf, memory, ctx);

    const speaker = memory.heardFrom;
    const attacker = memory.hurtBy;
    const held = leafHolds(leaf, memory, ctx);
    memory.heardFrom = speaker;
    memory.hurtBy = attacker;
    return held;
  });
}

function leafHolds(
  condition: BrainConditionDef,
  memory: BrainMemory,
  ctx: BrainContext,
): boolean {
  switch (condition.cond) {
    case "after":
      return memory.msInState >= condition.ms;
    case "stuck":
      return memory.stuck;
    case "in_range": {
      const at = locate(condition.of, memory, ctx);
      return at !== null && within(ctx.self, at, condition.cells, ctx.sight);
    }
    case "out_of_range": {
      const at = locate(condition.of, memory, ctx);
      // A target that has left the world is as out of range as one that walked
      // off, and answering anything else would strand a creature chasing a
      // ghost. This is also what makes the two conditions exact complements —
      // and what makes a body with no authored cell always far from home.
      return at === null || !within(ctx.self, at, condition.cells, ctx.sight);
    }
    case "in_los":
      return inSight(locate(condition.of, memory, ctx), condition.cells, ctx);
    case "out_of_los":
      // Gone, too far, or behind something — the same complement rule, now with
      // one more way to be lost.
      return !inSight(locate(condition.of, memory, ctx), condition.cells, ctx);
    case "heard":
      return heardFrom(condition, memory, ctx);
    case "heard_noise":
      return heardNoiseFrom(condition, memory, ctx);
    case "attacked":
      return struckBy(memory, ctx);
    case "talking":
      return ctx.talking();
    case "carrying":
      return ctx.carrying(condition.tileId);
    case "status":
      return ctx.hasStatus(condition.id, condition.atLeastMs);
  }
}

/**
 * Was this creature hit, and by whom?
 *
 * The first attacker wins when several landed between two ticks, on the same
 * grounds `heard` resolves two callers by who spoke first: it is a real race,
 * and oldest-first is the only tie-break that does not smuggle in an iteration
 * order from somewhere else. Whoever it was is remembered for the length of the
 * tick so a `bind: { foe: "attacker" }` on this transition has an id to write.
 */
function struckBy(memory: BrainMemory, ctx: BrainContext): boolean {
  const [first] = ctx.hurtBy();
  if (first === undefined) return false;
  memory.hurtBy = first;
  return true;
}

/**
 * Set off for `goal`, and let the body get on with it.
 *
 * One line, because the deciding is somewhere else in both directions: the
 * search belongs to the board (`./pathfinding`), and the walking belongs to the
 * session, which presses a leg every time this body is free rather than once a
 * round. What is left here is reading the answer the way a priority list does.
 *
 * Both failures read the same to an author and that is deliberate — `"arrived"`
 * for a creature already standing beside its target and `"blocked"` for one
 * with no way there both fall through, which is what lets "hit them, else close
 * on them, else hold" read straight down the list. They are still two facts:
 * only the second is a `stuck` a transition can watch for.
 *
 * There is no `busy` check any more. A body mid-step is a body already walking
 * where it was told to, so the order it is walking out *is* the answer; asking
 * again would be this line reporting on the state of a leg rather than on
 * whether the creature is going anywhere.
 */
function walkAlongRoute(
  goal: WalkGoal,
  allowDrops: boolean | undefined,
  ctx: BrainContext,
): ActionStatus {
  return ctx.walkTo(goal, allowDrops) === "walking" ? "running" : "failure";
}

/**
 * Run from `target`, and keep running.
 *
 * One line for the same reason {@link walkAlongRoute} is: the search belongs to
 * the board and the walking belongs to the session. What is left here is that a
 * flee has one failure rather than two — there is nowhere better than where it
 * stands — and that failure is what an author's `stuck` reads to put an animal
 * in a cornered state.
 *
 * **This used to be greedy and is not any more.** It scored the four
 * neighbouring cells, took whichever opened the distance most, and failed when
 * none of them did. A wall defeated it: a rabbit in a corner has no neighbour
 * that gains anything, so it gave up after two steps of hill-climbing having
 * never looked at the gap it could have run through — and while it still had
 * somewhere to go it shuffled between two cells, because the best of four flips
 * as the threat moves and nothing was committed to. @see ./pathfinding's
 * `findRefuge`, which is where the argument for the change is written down.
 */
function fleeAlongRoute(
  target: Coord,
  allowDrops: boolean | undefined,
  ctx: BrainContext,
): ActionStatus {
  return ctx.fleeFrom(target, allowDrops) === "walking" ? "running" : "failure";
}

/**
 * Try to go somewhere, anywhere.
 *
 * Every legal direction gets a turn, in an unbiased order: "pick one and give
 * up if it is blocked" would leave a creature in a corridor standing still
 * three times out of four.
 */
function stepAnywhere(
  allowDrops: boolean | undefined,
  ctx: BrainContext,
): boolean {
  const options = footing(ctx.rng.shuffle([...DIRECTIONS]), allowDrops, ctx);
  for (const direction of options) {
    if (ctx.step(direction)) return true;
  }
  return false;
}

function runAction(
  action: BrainActionDef,
  index: number,
  memory: BrainMemory,
  tickMs: number,
  ctx: BrainContext,
): ActionStatus {
  switch (action.action) {
    case "hold":
      return "success";
    case "step_random": {
      // A step in flight is a step still being taken, not a new one to start.
      if (ctx.busy) return "running";
      return stepAnywhere(action.allowDrops, ctx) ? "success" : "failure";
    }
    case "wait": {
      // Clamped rather than left to run away, so the number in scratch stays
      // the honest answer to "how long has this been waiting" no matter how
      // many ticks pass with the line already served.
      const waited = Math.min((memory.scratch[index] ?? 0) + tickMs, action.ms);
      memory.scratch[index] = waited;
      return waited >= action.ms ? "failure" : "running";
    }
    case "walk_n_steps": {
      const taken = memory.scratch[index] ?? 0;
      // Its distance is done. Failing rather than holding is what lets a state
      // read top to bottom as a sequence.
      if (taken >= action.steps) return "failure";
      if (ctx.busy) return "running";
      if (!stepAnywhere(action.allowDrops, ctx)) return "failure";
      memory.scratch[index] = taken + 1;
      // Running even on the last step, because that step is still in flight.
      // The tick after it lands is the one that falls through.
      return "running";
    }
    case "attack": {
      // A thing has no pulse, so it answers here the way an empty slot does.
      const id = boundBody(identify(action.of, memory, ctx));
      // Nobody in the slot. A failure rather than a stand-still, so a state can
      // read "hit them, else chase them, else hold" straight down the list.
      if (id === null) return "failure";
      return ctx.attack(id) ? "success" : "failure";
    }
    case "extract": {
      const bound = identify(action.of, memory, ctx);
      // A body is not a resource, on the terms a thing is not a target: the
      // mirror of `attack`'s refusal, and the line falls through either way.
      if (bound?.kind !== "thing") return "failure";
      // Running rather than success, because a pull is something this creature
      // is part-way through: a lower line that stepped would end it.
      return ctx.extract(bound.at, bound.tileId) ? "running" : "failure";
    }
    case "consume": {
      // The bag, unless the author named something on the board.
      if (!action.of) return ctx.consume(action.tileId) ? "success" : "failure";
      const bound = identify(action.of, memory, ctx);
      // A body is not a meal, on the terms it is not a resource: the same
      // refusal `extract` makes of the wrong kind of selector.
      if (bound?.kind !== "thing") return "failure";
      return ctx.consumeOn(bound.at, bound.tileId) ? "success" : "failure";
    }
    case "step_toward": {
      const goal = aim(action.of, memory, ctx);
      // Nobody to go to. A failure rather than a stand-still, so the author's
      // next line gets its turn.
      if (!goal) return "failure";
      return walkAlongRoute(goal, action.allowDrops, ctx);
    }
    case "step_away_from": {
      // Where the threat *is*, not who it is: a flee measures against a
      // position and re-measures it every time it picks somewhere to run,
      // which is the one place {@link locate} is still the right question and
      // {@link aim} is not.
      const at = locate(action.of, memory, ctx);
      // Nobody to move relative to, on {@link walkAlongRoute}'s terms.
      if (!at) return "failure";
      return fleeAlongRoute(at, action.allowDrops, ctx);
    }
  }
}

/**
 * The first transition whose condition holds, or null to stay put.
 *
 * Array order is priority, and `any` matches whatever state the creature is
 * actually in — so a wildcard placed above a specific transition wins, exactly
 * as it reads.
 */
function firstMatch(
  brain: BrainDef,
  memory: BrainMemory,
  ctx: BrainContext,
): BrainTransitionDef | null {
  for (const transition of brain.transitions) {
    if (transition.from !== ANY_STATE && transition.from !== memory.state) {
      continue;
    }
    if (holds(transition.if, memory, ctx)) return transition;
  }
  return null;
}

/**
 * Write down who set this off, on the way through.
 *
 * A selector that names nobody clears its slot rather than leaving the previous
 * occupant in place — a stale id is worse than an empty slot, because every
 * condition reading it would keep answering about somebody who is no longer
 * relevant.
 */
function applyBind(
  transition: BrainTransitionDef,
  memory: BrainMemory,
  ctx: BrainContext,
) {
  if (!transition.bind) return;
  for (const [slot, selector] of Object.entries(transition.bind)) {
    const bound = identify(selector, memory, ctx);
    if (bound === null) {
      delete memory.blackboard[slot];
    } else {
      memory.blackboard[slot] = bound;
    }
  }
}

/**
 * Forget how far the lines below this one had got.
 *
 * The subtle half of letting an action take time. Because the list is rescanned
 * from the top every tick, a counting action can be interrupted by something
 * above it — and when its turn comes round again it starts over rather than
 * picking up mid-count. That is what an author reading the table expects: a
 * higher line taking over is the creature changing its mind, and a mind changed
 * halfway through a walk does not later remember it had one step left.
 *
 * Lines *above* the selected one keep theirs, and that is the same rule seen
 * from the other side: they failed this tick because they were finished, and
 * forgetting that would put the state back at the top of its sequence forever.
 */
function discardBelow(memory: BrainMemory, index: number) {
  for (const key of Object.keys(memory.scratch)) {
    if (Number(key) > index) delete memory.scratch[Number(key)];
  }
}

/**
 * Advance one creature by one brain tick: consider leaving, then act.
 *
 * Transitions first, so a state entered on this tick does something on this
 * tick rather than standing idle for one — the alternative is a visible beat of
 * hesitation every time anything changes its mind.
 *
 * The action scan restarts from the top of the list every tick, running action
 * or not. That is what keeps a creature reactive inside a state: a higher
 * priority line can take over from a lower one that was still going.
 */
export function stepBrain(
  brain: BrainDef,
  memory: BrainMemory,
  tickMs: number,
  ctx: BrainContext,
): void {
  // The initial state is entered like any other, and its effects are owed the
  // same one firing — but nothing transitioned into it, so the first tick is
  // where that entry happens.
  if (!memory.started) {
    memory.started = true;
    runOnEnter(brain, memory, ctx);
  }

  // Last tick's speaker is nobody's business now: the slot exists to carry an id
  // from a condition to the bind on the same transition, and a leftover would
  // let a later `bind: { caller: "speaker" }` write down somebody who has not
  // said a word since.
  memory.heardFrom = null;
  memory.hurtBy = null;

  memory.msInState += tickMs;

  const transition = firstMatch(brain, memory, ctx);
  if (transition) {
    // Bound before the state changes, so a selector may still read a slot the
    // previous state was using — rebinding `$target` from `$target` is a way to
    // hold on to somebody rather than a way to lose them.
    applyBind(transition, memory, ctx);
    if (transition.to !== memory.state) {
      memory.state = transition.to;
      memory.msInState = 0;
      // A dead end belongs to the state it was reached in, not to the one that
      // rescued the creature from it.
      memory.stuck = false;
      // Nor does a half-finished graze. Positions mean nothing across states,
      // and a creature that comes back to one starts its sequence over — which
      // is also why a transition can cut a long action short at any moment.
      memory.scratch = {};
      // Once on the way in, before any action gets a turn: the yelp lands on
      // the frame the creature bolts, not the one after.
      runOnEnter(brain, memory, ctx);
    }
  }

  const state = brain.states[memory.state];
  if (!state) return;

  for (const [index, action] of state.do.entries()) {
    if (runAction(action, index, memory, tickMs, ctx) === "failure") continue;
    discardBelow(memory, index);
    memory.stuck = false;
    return;
  }

  // Nothing left to try. An empty list is not stuck — a state that was authored
  // to do nothing is doing exactly that, and nothing failed to happen.
  memory.stuck = state.do.length > 0;
}
