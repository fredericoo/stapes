import {
  nearest,
  type BrainActionDef,
  type BrainConditionDef,
  type BrainEffectDef,
} from "./brain";
import { PLAYER_TILE_ID } from "../game/constants";

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
  /**
   * An optional {@link SpeakerFilter} — a match and a selector, or nothing at
   * all. Its own kind rather than a selector beside a picklist, because
   * "anybody" is the absence of the whole field and two controls that have to
   * agree about that would let the editor author half of one.
   */
  | { key: string; kind: "speaker"; label: string }
  /**
   * A line of text. `optional` makes an empty box mean the *absence* of the
   * field rather than an empty string — which is a real distinction wherever
   * blank is authorable: a `heard_noise` with no word listens for any sound at
   * all, and writing `""` there would be a word of length zero that nothing
   * parses.
   */
  | { key: string; kind: "text"; label: string; optional?: boolean };

type CatalogEntry<T> = {
  label: string;
  /** One-line description shown beside the picker. */
  hint: string;
  params: ParamSpec[];
  /** A fresh instance, for when this name is first chosen. */
  make: () => T;
};

/**
 * What a freshly picked condition or action points at until the author says
 * otherwise.
 *
 * The player rather than any other tile, because every verb this is a default for
 * — notice, chase, swing — is overwhelmingly authored about the person. A flock
 * or a pack is the interesting case, and interesting cases are the ones somebody
 * is already choosing deliberately.
 */
export const DEFAULT_SELECTOR = nearest(PLAYER_TILE_ID);

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
    make: () => ({ cond: "in_range", of: DEFAULT_SELECTOR, cells: 3 }),
  },
  out_of_range: {
    label: "out of range",
    hint: "Nobody is within this many cells — the exact complement of in range.",
    params: [
      { key: "of", kind: "selector", label: "of" },
      { key: "cells", kind: "number", label: "cells", min: 0 },
    ],
    make: () => ({ cond: "out_of_range", of: DEFAULT_SELECTOR, cells: 3 }),
  },
  in_los: {
    label: "in sight",
    hint: "Within this many cells and in plain view — no full-height wall in between.",
    params: [
      { key: "of", kind: "selector", label: "of" },
      { key: "cells", kind: "number", label: "cells", min: 0 },
    ],
    make: () => ({ cond: "in_los", of: DEFAULT_SELECTOR, cells: 5 }),
  },
  out_of_los: {
    label: "out of sight",
    hint: "Too far, behind something, or gone — the exact complement of in sight.",
    params: [
      { key: "of", kind: "selector", label: "of" },
      { key: "cells", kind: "number", label: "cells", min: 0 },
    ],
    make: () => ({ cond: "out_of_los", of: DEFAULT_SELECTOR, cells: 5 }),
  },
  heard: {
    label: "heard",
    hint: "Somebody within this many cells said something containing these letters. Fires once per thing said. Narrow it by voice to tell the one you are talking to from a passer-by.",
    params: [
      { key: "text", kind: "text", label: "text" },
      { key: "cells", kind: "number", label: "cells", min: 0 },
      { key: "los", kind: "boolean", label: "must see them" },
      { key: "from", kind: "speaker", label: "from" },
    ],
    make: () => ({ cond: "heard", text: "ps", cells: 5, los: true }),
  },
  heard_noise: {
    label: "heard noise",
    hint: "Something within this many cells made a sound. Leave the text empty for any sound at all. Goes round corners — sound always does. Bind the speaker selector to remember what made it.",
    params: [
      { key: "text", kind: "text", label: "text", optional: true },
      { key: "cells", kind: "number", label: "cells", min: 0 },
    ],
    make: () => ({ cond: "heard_noise", cells: 8 }),
  },
  attacked: {
    label: "attacked",
    hint: "Somebody swung at this creature since its last turn. Bind the attacker selector to remember who.",
    params: [],
    make: () => ({ cond: "attacked" }),
  },
  stuck: {
    label: "stuck",
    hint: "Every action in this state failed last turn. A state ending in hold can never be stuck.",
    params: [],
    make: () => ({ cond: "stuck" }),
  },
  talking: {
    label: "talking",
    hint: "This body's dialog has a partner. Use it to stand still for a conversation, and its not to wander off after.",
    params: [],
    make: () => ({ cond: "talking" }),
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
    hint: "Walk a route to a target. Fails once beside them, or with no way there.",
    params: [
      { key: "of", kind: "selector", label: "of" },
      { key: "allowDrops", kind: "boolean", label: "allow drops" },
    ],
    make: () => ({ action: "step_toward", of: DEFAULT_SELECTOR }),
  },
  step_away_from: {
    label: "step away from",
    hint: "Open the distance to a target. Fails when cornered.",
    params: [
      { key: "of", kind: "selector", label: "of" },
      { key: "allowDrops", kind: "boolean", label: "allow drops" },
    ],
    make: () => ({ action: "step_away_from", of: DEFAULT_SELECTOR }),
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
  attack: {
    label: "attack",
    hint: "Swing at a target in an adjacent cell. Fails when out of reach, still recovering, or aimed at something with no hit points.",
    params: [{ key: "of", kind: "selector", label: "of" }],
    make: () => ({ action: "attack", of: DEFAULT_SELECTOR }),
  },
};

export const EFFECTS: Record<
  BrainEffectDef["effect"],
  CatalogEntry<BrainEffectDef>
> = {
  say: {
    label: "say",
    hint: "A speech bubble over the creature's head, once on entry. Named as its speaker — use noise for anything that is not language. {slot} becomes the name of whoever is in that slot.",
    params: [{ key: "text", kind: "text", label: "text" }],
    make: () => ({ effect: "say", text: "hello" }),
  },
  noise: {
    label: "noise",
    hint: "A sound the room heard, once on entry — hissing, barking, a rustle. Written where it happened, with nobody's name on it. {slot} becomes the name of whoever is in that slot.",
    params: [{ key: "text", kind: "text", label: "text" }],
    make: () => ({ effect: "noise", text: "sss" }),
  },
};

export const CONDITION_NAMES = Object.keys(
  CONDITIONS,
) as BrainConditionDef["cond"][];
export const ACTION_NAMES = Object.keys(ACTIONS) as BrainActionDef["action"][];
export const EFFECT_NAMES = Object.keys(EFFECTS) as BrainEffectDef["effect"][];
