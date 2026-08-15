import {
  ANY_STATE,
  type BrainActionDef,
  type BrainConditionDef,
  type BrainDef,
  type BrainTransitionDef,
  type Selector,
} from "../lib/brain";
import { DIRECTIONS, type Coord, type Direction } from "../lib/types";
import { SIGHT_LEVEL_SLACK } from "./constants";
import { DIR_DELTA } from "./movement";
import type { Rng } from "./rng";

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
   * Who this creature has its eye on, as `slot -> actor id`.
   *
   * Written by a transition's `bind` and read by whatever state it leads to.
   * Outlives the state that set it, deliberately: a chase is one commitment
   * held across several states, not a question re-asked in each.
   */
  blackboard: Record<string, string>;
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
   * Who the `heard` condition that just matched was about, for the length of one
   * transition.
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
export type BrainContext = {
  /** Still finishing a walk, a fall, or a shove. */
  busy: boolean;
  rng: Rng;
  /** Where this creature is standing. */
  self: Coord;
  /**
   * Nearest other body standing on `tileId`, or null when there is none — a
   * world with nobody in it, or a creature that is the last of its kind. Never
   * this creature itself. @see NEAREST_PREFIX
   */
  nearestOnTile(tileId: string): string | null;
  /** Where an actor is, or null once they are off the board. */
  positionOf(actorId: string): Coord | null;
  /**
   * Would stepping this way leave nothing underfoot? The board allows it — that
   * is how walking into a hole works — so refusing is a creature's own caution.
   */
  wouldDrop(direction: Direction): boolean;
  /**
   * Ask to walk one cell. False when the board refuses, which is the whole of
   * how an action learns it is blocked.
   */
  step(direction: Direction): boolean;
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
   * Is there a clear line from here to there?
   *
   * A question about the board, so it belongs to whoever holds the board — this
   * side only decides what to do with the answer. @see ./sight
   */
  canSee(at: Coord): boolean;
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
};

/** Something somebody said, as a listening brain sees it. */
export type Utterance = {
  /** Who said it. Resolved to a position through {@link BrainContext.positionOf}. */
  speakerId: string;
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

/** Run a state's entry effects — once, when it is entered. */
function runOnEnter(brain: BrainDef, memory: BrainMemory, ctx: BrainContext) {
  const onEnter = brain.states[memory.state]?.onEnter;
  if (!onEnter) return;
  for (const effect of onEnter) {
    if (effect.effect === "say") ctx.say(effect.text);
  }
}

/** Directions worth trying at all, given how this action feels about ledges. */
function footing(
  directions: Direction[],
  allowDrops: boolean | undefined,
  ctx: BrainContext,
): Direction[] {
  if (allowDrops) return directions;
  return directions.filter((direction) => !ctx.wouldDrop(direction));
}

/**
 * Who a selector names, right now.
 *
 * One arm per kind, exhaustively — which is the half of the tagged shape that
 * pays off here: a new kind added to the union is a type error in this switch
 * rather than a selector that silently answers nobody.
 */
function identify(
  selector: Selector,
  memory: BrainMemory,
  ctx: BrainContext,
): string | null {
  switch (selector.type) {
    case "slot":
      return memory.blackboard[selector.data.name] ?? null;
    case "speaker":
      return memory.heardFrom;
    case "attacker":
      return memory.hurtBy;
    case "nearest":
      return ctx.nearestOnTile(selector.data.tileId);
  }
}

/** Where a selector's subject is, or null when there is nobody to point at. */
function locate(
  selector: Selector,
  memory: BrainMemory,
  ctx: BrainContext,
): Coord | null {
  const id = identify(selector, memory, ctx);
  return id === null ? null : ctx.positionOf(id);
}

/** Steps apart on the plan, ignoring elevation. */
function stepsApart(a: Coord, b: Coord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function within(self: Coord, other: Coord, cells: number): boolean {
  if (Math.abs(self.z - other.z) > SIGHT_LEVEL_SLACK) return false;
  return stepsApart(self, other) <= cells;
}

/** Within `cells` and with nothing in the way. */
function inSight(
  at: Coord | null,
  cells: number,
  ctx: BrainContext,
): at is Coord {
  return at !== null && within(ctx.self, at, cells) && ctx.canSee(at);
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
    const at = ctx.positionOf(utterance.speakerId);
    if (at === null) continue;
    if (!within(ctx.self, at, condition.cells)) continue;
    if (condition.los && !ctx.canSee(at)) continue;
    memory.heardFrom = utterance.speakerId;
    return true;
  }
  return false;
}

function holds(
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
      return at !== null && within(ctx.self, at, condition.cells);
    }
    case "out_of_range": {
      const at = locate(condition.of, memory, ctx);
      // A target that has left the world is as out of range as one that walked
      // off, and answering anything else would strand a creature chasing a
      // ghost. This is also what makes the two conditions exact complements.
      return at === null || !within(ctx.self, at, condition.cells);
    }
    case "in_los":
      return inSight(locate(condition.of, memory, ctx), condition.cells, ctx);
    case "out_of_los":
      // Gone, too far, or behind something — the same complement rule, now with
      // one more way to be lost.
      return !inSight(locate(condition.of, memory, ctx), condition.cells, ctx);
    case "heard":
      return heardFrom(condition, memory, ctx);
    case "attacked":
      return struckBy(memory, ctx);
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
 * Step so as to change the distance to `target` in the direction `want` asks
 * for: `closer` for a chase, `further` for a flight.
 *
 * Only directions that genuinely improve matters are tried, and that filter is
 * doing real work — without it a blocked chaser would take a sideways or
 * backward step, which reads as a creature changing its mind rather than one
 * stuck. Failing instead lets the priority list fall through to whatever the
 * author put underneath.
 *
 * No route-finding: this is one step, judged on its own. A cat that rounds a
 * corner will press itself flat against the wall and follow in spirit, which is
 * the known cost of leaving A* out and the reason it is written down.
 */
function stepRelativeTo(
  target: Coord,
  want: "closer" | "further",
  allowDrops: boolean | undefined,
  ctx: BrainContext,
): ActionStatus {
  if (ctx.busy) return "running";

  const now = stepsApart(ctx.self, target);
  const sign = want === "closer" ? 1 : -1;

  // Shuffled before sorting, so the tie between two equally good directions —
  // which is most of the board when a target is diagonal — breaks differently
  // each time rather than always favouring north. Still reproducible: the
  // shuffle is the world's own seeded dice.
  const candidates = footing(ctx.rng.shuffle([...DIRECTIONS]), allowDrops, ctx)
    .map((direction) => {
      const { dx, dy } = DIR_DELTA[direction];
      const after = stepsApart(
        { x: ctx.self.x + dx, y: ctx.self.y + dy, z: ctx.self.z },
        target,
      );
      return { direction, gain: (now - after) * sign };
    })
    .filter((candidate) => candidate.gain > 0)
    .sort((a, b) => b.gain - a.gain);

  for (const { direction } of candidates) {
    if (ctx.step(direction)) return "success";
  }
  return "failure";
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
      const id = identify(action.of, memory, ctx);
      // Nobody in the slot. A failure rather than a stand-still, so a state can
      // read "hit them, else chase them, else hold" straight down the list.
      if (id === null) return "failure";
      return ctx.attack(id) ? "success" : "failure";
    }
    case "step_toward":
    case "step_away_from": {
      const at = locate(action.of, memory, ctx);
      // Nobody to move relative to. A failure rather than a stand-still, so the
      // author's next line gets its turn.
      if (!at) return "failure";
      return stepRelativeTo(
        at,
        action.action === "step_toward" ? "closer" : "further",
        action.allowDrops,
        ctx,
      );
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
    const id = identify(selector, memory, ctx);
    if (id === null) {
      delete memory.blackboard[slot];
    } else {
      memory.blackboard[slot] = id;
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
