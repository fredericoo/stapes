import type { Coord } from "../app/lib/types";
import type { Goal } from "./goals";
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
  /** It carries food that heals, which is the only way health comes back. */
  readonly hasFood: boolean;
  /** Where it died and left its bag, until it has been back for it. */
  readonly lostKitAt: Coord | null;
};

export const NOTHING_TO_DO: Situation = {
  canBuy: false,
  canSell: false,
  canGather: false,
  recovering: false,
  hasFood: false,
  lostKitAt: null,
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
};

/** Each field left out leaves that part of the bot as it was. */
export type Decision = {
  readonly goal?: Goal;
  readonly say?: string;
  /** A peaceful bot hunts nothing, and fights only what attacks it. */
  readonly peaceful?: boolean;
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
 * The opening goals in order, then a loop that plays the game: go back for
 * the bag it died with, buy what it can afford, sell what it does not need,
 * and otherwise hunt, breaking off now and then to gather the money that
 * hunting does not pay. A recovering bot rests while it has food and gathers
 * when it has none, since bushes give food and health comes back only from
 * food.
 */
export class ProgressPlanner implements Planner {
  private at = 0;
  private huntingSinceMs: number | null = null;
  private failedAt = new Map<Goal["goal"], number>();
  private given: Goal | null = null;

  constructor(private readonly opening: readonly Goal[]) {}

  async decide(observation: Observation): Promise<Decision | null> {
    const goal = this.choose(observation);
    if (goal) this.given = goal;
    return goal ? { goal } : null;
  }

  /**
   * A finished goal is reported with no goal attached, so which one finished
   * is the one this planner last gave; only finishing an opening goal moves
   * the opening on.
   */
  private choose(observation: Observation): Goal | null {
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
    return this.next(observation);
  }

  private next({ goal, nowMs, situation }: Observation): Goal {
    const fresh = (kind: Goal["goal"]) =>
      nowMs - (this.failedAt.get(kind) ?? -Infinity) > FAILED_GOAL_MS;
    if (situation.canBuy && fresh("shop")) return this.leaveHunt({ goal: "shop" });
    if (situation.canSell && fresh("sell")) return this.leaveHunt({ goal: "sell" });
    if (situation.recovering && situation.hasFood) {
      return this.leaveHunt({ goal: "rest", seconds: REST_SPELL_SECONDS });
    }
    const hunted = this.huntingSinceMs === null ? 0 : nowMs - this.huntingSinceMs;
    const gather = situation.canGather && fresh("gather");
    if (gather && (situation.recovering || hunted >= HUNT_SPELL_MS)) {
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
