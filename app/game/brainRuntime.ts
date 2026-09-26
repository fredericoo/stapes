import {
  ANY_STATE,
  MAX_HEALTH_PERCENT,
  type BrainCondition,
  type BrainActionDef,
  type BrainConditionDef,
  type BrainDef,
  type BrainTransitionDef,
  type Selector,
  type SpeakerFilter,
} from "../lib/brain";
import { withinHours, type MinutesOfDay } from "../lib/clock";
import { evaluateCondition } from "../lib/conditions";
import type { BattlerDef } from "../lib/battler";
import { DIRECTIONS, type Coord, type Direction } from "../lib/types";
import type { Rng } from "./rng";

export type SightLevels = BattlerDef["sight"];

export type Bound =
  | { readonly kind: "body"; readonly id: string }
  | { readonly kind: "thing"; readonly at: Coord; readonly tileId: string };

export function boundBody(bound: Bound | null): string | null {
  return bound?.kind === "body" ? bound.id : null;
}

export type BrainMemory = {
  state: string;
  msInState: number;
  blackboard: Record<string, Bound>;
  stuck: boolean;
  scratch: Record<number, number>;
  started: boolean;
  heardFrom: string | null;
  hurtBy: string | null;
};

export type ActionStatus = "success" | "failure" | "running";

export type WalkGoal =
  | { readonly of: "body"; readonly id: string }
  | { readonly of: "cell"; readonly at: Coord };

export type WalkOrderState = "walking" | "arrived" | "blocked";

export type FoundThing = { readonly at: Coord; readonly tileId: string };

export type StandOff = "too_close" | "in_position" | "too_far";

export type BrainContext = {
  busy: boolean;
  rng: Rng;
  self: Coord;
  home: Coord | null;
  nearestOnTile(tileIds: readonly string[]): string | null;
  nearestThing(tileIds: readonly string[]): FoundThing | null;
  positionOf(actorId: string): Coord | null;
  thingStillThere(at: Coord, tileId: string): boolean;
  talking(): boolean;
  wouldDrop(direction: Direction): boolean;
  wouldStepIntoHazard(direction: Direction): boolean;
  step(direction: Direction): boolean;
  walkTo(goal: WalkGoal, allowDrops: boolean | undefined): WalkOrderState;
  fleeFrom(threat: Coord, allowDrops: boolean | undefined): WalkOrderState;
  say(text: string): void;
  noise(text: string): void;
  canSee(at: Coord): boolean;
  sight: SightLevels;
  heard(): readonly Utterance[];
  heardNoise(): readonly Sound[];
  hurtBy(): readonly string[];
  attack(actorId: string): boolean;
  cast(spell: number, targetId?: string | null): "cast" | "casting" | "no";
  extract(at: Coord, tileId: string): boolean;
  consume(tileId: string | undefined): boolean;
  consumeOn(at: Coord, tileId: string): boolean;
  carrying(tileId: string | undefined): boolean;
  hasStatus(id: string, atLeastMs: number | undefined): boolean;
  standOff(actorId: string): StandOff | null;
  health(): number | null;
  minutesOfDay: MinutesOfDay;
  nameOf(actorId: string): string | null;
};

export type Utterance = {
  speakerId: string;
  text: string;
};

export type Sound = {
  sourceId: string;
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

const SLOT_PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

export const NOBODY = "someone";

function fillSlots(text: string, memory: BrainMemory, ctx: BrainContext): string {
  if (!text.includes("{")) return text;
  return text.replace(SLOT_PLACEHOLDER, (_whole, name: string) => {
    const id = boundBody(memory.blackboard[name] ?? null);
    return (id === null ? null : ctx.nameOf(id)) ?? NOBODY;
  });
}

function runOnEnter(brain: BrainDef, memory: BrainMemory, ctx: BrainContext) {
  const onEnter = brain.states[memory.state]?.onEnter;
  if (!onEnter) return;
  for (const effect of onEnter) {
    const text = fillSlots(effect.text, memory, ctx);
    if (effect.effect === "say") ctx.say(text);
    else ctx.noise(text);
  }
}

/**
 * The drop check runs first because it is one column scan, cheaper than the
 * hazard check's step check plus stack scan.
 */
function footing(direction: Direction, allowDrops: boolean | undefined, ctx: BrainContext) {
  if (!allowDrops && ctx.wouldDrop(direction)) return false;
  return !ctx.wouldStepIntoHazard(direction);
}

function identify(selector: Selector, memory: BrainMemory, ctx: BrainContext): Bound | null {
  switch (selector.type) {
    case "slot":
      return memory.blackboard[selector.data.name] ?? null;
    case "speaker":
      return asBody(memory.heardFrom);
    case "attacker":
      return asBody(memory.hurtBy);
    case "nearest":
      return asBody(ctx.nearestOnTile(selector.data.tileIds));
    case "thing": {
      const found = ctx.nearestThing(selector.data.tileIds);
      return found === null ? null : { kind: "thing", at: found.at, tileId: found.tileId };
    }
    case "home":
      return null;
  }
}

function asBody(id: string | null): Bound | null {
  return id === null ? null : { kind: "body", id };
}

function locate(selector: Selector, memory: BrainMemory, ctx: BrainContext): Coord | null {
  if (selector.type === "home") return ctx.home;
  return whereIs(identify(selector, memory, ctx), ctx);
}

function whereIs(bound: Bound | null, ctx: BrainContext): Coord | null {
  if (!bound) return null;
  if (bound.kind === "body") return ctx.positionOf(bound.id);
  return ctx.thingStillThere(bound.at, bound.tileId) ? bound.at : null;
}

function aim(selector: Selector, memory: BrainMemory, ctx: BrainContext): WalkGoal | null {
  if (selector.type === "home") {
    return ctx.home ? { of: "cell", at: ctx.home } : null;
  }
  const bound = identify(selector, memory, ctx);
  if (!bound) return null;
  if (bound.kind === "body") return { of: "body", id: bound.id };
  return ctx.thingStillThere(bound.at, bound.tileId) ? { of: "cell", at: bound.at } : null;
}

function stepsApart(a: Coord, b: Coord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function within(self: Coord, other: Coord, cells: number, sight: SightLevels): boolean {
  const dz = other.z - self.z;
  if (dz > sight.up || -dz > sight.down) return false;
  return stepsApart(self, other) <= cells;
}

function inSight(at: Coord | null, cells: number, ctx: BrainContext): at is Coord {
  return at !== null && within(ctx.self, at, cells, ctx.sight) && ctx.canSee(at);
}

function heardFrom(
  condition: Extract<BrainConditionDef, { cond: "heard" }>,
  memory: BrainMemory,
  ctx: BrainContext,
): boolean {
  const wanted = condition.text.toLowerCase();
  for (const utterance of ctx.heard()) {
    if (!utterance.text.toLowerCase().includes(wanted)) continue;
    if (!voiceCounts(condition.from, utterance.speakerId, memory, ctx)) continue;
    const at = ctx.positionOf(utterance.speakerId);
    if (at === null) continue;
    if (!within(ctx.self, at, condition.cells, ctx.sight)) continue;
    if (condition.los && !ctx.canSee(at)) continue;
    memory.heardFrom = utterance.speakerId;
    return true;
  }
  return false;
}

function heardNoiseFrom(
  condition: Extract<BrainConditionDef, { cond: "heard_noise" }>,
  memory: BrainMemory,
  ctx: BrainContext,
): boolean {
  const wanted = condition.text?.toLowerCase();
  for (const sound of ctx.heardNoise()) {
    if (wanted !== undefined && !sound.text.toLowerCase().includes(wanted)) {
      continue;
    }
    const at = ctx.positionOf(sound.sourceId);
    if (at === null) continue;
    if (!within(ctx.self, at, condition.cells, ctx.sight)) continue;
    memory.heardFrom = sound.sourceId;
    return true;
  }
  return false;
}

function voiceCounts(
  filter: SpeakerFilter | undefined,
  speakerId: string,
  memory: BrainMemory,
  ctx: BrainContext,
): boolean {
  if (!filter) return true;
  const wanted = boundBody(identify(filter.of, memory, ctx));
  return filter.match === "is" ? wanted === speakerId : wanted !== speakerId;
}

function holds(condition: BrainCondition, memory: BrainMemory, ctx: BrainContext): boolean {
  return evaluateCondition(condition, (leaf, negated) => {
    if (!negated) return leafHolds(leaf, memory, ctx);

    const speaker = memory.heardFrom;
    const attacker = memory.hurtBy;
    const held = leafHolds(leaf, memory, ctx);
    memory.heardFrom = speaker;
    memory.hurtBy = attacker;
    return held;
  });
}

function leafHolds(condition: BrainConditionDef, memory: BrainMemory, ctx: BrainContext): boolean {
  switch (condition.cond) {
    case "after":
      return memory.msInState >= condition.ms;
    case "stuck":
      return memory.stuck;
    case "in_range": {
      const at = locate(condition.of, memory, ctx);
      return at !== null && within(ctx.self, at, condition.cells, ctx.sight);
    }
    case "out_of_range": {
      const at = locate(condition.of, memory, ctx);
      return at === null || !within(ctx.self, at, condition.cells, ctx.sight);
    }
    case "in_los":
      return inSight(locate(condition.of, memory, ctx), condition.cells, ctx);
    case "out_of_los":
      return !inSight(locate(condition.of, memory, ctx), condition.cells, ctx);
    case "heard":
      return heardFrom(condition, memory, ctx);
    case "heard_noise":
      return heardNoiseFrom(condition, memory, ctx);
    case "attacked":
      return struckBy(memory, ctx);
    case "talking":
      return ctx.talking();
    case "carrying":
      return ctx.carrying(condition.tileId);
    case "status":
      return ctx.hasStatus(condition.id, condition.atLeastMs);
    case "health": {
      const share = ctx.health();
      if (share === null) return false;
      return share * MAX_HEALTH_PERCENT <= condition.atMostPercent;
    }
    case "time_of_day":
      return withinHours(ctx.minutesOfDay, condition.fromHour, condition.toHour);
    case "below_level":
      return ctx.self.z < condition.level;
  }
}

function struckBy(memory: BrainMemory, ctx: BrainContext): boolean {
  const [first] = ctx.hurtBy();
  if (first === undefined) return false;
  memory.hurtBy = first;
  return true;
}

function walkAlongRoute(
  goal: WalkGoal,
  allowDrops: boolean | undefined,
  ctx: BrainContext,
): ActionStatus {
  return ctx.walkTo(goal, allowDrops) === "walking" ? "running" : "failure";
}

function fleeAlongRoute(
  target: Coord,
  allowDrops: boolean | undefined,
  ctx: BrainContext,
): ActionStatus {
  return ctx.fleeFrom(target, allowDrops) === "walking" ? "running" : "failure";
}

function stepAnywhere(allowDrops: boolean | undefined, ctx: BrainContext): boolean {
  for (const direction of ctx.rng.shuffle([...DIRECTIONS])) {
    if (!footing(direction, allowDrops, ctx)) continue;
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
      if (ctx.busy) return "running";
      return stepAnywhere(action.allowDrops, ctx) ? "success" : "failure";
    }
    case "wait": {
      const waited = Math.min((memory.scratch[index] ?? 0) + tickMs, action.ms);
      memory.scratch[index] = waited;
      return waited >= action.ms ? "failure" : "running";
    }
    case "walk_n_steps": {
      const taken = memory.scratch[index] ?? 0;
      if (taken >= action.steps) return "failure";
      if (ctx.busy) return "running";
      if (!stepAnywhere(action.allowDrops, ctx)) return "failure";
      memory.scratch[index] = taken + 1;
      return "running";
    }
    case "attack": {
      const id = boundBody(identify(action.of, memory, ctx));
      if (id === null) return "failure";
      return ctx.attack(id) ? "success" : "failure";
    }
    case "cast": {
      const id = action.of ? boundBody(identify(action.of, memory, ctx)) : undefined;
      const verdict = ctx.cast(action.spell, id);
      if (verdict === "casting") return "running";
      return verdict === "cast" ? "success" : "failure";
    }
    case "extract": {
      const bound = identify(action.of, memory, ctx);
      if (bound?.kind !== "thing") return "failure";
      return ctx.extract(bound.at, bound.tileId) ? "running" : "failure";
    }
    case "consume": {
      if (!action.of) return ctx.consume(action.tileId) ? "success" : "failure";
      const bound = identify(action.of, memory, ctx);
      if (bound?.kind !== "thing") return "failure";
      return ctx.consumeOn(bound.at, bound.tileId) ? "success" : "failure";
    }
    case "step_toward": {
      const goal = aim(action.of, memory, ctx);
      if (!goal) return "failure";
      return walkAlongRoute(goal, action.allowDrops, ctx);
    }
    case "attack_range": {
      const id = boundBody(identify(action.of, memory, ctx));
      if (id === null) return "failure";
      if (ctx.busy) return "running";
      const standing = ctx.standOff(id);
      if (standing === null || standing === "in_position") return "failure";
      if (standing === "too_close") {
        const at = ctx.positionOf(id);
        return at ? fleeAlongRoute(at, action.allowDrops, ctx) : "failure";
      }
      return walkAlongRoute({ of: "body", id }, action.allowDrops, ctx);
    }
    case "step_away_from": {
      const at = locate(action.of, memory, ctx);
      if (!at) return "failure";
      return fleeAlongRoute(at, action.allowDrops, ctx);
    }
  }
}

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

function applyBind(transition: BrainTransitionDef, memory: BrainMemory, ctx: BrainContext) {
  if (!transition.bind) return;
  for (const [slot, selector] of Object.entries(transition.bind)) {
    const bound = identify(selector, memory, ctx);
    if (bound === null) {
      delete memory.blackboard[slot];
    } else {
      memory.blackboard[slot] = bound;
    }
  }
}

function discardBelow(memory: BrainMemory, index: number) {
  for (const key of Object.keys(memory.scratch)) {
    if (Number(key) > index) delete memory.scratch[Number(key)];
  }
}

export function stepBrain(
  brain: BrainDef,
  memory: BrainMemory,
  tickMs: number,
  ctx: BrainContext,
): void {
  if (!memory.started) {
    memory.started = true;
    runOnEnter(brain, memory, ctx);
  }

  memory.heardFrom = null;
  memory.hurtBy = null;

  memory.msInState += tickMs;

  const transition = firstMatch(brain, memory, ctx);
  if (transition) {
    applyBind(transition, memory, ctx);
    if (transition.to !== memory.state) {
      memory.state = transition.to;
      memory.msInState = 0;
      memory.stuck = false;
      memory.scratch = {};
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

  memory.stuck = state.do.length > 0;
}
