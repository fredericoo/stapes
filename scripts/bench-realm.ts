import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataStore } from "../app/lib/dataStore";
import { MASTERIES } from "../app/lib/mastery";
import { DiskBlobs } from "../server/blobs";
import { Characters } from "../server/characters";
import { openDatabase } from "../server/db";
import { Deaths, INSERT_DEATH_SQL } from "../server/deaths";
import { GameServer } from "../server/GameServer";
import { SocketHub, type WorldContext } from "../server/sockets";
import { WorldStore } from "../server/WorldStore";

/** Production on 2026-11-08: 558 characters and 1,650 deaths. */
const DEFAULT_CHARACTERS = 560;
const DEFAULT_DEATHS = 1_650;
const DEFAULT_ROUNDS = 20;
const MAX_XP = 50_000;
const MASTERIES_KEY_PREFIX = "mast:";

function argValue(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

/**
 * Fills a fresh database to production's size and times the three reads a
 * realm refresh makes, each `rounds` times. Prints one line of JSON, in ms.
 */
async function run(characters: number, deaths: number, rounds: number) {
  const directory = await mkdtemp(join(tmpdir(), "stapes-realm-"));
  const db = await openDatabase(join(directory, "stapes.db"));
  const store = new WorldStore(db);
  const hub = new SocketHub();
  const context: WorldContext = {
    storage: store,
    getWebSockets: () => hub.all(),
    acceptWebSocket: (socket) => hub.accept(socket),
  };
  const server = new GameServer(context, {
    dataStore: new DataStore(new DiskBlobs("data")),
    nameOf: async () => "Realm",
  });

  const now = new Date().toISOString();
  const addUser = await db.prepare(
    "INSERT INTO user (id, name, email, createdAt, updatedAt, username) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const addCharacter = await db.prepare(
    "INSERT INTO character (id, user_id, name, created_at) VALUES (?, ?, ?, ?)",
  );
  const masteries: Record<string, unknown> = {};
  for (let i = 0; i < characters; i++) {
    await addUser.run([`u${i}`, `u${i}`, `u${i}@bench.invalid`, now, now, `u${i}`]);
    await addCharacter.run([`c${i}`, `u${i}`, `Name${i}`, Date.now()]);
    const xp = Object.fromEntries(MASTERIES.map((m) => [m, Math.floor(Math.random() * MAX_XP)]));
    masteries[`${MASTERIES_KEY_PREFIX}c${i}`] = { masteries: xp, savedAt: Date.now() };
  }
  const addDeath = await db.prepare(INSERT_DEATH_SQL);
  for (let i = 0; i < deaths; i++) {
    const victim = `c${i % characters}`;
    const killer = i % 3 === 0 ? `c${(i * 7) % characters}` : null;
    await addDeath.run([Date.now(), victim, victim, 0, 0, 0, "creature", "wolf", killer, null]);
  }
  await store.put(masteries);
  await store.flush();

  const roster = new Characters(db);
  const ledger = new Deaths(db);
  const times = { roster: [] as number[], ratings: [] as number[], counts: [] as number[] };
  for (let round = 0; round < rounds; round++) {
    let t0 = performance.now();
    await roster.roster();
    times.roster.push(performance.now() - t0);
    t0 = performance.now();
    await server.ratings();
    times.ratings.push(performance.now() - t0);
    t0 = performance.now();
    await ledger.counts();
    times.counts.push(performance.now() - t0);
  }

  const summary = Object.fromEntries(
    Object.entries(times).map(([name, list]) => {
      const sorted = [...list].sort((a, b) => a - b);
      return [name, { p50: +percentile(sorted, 0.5).toFixed(2), max: +sorted.at(-1)!.toFixed(2) }];
    }),
  );
  console.log(JSON.stringify({ characters, deaths, rounds, ...summary }));
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
}

await run(
  Number(argValue("--characters") ?? DEFAULT_CHARACTERS),
  Number(argValue("--deaths") ?? DEFAULT_DEATHS),
  Number(argValue("--rounds") ?? DEFAULT_ROUNDS),
);
