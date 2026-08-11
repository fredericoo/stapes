import type {
  BrainActionDef,
  BrainConditionDef,
  BrainEffectDef,
} from "./brain";

/**
 * The authorable vocabulary of a brain, as data the editor reads.
 *
 * The runtime knows conditions, actions and effects as switch arms and valibot
 * variants — code, which the editor cannot enumerate. This is the same set,
 * turned outward: one entry per name, each carrying a default instance and the
 * shape of its parameters, so the editor's dropdowns are fed from here and
 * *cannot* offer a name the runtime does not implement. Add a verb to the
 * runtime and it stays invisible in the editor until it is added here too —
 * which is the right failure, a missing option rather than a broken save.
 *
 * The one duplication this accepts is the default values: `make()` here and the
 * schema in `./brain` must agree on what a fresh `in_range` looks like. They are
 * a few lines apart and both change when a verb does, and the alternative —
 * deriving defaults from a valibot schema — buys less than it costs.
 */

/** How the editor renders and edits one field of a condition/action/effect. */
export type ParamSpec =
  | { key: string; kind: "number"; label: string; min?: number }
  | { key: string; kind: "boolean"; label: string }
  | { key: string; kind: "selector"; label: string }
  | { key: string; kind: "text"; label: string };

type CatalogEntry<T> = {
  label: string;
  /** One-line description shown beside the picker. */
  hint: string;
  params: ParamSpec[];
  /** A fresh instance, for when this name is first chosen. */
  make: () => T;
};

/**
 * Selectors are values rather than registered names, but the editor still
 * offers a bounded set: the live query, plus whatever slots the brain's own
 * transitions have bound. A creature can only read a slot something wrote.
 */
export const LIVE_SELECTOR = "nearest_player";

export const CONDITIONS: Record<
  BrainConditionDef["cond"],
  CatalogEntry<BrainConditionDef>
> = {
  after: {
    label: "after",
    hint: "This long has passed in the current state.",
    params: [{ key: "ms", kind: "number", label: "ms", min: 0 }],
    make: () => ({ cond: "after", ms: 1000 }),
  },
  in_range: {
    label: "in range",
    hint: "Somebody is within this many cells.",
    params: [
      { key: "of", kind: "selector", label: "of" },
      { key: "cells", kind: "number", label: "cells", min: 0 },
    ],
    make: () => ({ cond: "in_range", of: LIVE_SELECTOR, cells: 3 }),
  },
  out_of_range: {
    label: "out of range",
    hint: "Nobody is within this many cells — the exact complement of in range.",
    params: [
      { key: "of", kind: "selector", label: "of" },
      { key: "cells", kind: "number", label: "cells", min: 0 },
    ],
    make: () => ({ cond: "out_of_range", of: LIVE_SELECTOR, cells: 3 }),
  },
  stuck: {
    label: "stuck",
    hint: "Every action in this state failed last turn. A state ending in hold can never be stuck.",
    params: [],
    make: () => ({ cond: "stuck" }),
  },
};

export const ACTIONS: Record<
  BrainActionDef["action"],
  CatalogEntry<BrainActionDef>
> = {
  hold: {
    label: "hold",
    hint: "Stand still, successfully. The usual last line.",
    params: [],
    make: () => ({ action: "hold" }),
  },
  step_random: {
    label: "step random",
    hint: "Step to a random walkable neighbour. Fails when hemmed in.",
    params: [{ key: "allowDrops", kind: "boolean", label: "allow drops" }],
    make: () => ({ action: "step_random" }),
  },
  step_toward: {
    label: "step toward",
    hint: "Close the distance to a target. Fails when nothing gets closer.",
    params: [
      { key: "of", kind: "selector", label: "of" },
      { key: "allowDrops", kind: "boolean", label: "allow drops" },
    ],
    make: () => ({ action: "step_toward", of: LIVE_SELECTOR }),
  },
  step_away_from: {
    label: "step away from",
    hint: "Open the distance to a target. Fails when cornered.",
    params: [
      { key: "of", kind: "selector", label: "of" },
      { key: "allowDrops", kind: "boolean", label: "allow drops" },
    ],
    make: () => ({ action: "step_away_from", of: LIVE_SELECTOR }),
  },
  wait: {
    label: "wait",
    hint: "Stand still for a stretch, then hand its turn to the next line.",
    params: [{ key: "ms", kind: "number", label: "ms", min: 0 }],
    make: () => ({ action: "wait", ms: 1000 }),
  },
  walk_n_steps: {
    label: "walk n steps",
    hint: "Wander a bounded distance, then hand its turn to the next line.",
    params: [
      { key: "steps", kind: "number", label: "steps", min: 1 },
      { key: "allowDrops", kind: "boolean", label: "allow drops" },
    ],
    make: () => ({ action: "walk_n_steps", steps: 3 }),
  },
};

export const EFFECTS: Record<
  BrainEffectDef["effect"],
  CatalogEntry<BrainEffectDef>
> = {
  say: {
    label: "say",
    hint: "A speech bubble over the creature's head, once on entry.",
    params: [{ key: "text", kind: "text", label: "text" }],
    make: () => ({ effect: "say", text: "!" }),
  },
};

export const CONDITION_NAMES = Object.keys(
  CONDITIONS,
) as BrainConditionDef["cond"][];
export const ACTION_NAMES = Object.keys(ACTIONS) as BrainActionDef["action"][];
export const EFFECT_NAMES = Object.keys(EFFECTS) as BrainEffectDef["effect"][];
