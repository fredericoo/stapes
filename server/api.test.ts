import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyMap, getStack, replaceStack, serializeMap } from "../app/lib/mapData";
import type { MapFile } from "../app/lib/types";
import { PLAYER_TILE_ID } from "../app/game/constants";
import { createApi } from "./api";
import { SEEDED_ADMIN_USERNAME } from "./auth";
import { ClientBundle } from "./clientBundle";
import { readConfig } from "./config";
import { World } from "./world";

const SEEDED_ADMIN_PASSWORD = "salem123";

let directory: string;
let world: World;
let api: ReturnType<typeof createApi>;
let cookie: string;

function startableMap(): MapFile {
  let map = emptyMap();
  map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: PLAYER_TILE_ID }]);
  return replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "stapes-api-"));
  const seed = join(directory, "seed");
  await mkdir(seed, { recursive: true });
  await copyFile("data/tilesets.json", join(seed, "tilesets.json"));
  await copyFile("data/tiles.json", join(seed, "tiles.json"));
  await copyFile("data/statuses.json", join(seed, "statuses.json"));
  await writeFile(join(seed, "map.json"), serializeMap(startableMap()));

  const config = readConfig({ DATA_DIR: join(directory, "data"), SEED_DIR: seed } as never);
  world = await World.open(config);
  api = createApi(world, new ClientBundle(config), config);

  const signedIn = await world.auth.api.signInUsername({
    body: { username: SEEDED_ADMIN_USERNAME, password: SEEDED_ADMIN_PASSWORD },
    asResponse: true,
  });
  cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
});

afterEach(async () => {
  await world.drain();
  await rm(directory, { recursive: true, force: true });
});

function saveMap(map: MapFile): Promise<Response> {
  return api.handle(
    new Request("http://localhost/api/map", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ map: serializeMap(map) }),
    }),
  );
}

async function storedMap(): Promise<string> {
  return serializeMap(await world.blobs.readMap());
}

describe("saving the map", () => {
  it("refuses a map that cannot start a world, and leaves the stored map as it was", async () => {
    const before = await storedMap();
    const markerless = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);

    const response = await saveMap(markerless);

    expect(response.ok).toBe(false);
    expect(await storedMap()).toBe(before);
  });

  it("removes a placement that does not fit before writing, and names it in the response", async () => {
    let map = replaceStack(startableMap(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "barrel" },
      { tileId: "barrel" },
    ]);
    map = replaceStack(map, 1, 0, 1, [{ tileId: "grass" }]);

    const response = await saveMap(map);

    expect(await response.json()).toMatchObject({
      ok: true,
      removed: [{ x: 1, y: 0, z: 0, tileId: "barrel" }],
    });
    expect(getStack(await world.blobs.readMap(), 1, 0, 0)).toEqual([
      { tileId: "grass" },
      { tileId: "barrel" },
    ]);
  });
});
