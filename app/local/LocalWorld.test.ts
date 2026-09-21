import { describe, expect, it, afterEach } from "vitest";
import tilesJson from "../../data/tiles.json";
import statusesJson from "../../data/statuses.json";
import { GameSocket } from "../../server/sockets";
import { PLAYER_TILE_ID } from "../game/constants";
import { DataStore, type Blobs } from "../lib/dataStore";
import { MAP_FILE_VERSION, type FlatMapFile } from "../lib/types";
import type { CheckpointBatch, Checkpoints, StoredWorld } from "./checkpoints";
import { LocalWorld } from "./LocalWorld";

/**
 * The world, running where the page runs.
 *
 * This is the claim `/admin/play` rests on: that `server/GameServer.ts` — the
 * same file the Bun process runs — comes up in a browser runtime, seats a
 * joiner, simulates a step and writes down where everybody was standing. If it
 * does, the page has nothing left to differ about, because everything above
 * this is the protocol both routes already share.
 *
 * The geometry is built here rather than read out of `data/map.json`: a strip
 * of grass and a spawn marker, so an afternoon's authoring cannot decide
 * whether this passes. The tile catalogue is the real one, because heights and
 * walkability are exactly what a step is about. @see CLAUDE.md
 */

/** Long enough for a tick at 30Hz to have happened several times over. */
const MESSAGE_TIMEOUT_MS = 5000;

/** A strip of grass with the spawn marker at one end. */
function authoredMap(): FlatMapFile {
  const levels: Record<string, Record<string, unknown[]>> = { "0": {} };
  for (let x = 0; x < 8; x++) levels["0"]![`${x},0`] = [{ tileId: "grass" }];
  levels["0"]!["0,0"] = [{ tileId: "grass" }, { tileId: PLAYER_TILE_ID, direction: "s" }];
  return { version: MAP_FILE_VERSION, levels } as FlatMapFile;
}

/** Authored content with no backing store, which is all a world needs to read. */
class MemoryBlobs implements Blobs {
  private readonly entries = new Map<string, string>();

  constructor() {
    this.entries.set("tiles.json", JSON.stringify(tilesJson));
    this.entries.set("statuses.json", JSON.stringify(statusesJson));
    this.entries.set("map.json", JSON.stringify(authoredMap()));
  }

  getText(key: string): Promise<string | null> {
    return Promise.resolve(this.entries.get(key) ?? null);
  }

  getBytes(): Promise<Uint8Array<ArrayBuffer> | null> {
    return Promise.resolve(null);
  }

  put(key: string, body: string | Uint8Array<ArrayBuffer>): Promise<void> {
    this.entries.set(key, typeof body === "string" ? body : "");
    return Promise.resolve();
  }
}

/** A checkpoint store that survives a world, so a restart can be tested. */
function recording(): Checkpoints {
  let world: StoredWorld = { values: new Map(), alarmAtMs: null };
  return {
    load: () => Promise.resolve({ values: new Map(world.values), alarmAtMs: world.alarmAtMs }),
    commit: (batch: CheckpointBatch) => {
      for (const [key, value] of batch.writes) world.values.set(key, value);
      for (const key of batch.deletions) world.values.delete(key);
      if (batch.alarmAtMs !== undefined) world.alarmAtMs = batch.alarmAtMs;
      return Promise.resolve();
    },
    clear: () => {
      world = { values: new Map(), alarmAtMs: null };
      return Promise.resolve();
    },
  };
}

/**
 * One connection, shaped like the worker's.
 *
 * `app/local/world.worker.ts` builds exactly this `GameSocket` around a port; here
 * the frames go into an array instead. Frames are queued rather than delivered
 * to whoever happens to be listening, because a test asks for the next message
 * *after* the call that produced it — @see server/testHarness.ts, which learnt
 * this the same way.
 */
class Connection {
  private readonly queue: string[] = [];
  private isClosed = false;
  readonly socket: GameSocket;
  closeCode: number | null = null;

  constructor() {
    const self = this;
    this.socket = new GameSocket({
      send: (data) => void self.queue.push(data),
      close: (code) => {
        self.isClosed = true;
        self.closeCode = code ?? null;
      },
      get closed() {
        return self.isClosed;
      },
    });
  }

  /** The next frame of a kind, or a failure naming what was seen instead. */
  async next(type: string): Promise<Record<string, unknown>> {
    const deadline = Date.now() + MESSAGE_TIMEOUT_MS;
    const seen: string[] = [];
    while (Date.now() < deadline) {
      while (this.queue.length > 0) {
        const message = JSON.parse(this.queue.shift()!) as Record<string, unknown>;
        if (message.type === type) return message;
        seen.push(String(message.type));
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`No ${type} arrived. Saw: ${seen.join(", ") || "nothing"}`);
  }
}

type Cell = { x: number; y: number; z: number; stack: { tileId: string }[] };

/** Where a body stands in a map as it goes over the wire. */
function playerCells(map: FlatMapFile): string[] {
  const level = (map.levels as Record<string, Record<string, { tileId: string }[]>>)["0"];
  return Object.entries(level ?? {})
    .filter(([, stack]) => stack.some((placed) => placed.tileId === PLAYER_TILE_ID))
    .map(([cell]) => cell);
}

let world: LocalWorld | null = null;

/**
 * A world, checkpointing only when it is asked to.
 *
 * The interval is pushed out of the way rather than left at the two seconds it
 * runs at, so a test that reads the stored world is reading the checkpoint it
 * took and not whichever one the timer happened to land. `stop` flushes, which
 * is how these take one on purpose.
 */
async function open(checkpoints: Checkpoints): Promise<LocalWorld> {
  world = await LocalWorld.open({
    dataStore: new DataStore(new MemoryBlobs()),
    checkpoints,
    checkpointIntervalMs: 60_000,
  });
  return world;
}

afterEach(async () => {
  await world?.stop();
  world = null;
});

describe("the world in a tab", () => {
  it("tells a joiner who they are and hands them the board", async () => {
    const opened = await open(recording());
    const connection = new Connection();

    await opened.join(connection.socket, "alice");
    const hello = await connection.next("hello");

    expect(hello.selfId).toBe("alice");
    expect(hello.actorIds).toEqual(["alice"]);
    // The authored marker is consumed and this player is standing on it.
    expect(playerCells(hello.map as FlatMapFile)).toEqual(["0,0"]);
  });

  it("walks a body when the page asks it to", async () => {
    const opened = await open(recording());
    const connection = new Connection();
    await opened.join(connection.socket, "alice");
    await connection.next("hello");

    await opened.message(
      connection.socket,
      JSON.stringify({ type: "step", seq: 1, direction: "e", preferDescend: false }),
    );

    // The commit, rather than the event that announces the step: what is being
    // asserted is that the simulation moved the body, not that it said so.
    const moved = await untilCommittedAt(connection, 1);
    expect(moved).toBe(true);
  });

  it("gives a returning player the body they left", async () => {
    const checkpoints = recording();
    const first = await open(checkpoints);
    const alice = new Connection();
    await first.join(alice.socket, "alice");
    await alice.next("hello");
    await first.message(
      alice.socket,
      JSON.stringify({ type: "step", seq: 1, direction: "e", preferDescend: false }),
    );
    await untilCommittedAt(alice, 1);
    // A checkpoint, then the world goes. In a tab the checkpoint is the one the
    // interval takes every couple of seconds; here it is taken on purpose, so
    // what is under test is the restore rather than a timer.
    await first.stop();

    const second = await open(checkpoints);
    const returning = new Connection();
    await second.join(returning.socket, "alice");
    const hello = await returning.next("hello");

    // Back where they were standing, not back at the spawn marker.
    expect(playerCells(hello.map as FlatMapFile)).toEqual(["1,0"]);
  });

  /**
   * The Reset world button, which is `POST /api/reset` without the secret —
   * this world is one tab's, so there is nobody to keep it from. Nobody is
   * disconnected: everyone connected is sent a fresh `hello`, which is how the
   * page redraws into the new world without noticing a gap.
   */
  it("puts everybody back on the authored map when the world is reset", async () => {
    const checkpoints = recording();
    const opened = await open(checkpoints);
    const alice = new Connection();
    await opened.join(alice.socket, "alice");
    await alice.next("hello");
    await opened.message(
      alice.socket,
      JSON.stringify({ type: "step", seq: 1, direction: "e", preferDescend: false }),
    );
    await untilCommittedAt(alice, 1);

    await opened.reset();

    const hello = await alice.next("hello");
    expect(playerCells(hello.map as FlatMapFile)).toEqual(["0,0"]);

    // And the world that was written down went with it, so a reload does not
    // bring the old one back.
    const after = await checkpoints.load();
    expect([...after.values.keys()]).not.toContain("world");
  });
});

/**
 * Wait for the patch that puts a body in a cell.
 *
 * A step is answered over several ticks — the walk is announced, then
 * committed — so what the test waits for is the cell, not the next frame.
 */
async function untilCommittedAt(connection: Connection, x: number): Promise<boolean> {
  const deadline = Date.now() + MESSAGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const patch = await connection.next("patch");
    const cells = (patch.cells ?? []) as Cell[];
    const landed = cells.some(
      (cell) =>
        cell.x === x &&
        cell.y === 0 &&
        cell.stack.some((placed) => placed.tileId === PLAYER_TILE_ID),
    );
    if (landed) return true;
  }
  return false;
}
