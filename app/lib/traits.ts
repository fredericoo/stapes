import * as v from "valibot";
import {
  ANY_STATE,
  brainShapeProblems,
  fromStates,
  needsExpansion,
  resolveBrain,
  validateBrain,
  type BrainCondition,
  type BrainConditionDef,
  type BrainDef,
  type BrainStateDef,
  type BrainTransitionDef,
  type Selector,
} from "./brain";
import { ACTIONS, CONDITIONS, EFFECTS, type ParamSpec } from "./brainCatalog";
import type { ConditionNode } from "./conditions";
import type { TileDef } from "./types";

export const BANDS = ["idle", "roam", "errand", "need", "rest", "fight", "danger"] as const;

export type Band = (typeof BANDS)[number];

export const REST_STATE = "rest";

export const MAX_TRAIT_DEPTH = 4;

export const PARAM_KINDS = [
  "cells",
  "ms",
  "percent",
  "hour",
  "level",
  "steps",
  "boolean",
  "text",
  "bodies",
  "things",
  "item",
  "consumable",
  "status",
  "spell",
  "selector",
  "condition",
  "actions",
  "band",
  "state",
  "slot",
] as const;

export type ParamKind = (typeof PARAM_KINDS)[number];

export const SLOT_HOLDS = ["body", "thing"] as const;

export type SlotHolds = (typeof SLOT_HOLDS)[number];

export type TraitParam = {
  kind: ParamKind;
  label?: string;
  default?: unknown;
  optional?: boolean;
  band?: Band;
  holds?: SlotHolds;
};

export type TraitLet = { kind: ParamKind; value: unknown };

export type TraitCall = { trait: string; with?: Record<string, unknown> };

export type ArgRef = { arg: string };

export type AuthoredCondition = ConditionNode<BrainConditionDef | ArgRef>;

export type BrainTriggerDef = {
  band?: Band;
  retarget?: boolean;
  if: AuthoredCondition;
  bind?: Record<string, Selector>;
  to: string;
};

export type AuthoredStateDef = BrainStateDef & { band?: Band };

export type AuthoredTransitionDef = Omit<BrainTransitionDef, "if"> & { if: AuthoredCondition };

export type AuthoredBrain = {
  initial: string;
  states: Record<string, AuthoredStateDef>;
  transitions: AuthoredTransitionDef[];
  triggers?: BrainTriggerDef[];
  traits?: TraitCall[];
  let?: Record<string, TraitLet>;
};

export type TraitDef = {
  id: string;
  name: string;
  hint: string;
  params: Record<string, TraitParam>;
  slots: Record<string, SlotHolds>;
  let: Record<string, TraitLet>;
  states: Record<string, unknown>;
  triggers: unknown[];
  transitions: unknown[];
  traits: TraitCall[];
  returns?: string;
};

export type TraitCatalogue = Readonly<Record<string, TraitDef>>;

export type TraitIssue = { severity: "error" | "warn"; message: string };

export type TraitContext = {
  bodies?: ReadonlySet<string>;
  things?: ReadonlySet<string>;
  items?: ReadonlySet<string>;
  consumables?: ReadonlySet<string>;
  statuses?: ReadonlySet<string>;
  spells?: number;
};

export const KIND_LABELS: Record<ParamKind, string> = {
  cells: "a distance in cells",
  ms: "a time in ms",
  percent: "a percentage",
  hour: "an hour of the day",
  level: "a level",
  steps: "a number of steps",
  boolean: "yes or no",
  text: "some text",
  bodies: "a list of bodies",
  things: "a list of things",
  item: "an item",
  consumable: "a consumable",
  status: "a status",
  spell: "a spell",
  selector: "a selector",
  condition: "a condition",
  actions: "a list of actions",
  band: "a band",
  state: "a state",
  slot: "a slot",
};

const nameSchema = v.pipe(v.string(), v.regex(/^[A-Za-z][A-Za-z0-9_]*$/));
const slotName = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_]+$/));
const stateName = v.pipe(v.string(), v.minLength(1));

const paramSchema = v.object({
  kind: v.picklist(PARAM_KINDS),
  label: v.optional(v.string()),
  default: v.optional(v.unknown()),
  optional: v.optional(v.boolean()),
  band: v.optional(v.picklist(BANDS)),
  holds: v.optional(v.picklist(SLOT_HOLDS)),
});

const letSchema = v.object({ kind: v.picklist(PARAM_KINDS), value: v.unknown() });

const callSchema = v.object({
  trait: v.pipe(v.string(), v.minLength(1)),
  with: v.optional(v.record(v.string(), v.unknown())),
});

const traitSchema = v.object({
  id: v.pipe(v.string(), v.regex(/^[a-z0-9-]+$/)),
  name: v.pipe(v.string(), v.minLength(1)),
  hint: v.optional(v.string(), ""),
  params: v.optional(v.record(nameSchema, paramSchema), {}),
  slots: v.optional(v.record(slotName, v.picklist(SLOT_HOLDS)), {}),
  let: v.optional(v.record(nameSchema, letSchema), {}),
  states: v.optional(v.record(stateName, v.unknown()), {}),
  triggers: v.optional(v.array(v.unknown()), []),
  transitions: v.optional(v.array(v.unknown()), []),
  traits: v.optional(v.array(callSchema), []),
  returns: v.optional(v.string()),
});

export function resolveTrait(raw: unknown): TraitDef | null {
  const parsed = v.safeParse(traitSchema, raw);
  return parsed.success ? (parsed.output as TraitDef) : null;
}

export function traitsById(raw: readonly unknown[]): Record<string, TraitDef> {
  const out: Record<string, TraitDef> = {};
  for (const entry of raw) {
    const trait = resolveTrait(entry);
    if (!trait || Object.hasOwn(out, trait.id)) continue;
    out[trait.id] = trait;
  }
  return out;
}

const DROP = Symbol("drop");

type Dropped = typeof DROP;

type Bound = { kind: ParamKind; value: unknown };

const ABSENT = Symbol("absent");

export function isArgRef(value: unknown): value is ArgRef {
  return (
    isRecord(value) && Object.keys(value).length === 1 && typeof (value as ArgRef).arg === "string"
  );
}

function isCall(value: unknown): value is TraitCall {
  return isRecord(value) && typeof value.trait === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entryOf<T>(registry: Record<string, T>, key: unknown): T | undefined {
  return typeof key === "string" && Object.hasOwn(registry, key) ? registry[key] : undefined;
}

export function fits(given: ParamKind, expected: ParamKind): boolean {
  return given === expected || (given === "consumable" && expected === "item");
}

function rank(band: Band): number {
  return BANDS.indexOf(band);
}

/**
 * Every visit a trait body gets goes through one traversal, so checking a
 * trait and expanding it cannot disagree about where an argument may stand.
 * The checker answers with what it was given and records problems; the
 * resolver answers with the value an argument or name stands for.
 */
type Visitor = {
  arg(ref: ArgRef, expect: ParamKind, at: string): unknown;
  literal(value: unknown, expect: ParamKind, at: string): void;
  state(name: unknown, at: string): unknown;
  slot(name: unknown, at: string): unknown;
  holds(selector: unknown, want: SlotHolds | undefined, at: string): void;
  slotHolds(name: unknown): SlotHolds | undefined;
  text(value: string): string;
  problem(at: string, message: string): void;
};

const WANTS_A_BODY = new Set(["attack", "attack_range", "cast"]);
const WANTS_A_THING = new Set(["extract", "switch", "consume"]);

const NUMBER_KINDS: Record<string, ParamKind> = {
  cells: "cells",
  ms: "ms",
  toMs: "ms",
  atLeastMs: "ms",
  atMostPercent: "percent",
  fromHour: "hour",
  toHour: "hour",
  level: "level",
  steps: "steps",
};

function scalarKind(spec: ParamSpec): ParamKind | null {
  switch (spec.kind) {
    case "number":
      return NUMBER_KINDS[spec.key] ?? null;
    case "boolean":
      return "boolean";
    case "text":
      return "text";
    case "status":
      return "status";
    case "spell":
      return "spell";
    case "tile":
      return spec.tiles === "item" ? "item" : "consumable";
    default:
      return null;
  }
}

function within(at: string, step: string): string {
  if (!step) return at;
  return at ? `${at} › ${step}` : step;
}

function mapScalar(raw: unknown, kind: ParamKind | null, visit: Visitor, at: string): unknown {
  if (isArgRef(raw)) {
    if (kind !== null) return visit.arg(raw, kind, at);
    visit.problem(at, "cannot take an argument here");
    return raw;
  }
  if (kind !== null) visit.literal(raw, kind, at);
  return raw;
}

function mapFields(
  item: Record<string, unknown>,
  params: readonly ParamSpec[],
  visit: Visitor,
  at: string,
): Record<string, unknown> | Dropped {
  const out: Record<string, unknown> = { ...item };
  for (const spec of params) {
    if (!Object.hasOwn(item, spec.key)) continue;
    const where = within(at, spec.key);
    const raw = item[spec.key];
    const next =
      spec.kind === "selector" || spec.kind === "aim" || spec.kind === "ground"
        ? mapSelector(raw, visit, where)
        : spec.kind === "speaker"
          ? mapSpeaker(raw, visit, where)
          : mapScalar(raw, scalarKind(spec), visit, where);
    if (next === DROP && spec.kind === "number" && spec.optional) delete out[spec.key];
    else if (next === DROP) return DROP;
    else out[spec.key] = next;
  }
  return out;
}

function mapSelector(raw: unknown, visit: Visitor, at: string): unknown {
  if (isArgRef(raw)) return visit.arg(raw, "selector", at);
  if (!isRecord(raw) || !isRecord(raw.data)) return raw;
  if (raw.type === "nearest" || raw.type === "thing") {
    const kind = raw.type === "nearest" ? "bodies" : "things";
    const tileIds = mapScalar(raw.data.tileIds, kind, visit, within(at, "tiles"));
    if (tileIds === DROP) return DROP;
    return { ...raw, data: { ...raw.data, tileIds } };
  }
  if (raw.type === "slot") {
    const name = visit.slot(raw.data.name, within(at, "slot"));
    if (name === DROP) return DROP;
    return { ...raw, data: { ...raw.data, name } };
  }
  return raw;
}

function mapSpeaker(raw: unknown, visit: Visitor, at: string): unknown {
  if (isArgRef(raw)) {
    visit.problem(at, "cannot take an argument here");
    return raw;
  }
  if (!isRecord(raw)) return raw;
  visit.holds(raw.of, "body", within(at, "of"));
  const of = mapSelector(raw.of, visit, within(at, "of"));
  return of === DROP ? DROP : { ...raw, of };
}

function mapCondition(raw: unknown, visit: Visitor, at: string): unknown {
  if (isArgRef(raw)) return visit.arg(raw, "condition", at);
  if (!isRecord(raw)) return raw;
  if (Array.isArray(raw.rules)) {
    if (raw.rules.length === 0) visit.problem(at, "a group needs at least one rule");
    const rules: unknown[] = [];
    raw.rules.forEach((rule, i) => {
      const next = mapCondition(rule, visit, within(at, `rule ${i + 1}`));
      if (next !== DROP) rules.push(next);
    });
    return rules.length === 0 && raw.rules.length > 0 ? DROP : { ...raw, rules };
  }
  const entry = entryOf(CONDITIONS, raw.cond);
  if (!entry) {
    visit.problem(at, `there is no condition called ${JSON.stringify(raw.cond)}`);
    return raw;
  }
  return mapFields(raw, entry.params, visit, at);
}

function mapAction(raw: unknown, visit: Visitor, at: string): unknown {
  if (!isRecord(raw)) return raw;
  const entry = entryOf(ACTIONS, raw.action);
  if (!entry) {
    visit.problem(at, `there is no action called ${JSON.stringify(raw.action)}`);
    return raw;
  }
  const verb = String(raw.action);
  if (Object.hasOwn(raw, "of")) {
    const want = WANTS_A_BODY.has(verb) ? "body" : WANTS_A_THING.has(verb) ? "thing" : undefined;
    visit.holds(raw.of, want, within(at, "of"));
  }
  return mapFields(raw, entry.params, visit, at);
}

function mapEffect(raw: unknown, visit: Visitor, at: string): unknown {
  if (!isRecord(raw)) return raw;
  if (!entryOf(EFFECTS, raw.effect)) {
    visit.problem(at, `there is no effect called ${JSON.stringify(raw.effect)}`);
    return raw;
  }
  const where = within(at, "text");
  if (isArgRef(raw.text)) {
    const text = visit.arg(raw.text, "text", where);
    return text === DROP ? DROP : { ...raw, text };
  }
  visit.literal(raw.text, "text", where);
  return typeof raw.text === "string" ? { ...raw, text: visit.text(raw.text) } : raw;
}

function mapList(
  raw: unknown,
  item: (value: unknown, visit: Visitor, at: string) => unknown,
  visit: Visitor,
  at: string,
): unknown {
  if (!Array.isArray(raw)) return raw;
  const out: unknown[] = [];
  raw.forEach((value, i) => {
    const next = item(value, visit, within(at, String(i + 1)));
    if (next !== DROP) out.push(next);
  });
  return out;
}

function mapActions(raw: unknown, visit: Visitor, at: string): unknown {
  if (isArgRef(raw)) return visit.arg(raw, "actions", at);
  return mapList(raw, mapAction, visit, at);
}

function mapStateDef(raw: unknown, visit: Visitor, at: string): unknown {
  if (!isRecord(raw)) {
    visit.problem(at, "is not a state");
    return raw;
  }
  const out: Record<string, unknown> = { ...raw };
  if (Object.hasOwn(raw, "band")) {
    const band = mapScalar(raw.band, "band", visit, within(at, "band"));
    if (band === DROP) delete out.band;
    else out.band = band;
  }
  if (Object.hasOwn(raw, "onEnter")) {
    const effects = mapList(raw.onEnter, mapEffect, visit, within(at, "on enter"));
    if (Array.isArray(effects) && effects.length === 0) delete out.onEnter;
    else out.onEnter = effects;
  }
  const actions = mapActions(raw.do, visit, within(at, "do"));
  out.do = actions === DROP ? [] : actions;
  return out;
}

function mapBind(raw: unknown, visit: Visitor, at: string): unknown {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return raw;
  const out: Record<string, unknown> = {};
  for (const [key, selector] of Object.entries(raw)) {
    const where = within(at, `bind ${key}`);
    visit.holds(selector, visit.slotHolds(key), where);
    const name = visit.slot(key, where);
    const source = mapSelector(selector, visit, where);
    if (name === DROP || source === DROP) return DROP;
    out[String(name)] = source;
  }
  return out;
}

type Trigger = {
  band?: Band;
  retarget: boolean;
  if: BrainCondition;
  bind?: Record<string, Selector>;
  to: string;
};

function mapTrigger(raw: unknown, visit: Visitor, at: string): Trigger | Dropped {
  if (!isRecord(raw)) {
    visit.problem(at, "is not a trigger");
    return DROP;
  }
  const band = Object.hasOwn(raw, "band")
    ? mapScalar(raw.band, "band", visit, within(at, "band"))
    : undefined;
  const retarget = Object.hasOwn(raw, "retarget")
    ? mapScalar(raw.retarget, "boolean", visit, within(at, "retarget"))
    : false;
  const cond = mapCondition(raw.if, visit, within(at, "if"));
  const bind = mapBind(raw.bind, visit, at);
  const to = visit.state(raw.to, within(at, "to"));
  if (cond === DROP || bind === DROP || to === DROP) return DROP;
  return {
    ...(band === undefined || band === DROP ? {} : { band: band as Band }),
    retarget: retarget === true,
    if: cond as BrainCondition,
    ...(bind === undefined ? {} : { bind: bind as Record<string, Selector> }),
    to: to as string,
  };
}

function mapTransition(
  raw: unknown,
  visit: Visitor,
  at: string,
  wildcard: boolean,
): BrainTransitionDef | Dropped {
  if (!isRecord(raw)) {
    visit.problem(at, "is not a transition");
    return DROP;
  }
  const where = within(at, "from");
  let from: unknown;
  if (raw.from === ANY_STATE) {
    if (!wildcard) visit.problem(where, "a trait cannot leave from any state; use a trigger");
    from = raw.from;
  } else if (Array.isArray(raw.from)) {
    const names = raw.from.map((name) => visit.state(name, where));
    from = names.includes(DROP) ? DROP : names;
  } else {
    from = visit.state(raw.from, where);
  }
  const cond = mapCondition(raw.if, visit, within(at, "if"));
  const bind = mapBind(raw.bind, visit, at);
  const to = visit.state(raw.to, within(at, "to"));
  if (from === DROP || cond === DROP || bind === DROP || to === DROP) return DROP;
  return {
    from: from as BrainTransitionDef["from"],
    if: cond as BrainCondition,
    ...(bind === undefined ? {} : { bind: bind as Record<string, Selector> }),
    to: to as string,
  };
}

const intFrom = (min: number) => v.pipe(v.number(), v.integer(), v.minValue(min));
const tileList = v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1));
const tileId = v.pipe(v.string(), v.minLength(1));

const SCALARS: Partial<Record<ParamKind, v.GenericSchema>> = {
  cells: intFrom(0),
  ms: intFrom(0),
  percent: v.pipe(intFrom(0), v.maxValue(100)),
  hour: v.pipe(intFrom(0), v.maxValue(23)),
  level: v.pipe(v.number(), v.integer()),
  steps: intFrom(1),
  boolean: v.boolean(),
  text: v.pipe(v.string(), v.minLength(1)),
  bodies: tileList,
  things: tileList,
  item: tileId,
  consumable: tileId,
  status: tileId,
  spell: intFrom(1),
  band: v.picklist(BANDS),
};

function outsideCatalogue(value: unknown, kind: ParamKind, context: TraitContext): string | null {
  const names = (known: ReadonlySet<string> | undefined, what: string) => {
    if (!known) return null;
    const list = Array.isArray(value) ? value : [value];
    const missing = list.filter((one) => typeof one === "string" && !known.has(one));
    return missing.length === 0 ? null : `${missing.join(", ")} ${what}`;
  };
  switch (kind) {
    case "bodies":
      return names(context.bodies, "cannot be a body");
    case "things":
      return names(context.things, "is not a thing a body can find");
    case "item":
      return names(context.items, "is not an item");
    case "consumable":
      return names(context.consumables, "is not a consumable");
    case "status":
      return names(context.statuses, "is not a status");
    case "spell":
      return context.spells !== undefined && typeof value === "number" && value > context.spells
        ? `this body has no spell ${value}`
        : null;
    default:
      return null;
  }
}

type CheckScope = {
  values: ReadonlyMap<string, ParamKind>;
  states: ReadonlySet<string>;
  slots: ReadonlySet<string> | null;
  holds: ReadonlyMap<string, SlotHolds>;
};

function selectorHolds(selector: unknown, visit: Visitor): SlotHolds | undefined {
  if (!isRecord(selector)) return undefined;
  switch (selector.type) {
    case "attacker":
    case "speaker":
    case "nearest":
      return "body";
    case "thing":
      return "thing";
    case "slot":
      return isRecord(selector.data) ? visit.slotHolds(selector.data.name) : undefined;
    default:
      return undefined;
  }
}

class Checker implements Visitor {
  constructor(
    private readonly scope: CheckScope,
    private readonly issues: TraitIssue[],
    private readonly label: string,
    private readonly context: TraitContext,
  ) {}

  arg(ref: ArgRef, expect: ParamKind, at: string): unknown {
    const kind = this.scope.values.get(ref.arg);
    if (kind !== undefined) {
      if (!fits(kind, expect)) {
        this.problem(at, `wants ${KIND_LABELS[expect]}, and ${ref.arg} is ${KIND_LABELS[kind]}`);
      }
    } else if (this.scope.slots?.has(ref.arg) || this.scope.states.has(ref.arg)) {
      this.problem(at, `${ref.arg} is a name: write it where the slot or state goes`);
    } else {
      this.problem(at, `${ref.arg} is not a parameter here`);
    }
    return ref;
  }

  holds(selector: unknown, want: SlotHolds | undefined, at: string): void {
    if (want === undefined) return;
    const held = selectorHolds(selector, this);
    if (held !== undefined && held !== want) {
      this.problem(at, `wants a ${want}, and this names a ${held}`);
    }
  }

  slotHolds(name: unknown): SlotHolds | undefined {
    return typeof name === "string" ? this.scope.holds.get(name) : undefined;
  }

  literal(value: unknown, expect: ParamKind, at: string): void {
    const schema = SCALARS[expect];
    if (schema && !v.safeParse(schema, value).success) {
      this.problem(at, `wants ${KIND_LABELS[expect]}, not ${JSON.stringify(value)}`);
      return;
    }
    const missing = outsideCatalogue(value, expect, this.context);
    if (missing) this.problem(at, missing);
  }

  state(name: unknown, at: string): unknown {
    if (typeof name !== "string" || !this.scope.states.has(name)) {
      this.problem(at, `${JSON.stringify(name)} is not a state here`);
    }
    return name;
  }

  slot(name: unknown, at: string): unknown {
    const valid = typeof name === "string" && v.safeParse(slotName, name).success;
    if (!valid || (this.scope.slots !== null && !this.scope.slots.has(name))) {
      this.problem(at, `${JSON.stringify(name)} is not a slot here`);
    }
    return name;
  }

  text(value: string): string {
    return value;
  }

  problem(at: string, message: string): void {
    this.issues.push({ severity: "error", message: `${within(this.label, at)}: ${message}` });
  }
}

type Scope = {
  label: string;
  path: string;
  values: Map<string, Bound | typeof ABSENT>;
  states: Map<string, string>;
  slots: Map<string, string> | null;
};

const SLOT_PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

class Resolver implements Visitor {
  constructor(
    private readonly scope: Scope,
    private readonly build: Build,
  ) {}

  arg(ref: ArgRef): unknown {
    const bound = this.scope.values.get(ref.arg);
    if (bound === undefined) {
      this.problem("", `${ref.arg} is not a parameter here`);
      return DROP;
    }
    return bound === ABSENT ? DROP : bound.value;
  }

  literal(): void {}

  state(name: unknown, at: string): unknown {
    const global = typeof name === "string" ? this.scope.states.get(name) : undefined;
    if (
      global === undefined &&
      typeof name === "string" &&
      this.scope.values.get(name) === ABSENT
    ) {
      return DROP;
    }
    if (global === undefined) {
      this.problem(at, `${JSON.stringify(name)} is not a state here`);
      return DROP;
    }
    return global;
  }

  slot(name: unknown): unknown {
    if (this.scope.slots === null || typeof name !== "string") return name;
    return this.scope.slots.get(name) ?? name;
  }

  holds(): void {}

  slotHolds(): SlotHolds | undefined {
    return undefined;
  }

  text(value: string): string {
    const slots = this.scope.slots;
    if (slots === null) return value;
    return value.replace(SLOT_PLACEHOLDER, (whole, name: string) => {
      const global = slots.get(name);
      return global === undefined ? whole : `{${global}}`;
    });
  }

  problem(at: string, message: string): void {
    this.build.issue(within(this.scope.label, at), message);
  }
}

/** One expansion of one brain: everything the calls inside it contribute. */
class Build {
  readonly issues: TraitIssue[] = [];
  readonly states = new Map<string, { def: BrainStateDef; local: boolean }>();
  readonly bands = new Map<string, Band>();
  readonly triggers: Trigger[] = [];
  readonly own: BrainTransitionDef[] = [];
  readonly transitions: BrainTransitionDef[] = [];
  private readonly stack: string[] = [];
  private readonly prefixes = new Set<string>();
  private instances = 0;

  constructor(
    readonly catalogue: TraitCatalogue,
    readonly rest: string,
  ) {}

  issue(at: string, message: string): void {
    this.issues.push({ severity: "error", message: `${at}: ${message}` });
  }

  raise(state: string, band: unknown): void {
    const valid = BANDS.includes(band as Band) ? (band as Band) : "idle";
    const held = this.bands.get(state);
    if (held === undefined || rank(valid) > rank(held)) this.bands.set(state, valid);
  }

  addState(name: string, raw: unknown, local: boolean): void {
    if (!isRecord(raw)) return;
    if (this.states.has(name)) {
      this.issue(name, "a trait brings a state with the same name as one of the brain's own");
      return;
    }
    const { band, ...def } = raw as AuthoredStateDef;
    this.states.set(name, { def, local });
    this.raise(name, band ?? "idle");
  }

  /**
   * The brain's own states are added before its lets are bound, so the table
   * keeps them first and in their authored order, and are swapped for their
   * resolved selves once a let they name has a value.
   */
  resolveOwn(name: string, resolved: unknown): void {
    if (!isRecord(resolved) || !this.states.has(name)) return;
    const { band: _band, ...def } = resolved as AuthoredStateDef;
    this.states.set(name, { def, local: false });
  }

  instantiate(call: TraitCall, caller: Scope, at: string): string | null {
    const where = within(caller.label, at);
    const def = entryOf(this.catalogue, call.trait);
    if (!def) {
      this.issue(where, `there is no trait called ${JSON.stringify(call.trait)}`);
      return null;
    }
    if (this.stack.includes(def.id)) {
      this.issue(where, `${def.id} calls itself through ${[...this.stack, def.id].join(" › ")}`);
      return null;
    }
    if (this.stack.length >= MAX_TRAIT_DEPTH) {
      this.issue(where, `calls are nested more than ${MAX_TRAIT_DEPTH} deep`);
      return null;
    }
    this.stack.push(def.id);
    const n = ++this.instances;
    const scope: Scope = {
      label: within(caller.label, def.id),
      path: this.claimPath(caller.path ? `${caller.path}/${def.id}` : def.id),
      values: new Map(),
      states: new Map([[REST_STATE, this.rest]]),
      slots: new Map(),
    };
    for (const name of Object.keys(def.slots)) scope.slots!.set(name, `${name}_${n}`);
    for (const name of Object.keys(def.states)) scope.states.set(name, `${scope.path}/${name}`);
    for (const [name, param] of Object.entries(def.params)) {
      this.bindParam(name, param, call.with?.[name], caller, scope, n);
    }
    for (const [name, bound] of Object.entries(def.let)) this.bindLet(name, bound, scope);

    const resolve = new Resolver(scope, this);
    for (const [name, raw] of Object.entries(def.states)) {
      this.addState(scope.states.get(name)!, mapStateDef(raw, resolve, `state ${name}`), true);
    }
    def.traits.forEach((nested, i) => this.instantiate(nested, scope, `call ${i + 1}`));
    def.triggers.forEach((raw, i) => this.addTrigger(mapTrigger(raw, resolve, `trigger ${i + 1}`)));
    def.transitions.forEach((raw, i) => {
      const row = mapTransition(raw, resolve, `transition ${i + 1}`, false);
      if (row !== DROP) this.transitions.push(row);
    });
    this.stack.pop();
    if (def.returns === undefined) return null;
    return scope.states.get(def.returns) ?? null;
  }

  addTrigger(trigger: Trigger | Dropped): void {
    if (trigger !== DROP) this.triggers.push(trigger);
  }

  bindLet(name: string, bound: TraitLet, scope: Scope): void {
    if (bound.kind === "state") {
      const global = this.stateArg(bound.value, scope, `let ${name}`);
      if (global !== null) scope.states.set(name, global);
      return;
    }
    const value = this.valueArg(bound.value, bound.kind, scope, `let ${name}`);
    scope.values.set(name, value === DROP ? ABSENT : { kind: bound.kind, value });
  }

  private bindParam(
    name: string,
    param: TraitParam,
    given: unknown,
    caller: Scope,
    scope: Scope,
    n: number,
  ): void {
    if (param.kind === "state") {
      const global =
        given !== undefined
          ? this.stateArg(given, caller, name)
          : typeof param.default === "string"
            ? (scope.states.get(param.default) ?? null)
            : null;
      if (global === null) {
        if (given === undefined && !param.optional) {
          this.issue(scope.label, `needs a state for ${name}`);
        }
        if (given === undefined) scope.values.set(name, ABSENT);
        return;
      }
      scope.states.set(name, global);
      if (param.band) this.raise(global, param.band);
      return;
    }
    if (param.kind === "slot") {
      const global =
        typeof given === "string"
          ? caller.slots === null
            ? given
            : (caller.slots.get(given) ?? given)
          : `${name}_${n}`;
      scope.slots!.set(name, global);
      return;
    }
    const value = given === undefined ? DROP : this.valueArg(given, param.kind, caller, name);
    if (value !== DROP) {
      scope.values.set(name, { kind: param.kind, value });
      return;
    }
    if (Object.hasOwn(param, "default")) {
      const fallback = this.valueArg(param.default, param.kind, scope, name);
      scope.values.set(name, fallback === DROP ? ABSENT : { kind: param.kind, value: fallback });
      return;
    }
    if (!param.optional) this.issue(scope.label, `needs a value for ${name}`);
    scope.values.set(name, ABSENT);
  }

  private stateArg(raw: unknown, scope: Scope, at: string): string | null {
    if (isCall(raw)) return this.instantiate(raw, scope, at);
    const global = typeof raw === "string" ? scope.states.get(raw) : undefined;
    if (global === undefined) {
      this.issue(within(scope.label, at), `${JSON.stringify(raw)} is not a state here`);
      return null;
    }
    return global;
  }

  private valueArg(raw: unknown, kind: ParamKind, scope: Scope, at: string): unknown {
    const resolve = new Resolver(scope, this);
    if (isArgRef(raw)) return resolve.arg(raw);
    switch (kind) {
      case "condition":
        return mapCondition(raw, resolve, at);
      case "actions":
        return mapActions(raw, resolve, at);
      case "selector":
        return mapSelector(raw, resolve, at);
      case "text":
        return typeof raw === "string" ? resolve.text(raw) : raw;
      default:
        return raw;
    }
  }

  private claimPath(path: string): string {
    let claimed = path;
    for (let n = 2; this.prefixes.has(claimed); n++) claimed = `${path}#${n}`;
    this.prefixes.add(claimed);
    return claimed;
  }
}

/**
 * `table` is what the calls expanded to even when something is wrong with it,
 * for the editor to show; `brain` is that table only when nothing is, and is
 * what a world runs.
 */
export type Expansion = { brain: BrainDef | null; table: BrainDef; issues: TraitIssue[] };

export function expandBrain(
  authored: AuthoredBrain,
  catalogue: TraitCatalogue,
  label = "brain",
): Expansion {
  const build = new Build(catalogue, authored.initial);
  const names = Object.keys(authored.states);
  const scope: Scope = {
    label,
    path: "",
    values: new Map(),
    states: new Map(names.map((name) => [name, name])),
    slots: null,
  };
  if (!scope.states.has(REST_STATE)) scope.states.set(REST_STATE, authored.initial);

  for (const [name, def] of Object.entries(authored.states)) build.addState(name, def, false);
  for (const [name, bound] of Object.entries(authored.let ?? {})) build.bindLet(name, bound, scope);
  const resolve = new Resolver(scope, build);
  for (const [name, def] of Object.entries(authored.states)) {
    build.resolveOwn(name, mapStateDef(def, resolve, `state ${name}`));
  }
  (authored.traits ?? []).forEach((call, i) => build.instantiate(call, scope, `call ${i + 1}`));
  (authored.triggers ?? []).forEach((raw, i) =>
    build.addTrigger(mapTrigger(raw, resolve, `trigger ${i + 1}`)),
  );
  authored.transitions.forEach((raw, i) => {
    const row = mapTransition(raw, resolve, `transition ${i + 1}`, true);
    if (row !== DROP) build.own.push(row);
  });

  const table = pruned(assemble(build, authored), build);
  const issues = [...build.issues];
  for (const problem of brainShapeProblems(table)) {
    issues.push({ severity: "error", message: `${label}: ${problem}` });
  }
  if (issues.length === 0) {
    for (const issue of validateBrain(table)) {
      issues.push({ severity: issue.severity, message: `${label}: ${issue.message}` });
    }
  }
  const fatal = issues.some((issue) => issue.severity === "error");
  return { brain: fatal ? null : table, table, issues };
}

function assemble(build: Build, authored: AuthoredBrain): BrainDef {
  const names = [...build.states.keys()];
  const bandOf = (state: string) => build.bands.get(state) ?? "idle";
  const bandFor = (trigger: Trigger) =>
    trigger.band !== undefined && BANDS.includes(trigger.band) ? trigger.band : bandOf(trigger.to);
  const ranked = build.triggers
    .map((trigger, order) => ({ trigger, band: bandFor(trigger), order }))
    .sort((a, b) => rank(b.band) - rank(a.band) || a.order - b.order);

  const rows: BrainTransitionDef[] = [];
  for (const { trigger, band } of ranked) {
    const from = names.filter((name) =>
      name === trigger.to ? trigger.retarget : rank(bandOf(name)) < rank(band),
    );
    if (from.length > 0) rows.push(rowFrom(from, trigger));
  }
  rows.push(...build.own, ...build.transitions);

  const states: Record<string, BrainStateDef> = {};
  for (const [name, { def }] of build.states) states[name] = def;
  return { initial: authored.initial, states, transitions: distinct(rows) };
}

function rowFrom(from: string[], trigger: Trigger): BrainTransitionDef {
  return {
    from: from.length === 1 ? from[0]! : from,
    if: trigger.if,
    ...(trigger.bind ? { bind: trigger.bind } : {}),
    to: trigger.to,
  };
}

function distinct(rows: BrainTransitionDef[]): BrainTransitionDef[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * A state a trait brought that no row can reach is dropped with the rows
 * leaving it: it is an optional part of the trait the call did not ask for,
 * like a follower's loitering with no distance to loiter at.
 */
function pruned(brain: BrainDef, build: Build): BrainDef {
  const reached = new Set([brain.initial]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of brain.transitions) {
      if (reached.has(row.to)) continue;
      const leaves = row.from === ANY_STATE || fromStates(row.from).some((s) => reached.has(s));
      if (!leaves) continue;
      reached.add(row.to);
      grew = true;
    }
  }
  const dropped = (name: string) => !reached.has(name) && build.states.get(name)?.local === true;
  if (!Object.keys(brain.states).some(dropped)) return brain;

  const states = Object.fromEntries(
    Object.entries(brain.states).filter(([name]) => !dropped(name)),
  );
  const transitions: BrainTransitionDef[] = [];
  for (const row of brain.transitions) {
    if (dropped(row.to)) continue;
    if (typeof row.from === "string") {
      if (!dropped(row.from)) transitions.push(row);
      continue;
    }
    const kept = row.from.filter((name) => !dropped(name));
    if (kept.length > 0) transitions.push({ ...row, from: kept.length === 1 ? kept[0]! : kept });
  }
  return { ...brain, states, transitions };
}

export function hasBrain(def: TileDef): boolean {
  const brain = def.interactions?.brain;
  if (!needsExpansion(brain)) return resolveBrain(def) !== null;
  return isRecord(brain?.states) && Object.hasOwn(brain.states, brain.initial);
}

export function withTraits(tiles: readonly TileDef[], catalogue: TraitCatalogue): TileDef[] {
  return tiles.map((def) => {
    const brain = def.interactions?.brain;
    if (!needsExpansion(brain)) return def;
    const expanded = expandBrain(brain as AuthoredBrain, catalogue, def.id).brain;
    if (!expanded) return def;
    return { ...def, interactions: { ...def.interactions, brain: expanded } };
  });
}

export function brainExpansionIssues(
  tiles: readonly TileDef[],
  catalogue: TraitCatalogue,
): TraitIssue[] {
  return tiles.flatMap((def) => {
    const brain = def.interactions?.brain;
    if (!needsExpansion(brain)) return [];
    return expandBrain(brain as AuthoredBrain, catalogue, def.id).issues.filter(
      (issue) => issue.severity === "error",
    );
  });
}

export function usesTrait(
  brain: AuthoredBrain | undefined,
  id: string,
  catalogue: TraitCatalogue,
): boolean {
  if (!brain) return false;
  const seen = new Set<string>();
  const visit = (calls: readonly unknown[]): boolean =>
    calls.some((call) => {
      if (!isCall(call)) return false;
      if (call.trait === id) return true;
      const nested = Object.values(call.with ?? {}).filter(isCall);
      if (visit(nested)) return true;
      if (seen.has(call.trait)) return false;
      seen.add(call.trait);
      const def = entryOf(catalogue, call.trait);
      return def ? visit(callsInside(def)) : false;
    });
  return visit([...(brain.traits ?? []), ...letCalls(brain.let)]);
}

function callsInside(def: TraitDef): unknown[] {
  const inArgs = def.traits.flatMap((call) => Object.values(call.with ?? {}).filter(isCall));
  return [...def.traits, ...inArgs, ...letCalls(def.let)];
}

function letCalls(lets: Record<string, TraitLet> | undefined): unknown[] {
  return Object.values(lets ?? {})
    .map((bound) => bound.value)
    .filter(isCall);
}

function traitScope(def: TraitDef): CheckScope {
  const values = new Map<string, ParamKind>();
  const states = new Set<string>([REST_STATE, ...Object.keys(def.states)]);
  const slots = new Set<string>(Object.keys(def.slots));
  const holds = new Map<string, SlotHolds>(Object.entries(def.slots));
  for (const [name, param] of Object.entries(def.params)) {
    if (param.kind === "state") states.add(name);
    else if (param.kind === "slot") {
      slots.add(name);
      if (param.holds) holds.set(name, param.holds);
    } else values.set(name, param.kind);
  }
  for (const [name, bound] of Object.entries(def.let)) {
    if (bound.kind === "state") states.add(name);
    else values.set(name, bound.kind);
  }
  return { values, states, slots, holds };
}

function brainScope(brain: AuthoredBrain): CheckScope {
  const values = new Map<string, ParamKind>();
  const states = new Set<string>([REST_STATE, ...Object.keys(brain.states)]);
  for (const [name, bound] of Object.entries(brain.let ?? {})) {
    if (bound.kind === "state") states.add(name);
    else values.set(name, bound.kind);
  }
  return { values, states, slots: null, holds: new Map() };
}

function checkValue(raw: unknown, kind: ParamKind, visit: Checker, at: string) {
  if (isArgRef(raw)) {
    if (kind === "state" || kind === "slot") {
      visit.problem(at, `name ${KIND_LABELS[kind]} directly, not through an argument`);
    } else {
      visit.arg(raw, kind, at);
    }
    return;
  }
  switch (kind) {
    case "condition":
      mapCondition(raw, visit, at);
      return;
    case "actions":
      if (!Array.isArray(raw)) visit.problem(at, `wants ${KIND_LABELS.actions}`);
      else mapActions(raw, visit, at);
      return;
    case "selector":
      if (!isRecord(raw)) visit.problem(at, `wants ${KIND_LABELS.selector}`);
      else mapSelector(raw, visit, at);
      return;
    case "state":
      if (!isCall(raw)) visit.state(raw, at);
      return;
    case "slot":
      visit.slot(raw, at);
      return;
    default:
      visit.literal(raw, kind, at);
  }
}

function checkCall(call: TraitCall, catalogue: TraitCatalogue, visit: Checker, at: string): void {
  const callee = entryOf(catalogue, call.trait);
  if (!callee) {
    visit.problem(at, `there is no trait called ${JSON.stringify(call.trait)}`);
    return;
  }
  const args = call.with ?? {};
  for (const name of Object.keys(args)) {
    if (!Object.hasOwn(callee.params, name)) {
      visit.problem(at, `${callee.id} has no parameter called ${name}`);
    }
  }
  for (const [name, param] of Object.entries(callee.params)) {
    const where = within(at, `${callee.id} ${name}`);
    const given = args[name];
    if (given === undefined) {
      const required = !param.optional && !Object.hasOwn(param, "default") && param.kind !== "slot";
      if (required) visit.problem(where, `needs ${KIND_LABELS[param.kind]}`);
      continue;
    }
    if (param.kind === "state" && isCall(given)) {
      const routine = entryOf(catalogue, given.trait);
      if (routine && routine.returns === undefined) {
        visit.problem(where, `${routine.id} returns no state to go to`);
      }
      checkCall(given, catalogue, visit, where);
      continue;
    }
    checkValue(given, param.kind, visit, where);
  }
}

function checkLets(lets: Record<string, TraitLet>, catalogue: TraitCatalogue, visit: Checker) {
  for (const [name, bound] of Object.entries(lets)) {
    if (bound.kind === "state" && isCall(bound.value)) {
      checkCall(bound.value, catalogue, visit, `let ${name}`);
    } else {
      checkValue(bound.value, bound.kind, visit, `let ${name}`);
    }
  }
}

export function checkTrait(
  def: TraitDef,
  catalogue: TraitCatalogue,
  context: TraitContext = {},
): TraitIssue[] {
  const issues: TraitIssue[] = [];
  const visit = new Checker(traitScope(def), issues, def.id, context);

  const taken = new Map<string, string>();
  const claim = (name: string, what: string) => {
    const held = taken.get(name);
    if (held) visit.problem(what, `${name} is already ${held}`);
    else taken.set(name, what);
  };
  for (const name of Object.keys(def.params)) claim(name, `parameter ${name}`);
  for (const name of Object.keys(def.let)) claim(name, `let ${name}`);
  for (const name of Object.keys(def.states)) {
    if (name === REST_STATE) visit.problem(`state ${name}`, `${REST_STATE} is the brain's own`);
    claim(name, `state ${name}`);
  }
  for (const name of Object.keys(def.slots)) claim(name, `slot ${name}`);

  for (const [name, param] of Object.entries(def.params)) {
    const at = `parameter ${name}`;
    if (param.band && param.kind !== "state") visit.problem(at, "only a state holds at a band");
    if (param.holds && param.kind !== "slot")
      visit.problem(at, "only a slot holds a body or thing");
    if (!Object.hasOwn(param, "default")) continue;
    if (param.kind === "slot") {
      visit.problem(at, "a slot has no default; leave it out to keep one private");
    } else {
      checkValue(param.default, param.kind, visit, at);
    }
  }
  checkLets(def.let, catalogue, visit);
  for (const [name, raw] of Object.entries(def.states)) mapStateDef(raw, visit, `state ${name}`);
  def.triggers.forEach((raw, i) => mapTrigger(raw, visit, `trigger ${i + 1}`));
  def.transitions.forEach((raw, i) => mapTransition(raw, visit, `transition ${i + 1}`, false));
  def.traits.forEach((call, i) => checkCall(call, catalogue, visit, `call ${i + 1}`));
  if (def.returns !== undefined) visit.state(def.returns, "returns");

  const loop = cycleThrough(def.id, catalogue);
  if (loop) visit.problem("", `calls itself through ${loop.join(" › ")}`);

  if (issues.length > 0) return issues;
  return sampled(def, catalogue).issues.filter((issue) => issue.severity === "error");
}

function cycleThrough(id: string, catalogue: TraitCatalogue): string[] | null {
  const walk = (at: string, trail: string[]): string[] | null => {
    const def = entryOf(catalogue, at);
    if (!def) return null;
    for (const call of callsInside(def)) {
      if (!isCall(call)) continue;
      if (call.trait === id) return [...trail, id];
      if (trail.includes(call.trait)) continue;
      const found = walk(call.trait, [...trail, call.trait]);
      if (found) return found;
    }
    return null;
  };
  return walk(id, [id]);
}

const SAMPLES: Record<ParamKind, unknown> = {
  cells: 1,
  ms: 1000,
  percent: 50,
  hour: 12,
  level: 0,
  steps: 1,
  boolean: false,
  text: "sample",
  bodies: ["sample"],
  things: ["sample"],
  item: "sample",
  consumable: "sample",
  status: "sample",
  spell: 1,
  selector: { type: "home" },
  condition: { cond: "stuck" },
  actions: [{ action: "hold" }],
  band: "idle",
  state: "",
  slot: "",
};

/**
 * Expands the trait once inside a throwaway brain, with made-up values for
 * whatever it has no default for, so a body that only goes wrong once its
 * rows are written out — a malformed action, a group left empty — is caught
 * against the trait rather than against every creature that calls it. A
 * trait that returns a state is entered through that state, or everything
 * it brings would be pruned as unreachable before anything looked at it.
 */
function sampled(def: TraitDef, catalogue: TraitCatalogue): Expansion {
  const host = "host";
  const states: Record<string, AuthoredStateDef> = { [host]: { do: [{ action: "hold" }] } };
  const args: Record<string, unknown> = {};
  for (const [name, param] of Object.entries(def.params)) {
    if (param.optional || Object.hasOwn(param, "default") || param.kind === "slot") continue;
    if (param.kind === "state") {
      states[`${host}_${name}`] = { do: [{ action: "hold" }] };
      args[name] = `${host}_${name}`;
    } else {
      args[name] = SAMPLES[param.kind];
    }
  }
  const call: TraitCall = { trait: def.id, with: args };
  const brain: AuthoredBrain =
    def.returns === undefined
      ? { initial: host, states, transitions: [], traits: [call] }
      : {
          initial: host,
          states,
          transitions: [],
          let: { sample: { kind: "state", value: call } },
          triggers: [{ if: { cond: "stuck" }, to: "sample" }],
        };
  return expandBrain(brain, catalogue, def.id);
}

export function checkBrain(
  brain: AuthoredBrain,
  catalogue: TraitCatalogue,
  context: TraitContext = {},
  label = "brain",
): TraitIssue[] {
  if (!needsExpansion(brain)) return validateBrain(brain as BrainDef);
  const issues: TraitIssue[] = [];
  const visit = new Checker(brainScope(brain), issues, label, context);
  checkLets(brain.let ?? {}, catalogue, visit);
  for (const [name, state] of Object.entries(brain.states)) {
    mapStateDef(state, visit, `state ${name}`);
  }
  brain.transitions.forEach((raw, i) => mapTransition(raw, visit, `transition ${i + 1}`, true));
  (brain.triggers ?? []).forEach((raw, i) => mapTrigger(raw, visit, `trigger ${i + 1}`));
  (brain.traits ?? []).forEach((call, i) => checkCall(call, catalogue, visit, `call ${i + 1}`));
  if (issues.length > 0) return issues;
  return expandBrain(brain, catalogue, label).issues;
}
