import { expect, it } from "bun:test";
import type { AnyTextAdapter } from "@tanstack/ai";
import { LlmPlanner } from "./LlmPlanner";
import { NOTHING_TO_DO, ScriptedPlanner, type Observation } from "./planner";

type Call = { readonly name: string; readonly args: unknown };

/**
 * A model that answers every request with `text` and `calls` and records what
 * it was sent, shaped as the OpenAI adapter's chunks are.
 */
function fakeModel(text: string, calls: readonly Call[] = []) {
  const requests: { tools: { name: string }[] }[] = [];
  const adapter = {
    kind: "text",
    name: "fake",
    model: "fake",
    async *chatStream(options: { tools?: { name: string }[] }) {
      requests.push({ tools: options.tools ?? [] });
      const base = { model: "fake", timestamp: 0 };
      yield { ...base, type: "RUN_STARTED", runId: "run", threadId: "thread" };
      if (text) {
        const messageId = "message";
        yield { ...base, type: "TEXT_MESSAGE_START", messageId, role: "assistant" };
        yield { ...base, type: "TEXT_MESSAGE_CONTENT", messageId, delta: text };
        yield { ...base, type: "TEXT_MESSAGE_END", messageId };
      }
      for (const [index, call] of calls.entries()) {
        const toolCallId = `call-${index}`;
        const args = JSON.stringify(call.args);
        const named = { toolCallId, toolCallName: call.name, toolName: call.name };
        yield { ...base, ...named, type: "TOOL_CALL_START" };
        yield { ...base, toolCallId, type: "TOOL_CALL_ARGS", delta: args, args };
        yield { ...base, ...named, type: "TOOL_CALL_END", input: call.args };
      }
      const finishReason = calls.length ? "tool_calls" : "stop";
      yield { ...base, type: "RUN_FINISHED", runId: "run", threadId: "thread", finishReason };
    },
    async structuredOutput() {
      throw new Error("not used");
    },
  };
  return { adapter: adapter as unknown as AnyTextAdapter, requests };
}

function observation(reason: Observation["reason"], lines: string[]): Observation {
  return {
    reason,
    goal: { goal: "hunt" },
    outcome: null,
    nowMs: 0,
    situation: NOTHING_TO_DO,
    self: { name: "Wren", x: 0, y: 0, z: 0, hp: 10, maxHp: 10 },
    players: [{ name: "Ash", x: 2, y: 0, z: 0 }],
    peaceful: false,
    recent: lines.map((line, index) => ({
      seq: index + 1,
      atMs: index * 1000,
      line,
      heard: line.includes(" said: "),
    })),
  };
}

it("says what the model writes and steers by its tool calls, in one request", async () => {
  const { adapter, requests } = fakeModel("omw", [
    { name: "set_goal", args: { goal: "go_to", x: 2, y: 0, level: 0, seconds: null, pulls: null } },
    { name: "set_peaceful", args: { peaceful: true } },
  ]);
  const planner = new LlmPlanner(adapter, new ScriptedPlanner([]));

  const decision = await planner.decide(observation("heard", ['Ash said: "come here"']));

  expect(decision).toEqual({
    say: "omw",
    goal: { goal: "go_to", x: 2, y: 0, z: 0 },
    peaceful: true,
  });
  expect(requests).toHaveLength(1);
});

it("ignores a goal that is missing a field it needs", async () => {
  const { adapter } = fakeModel("", [
    {
      name: "set_goal",
      args: { goal: "go_to", x: 2, y: null, level: 0, seconds: null, pulls: null },
    },
  ]);
  const planner = new LlmPlanner(adapter, new ScriptedPlanner([]));

  expect(await planner.decide(observation("heard", ['Ash said: "come here"']))).toEqual({});
});

it("keeps the fallback's goal and stays silent when the model writes nothing", async () => {
  const { adapter } = fakeModel("  \n");
  const planner = new LlmPlanner(adapter, new ScriptedPlanner([{ goal: "open_rewards" }]));

  expect(await planner.decide(observation("start", []))).toEqual({
    goal: { goal: "open_rewards" },
  });
});

it("does not call the model on a timer when nothing has happened since", async () => {
  const { adapter, requests } = fakeModel("");
  const planner = new LlmPlanner(adapter, new ScriptedPlanner([]));

  await planner.decide(observation("heard", ['Ash said: "hi"']));
  await planner.decide(observation("timer", ['Ash said: "hi"']));

  expect(requests).toHaveLength(1);
});

it("stays silent when nobody has spoken since it last decided", async () => {
  const { adapter } = fakeModel("hey bro what's up");
  const planner = new LlmPlanner(adapter, new ScriptedPlanner([]));

  await planner.decide(observation("heard", ['Ash said: "hey bro"']));
  const decision = await planner.decide(
    observation("done", ['Ash said: "hey bro"', "picked up Apple Pie"]),
  );

  expect(decision).toEqual({});
});
