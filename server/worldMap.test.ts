import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStack } from "../app/lib/mapData";
import type { MapFile } from "../app/lib/types";
import { GameSocket } from "./sockets";
import { PLAYER_TILE_ID } from "../app/game/constants";
import { readConfig, type Config } from "./config";
import { rowTree } from "./testHarness";
import { World } from "./world";
import {
  buildWorldMap,
  hashOf,
  prebuildWorldMap,
  prepareStartingWorld,
  PREBUILT_DIR,
} from "./worldMap";

let directory: string;
let seed: string;
let config: Config;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "stapes-world-map-"));
  seed = join(directory, "seed");
  await mkdir(seed, { recursive: true });
  for (const name of ["tilesets.json", "tiles.json", "statuses.json", "traits.json"]) {
    await copyFile(join("data", name), join(seed, name));
  }
  await writeFile(join(seed, "world.json"), rowTree(5, 2));
  config = readConfig({ DATA_DIR: join(directory, "data"), SEED_DIR: seed } as never);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("building the world's map at start", () => {
  it("plays the map its tree builds", async () => {
    const world = await World.open(config);

    expect(getStack(await world.blobs.readMap(), 2, 0, 0).map((p) => p.tileId)).toEqual([
      "grass",
      PLAYER_TILE_ID,
    ]);
    await world.drain();
  });

  it("does not build again on a restart with nothing changed", async () => {
    await (await World.open(config)).drain();
    const built = (await stat(join(seed, "map.json"))).mtimeMs;

    const again = await World.open(config);

    expect((await stat(join(seed, "map.json"))).mtimeMs).toBe(built);
    await again.drain();
  });

  it("plays the file it was started with, as staging names a smaller tree", async () => {
    await writeFile(join(seed, "world-staging.json"), rowTree(3, 0));

    const world = await World.open({ ...config, SEED_TREE: "world-staging.json" });

    expect(getStack(await world.blobs.readMap(), 0, 0, 0).map((p) => p.tileId)).toEqual([
      "grass",
      PLAYER_TILE_ID,
    ]);
    await world.drain();
  });
});

describe("the map an image built", () => {
  function playedSpawnColumn(world: World): number {
    const internals = world.server as unknown as { session: { getSpawnPoint(): { x: number } } };
    return internals.session.getSpawnPoint().x;
  }

  async function storedSpawnColumn(world: World): Promise<number> {
    const map = await world.blobs.readMap();
    for (let x = 0; x < 5; x++) {
      if (getStack(map, x, 0, 0).some((p) => p.tileId === PLAYER_TILE_ID)) return x;
    }
    return -1;
  }

  /** Stands a different map in for the prebuilt one, so a test can tell which was played. */
  async function replacePrebuiltWith(tree: string) {
    const tiles = await readFile(join(seed, "tiles.json"), "utf8");
    const { text } = buildWorldMap(tree, tiles);
    await writeFile(join(seed, PREBUILT_DIR, "world.map.json"), text);
    await prepareStartingWorld(seed, join(seed, PREBUILT_DIR, "world"), text);
    await writeFile(join(seed, PREBUILT_DIR, "world.hash"), hashOf(text));
  }

  it("is played instead of building, when it was built from the same inputs", async () => {
    await prebuildWorldMap(seed, "world.json");
    await replacePrebuiltWith(rowTree(5, 4));

    const world = await World.open(config);

    expect(playedSpawnColumn(world)).toBe(4);
    expect(await storedSpawnColumn(world)).toBe(4);
    await world.drain();
  });

  it("is started from the rows the image prepared, without parsing the map at start", async () => {
    await prebuildWorldMap(seed, "world.json");
    await writeFile(join(seed, PREBUILT_DIR, "world.map.json"), "not a map");

    const world = await World.open(config);

    expect(playedSpawnColumn(world)).toBe(2);
    await world.drain();
  });

  it("is built again at a deployed start when the traits changed since the image prepared its rows", async () => {
    await prebuildWorldMap(seed, "world.json");
    await replacePrebuiltWith(rowTree(5, 4));
    const tiles = await readFile(join(seed, "tiles.json"), "utf8");
    await writeFile(
      join(seed, PREBUILT_DIR, "world.map.json"),
      buildWorldMap(rowTree(5, 3), tiles).text,
    );
    await writeFile(join(seed, "traits.json"), "[]");

    const world = await World.open({ ...config, deployed: true });

    expect(playedSpawnColumn(world)).toBe(3);
    await world.drain();
  });

  it("is ignored once the tree has changed since the image built it", async () => {
    await prebuildWorldMap(seed, "world.json");
    await writeFile(join(seed, "world.json"), rowTree(5, 1));

    const world = await World.open(config);

    expect(playedSpawnColumn(world)).toBe(1);
    await world.drain();
  });
});

describe("a start", () => {
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

  function playedTilesAt(world: World, x: number): string[] {
    const internals = world.server as unknown as { session: { getMap(): MapFile } };
    return getStack(internals.session.getMap(), x, 0, 0).map((p) => p.tileId);
  }

  it("puts back what was changed on the board since the last, with the tree unchanged", async () => {
    const before = await World.open(config);
    const admin = socket();
    await before.join(admin, "admin", { admin: true });
    await before.message(
      admin,
      JSON.stringify({ type: "command", text: "/tile cat 4 0 0", requestId: 1 }),
    );
    expect(playedTilesAt(before, 4)).toContain("cat");
    await before.drain();

    const after = await World.open(config);

    expect(playedTilesAt(after, 4)).toEqual(["grass"]);
    await after.drain();
  });

  it("sends a player whose saved cell is gone from the new map to the spawn", async () => {
    await writeFile(join(seed, "world.json"), rowTree(40, 2));
    const before = await World.open(config);
    await before.store.put("pos:alice", { x: 30, y: 0, z: 0, direction: "s", savedAt: Date.now() });
    await before.drain();
    await writeFile(join(seed, "world.json"), rowTree(5, 2));

    const after = await World.open(config);
    await after.join(socket(), "alice", { admin: false });

    expect((await after.server.characterSheet("alice")).position).toMatchObject({
      x: 2,
      y: 0,
      z: 0,
    });
    await after.drain();
  });
});
