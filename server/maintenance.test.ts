import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyMap, replaceStack, serializeMap } from "../app/lib/mapData";
import { PLAYER_TILE_ID } from "../app/game/constants";
import { CLOSE_MAINTENANCE } from "../app/net/protocol";
import { readConfig } from "./config";
import { openDatabase, type Database } from "./db";
import { Maintenance } from "./maintenance";
import { GameSocket } from "./sockets";
import { World } from "./world";

/**
 * Maintenance mode: a row in the database, and the world closing players out.
 *
 * Against a real database file, on the terms `./accounts.test.ts` gives. The
 * point of the switch is that it survives a restart, and a stubbed store would
 * say nothing about that.
 */

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "stapes-maintenance-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("the maintenance row", () => {
  let db: Database;

  beforeEach(async () => {
    db = await openDatabase(join(directory, "stapes.db"));
  });

  afterEach(async () => {
    await db.close?.();
  });

  it("starts open", async () => {
    expect((await Maintenance.load(db)).state).toBeNull();
  });

  /**
   * The reason it is a row and not an environment variable: a world closed for
   * maintenance has to stay closed through the deploys made while it is.
   */
  it("is read back by the next process", async () => {
    await (await Maintenance.load(db)).begin("Back at six.", 1_000);
    await db.close?.();
    db = await openDatabase(join(directory, "stapes.db"));
    expect((await Maintenance.load(db)).state).toEqual({ message: "Back at six.", sinceMs: 1_000 });
  });

  it("keeps when it started across a change of message", async () => {
    const maintenance = await Maintenance.load(db);
    await maintenance.begin("Back at six.", 1_000);
    expect(await maintenance.begin("Back at seven.", 5_000)).toEqual({
      message: "Back at seven.",
      sinceMs: 1_000,
    });
  });

  it("stores a blank message as no message", async () => {
    const maintenance = await Maintenance.load(db);
    expect((await maintenance.begin("   ")).message).toBeNull();
  });

  it("opens again, for this process and the next", async () => {
    const maintenance = await Maintenance.load(db);
    await maintenance.begin(null);
    await maintenance.end();
    expect(maintenance.state).toBeNull();
    expect((await Maintenance.load(db)).state).toBeNull();
  });
});

describe("closing the world", () => {
  let world: World;

  /**
   * A world of one cell to stand on, built here rather than read from
   * `data/map.json` — see `CLAUDE.md`. The tile catalogue is the real one.
   */
  beforeEach(async () => {
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

  it("closes players out and leaves administrators in", async () => {
    const player = socket();
    const admin = socket();
    await world.join(player.socket, "player-actor", { admin: false });
    await world.join(admin.socket, "admin-actor", { admin: true });

    await world.beginMaintenance("Back at six.");

    expect(player.closedWith()).toBe(CLOSE_MAINTENANCE);
    expect(admin.closedWith()).toBeNull();
    expect(world.maintenance.state?.message).toBe("Back at six.");
  });

  it("opens again without touching anybody", async () => {
    const admin = socket();
    await world.join(admin.socket, "admin-actor", { admin: true });
    await world.beginMaintenance(null);

    await world.endMaintenance();

    expect(world.maintenance.state).toBeNull();
    expect(admin.closedWith()).toBeNull();
  });
});
