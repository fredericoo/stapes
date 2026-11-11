import { expect, it } from "bun:test";
import type { Goal } from "./goals";
import {
  GATHER_PULLS,
  NOTHING_TO_DO,
  ProgressPlanner,
  REST_SPELL_SECONDS,
  type AskReason,
  type Situation,
} from "./planner";

const OPENING: Goal[] = [{ goal: "open_rewards" }, { goal: "reach_level", level: 0 }];

it("goes back for a lost bag and then carries on with the opening where it left off", async () => {
  const planner = new ProgressPlanner(OPENING);
  const ask = async (reason: AskReason, goal: Goal | null, situation: Situation = NOTHING_TO_DO) =>
    (
      await planner.decide({
        reason,
        goal,
        outcome: null,
        nowMs: 0,
        situation,
        self: { name: "bot", x: 0, y: 0, z: 0, hp: 10, maxHp: 10 },
        players: [],
        peaceful: false,
        recent: [],
      })
    )?.goal ?? null;
  const lost = { ...NOTHING_TO_DO, lostKitAt: { x: 3, y: 4, z: -1 } };

  expect(await ask("start", null)).toEqual({ goal: "open_rewards" });
  expect(await ask("died", { goal: "open_rewards" }, lost)).toEqual({
    goal: "go_to",
    x: 3,
    y: 4,
    z: -1,
  });
  expect(await ask("done", null)).toEqual({ goal: "open_rewards" });
  expect(await ask("done", null)).toEqual({ goal: "reach_level", level: 0 });
  expect(await ask("done", null)).toEqual({ goal: "hunt" });
});

it("rests a recovering bot that has food, gathers for one that has none, and hunts once it has recovered", async () => {
  const planner = new ProgressPlanner([]);
  const ask = async (situation: Situation) =>
    (
      await planner.decide({
        reason: "done",
        goal: null,
        outcome: null,
        nowMs: 0,
        situation,
        self: { name: "bot", x: 0, y: 0, z: 0, hp: 4, maxHp: 10 },
        players: [],
        peaceful: false,
        recent: [],
      })
    )?.goal ?? null;

  expect(await ask({ ...NOTHING_TO_DO, recovering: true, hasFood: true, canGather: true })).toEqual(
    {
      goal: "rest",
      seconds: REST_SPELL_SECONDS,
    },
  );
  expect(await ask({ ...NOTHING_TO_DO, recovering: true, canGather: true })).toEqual({
    goal: "gather",
    pulls: GATHER_PULLS,
  });
  expect(await ask({ ...NOTHING_TO_DO, hasFood: true, canGather: true })).toEqual({ goal: "hunt" });
});

it("sends a recovering bot to safe ground before it rests or gathers, and rests where it is once the walk has failed", async () => {
  const planner = new ProgressPlanner([]);
  const ask = async (reason: AskReason, goal: Goal | null, situation: Situation) =>
    (
      await planner.decide({
        reason,
        goal,
        outcome: null,
        nowMs: 0,
        situation,
        self: { name: "bot", x: 0, y: 0, z: 0, hp: 3, maxHp: 10 },
        players: [],
        peaceful: false,
        recent: [],
      })
    )?.goal ?? null;
  const haven = { x: 40, y: 2, z: 0 };
  const exposed = { ...NOTHING_TO_DO, recovering: true, refugeAt: haven, canGather: true };
  const refuge = { goal: "refuge", ...haven } as const;

  expect(await ask("done", null, { ...exposed, hasFood: true })).toEqual(refuge);
  expect(await ask("done", null, exposed)).toEqual(refuge);
  expect(await ask("failed", refuge, { ...exposed, hasFood: true })).toEqual({
    goal: "rest",
    seconds: REST_SPELL_SECONDS,
  });
});
