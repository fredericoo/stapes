import * as v from "valibot";
import { cellGoal, levelGoal, type NavGoal } from "../app/game/navigation";
import type { ObjectRef } from "../app/game/affordances";
import type { Equipment } from "../app/game/equipment";
import { MAX_LEVEL, MIN_LEVEL, type Coord } from "../app/lib/types";
import type { ActorSnapshot } from "../app/game/GameSession";
import type { BattlerDef } from "../app/lib/battler";
import { forgeOrders, type ForgeOrder } from "./arcane";
import type { Deal, Economy } from "./economy";
import { exploredKey, type Knowledge } from "./knowledge";
import type { Landmarks } from "./memory";

const level = v.pipe(v.number(), v.integer(), v.minValue(MIN_LEVEL), v.maxValue(MAX_LEVEL));
const coordinate = v.pipe(v.number(), v.integer());

export const goalSchema = v.variant("goal", [
  v.object({ goal: v.literal("reach_level"), level }),
  v.object({ goal: v.literal("go_to"), x: coordinate, y: coordinate, z: level }),
  v.object({ goal: v.literal("open_rewards") }),
  v.object({ goal: v.literal("hunt") }),
  v.object({
    goal: v.literal("explore"),
    toward: v.optional(v.object({ x: coordinate, y: coordinate })),
  }),
  v.object({ goal: v.literal("shop") }),
  v.object({ goal: v.literal("sell") }),
  v.object({ goal: v.literal("forge") }),
  v.object({
    goal: v.literal("gather"),
    pulls: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
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
    case "hunt":
      return "hunt";
    case "explore":
      return goal.toward ? `explore toward ${goal.toward.x},${goal.toward.y}` : "explore";
    case "shop":
      return "buy what I can afford and need";
    case "sell":
      return "sell what I carry and do not need";
    case "forge":
      return "forge the stones I carry";
    case "gather":
      return `gather ${goal.pulls} times`;
    case "rest":
      return `rest for ${goal.seconds}s`;
  }
}

/**
 * What a bot does on arriving: press a thing, talk an NPC through a trade,
 * work a resource until it gives, or craft a recipe at a crafter.
 */
export type Act =
  | { readonly kind: "press"; readonly ref: ObjectRef }
  | { readonly kind: "talk"; readonly deal: Deal; readonly at: Coord }
  | { readonly kind: "gather"; readonly ref: ObjectRef }
  | { readonly kind: "craft"; readonly ref: ObjectRef; readonly recipe: number }
  | { readonly kind: "visit"; readonly tileId: string; readonly at: Coord };

/**
 * One leg of a goal: where to walk, what to do on arrival, and the edge cell
 * it is exploring, if that is what it is for.
 */
export type Errand = {
  readonly nav: NavGoal;
  readonly act: Act | null;
  readonly explores: Coord | null;
};

/** What the bot remembers giving up on and where it has already been. */
export type Recall = {
  readonly skipped: ReadonlySet<string>;
  readonly explored: ReadonlySet<string>;
  readonly random: () => number;
  /** Pulls finished since the current goal was set. */
  readonly pulls: number;
  /** Places an explore never heads for: where the fleet saw something this bot fears. */
  readonly avoid: (cell: Coord) => boolean;
};

/**
 * An explore picks at random among this many of the nearest unexplored edge
 * cells, so it mostly works outward from where the bot is and two bots in one
 * place do not walk off together.
 */
export const EXPLORE_CHOICES = 12;

export type Holdings = {
  readonly equipment: Equipment;
  readonly tags: readonly string[];
  readonly body: BattlerDef | null;
};

/** What the bot knows of trade: the catalogue's offers, the fleet's memory, and who is in view. */
export type Market = {
  readonly economy: Economy;
  readonly landmarks: Landmarks;
  readonly bodies: readonly ActorSnapshot[];
};

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
  market: Market,
): Errand | "done" | "rest" | "exhausted" {
  switch (goal.goal) {
    case "reach_level":
      return self.z >= goal.level
        ? "done"
        : { nav: levelGoal(goal.level), act: null, explores: null };
    case "go_to": {
      const nav = cellGoal({ x: goal.x, y: goal.y, z: goal.z }, "beside");
      return nav.reached(self) ? "done" : { nav, act: null, explores: null };
    }
    case "open_rewards": {
      const offers = knowledge
        .rewardsOnOffer(holdings.tags)
        .filter(({ ref }) => !recall.skipped.has(refKey(ref)));
      const nearest = offers.sort((a, b) => distance(self, a.ref) - distance(self, b.ref))[0];
      if (!nearest) return "done";
      return {
        nav: knowledge.rewardGoal(nearest.ref, holdings.equipment, holdings.tags),
        act: { kind: "press", ref: nearest.ref },
        explores: null,
      };
    }
    case "shop":
    case "sell": {
      if (!holdings.body) return "done";
      const { economy } = market;
      const deals =
        goal.goal === "shop"
          ? economy.purchases(holdings.equipment, holdings.body)
          : economy.sales(holdings.equipment, holdings.body);
      if (deals.length === 0) return "done";
      for (const deal of deals) {
        const errand = talkErrand(deal, knowledge, self, recall, market);
        if (errand) return errand;
      }
      return exploreErrand(knowledge, self, null, recall) ?? "exhausted";
    }
    case "forge": {
      if (!holdings.body) return "done";
      const { tilesById, statusDefs } = market.economy;
      const orders = forgeOrders(tilesById, statusDefs, holdings.equipment, holdings.body);
      if (orders.length === 0) return "done";
      return (
        forgeErrand(orders, knowledge, self, recall, market) ??
        exploreErrand(knowledge, self, null, recall) ??
        "exhausted"
      );
    }
    case "gather": {
      if (recall.pulls >= goal.pulls || !holdings.body) return "done";
      return gatherErrand(knowledge, self, holdings, recall, market) ?? "done";
    }
    case "explore":
    case "hunt":
      return (
        exploreErrand(
          knowledge,
          self,
          goal.goal === "explore" ? (goal.toward ?? null) : null,
          recall,
        ) ?? "exhausted"
      );
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
    !recall.explored.has(exploredKey(cell)) &&
    !recall.avoid(cell) &&
    (!toward || planDistance(cell, toward) < start);
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
  return { nav: cellGoal(target, "on"), act: null, explores: target };
}

/**
 * Talk is a counter's width, not an arm's: `canTalkFrom` allows 3.5 cells.
 * A bot stops a little inside it, so a step by the NPC does not end the talk.
 */
export const TALK_CELLS = 3;

/**
 * The walk to whoever makes a deal: the nearest one in view, else the
 * nearest place the fleet remembers one. Null when nobody knows where any
 * is, which is a reason to explore.
 */
function talkErrand(
  deal: Deal,
  knowledge: Knowledge,
  self: Coord,
  recall: Recall,
  market: Market,
): Errand | null {
  const npc = deal.offer.npc;
  const at = whereIs(npc, self, market, recall.skipped);
  if (!at) return null;
  return {
    nav: knowledge.talkGoal(at, TALK_CELLS),
    act: { kind: "talk", deal, at },
    explores: null,
  };
}

/**
 * The nearest resource in what the bot has seen whose yield it wants, else
 * the nearest the fleet remembers. A resource with every pull taken by
 * somebody else is passed over.
 */
function gatherErrand(
  knowledge: Knowledge,
  self: Coord,
  holdings: Holdings,
  recall: Recall,
  market: Market,
): Errand | null {
  const wanted = market.economy.wanted(holdings.equipment, holdings.body!);
  const found = knowledge
    .resources(wanted)
    .filter(({ ref }) => !recall.skipped.has(refKey(ref)))
    .sort((a, b) => distance(self, a.ref) - distance(self, b.ref));
  for (const { ref, tileId } of found) market.landmarks.saw(tileId, ref);
  const nearest = found[0];
  if (nearest) {
    return {
      nav: cellGoal(nearest.ref, "beside"),
      act: { kind: "gather", ref: nearest.ref },
      explores: null,
    };
  }
  for (const tileId of knowledge.resourceTileIds(wanted)) {
    const at = market.landmarks
      .where(tileId, self)
      .find((spot) => !recall.skipped.has(landmarkKey(tileId, spot)));
    if (at)
      return { nav: cellGoal(at, "beside"), act: { kind: "visit", tileId, at }, explores: null };
  }
  return null;
}

/**
 * The walk to the nearest crafter of a forge order in what the bot has seen,
 * else to the nearest the fleet remembers. Null when nobody knows of one.
 */
function forgeErrand(
  orders: readonly ForgeOrder[],
  knowledge: Knowledge,
  self: Coord,
  recall: Recall,
  market: Market,
): Errand | null {
  const crafters = new Set(orders.map((order) => order.crafter));
  const seen = knowledge
    .placements(crafters)
    .filter(({ ref }) => !recall.skipped.has(refKey(ref)))
    .sort((a, b) => distance(self, a.ref) - distance(self, b.ref));
  for (const { ref, tileId } of seen) market.landmarks.saw(tileId, ref);
  const nearest = seen[0];
  if (nearest) {
    const order = orders.find((candidate) => candidate.crafter === nearest.tileId)!;
    return {
      nav: knowledge.craftGoal(nearest.ref),
      act: { kind: "craft", ref: nearest.ref, recipe: order.index },
      explores: null,
    };
  }
  for (const tileId of crafters) {
    const at = market.landmarks
      .where(tileId, self)
      .find((spot) => !recall.skipped.has(landmarkKey(tileId, spot)));
    if (at)
      return { nav: cellGoal(at, "beside"), act: { kind: "visit", tileId, at }, explores: null };
  }
  return null;
}

/** The nearest of `npc` in view, else the nearest place the fleet remembers one not given up on. */
export function whereIs(
  npc: string,
  self: Coord,
  market: Market,
  skipped: ReadonlySet<string>,
): Coord | null {
  const seen = market.bodies
    .filter((body) => body.tileId === npc)
    .sort((a, b) => distance(self, a) - distance(self, b))[0];
  if (seen) return { x: seen.x, y: seen.y, z: seen.z };
  return market.landmarks.where(npc, self).find((at) => !skipped.has(landmarkKey(npc, at))) ?? null;
}

export function refKey(ref: ObjectRef): string {
  return `${ref.x},${ref.y},${ref.z},${ref.stackIndex}`;
}

export function landmarkKey(tileId: string, at: Coord): string {
  return `${tileId}@${at.x},${at.y},${at.z}`;
}

function planDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function distance(a: Coord, b: Coord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) * 4;
}
