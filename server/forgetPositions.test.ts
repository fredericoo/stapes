import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyMap, replaceStack, serializeMap } from "../app/lib/mapData";
import { PLAYER_TILE_ID } from "../app/game/constants";
import { readConfig, type Config } from "./config";
import { FORGET_POSITIONS_SQL, openDatabase } from "./db";
import { FORGET_POSITIONS_KEY } from "./GameServer";
import { GameSocket } from "./sockets";
import { World } from "./world";

const WIDTH = 10;
const OLD_SPAWN_X = 6;
const NEW_SPAWN_X = 1;
const LATER_SPAWN_X = 2;
const EARNED = { sharp: 40_000, toughness: 9_000 };

let directory: string;
let seed: string;
let config: Config;

async function seedMapWithSpawnAt(spawnX: number) {
  let map = emptyMap();
  for (let x = 0; x < WIDTH; x++) map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
  map = replaceStack(map, spawnX, 0, 0, [{ tileId: "grass" }, { tileId: PLAYER_TILE_ID }]);
  await writeFile(join(seed, "map.json"), serializeMap(map));
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "stapes-forget-"));
  seed = join(directory, "seed");
  await mkdir(seed, { recursive: true });
  for (const name of ["tilesets.json", "tiles.json", "statuses.json", "traits.json"]) {
    await copyFile(join("data", name), join(seed, name));
  }
  config = readConfig({ DATA_DIR: join(directory, "data"), SEED_DIR: seed } as never);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function socket(): GameSocket {
  let closed = false;
  return new GameSocket({
    send: () => {},
    close: () => {
      closed = true;
    },
    get closed() {
      return closed;
    },
  });
}

async function migrateAsTheNewImageDoes() {
  const db = await openDatabase(config.databasePath);
  try {
    await db.exec(FORGET_POSITIONS_SQL);
  } finally {
    await db.close?.();
  }
}

async function storedKeys(): Promise<string[]> {
  const db = await openDatabase(config.databasePath);
  try {
    const rows = (await (await db.prepare("SELECT key FROM kv")).all()) as { key: string }[];
    return rows.map((row) => row.key);
  } finally {
    await db.close?.();
  }
}

async function xOf(world: World, actorId: string): Promise<number | null> {
  return (await world.server.characterSheet(actorId)).position?.x ?? null;
}

describe("the deploy that moves the world onto a new map", () => {
  it("wakes everybody on the new spawn with their kit and masteries, and only once", async () => {
    await seedMapWithSpawnAt(OLD_SPAWN_X);
    const old = await World.open(config);
    await old.store.put("mast:alice", { masteries: EARNED, savedAt: Date.now() });
    await old.join(socket(), "alice", { admin: false });
    const bobsSocket = socket();
    await old.join(bobsSocket, "bob", { admin: false });
    await old.leave(bobsSocket);
    const kit = (await old.server.characterSheet("alice")).equipment;
    expect(await xOf(old, "alice")).toBe(OLD_SPAWN_X);
    await old.drain();

    await migrateAsTheNewImageDoes();
    expect(await storedKeys()).toContain(FORGET_POSITIONS_KEY);

    await seedMapWithSpawnAt(NEW_SPAWN_X);
    const moved = await World.open(config);
    await moved.join(socket(), "alice", { admin: false });
    expect(await xOf(moved, "alice")).toBe(OLD_SPAWN_X);
    expect(await xOf(moved, "bob")).toBe(OLD_SPAWN_X);

    await moved.reseed();

    expect(await xOf(moved, "alice")).toBe(NEW_SPAWN_X);
    expect(await xOf(moved, "bob")).toBeNull();
    const sheet = await moved.server.characterSheet("alice");
    expect(sheet.masteryXp).toEqual(EARNED);
    expect(sheet.equipment).toEqual(kit);
    await moved.join(socket(), "bob", { admin: false });
    expect(await xOf(moved, "bob")).toBe(NEW_SPAWN_X);
    await moved.drain();
    expect(await storedKeys()).not.toContain(FORGET_POSITIONS_KEY);

    await seedMapWithSpawnAt(LATER_SPAWN_X);
    const next = await World.open(config);
    await next.join(socket(), "alice", { admin: false });
    await next.reseed();

    expect(await xOf(next, "alice")).toBe(NEW_SPAWN_X);
    expect(await xOf(next, "bob")).toBe(NEW_SPAWN_X);
    await next.drain();
  });

  it("leaves a world with nothing saved unmarked", async () => {
    await openDatabase(config.databasePath).then((db) => db.close?.());

    await migrateAsTheNewImageDoes();

    expect(await storedKeys()).not.toContain(FORGET_POSITIONS_KEY);
  });
});
