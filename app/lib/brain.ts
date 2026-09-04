import * as v from "valibot";
import { conditionLeaves, conditionSchema, type ConditionNode } from "./conditions";
import type { TileDef } from "./types";

/**
 * What drives a body when nobody is connected to it.
 *
 * A flat state machine, authored on the tile def beside the other interaction
 * blocks. Three rules carry the whole design:
 *
 * - **Transitions are an ordered list and the first match wins.** The order is
 *   the semantics, which is why this is a list rather than a graph: a node
 *   canvas draws five edges out of one state with no indication which is tried
 *   first, and that is the only thing about a brain you cannot afford to guess.
 * - **A state's `do` is a priority list**, scanned top to bottom each brain
 *   tick. The first action that does not *fail* is the one that runs, so
 *   "cornered" is expressible as falling through to the next line rather than as
 *   a branch inside an action.
 * - **Names, not code.** Conditions and actions are named here and implemented
 *   in a registry, so an authored brain is data all the way down: serializable,
 *   diffable, and safe to load from a file somebody hand-edited.
 *
 * Everything is parsed rather than trusted, on the same terms as `push` and
 * `pressurePlate`: a malformed brain yields an inert body, never a crashed
 * world. It is by far the biggest authored blob in `tiles.json`, so it is the
 * one where that matters most.
 */

/**
 * Source state matching every state at once.
 *
 * The escape hatch that keeps a flat machine from needing an edge from
 * everywhere to everywhere — "whatever you were doing, if you were just shoved,
 * bolt" is one transition rather than one per state.
 */
export const ANY_STATE = "any";

/**
 * How a brain names somebody other than itself.
 *
 * A tagged union — `{ type, data }` — rather than an encoded string, and the
 * reason is room to grow. Every one of these answers "which body do you mean",
 * but the *question* each asks is a different shape: `nearest` needs to know
 * which tile, `slot` needs a name, and the two event forms need nothing at all.
 * A string had to smuggle those parameters into its own text, which meant a
 * parser, an escaping question nobody had answered, and a hard ceiling on any
 * selector wanting two parameters rather than one.
 *
 * Adding a kind is now a variant here, an arm in `identify`, and an entry in the
 * editor's catalog — the same three places a condition or an action is added,
 * which is the point. Nothing has to agree on a syntax.
 *
 * The split that matters is between the *live* queries and the *remembered*
 * one, and it is the whole reason a blackboard exists. `nearest` is asked fresh
 * every time it is read. `slot` is a name written down earlier, by the
 * transition that bound it.
 *
 * A state that chases has to use the second. Re-asking "who is nearest" every
 * tick makes a creature standing between two people flip between them and
 * jitter on the spot; binding on the way in means it commits to the one that
 * set it off, and keeps committing until something says otherwise.
 */
export type Selector =
  /**
   * The nearest body standing on a named tile.
   *
   * The tile id is the whole of the test, and that one fact covers every
   * relationship authored so far. `player` is the threat everything reacts to;
   * a rat naming `rat` is a flock, because the animal a rat wants to be beside
   * is another rat; a wolf naming `wolf-alpha` is a pack with a leader. None of
   * those needed a notion of factions or herds — the world already says what
   * each body *is*, and that turns out to be the only relation any of them need.
   *
   * A creature is never its own answer. Without that, a rat naming `rat` would
   * resolve to the rat asking and follow itself in circles.
   *
   * No sight test: whether the answer is in view is `in_los`'s question, asked
   * separately by whoever cares. That leaves one authored edge — the nearest rat
   * behind a wall answers an `in_los` no even with a second one in plain view —
   * and it is inherent to answering "nearest" before "visible", so it is written
   * down rather than special-cased.
   *
   * Naming a tile nothing is standing on answers nobody, exactly as an unbound
   * slot does. That is what makes a brain authored against a creature the world
   * has not placed yet inert rather than broken.
   */
  | { type: "nearest"; data: { tileId: string } }
  /** Whoever a transition wrote down earlier, under this name. */
  | { type: "slot"; data: { name: string } }
  /**
   * Whoever this transition just heard — the one who spoke, for a
   * {@link BrainConditionDef} `heard`, or the one who made the sound, for a
   * `heard_noise`.
   *
   * A live query, but one with a window of exactly one transition: it answers
   * nothing on a transition that did not just hear something. That is the point
   * of it — "the one who called me" is not "the one standing nearest", and a
   * room with two people in it is precisely where the difference shows.
   *
   * One selector for both conditions rather than a second one named for sounds,
   * because they ask the same question and would read the same answer off the
   * same field. What is heard is a voice or a crunch; who was heard is one
   * question either way.
   *
   * Meant to be bound rather than read from a state: binding it to `caller`
   * writes it down, and the state that follows chases that slot.
   */
  | { type: "speaker" }
  /**
   * Whoever the {@link BrainConditionDef} `attacked` on this very transition
   * matched — the one who just hit this creature.
   *
   * The same one-transition window `speaker` has, and for the same reason: being
   * struck is an event, and "the one who hit me" answers nothing on a transition
   * where nobody did. Meant to be bound, so the state that follows fights a slot
   * rather than re-asking a question whose answer has already expired.
   */
  | { type: "attacker" }
  /**
   * The cell this creature was authored on — the one place selector, and the
   * only one that names somewhere rather than somebody.
   *
   * It is here rather than in a union of its own because every verb that would
   * want it already takes a {@link Selector} and already means the same thing by
   * it: `out_of_range` asks how far away something is, `step_toward` closes on
   * it, and neither has any use for the fact that the something has a pulse. A
   * second, place-shaped selector type would mean a second arm on all four
   * distance conditions and both steering actions, to say what they already say.
   *
   * The price is that the verbs which genuinely need a *body* — `attack`, a
   * `bind`, a `heard` filter — can be authored against it, and they answer the
   * way every selector naming nobody answers: an `attack` falls through, a
   * `bind` clears its slot. That is the documented behaviour of an unbound slot
   * rather than a new failure mode, which is what makes the one union tolerable.
   *
   * Measured on exactly the terms a body is, sight levels included — so a rat
   * that minds its own storey reads a home one floor up as away, and stays
   * walking until it is back on the right one. That is the reading that became
   * correct when `step_toward` learned to route: a staircase is a thing a
   * creature can now walk, so "directly below home" stopped being a place worth
   * settling for. @see ../game/pathfinding
   *
   * Nowhere at all for a body the world did not author — a player's, or one some
   * later path seats without a home. `out_of_range` of nowhere holds, exactly as
   * it does for a target that has left the world.
   */
  | { type: "home" };

export const SPEAKER_SELECTOR: Selector = { type: "speaker" };
export const ATTACKER_SELECTOR: Selector = { type: "attacker" };
export const HOME_SELECTOR: Selector = { type: "home" };

/** The selector naming the nearest body on `tileId`. */
export function nearest(tileId: string): Selector {
  return { type: "nearest", data: { tileId } };
}

/** The selector reading back whatever a transition bound under `name`. */
export function slot(name: string): Selector {
  return { type: "slot", data: { name } };
}

/** The tile a `nearest` selector names, or null for the other kinds. */
export function nearestTileId(selector: Selector): string | null {
  return selector.type === "nearest" ? selector.data.tileId : null;
}

/** The slot a `slot` selector reads, or null for the other kinds. */
export function slotOf(selector: Selector): string | null {
  return selector.type === "slot" ? selector.data.name : null;
}

/**
 * A short stable string for one selector — a React key, a dropdown value, a
 * line in a test failure.
 *
 * Presentation only, and deliberately not a format anything parses back: the
 * authored shape is the object, and a second encoding that round-trips would be
 * the string selector growing back with extra steps.
 */
export function selectorKey(selector: Selector): string {
  switch (selector.type) {
    case "nearest":
      return `nearest:${selector.data.tileId}`;
    case "slot":
      return `$${selector.data.name}`;
    default:
      return selector.type;
  }
}

/**
 * Whose voice a {@link BrainConditionDef} `heard` counts.
 *
 * The half of "somebody said something" that a room with two people in it
 * actually turns on. Every other condition already names who it is about
 * through a {@link Selector}; `heard` did not, so a creature mid-conversation
 * could not tell the person it was talking to from a stranger walking past
 * saying the same word.
 *
 * `not` is a separate match rather than a second condition because "anybody but
 * the one I am busy with" is the *whole* of what an engaged NPC needs to
 * recognise, and it has to survive somebody reordering the transition table.
 * The same thing is expressible by putting a `from: is` row above a bare
 * `heard` and letting the first match swallow it — but then the rule lives in
 * the gap between two rows rather than on the row that means it, and dragging
 * one of them past the other silently changes who gets answered.
 *
 * A filter naming nobody — an unbound slot, a tile nothing stands on — is what
 * makes both matches read correctly on their own: `is` matches nobody, because
 * there is nobody to be; `not` matches everybody, because with no partner every
 * voice is a stranger's. That is the behaviour an NPC wants on the tick before
 * anyone has greeted it, and it falls out rather than being special-cased.
 *
 * The event selectors (`speaker`, `attacker`) are accepted here and answer
 * nobody, on the terms every other selector that names nobody does: the
 * condition asking is the one that would have set `speaker`, so it is not set
 * yet. Refusing them would mean a second, narrower selector schema and an
 * editor picker that knows the difference.
 */
export type SpeakerFilter = { match: "is" | "not"; of: Selector };

export type BrainConditionDef =
  /** Milliseconds in the current state. */
  | { cond: "after"; ms: number }
  /**
   * Somebody is within `cells`, counted in steps rather than as the crow flies.
   *
   * Exact complements, this and {@link out_of_range}: at any distance precisely
   * one of them holds. That is deliberate and it is what stops a creature
   * authored with the same threshold on the way in and the way out from
   * flipping state every tick while somebody stands on the boundary.
   */
  | { cond: "in_range"; of: Selector; cells: number }
  /** Nobody within `cells` — including the case where the target is gone. */
  | { cond: "out_of_range"; of: Selector; cells: number }
  /**
   * Within `cells` *and* in plain view — no full-height wall in between.
   *
   * Distance and sight are one condition rather than two because a transition
   * takes a single `if`: there is no `and`, deliberately, so anything an author
   * needs to ask together has to be askable as one question.
   *
   * A creature that acts on this reads as noticing you rather than as sensing
   * you through the scenery, which is most of the difference between a
   * believable animal and a proximity trigger. @see ../game/sight
   */
  | { cond: "in_los"; of: Selector; cells: number }
  /**
   * Out of `cells`, or out of view, or gone. The exact complement of
   * {@link in_los}, and the usual way a chase ends: what got behind the barn is
   * lost, not still being followed through the wall.
   */
  | { cond: "out_of_los"; of: Selector; cells: number }
  /**
   * Somebody within earshot said something containing `text`.
   *
   * The one condition that is *edge* triggered. Every other one asks about a
   * state of the world that is either true or false right now and will still be
   * answerable next tick; this asks about something that happened, and an
   * utterance is heard by a given creature on exactly one brain tick before it
   * is gone. That is what makes a transition on it fire once per thing said
   * rather than for as long as the words hang in the air.
   *
   * Matching is a case-insensitive substring, so `"ps"` catches "psps",
   * "PSPSPS" and "come here ps". A word rather than an exact line is the useful
   * thing to author against: people type at a creature, they do not enter a
   * command.
   *
   * `los` adds the sight test to the distance one — a cat that answers a call
   * from the other side of a closed door is a cat that heard through a wall,
   * which is fine for sound and wrong for the summons this exists to express.
   *
   * `from` narrows it to one voice, or to every voice but one. Absent, anybody
   * near enough will do, which is what a cat answering to "ps" wants and what
   * an NPC already deep in a conversation cannot afford. @see SpeakerFilter
   */
  | {
      cond: "heard";
      text: string;
      cells: number;
      los?: boolean;
      /** Whose voice counts. Absent means anybody's. @see SpeakerFilter */
      from?: SpeakerFilter;
    }
  /**
   * Something within `cells` made a sound — a crunch, a hiss, a howl.
   *
   * The other half of {@link heard}, and the halves are split rather than joined
   * by a channel flag because the two questions want different parameters.
   * Speech is language, so it is asked about by *word*; a sound is not, so the
   * useful thing to ask about it is usually that there was one at all.
   *
   * Edge triggered, on exactly the terms {@link heard} is: a noise is over the
   * instant it is made, so a transition on this fires once per sound rather than
   * for as long as the label hangs in the air.
   *
   * **`text` is optional, and absent means any sound whatever.** That is the
   * opposite of `heard`, which refuses an empty word — and both readings are
   * right for what they are about. "Any word ever said" is authorable and is
   * never what anybody meant to type; "anything at all" is precisely what an
   * animal's ears do, and it is the whole of why a wolf comes to look. Given, it
   * matches as a case-insensitive substring, like a word does.
   *
   * **No sight test, and deliberately not even the option of one.** `heard` has
   * `los` because a summons through a closed door is wrong, and its own note
   * says why: sight is wrong *for sound*. This condition is only ever about
   * sound, so a flag turning it into a look would be the mistake rather than the
   * guard against it.
   *
   * A creature never hears itself, so a state that howls on entry cannot set
   * itself off. It does hear every other body, which is what makes one howl
   * gather a pack.
   *
   * Whoever made it is named by the `speaker` selector for the length of this
   * transition, so "go and look" is a bind and a `step_toward` rather than a new
   * kind of target. A maker who has since left the board is not heard at all —
   * the same rule a `heard` follows for a speaker who logged out.
   */
  | { cond: "heard_noise"; text?: string; cells: number }
  /**
   * Somebody hit this creature since it last had a turn.
   *
   * Edge triggered, like {@link heard} and unlike everything else here: a blow
   * is something that happened, not a state of the world that will still be
   * true next tick. That is what makes "fight back" one transition rather than a
   * standing comparison against a health value nobody has to re-earn.
   *
   * No distance and no sight test, deliberately. Whoever hit you was by
   * definition close enough to, and a creature that had to *see* its attacker to
   * react would stand there placidly while something behind it kept swinging.
   */
  | { cond: "attacked" }
  /**
   * Every action in this state failed, last time it had a turn.
   *
   * How "cornered" is authored without a branch inside an action: blocked,
   * nowhere to run and nobody to run from all arrive here, because they are all
   * just a priority list with nothing left in it.
   *
   * Note that a state ending in `hold` can never be stuck — `hold` succeeds by
   * definition, so it swallows the condition. A state meant to give up needs to
   * end in the action that can fail.
   */
  | { cond: "stuck" }
  /**
   * This body is mid-conversation — its `dialog` block has a partner.
   *
   * The one place the brain and the dialog meet, and deliberately the only one:
   * the dialog decides who is being talked to and what is said, and the brain
   * decides what the legs do about it. A shopkeeper that wanders when idle and
   * stands still for a sale is `from: any, if: talking, to: serving` and the
   * `not` of it back, and nothing else has to know a conversation exists.
   * A body with no dialog block is never talking.
   */
  | { cond: "talking" };

/**
 * What a transition fires on: one question, or several joined together.
 *
 * A bare {@link BrainConditionDef} is a condition, which is what every brain
 * authored before this was and still is — the tree is `and`/`or`/`not` layered
 * *over* the vocabulary rather than replacing it, so nothing in `tiles.json`
 * moved. @see ./conditions
 *
 * The flat machine held out against `and` for a long time, and the argument was
 * a good one: a transition that takes exactly one question cannot hide a
 * decision inside its condition, so the table is the whole of the behaviour.
 * What changed is that the same tree is now wanted in places that are not
 * transitions at all — whether a trade is on offer, whether a door will open for
 * you — and a second, differently-shaped answer to "several questions at once"
 * in each of them is a worse outcome than one shared shape here.
 *
 * The rule the flat machine was protecting still holds, and it is worth naming
 * since it is no longer enforced by the shape: **order is still the semantics.**
 * A group answers one question in more words. Two transitions answer two
 * questions, in a priority the author can see. Reaching for `or` where two rows
 * would do buries the priority inside a condition, which is precisely the thing
 * a node canvas does badly and this table exists to avoid.
 */
export type BrainCondition = ConditionNode<BrainConditionDef>;

/**
 * Whether a step may leave the ground beneath it.
 *
 * Off by default, and that is a decision about creatures rather than about
 * movement: the board has always let anyone walk into open air so gravity can
 * pull them through, which is right for a player who can see the drop coming
 * and wrong for a deer grazing along a rooftop. Authored per action rather than
 * per creature, so the same animal can refuse a ledge while browsing and take
 * it without hesitating when something is chasing it.
 */
type Steering = { of: Selector; allowDrops?: boolean };

/**
 * What a creature can be asked to do for one turn.
 *
 * Two of these keep a count across turns — `wait` its clock, `walk_n_steps` its
 * tally — and the line between that and a script is worth stating: **an action
 * may hold a counter or a timer, but never a decision.** `patrol_between(a, b)`
 * would be a state machine hiding inside an action, and the moment one exists
 * half the creature's behaviour has vanished from the transition table.
 *
 * A counting action reports `failure` once it has finished counting, on the same
 * terms as one that is blocked or has arrived: done is one more way of having
 * nothing left to offer, so the priority list falls through to the next line and
 * a state can read as a sequence without anything branching inside it.
 */
export type BrainActionDef =
  /** Step to a random walkable neighbour. Fails when hemmed in on all sides. */
  | { action: "step_random"; allowDrops?: boolean }
  /** Stand still, successfully. The usual last line of a priority list. */
  | { action: "hold" }
  /**
   * Set off along a route to somebody, one step of it per turn.
   *
   * Fails on both ways of having nothing to walk: already standing beside them,
   * and no way to them at all. The second is what makes a `stuck` transition
   * out of a chase meaningful — a creature shut out by a wall gives up rather
   * than pressing itself against the nearest side of it. @see ../game/pathfinding
   */
  | ({ action: "step_toward" } & Steering)
  /**
   * Step so as to open the distance. Fails when nothing gets further — cornered.
   *
   * Judged one step at a time, unlike its mirror, and deliberately: "away" is a
   * direction rather than a place, so there is no destination to route to.
   */
  | ({ action: "step_away_from" } & Steering)
  /** Stand still for a stretch, then get out of the way of the next line. */
  | { action: "wait"; ms: number }
  /** Wander a bounded distance, then get out of the way of the next line. */
  | { action: "walk_n_steps"; steps: number; allowDrops?: boolean }
  /**
   * Swing at somebody.
   *
   * Fails, rather than erroring, at every way this can be the wrong thing to
   * ask for: nobody in the slot, out of reach, still catching its breath from
   * the last blow, or a target with no hit points to take — a creature told to
   * attack a wall simply has nothing to show for the line. Falling through is
   * the whole point, because it is what lets one state read as "hit them if you
   * can, otherwise close the distance, otherwise stand your ground".
   *
   * Deliberately not a move. Closing the distance is `step_toward`'s job, and
   * keeping the two apart is what lets an author write a creature that swings
   * but will not chase.
   */
  | { action: "attack"; of: Selector };

/**
 * Something a state does the once, on the way in.
 *
 * Kept apart from the `do` list because effects are a different kind of thing:
 * an action can fail and hand its turn to the next line, which is the whole
 * point of the priority list, but an effect always lands. Folding a speech into
 * that list would give it a success or failure to contribute, and "the deer
 * yelped" is neither — so effects run first, once, and stay out of it.
 *
 * Two kinds, and the difference between them is whether a body is *talking*.
 *
 * `say` reuses the chat a player already sends: a bubble pinned to the cell,
 * attributed to whoever said it, sanitised and capped on the same terms.
 *
 * `noise` is the one to reach for by default, because most of what a creature
 * emits is not language. A hiss is not a sentence a snake uttered, and drawing
 * it as one — "Snake says: sss" — puts words in a mouth that has none. It goes
 * out on its own channel, unattributed. @see NoiseEmission
 */
export type BrainEffectDef =
  | { effect: "say"; text: string }
  | { effect: "noise"; text: string };

/**
 * The two states a channel drive can be in — the same pair a torch or a plate
 * emits. Spelled out here rather than imported to keep `./brain` free of a
 * dependency on the rest of the interaction blocks; the schema below is the one
 * place the strings live.
 */
export type BrainSignalValue = "on" | "off";

/**
 * Drive a signal channel for as long as the creature is in this state.
 *
 * Held, not pulsed — which is what makes it release itself. A channel's power
 * is re-read from its live emitters every settle pass, so a creature that has
 * left the state is simply no longer among them and the door it was holding
 * open closes on the next pass, with no exit hook to author and nothing to
 * remember. It is the difference between an NPC being part of the existing
 * puzzle wiring and being a parallel system beside it: the same channels a
 * plate drives, driven by a state of mind instead of a weight.
 */
export type BrainEmitDef = { channel: string; value: BrainSignalValue };

export type BrainStateDef = {
  /** Effects run once on entry, before the first action scan. */
  onEnter?: BrainEffectDef[];
  /** A channel this state holds, while the creature is in it. */
  emit?: BrainEmitDef;
  /** Priority list: the first action that does not fail is the one that runs. */
  do: BrainActionDef[];
};

export type BrainTransitionDef = {
  /** A state name, or {@link ANY_STATE}. */
  from: string;
  if: BrainCondition;
  /**
   * Slots to write on the way through, as `slot: selector`.
   *
   * Resolved once, here, and remembered — which is the point. The transition
   * knows who set the creature off; the state it leads to only knows `$target`,
   * and would have no way to ask again without changing its mind.
   */
  bind?: Record<string, Selector>;
  to: string;
};

export type BrainDef = {
  initial: string;
  states: Record<string, BrainStateDef>;
  /** Evaluated in order; the first whose condition holds is taken. */
  transitions: BrainTransitionDef[];
};

const stateName = v.pipe(v.string(), v.minLength(1));

/**
 * One tagged selector. Anything else — including the old encoded strings — is
 * not a selector, and a brain carrying one is inert rather than half-understood.
 *
 * The tile a `nearest` names is only required to be non-empty, rather than
 * matched against a charset the way a slot name is. A slot name is invented by
 * whoever authors the brain, so the editor can insist on a shape; a tile id is an
 * identifier from elsewhere in the world, and a brain that stopped parsing
 * because somebody named a tile with a dot in it would be this schema inventing a
 * rule the tiles themselves do not have.
 */
const selectorSchema = v.variant("type", [
  v.object({
    type: v.literal("nearest"),
    data: v.object({ tileId: v.pipe(v.string(), v.minLength(1)) }),
  }),
  v.object({
    type: v.literal("slot"),
    data: v.object({ name: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_]+$/)) }),
  }),
  v.object({ type: v.literal("speaker") }),
  v.object({ type: v.literal("attacker") }),
  v.object({ type: v.literal("home") }),
]);

const cells = v.pipe(v.number(), v.integer(), v.minValue(0));

const durationMs = v.pipe(v.number(), v.integer(), v.minValue(0));

const speakerFilterSchema = v.object({
  match: v.picklist(["is", "not"]),
  of: selectorSchema,
});

const leafSchema = v.variant("cond", [
  v.object({ cond: v.literal("after"), ms: durationMs }),
  v.object({ cond: v.literal("in_range"), of: selectorSchema, cells }),
  v.object({ cond: v.literal("out_of_range"), of: selectorSchema, cells }),
  v.object({ cond: v.literal("in_los"), of: selectorSchema, cells }),
  v.object({ cond: v.literal("out_of_los"), of: selectorSchema, cells }),
  v.object({
    cond: v.literal("heard"),
    // A word to listen for. Empty would match every utterance ever, which is
    // authorable but is never what somebody meant to type.
    text: v.pipe(v.string(), v.minLength(1)),
    cells,
    los: v.optional(v.boolean()),
    from: v.optional(speakerFilterSchema),
  }),
  v.object({
    cond: v.literal("heard_noise"),
    // Optional, unlike `heard`'s: a sound worth reacting to is often just a
    // sound. Non-empty when given, so the absent case is the only way to say
    // "anything" and an empty box in the editor cannot mean a third thing.
    text: v.optional(v.pipe(v.string(), v.minLength(1))),
    cells,
  }),
  v.object({ cond: v.literal("stuck") }),
  v.object({ cond: v.literal("attacked") }),
  v.object({ cond: v.literal("talking") }),
]);

const ifSchema = conditionSchema<BrainConditionDef>(leafSchema);

/**
 * Is this a selector?
 *
 * Asked by the editor of a value it pulled out of a half-authored condition,
 * where the field may still be whatever the previous verb left behind. Answered
 * by the schema rather than by a hand-written shape test, so there is one
 * definition of the word and the guard cannot drift from what actually parses.
 */
export function isSelector(value: unknown): value is Selector {
  return v.safeParse(selectorSchema, value).success;
}

/**
 * Is this a speaker filter?
 *
 * The same question {@link isSelector} answers and asked by the same caller: the
 * editor holds a `heard` whose `from` may be absent, or may be whatever the
 * previous condition left in that key. Answered by the schema so the guard
 * cannot drift from what parses.
 */
export function isSpeakerFilter(value: unknown): value is SpeakerFilter {
  return v.safeParse(speakerFilterSchema, value).success;
}

const allowDrops = v.optional(v.boolean());

const actionSchema = v.variant("action", [
  v.object({ action: v.literal("step_random"), allowDrops }),
  v.object({ action: v.literal("hold") }),
  v.object({
    action: v.literal("step_toward"),
    of: selectorSchema,
    allowDrops,
  }),
  v.object({
    action: v.literal("step_away_from"),
    of: selectorSchema,
    allowDrops,
  }),
  v.object({ action: v.literal("wait"), ms: durationMs }),
  v.object({
    action: v.literal("walk_n_steps"),
    // At least one, because a walk of no steps is a line that can only ever
    // fail — authored, almost certainly, by mistake.
    steps: v.pipe(v.number(), v.integer(), v.minValue(1)),
    allowDrops,
  }),
  v.object({ action: v.literal("attack"), of: selectorSchema }),
]);

const effectSchema = v.variant("effect", [
  v.object({ effect: v.literal("say"), text: v.pipe(v.string(), v.minLength(1)) }),
  v.object({
    effect: v.literal("noise"),
    text: v.pipe(v.string(), v.minLength(1)),
  }),
]);

const emitSchema = v.object({
  channel: v.pipe(v.string(), v.minLength(1)),
  value: v.picklist(["on", "off"]),
});

const brainSchema = v.object({
  initial: stateName,
  states: v.record(
    stateName,
    v.object({
      onEnter: v.optional(v.array(effectSchema)),
      emit: v.optional(emitSchema),
      do: v.array(actionSchema),
    }),
  ),
  transitions: v.array(
    v.object({
      from: stateName,
      if: ifSchema,
      bind: v.optional(v.record(v.pipe(v.string(), v.minLength(1)), selectorSchema)),
      to: stateName,
    }),
  ),
});

/**
 * Everything true of a brain that its shape alone cannot say.
 *
 * A machine whose initial state does not exist has nowhere to start, and one
 * whose transition points at a state that was renamed would strand a creature
 * mid-behaviour. Both are refusals rather than repairs: a brain that silently
 * dropped its broken half would be harder to notice than one that plainly does
 * nothing.
 */
function isCoherent(brain: BrainDef): boolean {
  return !validateBrain(brain).some((issue) => issue.severity === "error");
}

/** One thing wrong with a brain, at the level the editor should say it. */
export type BrainIssue = {
  /** `error` makes a brain inert at load; `warn` is a smell worth surfacing. */
  severity: "error" | "warn";
  message: string;
};

/**
 * Everything true of a brain that its shape alone cannot say, as a list rather
 * than a yes/no.
 *
 * The runtime asks only "is this coherent" — a malformed brain is an inert body
 * and that is the whole of what a player needs. The editor is where the *reason*
 * is actionable: it is the moment somebody can fix a transition that points at a
 * renamed state, so this returns each fault in words rather than collapsing them
 * to a boolean. `isCoherent` is that boolean, kept as the one thing the loader
 * needs.
 *
 * The severities draw the line the loader draws: an `error` is a fault that
 * makes the machine unrunnable and so refuses to load, while a `warn` — a state
 * nothing can reach — loads and runs exactly as authored but almost certainly
 * is not what the author meant.
 */
export function validateBrain(brain: BrainDef): BrainIssue[] {
  const issues: BrainIssue[] = [];
  const names = Object.keys(brain.states);

  // A state actually called "any" would be unreachable as a transition source,
  // since the wildcard shadows it — better refused than quietly never matched.
  if (Object.hasOwn(brain.states, ANY_STATE)) {
    issues.push({ severity: "error", message: `A state cannot be named "${ANY_STATE}".` });
  }
  if (names.length === 0) {
    issues.push({ severity: "error", message: "Add at least one state." });
  }
  if (!brain.initial) {
    issues.push({ severity: "error", message: "Pick an initial state." });
  } else if (!Object.hasOwn(brain.states, brain.initial)) {
    issues.push({
      severity: "error",
      message: `Initial state "${brain.initial}" does not exist.`,
    });
  }

  brain.transitions.forEach((t, i) => {
    if (t.from !== ANY_STATE && !Object.hasOwn(brain.states, t.from)) {
      issues.push({
        severity: "error",
        message: `Transition ${i + 1}: from "${t.from}", which is not a state.`,
      });
    }
    if (!Object.hasOwn(brain.states, t.to)) {
      issues.push({
        severity: "error",
        message: `Transition ${i + 1}: goes to "${t.to}", which is not a state.`,
      });
    }
  });

  for (const name of unreachableStates(brain)) {
    issues.push({ severity: "warn", message: `State "${name}" cannot be reached.` });
  }

  return issues;
}

/**
 * States no run of transitions from `initial` can ever land in.
 *
 * A wildcard source reaches from everywhere, so the moment any state is
 * reachable its target is too — which is why it is folded in as an edge out of
 * every currently-reachable state rather than a special case. Skipped entirely
 * when the initial state is itself missing: there is no vantage point to judge
 * reachability from, and the missing-initial error already covers it.
 */
function unreachableStates(brain: BrainDef): string[] {
  const names = Object.keys(brain.states);
  if (!brain.initial || !Object.hasOwn(brain.states, brain.initial)) return [];

  const reached = new Set<string>([brain.initial]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of brain.transitions) {
      if (!Object.hasOwn(brain.states, t.to) || reached.has(t.to)) continue;
      const canLeave = t.from === ANY_STATE || reached.has(t.from);
      if (canLeave) {
        reached.add(t.to);
        grew = true;
      }
    }
  }
  return names.filter((name) => !reached.has(name));
}

const reachCache = new WeakMap<BrainDef, number>();

/**
 * The furthest distance, in cells, that this brain ever asks about.
 *
 * The largest `cells` on any condition in any transition. It is what the
 * session uses to decide whether a creature could notice a player at all: a
 * wolf that sees at nine, hunts to fourteen and investigates a sound at
 * twenty-two reaches twenty-two, and somebody further away than that cannot
 * appear in any question it asks. Zero for a brain with no distance in it.
 *
 * Read off the authored conditions rather than written down beside them, so a
 * brain given longer ears is given a longer reach in the same edit.
 */
export function brainReach(brain: BrainDef): number {
  const cached = reachCache.get(brain);
  if (cached !== undefined) return cached;

  let reach = 0;
  const leaves = brain.transitions.flatMap((transition) => conditionLeaves(transition.if));
  for (const leaf of leaves) {
    if ("cells" in leaf && leaf.cells > reach) reach = leaf.cells;
  }
  reachCache.set(brain, reach);
  return reach;
}

const brainCache = new WeakMap<TileDef, BrainDef | null>();

/**
 * Parsed brain for a tile def, or null when it has none — or has one that does
 * not hold together.
 *
 * Memoised on def identity, like the other resolvers: this is asked once per
 * body per brain tick, and re-parsing a state machine at that rate would be the
 * most expensive thing in the loop.
 */
export function resolveBrain(def: TileDef): BrainDef | null {
  const cached = brainCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.brain;
  const parsed = raw == null ? null : v.safeParse(brainSchema, raw);
  const brain =
    parsed?.success && isCoherent(parsed.output as BrainDef)
      ? (parsed.output as BrainDef)
      : null;
  brainCache.set(def, brain);
  return brain;
}
