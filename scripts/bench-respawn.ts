import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSpawnFilled, type SpawnPoint } from "../app/game/respawn";
import { characterIdOf } from "../app/lib/characterId";
import { DataStore } from "../app/lib/dataStore";
import { getStack, replaceStack } from "../app/lib/mapData";
import type { MapFile } from "../app/lib/types";
import { DiskBlobs } from "../server/blobs";
import { type Database, openDatabase } from "../server/db";
import { GameServer } from "../server/GameServer";
import { GameSocket, SocketHub, type WorldContext } from "../server/sockets";
import { WorldStore } from "../server/WorldStore";

const CONTENT = ["tiles.json", "statuses.json", "traits.json", "tilesets.json"];
const DEFAULT_ROUNDS = 40;
const DEFAULT_DUE = 500;
const NOON_MS = Date.UTC(2026, 0, 1, 12);
const HOUR_MS = 60 * 60 * 1000;

function argValue(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

function summary(samples: readonly number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return {
    n: sorted.length,
    p50: +percentile(sorted, 0.5).toFixed(2),
    max: +sorted.at(-1)!.toFixed(2),
  };
}

type Internals = {
  respawnPoints: Map<string, SpawnPoint>;
  respawnPending: Map<string, number>;
  persistRespawnPending(): void;
  now(): number;
  session: { map: MapFile; getMap(): MapFile; despawn(id: string): void };
};

type Kind = "item" | "object" | "creature";

function kindOf(point: SpawnPoint): Kind {
  if (point.ownerId) return "creature";
  return point.itemIds?.length ? "item" : "object";
}

type World = {
  server: GameServer;
  internals: Internals;
  store: WorldStore;
  db: Database;
};

async function openWorld(directory: string, startAtMs: number): Promise<World> {
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
    nameOf: async () => "Respawn",
    manualTicks: { startAtMs },
  });
  return { server, internals: server as unknown as Internals, store, db };
}

function join0(server: GameServer) {
  let closed = false;
  const socket = new GameSocket({
    send() {},
    close() {
      closed = true;
    },
    get closed() {
      return closed;
    },
  });
  return server.join(socket, characterIdOf(0), { admin: false });
}

/** Takes what the point grew off the board, the way a pickup, a felling or a kill would. */
function takeAway(internals: Internals, point: SpawnPoint) {
  const session = internals.session;
  if (point.ownerId) {
    session.despawn(point.ownerId);
    return;
  }
  const { x, y, z } = point.cell;
  const map = session.getMap();
  const kept = getStack(map, x, y, z).filter((placed) => placed.tileId !== point.placed.tileId);
  session.map = replaceStack(map, x, y, z, kept);
}

/**
 * A pickup, as the checkpoint sees it: takes one respawning item off its
 * cell, steps the world once so it notices, then times the flush that
 * follows and counts the bytes it wrote.
 */
async function pickups({ server, internals, store }: World, rounds: number) {
  const withItems = [...internals.respawnPoints.values()].filter((p) => p.itemIds?.length);
  const flushMs: number[] = [];
  const bytes: number[] = [];
  for (const point of withItems.slice(0, rounds)) {
    const { x, y, z } = point.cell;
    const map = internals.session.getMap();
    const kept = getStack(map, x, y, z).filter((placed) => placed.itemId !== point.itemIds![0]);
    internals.session.map = replaceStack(map, x, y, z, kept);
    await server.step(1);
    const pending = (store as unknown as { pending: Map<string, unknown> }).pending;
    bytes.push([...pending.values()].reduce<number>((n, v) => n + JSON.stringify(v).length, 0));
    const t0 = performance.now();
    await store.flush();
    flushMs.push(performance.now() - t0);
  }
  return {
    pickups: flushMs.length,
    flushMs: summary(flushMs),
    bytesPerPickup: Math.round(bytes.reduce((a, b) => a + b, 0) / Math.max(1, bytes.length)),
  };
}

/**
 * One respawn falling due, timed as the tick it lands in, beside a tick with
 * nothing due. The point is emptied and noticed a tick earlier, so the timed
 * tick does only the growing back.
 */
async function respawnTicks({ server, internals }: World, rounds: number) {
  const idleMs: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    await server.step(1);
    idleMs.push(performance.now() - t0);
  }

  const byKind: Record<Kind, number[]> = { item: [], object: [], creature: [] };
  const points = [...internals.respawnPoints.values()];
  for (const kind of Object.keys(byKind) as Kind[]) {
    for (const point of points.filter((p) => kindOf(p) === kind).slice(0, rounds)) {
      takeAway(internals, point);
      await server.step(1);
      internals.respawnPending.set(point.key, internals.now());
      const t0 = performance.now();
      await server.step(1);
      byKind[kind].push(performance.now() - t0);
    }
  }
  return {
    idleTickMs: summary(idleMs),
    respawnTickMs: {
      item: summary(byKind.item),
      object: summary(byKind.object),
      creature: summary(byKind.creature),
    },
  };
}

/**
 * Empties `due` points, checkpoints a board without them, and reopens the
 * world after every one of them has fallen due: the first tick grows them
 * all back, as a deploy after a quiet night does.
 */
async function restart(directory: string, world: World, due: number) {
  const { server, internals, store } = world;
  const points = [...internals.respawnPoints.values()].slice(0, due);
  const dueAtMs = internals.now() + HOUR_MS;
  for (const point of points) {
    takeAway(internals, point);
    internals.respawnPending.set(point.key, dueAtMs);
  }
  internals.persistRespawnPending();
  await server.step(1);
  server.saveEveryActor();
  await store.flush();
  world.db.close();

  const reopened = await openWorld(directory, dueAtMs + HOUR_MS);
  const t0 = performance.now();
  await join0(reopened.server);
  const loadMs = performance.now() - t0;
  const reopenedPoints = points.map((point) => reopened.internals.respawnPoints.get(point.key)!);
  const filled = () =>
    reopenedPoints.filter((point) => isSpawnFilled(reopened.internals.session.getMap(), point))
      .length;
  const filledAtLoad = filled();
  const owed = [...reopened.internals.respawnPending.values()].filter(
    (at) => at <= reopened.internals.now(),
  ).length;
  const t1 = performance.now();
  await reopened.server.step(1);
  const firstTickMs = performance.now() - t1;
  const filledAfter = filled();
  const left = [...reopened.internals.respawnPending.values()].filter(
    (at) => at <= reopened.internals.now(),
  ).length;
  reopened.db.close();
  return {
    kinds: {
      item: points.filter((p) => kindOf(p) === "item").length,
      object: points.filter((p) => kindOf(p) === "object").length,
      creature: points.filter((p) => kindOf(p) === "creature").length,
    },
    dueAtLoad: owed,
    settledInFirstTick: owed - left,
    filledAtLoad,
    filledAfterFirstTick: filledAfter,
    loadMs: +loadMs.toFixed(1),
    firstTickMs: +firstTickMs.toFixed(1),
  };
}

/**
 * Prints one line of JSON: the checkpoint flush after a pickup, the tick a
 * single respawn lands in for each kind of point, and a restart with `--due`
 * respawns owed. `--map` benches a map other than `data/map.json`.
 */
async function run(rounds: number, due: number, mapPath: string) {
  const directory = await mkdtemp(join(tmpdir(), "stapes-respawn-"));
  for (const file of CONTENT) await copyFile(join("data", file), join(directory, file));
  await copyFile(mapPath, join(directory, "map.json"));

  const world = await openWorld(directory, NOON_MS);
  await join0(world.server);
  await world.server.step(2);
  await world.store.flush();

  const points = [...world.internals.respawnPoints.values()];
  const cells = Object.values(world.internals.session.getMap().levels).reduce(
    (n, level) => n + Object.values(level).reduce((m, chunk) => m + Object.keys(chunk).length, 0),
    0,
  );
  const ticks = await respawnTicks(world, rounds);
  const flushed = await pickups(world, rounds);
  const restarted = await restart(directory, world, due);

  console.log(
    JSON.stringify({
      map: mapPath,
      cells,
      points: points.length,
      ...flushed,
      ...ticks,
      restart: restarted,
    }),
  );
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
}

await run(
  Number(argValue("--rounds") ?? DEFAULT_ROUNDS),
  Number(argValue("--due") ?? DEFAULT_DUE),
  argValue("--map") ?? join("data", "map.json"),
);
