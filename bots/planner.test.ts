import { expect, it } from "bun:test";
import type { Goal } from "./goals";
import type { Need, Objective } from "./objective";
import {
  GATHER_PULLS,
  HUNT_SPELL_MS,
  NOTHING_TO_DO,
  OBJECTIVE_STALL_MS,
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
        objective: null,
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
        objective: null,
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
        objective: null,
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

function objective(name: string, worth: number, needs: Need[]): Objective {
  const take = needs.map((need) => ({ tileId: need.tileId, count: need.want }));
  const offer = {
    npc: "seller",
    npcName: "Seller",
    path: [name.length],
    take,
    give: [{ tileId: name, count: 1 }],
    min: 1,
    max: 1,
  };
  return { key: name, offer, name, needs, seconds: 1, worth };
}

function objectivePlanner() {
  const planner = new ProgressPlanner([]);
  return async (nowMs: number, situation: Situation, goal: Goal | null = null) =>
    planner.decide({
      reason: "done",
      goal,
      outcome: null,
      nowMs,
      situation,
      self: { name: "bot", x: 0, y: 0, z: 0, hp: 10, maxHp: 10 },
      players: [],
      peaceful: false,
      recent: [],
      objective: null,
    });
}

const skins = (have: number): Need => ({
  tileId: "skin",
  name: "Skin",
  want: 5,
  have,
  via: "hunt",
  seconds: 1,
});
const shards = (have: number): Need => ({
  tileId: "shard",
  name: "Shard",
  want: 20,
  have,
  via: "gather",
  seconds: 1,
});

it("hunts for an input that creatures drop and gathers for one that resources yield, whatever the hunting timer says", async () => {
  const ask = objectivePlanner();
  const cap = objective("cap", 1, [skins(2)]);
  const sword = objective("sword", 1, [shards(4)]);
  const helm = objective("helm", 1, [skins(4), shards(2)]);
  const gathering = { ...NOTHING_TO_DO, canGather: true };

  await ask(0, NOTHING_TO_DO, null);
  const late = HUNT_SPELL_MS + 1;
  expect(await ask(late, { ...gathering, objectives: [cap] }, { goal: "hunt" })).toEqual({
    goal: { goal: "hunt" },
    objective: cap,
  });
  expect((await ask(late, { ...gathering, objectives: [sword] }))?.goal).toEqual({
    goal: "gather",
    pulls: GATHER_PULLS,
  });

  const fresh = objectivePlanner();
  expect((await fresh(0, { ...gathering, objectives: [helm] }))?.goal).toEqual({
    goal: "gather",
    pulls: GATHER_PULLS,
  });
});

it("keeps its objective over a slightly better one, takes a far better one, and drops one that stalls with every other on the same input", async () => {
  const ask = objectivePlanner();
  const cap = objective("cap", 1, [skins(0)]);
  const boots = objective("boots", 1.2, [skins(0)]);
  const backpack = objective("backpack", 3, [skins(0)]);
  const sword = objective("sword", 0.5, [shards(0)]);
  const at = (objectives: Objective[]) => ({ ...NOTHING_TO_DO, objectives });
  const all = [backpack, boots, cap, sword];

  expect((await ask(0, at([cap, sword])))?.objective).toBe(cap);
  expect((await ask(1, at([boots, cap, sword])))?.objective).toBe(cap);
  expect((await ask(2, at(all)))?.objective).toBe(backpack);

  const stalled = OBJECTIVE_STALL_MS + 3;
  expect((await ask(stalled, at(all)))?.objective).toBe(sword);
  expect((await ask(stalled + 1, at(all)))?.objective).toBe(sword);
  const later = stalled + OBJECTIVE_STALL_MS + 1;
  expect((await ask(later, at([backpack, boots, cap])))?.objective).toBe(backpack);
});

it("does not count time spent on the opening as its objective stalling", async () => {
  const planner = new ProgressPlanner(OPENING);
  const cap = objective("cap", 1, [skins(0)]);
  const boots = objective("boots", 1, [skins(0)]);
  const ask = async (nowMs: number) =>
    (
      await planner.decide({
        reason: "timer",
        goal: OPENING[0]!,
        outcome: null,
        nowMs,
        situation: { ...NOTHING_TO_DO, objectives: [cap, boots] },
        self: { name: "bot", x: 0, y: 0, z: 0, hp: 10, maxHp: 10 },
        players: [],
        peaceful: false,
        recent: [],
        objective: null,
      })
    )?.objective;

  expect(await ask(0)).toBe(cap);
  expect(await ask(2 * OBJECTIVE_STALL_MS)).toBe(cap);
});
