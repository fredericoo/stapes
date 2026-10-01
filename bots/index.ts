import { tilesByIdFromList } from "../app/lib/validation";
import { RemoteSession } from "../app/net/RemoteSession";
import type { ClientSocket } from "../app/net/socket";
import { takeSeat, type BotAccount } from "./account";
import { Bot } from "./Bot";
import type { Goal } from "./goals";
import { ScriptedPlanner } from "./planner";

const FRAME_MS = 50;

const RECONNECT_MS = 5_000;

const CLOSE_OUTDATED = 4001;

const CLOSE_REPLACED = 4002;

/**
 * Bun's `WebSocket` takes request headers, which is how the session cookie
 * reaches the upgrade; the DOM type this project compiles against does not
 * know the option.
 */
const BunWebSocket = WebSocket as unknown as new (
  url: string,
  options: { headers: Record<string, string> },
) => ClientSocket;

const env = process.env;
const base = env.STAPES_URL ?? "http://localhost:3000";
const origin = env.STAPES_ORIGIN ?? base;
const account: BotAccount = {
  username: env.BOT_USERNAME ?? "wandererbot",
  password: env.BOT_PASSWORD ?? "wanderer-bot-password",
  character: env.BOT_CHARACTER ?? "Wanderer",
};

function log(line: string) {
  console.log(`[${account.character}] ${line}`);
}

const GOALS: readonly Goal[] = [
  { goal: "open_rewards" },
  { goal: "reach_level", level: 0 },
  { goal: "explore" },
];

async function play(): Promise<"again" | "stop"> {
  const seat = await takeSeat(base, origin, account);
  const socket = new BunWebSocket(seat.socketUrl, {
    headers: { Cookie: seat.cookie, Origin: origin },
  });
  const remote = new RemoteSession(socket, seat.tiles, seat.statusDefs);
  const bot = new Bot(
    remote,
    new ScriptedPlanner(GOALS),
    tilesByIdFromList(seat.tiles),
    seat.statusDefs,
    log,
  );

  let last = performance.now();
  const frame = setInterval(() => {
    const now = performance.now();
    remote.update(now - last);
    last = now;
    if (remote.isReady()) bot.act(now);
  }, FRAME_MS);

  return new Promise((resolve) => {
    socket.addEventListener("close", (event) => {
      clearInterval(frame);
      remote.dispose();
      log(`socket closed: ${event.code} ${event.reason}`);
      resolve(event.code === CLOSE_REPLACED || event.code === CLOSE_OUTDATED ? "stop" : "again");
    });
  });
}

for (;;) {
  try {
    if ((await play()) === "stop") break;
  } catch (error) {
    log(String(error));
  }
  await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
}
