import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStack } from "../app/lib/mapData";
import { PLAYER_TILE_ID } from "../app/game/constants";
import { readConfig, type Config } from "./config";
import { rowTree } from "./testHarness";
import { World } from "./world";
import { buildWorldMap, prebuildWorldMap, PREBUILT_DIR } from "./worldMap";

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
  async function spawnColumn(world: World): Promise<number> {
    const map = await world.blobs.readMap();
    for (let x = 0; x < 5; x++) {
      if (getStack(map, x, 0, 0).some((p) => p.tileId === PLAYER_TILE_ID)) return x;
    }
    return -1;
  }

  /** Stands a different map in for the prebuilt one, so a test can tell which was played. */
  async function replacePrebuiltWith(tree: string) {
    const tiles = await readFile(join(seed, "tiles.json"), "utf8");
    await writeFile(join(seed, PREBUILT_DIR, "world.map.json"), buildWorldMap(tree, tiles).text);
  }

  it("is played instead of building, when it was built from the same inputs", async () => {
    await prebuildWorldMap(seed, "world.json");
    await replacePrebuiltWith(rowTree(5, 4));

    const world = await World.open(config);

    expect(await spawnColumn(world)).toBe(4);
    await world.drain();
  });

  it("is ignored once the tree has changed since the image built it", async () => {
    await prebuildWorldMap(seed, "world.json");
    await writeFile(join(seed, "world.json"), rowTree(5, 1));

    const world = await World.open(config);

    expect(await spawnColumn(world)).toBe(1);
    await world.drain();
  });
});
