import type { Goal } from "./goals";

export type AskReason = "start" | "done" | "failed" | "timer" | "died";

/** What the bot could usefully do about its gear right now, as `Economy` reckons it. */
export type Situation = {
  /** It can pay for food it lacks or an upgrade. */
  readonly canBuy: boolean;
  /** It carries something it does not need that an NPC pays for. */
  readonly canSell: boolean;
  /** It knows of a resource whose yield it wants. */
  readonly canGather: boolean;
};

export const NOTHING_TO_DO: Situation = { canBuy: false, canSell: false, canGather: false };

export type Observation = {
  readonly reason: AskReason;
  readonly goal: Goal | null;
  readonly outcome: string | null;
  readonly nowMs: number;
  readonly situation: Situation;
};

export type Decision = { readonly goal: Goal };

export interface Planner {
  decide(observation: Observation): Promise<Decision | null>;
}

/**
 * Goals in a fixed order, one after the other. A failed goal is asked for
 * again, and the last one is kept once the list runs out.
 */
export class ScriptedPlanner implements Planner {
  private at = 0;

  constructor(private readonly goals: readonly Goal[]) {}

  async decide(observation: Observation): Promise<Decision | null> {
    if (observation.reason === "done") this.at++;
    if (observation.reason === "timer") return null;
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
 * The opening goals in order, then a loop that plays the game: buy what it
 * can afford, sell what it does not need, and otherwise hunt, breaking off
 * now and then to gather the money that hunting does not pay.
 */
export class ProgressPlanner implements Planner {
  private at = 0;
  private huntingSinceMs: number | null = null;
  private failedAt = new Map<Goal["goal"], number>();

  constructor(private readonly opening: readonly Goal[]) {}

  async decide(observation: Observation): Promise<Decision | null> {
    const { reason, goal, nowMs } = observation;
    if (reason === "failed" && goal) this.failedAt.set(goal.goal, nowMs);
    if (this.at < this.opening.length) {
      if (reason === "done") this.at++;
      if (this.at < this.opening.length) {
        return reason === "timer" ? null : { goal: this.opening[this.at]! };
      }
    }
    if (reason === "timer" && goal && goal.goal !== "hunt") return null;
    return { goal: this.next(observation) };
  }

  private next({ goal, nowMs, situation }: Observation): Goal {
    const fresh = (kind: Goal["goal"]) =>
      nowMs - (this.failedAt.get(kind) ?? -Infinity) > FAILED_GOAL_MS;
    if (situation.canBuy && fresh("shop")) return this.leaveHunt({ goal: "shop" });
    if (situation.canSell && fresh("sell")) return this.leaveHunt({ goal: "sell" });
    const hunted = this.huntingSinceMs === null ? 0 : nowMs - this.huntingSinceMs;
    if (situation.canGather && fresh("gather") && hunted >= HUNT_SPELL_MS) {
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
