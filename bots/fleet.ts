import { randomCharacterName } from "../app/lib/randomCharacterName";
import { MAX_USERNAME_LENGTH } from "../app/lib/account";
import { tilesByIdFromList } from "../app/lib/validation";
import { RemoteSession } from "../app/net/RemoteSession";
import type { ClientSocket } from "../app/net/socket";
import { takeSeat, type BotAccount } from "./account";
import { Bot } from "./Bot";
import type { Goal } from "./goals";
import { ScriptedPlanner } from "./planner";
import { between, drawTemperament, seededRandom } from "./temperament";

/** How often the client state is advanced, which keeps prediction smooth. */
const FRAME_MS = 50;

/**
 * How often a bot decides. Steering runs every frame (`Bot.steer`); deciding
 * reads every body in view and searches for routes, and ten bots that decided
 * every 50ms kept four cores busy.
 */
const DECIDE_MS = 200;

const RECONNECT_MS = 5_000;

const CLOSE_OUTDATED = 4001;

const CLOSE_REPLACED = 4002;

/**
 * A server starts all its bots at once, and bots that join in the same
 * second walk out of the tutorial in a line. Each waits up to this long first.
 */
const START_JITTER_MS = 20_000;

/** A generated name somebody already has is drawn again, this many times. */
const NAME_ATTEMPTS = 8;

/**
 * Bun's `WebSocket` takes request headers, which is how the session cookie
 * reaches the upgrade; the DOM type this project compiles against does not
 * know the option.
 */
const BunWebSocket = WebSocket as unknown as new (
  url: string,
  options: { headers: Record<string, string> },
) => ClientSocket;

/** Where a fleet of bots plays, and as whom. */
export type FleetConfig = {
  /** Where requests go. */
  readonly base: string;
  /** What requests claim to come from, which a deployed server checks. */
  readonly origin: string;
  readonly password: string;
};

const GOALS: readonly Goal[] = [
  { goal: "open_rewards" },
  { goal: "reach_level", level: 0 },
  { goal: "hunt" },
];

/**
 * Bot `index`'s account: a name from the game's own generator, seeded by the
 * index and the attempt, so the same bot signs in as the same character on
 * every run and a name somebody already took is drawn again.
 */
function accountFor(index: number, attempt: number, password: string): BotAccount {
  const character = randomCharacterName(seededRandom(`bot-${index}-${attempt}`));
  const letters = character.replace(/[^A-Za-z]/g, "").toLowerCase();
  const username = `${letters.slice(0, MAX_USERNAME_LENGTH - 3)}bot`;
  return { username, password, character };
}

/** A refusal about the account or the name, rather than the world being down. */
function refused(error: unknown): boolean {
  return /could not (create|sign in or sign up)/.test(String(error));
}

async function play(
  fleet: FleetConfig,
  account: BotAccount,
  log: (line: string) => void,
): Promise<"again" | "stop"> {
  const { base, origin } = fleet;
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
    Math.random,
    drawTemperament(seededRandom(account.character)),
  );

  let last = performance.now();
  let decidedAt = last - between(Math.random, 0, DECIDE_MS);
  const frame = setInterval(() => {
    const now = performance.now();
    remote.update(now - last);
    last = now;
    if (!remote.isReady()) return;
    bot.steer(now);
    if (now - decidedAt < DECIDE_MS) return;
    decidedAt = now;
    bot.act(now);
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

/**
 * Plays bot `index` until the server replaces or outdates it, signing in again
 * after every other disconnection.
 */
export async function runBot(fleet: FleetConfig, index: number) {
  await new Promise((resolve) => setTimeout(resolve, between(Math.random, 0, START_JITTER_MS)));
  for (let attempt = 0; attempt < NAME_ATTEMPTS;) {
    const account = accountFor(index, attempt, fleet.password);
    const log = (line: string) => console.log(`[${account.character}] ${line}`);
    try {
      if ((await play(fleet, account, log)) === "stop") return;
    } catch (error) {
      log(String(error));
      if (refused(error)) attempt++;
    }
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
  }
  console.error(`[bots] bot ${index} found no name to play under`);
}
