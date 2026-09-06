import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import tilesJson from "../../data/tiles.json";
import statusesJson from "../../data/statuses.json";
import { WALK_DURATION_MS } from "../../app/game/constants";
import { normalizeTiles, type FlatMapFile, type TileDef } from "../../app/lib/types";
import { parseClientMessage } from "../../app/net/protocol";
import { Harness, Pair, type TestSocket } from "../testHarness";
import { BotBody } from "./body";
import type { BotDecision, BotDecisionLog, BotModel } from "./model";
import {
  BOT_FRAME_MS,
  BotRunner,
  DecisionGuard,
  DEFAULT_BOT_LIMITS,
} from "./runner";
import type { BotCall } from "./tools";
import type { BotSocket } from "./transport";

/**
 * A bot playing the real world.
 *
 * A fake model and real everything else: a scripted provider in the one slot
 * that would otherwise cost money and take a network, and a genuine
 * `GameServer` behind a genuine socket for everything else — the same pair
 * `GameServer.test.ts` drives, wired the way `server/index.ts` wires Elysia's
 * handlers. So what these cases actually exercise is a bot's frames going
 * through the server's own validation, its refusals coming back, and the world
 * moving because of them.
 *
 * The map is built here rather than read from `data/map.json`, per the rule: the
 * shipped world is authored constantly and a test that read a coordinate out of
 * it would fail on an afternoon's editing. The tile *catalogue* is the real one,
 * because heights and walkability are what a route is decided by.
 */

const JSON_TYPE = "application/json";
const tiles: TileDef[] = normalizeTiles(tilesJson as unknown[]);

/** How long a wait for the world to do something gives up after. */
const TIMEOUT_MS = 5_000;

/**
 * A field of grass with the authored spawn marker at the origin.
 *
 * Wide enough to route across and no wider. Nothing else is on it, so a step the
 * server refuses is a step the *rules* refused rather than a crate somebody put
 * in the way.
 */
function fieldMap(): FlatMapFile {
  const cells: Record<string, unknown[]> = {};
  for (let x = -2; x <= 6; x++) {
    for (let y = -2; y <= 2; y++) {
      cells[`${x},${y}`] = [{ tileId: "grass" }];
    }
  }
  cells["0,0"] = [{ tileId: "grass" }, { tileId: "player", direction: "s" }];
  return { version: 1, levels: { "0": cells } } as FlatMapFile;
}

let harness: Harness;

beforeEach(async () => {
  harness = await Harness.create();
  await harness.blobs.put("tiles.json", JSON.stringify(tilesJson), JSON_TYPE);
  await harness.blobs.put(
    "statuses.json",
    JSON.stringify(statusesJson),
    JSON_TYPE,
  );
  await harness.blobs.put("map.json", JSON.stringify(fieldMap()), JSON_TYPE);
});

afterEach(async () => {
  await harness.dispose();
});

/** Every provider a test needs: one that answers from a list, in order. */
function scripted(script: BotCall[][], prompts?: string[]): BotModel {
  let turn = 0;
  return {
    decide(request): Promise<BotDecision> {
      prompts?.push(request.prompt);
      const calls = script[turn] ?? [];
      turn += 1;
      return Promise.resolve({
        calls,
        text: "",
        usage: { inputTokens: 100, outputTokens: 10 },
      });
    },
  };
}

/** A provider that is down. */
function failing(): BotModel {
  return {
    decide(): Promise<BotDecision> {
      return Promise.reject(new Error("the provider is down"));
    },
  };
}

/**
 * The harness's socket pair, in the shape a session takes.
 *
 * `readyState` is the one member the pair does not have — `RemoteSession`
 * compares it against `WebSocket.OPEN` before every send — and a closed socket
 * is not a case any of this is about, so it is simply open.
 */
function botSocket(ws: TestSocket, sent: string[]): BotSocket {
  return {
    readyState: 1,
    send(data: string) {
      sent.push(data);
      ws.send(data);
    },
    close() {
      ws.close();
    },
    addEventListener(_type, listener) {
      ws.addEventListener("message", listener as (e: { data: string }) => void);
    },
    removeEventListener(_type, listener) {
      ws.removeEventListener(
        "message",
        listener as (e: { data: string }) => void,
      );
    },
  };
}

/** Join the world as a client, exactly as `server/index.ts` does. */
function accept(actorId: string) {
  const pair = new Pair();
  const ws = pair.client();
  pair.onClientMessage = (data) => {
    void harness.server.webSocketMessage(pair.server, data);
  };
  pair.onClientClose = () => {
    harness.hub.drop(pair.server);
    void harness.server.webSocketClose(pair.server);
  };
  void harness.server.join(pair.server, actorId);
  return { pair, ws };
}

/** One bot, joined and ready, plus everything a case needs to look at it. */
async function joinBot(actorId: string) {
  const sent: string[] = [];
  const rejected: number[] = [];
  const { pair, ws } = accept(actorId);
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data) as { type?: string; seq?: number };
    if (message.type === "stepRejected") rejected.push(message.seq ?? -1);
  });
  const body = new BotBody(botSocket(ws, sent), tiles);
  await until(() => body.isReady());
  return { body, sent, rejected, pair };
}

/** Where the world says this actor is, read off a fresh joiner's `hello`. */
async function serverCellOf(actorId: string): Promise<string | null> {
  const { pair, ws } = accept("observer");
  const hello = (await nextMessageOfType(ws, "hello")) as {
    map: FlatMapFile;
  };
  harness.hub.drop(pair.server);
  await harness.server.webSocketClose(pair.server);
  for (const cells of Object.values(hello.map.levels)) {
    for (const [key, stack] of Object.entries(cells)) {
      if (stack.some((placed) => placed.owner === actorId)) return key;
    }
  }
  return null;
}

describe("a bot in the world", () => {
  it("walks where it decided to walk, and the world agrees it did", async () => {
    const { body, sent, rejected } = await joinBot("bot");
    const runner = new BotRunner({
      body,
      model: scripted([[{ tool: "walk_to", x: 4, y: 0 }]]),
      log: () => {},
    });

    await settle(runner, body);
    expect(await runner.decideOnce()).toBe(true);
    await frames(runner, WALK_DURATION_MS * 6);

    expect(await serverCellOf("bot")).toBe("4,0");
    expect(rejected).toEqual([]);
    // Everything it said, said in a language the server speaks. This is the
    // assertion that rots the moment the protocol changes under it, which is
    // exactly why it is written down.
    expect(sent.length).toBeGreaterThan(0);
    for (const frame of sent) expect(parseClientMessage(frame)).not.toBeNull();
    expect(typesOf(sent)).toContain("step");
  });

  it("takes a blind step into a cell it has no route to", async () => {
    // Off the end of the field: `walk_to` cannot resolve a floor there and would
    // refuse, which is the whole reason `step` exists beside it.
    const { body, sent } = await joinBot("bot");
    const runner = new BotRunner({
      body,
      model: scripted([[{ tool: "step", direction: "e" }]]),
      log: () => {},
    });

    await settle(runner, body);
    await runner.decideOnce();
    await frames(runner, WALK_DURATION_MS * 3);

    expect(await serverCellOf("bot")).toBe("1,0");
    for (const frame of sent) expect(parseClientMessage(frame)).not.toBeNull();
  });

  it("speaks, and a slash is a command rather than speech", async () => {
    const { body, sent } = await joinBot("bot");
    const runner = new BotRunner({
      body,
      model: scripted([
        [{ tool: "say", text: "is anybody there" }],
        [{ tool: "say", text: "/mastery blade 10" }],
      ]),
      log: () => {},
    });

    await settle(runner, body);
    await runner.decideOnce();
    await runner.decideOnce();
    await frames(runner, BOT_FRAME_MS * 4);

    for (const frame of sent) expect(parseClientMessage(frame)).not.toBeNull();
    expect(typesOf(sent)).toContain("say");
    expect(typesOf(sent)).toContain("command");
  });

  it("applies one call a decision, whatever the model asked for", async () => {
    const { body, sent } = await joinBot("bot");
    const runner = new BotRunner({
      body,
      model: scripted([
        [
          { tool: "say", text: "one" },
          { tool: "say", text: "two" },
          { tool: "say", text: "three" },
          { tool: "say", text: "four" },
        ],
      ]),
      log: () => {},
    });

    await settle(runner, body);
    await runner.decideOnce();

    const said = sent
      .map((frame) => JSON.parse(frame) as { type: string; text?: string })
      .filter((message) => message.type === "say")
      .map((message) => message.text);
    // A decision is answered blind — no result comes back inline — so more than
    // one call is a model hedging rather than a model doing several things.
    // @see MAX_CALLS_PER_DECISION
    expect(said).toEqual(["one"]);
  });

  it("tells the model what the world said about its last decision", async () => {
    const { body } = await joinBot("bot");
    const runner = new BotRunner({
      body,
      // Nowhere near the field, so there is no route and the controller says so.
      model: scripted([[{ tool: "walk_to", x: 40, y: 40 }]]),
      log: () => {},
    });

    await settle(runner, body);
    await runner.decideOnce();
    await frames(runner, BOT_FRAME_MS * 4);

    const events = body.view().events;
    expect(events.some((line) => line.includes("(40, 40)"))).toBe(true);
    expect(events.length).toBeGreaterThan(1);
  });

  it("still knows what it said two decisions after the log dropped it", async () => {
    // The bug this is about: `body.view` drains the event log, so without a
    // memory the bot has no evidence by the third decision that it ever spoke —
    // and in a live run it asked the same person the same question three times
    // in three seconds, at an identical prompt digest each time.
    const { body } = await joinBot("bot");
    const prompts: string[] = [];
    const runner = new BotRunner({
      body,
      model: scripted(
        [
          // One call a decision, so the goal and the question are two of them.
          // @see MAX_CALLS_PER_DECISION
          [{ tool: "set_goal", text: "find out who lives here" }],
          [{ tool: "say", text: "What are you doing here, Ivory Anteater?" }],
          [{ tool: "step", direction: "n" }],
          [{ tool: "step", direction: "s" }],
        ],
        prompts,
      ),
      log: () => {},
    });

    await settle(runner, body);
    for (let i = 0; i < 4; i++) {
      await runner.decideOnce();
      await frames(runner, BOT_FRAME_MS * 2);
    }

    // Nothing of it in the first prompt, which is what a memory is for.
    expect(prompts[0]).not.toContain("Ivory Anteater");
    // The fourth: it was said in the second, so by here the event log has long
    // since drained it and only the memory is still carrying it. The third
    // prompt would hold it twice and honestly — once remembered, once as an
    // event of the decision just gone — which is not what this is about.
    const later = prompts[3]!;
    expect(later).toContain("Ivory Anteater");
    expect(later).toContain("find out who lives here");
    // And what it said is written down once, not once per place it arrived from.
    expect(later.split("Ivory Anteater?")).toHaveLength(2);
    // Each line behind the world's own clock, which is what replaced counting
    // back in turns. `body.minutesOfDay` is the source, so this is also the
    // check that a real body has one.
    expect(later).toMatch(/\n\d\d:\d\d {2}You said: What are you doing here,/);
  });

  it("sends nothing to the world for a goal", async () => {
    const { body, sent } = await joinBot("bot");
    const runner = new BotRunner({
      body,
      model: scripted([[{ tool: "set_goal", text: "find the shop" }]]),
      log: () => {},
    });

    await settle(runner, body);
    const before = sent.length;
    await runner.decideOnce();
    await frames(runner, BOT_FRAME_MS * 2);

    expect(sent.slice(before)).toEqual([]);
  });

  it("logs a line per decision", async () => {
    const { body } = await joinBot("bot");
    const lines: BotDecisionLog[] = [];
    const runner = new BotRunner({
      body,
      model: scripted([[{ tool: "step", direction: "n" }]]),
      log: (line) => lines.push(line),
    });

    await settle(runner, body);
    await runner.decideOnce();

    expect(lines).toHaveLength(1);
    expect(lines[0]!.calls).toEqual([{ tool: "step", direction: "n" }]);
    expect(lines[0]!.inputTokens).toBe(100);
    expect(lines[0]!.promptChars).toBeGreaterThan(0);
    expect(lines[0]!.promptDigest).toMatch(/^[0-9a-f]{8}$/);
  });

  it("parks after enough consecutive provider failures, and stops asking", async () => {
    const { body } = await joinBot("bot");
    let clock = 0;
    const runner = new BotRunner({
      body,
      model: failing(),
      limits: { ...DEFAULT_BOT_LIMITS, failureLimit: 3 },
      // Far enough ahead each time to clear the backoff the last failure set,
      // so what parks the bot is the count of failures and not the clock.
      now: () => (clock += 120_000),
      log: () => {},
    });

    await settle(runner, body);
    for (let i = 0; i < 3; i++) expect(await runner.decideOnce()).toBe(false);

    expect(runner.parked).toBe(true);
    expect(await runner.decideOnce()).toBe(false);
  });
});

describe("the guards", () => {
  it("holds a bot to its decisions per minute", () => {
    const guard = new DecisionGuard({
      ...DEFAULT_BOT_LIMITS,
      maxDecisionsPerMinute: 2,
    });

    guard.noteStart(0);
    guard.noteStart(10_000);

    expect(guard.waitMs(10_000)).toBe(50_000);
    // Once the oldest falls out of the window there is room again, and the wait
    // is exactly how long that took rather than a fixed sleep.
    expect(guard.waitMs(60_001)).toBe(0);
  });

  it("backs off further with each consecutive failure, and recovers", () => {
    const guard = new DecisionGuard({
      ...DEFAULT_BOT_LIMITS,
      backoffBaseMs: 1_000,
      backoffMaxMs: 4_000,
    });

    guard.noteFailure(0);
    expect(guard.waitMs(0)).toBe(1_000);
    guard.noteFailure(0);
    expect(guard.waitMs(0)).toBe(2_000);
    guard.noteFailure(0);
    expect(guard.waitMs(0)).toBe(4_000);
    // Capped, rather than doubling towards an hour.
    guard.noteFailure(0);
    expect(guard.waitMs(0)).toBe(4_000);

    guard.noteSuccess();
    expect(guard.waitMs(0)).toBe(0);
  });

  it("parks a bot for good after the failure limit", () => {
    const guard = new DecisionGuard({ ...DEFAULT_BOT_LIMITS, failureLimit: 2 });

    guard.noteFailure(0);
    expect(guard.parked).toBe(false);
    guard.noteFailure(0);

    expect(guard.parked).toBe(true);
    expect(guard.waitMs(1_000_000)).toBe(Number.POSITIVE_INFINITY);
  });
});

function typesOf(frames: string[]): string[] {
  return frames.map((frame) => (JSON.parse(frame) as { type: string }).type);
}

/**
 * Tick until the bot may decide.
 *
 * What `BotRunner.run` does on its own before the first decision, and every case
 * below has to do it too: see `./body`'s `isSettled` for what a bot that acts on
 * the frame it joins gets wrong.
 */
async function settle(runner: BotRunner, body: BotBody) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (!body.isSettled()) {
    if (Date.now() > deadline) throw new Error("never settled");
    await frames(runner, BOT_FRAME_MS * 2);
  }
}

/** Drive the body's own clock for a while, letting the world tick beside it. */
async function frames(runner: BotRunner, ms: number) {
  const end = Date.now() + ms;
  let last = Date.now();
  while (Date.now() < end) {
    await wait(BOT_FRAME_MS);
    const now = Date.now();
    runner.tick(now - last);
    last = now;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (ready()) return;
    await wait(5);
  }
  throw new Error("gave up waiting");
}

function nextMessageOfType(
  ws: TestSocket,
  type: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: { data: string }) => {
      const message = JSON.parse(event.data) as Record<string, unknown>;
      if (message.type !== type) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(message);
    };
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error(`no ${type} message`));
    }, TIMEOUT_MS);
    ws.addEventListener("message", onMessage);
  });
}
