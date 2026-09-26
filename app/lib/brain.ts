import * as v from "valibot";
import { conditionLeaves, conditionSchema, type ConditionNode } from "./conditions";
import type { TileDef } from "./types";

export const ANY_STATE = "any";

export type Selector =
  | { type: "nearest"; data: { tileIds: string[] } }
  | { type: "thing"; data: { tileIds: string[] } }
  | { type: "slot"; data: { name: string } }
  | { type: "speaker" }
  | { type: "attacker" }
  | { type: "home" };

export const SPEAKER_SELECTOR: Selector = { type: "speaker" };
export const ATTACKER_SELECTOR: Selector = { type: "attacker" };
export const HOME_SELECTOR: Selector = { type: "home" };

export function nearest(...tileIds: string[]): Selector {
  return { type: "nearest", data: { tileIds } };
}

export function thing(...tileIds: string[]): Selector {
  return { type: "thing", data: { tileIds } };
}

export function slot(name: string): Selector {
  return { type: "slot", data: { name } };
}

export function tilesNamedBy(selector: Selector): readonly string[] {
  switch (selector.type) {
    case "nearest":
    case "thing":
      return selector.data.tileIds;
    default:
      return NO_TILES;
  }
}

const NO_TILES: readonly string[] = [];

export function slotTiles(brain: BrainDef, name: string): readonly string[] {
  let agreed: readonly string[] | null = null;
  for (const transition of brain.transitions) {
    const source = transition.bind?.[name];
    if (!source) continue;
    const tileIds = tilesNamedBy(source);
    if (tileIds.length === 0) return NO_TILES;
    if (agreed !== null && !sameTiles(agreed, tileIds)) return NO_TILES;
    agreed = tileIds;
  }
  return agreed ?? NO_TILES;
}

function sameTiles(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const inA = new Set(a);
  return b.every((tileId) => inA.has(tileId));
}

export type SpeakerFilter = { match: "is" | "not"; of: Selector };

export type BrainConditionDef =
  | { cond: "after"; ms: number }
  | { cond: "in_range"; of: Selector; cells: number }
  | { cond: "out_of_range"; of: Selector; cells: number }
  | { cond: "in_los"; of: Selector; cells: number }
  | { cond: "out_of_los"; of: Selector; cells: number }
  | {
      cond: "heard";
      text: string;
      cells: number;
      los?: boolean;
      from?: SpeakerFilter;
    }
  | { cond: "heard_noise"; text?: string; cells: number }
  | { cond: "attacked" }
  | { cond: "stuck" }
  | { cond: "talking" }
  | { cond: "carrying"; tileId?: string }
  | { cond: "status"; id: string; atLeastMs?: number }
  | { cond: "health"; atMostPercent: number }
  | { cond: "time_of_day"; fromHour: number; toHour: number }
  | { cond: "below_level"; level: number };

export type BrainCondition = ConditionNode<BrainConditionDef>;

type Steering = { of: Selector; allowDrops?: boolean };

export type BrainActionDef =
  | { action: "step_random"; allowDrops?: boolean }
  | { action: "hold" }
  | ({ action: "step_toward" } & Steering)
  | ({ action: "step_away_from" } & Steering)
  | ({ action: "attack_range" } & Steering)
  | { action: "wait"; ms: number }
  | { action: "walk_n_steps"; steps: number; allowDrops?: boolean }
  | { action: "attack"; of: Selector }
  | { action: "cast"; spell: number; of?: Selector }
  | { action: "extract"; of: Selector }
  | { action: "consume"; of?: Selector; tileId?: string };

export type BrainEffectDef = { effect: "say"; text: string } | { effect: "noise"; text: string };

export type BrainSignalValue = "on" | "off";

export type BrainEmitDef = { channel: string; value: BrainSignalValue };

export type BrainStateDef = {
  onEnter?: BrainEffectDef[];
  emit?: BrainEmitDef;
  do: BrainActionDef[];
};

export type BrainTransitionDef = {
  from: string;
  if: BrainCondition;
  bind?: Record<string, Selector>;
  to: string;
};

export type BrainDef = {
  initial: string;
  states: Record<string, BrainStateDef>;
  transitions: BrainTransitionDef[];
};

const stateName = v.pipe(v.string(), v.minLength(1));

const selectorSchema = v.variant("type", [
  v.object({
    type: v.literal("nearest"),
    data: v.object({
      tileIds: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
    }),
  }),
  v.object({
    type: v.literal("thing"),
    data: v.object({
      tileIds: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
    }),
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

export const MAX_HEALTH_PERCENT = 100;

export const MAX_HOUR_OF_DAY = 23;

const hourOfDay = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_HOUR_OF_DAY));

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
    text: v.pipe(v.string(), v.minLength(1)),
    cells,
    los: v.optional(v.boolean()),
    from: v.optional(speakerFilterSchema),
  }),
  v.object({
    cond: v.literal("heard_noise"),
    text: v.optional(v.pipe(v.string(), v.minLength(1))),
    cells,
  }),
  v.object({ cond: v.literal("stuck") }),
  v.object({ cond: v.literal("attacked") }),
  v.object({ cond: v.literal("talking") }),
  v.object({
    cond: v.literal("carrying"),
    tileId: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  v.object({
    cond: v.literal("status"),
    id: v.pipe(v.string(), v.minLength(1)),
    atLeastMs: v.optional(durationMs),
  }),
  v.object({
    cond: v.literal("health"),
    atMostPercent: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_HEALTH_PERCENT)),
  }),
  v.object({ cond: v.literal("time_of_day"), fromHour: hourOfDay, toHour: hourOfDay }),
  v.object({ cond: v.literal("below_level"), level: v.pipe(v.number(), v.integer()) }),
]);

const ifSchema = conditionSchema<BrainConditionDef>(leafSchema);

export function isSelector(value: unknown): value is Selector {
  return v.safeParse(selectorSchema, value).success;
}

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
  v.object({
    action: v.literal("attack_range"),
    of: selectorSchema,
    allowDrops,
  }),
  v.object({ action: v.literal("wait"), ms: durationMs }),
  v.object({
    action: v.literal("walk_n_steps"),
    steps: v.pipe(v.number(), v.integer(), v.minValue(1)),
    allowDrops,
  }),
  v.object({ action: v.literal("attack"), of: selectorSchema }),
  v.object({
    action: v.literal("cast"),
    spell: v.pipe(v.number(), v.integer(), v.minValue(1)),
    of: v.optional(selectorSchema),
  }),
  v.object({ action: v.literal("extract"), of: selectorSchema }),
  v.object({
    action: v.literal("consume"),
    of: v.optional(selectorSchema),
    tileId: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
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

function isCoherent(brain: BrainDef): boolean {
  return !validateBrain(brain).some((issue) => issue.severity === "error");
}

export type BrainIssue = {
  severity: "error" | "warn";
  message: string;
};

export function validateBrain(brain: BrainDef): BrainIssue[] {
  const issues: BrainIssue[] = [];
  const names = Object.keys(brain.states);

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

function unreachableStates(brain: BrainDef): string[] {
  const names = Object.keys(brain.states);
  if (!brain.initial || !Object.hasOwn(brain.states, brain.initial)) return [];

  const reached = new Set<string>([brain.initial]);
  for (let grew = true; grew;) {
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

export function resolveBrain(def: TileDef): BrainDef | null {
  const cached = brainCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.brain;
  const parsed = raw == null ? null : v.safeParse(brainSchema, raw);
  const brain =
    parsed?.success && isCoherent(parsed.output as BrainDef) ? (parsed.output as BrainDef) : null;
  brainCache.set(def, brain);
  return brain;
}
