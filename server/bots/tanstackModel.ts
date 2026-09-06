import { chat, maxIterations, toolDefinition } from "@tanstack/ai";
import { toJsonSchema } from "@valibot/to-json-schema";
import type { AnyTextAdapter, ChatStream } from "@tanstack/ai";
import { createGeminiChat, GEMINI_MODELS } from "@tanstack/ai-gemini";
import { createGrokText, GROK_CHAT_MODELS } from "@tanstack/ai-grok";
import { createOpenaiChat, OPENAI_CHAT_MODELS } from "@tanstack/ai-openai";
import type { BotConfig } from "./config";
import {
  BOT_SYSTEM_PROMPT,
  type BotDecision,
  type BotDecisionRequest,
  type BotModel,
} from "./model";
import { BOT_TOOLS, MAX_CALLS_PER_DECISION, parseBotCall } from "./tools";

/**
 * The real provider, behind `./model`'s one-method seam.
 *
 * Imported by `./main` and by nothing else, which is deliberate: the suite drives
 * the runner against a real world with a scripted stub in this slot, so no test
 * loads this file, needs a key, or costs anything.
 *
 * ## The tools execute, so one decision is several requests
 *
 * Each tool has an `execute` that applies the call and returns what the world
 * said, so the engine runs it and asks the model again with the answer in hand.
 * A decision is therefore no longer one request: a turn that calls a tool costs
 * a second request to read the answer, and a chain of calls costs one apiece,
 * bounded by {@link MAX_CALLS_PER_DECISION}. A turn that answers with prose and
 * no call still costs exactly one, because the engine stops the moment a turn
 * emits no calls.
 *
 * **That cost buys the answers a refusal needs.** The outcome of `walk_to` does
 * play out over seconds, but its *refusal* is known immediately: `findPath` runs
 * synchronously. Answered blind, a model hedged — the same `say` three times in
 * one decision, in three phrasings, because nothing told it the first had
 * landed. Answering inline is the fix; capping a decision at one call only
 * stopped the hedging from reaching the world.
 */

/** Which model each provider asks for when nobody has said. */
const DEFAULT_MODELS = {
  gemini: "gemini-3.8-flash",
  grok: "grok-4.5",
  // The small one, on the same grounds the other two defaults are small: a bot
  // decides continuously, so the model it reaches for by default should be the
  // cheapest one that can read a grid. Any other id in the catalogue is one
  // `BOT_MODEL` away.
  openai: "gpt-5-nano",
} as const;

/**
 * A model name checked against the catalogue it has to come from.
 *
 * `BOT_MODEL` is a string out of the environment, and every provider publishes
 * the list of what it will answer to — so the alternative to checking is a
 * process that starts, joins the world, and fails on every decision until
 * somebody reads the log. The catalogue is the provider's own, which is why
 * this takes one rather than knowing any names itself.
 */
function modelFrom<T extends string>(
  name: string,
  catalogue: readonly T[],
  // The whole phrase rather than the provider's name, because the article
  // belongs to whoever knows the name: "a Grok", "an OpenAI".
  described: string,
): T {
  const known = catalogue.find((candidate) => candidate === name);
  if (!known) throw new Error(`${name} is not ${described}`);
  return known;
}

/**
 * Turn the configuration into an adapter.
 *
 * Adding a provider is a case here plus a dependency, which is the whole of what
 * "provider-agnostic" is asked to mean for now — nobody has chosen between these
 * two, and the choice should cost one line when they do.
 *
 * The model name is checked against the provider's own catalogue rather than
 * cast into it. `BOT_MODEL` is a string out of the environment, and the failure
 * it prevents is the expensive kind: a typo that starts the process, joins the
 * world and fails on every decision until somebody reads the log.
 */
export function botAdapter(config: BotConfig): AnyTextAdapter {
  const apiKey = config.BOT_API_KEY;
  if (!apiKey) throw new Error("No BOT_API_KEY, so there is no provider");
  const name = config.BOT_MODEL ?? DEFAULT_MODELS[config.BOT_PROVIDER];

  switch (config.BOT_PROVIDER) {
    case "grok":
      return createGrokText(
        modelFrom(name, GROK_CHAT_MODELS, "a Grok chat model"),
        apiKey,
      ) as AnyTextAdapter;
    case "openai":
      return createOpenaiChat(
        modelFrom(name, OPENAI_CHAT_MODELS, "an OpenAI chat model"),
        apiKey,
      ) as AnyTextAdapter;
    case "gemini":
      return createGeminiChat(
        modelFrom(name, GEMINI_MODELS, "a Gemini model"),
        apiKey,
      ) as AnyTextAdapter;
  }
}

/**
 * The four tools, as the provider is told about them.
 *
 * Built from the same valibot schemas the answers are parsed with — see
 * `./tools` — so the JSON schema a provider is shown and the parser a call goes
 * through cannot describe two different things.
 *
 * **Converted here rather than handed over as they are.** Standard Schema says
 * how to *validate*, and only some of its implementations also carry a JSON
 * Schema conversion — valibot does not, so the engine refuses one at the moment
 * of the first request, with every tool already described and a thread already
 * open. `@valibot/to-json-schema` is the conversion valibot leaves out, and
 * doing it at module load means a schema this cannot express is a process that
 * does not start rather than a bot that joins and fails on every decision.
 */
const TOOL_DEFINITIONS = BOT_TOOLS.map((tool) =>
  toolDefinition({
    name: tool.name,
    description: tool.description,
    // Cast because the two types disagree about one thing neither of these
    // schemas does: JSON Schema lets a sub-schema be the literal `true` or
    // `false`, valibot's output models that and the engine's input does not.
    // Every schema in `./tools` is a flat object of scalars.
    inputSchema: toJsonSchema(tool.schema) as Parameters<
      typeof toolDefinition
    >[0]["inputSchema"],
  }),
);

export class TanStackBotModel implements BotModel {
  constructor(private readonly adapter: AnyTextAdapter) {}

  async decide(request: BotDecisionRequest): Promise<BotDecision> {
    const stream = chat({
      adapter: this.adapter,
      systemPrompts: [BOT_SYSTEM_PROMPT],
      messages: [{ role: "user", content: request.prompt }],
      // Bound to this decision's `apply`, which is why the executors are made
      // here and the definitions at module load: the conversion below is what
      // has to happen once, and `.server` only attaches a function to it.
      tools: TOOL_DEFINITIONS.map((tool) =>
        tool.server((input: unknown) => answer(request, tool.name, input)),
      ),
      // Model turns, and one call fits in a turn, so this is the same bound the
      // runner and the system prompt state — see MAX_CALLS_PER_DECISION. A call
      // made on the last turn is applied like any other; what it does not get is
      // another turn to be read in, and that outcome comes back as an event.
      agentLoopStrategy: maxIterations(MAX_CALLS_PER_DECISION),
    });
    return collect(stream);
  }
}

/**
 * Parse one call the model made, apply it, and hand back what the world said.
 *
 * Parsed here rather than trusted, for the reason `./tools` gives: the engine
 * validates against a JSON *Schema* it was handed, which is a description and
 * not the parser, so the object arriving is still `unknown`.
 *
 * A call that does not parse is answered rather than dropped. It used to be
 * dropped, because a whole batch came back at once and a bad one in three should
 * cost that one — but a model that is about to be asked again should be told,
 * and this is the turn on which telling it is any use.
 */
function answer(
  request: BotDecisionRequest,
  name: string,
  input: unknown,
): string {
  const call = parseBotCall(name, input);
  if (!call) return `${name} was not called with arguments it understands.`;
  return request.apply(call);
}

/**
 * Read one run off the event stream.
 *
 * The calls themselves are not read here any more: they were applied by the
 * executors as they arrived, and the runner that passed `apply` in already has
 * the list. What is left is the text and the cost.
 *
 * **Usage is summed rather than taken from the end**, and that is the whole
 * point of measuring it: a run reports one `RUN_FINISHED` per model turn, so
 * reading the last would report a three-request decision as costing one.
 */
async function collect(stream: ChatStream): Promise<BotDecision> {
  let text = "";
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  for await (const event of stream) {
    // Read structurally rather than by narrowing the union. The discriminant is
    // AG-UI's `EventType`, a string enum in a package this one does not depend
    // on, and matching on it would mean taking `@ag-ui/core` as a direct
    // dependency for three names whose values are the names themselves.
    const chunk = event as unknown as { type: string } & Record<string, unknown>;
    const type = chunk.type;
    if (type === "TEXT_MESSAGE_CONTENT") {
      text += String(chunk.delta ?? "");
    } else if (type === "RUN_FINISHED" || type === "RUN_ERROR") {
      const usage = readUsage(chunk.usage);
      inputTokens = add(inputTokens, usage.inputTokens);
      outputTokens = add(outputTokens, usage.outputTokens);
      if (type === "RUN_ERROR") {
        throw new Error(String(chunk.message ?? "the provider failed"));
      }
    }
  }

  return { text: text.trim(), usage: { inputTokens, outputTokens } };
}

/**
 * Token counts, whichever of the two shapes the run reports them in.
 *
 * AG-UI carries usage as an array of per-model entries; the engine's own
 * `TokenUsage` is a single object. Both appear on the same field, and a log line
 * that silently read `null` from the shape it did not expect would be a cost
 * report that quietly said nothing.
 */
function readUsage(usage: unknown): {
  inputTokens: number | null;
  outputTokens: number | null;
} {
  const entries = Array.isArray(usage) ? usage : usage ? [usage] : [];
  let input: number | null = null;
  let output: number | null = null;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const from = (...keys: string[]): number | null => {
      for (const key of keys) {
        if (typeof record[key] === "number") return record[key];
      }
      return null;
    };
    input = add(input, from("inputTokens", "promptTokens"));
    output = add(output, from("outputTokens", "completionTokens"));
  }
  return { inputTokens: input, outputTokens: output };
}

function add(total: number | null, next: number | null): number | null {
  if (next === null) return total;
  return (total ?? 0) + next;
}
