import { MAP_FILE_VERSION, normalizeTiles } from "../app/lib/types";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Harness, Pair, type TestSocket } from "./testHarness";
import type { WorldStore } from "./WorldStore";
import tilesJson from "../data/tiles.json";
import statusesJson from "../data/statuses.json";
import {
  BRAIN_TICK_MS,
  PLAYER_TILE_ID,
  PUSH_STEP_MS,
  TICK_MS,
  WALK_DURATION_MS,
} from "../app/game/constants";
import { MINUTES_PER_DAY, minutesOfDayAt } from "../app/lib/clock";
import { resolvePush } from "../app/lib/interactions";
import { chunkKeyFor, getStack, listCoords } from "../app/lib/mapData";
import { BODY_REACH_ON_LEVEL, INTEREST_REACH_CHUNKS } from "../app/net/interest";
import { xpForLevel } from "../app/lib/mastery";
import { CHUNK_SIZE, levelKey } from "../app/lib/types";
import type { FlatMapFile, MapFile, TileDef } from "../app/lib/types";
import { tilesByIdFromList } from "../app/lib/validation";
import { CHAT_MIN_INTERVAL_MS } from "../app/net/chat";
import { CLOSE_REPLACED, MAX_STEPS_AHEAD } from "../app/net/protocol";
import { COMBAT_STATUS_ID } from "../app/lib/status";
import { fightingStats, resolveBattler } from "../app/lib/battler";
import { swingWindupMs } from "../app/game/combat";
import { CHAT_LOG_MAX_ROWS, MAX_REMEMBERED_ACTORS, type GameServer } from "./GameServer";

const BAG_TILE_ID = "basic-bag";

const JSON_TYPE = "application/json";

const AUTHORED_CELLS = 4;

function authoredMap(): FlatMapFile {
  const levels: Record<string, Record<string, unknown[]>> = { "0": {} };
  for (let x = 0; x < AUTHORED_CELLS; x++) {
    levels["0"]![`${x},0`] = [{ tileId: "grass" }];
  }
  levels["0"]!["0,0"] = [{ tileId: "grass" }, { tileId: "player", direction: "s" }];
  return { version: MAP_FILE_VERSION, levels } as FlatMapFile;
}

const AWAY_FROM_SPAWN = 2;

const SPAWN_CELL = 0;

const OUTLYING_CELL = CHUNK_SIZE * 2;

const OUTLYING_CHUNK_KEY = `chunk:${levelKey(0)}:${chunkKeyFor(OUTLYING_CELL, 0)}`;

function checkpointWith(owners: string[]): {
  map: FlatMapFile;
  spawn: { x: number; y: number; z: number; stackIndex: number };
} {
  const levels: Record<string, Record<string, unknown[]>> = { "0": {} };
  for (let x = 0; x < 4; x++) {
    levels["0"]![`${x},0`] = [{ tileId: "grass" }];
  }
  levels["0"]![`${AWAY_FROM_SPAWN},0`] = [
    { tileId: "grass" },
    ...owners.map((owner) => ({ tileId: "player", direction: "s", owner })),
  ];
  return {
    map: { version: MAP_FILE_VERSION, levels } as FlatMapFile,
    spawn: { x: 0, y: 0, z: 0, stackIndex: 1 },
  };
}

function playerCells(map: FlatMapFile): number[] {
  const found: number[] = [];
  for (const cells of Object.values(map.levels)) {
    for (const [key, stack] of Object.entries(cells)) {
      for (const placed of stack) {
        if (placed.tileId === "player") found.push(Number(key.split(",")[0]));
      }
    }
  }
  return found.sort();
}

let harness: Harness;

function stub(): Harness["server"] {
  return harness.server;
}

async function runInDurableObject<T>(
  server: Harness["server"],
  fn: (instance: Harness["server"], state: { storage: WorldStore }) => T | Promise<T>,
): Promise<T> {
  return await fn(server, { storage: harness.store });
}

async function runDurableObjectAlarm(server: Harness["server"]): Promise<boolean> {
  await server.alarm();
  return true;
}

function playerOwners(map: FlatMapFile): (string | undefined)[] {
  const found: (string | undefined)[] = [];
  for (const cells of Object.values(map.levels)) {
    for (const stack of Object.values(cells)) {
      for (const placed of stack) {
        if (placed.tileId === "player") found.push(placed.owner);
      }
    }
  }
  return found;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MESSAGE_TIMEOUT_MS = 5000;

function nextMessage(ws: TestSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no message")), MESSAGE_TIMEOUT_MS);
    ws.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(JSON.parse(event.data) as Record<string, unknown>);
      },
      { once: true },
    );
  });
}

function nextMessageOfType(ws: TestSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: { data: string }) => {
      const message = JSON.parse(event.data) as Record<string, unknown>;
      if (message.type !== type) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(message);
    };
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error(`no ${type} message`));
    }, MESSAGE_TIMEOUT_MS);
    ws.addEventListener("message", onMessage);
  });
}

async function connect(actorId: string, { admin = true } = {}) {
  const pair = new Pair();
  const ws = pair.client();
  pair.onClientMessage = (data) => {
    void stub().webSocketMessage(pair.server, data);
  };
  pair.onClientClose = () => {
    harness.hub.drop(pair.server);
    void stub().webSocketClose(pair.server);
  };
  const joined = stub().join(pair.server, actorId, { admin });
  const hello = await nextMessageOfType(ws, "hello");
  await joined;
  return { ws, hello, pair };
}

async function disconnect(pair: Pair) {
  harness.hub.drop(pair.server);
  await stub().webSocketClose(pair.server);
}

async function simulateEviction() {
  harness.evict();
}

async function putCheckpoint(value: unknown) {
  await runInDurableObject(stub(), async (_instance, state) => {
    await state.storage.put("world", value);
  });
}

const STORAGE_POLL_MS = 20;

async function checkpointedGround(): Promise<Record<string, { tileId: string; owner?: string }[]>> {
  return await runInDurableObject(stub(), async (_instance, state) => {
    const stored = await state.storage.list<Record<string, { tileId: string; owner?: string }[]>>({
      prefix: `chunk:${levelKey(0)}:`,
    });
    const ground: Record<string, { tileId: string; owner?: string }[]> = {};
    for (const chunk of stored.values()) Object.assign(ground, chunk);
    return ground;
  });
}

async function waitForCheckpointedAt(actorId: string, cell: string): Promise<void> {
  const deadline = Date.now() + MESSAGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const stack = (await checkpointedGround())[cell] ?? [];
    const standing = stack.some(
      (placed) => placed.tileId === PLAYER_TILE_ID && placed.owner === actorId,
    );
    if (standing) return;
    await new Promise((resolve) => setTimeout(resolve, STORAGE_POLL_MS));
  }
  throw new Error(`${actorId} was never checkpointed at ${cell}`);
}

const NAMES = { alice: "Alice", bob: "Bob" } as const;

beforeEach(async () => {
  harness = await Harness.create(NAMES);
  await harness.blobs.put("tiles.json", JSON.stringify(tilesJson), JSON_TYPE);
  await harness.blobs.put("statuses.json", JSON.stringify(statusesJson), JSON_TYPE);
  await harness.blobs.put("map.json", JSON.stringify(authoredMap()), JSON_TYPE);
});

afterEach(async () => {
  await harness.dispose();
});

describe("joining and leaving", () => {
  it("tells a joiner who they are and who is present", async () => {
    const { hello } = await connect("alice");

    expect(hello.type).toBe("hello");
    expect(hello.selfId).toBe("alice");
    expect(hello.actorIds).toEqual(["alice"]);
    expect(hello.names).toEqual([{ actorId: "alice", name: "Alice" }]);
    expect(playerOwners(hello.map as FlatMapFile)).toEqual(["alice"]);
  });

  it("puts both actors on one board", async () => {
    await connect("alice");
    const { hello } = await connect("bob");

    expect(hello.actorIds).toEqual(["alice", "bob"]);
    expect(playerOwners(hello.map as FlatMapFile).sort()).toEqual(["alice", "bob"]);
  });

  it("consumes the authored marker, leaving no unowned avatar", async () => {
    const { hello } = await connect("alice");
    expect(playerOwners(hello.map as FlatMapFile)).toEqual(["alice"]);
  });

  it("tells an administrator joining how many people are here", async () => {
    const alice = await connect("alice");
    expect(alice.hello.playerCount).toBe(1);

    const bob = await connect("bob");
    expect(bob.hello.playerCount).toBe(2);
  });

  it("lets the event loop run between joins that arrive together", async () => {
    await connect("alice");
    const order: string[] = [];
    const joins = ["bob", "carol", "dave"].map((actorId) => {
      const pair = new Pair();
      pair.client().addEventListener("message", () => {
        if (!order.includes(actorId)) order.push(actorId);
      });
      return stub().join(pair.server, actorId, { admin: false });
    });
    setTimeout(() => order.push("loop"), 0);
    await Promise.all(joins);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(order.filter((one) => one !== "loop")).toEqual(["bob", "carol", "dave"]);
    expect(order.indexOf("loop")).toBeLessThan(order.indexOf("dave"));
  });

  it("does not seat a socket that closed while it waited its turn", async () => {
    await connect("alice");
    const pair = new Pair();
    const joined = stub().join(pair.server, "bob", { admin: false });
    pair.server.close();
    await joined;

    const seated = await runInDurableObject(stub(), (instance: GameServer) => {
      const internals = instance as unknown as { socketsByActor: Map<string, unknown> };
      return internals.socketsByActor.has("bob");
    });
    expect(seated).toBe(false);
  });

  it("does not tell a player joining how many people are here", async () => {
    await connect("alice");
    const bob = await connect("bob", { admin: false });

    expect(bob.hello).not.toHaveProperty("playerCount");
  });

  it("tells an administrator when somebody arrives", async () => {
    const alice = await connect("alice");
    const count = nextMessageOfType(alice.ws, "players");
    await connect("bob", { admin: false });

    expect(await count).toEqual({ type: "players", playerCount: 2 });
  });

  it("tells an administrator when somebody goes, without counting them", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob", { admin: false });
    await nextMessageOfType(alice.ws, "players");

    const count = nextMessageOfType(alice.ws, "players");
    bob.ws.close();

    expect(await count).toEqual({ type: "players", playerCount: 1 });
  });

  it("never sends a player the headcount", async () => {
    const alice = await connect("alice", { admin: false });
    const seen: string[] = [];
    alice.ws.addEventListener("message", (event) => {
      seen.push((JSON.parse(event.data) as { type: string }).type);
    });

    const bob = await connect("bob");
    bob.ws.close();
    await connect("carol");

    expect(seen).not.toContain("players");
  });

  it("removes an actor's tile when their socket closes", async () => {
    const alice = await connect("alice");
    await connect("bob");

    alice.ws.close();
    const { hello } = await connect("carol");

    const owners = playerOwners(hello.map as FlatMapFile).sort();
    expect(owners).toEqual(["bob", "carol"]);
    expect(hello.actorIds).not.toContain("alice");
  });

  it("closes an actor's older socket when they connect again", async () => {
    const first = await connect("alice");
    const second = await connect("alice");

    expect(first.ws.closeCode).toBe(CLOSE_REPLACED);
    expect(second.ws.closeCode).toBeNull();
  });

  it("takes the actor off the board when the newer socket closes before the replaced one's close lands", async () => {
    await connect("alice");
    const second = await connect("alice");

    second.ws.close();
    const { hello } = await connect("carol");

    expect(playerOwners(hello.map as FlatMapFile)).toEqual(["carol"]);
    expect(hello.actorIds).not.toContain("alice");
  });

  it("keeps the body when the replaced socket's close lands late", async () => {
    const first = await connect("alice");
    await connect("alice");

    first.ws.close();
    const { hello } = await connect("carol");

    expect(playerOwners(hello.map as FlatMapFile).sort()).toEqual(["alice", "carol"]);
    expect(hello.actorIds).toContain("alice");
  });

  it("still takes an actor off the board when their last socket closes", async () => {
    const first = await connect("alice");
    const second = await connect("alice");

    first.ws.close();
    second.ws.close();
    const { hello } = await connect("carol");

    expect(playerOwners(hello.map as FlatMapFile)).toEqual(["carol"]);
    expect(hello.actorIds).not.toContain("alice");
  });

  describe("leaving in the middle of a fight", () => {
    const SETTLE_MS = 300;
    const LETHAL_DAMAGE = 10_000;

    async function hurt(ws: TestSocket) {
      const flagged = messageWithin(ws, "statuses", MESSAGE_TIMEOUT_MS);
      send(ws, { type: "command", text: "/health -1" });
      expect(await flagged).not.toBeNull();
    }

    async function endCombat(actorId: string) {
      await runInDurableObject(stub(), (instance: GameServer) => {
        const internals = instance as unknown as {
          session: {
            statusesOf(id: string): { defId: string; remainingMs: number }[] | null;
          };
        };
        for (const status of internals.session.statusesOf(actorId) ?? []) {
          if (status.defId === COMBAT_STATUS_ID) status.remainingMs = 1;
        }
      });
    }

    function departureWithin(ws: TestSocket, actorId: string, ms: number): Promise<boolean> {
      return new Promise((resolve) => {
        const done = (left: boolean) => {
          clearTimeout(timer);
          ws.removeEventListener("message", onMessage);
          resolve(left);
        };
        const onMessage = (event: { data: string }) => {
          const message = JSON.parse(event.data) as {
            type?: string;
            events?: { kind: string; actorId?: string }[];
          };
          if (message.type !== "patch") return;
          const left = message.events?.some((e) => e.kind === "left" && e.actorId === actorId);
          if (left) done(true);
        };
        const timer = setTimeout(() => done(false), ms);
        ws.addEventListener("message", onMessage);
      });
    }

    it("keeps the body on the board after the last socket closes", async () => {
      const alice = await connect("alice");
      await hurt(alice.ws);

      await disconnect(alice.pair);
      const { hello } = await connect("carol");

      expect(playerOwners(hello.map as FlatMapFile).sort()).toEqual(["alice", "carol"]);
      expect(hello.actorIds).toContain("alice");
    });

    it("takes the body off once the fight is over, and says so only then", async () => {
      const alice = await connect("alice");
      const bob = await connect("bob");
      await hurt(alice.ws);

      await disconnect(alice.pair);
      expect(await departureWithin(bob.ws, "alice", SETTLE_MS)).toBe(false);

      const departure = departureWithin(bob.ws, "alice", MESSAGE_TIMEOUT_MS);
      await endCombat("alice");
      expect(await departure).toBe(true);

      const { hello } = await connect("carol");
      expect(playerOwners(hello.map as FlatMapFile).sort()).toEqual(["bob", "carol"]);
    });

    it("hands the body back to a player who returns mid-fight", async () => {
      const alice = await connect("alice");
      await hurt(alice.ws);
      await disconnect(alice.pair);

      const back = await connect("alice");
      expect(playerOwners(back.hello.map as FlatMapFile)).toEqual(["alice"]);
      expect((back.hello.statuses as { defId: string }[]).map((s) => s.defId)).toContain(
        COMBAT_STATUS_ID,
      );

      await endCombat("alice");
      await wait(SETTLE_MS);
      const { hello } = await connect("carol");
      expect(playerOwners(hello.map as FlatMapFile).sort()).toEqual(["alice", "carol"]);
    });

    it("writes down the death of a body left standing in a fight", async () => {
      const alice = await connect("alice");
      await hurt(alice.ws);
      await disconnect(alice.pair);

      type Internals = {
        session: {
          actors: Map<string, unknown>;
          actorIds(): Iterable<string>;
          applyDamage(actor: unknown, amount: number): void;
        };
        saveActors(actorIds: Iterable<string>, force: boolean): void;
        tick(): void;
      };
      await runInDurableObject(stub(), (instance: GameServer) => {
        const internals = instance as unknown as Internals;
        internals.saveActors(internals.session.actorIds(), true);
      });
      const hurtRow = await runInDurableObject(stub(), (_instance, state) =>
        state.storage.get<{ hp: number | null }>("hp:alice"),
      );
      expect(hurtRow?.hp).toBeGreaterThan(0);

      await runInDurableObject(stub(), (instance: GameServer) => {
        const internals = instance as unknown as Internals;
        const body = internals.session.actors.get("alice");
        internals.session.applyDamage(body, LETHAL_DAMAGE);
        internals.tick();
      });

      const deadRow = await runInDurableObject(stub(), (_instance, state) =>
        state.storage.get<{ hp: number | null }>("hp:alice"),
      );
      expect(deadRow?.hp).toBeNull();
    });

    it("lets the body go at the cap, even while the fight is still on", async () => {
      const alice = await connect("alice");
      const bob = await connect("bob");
      await hurt(alice.ws);
      await disconnect(alice.pair);

      const departure = departureWithin(bob.ws, "alice", MESSAGE_TIMEOUT_MS);
      await runInDurableObject(stub(), (instance: GameServer) => {
        const internals = instance as unknown as {
          lingering: Map<string, number>;
        };
        internals.lingering.set("alice", Date.now() - 1);
      });

      expect(await departure).toBe(true);
    });
  });
});

const CLOCK_TOLERANCE_MINUTES = 10;

function minutesApart(a: number, b: number): number {
  const d = Math.abs(a - b) % MINUTES_PER_DAY;
  return Math.min(d, MINUTES_PER_DAY - d);
}

describe("time of day", () => {
  it("hands every joiner the server's clock", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");

    const serverNow = minutesOfDayAt(Date.now());
    for (const hello of [alice.hello, bob.hello]) {
      expect(typeof hello.minutesOfDay).toBe("number");
      expect(minutesApart(hello.minutesOfDay as number, serverNow)).toBeLessThan(
        CLOCK_TOLERANCE_MINUTES,
      );
    }
  });

  it("keeps time across an eviction", async () => {
    await putCheckpoint(checkpointWith([]));
    await simulateEviction();

    const { hello } = await connect("alice");

    expect(minutesApart(hello.minutesOfDay as number, minutesOfDayAt(Date.now()))).toBeLessThan(
      CLOCK_TOLERANCE_MINUTES,
    );
  });

  it("moves everybody to the hour /time names, and keeps it", async () => {
    const sixPmMinutes = 18 * 60;
    const alice = await connect("alice");
    const bob = await connect("bob");

    command(alice.ws, "/time 18:00");

    const clock = await nextMessageOfType(bob.ws, "clock");
    expect(clock.minutesOfDay).toBe(sixPmMinutes);

    await simulateEviction();
    const carol = await connect("carol");
    expect(minutesApart(carol.hello.minutesOfDay as number, sixPmMinutes)).toBeLessThan(
      CLOCK_TOLERANCE_MINUTES,
    );
  });
});

describe("surviving eviction", () => {
  it("resumes a checkpoint whose marker was already consumed", async () => {
    await putCheckpoint(checkpointWith([]));
    await simulateEviction();

    const { hello } = await connect("alice");

    expect(hello.selfId).toBe("alice");
    expect(playerOwners(hello.map as FlatMapFile)).toEqual(["alice"]);
  });

  it("does not give a returning actor a second body", async () => {
    await putCheckpoint(checkpointWith(["alice"]));
    await simulateEviction();

    const { hello } = await connect("alice");

    expect(playerOwners(hello.map as FlatMapFile)).toEqual(["alice"]);
    expect(playerCells(hello.map as FlatMapFile)).toEqual([AWAY_FROM_SPAWN]);
  });

  it("reaps actors left in the checkpoint with no socket", async () => {
    await putCheckpoint(checkpointWith(["ghost"]));
    await simulateEviction();

    const { hello } = await connect("alice");

    expect(playerOwners(hello.map as FlatMapFile)).toEqual(["alice"]);
  });
});

const DEER_CELL = 3;

function tilesWithDeer() {
  return [
    ...(tilesJson as unknown[]),
    {
      id: "deer",
      name: "Deer",
      type: "simple",
      height: 2,
      attributes: {},
      actor: true,
      affectedByGravity: true,
      walkable: false,
    },
  ];
}

function mapWithDeer(): FlatMapFile {
  const map = authoredMap();
  map.levels["0"]![`${DEER_CELL},0`] = [{ tileId: "grass" }, { tileId: "deer" }];
  return map;
}

function deerCells(map: FlatMapFile): number[] {
  const found: number[] = [];
  for (const cells of Object.values(map.levels)) {
    for (const [key, stack] of Object.entries(cells)) {
      for (const placed of stack) {
        if (placed.tileId === "deer") found.push(Number(key.split(",")[0]));
      }
    }
  }
  return found.sort();
}

describe("residents", () => {
  beforeEach(async () => {
    await harness.blobs.put("tiles.json", JSON.stringify(tilesWithDeer()), JSON_TYPE);
    await harness.blobs.put("map.json", JSON.stringify(mapWithDeer()), JSON_TYPE);
  });

  it("is in the world a joiner is handed, driving itself", async () => {
    const { hello } = await connect("alice");

    expect(deerCells(hello.map as FlatMapFile)).toEqual([DEER_CELL]);
    expect(hello.actorIds).toEqual(expect.arrayContaining([expect.stringMatching(/^npc:/)]));
  });

  it("looks the same to everybody in the room", async () => {
    const alice = await connect("alice");
    const { hello } = await connect("bob");

    expect(deerCells(alice.hello.map as FlatMapFile)).toEqual(deerCells(hello.map as FlatMapFile));
  });

  it("survives an eviction, in place and unduplicated", async () => {
    await connect("alice");
    await simulateEviction();

    const { hello } = await connect("bob");

    expect(deerCells(hello.map as FlatMapFile)).toEqual([DEER_CELL]);
  });
});

describe("the checkpointed board", () => {
  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
  }

  async function storedBoard() {
    return await runInDurableObject(stub(), async (_instance, state) => {
      const meta = await state.storage.get<Record<string, unknown>>("world");
      const chunks = await state.storage.list({ prefix: "chunk:" });
      return { meta, chunkKeys: [...chunks.keys()] };
    });
  }

  it("keeps the board under a key per chunk", async () => {
    await connect("alice");
    await settle();

    const { meta, chunkKeys } = await storedBoard();
    expect(meta).toBeDefined();
    expect(meta!.map).toBeUndefined();
    expect(meta!.spawn).toBeDefined();
    expect(chunkKeys.length).toBeGreaterThan(0);
  });

  it("writes a legacy whole-map checkpoint back out as chunks", async () => {
    await putCheckpoint(checkpointWith(["alice"]));
    await connect("alice");
    expect(await actorX("alice")).toBe(AWAY_FROM_SPAWN);

    await settle();

    const { meta, chunkKeys } = await storedBoard();
    expect(meta!.map).toBeUndefined();
    expect(chunkKeys.length).toBeGreaterThan(0);
  });

  it("falls back to the authored map when the chunks are missing", async () => {
    await putCheckpoint({ spawn: { x: 0, y: 0, z: 0, stackIndex: 1 } });

    const { hello } = await connect("alice");

    expect(playerOwners(hello.map as FlatMapFile)).toEqual(["alice"]);
    const ground = (hello.map as FlatMapFile).levels["0"] ?? {};
    expect(Object.keys(ground).length).toBe(AUTHORED_CELLS);
  });

  it("forgets the old board when the world is replaced", async () => {
    await connect("alice");
    await settle();
    const orphan = "chunk:9:99,99";
    await runInDurableObject(stub(), async (_instance, state) => {
      await state.storage.put(orphan, { "1584,1584": [{ tileId: "grass" }] });
    });

    await stub().replaceWorld(authoredMap());
    await settle();

    const { chunkKeys } = await storedBoard();
    expect(chunkKeys).not.toContain(orphan);
    expect(chunkKeys.length).toBeGreaterThan(0);
  });
});

describe("replacing the world", () => {
  it("persists the authored map and restarts everyone on it", async () => {
    const alice = await connect("alice");

    const fresh = nextMessage(alice.ws);
    const replacement = authoredMap();
    await stub().replaceWorld(replacement);
    const hello = await fresh;

    expect(hello.type).toBe("hello");
    expect(playerOwners(hello.map as FlatMapFile)).toEqual(["alice"]);

    const stored = await harness.blobs.getText("map.json");
    const text = stored!;
    expect(text).not.toContain('"owner"');
  });

  it("keeps everybody's name across a save", async () => {
    const alice = await connect("alice");

    const fresh = nextMessage(alice.ws);
    await stub().replaceWorld(authoredMap());
    const hello = await fresh;

    expect(hello.names).toEqual([{ actorId: "alice", name: "Alice" }]);
  });

  it("keeps a connected player where they stood when asked to", async () => {
    const alice = await connect("alice");
    await walkEast(alice.ws);
    expect(await actorX("alice")).toBe(ONE_STEP_EAST);

    const fresh = nextMessageOfType(alice.ws, "hello");
    await stub().replaceWorld(authoredMap(), { keepPositions: true });
    await fresh;

    expect(await actorX("alice")).toBe(ONE_STEP_EAST);
  });

  it("restarts a connected player at spawn when nobody asks", async () => {
    const alice = await connect("alice");
    await walkEast(alice.ws);
    expect(await actorX("alice")).toBe(ONE_STEP_EAST);

    const fresh = nextMessageOfType(alice.ws, "hello");
    await stub().replaceWorld(authoredMap());
    await fresh;

    expect(await actorX("alice")).toBe(SPAWN_CELL);
  });

  it("leaves a connected player carrying what they were carrying", async () => {
    const withSword = authoredMap();
    withSword.levels["0"]!["1,0"] = [{ tileId: "grass" }, { tileId: "rusty-sword" }];
    await harness.blobs.put("map.json", JSON.stringify(withSword), JSON_TYPE);

    const alice = await connect("alice");
    const bagId = kitOf(alice.hello).bag.id;

    send(alice.ws, { type: "pickUp", ref: { x: 1, y: 0, z: 0, stackIndex: 1 } });
    const armed = (await equipmentWithin(alice.ws))!;
    expect(contentsOf(armed).map((i) => i.tileId)).toEqual(["rusty-sword"]);

    const fresh = nextMessageOfType(alice.ws, "hello");
    await stub().replaceWorld(withSword);
    const hello = await fresh;

    expect(kitOf(hello).bag.id).toBe(bagId);
    expect(contentsOf(hello).map((i) => i.tileId)).toEqual(["rusty-sword"]);
  });

  it("arms a player from the floor when they ask to equip", async () => {
    const withSword = authoredMap();
    withSword.levels["0"]!["1,0"] = [{ tileId: "grass" }, { tileId: "rusty-sword" }];
    await harness.blobs.put("map.json", JSON.stringify(withSword), JSON_TYPE);

    const alice = await connect("alice");
    send(alice.ws, { type: "equip", ref: { x: 1, y: 0, z: 0, stackIndex: 1 } });
    const armed = (await equipmentWithin(alice.ws))!;

    const equipment = armed.equipment as { weapon: { tileId: string } | null };
    expect(equipment.weapon?.tileId).toBe("rusty-sword");
    expect(contentsOf(armed)).toEqual([]);
  });

  it("puts the authored floor items back regardless", async () => {
    const withSword = authoredMap();
    withSword.levels["0"]!["1,0"] = [{ tileId: "grass" }, { tileId: "rusty-sword" }];
    await harness.blobs.put("map.json", JSON.stringify(withSword), JSON_TYPE);

    const alice = await connect("alice");
    send(alice.ws, { type: "pickUp", ref: { x: 1, y: 0, z: 0, stackIndex: 1 } });
    await equipmentWithin(alice.ws);

    const fresh = nextMessageOfType(alice.ws, "hello");
    await stub().replaceWorld(withSword);
    const hello = await fresh;

    const stack = (hello.map as FlatMapFile).levels["0"]!["1,0"]!;
    expect(stack.map((p) => p.tileId)).toContain("rusty-sword");
  });

  it("checks the kit it carries over against the catalogue the save brought", async () => {
    const withSword = authoredMap();
    withSword.levels["0"]!["1,0"] = [{ tileId: "grass" }, { tileId: "rusty-sword" }];
    await harness.blobs.put("map.json", JSON.stringify(withSword), JSON_TYPE);

    const alice = await connect("alice");
    const bagId = kitOf(alice.hello).bag.id;
    send(alice.ws, { type: "pickUp", ref: { x: 1, y: 0, z: 0, stackIndex: 1 } });
    await equipmentWithin(alice.ws);

    const asProps = (tilesJson as Array<Record<string, unknown>>).map((t) =>
      t.id === "rusty-sword" ? { ...t, kind: "prop" } : t,
    );
    await harness.blobs.put("tiles.json", JSON.stringify(asProps), JSON_TYPE);

    const fresh = nextMessageOfType(alice.ws, "hello");
    await stub().replaceWorld(withSword);
    const hello = await fresh;

    expect(kitOf(hello).bag.id).toBe(bagId);
    expect(contentsOf(hello)).toEqual([]);
  });

  it("drops the previous world's checkpoint", async () => {
    const who = freshPlayer();
    const previous = checkpointWith([who]);
    const outlying = `${OUTLYING_CELL},0`;
    previous.map.levels["0"]![outlying] = [{ tileId: "water" }];
    await putCheckpoint(previous);

    await connect(who);
    await waitForCheckpointedAt(who, `${AWAY_FROM_SPAWN},0`);
    expect(await storedKeys("chunk:")).toContain(OUTLYING_CHUNK_KEY);

    await stub().replaceWorld(authoredMap());
    await waitForCheckpointedAt(who, `${SPAWN_CELL},0`);
    await simulateEviction();

    const { hello } = await connect(who);
    const ground = (hello.map as FlatMapFile).levels["0"] ?? {};
    expect(ground[outlying]).toBeUndefined();
    expect(Object.keys(ground).length).toBe(AUTHORED_CELLS);
  });
});

describe("finding authored content", () => {});

function checkpointOnTwoLevels(): {
  map: FlatMapFile;
  spawn: { x: number; y: number; z: number; stackIndex: number };
} {
  const ground: Record<string, unknown[]> = {};
  const upstairs: Record<string, unknown[]> = {};
  for (let x = 0; x < 4; x++) {
    ground[`${x},0`] = [{ tileId: "grass" }];
    upstairs[`${x},0`] = [{ tileId: "grass" }];
  }
  ground["0,0"] = [{ tileId: "grass" }, { tileId: "player", direction: "s", owner: "alice" }];
  upstairs["2,0"] = [{ tileId: "grass" }, { tileId: "player", direction: "s", owner: "bob" }];
  return {
    map: { version: MAP_FILE_VERSION, levels: { "0": ground, "1": upstairs } } as FlatMapFile,
    spawn: { x: 0, y: 0, z: 0, stackIndex: 0 },
  };
}

function chatWithin(ws: TestSocket, ms: number): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const done = (value: Record<string, unknown> | null) => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(value);
    };
    const onMessage = (event: { data: string }) => {
      const message = JSON.parse(event.data) as Record<string, unknown>;
      if (message.type === "chat") done(message);
    };
    const timer = setTimeout(() => done(null), ms);
    ws.addEventListener("message", onMessage);
  });
}

const QUIET_MS = 200;

function say(ws: TestSocket, text: string) {
  ws.send(JSON.stringify({ type: "say", text }));
}

function command(ws: TestSocket, text: string) {
  ws.send(JSON.stringify({ type: "command", text }));
}

async function isTicking(): Promise<boolean> {
  let ticking = false;
  await runInDurableObject(stub(), (instance: GameServer) => {
    ticking = (instance as unknown as Record<string, unknown>).timer !== null;
  });
  return ticking;
}

async function chatRows(): Promise<Record<string, unknown>[]> {
  return await harness.query("SELECT * FROM chat ORDER BY id");
}

describe("chat", () => {
  async function twoLevels() {
    const alice = await connect("alice");
    const bob = await connect("bob");
    await putCheckpoint(checkpointOnTwoLevels());
    await simulateEviction();
    return { alice, bob };
  }

  it("reaches the people standing on the same floor", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");

    say(alice.ws, "hey there!");

    const heard = await chatWithin(bob.ws, 1000);
    expect(heard).toMatchObject({
      type: "chat",
      actorId: "alice",
      text: "hey there!",
      tileId: PLAYER_TILE_ID,
    });
  });

  it("comes back to its own author", async () => {
    const alice = await connect("alice");
    say(alice.ws, "hey there!");

    expect(await chatWithin(alice.ws, 1000)).toMatchObject({
      type: "chat",
      text: "hey there!",
    });
  });

  it("does not reach another floor", async () => {
    const { alice, bob } = await twoLevels();

    say(alice.ws, "hey there!");

    expect(await chatWithin(bob.ws, QUIET_MS)).toBeNull();
  });

  it("still reaches the author on their own floor after the restore", async () => {
    const { alice } = await twoLevels();

    say(alice.ws, "hey there!");

    expect(await chatWithin(alice.ws, 1000)).toMatchObject({
      type: "chat",
      actorId: "alice",
    });
  });

  it("pins the message to the cell its author was standing in", async () => {
    const { alice } = await twoLevels();

    say(alice.ws, "hey there!");

    const heard = await chatWithin(alice.ws, 1000);
    expect(heard).toMatchObject({ x: 0, y: 0, z: 0 });
    expect(typeof heard!.stackIndex).toBe("number");
  });

  it("drops a second message sent too soon after the first", async () => {
    const alice = await connect("alice");

    say(alice.ws, "first");
    say(alice.ws, "second");

    expect(await chatWithin(alice.ws, 1000)).toMatchObject({
      text: "first",
    });
    expect(await chatWithin(alice.ws, QUIET_MS)).toBeNull();
  });

  it("drops a message with nothing drawable left in it", async () => {
    const alice = await connect("alice");

    say(alice.ws, "🎉🎉🎉");

    expect(await chatWithin(alice.ws, QUIET_MS)).toBeNull();
  });

  it("goes back to sleep once the word has been heard", async () => {
    const alice = await connect("alice");
    await wait(QUIET_MS);
    expect(await isTicking()).toBe(false);

    say(alice.ws, "hey there!");
    await chatWithin(alice.ws, 1000);
    await wait(BRAIN_TICK_MS + QUIET_MS);

    expect(await isTicking()).toBe(false);
  });

  it("keeps what was said", async () => {
    const alice = await connect("alice");
    say(alice.ws, "hey there!");
    await chatWithin(alice.ws, 1000);

    expect(await chatRows()).toMatchObject([
      { actor: "alice", text: "hey there!", x: 0, y: 0, z: 0 },
    ]);
  });

  it("keeps the log at its cap", async () => {
    const alice = await connect("alice");
    say(alice.ws, "hey there!");
    await chatWithin(alice.ws, 1000);

    for (let i = 0; i < CHAT_LOG_MAX_ROWS + 100; i++) {
      harness.store.sql.exec(
        "INSERT INTO chat (at, actor, x, y, z, text) VALUES (0, 'backfill', 0, 0, 0, 'old')",
      );
    }
    await harness.store.flush();

    const beforePrune = await chatRows();
    expect(beforePrune.length).toBeGreaterThan(CHAT_LOG_MAX_ROWS);

    await wait(CHAT_MIN_INTERVAL_MS);
    say(alice.ws, "and another");
    await chatWithin(alice.ws, 1000);

    expect(await chatRows()).toHaveLength(CHAT_LOG_MAX_ROWS);
  });
});

describe("calling a creature", () => {
  function checkpointWithCat(): {
    map: FlatMapFile;
    spawn: { x: number; y: number; z: number; stackIndex: number };
  } {
    const ground: Record<string, unknown[]> = {};
    for (let x = 0; x < 6; x++) ground[`${x},0`] = [{ tileId: "grass" }];
    ground["0,0"] = [{ tileId: "grass" }, { tileId: "player", direction: "s", owner: "alice" }];
    ground["3,0"] = [{ tileId: "grass" }, { tileId: "cat" }];
    return {
      map: { version: MAP_FILE_VERSION, levels: { "0": ground } } as FlatMapFile,
      spawn: { x: 0, y: 0, z: 0, stackIndex: 0 },
    };
  }

  async function withCat() {
    const alice = await connect("alice");
    await putCheckpoint(checkpointWithCat());
    await simulateEviction();
    return alice;
  }

  it("answers somebody who calls it", async () => {
    const alice = await withCat();

    say(alice.ws, "psps");

    expect(await noiseWithin(alice.ws, 2000)).toMatchObject({
      type: "noise",
      text: "meow",
    });
  });

  it("says nothing back to a line that was not a call", async () => {
    const alice = await withCat();

    say(alice.ws, "hello there");

    expect(await noiseWithin(alice.ws, QUIET_MS * 4)).toBeNull();
  });

  it("tells the room about a body summoned into it", async () => {
    const alice = await connect("alice");

    command(alice.ws, "/tile deer +1");

    const spawned = await eventWithin(alice.ws, "spawned", 2000);
    expect(spawned).toMatchObject({ kind: "spawned" });
    expect(spawned?.actorId).toBe("npc:1,0,0,1");
  });

  it("does not announce the actors a hello already named", async () => {
    const alice = await withCat();
    const seen = record(alice.ws);

    await wait(QUIET_MS * 4);

    const spawns = seen
      .of("patch")
      .flatMap((message) => message.events as Record<string, unknown>[])
      .filter((event) => event.kind === "spawned");
    expect(spawns).toEqual([]);
  });
});

function send(ws: TestSocket, message: unknown) {
  ws.send(JSON.stringify(message));
}

function equipmentWithin(ws: TestSocket) {
  return messageWithin(ws, "equipment", 1000);
}

function contentsOf(message: Record<string, unknown>): Array<{ tileId: string }> {
  const equipment = message.equipment as {
    bag: { contents?: Array<{ tileId: string }> } | null;
  };
  return equipment.bag?.contents ?? [];
}

function step(ws: TestSocket, seq: number, direction: string) {
  ws.send(JSON.stringify({ type: "step", seq, direction, preferDescend: false }));
}

function noiseWithin(ws: TestSocket, ms: number) {
  return messageWithin(ws, "noise", ms);
}

function messageWithin(
  ws: TestSocket,
  type: string,
  ms: number,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const done = (value: Record<string, unknown> | null) => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(value);
    };
    const onMessage = (event: { data: string }) => {
      const message = JSON.parse(event.data) as Record<string, unknown>;
      if (message.type === type) done(message);
    };
    const timer = setTimeout(() => done(null), ms);
    ws.addEventListener("message", onMessage);
  });
}

function record(ws: TestSocket) {
  ws.discardPending();
  const seen: Record<string, unknown>[] = [];
  ws.addEventListener("message", (event) => {
    seen.push(JSON.parse(event.data) as Record<string, unknown>);
  });
  return {
    types: () => seen.map((message) => message.type as string),
    of: (type: string) => seen.filter((message) => message.type === type),
  };
}

function eventWithin(
  ws: TestSocket,
  kind: string,
  ms: number,
  matches: (event: Record<string, unknown>) => boolean = () => true,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const done = (value: Record<string, unknown> | null) => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(value);
    };
    const onMessage = (event: { data: string }) => {
      const message = JSON.parse(event.data) as Record<string, unknown>;
      if (message.type !== "patch") return;
      const events = message.events as Record<string, unknown>[];
      const found = events.find((e) => e.kind === kind && matches(e));
      if (found) done(found);
    };
    const timer = setTimeout(() => done(null), ms);
    ws.addEventListener("message", onMessage);
  });
}

function walkWithin(ws: TestSocket, ms: number): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const done = (value: Record<string, unknown> | null) => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(value);
    };
    const onMessage = (event: { data: string }) => {
      const message = JSON.parse(event.data) as Record<string, unknown>;
      if (message.type !== "patch") return;
      const events = message.events as Record<string, unknown>[];
      const walk = events.find((e) => e.kind === "walkStarted");
      if (walk) done(walk);
    };
    const timer = setTimeout(() => done(null), ms);
    ws.addEventListener("message", onMessage);
  });
}

async function actorX(actorId: string): Promise<number | null> {
  let found: number | null = null;
  await runInDurableObject(stub(), (instance: GameServer) => {
    const internals = instance as unknown as {
      session: { actorSnapshots(): { id: string; x: number }[] } | null;
    };
    const actor = internals.session?.actorSnapshots().find((a) => a.id === actorId);
    found = actor ? actor.x : null;
  });
  return found;
}

describe("stepping", () => {
  it("walks an actor that says it has taken a step", async () => {
    const { ws } = await connect("alice");
    step(ws, 0, "e");

    const walk = await walkWithin(ws, 1000);
    expect(walk).toMatchObject({
      actorId: "alice",
      from: { x: 0, y: 0, z: 0 },
      to: { x: 1, y: 0, z: 0 },
      direction: "e",
    });
  });

  it("commits the step to the board", async () => {
    const { ws } = await connect("alice");
    step(ws, 0, "e");
    await walkWithin(ws, 1000);

    await new Promise((resolve) => setTimeout(resolve, WALK_DURATION_MS + 200));
    expect(await actorX("alice")).toBe(1);
  });

  it("turns an actor asked only to face", async () => {
    const { ws } = await connect("alice");
    ws.send(JSON.stringify({ type: "face", direction: "n" }));

    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
    let facing: string | undefined;
    await runInDurableObject(stub(), (instance: GameServer) => {
      const internals = instance as unknown as {
        session: { actorSnapshots(): { id: string; direction: string }[] } | null;
      };
      facing = internals.session?.actorSnapshots().find((a) => a.id === "alice")?.direction;
    });
    expect(facing).toBe("n");
    expect(await actorX("alice")).toBe(0);
  });

  it("keeps a turn sent straight after a step, once the step lands", async () => {
    const { ws } = await connect("alice");
    step(ws, 0, "e");
    ws.send(JSON.stringify({ type: "face", direction: "n" }));

    await new Promise((resolve) => setTimeout(resolve, WALK_DURATION_MS + 200));
    let facing: string | undefined;
    await runInDurableObject(stub(), (instance: GameServer) => {
      const internals = instance as unknown as {
        session: { actorSnapshots(): { id: string; direction: string }[] } | null;
      };
      facing = internals.session?.actorSnapshots().find((a) => a.id === "alice")?.direction;
    });
    expect(await actorX("alice")).toBe(1);
    expect(facing).toBe("n");
  });

  it("refuses a step further ahead than it will hold", async () => {
    const { ws } = await connect("alice");
    for (let seq = 0; seq <= MAX_STEPS_AHEAD; seq++) step(ws, seq, "e");

    expect(await messageWithin(ws, "stepRejected", 1000)).toEqual({
      type: "stepRejected",
      seq: MAX_STEPS_AHEAD,
    });
  });

  it("holds as many steps as a client may draw ahead", async () => {
    const { ws } = await connect("alice");
    for (let seq = 0; seq < MAX_STEPS_AHEAD; seq++) step(ws, seq, "e");

    expect(await messageWithin(ws, "stepRejected", QUIET_MS)).toBeNull();
  });

  it("tells only the client whose step it was", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");

    for (let seq = 0; seq <= MAX_STEPS_AHEAD; seq++) step(alice.ws, seq, "e");

    expect(await messageWithin(alice.ws, "stepRejected", 1000)).not.toBeNull();
    expect(await messageWithin(bob.ws, "stepRejected", QUIET_MS)).toBeNull();
  });

  it("walks the second of two steps that arrived together", async () => {
    const { ws } = await connect("alice");
    step(ws, 0, "e");
    step(ws, 1, "e");

    await new Promise((resolve) => setTimeout(resolve, WALK_DURATION_MS * 2 + 300));
    expect(await actorX("alice")).toBe(2);
  });

  it("goes back to sleep once the steps are walked", async () => {
    const { ws } = await connect("alice");
    step(ws, 0, "e");

    await new Promise((resolve) => setTimeout(resolve, WALK_DURATION_MS + QUIET_MS));
    expect(await isTicking()).toBe(false);
  });
});

async function savedPosition(actorId: string): Promise<Record<string, unknown> | undefined> {
  let found: Record<string, unknown> | undefined;
  await runInDurableObject(stub(), async (_instance, state) => {
    found = await state.storage.get<Record<string, unknown>>(`pos:${actorId}`);
  });
  return found;
}

let playersSoFar = 0;

function freshPlayer(): string {
  return `player-${playersSoFar++}`;
}

const BACKFILL_BATCH = 128;

async function storedKeys(prefix: string): Promise<string[]> {
  let keys: string[] = [];
  await runInDurableObject(stub(), async (_instance, state) => {
    keys = [...(await state.storage.list({ prefix })).keys()];
  });
  return keys;
}

async function keptAfterJoin(prefix: string, joined: string): Promise<string[]> {
  const keys = await storedKeys(prefix);
  return keys.filter((key) => key !== `${prefix}${joined}`);
}

async function savedEquipment(actorId: string): Promise<Record<string, unknown> | undefined> {
  let found: Record<string, unknown> | undefined;
  await runInDurableObject(stub(), async (_instance, state) => {
    found = await state.storage.get<Record<string, unknown>>(`equip:${actorId}`);
  });
  return found;
}

async function savedMasteries(actorId: string): Promise<Record<string, number> | undefined> {
  let found: { masteries?: Record<string, number> } | undefined;
  await runInDurableObject(stub(), async (_instance, state) => {
    found = await state.storage.get(`mast:${actorId}`);
  });
  return found?.masteries;
}

function kitOf(hello: Record<string, unknown>): { bag: { id: string } } {
  return hello.equipment as { bag: { id: string } };
}

const ONE_STEP_EAST = 1;

async function walkEast(ws: TestSocket) {
  step(ws, 0, "e");
  await walkWithin(ws, 1000);
  await new Promise((resolve) => setTimeout(resolve, WALK_DURATION_MS + 200));
}

async function leave(ws: TestSocket) {
  ws.close();
  await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
}

const FAR_SPAWN = 5;

function stripSpawningAtTheFarEnd(): FlatMapFile {
  const levels: Record<string, Record<string, unknown[]>> = { "0": {} };
  for (let x = 0; x <= FAR_SPAWN; x++) levels["0"]![`${x},0`] = [{ tileId: "grass" }];
  levels["0"]![`${FAR_SPAWN},0`] = [{ tileId: "grass" }, { tileId: "player", direction: "s" }];
  return { version: MAP_FILE_VERSION, levels } as FlatMapFile;
}

describe("player permanence", () => {
  it("brings a returning player back where they left off", async () => {
    const who = freshPlayer();
    const first = await connect(who);
    await walkEast(first.ws);
    expect(await actorX(who)).toBe(ONE_STEP_EAST);
    await leave(first.ws);

    await connect(who);

    expect(await actorX(who)).toBe(ONE_STEP_EAST);
  });

  it("does not hand back a bag they left on the floor", async () => {
    const who = freshPlayer();
    const first = await connect(who);
    send(first.ws, {
      type: "drop",
      from: { kind: "bag" },
      to: { x: SPAWN_CELL, y: 0, z: 0 },
    });
    expect(await equipmentWithin(first.ws)).not.toBeNull();
    await leave(first.ws);
    await simulateEviction();

    const { hello } = await connect(who);

    expect((hello.equipment as { bag: unknown }).bag).toBeNull();
    const stack = (hello.map as FlatMapFile).levels["0"]?.[`${SPAWN_CELL},0`];
    expect(stack?.map((placed) => placed.tileId)).toContain(BAG_TILE_ID);
  });

  it("starts somebody the world has never met at the spawn point", async () => {
    await connect(freshPlayer());

    const newcomer = freshPlayer();
    await connect(newcomer);

    expect(await actorX(newcomer)).toBe(0);
  });

  it("remembers across an eviction", async () => {
    const who = freshPlayer();
    const first = await connect(who);
    await walkEast(first.ws);
    await leave(first.ws);
    await simulateEviction();

    await connect(who);

    expect(await actorX(who)).toBe(ONE_STEP_EAST);
  });

  it("writes a connected player's position down as the world settles", async () => {
    const who = freshPlayer();
    const { ws } = await connect(who);
    await walkEast(ws);

    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
    expect(await savedPosition(who)).toMatchObject({
      x: ONE_STEP_EAST,
      y: 0,
      z: 0,
    });
  });

  it("drops the least recently saved once the store is full", async () => {
    const overflow = 5;
    await runInDurableObject(stub(), async (_instance, state) => {
      for (let i = 0; i < MAX_REMEMBERED_ACTORS + overflow; i += BACKFILL_BATCH) {
        const batch: Record<string, unknown> = {};
        const end = Math.min(i + BACKFILL_BATCH, MAX_REMEMBERED_ACTORS + overflow);
        for (let n = i; n < end; n++) {
          batch[`pos:backfill-${n}`] = { x: 0, y: 0, z: 0, direction: "s", savedAt: n };
        }
        await state.storage.put(batch);
      }
    });

    await simulateEviction();
    const joined = freshPlayer();
    await connect(joined);

    const kept = await keptAfterJoin("pos:", joined);
    expect(kept).toHaveLength(MAX_REMEMBERED_ACTORS);
    expect(kept).not.toContain("pos:backfill-0");
    expect(kept).toContain(`pos:backfill-${MAX_REMEMBERED_ACTORS + overflow - 1}`);
  });

  it("hands a returning player back the same bag they left with", async () => {
    const who = freshPlayer();
    const first = await connect(who);
    const bagId = kitOf(first.hello).bag.id;
    expect(bagId).toMatch(/^itm_/);
    await leave(first.ws);

    const again = await connect(who);

    expect(kitOf(again.hello).bag.id).toBe(bagId);
  });

  it("gives somebody the world has never met a bag of their own", async () => {
    const one = await connect(freshPlayer());
    const other = await connect(freshPlayer());

    expect(kitOf(other.hello).bag.id).not.toBe(kitOf(one.hello).bag.id);
  });

  it("remembers a kit across an eviction", async () => {
    const who = freshPlayer();
    const first = await connect(who);
    const bagId = kitOf(first.hello).bag.id;
    await leave(first.ws);
    await simulateEviction();

    const again = await connect(who);

    expect(kitOf(again.hello).bag.id).toBe(bagId);
  });

  it("writes a connected player's kit down as the world settles", async () => {
    const who = freshPlayer();
    const { ws, hello } = await connect(who);
    await walkEast(ws);
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    const saved = await savedEquipment(who);
    expect(saved).toBeDefined();
    expect((saved!.equipment as { bag: { id: string } }).bag.id).toBe(kitOf(hello).bag.id);
  });

  it("drops the least recently saved kits once the store is full", async () => {
    const overflow = 5;
    await runInDurableObject(stub(), async (_instance, state) => {
      for (let i = 0; i < MAX_REMEMBERED_ACTORS + overflow; i += BACKFILL_BATCH) {
        const batch: Record<string, unknown> = {};
        const end = Math.min(i + BACKFILL_BATCH, MAX_REMEMBERED_ACTORS + overflow);
        for (let n = i; n < end; n++) {
          batch[`equip:backfill-${n}`] = {
            equipment: { weapon: null, offhand: null, bag: null },
            savedAt: n,
          };
        }
        await state.storage.put(batch);
      }
    });

    await simulateEviction();
    const joined = freshPlayer();
    await connect(joined);

    const kept = await keptAfterJoin("equip:", joined);
    expect(kept).toHaveLength(MAX_REMEMBERED_ACTORS);
    expect(kept).not.toContain("equip:backfill-0");
    expect(kept).toContain(`equip:backfill-${MAX_REMEMBERED_ACTORS + overflow - 1}`);
  });

  it("hands a returning player back the rewards they have taken", async () => {
    const who = freshPlayer();
    await runInDurableObject(stub(), async (_instance, state) => {
      await state.storage.put(`tags:${who}`, {
        tags: ["chest-42"],
        savedAt: Date.now(),
      });
    });
    await simulateEviction();

    const { hello } = await connect(who);

    expect(hello.tags).toEqual(["chest-42"]);
  });

  it("keeps taken rewards across a world replacement", async () => {
    const who = freshPlayer();
    await runInDurableObject(stub(), async (_instance, state) => {
      await state.storage.put(`tags:${who}`, {
        tags: ["chest-42"],
        savedAt: Date.now(),
      });
    });
    await simulateEviction();
    await connect(who);

    await stub().replaceWorld(authoredMap());

    const { hello } = await connect(who);
    expect(hello.tags).toEqual(["chest-42"]);
  });

  it("drops the least recently saved tags once the store is full", async () => {
    const overflow = 5;
    await runInDurableObject(stub(), async (_instance, state) => {
      for (let i = 0; i < MAX_REMEMBERED_ACTORS + overflow; i += BACKFILL_BATCH) {
        const batch: Record<string, unknown> = {};
        const end = Math.min(i + BACKFILL_BATCH, MAX_REMEMBERED_ACTORS + overflow);
        for (let n = i; n < end; n++) {
          batch[`tags:backfill-${n}`] = { tags: ["seen"], savedAt: n };
        }
        await state.storage.put(batch);
      }
    });

    await simulateEviction();
    const joined = freshPlayer();
    await connect(joined);

    const kept = await keptAfterJoin("tags:", joined);
    expect(kept).toHaveLength(MAX_REMEMBERED_ACTORS);
    expect(kept).not.toContain("tags:backfill-0");
    expect(kept).toContain(`tags:backfill-${MAX_REMEMBERED_ACTORS + overflow - 1}`);
  });

  it("hands a returning player back what they have learnt", async () => {
    const who = freshPlayer();
    const EARNED = { sharp: 40_000, toughness: 9_000 };
    await runInDurableObject(stub(), async (_instance, state) => {
      await state.storage.put(`mast:${who}`, {
        masteries: EARNED,
        savedAt: Date.now(),
      });
    });
    await simulateEviction();

    const { ws } = await connect(who);
    await walkEast(ws);
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    expect(await savedMasteries(who)).toEqual(EARNED);
  });

  it("refuses a stored block of masteries it cannot make sense of", async () => {
    const who = freshPlayer();
    await runInDurableObject(stub(), async (_instance, state) => {
      await state.storage.put(`mast:${who}`, {
        masteries: { sharp: "quite good", agility: -1 },
        savedAt: Date.now(),
      });
    });
    await simulateEviction();

    const { ws, hello } = await connect(who);
    expect(hello).toBeDefined();

    await walkEast(ws);
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    const written = await savedMasteries(who);
    for (const earned of Object.values(written ?? {})) {
      expect(Number.isFinite(earned)).toBe(true);
    }
    expect(written?.sharp).not.toBeNaN();
  });

  it("drops the least recently saved masteries once the store is full", async () => {
    const overflow = 5;
    await runInDurableObject(stub(), async (_instance, state) => {
      for (let i = 0; i < MAX_REMEMBERED_ACTORS + overflow; i += BACKFILL_BATCH) {
        const batch: Record<string, unknown> = {};
        const end = Math.min(i + BACKFILL_BATCH, MAX_REMEMBERED_ACTORS + overflow);
        for (let n = i; n < end; n++) {
          batch[`mast:backfill-${n}`] = { masteries: { fist: n }, savedAt: n };
        }
        await state.storage.put(batch);
      }
    });

    await simulateEviction();
    const joined = freshPlayer();
    await connect(joined);

    const kept = await keptAfterJoin("mast:", joined);
    expect(kept).toHaveLength(MAX_REMEMBERED_ACTORS);
    expect(kept).not.toContain("mast:backfill-0");
    expect(kept).toContain(`mast:backfill-${MAX_REMEMBERED_ACTORS + overflow - 1}`);
  });

  it("never writes a kit down without the board it was read from", async () => {
    const who = freshPlayer();
    const { ws } = await connect(who);
    await walkEast(ws);
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    const saved = await savedEquipment(who);
    expect(saved).toBeDefined();
    await runInDurableObject(stub(), async (_instance, state) => {
      expect(await state.storage.get("world")).toBeDefined();
    });
  });

  it("bubbles to a neighbour when their cell has been built on", async () => {
    const who = freshPlayer();
    const first = await connect(who);
    await walkEast(first.ws);
    await leave(first.ws);

    const rebuilt = stripSpawningAtTheFarEnd();
    rebuilt.levels["0"]![`${ONE_STEP_EAST},0`] = [{ tileId: "grass" }, { tileId: "stone-wall" }];
    await stub().replaceWorld(rebuilt);

    await connect(who);

    expect(await actorX(who)).toBe(ONE_STEP_EAST - 1);
  });
});

const BOX_SPAWN = 9;
const BOX_AT = BOX_SPAWN + 1;

const BOX_TILE_ID = "wooden-box";

const ANY_GROUND_TILE_ID = "grass";

function laneTileId(): string {
  const def = tilesByIdFromList(tilesJson as TileDef[])[BOX_TILE_ID];
  const moveOn = def ? (resolvePush(def)?.moveOnTileIds ?? []) : [];
  return moveOn[0] ?? ANY_GROUND_TILE_ID;
}

function stripWithABox(): {
  map: FlatMapFile;
  spawn: { x: number; y: number; z: number; stackIndex: number };
} {
  const ground = laneTileId();
  const levels: Record<string, Record<string, unknown[]>> = { "0": {} };
  for (let x = 0; x <= BOX_AT + 1; x++) {
    levels["0"]![`${x},0`] = [{ tileId: ground }];
  }
  levels["0"]![`${BOX_AT},0`] = [{ tileId: ground }, { tileId: BOX_TILE_ID }];
  return {
    map: { version: MAP_FILE_VERSION, levels } as FlatMapFile,
    spawn: { x: BOX_SPAWN, y: 0, z: 0, stackIndex: 1 },
  };
}

function eventsWithin(
  ws: TestSocket,
  kind: string,
  ms: number,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const found: Record<string, unknown>[] = [];
    const onMessage = (event: { data: string }) => {
      const message = JSON.parse(event.data) as Record<string, unknown>;
      if (message.type !== "patch") return;
      for (const e of message.events as Record<string, unknown>[]) {
        if (e.kind === kind) found.push(e);
      }
    };
    ws.addEventListener("message", onMessage);
    setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      resolve(found);
    }, ms);
  });
}

async function boxX(): Promise<number | null> {
  let found: number | null = null;
  await runInDurableObject(stub(), (instance: GameServer) => {
    const internals = instance as unknown as {
      session: { getMap(): MapFile } | null;
    };
    const map = internals.session?.getMap();
    if (!map) return;
    for (const coord of listCoords(map, 0)) {
      const stack = getStack(map, coord.x, coord.y, 0);
      if (stack.some((p) => p.tileId === "wooden-box")) found = coord.x;
    }
  });
  return found;
}

describe("announcing a swing", () => {
  const FIRST_BLOW_MS = (() => {
    const player = tilesByIdFromList(normalizeTiles(tilesJson as unknown[]))[PLAYER_TILE_ID];
    const battler = player && resolveBattler(player);
    if (!battler) throw new Error("the player is not a battler");
    const stats = fightingStats(battler, battler.naturalWeapon);
    return swingWindupMs(stats) + QUIET_MS * 3;
  })();

  it("tells the room each time somebody throws a blow", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    await walkEast(alice.ws);

    alice.ws.send(JSON.stringify({ type: "pvp", enabled: true }));
    bob.ws.send(JSON.stringify({ type: "pvp", enabled: true }));

    const swings = eventsWithin(alice.ws, "swung", FIRST_BLOW_MS);
    alice.ws.send(JSON.stringify({ type: "target", actorId: "bob" }));
    alice.ws.send(JSON.stringify({ type: "attackMode", enabled: true }));

    const thrown = await swings;
    expect(thrown.length).toBeGreaterThan(0);
    expect(thrown[0]).toEqual({ kind: "swung", actorId: "alice" });
    expect(bob.hello.actorIds).toEqual(["alice", "bob"]);
  });
});

describe("pushing", () => {
  it("announces one shove once", async () => {
    await putCheckpoint(stripWithABox());
    await simulateEviction();
    const { ws } = await connect(freshPlayer());

    const slides = eventsWithin(ws, "slideStarted", PUSH_STEP_MS + QUIET_MS * 2);
    ws.send(
      JSON.stringify({
        type: "interact",
        ref: { x: BOX_AT, y: 0, z: 0, stackIndex: 1 },
      }),
    );

    expect(await slides).toHaveLength(1);
    expect(await boxX()).toBe(BOX_AT + 1);
  });
});

function markerlessMap(): FlatMapFile {
  const levels: Record<string, Record<string, unknown[]>> = { "0": {} };
  for (let x = 0; x < 4; x++) {
    levels["0"]![`${x},0`] = [{ tileId: "grass" }];
  }
  return { version: MAP_FILE_VERSION, levels } as FlatMapFile;
}

async function storedMap(): Promise<FlatMapFile> {
  const stored = await harness.blobs.getText("map.json");
  return JSON.parse(stored!) as FlatMapFile;
}

describe("saving a map that cannot start", () => {
  it("refuses it without writing anything", async () => {
    await stub().replaceWorld(authoredMap());
    await putCheckpoint(checkpointWith(["ghost"]));
    const before = await storedMap();

    await runInDurableObject(stub(), async (instance: GameServer) => {
      await expect(instance.replaceWorld(markerlessMap())).rejects.toThrow(/player/);
    });

    expect(await storedMap()).toEqual(before);
    await runInDurableObject(stub(), async (_instance, state) => {
      expect(await state.storage.get("world")).toBeDefined();
    });
  });

  it("saves onto a world too broken to load", async () => {
    const wedged = await Harness.create();
    try {
      await wedged.blobs.put("map.json", JSON.stringify(markerlessMap()), JSON_TYPE);

      await wedged.server.replaceWorld(authoredMap());

      const saved = await wedged.blobs.getText("map.json");
      expect(playerCells(JSON.parse(saved!) as FlatMapFile)).toEqual([0]);
    } finally {
      await wedged.dispose();
    }
  });
});

describe("consuming", () => {
  const BERRY = "berry";

  function mapWithBerry(): FlatMapFile {
    const map = authoredMap();
    map.levels["0"]!["1,0"] = [{ tileId: "grass" }, { tileId: BERRY }];
    return map;
  }

  const BERRY_REF = { x: 1, y: 0, z: 0, stackIndex: 1 };

  async function liveTilesAt(x: number, y: number, z: number) {
    let found: string[] = [];
    await runInDurableObject(stub(), (instance: GameServer) => {
      const session = (instance as unknown as { session: { getMap(): MapFile } }).session;
      found = getStack(session.getMap(), x, y, z).map((p) => p.tileId);
    });
    return found;
  }

  it("takes the berry off the board", async () => {
    await harness.blobs.put("map.json", JSON.stringify(mapWithBerry()), JSON_TYPE);
    const alice = await connect("alice");
    expect(await liveTilesAt(1, 0, 0)).toEqual(["grass", BERRY]);

    send(alice.ws, { type: "consume", from: { kind: "floor", ref: BERRY_REF } });
    await noiseWithin(alice.ws, 1000);

    expect(await liveTilesAt(1, 0, 0)).toEqual(["grass"]);
  });

  it("makes the noise it makes, to the floor it was eaten on", async () => {
    await harness.blobs.put("map.json", JSON.stringify(mapWithBerry()), JSON_TYPE);
    const alice = await connect("alice");

    send(alice.ws, { type: "consume", from: { kind: "floor", ref: BERRY_REF } });

    expect(await noiseWithin(alice.ws, 1000)).toMatchObject({
      type: "noise",
      text: "crunch",
      z: 0,
    });
  });

  it("never sends it as chat, which would name a speaker", async () => {
    await harness.blobs.put("map.json", JSON.stringify(mapWithBerry()), JSON_TYPE);
    const alice = await connect("alice");

    send(alice.ws, { type: "consume", from: { kind: "floor", ref: BERRY_REF } });

    const noise = await noiseWithin(alice.ws, 1000);
    expect(noise).not.toBeNull();
    expect(noise).not.toHaveProperty("actorId");
    expect(await chatWithin(alice.ws, QUIET_MS)).toBeNull();
  });

  it("makes none when there is nothing there to eat", async () => {
    const alice = await connect("alice");

    send(alice.ws, {
      type: "consume",
      from: { kind: "floor", ref: { x: 3, y: 0, z: 0, stackIndex: 1 } },
    });

    expect(await noiseWithin(alice.ws, QUIET_MS)).toBeNull();
  });
});

describe("respawn", () => {
  const GNOME_X = 3;
  const GNOME_OWNER = `npc:${GNOME_X},0,0,1`;
  const RESPAWN_WINDOW_MS = 1;

  function gnomeTile() {
    return {
      id: "gnome",
      name: "Gnome",
      height: 2,
      type: "simple",
      kind: "prop",
      attributes: {},
      actor: true,
      walkable: false,
      interactions: {
        respawn: { fromMs: RESPAWN_WINDOW_MS, toMs: RESPAWN_WINDOW_MS },
      },
      sprite: {
        frames: [
          {
            sprite: {
              tilesetId: "tiny-ranch-tiles",
              rect: { x: 0, y: 0, w: 1, h: 1 },
              base: { x: 0, y: 0 },
            },
            durationMs: 200,
          },
        ],
      },
    };
  }

  function mapWithGnome(): FlatMapFile {
    const flat = authoredMap();
    flat.levels["0"]![`${GNOME_X},0`] = [{ tileId: "grass" }, { tileId: "gnome" }];
    return flat;
  }

  beforeEach(async () => {
    await harness.blobs.put("tiles.json", JSON.stringify([...tilesJson, gnomeTile()]), JSON_TYPE);
    await harness.blobs.put("map.json", JSON.stringify(mapWithGnome()), JSON_TYPE);
  });

  it("derives and stores the spawn points when a fresh world loads", async () => {
    await connect("alice");

    const points = await runInDurableObject(stub(), (_instance, state) =>
      state.storage.get<Array<{ key: string; ownerId?: string }>>("respawnPoints"),
    );
    expect(points?.map((p) => p.key)).toEqual([GNOME_OWNER]);
    expect(points?.[0]?.ownerId).toBe(GNOME_OWNER);
  });

  it("arms a creature missing at load and grows it back on the alarm", async () => {
    await connect("alice");

    await putCheckpoint({ ...checkpointWith(["alice"]), dead: [GNOME_OWNER] });
    await simulateEviction();

    const { hello } = await connect("alice");
    const helloStack = (hello.map as FlatMapFile).levels["0"]?.[`${GNOME_X},0`];
    expect(helloStack?.map((p) => p.tileId)).toEqual(["grass"]);

    await new Promise((resolve) => setTimeout(resolve, 10));
    await runDurableObjectAlarm(stub());

    const stack = await runInDurableObject(stub(), (instance: GameServer) => {
      const internals = instance as unknown as {
        session: { getMap(): MapFile };
      };
      return getStack(internals.session.getMap(), GNOME_X, 0, 0);
    });
    expect(stack.map((p) => p.tileId)).toEqual(["grass", "gnome"]);
    expect(stack[1]?.owner).toBe(GNOME_OWNER);

    const pending = await runInDurableObject(stub(), (_instance, state) =>
      state.storage.get<Record<string, number>>("respawnPending"),
    );
    expect(Object.keys(pending ?? {})).toEqual([]);
  });

  describe("an item that decays where it stands", () => {
    const BERRY_X = 1;
    const BERRY_REF = { x: BERRY_X, y: 0, z: 0, stackIndex: 1 };
    const DECAY_MS = 300;

    function berryTiles() {
      const sprite = {
        frames: [
          {
            sprite: {
              tilesetId: "tiny-ranch-tiles",
              rect: { x: 0, y: 0, w: 1, h: 1 },
              base: { x: 0, y: 0 },
            },
            durationMs: 200,
          },
        ],
      };
      const common = {
        name: "Berry",
        height: 0,
        type: "simple",
        kind: "item",
        attributes: {},
        lightPassing: true,
        sprite,
      };
      return [
        {
          ...common,
          id: "test-berry",
          interactions: {
            item: { type: "consumable", label: "Eat", hp: 0 },
            respawn: { fromMs: RESPAWN_WINDOW_MS, toMs: RESPAWN_WINDOW_MS },
            decay: { tileId: "test-stale-berry", fromMs: DECAY_MS, toMs: DECAY_MS },
          },
        },
        {
          ...common,
          id: "test-stale-berry",
          interactions: { item: { type: "consumable", label: "Eat", hp: -2 } },
        },
      ];
    }

    function mapWithBerry(): FlatMapFile {
      const flat = authoredMap();
      flat.levels["0"]![`${BERRY_X},0`] = [{ tileId: "grass" }, { tileId: "test-berry" }];
      return flat;
    }

    async function berryCell() {
      return await runInDurableObject(stub(), (instance: GameServer) => {
        const session = (instance as unknown as { session: { getMap(): MapFile } }).session;
        return getStack(session.getMap(), BERRY_X, 0, 0).map((p) => p.tileId);
      });
    }

    async function settle() {
      await new Promise((resolve) => setTimeout(resolve, DECAY_MS * 3));
    }

    async function tickPasses() {
      await new Promise((resolve) => setTimeout(resolve, TICK_MS * 2));
    }

    beforeEach(async () => {
      await harness.blobs.put(
        "tiles.json",
        JSON.stringify([...tilesJson, gnomeTile(), ...berryTiles()]),
        JSON_TYPE,
      );
      await harness.blobs.put("map.json", JSON.stringify(mapWithBerry()), JSON_TYPE);
    });

    it("does not grow a second one while the first is merely going off", async () => {
      await connect("alice");
      await settle();

      expect(await berryCell()).toEqual(["grass", "test-stale-berry"]);
    });

    it("grows one back once the stale one is taken", async () => {
      const alice = await connect("alice");
      await settle();
      expect(await berryCell()).toEqual(["grass", "test-stale-berry"]);

      send(alice.ws, { type: "pickUp", ref: BERRY_REF });
      await equipmentWithin(alice.ws);
      await settle();

      expect(await berryCell()).toEqual(["grass", "test-stale-berry"]);
    });

    it("still grows one back when the same berry is dropped where it was found", async () => {
      const alice = await connect("alice");

      send(alice.ws, { type: "pickUp", ref: BERRY_REF });
      await equipmentWithin(alice.ws);
      await tickPasses();

      send(alice.ws, {
        type: "drop",
        from: { kind: "contents", index: 0 },
        to: { x: BERRY_X, y: 0, z: 0 },
      });
      await settle();

      const cell = await berryCell();
      expect(cell.filter((id) => id.endsWith("berry"))).toHaveLength(2);
    });
  });
});

describe("resetting the world", () => {
  it("forgets what a player had learnt, which a save carries forward", async () => {
    const who = freshPlayer();
    const EARNED = { sharp: 40_000, toughness: 9_000 };
    await runInDurableObject(stub(), async (_instance, state) => {
      await state.storage.put(`mast:${who}`, {
        masteries: EARNED,
        savedAt: Date.now(),
      });
    });
    await simulateEviction();
    await connect(who);

    await stub().replaceWorld(authoredMap());
    expect((await connect(who)).hello.masteryXp).toEqual(EARNED);

    await stub().resetWorld();

    const { hello } = await connect(who);
    expect(hello.masteryXp).not.toEqual(EARNED);
    expect(await savedMasteries(who)).not.toEqual(EARNED);
  });

  it("gives back the rewards a player had already taken", async () => {
    const who = freshPlayer();
    await runInDurableObject(stub(), async (_instance, state) => {
      await state.storage.put(`tags:${who}`, {
        tags: ["chest-42"],
        savedAt: Date.now(),
      });
    });
    await simulateEviction();

    const taken = await connect(who);
    expect(taken.hello.tags).toEqual(["chest-42"]);

    await stub().resetWorld();

    const { hello } = await connect(who);
    expect(hello.tags).toEqual([]);
    expect(await storedKeys("tags:")).toEqual([]);
  });

  it("starts the board again from the authored map", async () => {
    await connect("alice");
    await putCheckpoint(checkpointWith(["alice"]));
    await simulateEviction();

    const resumed = await connect("alice");
    expect(playerCells(resumed.hello.map as FlatMapFile)).toEqual([AWAY_FROM_SPAWN]);

    await stub().resetWorld();

    const { hello } = await connect("alice");
    expect(playerCells(hello.map as FlatMapFile)).toEqual([0]);
    expect(Object.keys((hello.map as FlatMapFile).levels["0"] ?? {})).toHaveLength(AUTHORED_CELLS);
  });

  it("re-seats a connected player rather than waiting for a reload", async () => {
    const who = freshPlayer();
    const joined = await connect(who);

    await stub().resetWorld();

    const hello = await nextMessage(joined.ws);
    expect(hello.type).toBe("hello");
    expect(hello.selfId).toBe(who);
    expect(playerOwners(hello.map as FlatMapFile)).toEqual([who]);
  });

  it("drops the chat log, and survives having one to drop", async () => {
    const alice = await connect("alice");
    say(alice.ws, "hello");
    await chatWithin(alice.ws, 1000);
    expect(await chatRows()).not.toHaveLength(0);

    await stub().resetWorld();

    const tables = await harness.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat'",
    );
    expect(tables).toHaveLength(0);
  });

  it("works on a world nobody is in", async () => {
    await putCheckpoint(checkpointWith(["ghost"]));
    await simulateEviction();

    await stub().resetWorld();

    const { hello } = await connect("alice");
    expect(playerCells(hello.map as FlatMapFile)).toEqual([0]);
  });
});

describe("what a flush writes", () => {
  const GNOME_X = 3;
  const GNOME_OWNER = `npc:${GNOME_X},0,0,1`;

  function gnomeTile() {
    return {
      id: "gnome",
      name: "Gnome",
      height: 2,
      type: "simple",
      kind: "battler",
      attributes: {},
      actor: true,
      walkable: false,
      interactions: {
        battler: {
          baseHp: 8,
          masteries: { toughness: 4 },
          naturalWeapon: {
            type: "weapon",
            damage: 1,
            def: 0,
            accuracy: 50,
            variance: 0,
            spd: 20,
            mastery: "fist",
          },
          kit: [{ slot: "bag", tileId: BAG_TILE_ID, chance: 100 }],
        },
      },
      sprite: {
        frames: [
          {
            sprite: {
              tilesetId: "tiny-ranch-tiles",
              rect: { x: 0, y: 0, w: 1, h: 1 },
              base: { x: 0, y: 0 },
            },
            durationMs: 200,
          },
        ],
      },
    };
  }

  function mapWithGnome(): FlatMapFile {
    const flat = authoredMap();
    flat.levels["0"]![`${GNOME_X},0`] = [{ tileId: "grass" }, { tileId: "gnome" }];
    return flat;
  }

  beforeEach(async () => {
    await harness.blobs.put("tiles.json", JSON.stringify([...tilesJson, gnomeTile()]), JSON_TYPE);
    await harness.blobs.put("map.json", JSON.stringify(mapWithGnome()), JSON_TYPE);
  });

  it("never writes down where a creature is standing", async () => {
    const alice = await connect("alice");
    await walkEast(alice.ws);
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    const positions = await storedKeys("pos:");
    expect(positions).toContain("pos:alice");
    expect(positions).not.toContain(`pos:${GNOME_OWNER}`);
  });

  it("never writes down what a creature is carrying", async () => {
    const alice = await connect("alice");
    await walkEast(alice.ws);
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    const kits = await storedKeys("equip:");
    expect(kits).toContain("equip:alice");
    expect(kits).not.toContain(`equip:${GNOME_OWNER}`);
  });

  it("still puts a creature back where it stood after an eviction", async () => {
    await connect("alice");
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
    await simulateEviction();

    const { hello } = await connect("bob");
    const stack = (hello.map as FlatMapFile).levels["0"]?.[`${GNOME_X},0`];
    expect(stack?.map((placed) => placed.tileId)).toEqual(["grass", "gnome"]);
  });

  it("does not write a player again while they have not moved", async () => {
    const who = freshPlayer();
    const alice = await connect(who);
    await walkEast(alice.ws);
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    const first = await runInDurableObject(stub(), (_instance, state) =>
      state.storage.get<{ savedAt: number }>(`pos:${who}`),
    );
    expect(first).toBeDefined();

    await runInDurableObject(stub(), (instance: GameServer) => {
      const internals = instance as unknown as {
        saveActors(ids: Iterable<string>): void;
        session: { actorIds(): string[] };
      };
      internals.saveActors(internals.session.actorIds());
    });
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    const second = await runInDurableObject(stub(), (_instance, state) =>
      state.storage.get<{ savedAt: number }>(`pos:${who}`),
    );
    expect(second?.savedAt).toBe(first?.savedAt);
  });

  it("retracts a status row once the status has run out", async () => {
    const map = authoredMap();
    map.levels["0"]!["1,0"] = [{ tileId: "grass" }, { tileId: "berry" }];
    await harness.blobs.put("map.json", JSON.stringify(map), JSON_TYPE);

    const who = freshPlayer();
    const { ws } = await connect(who);
    send(ws, {
      type: "consume",
      from: { kind: "floor", ref: { x: 1, y: 0, z: 0, stackIndex: 1 } },
    });
    await noiseWithin(ws, 1000);
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    const stored = await runInDurableObject(stub(), (_instance, state) =>
      state.storage.get<{ statuses: unknown[] }>(`status:${who}`),
    );
    expect(stored?.statuses).toHaveLength(1);

    await runInDurableObject(stub(), (instance: GameServer) => {
      const internals = instance as unknown as {
        saveActors(ids: Iterable<string>): void;
        session: {
          actorIds(): string[];
          statusesOf(id: string): { remainingMs: number }[] | null;
          tick(ms: number): void;
        };
      };
      const running = internals.session.statusesOf(who);
      for (const status of running ?? []) status.remainingMs = 1;
      internals.session.tick(100);
      internals.saveActors(internals.session.actorIds());
    });
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    const after = await runInDurableObject(stub(), (_instance, state) =>
      state.storage.get<{ statuses: unknown[] }>(`status:${who}`),
    );
    expect(after?.statuses).toEqual([]);
  });

  it("writes a kit and the board it was read from in one batch", async () => {
    const who = freshPlayer();
    const alice = await connect(who);
    await walkEast(alice.ws);
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    const kit = await runInDurableObject(stub(), (_instance, state) =>
      state.storage.get<{ savedAt: number }>(`equip:${who}`),
    );
    const board = await storedKeys("chunk:");
    expect(kit).toBeDefined();
    expect(board.length).toBeGreaterThan(0);
  });

  it("retracts a kit row once the last thing in it has been dropped", async () => {
    const who = freshPlayer();
    const { ws } = await connect(who);
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    const before = await savedEquipment(who);
    expect((before?.equipment as { bag: unknown } | undefined)?.bag).not.toBeNull();

    send(ws, {
      type: "drop",
      from: { kind: "bag" },
      to: { x: SPAWN_CELL, y: 0, z: 0 },
    });
    const patch = await equipmentWithin(ws);
    expect(patch).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    const after = await savedEquipment(who);
    const kit = after?.equipment as {
      weapon: unknown;
      offhand: unknown;
      bag: unknown;
    };
    expect(kit.weapon).toBeNull();
    expect(kit.offhand).toBeNull();
    expect(kit.bag).toBeNull();
  });

  it("restamps somebody on the way out even if they never moved", async () => {
    const who = freshPlayer();
    const alice = await connect(who);
    await walkEast(alice.ws);
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    const before = await runInDurableObject(stub(), (_instance, state) =>
      state.storage.get<{ savedAt: number }>(`pos:${who}`),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await leave(alice.ws);

    const after = await runInDurableObject(stub(), (_instance, state) =>
      state.storage.get<{ savedAt: number }>(`pos:${who}`),
    );
    expect(after?.savedAt).toBeGreaterThan(before!.savedAt);
  });
});

describe("dying and coming back", () => {
  const SWORD = "rusty-sword";

  function checkpointWithSword() {
    const checkpoint = checkpointWith(["alice"]);
    const cell = `${AWAY_FROM_SPAWN},0`;
    checkpoint.map.levels["0"]![cell] = [...checkpoint.map.levels["0"]![cell]!, { tileId: SWORD }];
    return checkpoint;
  }

  const SWORD_STACK_INDEX = 2;

  async function killAndTick(actorId: string) {
    await runInDurableObject(stub(), (instance: GameServer) => {
      const internals = instance as unknown as {
        session: {
          actors: Map<string, unknown>;
          applyDamage(actor: unknown, amount: number): void;
        };
        tick(): void;
      };
      const body = internals.session.actors.get(actorId);
      expect(body).toBeDefined();
      internals.session.applyDamage(body, 10_000);
      internals.tick();
    });
  }

  it("survives dying with a step still queued", async () => {
    const alice = await connect("alice");

    step(alice.ws, 1, "e");
    step(alice.ws, 2, "e");

    const deadline = Date.now() + MESSAGE_TIMEOUT_MS;
    let queued = false;
    while (Date.now() < deadline && !queued) {
      queued = await runInDurableObject(stub(), (instance: GameServer) => {
        const internals = instance as unknown as {
          queuedIntents: Map<string, unknown[]>;
        };
        return (internals.queuedIntents.get("alice")?.length ?? 0) > 0;
      });
      if (!queued) await wait(10);
    }
    expect(queued).toBe(true);

    await killAndTick("alice");

    const bob = await connect("bob");
    expect(bob.hello.type).toBe("hello");

    await runInDurableObject(stub(), (instance: GameServer) => {
      const internals = instance as unknown as {
        queuedIntents: Map<string, unknown[]>;
      };
      expect(internals.queuedIntents.has("alice")).toBe(false);
    });
  });

  it("keeps ticking when a tick throws", async () => {
    const alice = await connect("alice");

    await runInDurableObject(stub(), (instance: GameServer) => {
      const internals = instance as unknown as {
        tick(): void;
        tickSafely(): void;
        consecutiveTickFailures: number;
      };
      const good = internals.tick.bind(internals);
      internals.tick = () => {
        throw new Error("simulated fault");
      };

      expect(() => internals.tickSafely()).not.toThrow();
      expect(internals.consecutiveTickFailures).toBe(1);

      internals.tick = good;
      internals.tickSafely();
      expect(internals.consecutiveTickFailures).toBe(0);
    });

    step(alice.ws, 1, "e");
    expect(await walkWithin(alice.ws, 1000)).not.toBeNull();
  });

  it("makes up the time a long tick took, and gives up on a backlog", async () => {
    await connect("alice");

    await runInDurableObject(stub(), (instance: GameServer) => {
      const internals = instance as unknown as {
        timer: ReturnType<typeof setInterval> | null;
        tick(): void;
        wake(): void;
      };
      if (internals.timer !== null) clearInterval(internals.timer);
      internals.timer = null;
      let now = 0;
      let heartbeat: (() => void) | null = null;
      const starts: number[] = [];
      const durations = [10, 50, 10, 10, 10, 500, 10, 10];
      const realNow = performance.now;
      const realSetInterval = globalThis.setInterval;
      performance.now = () => now;
      globalThis.setInterval = ((beat: () => void) => {
        heartbeat = beat;
        return {} as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval;
      internals.tick = () => {
        now += durations[starts.push(now) - 1]!;
      };
      try {
        internals.wake();
        while (starts.length < durations.length) {
          const before = starts.length;
          heartbeat!();
          if (starts.length === before) now += 1;
        }
      } finally {
        performance.now = realNow;
        globalThis.setInterval = realSetInterval;
        internals.timer = null;
      }
      const T = 1000 / 30;
      const startedAt = (tick: number, at: number) => {
        expect(starts[tick]!).toBeGreaterThanOrEqual(at);
        expect(starts[tick]!).toBeLessThanOrEqual(at + 1);
      };
      startedAt(0, T);
      startedAt(1, 2 * T);
      expect(starts[2]).toBe(starts[1]! + 50);
      startedAt(3, 4 * T);
      startedAt(4, 5 * T);
      startedAt(5, 6 * T);
      expect(starts[6]).toBe(starts[5]! + 500);
      startedAt(7, starts[6]! + T);
    });
  });

  async function armedAlice() {
    await putCheckpoint(checkpointWithSword());
    const alice = await connect("alice");
    alice.ws.send(
      JSON.stringify({
        type: "pickUp",
        ref: { x: AWAY_FROM_SPAWN, y: 0, z: 0, stackIndex: SWORD_STACK_INDEX },
      }),
    );
    await nextMessageOfType(alice.ws, "equipment");
    return alice;
  }

  function tilesAt(map: FlatMapFile, x: number): string[] {
    const stack = (map.levels["0"]?.[`${x},0`] ?? []) as {
      tileId: string;
      contents?: { tileId: string }[];
    }[];
    return stack.flatMap((placed) => [
      placed.tileId,
      ...(placed.contents ?? []).map((held) => held.tileId),
    ]);
  }

  async function storedRows(actorId: string) {
    return await runInDurableObject(stub(), async (_instance, state) => ({
      position: await state.storage.get<Record<string, unknown>>(`pos:${actorId}`),
      equipment: await state.storage.get<{ equipment: Record<string, unknown> }>(
        `equip:${actorId}`,
      ),
    }));
  }

  it("writes a kit holding nothing they died with, in the batch that drops the body", async () => {
    await armedAlice();

    await killAndTick("alice");

    const { equipment } = await storedRows("alice");
    expect(equipment?.equipment.weapon).toBeNull();
    const bag = equipment?.equipment.bag as { contents?: unknown[] } | null;
    expect(bag?.contents ?? []).toEqual([]);
  });

  it("writes a bystander's changed kit in the batch that drops a body", async () => {
    await putCheckpoint(checkpointWithSword());
    const alice = await connect("alice");
    await connect("bob");
    await runInDurableObject(stub(), (instance: GameServer) => {
      const internals = instance as unknown as {
        session: { actorIds(): string[] };
        saveActors(actorIds: Iterable<string>): void;
      };
      internals.saveActors(internals.session.actorIds());
    });
    alice.ws.send(
      JSON.stringify({
        type: "pickUp",
        ref: { x: AWAY_FROM_SPAWN, y: 0, z: 0, stackIndex: SWORD_STACK_INDEX },
      }),
    );
    await nextMessageOfType(alice.ws, "equipment");

    const batches = await runInDurableObject(stub(), (instance: GameServer) => {
      const internals = instance as unknown as {
        ctx: { storage: { put(entries: unknown, options?: unknown): Promise<void> } };
        session: {
          actors: Map<string, unknown>;
          applyDamage(actor: unknown, amount: number): void;
        };
        tick(): void;
      };
      const storage = internals.ctx.storage;
      const put = storage.put.bind(storage);
      const written: Record<string, unknown>[] = [];
      storage.put = (entries, options) => {
        if (typeof entries === "object" && entries !== null) {
          written.push(entries as Record<string, unknown>);
        }
        return put(entries, options);
      };
      try {
        internals.session.applyDamage(internals.session.actors.get("bob"), 10_000);
        internals.tick();
      } finally {
        storage.put = put;
      }
      return written;
    });

    const deathBatch = batches.find((entries) => "equip:bob" in entries);
    expect(deathBatch).toBeDefined();
    expect(JSON.stringify(deathBatch!["equip:alice"])).toContain(`"tileId":"${SWORD}"`);
  });

  it("sends them back to the spawn point, not to where the last flush caught them", async () => {
    await armedAlice();
    expect(await actorX("alice")).toBe(AWAY_FROM_SPAWN);

    await killAndTick("alice");

    const { position } = await storedRows("alice");
    expect(position?.x).toBe(SPAWN_CELL);
  });

  function checkpointWithMarker() {
    const checkpoint = checkpointWith(["alice"]);
    const cell = `${AWAY_FROM_SPAWN},0`;
    checkpoint.map.levels["0"]![cell] = [
      { tileId: "grass" },
      { tileId: MARKER },
      ...checkpoint.map.levels["0"]![cell]!.slice(1),
    ];
    return checkpoint;
  }

  const MARKER = "respawn-point";
  const MARKER_REF = { x: AWAY_FROM_SPAWN, y: 0, z: 0, stackIndex: 1 };

  async function anchorHere(ws: TestSocket) {
    send(ws, { type: "interact", ref: MARKER_REF });
    return await nextMessageOfType(ws, "notice");
  }

  it("moves the stored spawn row when somebody anchors themselves", async () => {
    await putCheckpoint(checkpointWithMarker());
    const alice = await connect("alice");

    const notice = await anchorHere(alice.ws);
    expect(notice).toMatchObject({ text: "You will respawn here." });

    const spawn = await runInDurableObject(stub(), async (_instance, state) =>
      state.storage.get<Record<string, unknown>>("spawn:alice"),
    );
    expect(spawn).toMatchObject({ x: AWAY_FROM_SPAWN, y: 0, z: 0 });
  });

  it("tells that socket where it comes back now, so the row can go grey", async () => {
    await putCheckpoint(checkpointWithMarker());
    const alice = await connect("alice");
    expect(alice.hello.spawnAt).toMatchObject({ x: SPAWN_CELL, y: 0, z: 0 });

    send(alice.ws, { type: "interact", ref: MARKER_REF });
    const moved = await nextMessageOfType(alice.ws, "spawnPoint");
    expect(moved).toMatchObject({ at: { x: AWAY_FROM_SPAWN, y: 0, z: 0 } });
  });

  it("sends a death to the moved mark rather than to the authored one", async () => {
    await putCheckpoint(checkpointWithMarker());
    const alice = await connect("alice");
    await anchorHere(alice.ws);

    await killAndTick("alice");

    const { position } = await storedRows("alice");
    expect(position?.x).toBe(AWAY_FROM_SPAWN);
  });

  it("stores the spawn coordinates the first time it sees somebody", async () => {
    await putCheckpoint(checkpointWithSword());
    await connect("alice");

    const spawn = await runInDurableObject(stub(), async (_instance, state) =>
      state.storage.get<Record<string, unknown>>("spawn:alice"),
    );
    expect(spawn).toMatchObject({ x: SPAWN_CELL, y: 0, z: 0 });
  });

  it("hands back a fresh empty bag", async () => {
    await armedAlice();
    await killAndTick("alice");
    await simulateEviction();

    const { hello } = await connect("alice");

    const equipment = hello.equipment as {
      weapon: unknown;
      bag: { tileId: string; contents: unknown[] } | null;
    };
    expect(equipment.weapon).toBeNull();
    expect(equipment.bag?.tileId).toBe(BAG_TILE_ID);
    expect(equipment.bag?.contents).toEqual([]);
  });

  async function hurtAndPoisoned(actorId: string) {
    await runInDurableObject(stub(), (instance: GameServer) => {
      const internals = instance as unknown as {
        session: {
          actors: Map<string, unknown>;
          actorIds(): Iterable<string>;
          applyDamage(actor: unknown, amount: number): void;
          grantStatus(actor: unknown, grant: { id: string }): void;
        };
        saveActors(actorIds: Iterable<string>, force: boolean): void;
      };
      const body = internals.session.actors.get(actorId);
      expect(body).toBeDefined();
      internals.session.applyDamage(body, 1);
      internals.session.grantStatus(body, { id: "poison" });
      internals.saveActors(internals.session.actorIds(), true);
    });
  }

  async function storedBody(actorId: string) {
    return await runInDurableObject(stub(), async (_instance, state) => ({
      hp: await state.storage.get<{ hp: number | null }>(`hp:${actorId}`),
      statuses: await state.storage.get<{ statuses: { defId: string }[] }>(`status:${actorId}`),
    }));
  }

  it("writes away the health and the conditions they died with", async () => {
    await armedAlice();
    await hurtAndPoisoned("alice");
    const before = await storedBody("alice");
    expect(before.hp?.hp).toBeGreaterThan(0);
    expect(before.statuses?.statuses.map((s) => s.defId)).toContain("poison");

    await killAndTick("alice");

    const after = await storedBody("alice");
    expect(after.hp?.hp).toBeNull();
    expect(after.statuses?.statuses).toEqual([]);
  });

  it("brings them back under nothing, on full health", async () => {
    const alice = await armedAlice();
    await hurtAndPoisoned("alice");
    await killAndTick("alice");

    send(alice.ws, { type: "rebirth" });
    const hello = await messageWithin(alice.ws, "hello", 1000);

    expect(hello!.statuses).toEqual([]);
    const mine = (hello!.hps as { actorId: string; hp: number; maxHp: number }[]).find(
      (entry) => entry.actorId === "alice",
    );
    expect(mine!.hp).toBe(mine!.maxHp);
  });

  it("brings them back on full hit points", async () => {
    await armedAlice();
    await killAndTick("alice");
    await simulateEviction();

    const { hello } = await connect("alice");

    const mine = (hello.hps as { actorId: string; hp: number; maxHp: number }[]).find(
      (entry) => entry.actorId === "alice",
    );
    expect(mine!.hp).toBe(mine!.maxHp);
  });

  it("hands back a world holding the sword exactly once", async () => {
    await armedAlice();
    await killAndTick("alice");
    await simulateEviction();

    const { hello } = await connect("alice");

    expect(tilesAt(hello.map as FlatMapFile, AWAY_FROM_SPAWN)).toContain(SWORD);
    const equipment = hello.equipment as {
      weapon: unknown;
      bag: { contents?: unknown[] } | null;
    };
    expect(equipment.weapon).toBeNull();
    expect(equipment.bag?.contents ?? []).toEqual([]);
  });

  it("seats them at the spawn point after a reload", async () => {
    await armedAlice();
    await killAndTick("alice");
    await simulateEviction();

    await connect("alice");

    expect(await actorX("alice")).toBe(SPAWN_CELL);
  });

  it("tells the dying player they died, after the patch that emptied them", async () => {
    const alice = await armedAlice();
    const seen = record(alice.ws);

    await killAndTick("alice");

    const types = seen.types();
    expect(types).toContain("died");
    expect(types.indexOf("patch")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("patch")).toBeLessThan(types.indexOf("died"));
  });

  it("hands the emptied kit over on the death itself", async () => {
    const alice = await armedAlice();
    const seen = record(alice.ws);

    await killAndTick("alice");

    const died = seen.of("died")[0]!;
    const equipment = died.equipment as Record<string, unknown>;
    expect(equipment.weapon).toBeNull();
    expect(equipment.offhand).toBeNull();
    expect(equipment.bag).toBeNull();
  });

  it("stops talking to a dead socket, while the world goes on for everyone else", async () => {
    const alice = await armedAlice();
    const bob = await connect("bob");
    await killAndTick("alice");
    const afterDeath = record(alice.ws);
    const bobSees = record(bob.ws);

    step(bob.ws, 1, "e");
    const bobsWalk = await walkWithin(bob.ws, 1000);

    expect(bobsWalk).not.toBeNull();
    expect(bobSees.types()).toContain("patch");
    expect(afterDeath.types()).toEqual([]);
  });

  it("puts a body back and re-tells the world on a rebirth", async () => {
    const alice = await armedAlice();
    await killAndTick("alice");
    expect(await actorX("alice")).toBeNull();

    send(alice.ws, { type: "rebirth" });
    const hello = await messageWithin(alice.ws, "hello", 1000);

    expect(hello).not.toBeNull();
    expect(hello!.selfId).toBe("alice");
    expect(await actorX("alice")).toBe(SPAWN_CELL);
  });

  it("starts talking to them again once they are back", async () => {
    const alice = await armedAlice();
    const bob = await connect("bob");
    await killAndTick("alice");

    send(alice.ws, { type: "rebirth" });
    expect(await messageWithin(alice.ws, "hello", 1000)).not.toBeNull();
    step(bob.ws, 1, "e");

    expect(await walkWithin(alice.ws, 1000)).not.toBeNull();
  });

  it("ignores a rebirth from somebody who is not dead", async () => {
    const alice = await armedAlice();

    send(alice.ws, { type: "rebirth" });

    expect(await messageWithin(alice.ws, "hello", 500)).toBeNull();
    expect(await actorX("alice")).toBe(AWAY_FROM_SPAWN);
  });

  it("keeps a dead socket silent across an eviction", async () => {
    const alice = await armedAlice();
    const bob = await connect("bob");
    await killAndTick("alice");
    await simulateEviction();
    const afterWake = record(alice.ws);

    step(bob.ws, 1, "e");
    expect(await walkWithin(bob.ws, 1000)).not.toBeNull();

    expect(await actorX("alice")).toBeNull();
    expect(afterWake.types()).toEqual([]);
  });
});

describe("statuses across a disconnection", () => {
  const BERRY_REF = { x: 1, y: 0, z: 0, stackIndex: 1 };

  function mapWithBerry(): FlatMapFile {
    const map = authoredMap();
    map.levels["0"]!["1,0"] = [{ tileId: "grass" }, { tileId: "berry" }];
    return map;
  }

  async function storedStatuses(
    actorId: string,
  ): Promise<{ defId: string; remainingMs: number }[] | undefined> {
    let found: { statuses: { defId: string; remainingMs: number }[] } | undefined;
    await runInDurableObject(stub(), async (_instance, state) => {
      found = await state.storage.get(`status:${actorId}`);
    });
    return found?.statuses;
  }

  type LiveStatus = { defId: string; remainingMs: number };

  async function liveStatuses(actorId: string): Promise<LiveStatus[] | null> {
    let found: LiveStatus[] | null = null;
    await runInDurableObject(stub(), (instance: GameServer) => {
      const session = (
        instance as unknown as {
          session: { statusesOf(id: string): readonly LiveStatus[] | null };
        }
      ).session;
      found = [...(session.statusesOf(actorId) ?? [])];
    });
    return found;
  }

  it("writes down what is running as the world settles", async () => {
    await harness.blobs.put("map.json", JSON.stringify(mapWithBerry()), JSON_TYPE);
    const who = freshPlayer();
    const { ws } = await connect(who);

    send(ws, { type: "consume", from: { kind: "floor", ref: BERRY_REF } });
    await noiseWithin(ws, 1000);
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    const stored = await storedStatuses(who);
    expect(stored?.map((entry) => entry.defId)).toEqual(["fed"]);
    expect(stored![0]!.remainingMs).toBeGreaterThan(0);
  });

  it("comes back exactly where it left off", async () => {
    await harness.blobs.put("map.json", JSON.stringify(mapWithBerry()), JSON_TYPE);
    const who = freshPlayer();
    const first = await connect(who);

    send(first.ws, { type: "consume", from: { kind: "floor", ref: BERRY_REF } });
    await noiseWithin(first.ws, 1000);
    await leave(first.ws);

    const away = await storedStatuses(who);
    expect(away?.[0]?.defId).toBe("fed");
    const remainingWhenTheyLeft = away![0]!.remainingMs;

    await new Promise((resolve) => setTimeout(resolve, QUIET_MS * 3));
    await simulateEviction();

    await connect(who);
    const back = await liveStatuses(who);
    expect(back?.map((entry) => entry.defId)).toEqual(["fed"]);
    expect(back![0]!.remainingMs).toBe(remainingWhenTheyLeft);
  });

  it("writes no health down for a body that is not hurt", async () => {
    await harness.blobs.put("map.json", JSON.stringify(mapWithBerry()), JSON_TYPE);
    const who = freshPlayer();
    const { ws } = await connect(who);

    send(ws, { type: "consume", from: { kind: "floor", ref: BERRY_REF } });
    await noiseWithin(ws, 1000);
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    let stored: unknown;
    await runInDurableObject(stub(), async (_instance, state) => {
      stored = await state.storage.get(`hp:${who}`);
    });
    expect(stored).toBeUndefined();
  });
});

describe("commands", () => {
  it("answers with what changed and what it now reads", async () => {
    const who = freshPlayer();
    const { ws } = await connect(who);

    send(ws, { type: "command", text: "/mastery sharp 10" });

    const notice = await nextMessageOfType(ws, "notice");
    expect(notice.text).toBe("Your sharp mastery is now 10");
    const masteries = await nextMessageOfType(ws, "masteries");
    expect((masteries.masteryXp as Record<string, number>).sharp).toBe(xpForLevel(10));
  });

  it("says why, rather than nothing, when the line was not a command", async () => {
    const who = freshPlayer();
    const { ws } = await connect(who);

    send(ws, { type: "command", text: "/mastery blad 10" });

    const notice = await nextMessageOfType(ws, "notice");
    expect(notice.text).toContain("blad");
  });

  it("never becomes a bubble in the room", async () => {
    const who = freshPlayer();
    const { ws } = await connect(who);
    const onlooker = await connect(freshPlayer());

    send(ws, { type: "command", text: "/mastery sharp 10" });
    await nextMessageOfType(ws, "notice");

    expect(await chatWithin(onlooker.ws, QUIET_MS)).toBeNull();
  });

  describe("only an administrator runs one", () => {
    it("refuses a player who is not one, and says so", async () => {
      const who = freshPlayer();
      const { ws } = await connect(who, { admin: false });

      send(ws, { type: "command", text: "/mastery sharp 100" });

      const notice = await nextMessageOfType(ws, "notice");
      expect(notice.text).toBe("Only an administrator can run commands");
    });

    it("leaves the masteries it named exactly where they were", async () => {
      const who = freshPlayer();
      const { ws } = await connect(who, { admin: false });

      send(ws, { type: "command", text: "/mastery sharp 100" });
      await nextMessageOfType(ws, "notice");

      let stored: unknown;
      await runInDurableObject(stub(), async (_instance, state) => {
        stored = await state.storage.get(`mast:${who}`);
      });
      expect(stored).toBeUndefined();
    });

    it("does not let one player harm another", async () => {
      const victim = freshPlayer();
      await connect(victim);
      const { ws } = await connect(freshPlayer(), { admin: false });

      send(ws, { type: "command", text: `/health -1 ${victim}` });
      await nextMessageOfType(ws, "notice");
      await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

      let stored: unknown;
      await runInDurableObject(stub(), async (_instance, state) => {
        stored = await state.storage.get(`hp:${victim}`);
      });
      expect(stored).toBeUndefined();
    });

    it("still refuses a line that would not have parsed", async () => {
      const { ws } = await connect(freshPlayer(), { admin: false });

      send(ws, { type: "command", text: "/masteyr sharp" });

      const notice = await nextMessageOfType(ws, "notice");
      expect(notice.text).toBe("Only an administrator can run commands");
    });

    it("says nothing out loud either", async () => {
      const { ws } = await connect(freshPlayer(), { admin: false });
      const onlooker = await connect(freshPlayer());

      send(ws, { type: "command", text: "/mastery sharp 100" });
      await nextMessageOfType(ws, "notice");

      expect(await chatWithin(onlooker.ws, QUIET_MS)).toBeNull();
    });
  });
});

describe("casting", () => {
  const STONE_TILE_ID = "test-arcane-stone";
  const STONE_COOLDOWN_MS = 60_000;

  const BOLT_TILE_ID = "test-arcane-bolt";
  const BOLT_DAMAGE = 30;

  function stoneTile(): unknown {
    return {
      id: STONE_TILE_ID,
      name: "Test Stone",
      height: 0,
      type: "simple",
      kind: "item",
      attributes: {},
      lightPassing: true,
      intangible: true,
      affectedByGravity: true,
      interactions: {
        item: {
          type: "stone",
          effect: { kind: "bolt", damage: -10, on: "caster" },
          cooldownMs: STONE_COOLDOWN_MS,
        },
      },
      sprite: {
        frames: [
          {
            sprite: {
              tilesetId: "tiny-ranch-tiles",
              rect: { x: 0, y: 0, w: 1, h: 1 },
              base: { x: 0, y: 0 },
            },
            durationMs: 200,
          },
        ],
      },
    };
  }

  function boltTile(): unknown {
    return {
      id: BOLT_TILE_ID,
      name: "Test Bolt",
      height: 0,
      type: "simple",
      kind: "item",
      attributes: {},
      lightPassing: true,
      intangible: true,
      affectedByGravity: true,
      interactions: {
        item: {
          type: "stone",
          effect: {
            kind: "bolt",
            damage: BOLT_DAMAGE,
            on: "target",
            projectile: "arrow",
          },
          cooldownMs: STONE_COOLDOWN_MS,
          reach: { cells: 8, height: 4 },
        },
      },
      sprite: {
        frames: [
          {
            sprite: {
              tilesetId: "tiny-ranch-tiles",
              rect: { x: 0, y: 0, w: 1, h: 1 },
              base: { x: 0, y: 0 },
            },
            durationMs: 200,
          },
        ],
      },
    };
  }

  function tilesWithStone(): unknown[] {
    return [
      ...(tilesJson as unknown[]).map((tile) => {
        const def = tile as Record<string, unknown>;
        if (def.id !== PLAYER_TILE_ID) return tile;
        const interactions = def.interactions as Record<string, unknown>;
        const battler = interactions.battler as Record<string, unknown>;
        return {
          ...def,
          interactions: {
            ...interactions,
            battler: {
              baseHp: 8,
              ...battler,
              kit: [
                ...((battler.kit as unknown[]) ?? []),
                { slot: "charm", tileId: STONE_TILE_ID, chance: 100 },
                { slot: "weapon", tileId: BOLT_TILE_ID, chance: 100 },
              ],
            },
          },
        };
      }),
      stoneTile(),
      boltTile(),
    ];
  }

  function charmCooldown(message: Record<string, unknown>): number | undefined {
    const equipment = message.equipment as {
      charm: { tileId: string; cooldownMs?: number } | null;
    };
    return equipment.charm?.cooldownMs;
  }

  beforeEach(async () => {
    await harness.blobs.put("tiles.json", JSON.stringify(tilesWithStone()), JSON_TYPE);
    await harness.blobs.put("map.json", JSON.stringify(authoredMap()), JSON_TYPE);
  });

  it("puts the stone on cooldown and says so on the kit message", async () => {
    const { ws, hello } = await connect(freshPlayer());
    expect(charmCooldown(hello)).toBeUndefined();

    send(ws, { type: "cast", slot: { from: "square", square: "charm" } });
    const kit = await equipmentWithin(ws);
    expect(kit).not.toBeNull();
    expect(charmCooldown(kit!)).toBe(STONE_COOLDOWN_MS);
  });

  it("puts a cast's flight and its receipt on the wire", async () => {
    const victimId = freshPlayer();
    const thrower = await connect(freshPlayer());
    const victim = await connect(victimId);

    send(thrower.ws, { type: "pvp", enabled: true });
    send(victim.ws, { type: "pvp", enabled: true });

    const shots = eventsWithin(thrower.ws, "projectileFired", 400);
    const hits = eventsWithin(thrower.ws, "damage", 400);

    send(thrower.ws, { type: "target", actorId: victimId });
    send(thrower.ws, { type: "cast", slot: { from: "square", square: "weapon" } });

    expect((await shots).map((shot) => shot.tileId)).toContain("arrow");
    expect(await hits).not.toHaveLength(0);
  });

  it("brings the cooldown back after the world has been evicted", async () => {
    const who = freshPlayer();
    const first = await connect(who);
    send(first.ws, { type: "cast", slot: { from: "square", square: "charm" } });
    await equipmentWithin(first.ws);
    await leave(first.ws);

    await simulateEviction();

    const { hello } = await connect(who);
    expect(charmCooldown(hello)).toBeGreaterThan(0);
  });
});

describe("saving authored content", () => {
  const STONE_TILE_ID = "reload-test-stone";
  const LONG_MS = 120_000;
  const SHORT_MS = 10_000;

  function stoneTile(cooldownMs: number): unknown {
    return {
      id: STONE_TILE_ID,
      name: "Reload Stone",
      height: 0,
      type: "simple",
      kind: "item",
      attributes: {},
      lightPassing: true,
      intangible: true,
      affectedByGravity: true,
      interactions: {
        item: {
          type: "stone",
          effect: { kind: "bolt", damage: -10, on: "caster" },
          cooldownMs,
        },
      },
      sprite: {
        frames: [
          {
            sprite: {
              tilesetId: "tiny-ranch-tiles",
              rect: { x: 0, y: 0, w: 1, h: 1 },
              base: { x: 0, y: 0 },
            },
            durationMs: 200,
          },
        ],
      },
    };
  }

  function tilesWithStone(cooldownMs: number): unknown[] {
    return [
      ...(tilesJson as unknown[]).map((tile) => {
        const def = tile as Record<string, unknown>;
        if (def.id !== PLAYER_TILE_ID) return tile;
        const interactions = def.interactions as Record<string, unknown>;
        const battler = interactions.battler as Record<string, unknown>;
        return {
          ...def,
          interactions: {
            ...interactions,
            battler: {
              baseHp: 8,
              ...battler,
              kit: [
                ...((battler.kit as unknown[]) ?? []),
                { slot: "charm", tileId: STONE_TILE_ID, chance: 100 },
              ],
            },
          },
        };
      }),
      stoneTile(cooldownMs),
    ];
  }

  async function saveTiles(cooldownMs: number) {
    await harness.blobs.put("tiles.json", JSON.stringify(tilesWithStone(cooldownMs)), JSON_TYPE);
    await stub().reloadContent();
  }

  function charm(message: Record<string, unknown>) {
    const equipment = message.equipment as {
      charm: { tileId: string; cooldownMs?: number } | null;
    };
    return equipment.charm;
  }

  beforeEach(async () => {
    await harness.blobs.put("tiles.json", JSON.stringify(tilesWithStone(LONG_MS)), JSON_TYPE);
    await harness.blobs.put("map.json", JSON.stringify(authoredMap()), JSON_TYPE);
  });

  it("casts on the cooldown the editor last saved", async () => {
    const { ws } = await connect(freshPlayer());
    await saveTiles(SHORT_MS);
    await messageWithin(ws, "hello", 2000);

    send(ws, { type: "cast", slot: { from: "square", square: "charm" } });
    const kit = await equipmentWithin(ws);
    expect(charm(kit!)?.cooldownMs).toBe(SHORT_MS);
  });

  it("clamps a running cooldown to the shortened stone", async () => {
    const { ws } = await connect(freshPlayer());
    send(ws, { type: "cast", slot: { from: "square", square: "charm" } });
    expect(charm((await equipmentWithin(ws))!)?.cooldownMs).toBe(LONG_MS);

    await saveTiles(SHORT_MS);
    const hello = await messageWithin(ws, "hello", 2000);
    expect(charm(hello!)?.cooldownMs).toBeLessThanOrEqual(SHORT_MS);
  });

  it("leaves everybody carrying what they were carrying", async () => {
    const { ws, hello } = await connect(freshPlayer());
    const before = (hello.equipment as { bag: { tileId: string } | null }).bag;
    expect(before?.tileId).toBe(BAG_TILE_ID);

    await saveTiles(SHORT_MS);
    const after = await messageWithin(ws, "hello", 2000);
    const bag = (after!.equipment as { bag: { tileId: string } | null }).bag;
    expect(bag?.tileId).toBe(BAG_TILE_ID);
    expect(charm(after!)?.tileId).toBe(STONE_TILE_ID);
  });

  it("leaves one body per player, where it was", async () => {
    const who = freshPlayer();
    const { ws } = await connect(who);

    await saveTiles(SHORT_MS);
    const after = await messageWithin(ws, "hello", 2000);

    expect(playerOwners(after!.map as FlatMapFile)).toEqual([who]);
  });

  it("does nothing at all to a world that is not running", async () => {
    await expect(stub().reloadContent()).resolves.toBeUndefined();
  });
});

describe("tile transitions", () => {
  const STONE = "arcane-stone-of-flame";

  function tilesWithInstantStone() {
    return (tilesJson as Array<Record<string, unknown>>).map((def) => {
      if (def.id !== STONE) return def;
      const interactions = def.interactions as Record<string, unknown>;
      const item = interactions.item as Record<string, unknown>;
      const { castTimeMs: _takenOff, ...instant } = item;
      return { ...def, interactions: { ...interactions, item: instant } };
    });
  }

  function checkpointWithStone(): {
    map: FlatMapFile;
    spawn: { x: number; y: number; z: number; stackIndex: number };
  } {
    const ground: Record<string, unknown[]> = {};
    for (let x = 0; x < 3; x++) {
      for (let y = 0; y < 3; y++) ground[`${x},${y}`] = [{ tileId: "grass" }];
    }
    ground["1,0"] = [
      { tileId: "grass" },
      { tileId: STONE, itemId: "stone-1" },
      { tileId: "player", direction: "s", owner: "alice" },
    ];
    return {
      map: { version: MAP_FILE_VERSION, levels: { "0": ground } } as FlatMapFile,
      spawn: { x: 1, y: 0, z: 0, stackIndex: 1 },
    };
  }

  it("announces a conjured tile's way in on the cast's own flush", async () => {
    await harness.blobs.put("tiles.json", JSON.stringify(tilesWithInstantStone()), JSON_TYPE);
    const alice = await connect("alice");
    await putCheckpoint(checkpointWithStone());
    await simulateEviction();

    send(alice.ws, { type: "pickUp", ref: { x: 1, y: 0, z: 0, stackIndex: 1 } });
    const kit = await equipmentWithin(alice.ws);
    const index = contentsOf(kit ?? {}).findIndex((item) => item.tileId === STONE);
    expect(index).toBeGreaterThanOrEqual(0);

    send(alice.ws, {
      type: "moveItem",
      from: { kind: "contents", index },
      to: { kind: "offhand" },
    });
    await equipmentWithin(alice.ws);

    send(alice.ws, { type: "command", text: "/mastery arcane 10" });
    await nextMessageOfType(alice.ws, "masteries");

    send(alice.ws, { type: "cast", slot: { from: "square", square: "offhand" } });
    const formed = await eventWithin(
      alice.ws,
      "tileTransition",
      2000,
      (event) => event.tileId === "arcane-flame",
    );

    expect(formed).toMatchObject({
      kind: "tileTransition",
      side: "appear",
      tileId: "arcane-flame",
      x: 1,
      y: 1,
      z: 0,
    });
  });

  const DISSOLVE = {
    durationMs: 300,
    dissolve: { pattern: "noise", edgeColor: "#8ce6ff", edgeWidth: 0.1 },
  };

  function tilesWithPlayer(transitions: Record<string, unknown>) {
    return (tilesJson as { id: string }[]).map((def) =>
      def.id === "player" ? { ...def, transitions } : def,
    );
  }

  it("sends a joining player's way in, although a join is not a tick", async () => {
    await harness.blobs.put(
      "tiles.json",
      JSON.stringify(tilesWithPlayer({ appear: DISSOLVE })),
      JSON_TYPE,
    );
    const alice = await connect("alice");
    const arrived = await eventWithin(alice.ws, "tileTransition", 2000);

    expect(arrived).toMatchObject({
      kind: "tileTransition",
      side: "appear",
      tileId: "player",
    });
  });

  it("sends a leaving player's way out to everybody still here", async () => {
    await harness.blobs.put(
      "tiles.json",
      JSON.stringify(tilesWithPlayer({ disappear: DISSOLVE })),
      JSON_TYPE,
    );
    const alice = await connect("alice");
    const bob = await connect("bob");
    const left = eventWithin(alice.ws, "tileTransition", 2000);
    await disconnect(bob.pair);

    expect(await left).toMatchObject({
      kind: "tileTransition",
      side: "disappear",
      tileId: "player",
    });
  });
});

describe("a pull somebody else is making", () => {
  function mapWithBush(): FlatMapFile {
    const map = authoredMap();
    map.levels["0"]!["1,0"] = [{ tileId: "grass" }, { tileId: "bush" }];
    return map;
  }

  const BUSH_REF = { x: 1, y: 0, z: 0, stackIndex: 1 };

  function pullWithin(ws: TestSocket, actorId: string): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const done = (value: Record<string, unknown> | null) => {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve(value);
      };
      const onMessage = (event: { data: string }) => {
        const message = JSON.parse(event.data) as Record<string, unknown>;
        if (message.type !== "patch") return;
        const entries = (message.extractions ?? []) as Record<string, unknown>[];
        const entry = entries.find((e) => e.actorId === actorId);
        if (entry) done(entry);
      };
      const timer = setTimeout(() => done(null), MESSAGE_TIMEOUT_MS);
      ws.addEventListener("message", onMessage);
    });
  }

  it("is broadcast to everybody when it starts and when it lands", async () => {
    await harness.blobs.put("map.json", JSON.stringify(mapWithBush()), JSON_TYPE);
    const alice = await connect("alice");
    const bob = await connect("bob");

    const starting = pullWithin(bob.ws, "alice");
    send(alice.ws, { type: "interact", ref: BUSH_REF });
    const started = await starting;
    const progress = started?.progress as { remainingMs: number; durationMs: number };
    expect(progress.durationMs).toBeGreaterThan(0);
    expect(progress.remainingMs).toBeLessThanOrEqual(progress.durationMs);
    expect(progress).not.toHaveProperty("key");

    expect(await pullWithin(bob.ws, "alice")).toEqual({
      actorId: "alice",
      progress: null,
    });
  });

  it("is handed to somebody who arrives part-way through it", async () => {
    await harness.blobs.put("map.json", JSON.stringify(mapWithBush()), JSON_TYPE);
    const alice = await connect("alice");
    send(alice.ws, { type: "interact", ref: BUSH_REF });
    await messageWithin(alice.ws, "extracting", MESSAGE_TIMEOUT_MS);

    const bob = await connect("bob");

    expect(bob.hello.extractions).toEqual([expect.objectContaining({ actorId: "alice" })]);
  });
});

describe("a cast somebody else is making", () => {
  const STONE = "arcane-stone-of-flame";

  const CAST_MS = 2_000;

  function tilesWithArcanist() {
    return (tilesJson as Array<Record<string, unknown>>).map((def) => {
      if (def.id === STONE) {
        const interactions = def.interactions as Record<string, unknown>;
        const item = interactions.item as Record<string, unknown>;
        return {
          ...def,
          interactions: {
            ...interactions,
            item: { ...item, castTimeMs: CAST_MS },
          },
        };
      }
      if (def.id !== "player") return def;
      const interactions = def.interactions as Record<string, unknown>;
      const battler = interactions.battler as Record<string, unknown>;
      return {
        ...def,
        interactions: {
          ...interactions,
          battler: {
            ...battler,
            masteries: {
              ...(battler.masteries as Record<string, number>),
              ...stoneAsks(),
            },
            kit: [...(battler.kit as unknown[]), { slot: "charm", tileId: STONE, chance: 100 }],
          },
        },
      };
    });
  }

  function stoneAsks(): Record<string, number> {
    const def = (tilesJson as Array<Record<string, unknown>>).find((tile) => tile.id === STONE)!;
    const interactions = def.interactions as Record<string, unknown>;
    const item = interactions.item as Record<string, unknown>;
    return item.requirements as Record<string, number>;
  }

  function castWithin(ws: TestSocket, actorId: string): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const done = (value: Record<string, unknown> | null) => {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve(value);
      };
      const onMessage = (event: { data: string }) => {
        const message = JSON.parse(event.data) as Record<string, unknown>;
        if (message.type !== "patch") return;
        const entries = (message.castings ?? []) as Record<string, unknown>[];
        const entry = entries.find((e) => e.actorId === actorId);
        if (entry) done(entry);
      };
      const timer = setTimeout(() => done(null), MESSAGE_TIMEOUT_MS);
      ws.addEventListener("message", onMessage);
    });
  }

  it("is broadcast to everybody when it starts and when it lands", async () => {
    await harness.blobs.put("tiles.json", JSON.stringify(tilesWithArcanist()), JSON_TYPE);
    const alice = await connect("alice");
    const bob = await connect("bob");

    const starting = castWithin(bob.ws, "alice");
    send(alice.ws, { type: "cast", slot: { from: "square", square: "charm" } });
    const started = await starting;
    const progress = started?.progress as {
      remainingMs: number;
      durationMs: number;
      slot: { from: string; square?: string };
    };
    expect(progress.durationMs).toBeGreaterThan(0);
    expect(progress.remainingMs).toBeLessThanOrEqual(progress.durationMs);
    expect(progress.slot).toEqual({ from: "square", square: "charm" });

    expect(await castWithin(bob.ws, "alice")).toEqual({
      actorId: "alice",
      progress: null,
    });
  });

  it("ends when the caster says stop, and the stone is still ready", async () => {
    await harness.blobs.put("tiles.json", JSON.stringify(tilesWithArcanist()), JSON_TYPE);
    const alice = await connect("alice");
    const bob = await connect("bob");

    const starting = castWithin(bob.ws, "alice");
    send(alice.ws, { type: "cast", slot: { from: "square", square: "charm" } });
    expect((await starting)?.progress).not.toBeNull();

    const ending = castWithin(bob.ws, "alice");
    send(alice.ws, { type: "cancelCast" });
    expect(await ending).toEqual({ actorId: "alice", progress: null });

    const again = castWithin(bob.ws, "alice");
    send(alice.ws, { type: "cast", slot: { from: "square", square: "charm" } });
    expect((await again)?.progress).not.toBeNull();
  });

  it("is handed to somebody who arrives part-way through it", async () => {
    await harness.blobs.put("tiles.json", JSON.stringify(tilesWithArcanist()), JSON_TYPE);
    const alice = await connect("alice");
    send(alice.ws, { type: "cast", slot: { from: "square", square: "charm" } });
    await messageWithin(alice.ws, "patch", MESSAGE_TIMEOUT_MS);

    const bob = await connect("bob");

    expect(bob.hello.castings).toEqual([expect.objectContaining({ actorId: "alice" })]);
  });
});

describe("the pvp switch", () => {
  function pvpWithin(
    ws: TestSocket,
    actorId: string,
  ): Promise<{ actorId: string; on: boolean } | null> {
    return new Promise((resolve) => {
      const done = (value: { actorId: string; on: boolean } | null) => {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve(value);
      };
      const onMessage = (event: { data: string }) => {
        const message = JSON.parse(event.data) as Record<string, unknown>;
        if (message.type !== "patch") return;
        const entries = (message.pvp ?? []) as Array<{
          actorId: string;
          on: boolean;
        }>;
        const entry = entries.find((e) => e.actorId === actorId);
        if (entry) done(entry);
      };
      const timer = setTimeout(() => done(null), MESSAGE_TIMEOUT_MS);
      ws.addEventListener("message", onMessage);
    });
  }

  it("reaches everybody else when it moves", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");

    const turningOn = pvpWithin(bob.ws, "alice");
    send(alice.ws, { type: "pvp", enabled: true });
    expect(await turningOn).toEqual({ actorId: "alice", on: true });

    const turningOff = pvpWithin(bob.ws, "alice");
    send(alice.ws, { type: "pvp", enabled: false });
    expect(await turningOff).toEqual({ actorId: "alice", on: false });
  });

  it("is handed in full to somebody who arrives after it was moved", async () => {
    const alice = await connect("alice");
    send(alice.ws, { type: "pvp", enabled: true });
    await messageWithin(alice.ws, "patch", MESSAGE_TIMEOUT_MS);

    const bob = await connect("bob");

    expect(bob.hello.pvp).toEqual([{ actorId: "alice", on: true }]);
  });

  it("comes back with a player who reconnects", async () => {
    const first = await connect("alice");
    send(first.ws, { type: "pvp", enabled: true });
    await messageWithin(first.ws, "patch", MESSAGE_TIMEOUT_MS);
    first.ws.close();

    await simulateEviction();

    const second = await connect("alice");
    expect(second.hello.pvp).toEqual([{ actorId: "alice", on: true }]);
  });
});

describe("an administrator hiding", () => {
  function mentions(message: Record<string, unknown>, actorId: string): boolean {
    return JSON.stringify(message).includes(`"${actorId}"`);
  }

  function hiddenWithin(ws: TestSocket, on: boolean): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const done = (value: Record<string, unknown> | null) => {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve(value);
      };
      const onMessage = (event: { data: string }) => {
        const message = JSON.parse(event.data) as Record<string, unknown>;
        if (message.type === "hidden" && message.on === on) done(message);
      };
      const timer = setTimeout(() => done(null), MESSAGE_TIMEOUT_MS);
      ws.addEventListener("message", onMessage);
    });
  }

  async function hide(ws: TestSocket) {
    const answer = hiddenWithin(ws, true);
    send(ws, { type: "hidden", enabled: true });
    expect(await answer).toEqual({ type: "hidden", on: true });
  }

  it("reads as a logout to everybody else", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob", { admin: false });

    const gone = eventWithin(bob.ws, "despawned", MESSAGE_TIMEOUT_MS, (e) => e.actorId === "alice");
    await hide(alice.ws);

    expect(await gone).not.toBeNull();
  });

  it("does not tell the administrator they have left", async () => {
    const alice = await connect("alice");
    await connect("bob", { admin: false });
    const seen = record(alice.ws);

    await hide(alice.ws);
    await Bun.sleep(300);

    const aboutSelf = seen
      .of("patch")
      .flatMap((patch) => patch.events as Record<string, unknown>[])
      .filter((event) => event.actorId === "alice");
    expect(aboutSelf.map((event) => event.kind)).not.toContain("left");
    expect(aboutSelf.map((event) => event.kind)).not.toContain("despawned");
  });

  it("sends nobody else anything about the body afterwards", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob", { admin: false });
    await hide(alice.ws);
    await Bun.sleep(200);
    const seen = record(bob.ws);

    step(alice.ws, 1, "e");
    say(alice.ws, "can anybody see me");
    const own = await chatWithin(alice.ws, 1000);
    await Bun.sleep(300);

    expect(own).toMatchObject({ actorId: "alice", text: "can anybody see me" });
    expect(seen.of("chat")).toEqual([]);
    expect(seen.of("patch").filter((patch) => mentions(patch, "alice"))).toEqual([]);
  });

  it("shows the damage done to the body to its owner alone", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob", { admin: false });
    await hide(alice.ws);
    await Bun.sleep(200);

    const seen = eventsWithin(bob.ws, "damage", 400);
    const felt = eventsWithin(alice.ws, "damage", 400);
    send(alice.ws, { type: "command", text: "/health -1" });

    expect((await felt).map((hit) => hit.targetId)).toEqual(["alice"]);
    expect(await seen).toEqual([]);
  });

  it("is left out of what somebody arriving afterwards is handed", async () => {
    const alice = await connect("alice");
    await hide(alice.ws);

    const carol = await connect("carol", { admin: false });

    expect(carol.hello.actorIds).toEqual(["carol"]);
    expect(mentions(carol.hello, "alice")).toBe(false);
  });

  it("is counted out of the headcount other administrators are sent", async () => {
    const alice = await connect("alice");
    const dave = await connect("dave");
    await nextMessageOfType(alice.ws, "players");

    const count = nextMessageOfType(dave.ws, "players");
    await hide(alice.ws);

    expect(await count).toEqual({ type: "players", playerCount: 1 });
  });

  it("is ignored from somebody who is not an administrator", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob", { admin: false });
    const seen = record(alice.ws);
    const bobSeen = record(bob.ws);

    send(bob.ws, { type: "hidden", enabled: true });
    say(bob.ws, "still here");

    expect(await chatWithin(alice.ws, 1000)).toMatchObject({ actorId: "bob" });
    const events = seen.of("patch").flatMap((patch) => patch.events as Record<string, unknown>[]);
    expect(events.filter((event) => event.kind === "left")).toEqual([]);
    expect(bobSeen.of("hidden")).toEqual([]);
  });

  it("stays on across a reconnect, which nobody else hears", async () => {
    const first = await connect("alice");
    const bob = await connect("bob", { admin: false });
    await hide(first.ws);
    first.ws.close();
    await Bun.sleep(200);
    const seen = record(bob.ws);

    const second = await connect("alice");
    expect(await hiddenWithin(second.ws, true)).toEqual({ type: "hidden", on: true });
    await Bun.sleep(300);

    expect(seen.of("patch").filter((patch) => mentions(patch, "alice"))).toEqual([]);
  });

  it("is not honoured for an account that is no longer an administrator", async () => {
    const first = await connect("alice");
    await hide(first.ws);
    first.ws.close();
    await Bun.sleep(200);

    await connect("alice", { admin: false });
    const bob = await connect("bob", { admin: false });

    expect(bob.hello.actorIds).toContain("alice");
  });

  it("comes back as a login when it is turned off", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob", { admin: false });
    await hide(alice.ws);
    await Bun.sleep(200);
    bob.ws.discardPending();

    const joined = eventWithin(bob.ws, "joined", MESSAGE_TIMEOUT_MS, (e) => e.actorId === "alice");
    const back = eventWithin(bob.ws, "spawned", MESSAGE_TIMEOUT_MS, (e) => e.actorId === "alice");
    send(alice.ws, { type: "hidden", enabled: false });

    expect(await joined).toMatchObject({ kind: "joined", actorId: "alice" });
    expect(await back).not.toBeNull();
  });
});

describe("what each client is told has changed", () => {
  function pvpFor(
    ws: TestSocket,
    actorId: string,
  ): Promise<{ actorId: string; on: boolean } | null> {
    return new Promise((resolve) => {
      const done = (value: { actorId: string; on: boolean } | null) => {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve(value);
      };
      const onMessage = (event: { data: string }) => {
        const message = JSON.parse(event.data) as Record<string, unknown>;
        if (message.type !== "patch") return;
        const entries = (message.pvp ?? []) as Array<{
          actorId: string;
          on: boolean;
        }>;
        const entry = entries.find((e) => e.actorId === actorId);
        if (entry) done(entry);
      };
      const timer = setTimeout(() => done(null), MESSAGE_TIMEOUT_MS);
      ws.addEventListener("message", onMessage);
    });
  }

  async function kill(actorId: string) {
    await runInDurableObject(stub(), (instance: GameServer) => {
      const internals = instance as unknown as {
        session: {
          actors: Map<string, unknown>;
          applyDamage(actor: unknown, amount: number): void;
        };
        tick(): void;
      };
      const body = internals.session.actors.get(actorId);
      expect(body).toBeDefined();
      internals.session.applyDamage(body, 10_000);
      internals.tick();
    });
  }

  async function rememberedPvp(): Promise<string[]> {
    let ids: string[] = [];
    await runInDurableObject(stub(), (instance: GameServer) => {
      const internals = instance as unknown as {
        sentPvp: Map<string, boolean>;
      };
      ids = [...internals.sentPvp.keys()];
    });
    return ids;
  }

  it("forgets a body that has left the board", async () => {
    const alice = await connect("alice");
    await connect("bob");

    send(alice.ws, { type: "pvp", enabled: true });
    expect(await pvpFor(alice.ws, "alice")).toEqual({
      actorId: "alice",
      on: true,
    });
    expect(await rememberedPvp()).toContain("alice");

    await kill("alice");

    expect(await rememberedPvp()).not.toContain("alice");
  });

  it("says nothing about a body that arrives with nothing to say", async () => {
    const alice = await connect("alice");

    const seen = record(alice.ws);
    await connect("bob");
    await wait(200);

    const patches = seen.of("patch");
    expect(patches.length).toBeGreaterThan(0);
    const about = patches.flatMap((message) => [
      ...((message.pvp ?? []) as Array<{ actorId: string }>),
      ...((message.extractions ?? []) as Array<{ actorId: string }>),
      ...((message.castings ?? []) as Array<{ actorId: string }>),
      ...((message.carriedLights ?? []) as Array<{ actorId: string }>),
    ]);
    expect(about.filter((entry) => entry.actorId === "bob")).toEqual([]);
  });

  it("carries the maximum along with the hit points", async () => {
    await connect("alice");
    const bob = await connect("bob");
    const authored = (bob.hello.hps as Array<{ actorId: string; maxHp: number }>).find(
      (entry) => entry.actorId === "alice",
    );
    expect(authored).toBeDefined();

    const hurt = new Promise<{ hp: number; maxHp: number } | null>((resolve) => {
      const done = (value: { hp: number; maxHp: number } | null) => {
        clearTimeout(timer);
        bob.ws.removeEventListener("message", onMessage);
        resolve(value);
      };
      const onMessage = (event: { data: string }) => {
        const message = JSON.parse(event.data) as Record<string, unknown>;
        if (message.type !== "patch") return;
        const entries = (message.hps ?? []) as Array<{
          actorId: string;
          hp: number;
          maxHp: number;
        }>;
        const entry = entries.find((e) => e.actorId === "alice");
        if (entry) done(entry);
      };
      const timer = setTimeout(() => done(null), MESSAGE_TIMEOUT_MS);
      bob.ws.addEventListener("message", onMessage);
    });

    await runInDurableObject(stub(), (instance: GameServer) => {
      const internals = instance as unknown as {
        session: {
          actors: Map<string, unknown>;
          applyDamage(actor: unknown, amount: number): void;
        };
        tick(): void;
      };
      internals.session.applyDamage(internals.session.actors.get("alice"), 1);
      internals.tick();
    });

    const patched = await hurt;
    expect(patched).not.toBeNull();
    expect(patched!.hp).toBeLessThan(authored!.maxHp);
    expect(patched!.maxHp).toBe(authored!.maxHp);
  });

  it("keeps quiet about a body that is doing neither", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");

    const seen = record(alice.ws);
    step(bob.ws, 1, "e");
    await wait(300);

    const patches = seen.of("patch");
    expect(patches.length).toBeGreaterThan(0);
    expect(patches.flatMap((m) => (m.extractions ?? []) as unknown[])).toEqual([]);
    expect(patches.flatMap((m) => (m.castings ?? []) as unknown[])).toEqual([]);
  });
});

describe("patches scoped to a subscription", () => {
  const OUT_OF_REACH = CHUNK_SIZE * (INTEREST_REACH_CHUNKS + 2);
  const IN_REACH = OUT_OF_REACH - 1;

  const ALICE_CELL = CHUNK_SIZE;

  const BODY_OUT = ALICE_CELL + BODY_REACH_ON_LEVEL + 1;
  const BODY_IN = BODY_OUT - 1;

  const DROPPED_SWORD = "rusty-sword";
  const DROPPED_STACK_INDEX = 2;
  const BERRY = "berry";
  const BERRY_STACK_INDEX = 3;

  function farApart(bobAt: number = BODY_OUT): { map: FlatMapFile; spawn: Record<string, number> } {
    const cells: Record<string, unknown[]> = {};
    for (let x = 0; x <= OUT_OF_REACH + 1; x++) {
      cells[`${x},0`] = [{ tileId: "grass" }];
    }
    cells[`${ALICE_CELL},0`] = [
      { tileId: "grass" },
      { tileId: PLAYER_TILE_ID, direction: "s", owner: "alice" },
    ];
    cells[`${bobAt},0`] = [
      { tileId: "grass" },
      { tileId: PLAYER_TILE_ID, direction: "s", owner: "bob" },
      { tileId: DROPPED_SWORD },
      { tileId: BERRY },
    ];
    return {
      map: { version: MAP_FILE_VERSION, levels: { "0": cells } } as FlatMapFile,
      spawn: { x: ALICE_CELL, y: 0, z: 0, stackIndex: 1 },
    };
  }

  async function bothConnected(bobAt: number = BODY_OUT) {
    await putCheckpoint(farApart(bobAt));
    const bob = await connect("bob");
    const alice = await connect("alice");
    expect(await actorX("alice")).toBe(ALICE_CELL);
    expect(await actorX("bob")).toBe(bobAt);
    await settled(alice.ws);
    await settled(bob.ws);
    return { alice, bob };
  }

  async function settled(ws: TestSocket) {
    while ((await messageWithin(ws, "patch", TICK_MS * 3)) !== null);
  }

  async function tickTimes(times: number) {
    await runInDurableObject(stub(), (instance: GameServer) => {
      const internals = instance as unknown as { tick(): void };
      for (let i = 0; i < times; i++) internals.tick();
    });
  }

  function cellOf(hello: Record<string, unknown>, x: number): { tileId: string }[] | undefined {
    const map = hello.map as {
      levels: Record<string, Record<string, { tileId: string }[]>>;
    };
    return map.levels[levelKey(0)]?.[`${x},0`];
  }

  function aliceHolds(hello: Record<string, unknown>, x: number): boolean {
    return cellOf(hello, x) !== undefined;
  }

  async function arrivedAt(actorId: string, x: number) {
    for (let i = 0; i < 100; i++) {
      if ((await actorX(actorId)) === x) return;
      await wait(TICK_MS);
    }
    throw new Error(`${actorId} never reached ${x}`);
  }

  it("leaves a body out of the hello of somebody who cannot reach it", async () => {
    const { alice, bob } = await bothConnected();

    expect(alice.hello.actorIds).toEqual(["alice"]);
    expect(bob.hello.actorIds).toEqual(["bob"]);
    expect(alice.hello.playerCount).toBe(2);
  });

  it("does not tell a client about a step it could not have seen", async () => {
    const { alice, bob } = await bothConnected();
    expect(aliceHolds(alice.hello, BODY_OUT)).toBe(true);
    const heard = record(alice.ws);

    step(bob.ws, 1, "e");
    expect(await walkWithin(bob.ws, 1000)).not.toBeNull();
    await messageWithin(bob.ws, "patch", MESSAGE_TIMEOUT_MS);

    expect(heard.types()).toEqual([]);
  });

  it("hands over the ground under a body it does not mention, without the body", async () => {
    const { alice } = await bothConnected();

    const stack = cellOf(alice.hello, BODY_OUT);
    expect(stack?.map((placed) => placed.tileId)).toEqual(["grass", DROPPED_SWORD, BERRY]);
  });

  it("does not pass on a noise made where this client cannot see", async () => {
    const { alice, bob } = await bothConnected();
    await settled(alice.ws);

    send(bob.ws, {
      type: "consume",
      from: {
        kind: "floor",
        ref: { x: BODY_OUT, y: 0, z: 0, stackIndex: BERRY_STACK_INDEX },
      },
    });
    expect(await noiseWithin(bob.ws, 1000)).toMatchObject({ text: "crunch" });

    expect(await noiseWithin(alice.ws, QUIET_MS)).toBeNull();
  });

  it("passes one on from a body it can see", async () => {
    const { alice, bob } = await bothConnected(BODY_IN);
    await settled(alice.ws);

    send(bob.ws, {
      type: "consume",
      from: {
        kind: "floor",
        ref: { x: BODY_IN, y: 0, z: 0, stackIndex: BERRY_STACK_INDEX },
      },
    });

    expect(await noiseWithin(alice.ws, 1000)).toMatchObject({
      text: "crunch",
      x: BODY_IN,
    });
  });

  it("does not pass on speech from out of sight", async () => {
    const { alice, bob } = await bothConnected();
    await settled(alice.ws);

    send(bob.ws, { type: "say", text: "hello" });

    expect(await chatWithin(alice.ws, QUIET_MS)).toBeNull();
  });

  it("passes speech on from somebody in sight", async () => {
    const { alice, bob } = await bothConnected(BODY_IN);
    await settled(alice.ws);

    send(bob.ws, { type: "say", text: "hello" });

    expect(await chatWithin(alice.ws, 1000)).toMatchObject({
      text: "hello",
      actorId: "bob",
      name: "Bob",
    });
  });

  it("announces a body that walks into reach, with its hit points", async () => {
    const { alice, bob } = await bothConnected();
    const heard = record(alice.ws);

    step(bob.ws, 1, "w");
    const spawned = await eventWithin(alice.ws, "spawned", 2000);

    expect(spawned).toMatchObject({
      actorId: "bob",
      at: { x: BODY_IN, y: 0, z: 0 },
    });
    const hps = heard.of("patch").flatMap((message) => message.hps as { actorId: string }[]);
    expect(hps.map((entry) => entry.actorId)).toContain("bob");
    const names = heard
      .of("patch")
      .flatMap((message) => message.names as { actorId: string; name: string }[]);
    expect(names).toContainEqual({ actorId: "bob", name: "Bob" });
    const walks = heard
      .of("patch")
      .flatMap((message) => message.events as { kind: string }[])
      .filter((event) => event.kind === "walkStarted");
    expect(walks).toEqual([]);
  });

  it("takes a body back when it walks out of reach", async () => {
    const { alice, bob } = await bothConnected();
    step(bob.ws, 1, "w");
    expect(await eventWithin(alice.ws, "spawned", 2000)).not.toBeNull();

    step(bob.ws, 2, "e");
    const gone = await eventWithin(alice.ws, "despawned", 2000);

    expect(gone).toMatchObject({ actorId: "bob" });
  });

  function cellsHeard(heard: ReturnType<typeof record>) {
    return heard.of("patch").flatMap(
      (message) =>
        message.cells as {
          x: number;
          stack: { tileId: string }[];
          afflicted?: { tileId: string; defIds: string[] }[];
        }[],
    );
  }

  it("sends a fire on its cell to whoever holds the ground, and puts it out there", async () => {
    const { alice, bob } = await bothConnected();
    const heard = record(alice.ws);

    command(bob.ws, "/tile flame +1");
    await tickTimes(3);
    await settled(alice.ws);
    const lit = cellsHeard(heard).filter((cell) => cell.x === BODY_OUT + 1);
    expect(lit.at(-1)?.afflicted).toEqual([{ tileId: "grass", defIds: ["burned"] }]);

    await tickTimes(Math.ceil(5_000 / TICK_MS));
    await settled(alice.ws);
    const after = cellsHeard(heard)
      .filter((cell) => cell.x === BODY_OUT + 1)
      .at(-1);
    expect(after?.stack.map((placed) => placed.tileId)).toEqual(["dirt", "flame"]);
    expect(after?.afflicted).toBeUndefined();

    const caught = cellsHeard(heard).filter((cell) => cell.x === BODY_OUT + 2);
    expect(caught.some((cell) => cell.afflicted?.length)).toBe(true);
  });

  it("never sends a fire in ground a client does not hold", async () => {
    const { alice, bob } = await bothConnected(OUT_OF_REACH);
    const heard = record(alice.ws);
    const bobHeard = record(bob.ws);

    command(bob.ws, "/tile flame +1");
    await tickTimes(10);
    await settled(bob.ws);
    await settled(alice.ws);

    expect(cellsHeard(bobHeard).some((cell) => cell.afflicted?.length)).toBe(true);
    expect(cellsHeard(heard).filter((cell) => cell.afflicted)).toEqual([]);
  });

  it("hands a fire back with its ground", async () => {
    const { alice, bob } = await bothConnected(IN_REACH);
    step(alice.ws, 1, "w");
    await arrivedAt("alice", ALICE_CELL - 1);
    await tickTimes(2);

    const heard = record(alice.ws);
    command(bob.ws, "/tile tree -1");
    command(bob.ws, "/tile flame -1");
    await tickTimes(3);
    await settled(alice.ws);
    expect(cellsHeard(heard).filter((cell) => cell.afflicted)).toEqual([]);

    step(alice.ws, 2, "e");
    await arrivedAt("alice", ALICE_CELL);
    await tickTimes(30);
    const handed = cellsHeard(heard)
      .filter((cell) => cell.x === IN_REACH - 1)
      .at(-1);
    expect(handed?.afflicted).toContainEqual({ tileId: "tree", defIds: ["burned"] });
  });

  it("hands a chunk back as it stands after walking away from it", async () => {
    const { alice, bob } = await bothConnected(IN_REACH);
    expect(cellOf(alice.hello, IN_REACH)?.map((p) => p.tileId)).toEqual([
      "grass",
      DROPPED_SWORD,
      BERRY,
    ]);

    step(alice.ws, 1, "w");
    await arrivedAt("alice", ALICE_CELL - 1);
    await tickTimes(2);

    const heard = record(alice.ws);
    send(bob.ws, {
      type: "pickUp",
      ref: { x: IN_REACH, y: 0, z: 0, stackIndex: DROPPED_STACK_INDEX },
    });
    await nextMessageOfType(bob.ws, "equipment");
    await settled(bob.ws);
    expect(heard.types()).toEqual([]);

    step(alice.ws, 2, "e");
    await arrivedAt("alice", ALICE_CELL);
    await tickTimes(30);

    const cells = heard
      .of("patch")
      .flatMap((message) => message.cells as { x: number; stack: { tileId: string }[] }[]);
    const handed = cells.filter((cell) => cell.x === IN_REACH).at(-1);
    expect(handed?.stack.map((placed) => placed.tileId)).toEqual(["grass", BERRY]);
  });

  it("never takes back the body a client is looking through", async () => {
    const { alice } = await bothConnected();
    const heard = record(alice.ws);

    step(alice.ws, 1, "e");
    await messageWithin(alice.ws, "patch", MESSAGE_TIMEOUT_MS);

    const kinds = heard
      .of("patch")
      .flatMap((message) => message.events as { kind: string }[])
      .map((event) => event.kind);
    expect(kinds).not.toContain("despawned");
  });
});
