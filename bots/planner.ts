import type { Goal } from "./goals";

export type AskReason = "start" | "done" | "failed" | "timer" | "died";

export type Observation = {
  readonly reason: AskReason;
  readonly goal: Goal | null;
  readonly outcome: string | null;
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
