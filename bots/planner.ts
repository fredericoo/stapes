import type { Coord } from "../app/lib/types";
import type { Goal } from "./goals";
import { nextNeed, progressOf, type Objective } from "./objective";
import type { Recalled } from "./recollection";

export type AskReason = "start" | "done" | "failed" | "timer" | "died" | "heard";

export type Someone = Coord & { readonly name: string };

/** What the bot could usefully do about its gear right now, as `Economy` reckons it. */
export type Situation = {
  /** It can pay for food it lacks or an upgrade. */
  readonly canBuy: boolean;
  /** It carries something it does not need that an NPC pays for. */
  readonly canSell: boolean;
  /** It knows of a resource whose yield it wants. */
  readonly canGather: boolean;
  /**
   * It fell below its `huntHpShare` and is not yet back to its
   * `restedHpShare`, so it starts no fight.
   */
  readonly recovering: boolean;
  /**
   * While it recovers, the safe ground it should recover on, when that is
   * worth the walk from where it stands (`refugeFor`).
   */
  readonly refugeAt: Coord | null;
  /** It carries food that heals, which is the only way health comes back. */
  readonly hasFood: boolean;
  /**
   * Where it died and left its bag, until it has been back for it, unless
   * something it would lose to is near the bag or the bag is not worth the
   * walk from where it stands.
   */
  readonly lostKitAt: Coord | null;
  /** It carries stones worth forging and knows where a forge is. */
  readonly canForge: boolean;
  /** A depot it knows of holds what completes the price of an upgrade. */
  readonly canWithdraw: boolean;
  /** It carries money and upgrade inputs worth the walk to a depot it knows of. */
  readonly canStash: boolean;
  /** Upgrades it knows how to work towards, best first (`objectivesFor`). */
  readonly objectives: readonly Objective[];
};

export const NOTHING_TO_DO: Situation = {
  canBuy: false,
  canSell: false,
  canGather: false,
  recovering: false,
  refugeAt: null,
  hasFood: false,
  lostKitAt: null,
  canForge: false,
  canWithdraw: false,
  canStash: false,
  objectives: [],
};

export type Observation = {
  readonly reason: AskReason;
  readonly goal: Goal | null;
  readonly outcome: string | null;
  readonly nowMs: number;
  readonly situation: Situation;
  readonly self: Someone & { readonly hp: number | null; readonly maxHp: number | null };
  /** Other players the bot can see, bots among them. */
  readonly players: readonly Someone[];
  readonly peaceful: boolean;
  readonly recent: readonly Recalled[];
  /** What the bot is working towards, with its progress as of this ask. */
  readonly objective: Objective | null;
};

/** Each field left out leaves that part of the bot as it was. */
export type Decision = {
  readonly goal?: Goal;
  readonly say?: string;
  /** A peaceful bot hunts nothing, and fights only what attacks it. */
  readonly peaceful?: boolean;
  /** What the bot works towards from now on; null is nothing. */
  readonly objective?: Objective | null;
};

export interface Planner {
  decide(observation: Observation): Promise<Decision | null>;
}

/**
 * Goals in a fixed order, one after the other. A failed goal is asked for
 * again, and the last one is kept once the list runs out. It never speaks.
 */
export class ScriptedPlanner implements Planner {
  private at = 0;

  constructor(private readonly goals: readonly Goal[]) {}

  async decide(observation: Observation): Promise<Decision | null> {
    if (observation.reason === "done") this.at++;
    if (observation.reason === "timer" || observation.reason === "heard") return null;
    const goal = this.goals[Math.min(this.at, this.goals.length - 1)];
    return goal ? { goal } : null;
  }
}

/**
 * How long a bot hunts before it may break off to gather. Hunting is what
 * grows mastery and pays in skins; gathering is what pays in money, and a bot
 * that only did one never bought anything from the other's shops.
 */
export const HUNT_SPELL_MS = 4 * 60_000;

/** Pulls a gathering trip takes before the bot goes back to hunting. */
export const GATHER_PULLS = 8;

/**
 * A goal that failed is not chosen again for this long, so a bot that cannot
 * find a seller does not spend its life looking for one.
 */
export const FAILED_GOAL_MS = 3 * 60_000;

/**
 * A recovering bot rests this long at a time and is then asked again, so it
 * gets up soon after it has healed.
 */
export const REST_SPELL_SECONDS = 30;

/**
 * An objective whose progress has not grown for this long is dropped, and
 * not taken up again for as long.
 */
export const OBJECTIVE_STALL_MS = 10 * 60_000;

/**
 * Another objective replaces the one held only when its `worth` is this many
 * times as much, so a bot does not drop its progress over a small difference.
 */
export const OBJECTIVE_SWITCH_RATIO = 1.5;

/**
 * The opening goals in order, then a loop that plays the game: go back for
 * the bag it died with, take out of a depot what completes a purchase, buy
 * what it can afford, sell what it does not need, stash what it is saving,
 * forge the stones it carries, and otherwise work towards its objective:
 * hunt what drops the input it lacks, or gather what yields it. With no
 * objective it hunts, breaking off now and then to gather the money that
 * hunting does not pay. A recovering bot first goes to safe ground when it
 * knows some worth the walk, then rests while it has food and gathers when
 * it has none, since bushes give food and health comes back only from food.
 */
export class ProgressPlanner implements Planner {
  private at = 0;
  private huntingSinceMs: number | null = null;
  private failedAt = new Map<Goal["goal"], number>();
  private given: Goal | null = null;
  private held: { key: string; best: number; sinceMs: number } | null = null;
  private droppedAt = new Map<string, number>();

  constructor(private readonly opening: readonly Goal[]) {}

  async decide(observation: Observation): Promise<Decision | null> {
    const objective = this.aim(observation);
    const goal = this.choose(observation, objective);
    if (goal) this.given = goal;
    return goal ? { goal, objective } : { objective };
  }

  /**
   * The objective to work towards: the one held, until it is finished or
   * unreachable, its progress stalls for `OBJECTIVE_STALL_MS`, or another is
   * worth `OBJECTIVE_SWITCH_RATIO` times as much; else the best on offer.
   * Time spent on the opening or on a walk back to the bag is not a stall,
   * since the objective chooses nothing then.
   */
  private aim({ situation, nowMs }: Observation): Objective | null {
    const recent = (key: string | null) =>
      key !== null && nowMs - (this.droppedAt.get(key) ?? -Infinity) <= OBJECTIVE_STALL_MS;
    const open = situation.objectives.filter((o) => !recent(o.key) && !recent(needKey(o)));
    const held = this.held;
    const current = held && open.find((o) => o.key === held.key);
    if (!held || !current) return this.adopt(open[0] ?? null, nowMs);
    const progress = progressOf(current);
    const busy = this.at < this.opening.length || situation.lostKitAt !== null;
    if (progress > held.best || busy) {
      held.best = progress;
      held.sinceMs = nowMs;
    } else if (nowMs - held.sinceMs > OBJECTIVE_STALL_MS) {
      this.droppedAt.set(held.key, nowMs);
      const stalled = needKey(current);
      if (stalled !== null) this.droppedAt.set(stalled, nowMs);
      return this.adopt(open.find((o) => o !== current && needKey(o) !== stalled) ?? null, nowMs);
    }
    const best = open[0]!;
    if (best.worth > current.worth * OBJECTIVE_SWITCH_RATIO) return this.adopt(best, nowMs);
    return current;
  }

  private adopt(objective: Objective | null, nowMs: number): Objective | null {
    this.held = objective && { key: objective.key, best: progressOf(objective), sinceMs: nowMs };
    return objective;
  }

  /**
   * A finished goal is reported with no goal attached, so which one finished
   * is the one this planner last gave; only finishing an opening goal moves
   * the opening on.
   */
  private choose(observation: Observation, objective: Objective | null): Goal | null {
    const { reason, goal, nowMs } = observation;
    if (reason === "failed" && goal) this.failedAt.set(goal.goal, nowMs);
    if (reason === "heard") return null;
    const finishedOpening = reason === "done" && this.given === this.opening[this.at];
    if (finishedOpening) this.at++;
    const kit = observation.situation.lostKitAt;
    if (kit && goal?.goal !== "go_to" && reason !== "timer") return { goal: "go_to", ...kit };
    if (this.at < this.opening.length) {
      if (reason === "timer") return null;
      return this.opening[this.at]!;
    }
    if (reason === "timer" && goal && goal.goal !== "hunt") return null;
    return this.next(observation, objective);
  }

  private next({ goal, nowMs, situation }: Observation, objective: Objective | null): Goal {
    const fresh = (kind: Goal["goal"]) =>
      nowMs - (this.failedAt.get(kind) ?? -Infinity) > FAILED_GOAL_MS;
    if (situation.canWithdraw && fresh("bank")) return this.leaveHunt({ goal: "bank" });
    if (situation.canBuy && fresh("shop")) return this.leaveHunt({ goal: "shop" });
    if (situation.canSell && fresh("sell")) return this.leaveHunt({ goal: "sell" });
    if (situation.canStash && fresh("bank")) return this.leaveHunt({ goal: "bank" });
    if (situation.recovering && situation.refugeAt && fresh("refuge")) {
      return this.leaveHunt({ goal: "refuge", ...situation.refugeAt });
    }
    if (situation.recovering && situation.hasFood) {
      return this.leaveHunt({ goal: "rest", seconds: REST_SPELL_SECONDS });
    }
    if (situation.canForge && fresh("forge")) return this.leaveHunt({ goal: "forge" });
    const hunted = this.huntingSinceMs === null ? 0 : nowMs - this.huntingSinceMs;
    const gather = situation.canGather && fresh("gather");
    const via = objective ? nextNeed(objective)?.via : undefined;
    const spell = via === undefined && hunted >= HUNT_SPELL_MS;
    if (gather && (situation.recovering || via === "gather" || spell)) {
      if (goal?.goal === "gather") return goal;
      return this.leaveHunt({ goal: "gather", pulls: GATHER_PULLS });
    }
    if (goal?.goal !== "hunt" || this.huntingSinceMs === null) this.huntingSinceMs = nowMs;
    return { goal: "hunt" };
  }

  private leaveHunt(goal: Goal): Goal {
    this.huntingSinceMs = null;
    return goal;
  }
}

/**
 * What an objective works on next and how, so a stall on one input by one
 * source sets aside every objective that would go on to the same work.
 */
function needKey(objective: Objective): string | null {
  const need = nextNeed(objective);
  return need && `need:${need.tileId}:${need.via}`;
}
