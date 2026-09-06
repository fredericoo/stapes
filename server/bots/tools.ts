import * as v from "valibot";
import { MAX_COMMAND_LENGTH } from "../../app/game/commands";
import type { Direction } from "../../app/lib/types";

/**
 * Everything a bot may ask for, and the schemas that decide whether it asked.
 *
 * Three world verbs, which is the whole of this tracer: get somewhere, find out
 * what is under you, say something. Every combat and item verb is deliberately
 * absent — the question being answered here is whether a fast, cheap model can
 * read the view and move sensibly, and a body that can fight is a second
 * question with its own failure modes.
 *
 * ## One of the four does not reach the world
 *
 * `set_goal` writes a sentence into the bot's own memory and sends nothing. It
 * is a {@link BotCall} but not a {@link BotAction}, and the split is not
 * pedantry: `../bots/body` is the client, and everything it can do is something
 * a person can do over the same socket. A goal is a note the runner keeps, so
 * the runner is what applies it — see `./memory`.
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

/**
 * How long a goal may be.
 *
 * A goal is pinned into every prompt until it is replaced, so its length is a
 * cost paid on every decision rather than once. A sentence fits in this; a plan
 * does not, and a model that wanted to write a plan should be refused here
 * rather than have it silently cut in the middle of a word.
 */
export const MAX_GOAL_LENGTH = 160;

const setGoalSchema = v.object({
  text: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_GOAL_LENGTH)),
});

/** Something the body does, which is something a person could do. */
export type BotAction =
  | { tool: "walk_to"; x: number; y: number }
  | { tool: "step"; direction: Direction }
  | { tool: "say"; text: string };

/** A sentence the bot keeps for itself. Nothing is sent to the world. */
export type BotGoal = { tool: "set_goal"; text: string };

/** One tool call, whichever kind it turned out to be. */
export type BotCall = BotAction | BotGoal;

export type BotToolName = BotCall["tool"];

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
  {
    name: "set_goal",
    description:
      "Write down what you are trying to do, in one sentence. It is shown at " +
      "the top of every turn from then on, and it is the only thing you carry " +
      "forward besides the last few things that happened. Set one as soon as " +
      "you decide on something, and call this again to replace it when you " +
      "change your mind.",
    schema: setGoalSchema as v.GenericSchema<Record<string, unknown>>,
  },
];

/**
 * Turn what a provider handed back into a call, or into nothing.
 *
 * Null rather than a throw: a malformed tool call is an ordinary thing for a
 * fast model to produce, and one bad call should cost that call rather than the
 * decision. `./tanstackModel` turns the null into a sentence saying the
 * arguments were not understood, which the model reads before it chooses again.
 */
export function parseBotCall(name: string, input: unknown): BotCall | null {
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
  if (name === "set_goal") {
    const parsed = v.safeParse(setGoalSchema, input);
    return parsed.success ? { tool: "set_goal", ...parsed.output } : null;
  }
  return null;
}

/**
 * One call, in the second person and the past tense.
 *
 * The one place a call becomes a sentence, because it is written down twice.
 * `../bots/body` pushes it into the event log so the next decision reads the
 * request beside whatever the world said about it, and `./memory` keeps it after
 * that log has drained. Two spellings would make one act look like two.
 */
export function describeCall(call: BotCall): string {
  switch (call.tool) {
    case "walk_to":
      return `You set off for (${call.x}, ${call.y}).`;
    case "step":
      return `You stepped ${call.direction}.`;
    case "say":
      return `You said: ${call.text}`;
    case "set_goal":
      return `You set your goal: ${call.text}`;
  }
}

/**
 * How many calls one decision may make, one after another. `set_goal` is one of
 * them.
 *
 * **A bound on a sequence, not on a batch.** Every call is applied the moment it
 * is made and answered with what the world said, so the second call is chosen
 * against the first one's answer — see `./model`'s `BotDecisionRequest.apply`.
 * That is what stopped the hedging this number was originally set to one for: a
 * model allowed three blind calls said the same thing three times in three
 * phrasings, because nothing told it the first had landed.
 *
 * **Three, because the decisions worth chaining are two or three calls long.**
 * Writing a goal and then acting on it is two. Being refused a route and
 * stepping instead is two. Doing both is three, and nothing observed so far
 * wants a fourth.
 *
 * It is also the spend. Each call in a chain is another request carrying the
 * whole prompt again, so this number is the multiple of a decision's input
 * tokens in the worst case — see `./tanstackModel`, where it is also the
 * iteration bound the engine is given.
 */
export const MAX_CALLS_PER_DECISION = 3;

/**
 * What a call gets back once the decision has spent {@link
 * MAX_CALLS_PER_DECISION}.
 *
 * An answer rather than a dropped call, because the model is mid-run and about
 * to choose again: told the budget is gone it stops, where a silent drop leaves
 * it believing it acted.
 */
export const NO_CALLS_LEFT_ANSWER =
  "You have done all you can this turn. Stop now; you will be asked again in a moment.";
