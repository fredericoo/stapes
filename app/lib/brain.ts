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

/**
 * How a brain names somebody other than itself.
 *
 * Two forms, and the difference between them is the whole reason a blackboard
 * exists. `nearest_player` is a question asked fresh — whoever is closest right
 * now. `$slot` is a name written down earlier, by the transition that bound it.
 *
 * A state that chases has to use the second. Re-asking "who is nearest" every
 * tick makes a creature standing between two people flip between them and
 * jitter on the spot; binding on the way in means it commits to the one that
 * set it off, and keeps committing until something says otherwise.
 */
export type Selector = "nearest_player" | `$${string}`;

/** The bound-slot form, `$target`, as opposed to a live query. */
export function slotOf(selector: Selector): string | null {
  return selector.startsWith("$") ? selector.slice(1) : null;
}

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
  | { cond: "stuck" };

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

export type BrainActionDef =
  /** Step to a random walkable neighbour. Fails when hemmed in on all sides. */
  | { action: "step_random"; allowDrops?: boolean }
  /** Stand still, successfully. The usual last line of a priority list. */
  | { action: "hold" }
  /** Step so as to close the distance. Fails when nothing gets closer. */
  | ({ action: "step_toward" } & Steering)
  /** Step so as to open it. Fails when nothing gets further — cornered. */
  | ({ action: "step_away_from" } & Steering);

export type BrainStateDef = {
  /** Priority list: the first action that does not fail is the one that runs. */
  do: BrainActionDef[];
};

export type BrainTransitionDef = {
  /** A state name, or {@link ANY_STATE}. */
  from: string;
  if: BrainConditionDef;
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

/** `nearest_player`, or `$` and a slot name. Anything else is not a selector. */
const selectorSchema = v.union([
  v.literal("nearest_player"),
  v.pipe(v.string(), v.regex(/^\$[A-Za-z0-9_]+$/)),
]);

const cells = v.pipe(v.number(), v.integer(), v.minValue(0));

const conditionSchema = v.variant("cond", [
  v.object({
    cond: v.literal("after"),
    ms: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
  v.object({ cond: v.literal("in_range"), of: selectorSchema, cells }),
  v.object({ cond: v.literal("out_of_range"), of: selectorSchema, cells }),
  v.object({ cond: v.literal("stuck") }),
]);

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
]);

const brainSchema = v.object({
  initial: stateName,
  states: v.record(
    stateName,
    v.object({ do: v.array(actionSchema) }),
  ),
  transitions: v.array(
    v.object({
      from: stateName,
      if: conditionSchema,
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
