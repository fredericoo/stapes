import { chat, maxIterations, toolDefinition, type AnyTextAdapter } from "@tanstack/ai";
import { createOpenaiChat } from "@tanstack/ai-openai";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";
import { describeGoal, goalSchema, type Goal } from "./goals";
import type { Decision, Observation, Planner } from "./planner";

export const BOT_MODEL = "gpt-5-nano";

/**
 * `minimal` answered almost every line, insults and chatter between others
 * included; `low` stayed quiet where it should, for about two seconds more.
 */
export const REASONING_EFFORT = "low";

/** Reasoning counts against this, and at `low` 400 cut answers off. */
export const MAX_OUTPUT_TOKENS = 2_000;

/** A reply is a few words; the chat itself allows `MAX_CHAT_LENGTH`. */
export const MAX_SAY_LENGTH = 80;

const MS_PER_SECOND = 1000;

const GOAL_NAMES = [
  "reach_level",
  "go_to",
  "open_rewards",
  "hunt",
  "explore",
  "shop",
  "sell",
  "gather",
  "rest",
] as const;

const wholeOrNull = v.nullable(v.pipe(v.number(), v.integer()));

/**
 * `goalSchema` is a union, which OpenAI's strict tool mode refuses, so the
 * tool takes every field flat, unused ones null, and `goalFrom` checks it.
 */
const goalArgsSchema = v.object({
  goal: v.picklist(GOAL_NAMES),
  x: wholeOrNull,
  y: wholeOrNull,
  level: wholeOrNull,
  seconds: wholeOrNull,
  pulls: wholeOrNull,
});

function goalFrom(args: v.InferOutput<typeof goalArgsSchema>): Goal | null {
  const { goal, x, y, level, seconds, pulls } = args;
  const toward = x !== null && y !== null ? { x, y } : undefined;
  const candidates: Record<(typeof GOAL_NAMES)[number], unknown> = {
    reach_level: { goal, level },
    go_to: { goal, x, y, z: level },
    open_rewards: { goal },
    hunt: { goal },
    explore: { goal, toward },
    shop: { goal },
    sell: { goal },
    gather: { goal, pulls },
    rest: { goal, seconds },
  };
  const parsed = v.safeParse(goalSchema, candidates[goal]);
  return parsed.success ? parsed.output : null;
}

const okSchema = toStandardJsonSchema(v.object({ ok: v.boolean() }));

const setGoalDefinition = toolDefinition({
  name: "set_goal",
  description: [
    "Change what you are doing, only when a player asks you to or what happened calls for it.",
    "reach_level: climb or descend to `level` (0 is the surface, below 0 is underground);",
    "go_to: walk to x,y on `level`, e.g. to a player who asked you to come;",
    "open_rewards: open every chest and reward you know of;",
    "hunt: explore and fight creatures you can beat;",
    "explore: walk somewhere new, toward x,y if given;",
    "shop: buy what you need and can afford from an NPC;",
    "sell: sell what you carry and do not need to an NPC;",
    "gather: work resources like veins and bushes `pulls` times (1 to 100);",
    "rest: stand still for `seconds` (1 to 300).",
    "Fields a goal does not use are null.",
  ].join(" "),
  inputSchema: toStandardJsonSchema(goalArgsSchema),
  outputSchema: okSchema,
});

const setPeacefulDefinition = toolDefinition({
  name: "set_peaceful",
  description:
    "true: hunt nothing and only fight what attacks you. false: attack creatures you can beat. Only when a player asks or what happened calls for it.",
  inputSchema: toStandardJsonSchema(v.object({ peaceful: v.boolean() })),
  outputSchema: okSchema,
});

function systemPrompt(name: string): string {
  return `You are ${name}, a player in The Last Stones, an online tile game where people explore, open chests, fight creatures and chat. You play it like a person would. Never say you are an AI or a bot.

Whatever text you write is said out loud in the game chat. Write NOTHING (an empty answer) unless a NEW line from another player calls for an answer from you: a greeting, a question, a request, your name. Insults, people talking to each other, acknowledgements and anything else that needs no answer get an empty answer. When unsure, write nothing. Never answer your own lines, and let a conversation end.

Replies are ultra short and casual, like a gamer typing: lowercase, one to six words, plain ASCII, no emoji.

Call set_goal or set_peaceful only when a player asks you to and it is reasonable, or when what happened calls for it. When you do it for someone who asked, also write a short reply to them.`;
}

/**
 * Asks a language model what the bot does next, in one round trip: what it
 * writes is said out loud, nothing at all is silence, and its tool calls
 * steer the bot. Forcing every answer through a tool was tried and made it
 * answer every line, since a field to fill got filled.
 * `fallback` is asked first and the model may override it, so a bot the
 * model leaves alone still has a goal, and one whose call fails still moves.
 * A timer ask with nothing new since the last one is answered without a call.
 * It speaks only when another player has said something since its last ask:
 * asked because it picked something up, it greeted a line it had already
 * answered.
 */
export class LlmPlanner implements Planner {
  private seenSeq = 0;

  constructor(
    private readonly adapter: AnyTextAdapter,
    private readonly fallback: Planner,
    private readonly log: (line: string) => void = () => {},
  ) {}

  async decide(observation: Observation): Promise<Decision | null> {
    const base = await this.fallback.decide(observation);
    const fresh = observation.recent.filter((memory) => memory.seq > this.seenSeq);
    if (observation.reason === "timer" && fresh.length === 0) return base;
    const spokenTo = fresh.some((memory) => memory.heard);
    const lastSeq = observation.recent.at(-1)?.seq ?? this.seenSeq;
    const briefed = { ...observation, goal: base?.goal ?? observation.goal };
    try {
      const { say, ...steer } = await this.ask(briefed);
      this.seenSeq = lastSeq;
      return { ...base, ...steer, ...(say && spokenTo ? { say } : {}) };
    } catch (error) {
      this.log(`model failed: ${String(error)}`);
      return base;
    }
  }

  private async ask(observation: Observation): Promise<Decision> {
    const decision: { goal?: Goal; peaceful?: boolean } = {};
    const tools = [
      setGoalDefinition.server((args) => {
        const goal = goalFrom(args);
        if (goal) decision.goal = goal;
        return { ok: goal !== null };
      }),
      setPeacefulDefinition.server(({ peaceful }) => {
        decision.peaceful = peaceful;
        return { ok: true };
      }),
    ];
    const said = await chat({
      adapter: this.adapter,
      systemPrompts: [systemPrompt(observation.self.name)],
      messages: [{ role: "user", content: brief(observation, this.seenSeq) }],
      tools,
      agentLoopStrategy: maxIterations(1),
      stream: false,
      modelOptions: {
        reasoning: { effort: REASONING_EFFORT },
        max_output_tokens: MAX_OUTPUT_TOKENS,
      },
    });
    const say = said.trim().slice(0, MAX_SAY_LENGTH);
    return say ? { ...decision, say } : decision;
  }
}

export function openaiPlanner(
  apiKey: string,
  fallback: Planner,
  log: (line: string) => void,
): LlmPlanner {
  const adapter = createOpenaiChat(BOT_MODEL, apiKey);
  return new LlmPlanner(adapter as AnyTextAdapter, fallback, log);
}

/**
 * What the bot knows right now, as the model reads it. Lines that arrived
 * since the last ask are marked new, so a message already answered is not
 * answered again.
 */
export function brief(observation: Observation, seenSeq: number): string {
  const { self, players, goal, peaceful, recent } = observation;
  const nowMs = recent.at(-1)?.atMs ?? 0;
  const health = self.hp === null ? "" : `, health ${self.hp}/${self.maxHp ?? "?"}`;
  const around = players.length
    ? players.map((p) => `${p.name} at ${p.x},${p.y},${p.z}`).join("; ")
    : "nobody";
  const events = recent.map((memory) => {
    const agoSeconds = Math.round((nowMs - memory.atMs) / MS_PER_SECOND);
    const marker = memory.seq > seenSeq ? "NEW " : "";
    return `- ${marker}${agoSeconds}s ago: ${memory.line}`;
  });
  return [
    `You are at ${self.x},${self.y},${self.z}${health}.`,
    `Goal: ${goal ? describeGoal(goal) : "none"}. Peaceful: ${peaceful ? "yes" : "no"}.`,
    `Players you can see: ${around}.`,
    `Why you are deciding now: ${observation.reason}${observation.outcome ? ` (${observation.outcome})` : ""}.`,
    "What happened, oldest first:",
    ...(events.length ? events : ["- nothing yet"]),
  ].join("\n");
}
