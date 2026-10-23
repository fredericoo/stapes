import { copyFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { TICK_MS } from "../app/game/constants";
import type { Equipment } from "../app/game/equipment";
import { carriedCount } from "../app/game/trade";
import { MASTERIES, levelForXp, type MasteryXp } from "../app/lib/mastery";
import { statusesById, type StatusDef } from "../app/lib/status";
import { traitsById, withTraits } from "../app/lib/traits";
import { normalizeTileDef, type TileDef } from "../app/lib/types";
import { tilesByIdFromList } from "../app/lib/validation";
import { RemoteSession } from "../app/net/RemoteSession";
import { Harness, Pair } from "../server/testHarness";
import { Bot } from "../bots/Bot";
import { Economy } from "../bots/economy";
import { GEAR_SLOTS, bodyOf, gearWorth, stoneHanded } from "../bots/gear";
import type { Goal } from "../bots/goals";
import { Landmarks } from "../bots/memory";
import { ProgressPlanner, type Decision, type Observation, type Planner } from "../bots/planner";
import { between, drawTemperament, seededRandom, type Temperament } from "../bots/temperament";

const MAP_PATH = "data/map.json";
const TILES_PATH = "data/tiles.json";
const STATUSES_PATH = "data/statuses.json";
const TRAITS_PATH = "data/traits.json";
const JSON_TYPE = "application/json";
const SCRIPT_PATH = "scripts/bench-bots.ts";

const DEFAULT_A = "origin/main";
const DEFAULT_B = "HEAD";
const DEFAULT_BOTS = 6;
const DEFAULT_HOURS = 1;
const DEFAULT_SEEDS = 8;

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const PROGRESS_EVERY_MS = 10 * MS_PER_MINUTE;
const NOON_MS = 12 * MS_PER_HOUR;

/** The same frame and decision cadence as `bots/fleet.ts`, so a bot here acts as one does live. */
const FRAME_MS = 50;
const DECIDE_MS = 200;

/** What `bots/fleet.ts` gives every bot first. */
const OPENING: readonly Goal[] = [{ goal: "open_rewards" }, { goal: "reach_level", level: 0 }];

const PERCENT = 100;

/** Two-sided 95% quantiles of Student's t, by degrees of freedom from 1. */
const T_975 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145,
  2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048,
  2.045, 2.042,
];
const Z_975 = 1.959964;

function argValue(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

function wholeArg(flag: string, fallback: number, min: number): number {
  const raw = argValue(flag);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${flag} takes a whole number from ${min}, not "${raw}"`);
  }
  return value;
}

function positiveArg(flag: string, fallback: number): number {
  const raw = argValue(flag);
  const value = raw === undefined ? fallback : Number(raw);
  if (!(value > 0)) throw new Error(`${flag} takes a number above 0, not "${raw}"`);
  return value;
}

type BagWalks = { started: number; made: number; abandoned: number };

/** What one bot did in one run, raw: the version under test only plays, and the parent measures. */
type BotRun = {
  style: Temperament["style"];
  deaths: number;
  kills: number;
  recoveringMs: number;
  bagWalks: BagWalks;
  equipment: Equipment;
  masteryXp: MasteryXp;
};

type Run = { seed: number; hours: number; bots: BotRun[] };

/**
 * Counts walks back to the bag from the planner's side of `Planner`, which
 * every version keeps. `ProgressPlanner` sends a bot back with a `go_to` at
 * `situation.lostKitAt`; the next `done` is the walk arriving, and a `failed`,
 * a death or another goal is the walk given up.
 */
class BagWalkCounter implements Planner {
  readonly walks: BagWalks = { started: 0, made: 0, abandoned: 0 };
  private walking = false;

  constructor(private readonly inner: Planner) {}

  async decide(observation: Observation): Promise<Decision | null> {
    this.endWalk(observation.reason);
    const decision = await this.inner.decide(observation);
    const goal = decision?.goal;
    if (!goal) return decision;
    if (this.walking) this.giveUp();
    if (isBagWalk(goal, observation)) {
      this.walks.started++;
      this.walking = true;
    }
    return decision;
  }

  private endWalk(reason: Observation["reason"]) {
    if (!this.walking) return;
    if (reason === "done") {
      this.walks.made++;
      this.walking = false;
    }
    if (reason === "failed" || reason === "died") this.giveUp();
  }

  private giveUp() {
    this.walks.abandoned++;
    this.walking = false;
  }
}

function isBagWalk(goal: Goal, observation: Observation): boolean {
  const kit = observation.situation.lostKitAt;
  if (goal.goal !== "go_to" || !kit) return false;
  return goal.x === kit.x && goal.y === kit.y && goal.z === kit.z;
}

type Seat = {
  id: string;
  remote: RemoteSession;
  bot: Bot;
  style: Temperament["style"];
  planner: BagWalkCounter;
  decideOffsetMs: number;
  deaths: number;
  kills: number;
  recoveringMs: number;
};

type KillHook = { kill: (target: { id: string }, blame?: { byId?: string }) => void };

/**
 * Deaths and kills are counted where the world decides them, in the session's
 * private `kill`, the way `bench:server` counts brain work, so every version
 * is counted the same way whatever its bot logs. A rename throws here rather
 * than reporting zeros.
 */
function countKills(harness: Harness, seats: ReadonlyMap<string, Seat>) {
  const session = (harness.server as unknown as { session: KillHook | null }).session;
  if (!session || typeof session.kill !== "function") {
    throw new Error("GameServer has no session with a kill to count");
  }
  const original = session.kill;
  session.kill = function (this: unknown, target, blame) {
    const victim = seats.get(target.id);
    if (victim) victim.deaths++;
    const killer = blame?.byId ? seats.get(blame.byId) : undefined;
    if (killer && !victim) killer.kills++;
    return original.call(this, target, blame);
  };
}

/** `Bot.recovering` is private, and read by name; a rename throws here rather than reading never. */
function isRecovering(bot: Bot): boolean {
  const recovering = (bot as unknown as { recovering?: unknown }).recovering;
  if (typeof recovering !== "boolean") throw new Error("Bot has no recovering flag to read");
  return recovering;
}

/**
 * The socket pair hands a frame to the server without waiting, and the
 * server awaits storage on its way in, so a frame yields to the event loop
 * before the world is ticked, as `bots/Bot.test.ts` does.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function loadTiles(): Promise<TileDef[]> {
  const raw = (await Bun.file(TILES_PATH).json()) as TileDef[];
  const traits = traitsById((await Bun.file(TRAITS_PATH).json()) as unknown[]);
  return withTraits(raw.map(normalizeTileDef), traits);
}

/** Plays `bots` bots for `hours` game-hours on the map at `mapPath`, and prints one line of JSON. */
async function play(seed: number, bots: number, hours: number, mapPath: string) {
  const tiles = await loadTiles();
  const tilesById = tilesByIdFromList(tiles);
  const statuses = statusesById((await Bun.file(STATUSES_PATH).json()) as unknown[]);
  const harness = await Harness.create({}, { manualTicks: { startAtMs: NOON_MS }, seed });
  for (const [name, path] of [
    ["tiles.json", TILES_PATH],
    ["statuses.json", STATUSES_PATH],
    ["traits.json", TRAITS_PATH],
    ["map.json", mapPath],
  ] as const) {
    await harness.blobs.put(name, await Bun.file(path).text(), JSON_TYPE);
  }

  const clock = { ms: 0 };
  const landmarks = new Landmarks(":memory:");
  const seats = new Map<string, Seat>();
  for (let index = 0; index < bots; index++) {
    const id = `bench-bot-${index}`;
    const pair = new Pair();
    pair.onClientMessage = (data) => void harness.server.webSocketMessage(pair.server, data);
    const remote = new RemoteSession(pair.client() as never, tiles, statuses, () => clock.ms);
    await harness.server.join(pair.server, id, { admin: false });
    const temperament = drawTemperament(seededRandom(`bench-${seed}-${index}`));
    const random = seededRandom(`bench-${seed}-${index}-play`);
    const planner = new BagWalkCounter(new ProgressPlanner(OPENING));
    const bot = new Bot(remote, planner, tilesById, statuses, { temperament, random, landmarks });
    const decideOffsetMs = Math.round(between(random, 0, DECIDE_MS / FRAME_MS)) * FRAME_MS;
    seats.set(id, {
      id,
      remote,
      bot,
      style: temperament.style,
      planner,
      decideOffsetMs,
      deaths: 0,
      kills: 0,
      recoveringMs: 0,
    });
  }
  countKills(harness, seats);

  const endMs = hours * MS_PER_HOUR;
  const startedMs = performance.now();
  let debtMs = 0;
  while (clock.ms < endMs) {
    clock.ms += FRAME_MS;
    for (const seat of seats.values()) frame(seat, clock.ms);
    await yieldToEventLoop();
    debtMs += FRAME_MS;
    const ticks = Math.floor(debtMs / TICK_MS);
    debtMs -= ticks * TICK_MS;
    if (ticks > 0) await harness.server.step(ticks);
    await yieldToEventLoop();
    if (clock.ms % PROGRESS_EVERY_MS === 0) progress(seed, clock.ms, startedMs);
  }

  const run: Run = { seed, hours, bots: [...seats.values()].map(report) };
  landmarks.close();
  await harness.dispose();
  console.log(JSON.stringify(run));
}

function progress(seed: number, gameMs: number, startedMs: number) {
  const gameMinutes = gameMs / MS_PER_MINUTE;
  const wallMinutes = (performance.now() - startedMs) / MS_PER_MINUTE;
  console.error(
    `${basename(process.cwd())} seed ${seed}: ${gameMinutes} game-minutes in ${wallMinutes.toFixed(1)} minutes`,
  );
}

function frame(seat: Seat, nowMs: number) {
  seat.remote.update(FRAME_MS);
  if (!seat.remote.isReady()) return;
  seat.bot.steer(nowMs);
  if (isRecovering(seat.bot)) seat.recoveringMs += FRAME_MS;
  if ((nowMs - seat.decideOffsetMs) % DECIDE_MS === 0) seat.bot.act(nowMs);
}

function report(seat: Seat): BotRun {
  const snapshot = seat.remote.getSnapshot();
  return {
    style: seat.style,
    deaths: seat.deaths,
    kills: seat.kills,
    recoveringMs: seat.recoveringMs,
    bagWalks: seat.planner.walks,
    equipment: snapshot.equipment,
    masteryXp: snapshot.masteryXp,
  };
}

type Metric = {
  label: string;
  /** One run's figure: a mean over its bots, or a rate per bot-hour. */
  of: (run: Run, measure: Measure) => number;
  digits: number;
};

type Measure = { tilesById: Record<string, TileDef>; statuses: Record<string, StatusDef> };

function perBotHour(pick: (bot: BotRun) => number) {
  return (run: Run) => sum(run.bots.map(pick)) / (run.bots.length * run.hours);
}

function perBot(pick: (bot: BotRun, measure: Measure) => number) {
  return (run: Run, measure: Measure) =>
    sum(run.bots.map((bot) => pick(bot, measure))) / run.bots.length;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function goldOf(bot: BotRun, { tilesById, statuses }: Measure): number {
  const { currency } = new Economy(tilesById, statuses, bot.style);
  return currency ? carriedCount(tilesById, bot.equipment, currency) : 0;
}

/** What everything the bot wears is worth, on the scale its gear choices are made on. */
function gearOf(bot: BotRun, { tilesById, statuses }: Measure): number {
  const body = bodyOf(tilesById, bot.masteryXp);
  if (!body) return 0;
  const { taste } = new Economy(tilesById, statuses, bot.style);
  const stoneHands = stoneHanded(bot.equipment, tilesById, taste, body.masteries);
  let total = 0;
  for (const slot of [...GEAR_SLOTS, "charm"] as const) {
    const def = tilesById[bot.equipment[slot]?.tileId ?? ""];
    if (def) total += gearWorth(def, slot, body, taste, stoneHands);
  }
  return total;
}

function topMasteryOf(bot: BotRun): number {
  return Math.max(...MASTERIES.map((mastery) => levelForXp(bot.masteryXp[mastery] ?? 0)));
}

const METRICS: readonly Metric[] = [
  { label: "deaths/h", of: perBotHour((bot) => bot.deaths), digits: 2 },
  { label: "kills/h", of: perBotHour((bot) => bot.kills), digits: 1 },
  { label: "gold", of: perBot(goldOf), digits: 1 },
  { label: "gear worth", of: perBot(gearOf), digits: 1 },
  { label: "top mastery", of: perBot(topMasteryOf), digits: 1 },
  {
    label: "time recovering %",
    of: (run) =>
      (PERCENT * sum(run.bots.map((bot) => bot.recoveringMs))) /
      (run.bots.length * run.hours * MS_PER_HOUR),
    digits: 1,
  },
  { label: "bag walks made/h", of: perBotHour((bot) => bot.bagWalks.made), digits: 2 },
  { label: "bag walks abandoned/h", of: perBotHour((bot) => bot.bagWalks.abandoned), digits: 2 },
];

/**
 * Past the table, the Cornish-Fisher expansion of t about the normal
 * quantile, which is within 0.001 of the exact value from 30 degrees up.
 */
function t975(degrees: number): number {
  if (degrees <= T_975.length) return T_975[degrees - 1]!;
  const z = Z_975;
  return (
    z + (z ** 3 + z) / (4 * degrees) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * degrees ** 2)
  );
}

type Interval = { mean: number; low: number; high: number };

function interval(values: readonly number[]): Interval {
  const mean = sum(values) / values.length;
  const variance = sum(values.map((value) => (value - mean) ** 2)) / (values.length - 1);
  const half = t975(values.length - 1) * Math.sqrt(variance / values.length);
  return { mean, low: mean - half, high: mean + half };
}

function show({ mean, low, high }: Interval, digits: number): string {
  return `${mean.toFixed(digits)} [${low.toFixed(digits)}, ${high.toFixed(digits)}]`;
}

function git(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** Worktrees made here are outside the repository, so they borrow its `node_modules`. */
function findNodeModules(from: string): string {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules"))) return join(dir, "node_modules");
    if (dirname(dir) === dir) throw new Error(`no node_modules above ${from}`);
  }
}

function warnOnLockfileChange(shaA: string, shaB: string) {
  const diff = Bun.spawnSync(["git", "diff", "--quiet", shaA, shaB, "--", "bun.lock"]);
  if (diff.exitCode === 0) return;
  console.error("bun.lock differs between A and B, and both run on this checkout's node_modules");
}

type Side = { name: "A" | "B"; ref: string; sha: string; dir: string };

async function checkOut(name: Side["name"], ref: string, root: string): Promise<Side> {
  const sha = git(["rev-parse", "--verify", `${ref}^{commit}`]);
  const dir = join(root, name);
  git(["worktree", "add", "--detach", dir, sha]);
  await symlink(findNodeModules(process.cwd()), join(dir, "node_modules"));
  await copyFile(import.meta.path, join(dir, SCRIPT_PATH));
  return { name, ref, sha, dir };
}

async function runOne(side: Side, seed: number, bots: number, hours: number, mapPath: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      SCRIPT_PATH,
      "--play",
      "--seed",
      String(seed),
      "--bots",
      String(bots),
      "--hours",
      String(hours),
      "--map",
      mapPath,
    ],
    { cwd: side.dir, stdout: "pipe", stderr: "inherit" },
  );
  const out = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error(`${side.name} seed ${seed} failed`);
  return JSON.parse(out.trim().split("\n").at(-1)!) as Run;
}

/** Runs every task, at most `jobs` at once, keeping each result at its task's index. */
async function pool<T>(tasks: ReadonlyArray<() => Promise<T>>, jobs: number): Promise<T[]> {
  const results: T[] = Array.from({ length: tasks.length });
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const at = next++;
      results[at] = await tasks[at]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));
  return results;
}

async function compare() {
  const bots = wholeArg("--bots", DEFAULT_BOTS, 1);
  const hours = positiveArg("--hours", DEFAULT_HOURS);
  const seeds = wholeArg("--seeds", DEFAULT_SEEDS, 2);
  const jobs = wholeArg("--jobs", Math.max(1, availableParallelism() - 1), 1);
  const mapPath = resolve(argValue("--map") ?? MAP_PATH);
  const root = await mkdtemp(join(tmpdir(), "stapes-bench-bots-"));
  const sides: Side[] = [];
  try {
    sides.push(await checkOut("A", argValue("--a") ?? DEFAULT_A, root));
    sides.push(await checkOut("B", argValue("--b") ?? DEFAULT_B, root));
    for (const side of sides) {
      console.error(`${side.name} = ${side.ref} (${side.sha.slice(0, 8)})`);
    }
    warnOnLockfileChange(sides[0]!.sha, sides[1]!.sha);
    console.error(
      `${bots} bots, ${hours} game-hours, seeds 1-${seeds}, ${jobs} at once, map ${mapPath}`,
    );
    const seedList = Array.from({ length: seeds }, (_, i) => i + 1);
    const tasks = sides.flatMap((side) =>
      seedList.map((seed) => () => runOne(side, seed, bots, hours, mapPath)),
    );
    const runs = await pool(tasks, jobs);
    await printTable(runs.slice(0, seeds), runs.slice(seeds), sides);
  } finally {
    for (const side of sides) git(["worktree", "remove", "--force", side.dir]);
    await rm(root, { recursive: true, force: true });
  }
}

/** A difference is significant when its paired 95% interval leaves out zero. */
async function printTable(a: readonly Run[], b: readonly Run[], sides: readonly Side[]) {
  const tilesById = tilesByIdFromList(await loadTiles());
  const statuses = statusesById((await Bun.file(STATUSES_PATH).json()) as unknown[]);
  const measure: Measure = { tilesById, statuses };
  const [nameA, nameB] = sides.map((side) => `${side.name} ${side.ref} (${side.sha.slice(0, 8)})`);
  console.log(`| metric | ${nameA} | ${nameB} | B−A | significant |`);
  console.log("|---|---|---|---|---|");
  for (const metric of METRICS) {
    const valuesA = a.map((run) => metric.of(run, measure));
    const valuesB = b.map((run) => metric.of(run, measure));
    const difference = interval(valuesB.map((value, i) => value - valuesA[i]!));
    const significant = difference.low > 0 || difference.high < 0;
    const cells = [
      metric.label,
      show(interval(valuesA), metric.digits),
      show(interval(valuesB), metric.digits),
      show(difference, metric.digits),
      significant ? "yes" : "no",
    ];
    console.log(`| ${cells.join(" | ")} |`);
  }
}

async function main() {
  if (!process.argv.includes("--play")) {
    await compare();
    return;
  }
  await play(
    wholeArg("--seed", 1, 0),
    wholeArg("--bots", DEFAULT_BOTS, 1),
    positiveArg("--hours", DEFAULT_HOURS),
    resolve(argValue("--map") ?? MAP_PATH),
  );
}

await main();
