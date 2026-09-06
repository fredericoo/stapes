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
import { BOT_TOOLS, parseBotCall, type BotCall } from "./tools";

/**
 * The real provider, behind `./model`'s one-method seam.
 *
 * Imported by `./main` and by nothing else, which is deliberate: the suite drives
 * the runner against a real world with a scripted stub in this slot, so no test
 * loads this file, needs a key, or costs anything.
 *
 * ## One round trip, and the runner applies what comes back
 *
 * The tools are defined **without an `execute` function**, so the engine hands
 * the calls back rather than running them and looping — a tool with no executor
 * is a client request, and a run made entirely of them finishes on the first
 * model turn. `maxIterations(1)` says the same thing a second way, so a model
 * that answers with prose instead of a call still costs exactly one call.
 *
 * That is not a limitation being worked around; it is the shape. A tool here
 * writes a *standing intent* — a destination the walk controller keeps walking
 * towards between decisions — so the model is a slow policy over a fast
 * controller, and there is nothing for it to wait on inline.
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
      tools: TOOL_DEFINITIONS,
      agentLoopStrategy: maxIterations(1),
    });
    return collect(stream);
  }
}

/**
 * Read one run off the event stream.
 *
 * The engine speaks AG-UI, so a tool call arrives as a start, a run of argument
 * deltas and an end. Accumulating the deltas per call id rather than reading the
 * end event's `input` is what keeps this working across providers: whether the
 * arguments are already parsed by the time the run ends is a fact about the
 * adapter, and the delta stream is there either way.
 *
 * A call whose arguments do not parse is dropped rather than thrown on. A fast
 * model producing one bad call out of three is ordinary, and it should cost that
 * call — the drop is reported back in the next decision's events, which is how
 * the model finds out.
 */
async function collect(stream: ChatStream): Promise<BotDecision> {
  const names = new Map<string, string>();
  const args = new Map<string, string>();
  const order: string[] = [];
  let text = "";
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  for await (const event of stream) {
    // Read structurally rather than by narrowing the union. The discriminant is
    // AG-UI's `EventType`, a string enum in a package this one does not depend
    // on, and matching on it would mean taking `@ag-ui/core` as a direct
    // dependency for four names whose values are the names themselves.
    const chunk = event as unknown as { type: string } & Record<string, unknown>;
    const type = chunk.type;
    if (type === "TOOL_CALL_START") {
      const id = String(chunk.toolCallId);
      names.set(id, String(chunk.toolCallName ?? chunk.toolName ?? ""));
      args.set(id, "");
      order.push(id);
    } else if (type === "TOOL_CALL_ARGS") {
      const id = String(chunk.toolCallId);
      args.set(id, (args.get(id) ?? "") + String(chunk.delta ?? ""));
    } else if (type === "TEXT_MESSAGE_CONTENT") {
      text += String(chunk.delta ?? "");
    } else if (type === "RUN_FINISHED" || type === "RUN_ERROR") {
      const usage = readUsage(chunk.usage);
      inputTokens = usage.inputTokens;
      outputTokens = usage.outputTokens;
      if (type === "RUN_ERROR") {
        throw new Error(String(chunk.message ?? "the provider failed"));
      }
    }
  }

  const calls: BotCall[] = [];
  for (const id of order) {
    const call = parseBotCall(names.get(id) ?? "", parseJson(args.get(id)));
    if (call) calls.push(call);
  }
  return { calls, text: text.trim(), usage: { inputTokens, outputTokens } };
}

function parseJson(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
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
