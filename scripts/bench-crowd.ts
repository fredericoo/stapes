import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { Session } from "node:inspector";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataStore } from "../app/lib/dataStore";
import { listCoords, parseMap } from "../app/lib/mapData";
import { WALK_DURATION_MS } from "../app/game/constants";
import type { GameSession } from "../app/game/GameSession";
import { DiskBlobs } from "../server/blobs";
import { openDatabase } from "../server/db";
import { GameServer } from "../server/GameServer";
import { GameSocket, SocketHub, type WorldContext } from "../server/sockets";
import { WorldStore } from "../server/WorldStore";

const CONTENT = ["map.json", "tiles.json", "statuses.json", "tilesets.json"];

const CHECKPOINT_INTERVAL_MS = 2_000;

const COMPRESS_MIN_LENGTH = 512;

const DRIVE_INTERVAL_MS = 5;

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

type Phase = { calls: number; ms: number };

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

class Bot {
  state: "joining" | "walking" | "dead" = "joining";
  nextAt = Number.POSITIVE_INFINITY;
  readonly socket: GameSocket;
  closeCode: number | undefined;
  private closed = false;
  private seq = 0;
  private direction: Direction = "s";
  private runLeft = 0;
  recording: string[] | null = null;

  constructor(
    readonly actorId: string,
    private readonly counters: Counters,
    deflate: boolean,
    private readonly idle: boolean,
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
      close(code?: number) {
        bot.closed = true;
        bot.closeCode = code;
        counters.closes++;
      },
      get closed() {
        return bot.closed;
      },
    });
  }

  private hear(data: string) {
    this.recording?.push(data);
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

  act(now: number): string | null {
    if (this.closed || now < this.nextAt) return null;
    if (this.state === "dead") {
      this.state = "joining";
      this.nextAt = Number.POSITIVE_INFINITY;
      return JSON.stringify({ type: "rebirth" });
    }
    if (this.state !== "walking" || this.idle) return null;

    if (this.runLeft <= 0) {
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

type Options = {
  players: number;
  seconds: number;
  warmupSeconds: number;
  joinsPerSecond: number;
  clustered: boolean;
  deflate: boolean;
  idle: boolean;
  sample: string | undefined;
  profile: string | undefined;
};

function inspect<T>(session: Session, method: string): Promise<T> {
  return new Promise((resolve, reject) => {
    session.post(method, (error: Error | null, result: unknown) =>
      error ? reject(error) : resolve(result as T),
    );
  });
}

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
    maxOnlinePlayers: options.players,
  });

  const checkpoint = setInterval(() => {
    if (store.dirty) void store.flush();
  }, CHECKPOINT_INTERVAL_MS);

  const phases = new Map<string, Phase>();
  for (const name of SERVER_PHASES) timePhase(phases, server, name, `server.${name}`);

  const tickStarts: number[] = [];
  const tickMs: number[] = [];
  const internals = server as unknown as { tick: () => void; session: GameSession | null };
  const timedTick = internals.tick;
  internals.tick = function (this: unknown) {
    const t0 = performance.now();
    timedTick.call(this);
    tickStarts.push(t0);
    tickMs.push(performance.now() - t0);
  };

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
    const bot = new Bot(crypto.randomUUID(), counters, options.deflate, options.idle);
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
    await Promise.all(handling);
    const t2 = performance.now();
    driveMs += t1 - t0 - spent;
    messageMs += spent + (t2 - t1);
  };
  const driver = setInterval(() => void drive(), DRIVE_INTERVAL_MS);

  const joinStarted = performance.now();
  const joinGapMs = 1_000 / options.joinsPerSecond;
  let sessionTimed = false;
  const refused: Bot[] = [];
  for (const [i, bot] of bots.entries()) {
    const due = joinStarted + i * joinGapMs;
    const wait = due - performance.now();
    if (wait > 0) await Bun.sleep(wait);
    await server.join(bot.socket, bot.actorId, { admin: false });
    if (bot.socket.closed) refused.push(bot);
    if (!sessionTimed && internals.session) {
      for (const name of SESSION_PHASES) {
        timePhase(phases, internals.session, name, `session.${name}`);
      }
      sessionTimed = true;
    }
  }
  const joinSeconds = (performance.now() - joinStarted) / 1_000;
  const seated = bots.length - refused.length;
  const session = internals.session;
  const residents = session ? session.actorIds().filter((id) => session.isResident(id)).length : 0;
  const refusal =
    refused.length === 0
      ? null
      : `the server refused ${refused.length} of ${options.players} players ` +
        `(closed with ${[...new Set(refused.map((bot) => bot.closeCode))].join(", ")})`;
  console.error(
    `[crowd] seated ${seated} of ${options.players} in ${joinSeconds.toFixed(1)}s; ` +
      `warming up ${options.warmupSeconds}s, then measuring ${options.seconds}s`,
  );
  if (refusal) console.error(`[crowd] ${refusal}`);

  await Bun.sleep(options.warmupSeconds * 1_000);

  resetPhases(phases);
  tickStarts.length = 0;
  tickMs.length = 0;
  driveMs = 0;
  messageMs = 0;
  const before = { ...counters };
  const profiler = options.profile ? new Session() : null;
  if (profiler) {
    profiler.connect();
    await inspect(profiler, "Profiler.enable");
    await inspect(profiler, "Profiler.start");
  }
  const cpuBefore = process.cpuUsage();
  const windowStart = performance.now();
  if (options.sample) {
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
  if (profiler) {
    const { profile } = await inspect<{ profile: unknown }>(profiler, "Profiler.stop");
    await Bun.write(options.profile!, JSON.stringify(profile));
    profiler.disconnect();
  }

  clearInterval(driver);
  clearInterval(checkpoint);

  const seconds = elapsedMs / 1_000;
  const ticks = tickMs.length;
  const sortedTicks = [...tickMs].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < tickStarts.length; i++) gaps.push(tickStarts[i]! - tickStarts[i - 1]!);
  gaps.sort((a, b) => a - b);
  const delta = (key: keyof Counters) => counters[key] - before[key];
  const perPlayerPerSecond = (key: keyof Counters) => delta(key) / Math.max(1, seated) / seconds;

  const report = {
    players: seated,
    refused: refused.length,
    residents,
    scenario: `${options.clustered ? "clustered" : "spread"}${options.idle ? ", idle" : ""}`,
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
    cpuPercent: Number((((cpu.user + cpu.system) / 1_000 / elapsedMs) * 100).toFixed(0)),
    botPercent: Number(((driveMs / elapsedMs) * 100).toFixed(1)),
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
  if (refusal) {
    console.error(`\n[crowd] ${refusal}, so every figure above is for ${seated} players`);
    process.exit(1);
  }
  process.exit(0);
}

await run({
  players: Number(argValue("--players") ?? 1_000),
  seconds: Number(argValue("--seconds") ?? 60),
  warmupSeconds: Number(argValue("--warmup") ?? 10),
  joinsPerSecond: Number(argValue("--joins-per-second") ?? 50),
  clustered: process.argv.includes("--clustered"),
  deflate: process.argv.includes("--deflate"),
  idle: process.argv.includes("--idle"),
  sample: argValue("--sample"),
  profile: argValue("--profile"),
});
