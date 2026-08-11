import {
  ANY_STATE,
  slotOf,
  type BrainActionDef,
  type BrainConditionDef,
  type BrainDef,
  type BrainTransitionDef,
  type Selector,
} from "../lib/brain";
import { DIRECTIONS, type Coord, type Direction } from "../lib/types";
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
  /** Nearest connected player, or null in a world with nobody in it. */
  nearestPlayerId(): string | null;
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
};

/**
 * Floors up or down that still count as being near somebody.
 *
 * The same slack interaction already uses for reach. Distance is otherwise
 * counted in steps on the plan, not as the crow flies: a creature that thinks
 * in cells it could walk is a creature whose behaviour matches the board.
 */
const SIGHT_LEVEL_SLACK = 1;

export function initialMemory(brain: BrainDef): BrainMemory {
  return {
    state: brain.initial,
    msInState: 0,
    blackboard: {},
    stuck: false,
  };
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

/** Who a selector names, right now. */
function identify(
  selector: Selector,
  memory: BrainMemory,
  ctx: BrainContext,
): string | null {
  const slot = slotOf(selector);
  if (slot !== null) return memory.blackboard[slot] ?? null;
  return ctx.nearestPlayerId();
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
  }
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

function runAction(
  action: BrainActionDef,
  memory: BrainMemory,
  ctx: BrainContext,
): ActionStatus {
  switch (action.action) {
    case "hold":
      return "success";
    case "step_random": {
      // A step in flight is a step still being taken, not a new one to start.
      if (ctx.busy) return "running";
      // Every legal direction gets a turn, in an unbiased order: "pick one and
      // give up if it is blocked" would leave a creature in a corridor standing
      // still three times out of four.
      const options = footing(
        ctx.rng.shuffle([...DIRECTIONS]),
        action.allowDrops,
        ctx,
      );
      for (const direction of options) {
        if (ctx.step(direction)) return "success";
      }
      return "failure";
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
    }
  }

  const state = brain.states[memory.state];
  if (!state) return;

  for (const action of state.do) {
    if (runAction(action, memory, ctx) !== "failure") {
      memory.stuck = false;
      return;
    }
  }

  // Nothing left to try. An empty list is not stuck — a state that was authored
  // to do nothing is doing exactly that, and nothing failed to happen.
  memory.stuck = state.do.length > 0;
}
