import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyMap, replaceStack, serializeMap } from "../app/lib/mapData";
import { PLAYER_TILE_ID } from "../app/game/constants";
import { CLOSE_WORLD_FULL } from "../app/net/protocol";
import { readConfig } from "./config";
import { MAX_ONLINE_PLAYERS } from "./GameServer";
import { GameSocket } from "./sockets";
import { World } from "./world";

/**
 * The limit on how many people may be in the world at once.
 *
 * Against a real `World`, on the terms `./maintenance.test.ts` gives, because
 * the refusal is decided in `World.join` and not in `GameServer`.
 */

let directory: string;
let world: World;

/**
 * A world of one cell to stand on, built here rather than read from
 * `data/map.json` — see `CLAUDE.md`. The tile catalogue is the real one.
 */
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "stapes-capacity-"));
  const seed = join(directory, "seed");
  await mkdir(seed, { recursive: true });
  await copyFile("data/tilesets.json", join(seed, "tilesets.json"));
  await copyFile("data/tiles.json", join(seed, "tiles.json"));
  await copyFile("data/statuses.json", join(seed, "statuses.json"));
  let map = emptyMap();
  map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: PLAYER_TILE_ID }]);
  map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
  await writeFile(join(seed, "map.json"), serializeMap(map));

  world = await World.open(
    readConfig({ DATA_DIR: join(directory, "data"), SEED_DIR: seed } as never),
  );
});

afterEach(async () => {
  await world.drain();
  await rm(directory, { recursive: true, force: true });
});

/** A server-side socket that records how it was closed. */
function socket(): { socket: GameSocket; closedWith: () => number | null } {
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

describe("a full world", () => {
  /**
   * One world filled once for all three, because filling it is 250 joins. A
   * reload takes the seat the player already had rather than a new one.
   */
  it("refuses the next player and lets administrators and reloads in", async () => {
    for (let i = 0; i < MAX_ONLINE_PLAYERS; i++) {
      await world.join(socket().socket, `player-${i}`, { admin: false });
    }

    const late = socket();
    await world.join(late.socket, "late-player", { admin: false });
    expect(late.closedWith()).toBe(CLOSE_WORLD_FULL);

    const admin = socket();
    await world.join(admin.socket, "admin-actor", { admin: true });
    expect(admin.closedWith()).toBeNull();

    const reload = socket();
    await world.join(reload.socket, "player-0", { admin: false });
    expect(reload.closedWith()).toBeNull();
  });

  it("counts administrators towards the limit", async () => {
    await world.join(socket().socket, "admin-actor", { admin: true });
    for (let i = 0; i < MAX_ONLINE_PLAYERS - 1; i++) {
      await world.join(socket().socket, `player-${i}`, { admin: false });
    }
    const late = socket();
    await world.join(late.socket, "late-player", { admin: false });
    expect(late.closedWith()).toBe(CLOSE_WORLD_FULL);
  });

  it("has room again once somebody leaves", async () => {
    const first = socket();
    await world.join(first.socket, "first-player", { admin: false });
    for (let i = 1; i < MAX_ONLINE_PLAYERS; i++) {
      await world.join(socket().socket, `player-${i}`, { admin: false });
    }
    await world.leave(first.socket);
    const late = socket();
    await world.join(late.socket, "late-player", { admin: false });
    expect(late.closedWith()).toBeNull();
  });
});
