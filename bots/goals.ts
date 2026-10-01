import * as v from "valibot";
import { cellGoal, levelGoal, type NavGoal } from "../app/game/navigation";
import type { ObjectRef } from "../app/game/affordances";
import type { Equipment } from "../app/game/equipment";
import { MAX_LEVEL, MIN_LEVEL, type Coord } from "../app/lib/types";
import { exploredKey, type Knowledge } from "./knowledge";

const level = v.pipe(v.number(), v.integer(), v.minValue(MIN_LEVEL), v.maxValue(MAX_LEVEL));
const coordinate = v.pipe(v.number(), v.integer());

export const goalSchema = v.variant("goal", [
  v.object({ goal: v.literal("reach_level"), level }),
  v.object({ goal: v.literal("go_to"), x: coordinate, y: coordinate, z: level }),
  v.object({ goal: v.literal("open_rewards") }),
  v.object({
    goal: v.literal("explore"),
    toward: v.optional(v.object({ x: coordinate, y: coordinate })),
  }),
  v.object({
    goal: v.literal("rest"),
    seconds: v.pipe(v.number(), v.minValue(1), v.maxValue(300)),
  }),
]);

export type Goal = v.InferOutput<typeof goalSchema>;

export function describeGoal(goal: Goal): string {
  switch (goal.goal) {
    case "reach_level":
      return `reach level ${goal.level}`;
    case "go_to":
      return `go to ${goal.x},${goal.y} on level ${goal.z}`;
    case "open_rewards":
      return "open every reward I know of";
    case "explore":
      return goal.toward ? `explore toward ${goal.toward.x},${goal.toward.y}` : "explore";
    case "rest":
      return `rest for ${goal.seconds}s`;
  }
}

/**
 * One leg of a goal: where to walk, what to press on arrival, and the edge
 * cell it is exploring, if that is what it is for.
 */
export type Errand = {
  readonly nav: NavGoal;
  readonly press: ObjectRef | null;
  readonly explores: Coord | null;
};

/** What the bot remembers giving up on and where it has already been. */
export type Recall = {
  readonly skipped: ReadonlySet<string>;
  readonly explored: ReadonlySet<string>;
  readonly random: () => number;
};

/**
 * An explore picks at random among this many of the nearest unexplored edge
 * cells, so it mostly works outward from where the bot is and two bots in one
 * place do not walk off together.
 */
export const EXPLORE_CHOICES = 12;

export type Holdings = { readonly equipment: Equipment; readonly tags: readonly string[] };

/**
 * The next errand towards a goal, or `"done"` when there is nothing left to
 * do for it. A goal that wants a place nobody has seen has no errand of its
 * own, so the bot explores until one appears.
 */
export function nextErrand(
  goal: Goal,
  knowledge: Knowledge,
  self: Coord,
  holdings: Holdings,
  recall: Recall,
): Errand | "done" | "rest" | "exhausted" {
  switch (goal.goal) {
    case "reach_level":
      return self.z >= goal.level
        ? "done"
        : { nav: levelGoal(goal.level), press: null, explores: null };
    case "go_to": {
      const nav = cellGoal({ x: goal.x, y: goal.y, z: goal.z }, "beside");
      return nav.reached(self) ? "done" : { nav, press: null, explores: null };
    }
    case "open_rewards": {
      const offers = knowledge
        .rewardsOnOffer(holdings.tags)
        .filter(({ ref }) => !recall.skipped.has(`${ref.x},${ref.y},${ref.z},${ref.stackIndex}`));
      const nearest = offers.sort((a, b) => distance(self, a.ref) - distance(self, b.ref))[0];
      if (!nearest) return "done";
      return {
        nav: knowledge.rewardGoal(nearest.ref, holdings.equipment, holdings.tags),
        press: nearest.ref,
        explores: null,
      };
    }
    case "explore":
      return exploreErrand(knowledge, self, goal.toward ?? null, recall) ?? "exhausted";
    case "rest":
      return "rest";
  }
}

/**
 * Wandering, when there is no unexplored edge left to walk to: the edge of a
 * map is never sent, so on a world the bot has seen all of, every edge left
 * is the outside of the map. Roaming goes somewhere this far away instead.
 */
export const ROAM_NEAR_CELLS = 15;

export const ROAM_FAR_CELLS = 60;

/**
 * A walk to an unexplored place: one of the nearest edge cells while any are
 * left, else a known cell a roam's distance away. With `toward`, only cells
 * nearer that point than the bot is count, so "explore north" never settles
 * for what is behind it.
 */
export function exploreErrand(
  knowledge: Knowledge,
  self: Coord,
  toward: { x: number; y: number } | null,
  recall: Recall,
): Errand | null {
  const start = toward ? planDistance(self, toward) : 0;
  const fresh = (cell: Coord) =>
    !recall.explored.has(exploredKey(cell)) && (!toward || planDistance(cell, toward) < start);
  const edges = knowledge
    .frontierCells()
    .filter(fresh)
    .sort((a, b) => distance(self, a) - distance(self, b))
    .slice(0, EXPLORE_CHOICES);
  const choices = edges.length
    ? edges
    : knowledge.standingCellsAround(self, ROAM_NEAR_CELLS, ROAM_FAR_CELLS).filter(fresh);
  if (choices.length === 0) return null;
  const target = choices[Math.floor(recall.random() * choices.length)]!;
  return { nav: cellGoal(target, "on"), press: null, explores: target };
}

function planDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function distance(a: Coord, b: Coord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) * 4;
}
