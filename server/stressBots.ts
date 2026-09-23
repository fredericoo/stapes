import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { WALK_DURATION_MS } from "../app/game/constants";
import {
  CHARACTER_PARAM,
  CLOSE_MAINTENANCE,
  CLOSE_OUTDATED_CLIENT,
  CLOSE_REPLACED,
  CLOSE_SIGNED_OUT,
  GAME_SOCKET_PATH,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_PARAM,
  type MotionEvent,
} from "../app/net/protocol";

/**
 * Accounts and characters that play a world over its real socket, so an
 * administrator can find out how many players it holds before real ones arrive.
 *
 * **They run in this process and play another one.** The target is a URL, and
 * the default is production: the bots are meant to run from a pull request's
 * preview and load the world everybody plays, over the internet, the way a
 * browser does. Nothing is simulated on the target's side — each bot is an
 * account made through `/api/account`, a character made through
 * `/api/characters`, and a socket opened with the session cookie, so the target
 * pays for sign-in, seating, interest and patches exactly as it would for a
 * person.
 *
 * **Everything that names a bot is derived from its number.** Bot 7 is always
 * `stressbot_0007` with the same password and the same character, so raising
 * the count from 10 to 20 signs ten more in and leaves the first ten alone, and
 * lowering it to 0 and back reuses every account instead of making new ones.
 */

/** The world the bots play unless `STRESS_TARGET_ORIGIN` says otherwise. */
export const DEFAULT_STRESS_TARGET = "https://stapes.frederic.ooo";

/** The most bots one process will run. Set well above the 100 a test is expected to reach. */
export const MAX_STRESS_BOTS = 500;

/**
 * The gap between two bots starting.
 *
 * A browser does not arrive in the same millisecond as ninety others, and a
 * `hello` is the largest message the world sends. Starting the whole count at
 * once would measure one burst of joins rather than the world holding that
 * many players.
 */
const START_SPACING_MS = 250;

/**
 * The gap between two sign-ins, across every bot.
 *
 * Better Auth allows three sign-ins per ten seconds from one address, and every
 * bot comes from this one. Four seconds keeps under that with room for a real
 * player behind the same limiter — when the target cannot see client addresses,
 * the limiter puts everybody in one bucket. Sign-up is not limited this way, so
 * a bot's first run does not wait here; only an account that already exists and
 * has no stored session does.
 */
const SIGN_IN_SPACING_MS = 4_000;

/** How long a step may go unanswered before the bot stops waiting for it. */
const STEP_TIMEOUT_MS = 3_000;

/** How long a dead bot lies there before asking to come back. */
const REBIRTH_DELAY_MS = 3_000;

/** How long a bot waits before trying a world that is closed for maintenance. */
const MAINTENANCE_RETRY_MS = 30_000;

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** How many of the most recent step and join timings the percentiles are taken over. */
const TIMING_SAMPLES = 1_000;

/** Only step timings younger than this count, so the figure follows the load as it changes. */
const STEP_WINDOW_MS = 30_000;

/** How often throughput is sampled and the target's health is asked. */
const SAMPLE_INTERVAL_MS = 5_000;

// ---- identity ---------------------------------------------------------------

export type BotIdentity = {
  index: number;
  username: string;
  email: string;
  password: string;
  characterName: string;
};

/**
 * Bot `index` as letters, three of them: 1 is `aab`, 26 is `aba`.
 *
 * A character name is letters only (`app/lib/characterName.ts`), so the number
 * cannot appear in it as digits. Three letters is 17,576 names, which is more
 * than {@link MAX_STRESS_BOTS} will ever ask for.
 */
function letters(index: number): string {
  let rest = index;
  let out = "";
  for (let i = 0; i < 3; i++) {
    out = String.fromCharCode(97 + (rest % 26)) + out;
    rest = Math.floor(rest / 26);
  }
  return out;
}

/**
 * Who bot `index` is, the same on every call and in every process.
 *
 * The password is an HMAC of the username under `secret`, so it is fixed for a
 * given secret without being written in this file. Anybody who reads the
 * repository still knows the default secret; set `STRESS_BOT_SECRET` on the
 * process that runs the bots if the target is one where that matters. Changing
 * it later locks the bots out of the accounts they already made.
 */
export async function botIdentity(index: number, secret: string): Promise<BotIdentity> {
  const username = `stressbot_${String(index).padStart(4, "0")}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(username)),
  );
  const password = Buffer.from(mac).toString("base64url").slice(0, 24);
  return {
    index,
    username,
    // `.invalid` for the reason the seeded administrator's is: nothing can be
    // sent there by mistake. @see `./auth`
    email: `${username}@stress.invalid`,
    password,
    characterName: `Stressbot${letters(index)}`,
  };
}

// ---- cookies ----------------------------------------------------------------

/** `name=value` pairs, merged from every `Set-Cookie` a bot has been sent. */
class CookieJar {
  private readonly values = new Map<string, string>();

  constructor(serialized?: string) {
    for (const pair of serialized?.split("; ") ?? []) {
      const at = pair.indexOf("=");
      if (at > 0) this.values.set(pair.slice(0, at), pair.slice(at + 1));
    }
  }

  take(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";", 1)[0]!;
      const at = pair.indexOf("=");
      if (at <= 0) continue;
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      // A cookie cleared by the server comes back empty, or already expired.
      if (value === "" || /max-age=0/i.test(line)) this.values.delete(name);
      else this.values.set(name, value);
    }
  }

  get empty(): boolean {
    return this.values.size === 0;
  }

  toString(): string {
    return [...this.values].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

// ---- sessions kept between restarts -------------------------------------------

type StoredSession = { cookie: string; characterId: string };

/**
 * Each bot's cookie and character id, in a JSON file beside the database.
 *
 * Kept so a redeploy of the process running the bots does not sign a hundred
 * accounts in again: at {@link SIGN_IN_SPACING_MS} that is seven minutes before
 * the last one is back. A file rather than a table, because it belongs to this
 * feature and not to the world, and losing it only costs that wait.
 */
class SessionFile {
  private sessions: Record<string, StoredSession> = {};
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path: string | null) {}

  async load(): Promise<void> {
    if (!this.path) return;
    try {
      this.sessions = JSON.parse(await readFile(this.path, "utf8")) as Record<
        string,
        StoredSession
      >;
    } catch {
      this.sessions = {};
    }
  }

  get(username: string): StoredSession | undefined {
    return this.sessions[username];
  }

  set(username: string, session: StoredSession | null): void {
    if (session) this.sessions[username] = session;
    else delete this.sessions[username];
    const path = this.path;
    if (!path) return;
    const body = JSON.stringify(this.sessions);
    this.writing = this.writing
      .then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(`${path}.tmp`, body);
        await rename(`${path}.tmp`, path);
      })
      .catch((error: unknown) => console.error("[stress] could not store sessions", error));
  }
}

// ---- timing -------------------------------------------------------------------

/** The most recent {@link TIMING_SAMPLES} durations, each with when it was taken. */
class Samples {
  private readonly values: { at: number; ms: number }[] = [];

  add(ms: number, at = Date.now()): void {
    this.values.push({ at, ms });
    if (this.values.length > TIMING_SAMPLES) this.values.shift();
  }

  /** p50 and p95 of the samples younger than `windowMs`, or null when there are none. */
  percentiles(
    windowMs = Infinity,
    now = Date.now(),
  ): { p50: number; p95: number; n: number } | null {
    const recent = this.values
      .filter((sample) => now - sample.at <= windowMs)
      .map((sample) => sample.ms)
      .sort((a, b) => a - b);
    if (recent.length === 0) return null;
    const at = (q: number) => recent[Math.min(recent.length - 1, Math.floor(q * recent.length))]!;
    return { p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), n: recent.length };
  }
}

// ---- one bot --------------------------------------------------------------------

export type BotState =
  /** Waiting for its turn to start, or for a retry. */
  | "waiting"
  /** Signing in, or making its account or character. */
  | "account"
  /** Socket open, `hello` not yet arrived. */
  | "joining"
  /** In the world and walking. */
  | "walking"
  /** Killed, and about to ask for a rebirth. */
  | "dead"
  /** Gave up; applying the count again retries it. */
  | "failed";

type Direction = "n" | "e" | "s" | "w";
const DIRECTIONS: readonly Direction[] = ["n", "e", "s", "w"];

/** What a bot needs from the manager that runs it. */
type BotHost = {
  target: string;
  sessions: SessionFile;
  /** Resolves when it is this bot's turn to sign in. @see SIGN_IN_SPACING_MS */
  signInTurn(): Promise<void>;
  stepTimings: Samples;
  joinTimings: Samples;
  counters: { bytesIn: number; messagesIn: number; stepsSent: number };
  /** Called with the version the target said it speaks, when it refuses ours. */
  outdated(serverVersion: number | null): void;
};

class AccountError extends Error {}

/**
 * One account playing one character, from sign-in to walking about.
 *
 * **It walks the way a person with a keyboard does**: a direction held for a
 * few cells, a pause now and then, and a new direction when a wall refuses it.
 * It does not read the map. The world decides whether each step is allowed and
 * says so, which is also the answer a browser gets — a step into a wall costs
 * the target the same check either way.
 *
 * **One step in flight at a time.** The next is sent when the world confirms
 * the last with a `walkStarted` for this body, or refuses it, and the time
 * between sending and hearing is recorded. That time is the step latency a
 * player would feel, and it is the number that says whether the world is
 * keeping up.
 */
class Bot {
  state: BotState = "waiting";
  lastError: string | null = null;
  reconnects = 0;
  stepsRejected = 0;
  stepsTimedOut = 0;

  private stopped = true;
  /** Bumped on every start, so a sign-in still in flight from a previous run can tell it is stale. */
  private generation = 0;
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stepTimer: ReturnType<typeof setTimeout> | null = null;
  private jar: CookieJar | null = null;
  private characterId: string | null = null;
  private backoffMs = RECONNECT_MIN_MS;
  private signedOutInARow = 0;

  private seq = 0;
  private pending: { seq: number; sentAt: number } | null = null;
  private direction: Direction = "s";
  private runLeft = 0;
  /** When the socket was opened, until its first `hello` is timed against it. */
  private openedAt: number | null = null;

  constructor(
    readonly identity: BotIdentity,
    private readonly host: BotHost,
  ) {
    const stored = host.sessions.get(identity.username);
    if (stored) {
      this.jar = new CookieJar(stored.cookie);
      this.characterId = stored.characterId;
    }
  }

  /** Whether this bot is meant to be playing: started, and not stopped or given up since. */
  get running(): boolean {
    return !this.stopped && this.state !== "failed";
  }

  start(delayMs: number): void {
    this.stopped = false;
    this.generation++;
    this.lastError = null;
    this.state = "waiting";
    this.signedOutInARow = 0;
    this.backoffMs = RECONNECT_MIN_MS;
    this.later(delayMs, () => void this.connect());
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.state = "waiting";
    const socket = this.socket;
    this.socket = null;
    // 1000 is a tab closed on purpose; the target takes the body off the board
    // as it would for anybody leaving.
    socket?.close(1000, "stress test lowered");
  }

  /** Stop, and say why, so the manager shows it and a new count restarts it. */
  halt(reason: string): void {
    this.stop();
    this.state = "failed";
    this.lastError = reason;
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.stepTimer) clearTimeout(this.stepTimer);
    this.timer = null;
    this.stepTimer = null;
  }

  private later(ms: number, run: () => void): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopped) run();
    }, ms);
  }

  private fail(reason: string): void {
    this.lastError = reason;
    this.state = "failed";
    this.clearTimers();
  }

  private retry(reason: string, ms = this.nextBackoff()): void {
    this.lastError = reason;
    this.state = "waiting";
    this.reconnects++;
    this.later(ms, () => void this.connect());
  }

  private nextBackoff(): number {
    const ms = this.backoffMs * (0.5 + Math.random());
    this.backoffMs = Math.min(RECONNECT_MAX_MS, this.backoffMs * 2);
    return ms;
  }

  // ---- account ---------------------------------------------------------------

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    // Better Auth refuses a post whose origin is not the target's own. A bot
    // is a browser on that page as far as the target is concerned.
    headers.set("Origin", this.host.target);
    if (init.body) headers.set("Content-Type", "application/json");
    if (this.jar && !this.jar.empty) headers.set("Cookie", this.jar.toString());
    const response = await fetch(`${this.host.target}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    this.jar ??= new CookieJar();
    this.jar.take(response);
    return response;
  }

  private async me(): Promise<{
    user: unknown;
    characters: { id: string; name: string }[];
  }> {
    const response = await this.request("/api/me");
    if (!response.ok) throw new Error(`/api/me answered ${response.status}`);
    return (await response.json()) as { user: unknown; characters: { id: string; name: string }[] };
  }

  /** Make the account, or sign in to it when it is already there. */
  private async signIn(): Promise<void> {
    const { username, email, password } = this.identity;
    this.jar = new CookieJar();
    const made = await this.request("/api/account", {
      method: "POST",
      body: JSON.stringify({ username, email, password }),
    });
    if (made.ok) return;

    // Taken, which after the first run is every bot. Anything else would be
    // refused the same way by the sign-in below and is reported from there.
    for (;;) {
      await this.host.signInTurn();
      if (this.stopped) return;
      this.jar = new CookieJar();
      const response = await this.request("/api/auth/sign-in/username", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      if (response.ok) return;
      if (response.status === 429) continue;
      const text = await response.text();
      throw new AccountError(`sign-in refused (${response.status}): ${text.slice(0, 200)}`);
    }
  }

  /** A signed-in session and a character id, from storage or from the target. */
  private async ensureAccount(): Promise<void> {
    if (this.jar && this.characterId) return;
    this.state = "account";

    let me = this.jar ? await this.me() : null;
    if (!me?.user) {
      await this.signIn();
      if (this.stopped) return;
      me = await this.me();
      if (!me.user) throw new AccountError("signed in, and /api/me still says nobody");
    }

    const name = this.identity.characterName;
    let character = me.characters.find((each) => each.name === name);
    if (!character) {
      const response = await this.request("/api/characters", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new AccountError(`character ${name} refused (${response.status}): ${text}`);
      }
      character = ((await response.json()) as { character: { id: string; name: string } })
        .character;
    }
    this.characterId = character.id;
    this.host.sessions.set(this.identity.username, {
      cookie: this.jar!.toString(),
      characterId: character.id,
    });
  }

  private forgetSession(): void {
    this.jar = null;
    this.characterId = null;
    this.host.sessions.set(this.identity.username, null);
  }

  // ---- socket -----------------------------------------------------------------

  private async connect(): Promise<void> {
    const generation = this.generation;
    const stale = () => this.stopped || generation !== this.generation;
    if (stale()) return;
    try {
      await this.ensureAccount();
    } catch (error) {
      if (stale()) return;
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof AccountError) this.fail(reason);
      else this.retry(reason);
      return;
    }
    if (stale()) return;

    const url = new URL(GAME_SOCKET_PATH, this.host.target);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set(PROTOCOL_VERSION_PARAM, String(PROTOCOL_VERSION));
    url.searchParams.set(CHARACTER_PARAM, this.characterId!);

    this.state = "joining";
    this.openedAt = performance.now();
    // Bun's client takes headers, which is the only way to put a cookie on the
    // upgrade from outside a browser. It negotiates permessage-deflate as a
    // browser does, so the target compresses for bots as it would for people.
    const socket = new WebSocket(url, {
      headers: { Cookie: this.jar!.toString(), Origin: this.host.target },
    } as unknown as string[]);
    this.socket = socket;

    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      this.onMessage(typeof event.data === "string" ? event.data : String(event.data));
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.onClose(event.code, event.reason);
    });
  }

  private onClose(code: number, reason: string): void {
    this.pending = null;
    if (this.stepTimer) clearTimeout(this.stepTimer);
    if (this.stopped) return;
    const said = `closed ${code}${reason ? ` (${reason})` : ""}`;

    if (code === CLOSE_OUTDATED_CLIENT) {
      this.fail(`the target speaks another protocol than v${PROTOCOL_VERSION}`);
      return;
    }
    if (code === CLOSE_REPLACED) {
      // Somebody else signed in as this bot and took the body. Fighting them
      // for it would be two connections replacing each other for ever.
      this.fail(`${said}: replaced by another connection to this character`);
      return;
    }
    if (code === CLOSE_SIGNED_OUT) {
      this.forgetSession();
      if (++this.signedOutInARow > 1) {
        this.fail(`${said}: refused twice after signing in again`);
        return;
      }
      this.retry(said, 0);
      return;
    }
    if (code === CLOSE_MAINTENANCE) {
      this.retry(`${said}: the target is closed for maintenance`, MAINTENANCE_RETRY_MS);
      return;
    }
    this.retry(said);
  }

  /**
   * Read as little of each frame as answers the bot's questions.
   *
   * Every frame starts `{"type":"…"`, so the type is sliced out rather than
   * parsed. A `hello` can be megabytes and a patch arrives thirty times a
   * second, and a hundred bots parsing all of it would make this process the
   * bottleneck the test is looking for in the other one. Only a patch naming
   * this body while a step is waiting, and the small messages, are parsed.
   */
  private onMessage(data: string): void {
    this.host.counters.bytesIn += data.length;
    this.host.counters.messagesIn++;
    const type = data.startsWith('{"type":"') ? data.slice(9, data.indexOf('"', 9)) : null;

    if (type === "hello") {
      // Only the first: the world sends another after a rebirth or a restart,
      // and timing that one from the open would count the whole visit.
      if (this.openedAt !== null) this.host.joinTimings.add(performance.now() - this.openedAt);
      this.openedAt = null;
      this.state = "walking";
      this.backoffMs = RECONNECT_MIN_MS;
      this.signedOutInARow = 0;
      this.lastError = null;
      this.pending = null;
      this.runLeft = 0;
      this.scheduleStep(500 + Math.random() * 1_500);
      return;
    }
    if (type === "patch") {
      if (this.pending && data.includes(this.characterId!)) this.readPatch(data);
      return;
    }
    if (type === "stepRejected") {
      const { seq } = JSON.parse(data) as { seq: number };
      if (this.pending?.seq !== seq) return;
      this.pending = null;
      this.stepsRejected++;
      // Walked into something. Turn, the way somebody at a keyboard would.
      this.runLeft = 0;
      this.scheduleStep(150 + Math.random() * 300);
      return;
    }
    if (type === "died") {
      this.state = "dead";
      this.pending = null;
      if (this.stepTimer) clearTimeout(this.stepTimer);
      this.stepTimer = setTimeout(() => this.send({ type: "rebirth" }), REBIRTH_DELAY_MS);
      return;
    }
    if (type === "outdated") {
      const { serverVersion } = JSON.parse(data) as { serverVersion?: number };
      this.host.outdated(serverVersion ?? null);
    }
  }

  private readPatch(data: string): void {
    const patch = JSON.parse(data) as { events?: MotionEvent[] };
    const walked = patch.events?.some(
      (event) => event.kind === "walkStarted" && event.actorId === this.characterId,
    );
    if (!walked || !this.pending) return;
    this.host.stepTimings.add(performance.now() - this.pending.sentAt);
    this.pending = null;
    // The walk takes this long on ordinary ground. Sending the next step as it
    // ends is what holding a key does.
    this.scheduleStep(WALK_DURATION_MS);
  }

  private scheduleStep(ms: number): void {
    if (this.stepTimer) clearTimeout(this.stepTimer);
    this.stepTimer = setTimeout(() => this.step(), ms);
  }

  private step(): void {
    this.stepTimer = null;
    if (this.stopped || this.state !== "walking" || this.pending) return;

    if (this.runLeft <= 0) {
      // A new heading, and sometimes a stop first: people look around.
      this.direction = DIRECTIONS[Math.floor(Math.random() * DIRECTIONS.length)]!;
      this.runLeft = 1 + Math.floor(Math.random() * 8);
      if (Math.random() < 0.3) {
        this.scheduleStep(1_000 + Math.random() * 3_000);
        this.runLeft++;
        return;
      }
    }
    this.runLeft--;

    const seq = ++this.seq;
    this.pending = { seq, sentAt: performance.now() };
    this.host.counters.stepsSent++;
    this.send({ type: "step", seq, direction: this.direction, preferDescend: false });

    this.stepTimer = setTimeout(() => {
      if (this.pending?.seq !== seq) return;
      this.pending = null;
      this.stepsTimedOut++;
      this.runLeft = 0;
      this.step();
    }, STEP_TIMEOUT_MS);
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
}

// ---- the manager ----------------------------------------------------------------

export type StressStatus = {
  target: string;
  protocolVersion: number;
  desired: number;
  max: number;
  byState: Record<BotState, number>;
  /** Decompressed characters per second received across every bot. */
  bytesInPerSecond: number;
  messagesInPerSecond: number;
  stepsPerSecond: number;
  /** Step sent to `walkStarted` seen, over the last 30 seconds. */
  stepLatencyMs: { p50: number; p95: number; n: number } | null;
  /** Socket opened to `hello` received, over the most recent joins. */
  joinMs: { p50: number; p95: number; n: number } | null;
  stepsRejected: number;
  stepsTimedOut: number;
  reconnects: number;
  /** Distinct reasons bots are waiting or failed, most common first. */
  errors: { reason: string; bots: number }[];
  /** The target's own `/api/health`, asked every five seconds. */
  health: {
    at: number;
    ok: boolean;
    responseMs: number;
    players: number | null;
    protocolVersion: number | null;
    error: string | null;
  } | null;
  /** Set when the target refused our protocol; the bots stay stopped until the count is applied again. */
  halted: string | null;
};

export type StressBotsOptions = {
  target: string;
  secret: string;
  /** Where sessions are kept between restarts, or null to keep them in memory only. */
  sessionPath: string | null;
};

/**
 * Every bot this process runs, and the count an administrator asked for.
 *
 * Bots `1..count` are running, or on their way; anything above the count is
 * stopped. Changing the count starts or stops only the difference.
 */
export class StressBots {
  readonly target: string;
  private readonly secret: string;
  private readonly sessions: SessionFile;
  private readonly bots = new Map<number, Bot>();
  private desired = 0;
  private halted: string | null = null;
  private loaded: Promise<void>;

  private readonly stepTimings = new Samples();
  private readonly joinTimings = new Samples();
  private readonly counters = { bytesIn: 0, messagesIn: 0, stepsSent: 0 };
  private lastSample = { at: Date.now(), bytesIn: 0, messagesIn: 0, stepsSent: 0 };
  private rates = { bytesIn: 0, messagesIn: 0, stepsSent: 0 };
  private health: StressStatus["health"] = null;
  private sampler: ReturnType<typeof setInterval> | null = null;

  private signInQueue: Promise<void> = Promise.resolve();

  constructor(options: StressBotsOptions) {
    this.target = options.target.replace(/\/+$/, "");
    this.secret = options.secret;
    this.sessions = new SessionFile(options.sessionPath);
    this.loaded = this.sessions.load();
  }

  private host(): BotHost {
    return {
      target: this.target,
      sessions: this.sessions,
      signInTurn: () => {
        const turn = this.signInQueue;
        this.signInQueue = turn.then(() => Bun.sleep(SIGN_IN_SPACING_MS));
        return turn;
      },
      stepTimings: this.stepTimings,
      joinTimings: this.joinTimings,
      counters: this.counters,
      outdated: (serverVersion) => {
        const reason =
          `${this.target} speaks protocol v${serverVersion ?? "?"} and these bots speak ` +
          `v${PROTOCOL_VERSION}. Merge main into this branch and redeploy it.`;
        this.halted = reason;
        for (const bot of this.bots.values()) bot.halt(reason);
      },
    };
  }

  /** Run bots `1..count`, starting the new ones a {@link START_SPACING_MS} apart. */
  async setCount(count: number): Promise<void> {
    await this.loaded;
    const next = Math.max(0, Math.min(MAX_STRESS_BOTS, Math.floor(count)));
    this.desired = next;
    this.halted = null;

    for (const [index, bot] of this.bots) {
      if (index > next) {
        bot.stop();
        this.bots.delete(index);
      }
    }

    let delay = 0;
    const host = this.host();
    for (let index = 1; index <= next; index++) {
      let bot = this.bots.get(index);
      if (bot?.running) continue;
      bot ??= new Bot(await botIdentity(index, this.secret), host);
      this.bots.set(index, bot);
      bot.start(delay);
      delay += START_SPACING_MS;
    }

    if (next > 0) this.startSampling();
    else this.stopSampling();
  }

  status(): StressStatus {
    const byState: Record<BotState, number> = {
      waiting: 0,
      account: 0,
      joining: 0,
      walking: 0,
      dead: 0,
      failed: 0,
    };
    const reasons = new Map<string, number>();
    let stepsRejected = 0;
    let stepsTimedOut = 0;
    let reconnects = 0;
    for (const bot of this.bots.values()) {
      byState[bot.state]++;
      stepsRejected += bot.stepsRejected;
      stepsTimedOut += bot.stepsTimedOut;
      reconnects += bot.reconnects;
      if (bot.lastError && (bot.state === "failed" || bot.state === "waiting")) {
        reasons.set(bot.lastError, (reasons.get(bot.lastError) ?? 0) + 1);
      }
    }
    return {
      target: this.target,
      protocolVersion: PROTOCOL_VERSION,
      desired: this.desired,
      max: MAX_STRESS_BOTS,
      byState,
      bytesInPerSecond: Math.round(this.rates.bytesIn),
      messagesInPerSecond: Math.round(this.rates.messagesIn),
      stepsPerSecond: Math.round(this.rates.stepsSent * 10) / 10,
      stepLatencyMs: this.stepTimings.percentiles(STEP_WINDOW_MS),
      joinMs: this.joinTimings.percentiles(),
      stepsRejected,
      stepsTimedOut,
      reconnects,
      errors: [...reasons]
        .map(([reason, bots]) => ({ reason, bots }))
        .sort((a, b) => b.bots - a.bots)
        .slice(0, 8),
      health: this.health,
      halted: this.halted,
    };
  }

  /** Close every socket, for a process that is shutting down. */
  stopAll(): void {
    for (const bot of this.bots.values()) bot.stop();
    this.bots.clear();
    this.desired = 0;
    this.stopSampling();
  }

  private startSampling(): void {
    if (this.sampler) return;
    this.lastSample = { at: Date.now(), ...this.counters };
    this.sampler = setInterval(() => void this.sample(), SAMPLE_INTERVAL_MS);
    void this.sample();
  }

  private stopSampling(): void {
    if (this.sampler) clearInterval(this.sampler);
    this.sampler = null;
    this.rates = { bytesIn: 0, messagesIn: 0, stepsSent: 0 };
    // Not asked again until bots run, so the last answer would go on showing
    // a player count from when they were in.
    this.health = null;
  }

  private async sample(): Promise<void> {
    const now = Date.now();
    const seconds = Math.max(0.001, (now - this.lastSample.at) / 1000);
    this.rates = {
      bytesIn: (this.counters.bytesIn - this.lastSample.bytesIn) / seconds,
      messagesIn: (this.counters.messagesIn - this.lastSample.messagesIn) / seconds,
      stepsSent: (this.counters.stepsSent - this.lastSample.stepsSent) / seconds,
    };
    this.lastSample = { at: now, ...this.counters };

    const started = performance.now();
    try {
      const response = await fetch(`${this.target}/api/health`, {
        signal: AbortSignal.timeout(SAMPLE_INTERVAL_MS),
      });
      const body = (await response.json()) as { players?: number; protocolVersion?: number };
      this.health = {
        at: Date.now(),
        ok: response.ok,
        responseMs: Math.round(performance.now() - started),
        players: body.players ?? null,
        protocolVersion: body.protocolVersion ?? null,
        error: response.ok ? null : `answered ${response.status}`,
      };
    } catch (error) {
      this.health = {
        at: Date.now(),
        ok: false,
        responseMs: Math.round(performance.now() - started),
        players: null,
        protocolVersion: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
