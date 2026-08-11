import {
  ANY_STATE,
  type BrainActionDef,
  type BrainConditionDef,
  type BrainDef,
} from "../lib/brain";
import { DIRECTIONS, type Direction } from "../lib/types";
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
  /**
   * Ask to walk one cell. False when the board refuses, which is the whole of
   * how an action learns it is blocked.
   */
  step(direction: Direction): boolean;
};

export function initialMemory(brain: BrainDef): BrainMemory {
  return { state: brain.initial, msInState: 0 };
}

function holds(condition: BrainConditionDef, memory: BrainMemory): boolean {
  switch (condition.cond) {
    case "after":
      return memory.msInState >= condition.ms;
  }
}

function runAction(action: BrainActionDef, ctx: BrainContext): ActionStatus {
  switch (action.action) {
    case "hold":
      return "success";
    case "step_random": {
      // A step in flight is a step still being taken, not a new one to start.
      if (ctx.busy) return "running";
      // Every legal direction gets a turn, in an unbiased order: "pick one and
      // give up if it is blocked" would leave a creature in a corridor standing
      // still three times out of four.
      for (const direction of ctx.rng.shuffle([...DIRECTIONS])) {
        if (ctx.step(direction)) return "success";
      }
      return "failure";
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
function nextState(brain: BrainDef, memory: BrainMemory): string | null {
  for (const transition of brain.transitions) {
    if (transition.from !== ANY_STATE && transition.from !== memory.state) {
      continue;
    }
    if (holds(transition.if, memory)) return transition.to;
  }
  return null;
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

  const next = nextState(brain, memory);
  if (next !== null && next !== memory.state) {
    memory.state = next;
    memory.msInState = 0;
  }

  const state = brain.states[memory.state];
  if (!state) return;

  for (const action of state.do) {
    if (runAction(action, ctx) !== "failure") return;
  }
}
