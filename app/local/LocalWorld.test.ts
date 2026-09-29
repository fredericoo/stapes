import { describe, expect, it, afterEach } from "vitest";
import tilesJson from "../../data/tiles.json";
import statusesJson from "../../data/statuses.json";
import { GameSocket } from "../../server/sockets";
import { PLAYER_TILE_ID } from "../game/constants";
import { DataStore, type Blobs } from "../lib/dataStore";
import { MAP_FILE_VERSION, type FlatMapFile } from "../lib/types";
import type { CheckpointBatch, Checkpoints, StoredWorld } from "./checkpoints";
import { LocalWorld } from "./LocalWorld";

const MESSAGE_TIMEOUT_MS = 5000;

function authoredMap(): FlatMapFile {
  const levels: Record<string, Record<string, unknown[]>> = { "0": {} };
  for (let x = 0; x < 8; x++) levels["0"]![`${x},0`] = [{ tileId: "grass" }];
  levels["0"]!["0,0"] = [{ tileId: "grass" }, { tileId: PLAYER_TILE_ID, direction: "s" }];
  return { version: MAP_FILE_VERSION, levels } as FlatMapFile;
}

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

function playerCells(map: FlatMapFile): string[] {
  const level = (map.levels as Record<string, Record<string, { tileId: string }[]>>)["0"];
  return Object.entries(level ?? {})
    .filter(([, stack]) => stack.some((placed) => placed.tileId === PLAYER_TILE_ID))
    .map(([cell]) => cell);
}

let world: LocalWorld | null = null;

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
    await first.stop();

    const second = await open(checkpoints);
    const returning = new Connection();
    await second.join(returning.socket, "alice");
    const hello = await returning.next("hello");

    expect(playerCells(hello.map as FlatMapFile)).toEqual(["1,0"]);
  });

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

    const after = await checkpoints.load();
    expect([...after.values.keys()]).not.toContain("world");
  });
});

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
