import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnPoint } from "../app/game/respawn";
import { characterIdOf } from "../app/lib/characterId";
import { DataStore } from "../app/lib/dataStore";
import { getStack, replaceStack } from "../app/lib/mapData";
import type { MapFile } from "../app/lib/types";
import { DiskBlobs } from "../server/blobs";
import { openDatabase } from "../server/db";
import { GameServer } from "../server/GameServer";
import { GameSocket, SocketHub, type WorldContext } from "../server/sockets";
import { WorldStore } from "../server/WorldStore";

const CONTENT = ["map.json", "tiles.json", "statuses.json", "traits.json", "tilesets.json"];
const DEFAULT_ROUNDS = 40;
const NOON_MS = Date.UTC(2026, 0, 1, 12);

function argValue(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

type Internals = {
  respawnPoints: Map<string, SpawnPoint>;
  session: { map: MapFile; getMap(): MapFile };
};

/**
 * A pickup, as the checkpoint sees it: takes one respawning item off its
 * cell, steps the world once so it notices, then times the flush that
 * follows and counts the bytes it wrote. Prints one line of JSON.
 */
async function run(rounds: number) {
  const directory = await mkdtemp(join(tmpdir(), "stapes-respawn-"));
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
    nameOf: async () => "Respawn",
    manualTicks: { startAtMs: NOON_MS },
  });
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
  await server.join(socket, characterIdOf(0), { admin: false });
  await server.step(2);
  await store.flush();

  const internals = server as unknown as Internals;
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

  const sortedMs = [...flushMs].sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      points: internals.respawnPoints.size,
      pickups: flushMs.length,
      flushMs: { p50: +percentile(sortedMs, 0.5).toFixed(2), max: +sortedMs.at(-1)!.toFixed(2) },
      bytesPerPickup: Math.round(bytes.reduce((a, b) => a + b, 0) / Math.max(1, bytes.length)),
    }),
  );
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
}

await run(Number(argValue("--rounds") ?? DEFAULT_ROUNDS));
