import * as v from "valibot";
import { MAX_COMMAND_LENGTH } from "../../app/game/commands";
import type { Direction } from "../../app/lib/types";

/**
 * Everything a bot may ask for, and the schemas that decide whether it asked.
 *
 * Three verbs, which is the whole of this tracer: get somewhere, find out what
 * is under you, say something. Every combat and item verb is deliberately absent
 * — the question being answered here is whether a fast, cheap model can read the
 * view and move sensibly, and a body that can fight is a second question with
 * its own failure modes.
 *
 * ## Two ways to move, and both are needed
 *
 * `walk_to` names a destination and lets `../../app/game/walkTo` find the route,
 * which is what a person does when they know where they are going. `step` presses
 * a direction once, which is what a person does when they do not — and some of
 * this world is only reachable that way. The tutorial opens by walking north into
 * a hole, and a body that can only travel to surfaces it has already resolved can
 * never have that happen to it.
 *
 * ## The schemas are the boundary
 *
 * A model can return anything, so what comes back is parsed rather than cast.
 * Valibot for the reason the rest of this codebase reaches for it at a runtime
 * boundary, and because TanStack AI takes Standard Schema tools directly — the
 * same object is both the JSON schema the provider is told about and the parser
 * the answer goes through.
 */

const directionSchema = v.picklist(["n", "e", "s", "w"] as const);

const walkToSchema = v.object({
  x: v.pipe(v.number(), v.integer()),
  y: v.pipe(v.number(), v.integer()),
});

const stepSchema = v.object({ direction: directionSchema });

/**
 * Anything with length, bounded by the longer of the two things a line can turn
 * out to be.
 *
 * `RemoteSession.say` sorts speech from a command by the leading slash and
 * truncates each to its own limit, so this only has to keep the string a string
 * of sane size — the sorting is not the wire's business here any more than it is
 * a browser's.
 */
const saySchema = v.object({
  text: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_COMMAND_LENGTH)),
});

export type BotAction =
  | { tool: "walk_to"; x: number; y: number }
  | { tool: "step"; direction: Direction }
  | { tool: "say"; text: string };

export type BotToolName = BotAction["tool"];

/** One tool, in the shape a provider is told about it. */
export type BotTool = {
  name: BotToolName;
  description: string;
  /** Standard Schema, so it is both the provider's JSON schema and the parser. */
  schema: v.GenericSchema<Record<string, unknown>>;
};

export const BOT_TOOLS: readonly BotTool[] = [
  {
    name: "walk_to",
    description:
      "Walk to an absolute world cell, routing round whatever is in the way. " +
      "x and y are the coordinates on the rulers beside the grid. The route is " +
      "recomputed as you go and you keep walking between decisions, so this is " +
      "how you travel anywhere you can already see a way to.",
    schema: walkToSchema as v.GenericSchema<Record<string, unknown>>,
  },
  {
    name: "step",
    description:
      "Press one direction once: n, e, s or w. Use this to walk into a cell " +
      "whose bottom you cannot see — walk_to will not take you somewhere it " +
      "cannot already resolve a floor for, and falling is how you find out what " +
      "is down there.",
    schema: stepSchema as v.GenericSchema<Record<string, unknown>>,
  },
  {
    name: "say",
    description:
      "Say something out loud. Everybody nearby hears it. A line beginning with " +
      "a slash is a command rather than speech and is not broadcast.",
    schema: saySchema as v.GenericSchema<Record<string, unknown>>,
  },
];

/**
 * Turn what a provider handed back into an action, or into nothing.
 *
 * Null rather than a throw: a malformed tool call is an ordinary thing for a
 * fast model to produce, and one bad call in a batch of three should cost that
 * call rather than the decision. What was dropped is logged and told back to the
 * model in the next decision's events, which is the only way it learns.
 */
export function parseBotAction(name: string, input: unknown): BotAction | null {
  if (name === "walk_to") {
    const parsed = v.safeParse(walkToSchema, input);
    return parsed.success ? { tool: "walk_to", ...parsed.output } : null;
  }
  if (name === "step") {
    const parsed = v.safeParse(stepSchema, input);
    return parsed.success ? { tool: "step", ...parsed.output } : null;
  }
  if (name === "say") {
    const parsed = v.safeParse(saySchema, input);
    return parsed.success ? { tool: "say", ...parsed.output } : null;
  }
  return null;
}

/** How many actions one decision may carry. */
export const MAX_ACTIONS_PER_DECISION = 3;
