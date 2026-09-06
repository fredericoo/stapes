import { chat, maxIterations, toolDefinition } from "@tanstack/ai";
import type { AnyTextAdapter, ChatStream } from "@tanstack/ai";
import { createGeminiChat, GEMINI_MODELS } from "@tanstack/ai-gemini";
import { createGrokText, GROK_CHAT_MODELS } from "@tanstack/ai-grok";
import type { BotConfig } from "./config";
import {
  BOT_SYSTEM_PROMPT,
  type BotDecision,
  type BotDecisionRequest,
  type BotModel,
} from "./model";
import { BOT_TOOLS, parseBotAction, type BotAction } from "./tools";

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
} as const;

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

  if (config.BOT_PROVIDER === "grok") {
    const model = GROK_CHAT_MODELS.find((known) => known === name);
    if (!model) throw new Error(`${name} is not a Grok chat model`);
    return createGrokText(model, apiKey) as AnyTextAdapter;
  }

  const model = GEMINI_MODELS.find((known) => known === name);
  if (!model) throw new Error(`${name} is not a Gemini model`);
  return createGeminiChat(model, apiKey) as AnyTextAdapter;
}

/**
 * The three tools, as the provider is told about them.
 *
 * Built from the same valibot schemas the answers are parsed with — see
 * `./tools` — so the JSON schema a provider is shown and the parser a call goes
 * through cannot describe two different things. That is the whole reason
 * Standard Schema is worth having here.
 */
const TOOL_DEFINITIONS = BOT_TOOLS.map((tool) =>
  toolDefinition({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.schema,
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

  const actions: BotAction[] = [];
  for (const id of order) {
    const action = parseBotAction(names.get(id) ?? "", parseJson(args.get(id)));
    if (action) actions.push(action);
  }
  return { actions, text: text.trim(), usage: { inputTokens, outputTokens } };
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
