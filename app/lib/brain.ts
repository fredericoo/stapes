import * as v from "valibot";
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

export type BrainConditionDef = {
  cond: "after";
  /** Milliseconds in the current state before this holds. */
  ms: number;
};

export type BrainActionDef =
  /** Step to a random walkable neighbour. Fails when hemmed in on all sides. */
  | { action: "step_random" }
  /** Stand still, successfully. The usual last line of a priority list. */
  | { action: "hold" };

export type BrainStateDef = {
  /** Priority list: the first action that does not fail is the one that runs. */
  do: BrainActionDef[];
};

export type BrainTransitionDef = {
  /** A state name, or {@link ANY_STATE}. */
  from: string;
  if: BrainConditionDef;
  to: string;
};

export type BrainDef = {
  initial: string;
  states: Record<string, BrainStateDef>;
  /** Evaluated in order; the first whose condition holds is taken. */
  transitions: BrainTransitionDef[];
};

const stateName = v.pipe(v.string(), v.minLength(1));

const conditionSchema = v.variant("cond", [
  v.object({
    cond: v.literal("after"),
    ms: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
]);

const actionSchema = v.variant("action", [
  v.object({ action: v.literal("step_random") }),
  v.object({ action: v.literal("hold") }),
]);

const brainSchema = v.object({
  initial: stateName,
  states: v.record(
    stateName,
    v.object({ do: v.array(actionSchema) }),
  ),
  transitions: v.array(
    v.object({ from: stateName, if: conditionSchema, to: stateName }),
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
  // A state actually called "any" would be unreachable as a transition source,
  // since the wildcard shadows it — better refused than quietly never matched.
  if (Object.hasOwn(brain.states, ANY_STATE)) return false;
  if (!Object.hasOwn(brain.states, brain.initial)) return false;
  return brain.transitions.every(
    (t) =>
      (t.from === ANY_STATE || Object.hasOwn(brain.states, t.from)) &&
      Object.hasOwn(brain.states, t.to),
  );
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
