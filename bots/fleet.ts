import { randomCharacterName } from "../app/lib/randomCharacterName";
import { MAX_USERNAME_LENGTH } from "../app/lib/account";
import { RATING_GLYPH } from "../app/lib/mastery";
import { tilesByIdFromList } from "../app/lib/validation";
import { RemoteSession } from "../app/net/RemoteSession";
import { CLOSE_OUTDATED_CLIENT, CLOSE_REPLACED } from "../app/net/protocol";
import type { ClientSocket } from "../app/net/socket";
import { Refused, takeSeat, type BotAccount } from "./account";
import { openaiPlanner } from "./LlmPlanner";
import { Bot } from "./Bot";
import type { Goal } from "./goals";
import type { Landmarks } from "./memory";
import { ProgressPlanner, type Planner } from "./planner";
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

/**
 * A server on another protocol turns the bot away until one side is
 * deployed again. Production runs release tags and a bot may run from `main`,
 * so either side can be the newer, and the bot waits for the other rather
 * than exiting.
 */
const OUTDATED_RETRY_MS = 60_000;

/**
 * A server starts all its bots at once, and bots that join in the same
 * second walk out of the tutorial in a line. Each waits up to this long first.
 */
const START_JITTER_MS = 20_000;

/** A generated name somebody already has is drawn again, this many times. */
export const NAME_ATTEMPTS = 8;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Each bot is a seat that this many characters take turns at, so the hours a
 * bot plays are spread over several characters rather than levelling one
 * without end.
 */
export const ROSTER_SIZE = 4;

/** How long one character plays before it signs off and another takes the seat. */
const SESSION_MIN_MS = HOUR_MS;
const SESSION_MAX_MS = 3 * HOUR_MS;

/** How long a seat stays empty between one character signing off and the next signing in. */
const BREAK_MIN_MS = MINUTE_MS;
const BREAK_MAX_MS = 10 * MINUTE_MS;

const CLOSE_NORMAL = 1000;

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
  /** The fleet's memory file, one per world, since every world is laid out differently. */
  readonly memory: string;
  /** Without one, bots play the scripted goals and never speak. */
  readonly openaiApiKey: string | null;
};

/** What every bot does first, before it plays for gear: the tutorial's rewards, then the surface. */
const OPENING: readonly Goal[] = [{ goal: "open_rewards" }, { goal: "reach_level", level: 0 }];

/**
 * The account of character `member` of bot `index`'s roster: a name from the
 * game's own generator, seeded by the index, the member and the attempt, so
 * the same seat signs in as the same characters on every run and a name
 * somebody already took is drawn again. Member 0 keeps the seed bots had
 * before rosters, so the characters already in a world stay in play.
 */
export function accountFor(
  index: number,
  member: number,
  attempt: number,
  password: string,
): BotAccount {
  const seed = member === 0 ? `bot-${index}-${attempt}` : `bot-${index}-${member}-${attempt}`;
  const character = randomCharacterName(seededRandom(seed));
  const letters = character.replace(/[^A-Za-z]/g, "").toLowerCase();
  const username = `${letters.slice(0, MAX_USERNAME_LENGTH - 3)}bot`;
  return { username, password, character };
}

async function play(
  fleet: FleetConfig,
  account: BotAccount,
  landmarks: Landmarks,
  logLine: (line: string) => void,
  endsAtMs: number,
): Promise<"again" | "outdated" | "stop" | "done"> {
  const { base, origin } = fleet;
  const seat = await takeSeat(base, origin, account);
  const socket = new BunWebSocket(seat.socketUrl, {
    headers: { Cookie: seat.cookie, Origin: origin },
  });
  const remote = new RemoteSession(socket, seat.tiles, seat.statusDefs);
  const log = (line: string) => logLine(`${standing(remote)} ${line}`);
  const temperament = drawTemperament(seededRandom(account.character));
  log(`plays ${temperament.style}`);
  const progress = new ProgressPlanner(OPENING);
  const planner: Planner = fleet.openaiApiKey
    ? openaiPlanner(fleet.openaiApiKey, progress, log)
    : progress;
  const bot = new Bot(remote, planner, tilesByIdFromList(seat.tiles), seat.statusDefs, {
    log,
    temperament,
    landmarks,
  });

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

  let signedOff = false;
  const shift = setTimeout(
    () => {
      signedOff = true;
      log("signs off");
      socket.close(CLOSE_NORMAL);
    },
    Math.max(0, endsAtMs - Date.now()),
  );

  return new Promise((resolve) => {
    socket.addEventListener("close", (event) => {
      clearInterval(frame);
      clearTimeout(shift);
      remote.dispose();
      log(`socket closed: ${event.code} ${event.reason}`);
      resolve(signedOff ? "done" : closing(event.code));
    });
  });
}

function closing(code: number): "again" | "outdated" | "stop" {
  if (code === CLOSE_REPLACED) return "stop";
  if (code === CLOSE_OUTDATED_CLIENT) return "outdated";
  return "again";
}

/**
 * The bot's health, rating and cell, put on every line it logs so that a
 * night's log can be read for how hurt a bot was and where, not only what it
 * did. A bot that is dead or not yet placed has no body to read.
 */
function standing(remote: RemoteSession): string {
  const self = remote.selfSnapshot();
  if (!self) return "-";
  const rating = self.rating === null ? "" : ` ${RATING_GLYPH}${self.rating}`;
  return `hp ${self.hp ?? "?"}/${self.maxHp ?? "?"}${rating} at ${self.x},${self.y},${self.z}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A roster member other than `last` whose names are not all taken, or `last`
 * when it is the only one left, or null when none is.
 */
export function nextMember(
  random: () => number,
  attempts: readonly number[],
  last: number | null,
): number | null {
  const usable = attempts.flatMap((tried, member) => (tried < NAME_ATTEMPTS ? [member] : []));
  const others = usable.filter((member) => member !== last);
  const pool = others.length ? others : usable;
  return pool[Math.floor(random() * pool.length)] ?? null;
}

/**
 * Plays roster member `member` of bot `index` for one session, between
 * `SESSION_MIN_MS` and `SESSION_MAX_MS`, signing in again after every
 * disconnection until the session is over. A name refused by the server
 * counts against the member in `attempts`.
 */
async function playSession(
  fleet: FleetConfig,
  index: number,
  member: number,
  attempts: number[],
  landmarks: Landmarks,
): Promise<"done" | "stop"> {
  const endsAtMs = Date.now() + between(Math.random, SESSION_MIN_MS, SESSION_MAX_MS);
  while (attempts[member]! < NAME_ATTEMPTS) {
    const account = accountFor(index, member, attempts[member]!, fleet.password);
    const log = (line: string) =>
      console.log(`${new Date().toISOString()} [${account.character}] ${line}`);
    let waitMs = RECONNECT_MS;
    try {
      const ended = await play(fleet, account, landmarks, log, endsAtMs);
      if (ended === "stop" || ended === "done") return ended;
      if (ended === "outdated") waitMs = OUTDATED_RETRY_MS;
    } catch (error) {
      log(String(error));
      if (error instanceof Refused) attempts[member]!++;
    }
    if (Date.now() >= endsAtMs) return "done";
    await sleep(waitMs);
  }
  return "done";
}

/**
 * Plays bot `index` until the server replaces it: one roster member per
 * session, a break of between `BREAK_MIN_MS` and `BREAK_MAX_MS`, then a
 * different member.
 */
export async function runBot(fleet: FleetConfig, index: number, landmarks: Landmarks) {
  await sleep(between(Math.random, 0, START_JITTER_MS));
  const attempts = Array.from({ length: ROSTER_SIZE }, () => 0);
  let member: number | null = null;
  for (;;) {
    member = nextMember(Math.random, attempts, member);
    if (member === null) {
      console.error(`[bots] bot ${index} found no name to play under`);
      return;
    }
    if ((await playSession(fleet, index, member, attempts, landmarks)) === "stop") return;
    await sleep(between(Math.random, BREAK_MIN_MS, BREAK_MAX_MS));
  }
}
