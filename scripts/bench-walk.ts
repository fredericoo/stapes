import { readFile } from "node:fs/promises";
import { TICK_MS, WALK_DURATION_MS } from "../app/game/constants";
import { Harness, Pair } from "../server/testHarness";
import { buildWorldMap } from "../server/worldMap";

const JSON_TYPE = "application/json";
const PLAYER = "player-1";
const SETTLE_MS = 10_000;
const DRAIN_MS = 2_000;

/** Levels tried, nearest first, when the next cell of the line has no room on the player's own. */
const LEVEL_TRIES = [0, 1, -1, 2, -2, 3, -3];

type Internals = {
  tick(): void;
  putBackChunks(...args: unknown[]): void;
  session: {
    actorPosition(id: string): { x: number; y: number; z: number } | null;
    runCommand(raw: string, id: string): unknown;
  };
};

function argValue(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

function round(ms: number): number {
  return Number(ms.toFixed(1));
}

/**
 * Builds the world from `data/world.json` into a real ticking `GameServer`,
 * seats one player at the spawn and moves them a cell every
 * `WALK_DURATION_MS` along a straight line, the pace of walking, so every
 * chunk they come near is read and put back as it is when somebody walks
 * there. Prints one line of JSON.
 */
async function run(cells: number, dx: number, dy: number) {
  const [tiles, statuses, traits, tree] = await Promise.all(
    ["tiles.json", "statuses.json", "traits.json", "world.json"].map((file) =>
      readFile(`data/${file}`, "utf8"),
    ),
  );
  const harness = await Harness.create({}, { seed: 7, weather: "clear" });
  await harness.blobs.put("tiles.json", tiles!, JSON_TYPE);
  await harness.blobs.put("statuses.json", statuses!, JSON_TYPE);
  await harness.blobs.put("traits.json", traits!, JSON_TYPE);
  await harness.blobs.put("map.json", buildWorldMap(tree!, tiles!).text, JSON_TYPE);

  const pair = new Pair();
  pair.client();
  pair.onClientMessage = (data) => void harness.server.webSocketMessage(pair.server, data);
  await harness.server.join(pair.server, PLAYER, { admin: true });
  await Bun.sleep(SETTLE_MS);

  const server = harness.server as unknown as Internals;
  const starts: number[] = [];
  const ticks: number[] = [];
  const putBacks: number[] = [];
  let putBackMs = 0;
  const tick = server.tick;
  const putBack = server.putBackChunks;
  server.putBackChunks = function (this: unknown, ...args: unknown[]) {
    const at = performance.now();
    putBack.apply(this, args);
    putBackMs += performance.now() - at;
  };
  server.tick = function (this: unknown) {
    const at = performance.now();
    putBackMs = 0;
    starts.push(at);
    tick.call(this);
    ticks.push(performance.now() - at);
    putBacks.push(putBackMs);
  };

  const session = server.session;
  const from = session.actorPosition(PLAYER)!;
  let x = from.x;
  let y = from.y;
  for (let i = 0; i < cells; i++) {
    x += dx;
    y += dy;
    const z = session.actorPosition(PLAYER)?.z ?? from.z;
    for (const dz of LEVEL_TRIES) {
      const moved = session.runCommand(`/goto ${x} ${y} ${z + dz}`, PLAYER) as { ok: boolean };
      if (moved.ok) break;
    }
    await Bun.sleep(WALK_DURATION_MS);
  }

  const sortedTicks = [...ticks].sort((a, b) => a - b);
  const late = starts.slice(1).map((at, i) => at - starts[i]! - TICK_MS);
  const sortedLate = late.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      cells,
      from,
      to: session.actorPosition(PLAYER),
      ticks: ticks.length,
      tickP50: round(percentile(sortedTicks, 0.5)),
      tickP99: round(percentile(sortedTicks, 0.99)),
      tickMax: round(sortedTicks.at(-1) ?? 0),
      ticksOverBudget: ticks.filter((ms) => ms > TICK_MS).length,
      putBackMax: round(Math.max(...putBacks)),
      putBackTotal: round(putBacks.reduce((sum, ms) => sum + ms, 0)),
      lateP99: round(percentile(sortedLate, 0.99)),
      lateMax: round(sortedLate.at(-1) ?? 0),
    }),
  );
  await Bun.sleep(DRAIN_MS);
  await harness.dispose();
  process.exit(0);
}

await run(
  Number(argValue("--cells") ?? 150),
  Number(argValue("--dx") ?? 0),
  Number(argValue("--dy") ?? -1),
);
