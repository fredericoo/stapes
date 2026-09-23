/**
 * How many players one world holds, loaded the way players load it.
 *
 * `bench:server` prices the simulation alone, with a handful of players
 * standing still. This prices the process around it: a real `GameServer` on a
 * real `WorldStore`, with N players seated through `join` exactly as a socket
 * seats them, each walking the way the stress bots walk — a run of a few
 * cells, a pause now and then, a turn when a step is refused, a rebirth three
 * seconds after dying. Everything the server does for them is on the clock:
 * the tick, each client's cut of the patch and its serialization, the message
 * path, the joins and rebirths with their `hello`, and the checkpoint flush.
 *
 *   bun scripts/bench-crowd.ts                         # 1000 players, spread, 60s
 *   bun scripts/bench-crowd.ts --players 250 --clustered
 *   bun scripts/bench-crowd.ts --deflate               # and pay for compression
 *   bun --cpu-prof scripts/bench-crowd.ts              # and say where it went
 *
 * **Spread** seats each player at a random cell of the surface, the way a
 * returning player comes back where they left; **clustered** seats everybody at
 * the spawn, which is launch day.
 *
 * **The bots run in this process**, so they are as cheap as a bot can be: a
 * frame is read no further than the type at its front, and one timer drives all
 * of them. What they cost is measured and printed, so it can be told apart from
 * what the world costs.
 *
 * `--deflate` compresses every frame of 512 characters or more as it is sent,
 * on the thread sending it, which is what `server/index.ts` asks Bun to do. It
 * is an approximation of that cost — Bun's own deflate, a fresh stream per
 * frame — rather than a measurement of the socket's.
 *
 * Reads `data/`, like `bench:server`, and never writes it: the content is
 * copied into a temporary directory first, beside the database.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataStore } from "../app/lib/dataStore";
import { listCoords, parseMap } from "../app/lib/mapData";
import { WALK_DURATION_MS } from "../app/game/constants";
import { DiskBlobs } from "../server/blobs";
import { openDatabase } from "../server/db";
import { GameServer } from "../server/GameServer";
import { GameSocket, SocketHub, type WorldContext } from "../server/sockets";
import { WorldStore } from "../server/WorldStore";

const CONTENT = ["map.json", "tiles.json", "statuses.json", "tilesets.json"];

/** The checkpoint cadence `server/config.ts` defaults to. */
const CHECKPOINT_INTERVAL_MS = 2_000;

/** The shortest frame `server/index.ts` compresses. */
const COMPRESS_MIN_LENGTH = 512;

/** How often the bots are looked at. Well under a walk, so a step is never late by much. */
const DRIVE_INTERVAL_MS = 5;

/** A dead bot lies there this long before asking to come back, as the stress bots do. */
const REBIRTH_DELAY_MS = 3_000;

type Direction = "n" | "e" | "s" | "w";
const DIRECTIONS: readonly Direction[] = ["n", "e", "s", "w"];

function argValue(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

function between(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// ---- phases -------------------------------------------------------------------

type Phase = { calls: number; ms: number };

/**
 * Time every call of one method, in place.
 *
 * Inclusive: a phase that calls another is charged for both, which is what a
 * breakdown of a tick wants — `broadcastPatch` is a line of its own and also
 * part of `tick`. An async method is charged for the part before its first
 * `await` only.
 */
function timePhase(phases: Map<string, Phase>, owner: object, name: string, label = name) {
  const target = owner as Record<string, unknown>;
  const original = target[name];
  if (typeof original !== "function") throw new Error(`nothing called ${name} to time`);
  const phase: Phase = { calls: 0, ms: 0 };
  phases.set(label, phase);
  target[name] = function (this: unknown, ...args: unknown[]) {
    const t0 = performance.now();
    try {
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    } finally {
      phase.ms += performance.now() - t0;
      phase.calls++;
    }
  };
}

function resetPhases(phases: Map<string, Phase>) {
  for (const phase of phases.values()) {
    phase.calls = 0;
    phase.ms = 0;
  }
}

/** What the tick is made of, by the names `GameServer` gives its parts. */
const SERVER_PHASES = [
  "tick",
  "applyQueuedSteps",
  "processDueRespawns",
  "collectMotionEvents",
  "flushSpawnMarks",
  "noteDeaths",
  "saveActors",
  "releaseLingerers",
  "broadcastSpeech",
  "broadcastNoise",
  "diffCells",
  "diffHps",
  "diffCarriedLights",
  "diffStatusIds",
  "diffPvp",
  "diffExtractions",
  "diffCastings",
  "broadcastPatch",
  "scopedPatchFor",
  "streamEnteredChunks",
  "announceDeaths",
  "flushEquipment",
  "flushTags",
  "flushConversations",
  "flushExtracting",
  "flushNextBlow",
  "flushNotices",
  "flushMasteries",
  "flushStatuses",
  "saveActorsIfDue",
  "sendHello",
  "queueStep",
  "rebirth",
];

/** And what the simulation's own tick is made of. */
const SESSION_PHASES = [
  "tick",
  "actorSnapshots",
  "afflictedPlacements",
  "tickStatuses",
  "tickBrains",
  "runAutoAttacks",
  "tickMotion",
  "tickStandingStatuses",
  "applyDueDecay",
  "tickAfflictions",
  "settleBoardNow",
  "spawn",
  "despawn",
];

// ---- bots ---------------------------------------------------------------------

type Counters = {
  frames: number;
  bytes: number;
  wireBytes: number;
  hellos: number;
  helloBytes: number;
  stepsSent: number;
  stepsRejected: number;
  deaths: number;
  closes: number;
};

/**
 * One player, from the socket's point of view.
 *
 * Walks like `stressBots`' bot, less the waiting: that one holds a step until
 * it sees its own `walkStarted`, which means parsing patches, and a thousand of
 * those in this process would be the bottleneck being looked for. This one
 * sends the next step as the last walk would end, which is what holding a key
 * does, and lets the world's queue and its refusals pace it.
 */
class Bot {
  state: "joining" | "walking" | "dead" = "joining";
  nextAt = Number.POSITIVE_INFINITY;
  readonly socket: GameSocket;
  private closed = false;
  private seq = 0;
  private direction: Direction = "s";
  private runLeft = 0;
  /** Every frame this bot is sent, while somebody is looking. @see `--sample` */
  recording: string[] | null = null;

  constructor(
    readonly actorId: string,
    private readonly counters: Counters,
    deflate: boolean,
  ) {
    const bot = this;
    this.socket = new GameSocket({
      send(data: string) {
        counters.frames++;
        counters.bytes += data.length;
        counters.wireBytes +=
          deflate && data.length >= COMPRESS_MIN_LENGTH
            ? Bun.deflateSync(data).length
            : data.length;
        bot.hear(data);
      },
      close() {
        bot.closed = true;
        counters.closes++;
      },
      get closed() {
        return bot.closed;
      },
    });
  }

  /** Read as little of a frame as answers the bot's questions. @see Bot */
  private hear(data: string) {
    this.recording?.push(data);
    // A patch is thirty a second and never changes what a bot does next.
    if (data.startsWith('{"type":"patch"')) return;
    if (data.startsWith('{"type":"hello"')) {
      this.counters.hellos++;
      this.counters.helloBytes += data.length;
      this.state = "walking";
      this.runLeft = 0;
      this.nextAt = performance.now() + between(500, 2_000);
      return;
    }
    if (data.startsWith('{"type":"stepRejected"')) {
      this.counters.stepsRejected++;
      // Walked into something. Turn, the way somebody at a keyboard would.
      this.runLeft = 0;
      if (this.state === "walking") this.nextAt = performance.now() + between(150, 450);
      return;
    }
    if (data.startsWith('{"type":"died"')) {
      this.counters.deaths++;
      this.state = "dead";
      this.nextAt = performance.now() + REBIRTH_DELAY_MS;
    }
  }

  /** Whatever is due, as a message for the world, or null. */
  act(now: number): string | null {
    if (this.closed || now < this.nextAt) return null;
    if (this.state === "dead") {
      // Asked once; the `hello` that answers it puts the bot back to walking.
      this.state = "joining";
      this.nextAt = Number.POSITIVE_INFINITY;
      return JSON.stringify({ type: "rebirth" });
    }
    if (this.state !== "walking") return null;

    if (this.runLeft <= 0) {
      // A new heading, and sometimes a stop first: people look around.
      this.direction = DIRECTIONS[Math.floor(Math.random() * DIRECTIONS.length)]!;
      this.runLeft = 1 + Math.floor(Math.random() * 8);
      if (Math.random() < 0.3) {
        this.nextAt = now + between(1_000, 4_000);
        return null;
      }
    }
    this.runLeft--;
    this.counters.stepsSent++;
    this.nextAt = now + WALK_DURATION_MS;
    return JSON.stringify({
      type: "step",
      seq: ++this.seq,
      direction: this.direction,
      preferDescend: false,
    });
  }
}

// ---- the world ----------------------------------------------------------------

type Options = {
  players: number;
  seconds: number;
  warmupSeconds: number;
  joinsPerSecond: number;
  clustered: boolean;
  deflate: boolean;
  /** Where to write one player's frames, if anywhere. */
  sample: string | undefined;
};

async function run(options: Options) {
  const directory = await mkdtemp(join(tmpdir(), "stapes-crowd-"));
  for (const file of CONTENT) await copyFile(join("data", file), join(directory, file));
  const db = await openDatabase(join(directory, "stapes.db"));
  const store = new WorldStore(db);
  const hub = new SocketHub();
  const context: WorldContext = {
    storage: store,
    getWebSockets: () => hub.all(),
    acceptWebSocket: (socket) => hub.accept(socket),
  };
  const server = new GameServer(context, {
    dataStore: new DataStore(new DiskBlobs(directory)),
    nameOf: async (actorId) => `Crowd${actorId.slice(0, 8)}`,
  });

  // The two loops `server/world.ts` runs beside the world, so their cost lands
  // where it does in production: between ticks, on the same thread.
  const checkpoint = setInterval(() => {
    if (store.dirty) void store.flush();
  }, CHECKPOINT_INTERVAL_MS);

  const phases = new Map<string, Phase>();
  for (const name of SERVER_PHASES) timePhase(phases, server, name, `server.${name}`);

  // Where each tick started, for the rate and the gaps between them.
  const tickStarts: number[] = [];
  const tickMs: number[] = [];
  const internals = server as unknown as { tick: () => void; session: object | null };
  const timedTick = internals.tick;
  internals.tick = function (this: unknown) {
    const t0 = performance.now();
    timedTick.call(this);
    tickStarts.push(t0);
    tickMs.push(performance.now() - t0);
  };

  // Spread: a wish for each player, somewhere on the surface. A wish is all a
  // remembered position ever is — the join bubbles out from it to the nearest
  // cell a body fits, and falls back to the spawn when nothing near does.
  const surface = options.clustered
    ? []
    : listCoords(parseMap(await Bun.file(join(directory, "map.json")).text()), 0);

  const counters: Counters = {
    frames: 0,
    bytes: 0,
    wireBytes: 0,
    hellos: 0,
    helloBytes: 0,
    stepsSent: 0,
    stepsRejected: 0,
    deaths: 0,
    closes: 0,
  };
  const bots: Bot[] = [];
  for (let i = 0; i < options.players; i++) {
    const bot = new Bot(crypto.randomUUID(), counters, options.deflate);
    if (surface.length > 0) {
      const at = surface[Math.floor(Math.random() * surface.length)]!;
      await store.put(`pos:${bot.actorId}`, {
        x: at.x,
        y: at.y,
        z: 0,
        direction: "s",
        savedAt: Date.now(),
      });
    }
    bots.push(bot);
  }

  let driveMs = 0;
  let messageMs = 0;
  const drive = async () => {
    const t0 = performance.now();
    const handling: Promise<void>[] = [];
    let spent = 0;
    for (const bot of bots) {
      const message = bot.act(t0);
      if (message === null) continue;
      const m0 = performance.now();
      handling.push(server.webSocketMessage(bot.socket, message));
      spent += performance.now() - m0;
    }
    const t1 = performance.now();
    // A step is handled without touching storage, so its whole cost is spent
    // by the time the microtasks behind these have run.
    await Promise.all(handling);
    const t2 = performance.now();
    driveMs += t1 - t0 - spent;
    messageMs += spent + (t2 - t1);
  };
  const driver = setInterval(() => void drive(), DRIVE_INTERVAL_MS);

  // Seat everybody, at the rate people arrive.
  const joinStarted = performance.now();
  const joinGapMs = 1_000 / options.joinsPerSecond;
  let sessionTimed = false;
  for (const [i, bot] of bots.entries()) {
    const due = joinStarted + i * joinGapMs;
    const wait = due - performance.now();
    if (wait > 0) await Bun.sleep(wait);
    await server.join(bot.socket, bot.actorId, { admin: false });
    if (!sessionTimed && internals.session) {
      for (const name of SESSION_PHASES) {
        timePhase(phases, internals.session, name, `session.${name}`);
      }
      sessionTimed = true;
    }
  }
  const joinSeconds = (performance.now() - joinStarted) / 1_000;
  const residents =
    (internals.session as { actorIds(): string[] } | null)!.actorIds().length - options.players;
  console.error(
    `[crowd] seated ${options.players} in ${joinSeconds.toFixed(1)}s; ` +
      `warming up ${options.warmupSeconds}s, then measuring ${options.seconds}s`,
  );

  await Bun.sleep(options.warmupSeconds * 1_000);

  // The window.
  resetPhases(phases);
  tickStarts.length = 0;
  tickMs.length = 0;
  driveMs = 0;
  messageMs = 0;
  const before = { ...counters };
  const cpuBefore = process.cpuUsage();
  const windowStart = performance.now();
  if (options.sample) {
    // One player's frames for the first two seconds of the window, to read
    // what a client is actually being sent.
    const watched = bots[0]!;
    watched.recording = [];
    await Bun.sleep(2_000);
    await Bun.write(options.sample, watched.recording.join("\n"));
    watched.recording = null;
    await Bun.sleep(Math.max(0, options.seconds * 1_000 - 2_000));
  } else {
    await Bun.sleep(options.seconds * 1_000);
  }
  const elapsedMs = performance.now() - windowStart;
  const cpu = process.cpuUsage(cpuBefore);

  clearInterval(driver);
  clearInterval(checkpoint);

  const seconds = elapsedMs / 1_000;
  const ticks = tickMs.length;
  const sortedTicks = [...tickMs].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < tickStarts.length; i++) gaps.push(tickStarts[i]! - tickStarts[i - 1]!);
  gaps.sort((a, b) => a - b);
  const delta = (key: keyof Counters) => counters[key] - before[key];
  const perPlayerPerSecond = (key: keyof Counters) => delta(key) / options.players / seconds;

  const report = {
    players: options.players,
    residents,
    scenario: options.clustered ? "clustered" : "spread",
    deflate: options.deflate,
    seconds: Number(seconds.toFixed(1)),
    ticksPerSecond: Number((ticks / seconds).toFixed(2)),
    tickMs: {
      p50: sortedTicks.length ? Number(percentile(sortedTicks, 0.5).toFixed(2)) : 0,
      p95: Number(percentile(sortedTicks, 0.95).toFixed(2)),
      p99: Number(percentile(sortedTicks, 0.99).toFixed(2)),
      max: Number((sortedTicks.at(-1) ?? 0).toFixed(2)),
    },
    gapMs: {
      p50: Number(percentile(gaps, 0.5).toFixed(1)),
      p99: Number(percentile(gaps, 0.99).toFixed(1)),
      max: Number((gaps.at(-1) ?? 0).toFixed(1)),
    },
    /** Of one core, over the window, for the whole process — bots included. */
    cpuPercent: Number((((cpu.user + cpu.system) / 1_000 / elapsedMs) * 100).toFixed(0)),
    /** The bots' own share of the thread, which is not the world's. */
    botPercent: Number(((driveMs / elapsedMs) * 100).toFixed(1)),
    /** Handling what the bots sent, between ticks. */
    messagePercent: Number(((messageMs / elapsedMs) * 100).toFixed(1)),
    perPlayer: {
      framesPerSecond: Number(perPlayerPerSecond("frames").toFixed(1)),
      kbPerSecond: Number((perPlayerPerSecond("bytes") / 1024).toFixed(2)),
      wireKbPerSecond: Number((perPlayerPerSecond("wireBytes") / 1024).toFixed(2)),
    },
    stepsPerSecond: Number((delta("stepsSent") / seconds).toFixed(0)),
    stepsRejectedPercent: Number(
      ((delta("stepsRejected") / Math.max(1, delta("stepsSent"))) * 100).toFixed(1),
    ),
    deaths: delta("deaths"),
    hellos: delta("hellos"),
    helloKb: Number((delta("helloBytes") / Math.max(1, delta("hellos")) / 1024).toFixed(0)),
    closes: delta("closes"),
  };
  console.log(JSON.stringify(report, null, 2));

  const perTick = (phase: Phase) => (ticks > 0 ? phase.ms / ticks : 0);
  const rows = [...phases.entries()]
    .filter(([, phase]) => phase.calls > 0)
    .sort(([, a], [, b]) => b.ms - a.ms);
  console.log("\n| phase | ms per tick | calls per tick | share of wall |");
  console.log("|---|---|---|---|");
  for (const [name, phase] of rows) {
    console.log(
      `| ${name} | ${perTick(phase).toFixed(3)} | ${(phase.calls / Math.max(1, ticks)).toFixed(1)} | ${((phase.ms / elapsedMs) * 100).toFixed(1)}% |`,
    );
  }

  await store.flush();
  await db.close?.();
  await rm(directory, { recursive: true, force: true });
  // Nothing the world left behind — its tick loop, a respawn alarm — should
  // hold the process open once the numbers are out.
  process.exit(0);
}

await run({
  players: Number(argValue("--players") ?? 1_000),
  seconds: Number(argValue("--seconds") ?? 60),
  warmupSeconds: Number(argValue("--warmup") ?? 10),
  joinsPerSecond: Number(argValue("--joins-per-second") ?? 50),
  clustered: process.argv.includes("--clustered"),
  deflate: process.argv.includes("--deflate"),
  sample: argValue("--sample"),
});
