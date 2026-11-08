import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataStore } from "../app/lib/dataStore";
import { characterIdOf } from "../app/lib/characterId";
import { DiskBlobs } from "../server/blobs";
import { openDatabase } from "../server/db";
import { GameServer } from "../server/GameServer";
import { GameSocket, SocketHub, type WorldContext } from "../server/sockets";
import { WorldStore } from "../server/WorldStore";

const CONTENT = ["map.json", "tiles.json", "statuses.json", "traits.json", "tilesets.json"];

/** Long enough for the flames authored on `data/map.json` to burn out the grass beside them. */
const SETTLE_MS = 15_000;
const MS_PER_SECOND = 1_000;
const MICROS_PER_MS = 1_000;

function argValue(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

/**
 * Loads `data/` into a real `GameServer`, seats one player and lets them
 * leave, then counts the ticks the empty world runs and the CPU they cost.
 * Prints one line of JSON.
 */
async function run(seconds: number) {
  const directory = await mkdtemp(join(tmpdir(), "stapes-idle-"));
  for (const file of CONTENT) await copyFile(join("data", file), join(directory, file));
  const db = await openDatabase(join(directory, "stapes.db"));
  const hub = new SocketHub();
  const context: WorldContext = {
    storage: new WorldStore(db),
    getWebSockets: () => hub.all(),
    acceptWebSocket: (socket) => hub.accept(socket),
  };
  const server = new GameServer(context, {
    dataStore: new DataStore(new DiskBlobs(directory)),
    nameOf: async () => "Idle",
  });

  let ticks = 0;
  const internals = server as unknown as { tick: () => void };
  const tick = internals.tick;
  internals.tick = function (this: unknown) {
    ticks++;
    tick.call(this);
  };

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
  await server.webSocketClose(socket);
  await Bun.sleep(SETTLE_MS);

  ticks = 0;
  const cpu = process.cpuUsage();
  const t0 = performance.now();
  await Bun.sleep(seconds * MS_PER_SECOND);
  const wallMs = performance.now() - t0;
  const used = process.cpuUsage(cpu);

  console.log(
    JSON.stringify({
      seconds,
      ticks,
      ticksPerSecond: Number(((ticks * MS_PER_SECOND) / wallMs).toFixed(1)),
      cpuPercent: Number(((100 * (used.user + used.system)) / MICROS_PER_MS / wallMs).toFixed(1)),
    }),
  );
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
}

await run(Number(argValue("--seconds") ?? 20));
