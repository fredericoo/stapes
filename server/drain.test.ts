import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyMap, replaceStack, serializeMap } from "../app/lib/mapData";
import { PLAYER_TILE_ID } from "../app/game/constants";
import { readConfig, type Config } from "./config";
import { openDatabase } from "./db";
import { GameSocket } from "./sockets";
import { World } from "./world";

let directory: string;
let seed: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "stapes-drain-"));
  seed = join(directory, "seed");
  await mkdir(seed, { recursive: true });
  await copyFile("data/tilesets.json", join(seed, "tilesets.json"));
  await copyFile("data/tiles.json", join(seed, "tiles.json"));
  await copyFile("data/statuses.json", join(seed, "statuses.json"));
  await copyFile("data/traits.json", join(seed, "traits.json"));
  let map = emptyMap();
  map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: PLAYER_TILE_ID }]);
  map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
  await writeFile(join(seed, "map.json"), serializeMap(map));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function configWith(): Config {
  return readConfig({ DATA_DIR: join(directory, "data"), SEED_DIR: seed } as never);
}

function socket() {
  let code: number | null = null;
  const made = new GameSocket({
    send: () => {},
    close: (closeCode) => {
      code = closeCode ?? null;
    },
    get closed() {
      return code !== null;
    },
  });
  return { socket: made, closedWith: () => code };
}

async function storedKeys(config: Config): Promise<string[]> {
  const db = await openDatabase(config.databasePath);
  try {
    const rows = (await (await db.prepare("SELECT key FROM kv")).all()) as { key: string }[];
    return rows.map((row) => row.key);
  } finally {
    await db.close?.();
  }
}

describe("draining the world", () => {
  it("stores a connected player who joined after the last periodic save", async () => {
    const config = configWith();
    const world = await World.open(config);
    await world.join(socket().socket, "late-joiner", { admin: false });

    await world.drain();

    expect(await storedKeys(config)).toContain("pos:late-joiner");
  });
});
