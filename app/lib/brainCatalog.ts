import {
  MAX_HEALTH_PERCENT,
  MAX_HOUR_OF_DAY,
  nearest,
  thing,
  type BrainActionDef,
  type BrainConditionDef,
  type BrainEffectDef,
} from "./brain";
import { PLAYER_TILE_ID } from "../game/constants";

export type ParamSpec =
  | { key: string; kind: "number"; label: string; min?: number; max?: number }
  | { key: string; kind: "boolean"; label: string }
  | { key: string; kind: "selector"; label: string }
  | { key: string; kind: "speaker"; label: string }
  | { key: string; kind: "text"; label: string; optional?: boolean }
  | { key: string; kind: "status"; label: string }
  | { key: string; kind: "ground"; label: string }
  | { key: string; kind: "aim"; label: string; spell: string }
  | { key: string; kind: "spell"; label: string }
  | {
      key: string;
      kind: "tile";
      label: string;
      optional?: boolean;
      tiles: TileFilter;
    };

export type TileFilter = "item" | "consumable";

type CatalogEntry<T> = {
  label: string;
  hint: string;
  params: ParamSpec[];
  make: () => T;
};

export const DEFAULT_SELECTOR = nearest(PLAYER_TILE_ID);

export const DEFAULT_THING = thing(PLAYER_TILE_ID);

export const CONDITIONS: Record<BrainConditionDef["cond"], CatalogEntry<BrainConditionDef>> = {
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
  status: {
    label: "status",
    hint: "This body is under a named condition, with at least this long left. Leave the time at zero to ask only whether it is running. Its `not` is how hunger is authored — a wolf with no fed left, or none at all.",
    params: [
      { key: "id", kind: "status", label: "status" },
      { key: "atLeastMs", kind: "number", label: "at least ms", min: 0 },
    ],
    make: () => ({ cond: "status", id: "fed" }),
  },
  health: {
    label: "health",
    hint: "This body is down to this share of its hit points or below. A share rather than a number of points, so half is half on a rat and on a troll. Its `not` is a creature that only fights while it is fresh.",
    params: [
      {
        key: "atMostPercent",
        kind: "number",
        label: "at most %",
        min: 0,
        max: MAX_HEALTH_PERCENT,
      },
    ],
    make: () => ({ cond: "health", atMostPercent: 33 }),
  },
  time_of_day: {
    label: "time of day",
    hint: "The world's clock is at or past the first hour and before the second. A window whose start is later than its end runs through midnight, so 19 to 5 is the night. Equal hours never hold, and their not always does.",
    params: [
      { key: "fromHour", kind: "number", label: "from hour", min: 0, max: MAX_HOUR_OF_DAY },
      { key: "toHour", kind: "number", label: "to hour", min: 0, max: MAX_HOUR_OF_DAY },
    ],
    make: () => ({ cond: "time_of_day", fromHour: 19, toHour: 4 }),
  },
  below_level: {
    label: "below level",
    hint: "This body is standing on a level lower than this one. Level 0 is the surface, so below 0 is underground and its not is under the sky.",
    params: [{ key: "level", kind: "number", label: "level" }],
    make: () => ({ cond: "below_level", level: 0 }),
  },
  carrying: {
    label: "carrying",
    hint: "There is something in this body's bag. Leave the tile empty for anything at all. A body with no bag carries nothing.",
    params: [
      {
        key: "tileId",
        kind: "tile",
        label: "tile",
        optional: true,
        tiles: "item",
      },
    ],
    make: () => ({ cond: "carrying" }),
  },
};

export const ACTIONS: Record<BrainActionDef["action"], CatalogEntry<BrainActionDef>> = {
  hold: {
    label: "hold",
    hint: "Stand still, successfully. The usual last line.",
    params: [],
    make: () => ({ action: "hold" }),
  },
  step_random: {
    label: "step random",
    hint: "Step to a random walkable neighbour, never onto a flame or a portal, nor into water unless the body swims. Fails when hemmed in.",
    params: [{ key: "allowDrops", kind: "boolean", label: "allow drops" }],
    make: () => ({ action: "step_random" }),
  },
  step_toward: {
    label: "step toward",
    hint: "Walk a route to a target, round slow ground when that is quicker and round water unless the body swims. Fails once beside them, or with no way there.",
    params: [
      { key: "of", kind: "selector", label: "of" },
      { key: "allowDrops", kind: "boolean", label: "allow drops" },
    ],
    make: () => ({ action: "step_toward", of: DEFAULT_SELECTOR }),
  },
  step_away_from: {
    label: "step away from",
    hint: "Open the distance to a target, keeping out of water unless the body swims. Fails when cornered.",
    params: [
      { key: "of", kind: "selector", label: "of" },
      { key: "allowDrops", kind: "boolean", label: "allow drops" },
    ],
    make: () => ({ action: "step_away_from", of: DEFAULT_SELECTOR }),
  },
  attack_range: {
    label: "attack range",
    hint: "Walk up until the body's weapon can reach the target, and no closer: beside it for a melee weapon, as far out as it shoots for a bow. Backs off inside a bow's minimum range, walks up when out of reach or behind a wall. Fails once in reach, so put the attack on the next line.",
    params: [
      { key: "of", kind: "selector", label: "of" },
      { key: "allowDrops", kind: "boolean", label: "allow drops" },
    ],
    make: () => ({ action: "attack_range", of: DEFAULT_SELECTOR }),
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
  cast: {
    label: "cast",
    hint: "Cast one of this body's own spells, by its position on the Spells tab. Holds the line for as long as the bar takes. Fails on a position it has no spell at, one still cooling, a caster short of what it asks, or a target out of reach. A spell that lands on its caster takes no target. With no target, a spell that needs one fails, except a conjure, which lands in front of the caster.",
    params: [
      { key: "spell", kind: "spell", label: "spell" },
      { key: "of", kind: "aim", label: "at", spell: "spell" },
    ],
    make: () => ({ action: "cast", spell: 1 }),
  },
  extract: {
    label: "extract",
    hint: "Work a thing beside it for what it is made of. Holds the line for as long as the pull takes. Fails on anything that is not a thing, is out of reach, is spent, or will not fit in the bag.",
    params: [{ key: "of", kind: "selector", label: "of" }],
    make: () => ({ action: "extract", of: DEFAULT_THING }),
  },
  consume: {
    label: "consume",
    hint: "Eat or drink. Out of the bag by default — leave the tile empty for the first consumable in there — or off the ground by naming a thing beside it, which is what a wolf does with a carcass.",
    params: [
      { key: "of", kind: "ground", label: "off the ground" },
      {
        key: "tileId",
        kind: "tile",
        label: "tile",
        optional: true,
        tiles: "consumable",
      },
    ],
    make: () => ({ action: "consume" }),
  },
};

export const EFFECTS: Record<BrainEffectDef["effect"], CatalogEntry<BrainEffectDef>> = {
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

export const CONDITION_NAMES = Object.keys(CONDITIONS) as BrainConditionDef["cond"][];
export const ACTION_NAMES = Object.keys(ACTIONS) as BrainActionDef["action"][];
export const EFFECT_NAMES = Object.keys(EFFECTS) as BrainEffectDef["effect"][];
