import { env, fetchMock, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import tilesJson from "../data/tiles.json";
import { MINUTES_PER_DAY, minutesOfDayAt } from "../app/lib/clock";
import { DEV_DATA_PREFIX } from "../app/lib/devData";
import type { FlatMapFile } from "../app/lib/types";
import type { GameServer } from "./GameServer";

/**
 * The Durable Object's load / restore / checkpoint path, in the runtime it
 * deploys to.
 *
 * Both bugs that shipped in this file lived here and were invisible to a node
 * test: the object has to actually be constructed from a checkpoint for either
 * to appear. Every hibernation cycle in production runs this path, so it is the
 * least exotic code in the file and was the least covered.
 */

/** A strip of grass with the authored spawn marker at the origin. */
function authoredMap(): FlatMapFile {
  const levels: Record<string, Record<string, unknown[]>> = { "0": {} };
  for (let x = 0; x < 4; x++) {
    levels["0"]![`${x},0`] = [{ tileId: "grass" }];
  }
  levels["0"]!["0,0"] = [{ tileId: "grass" }, { tileId: "player", direction: "s" }];
  return { version: 1, levels } as FlatMapFile;
}

/**
 * A world that has already been run: the marker is consumed, the actors listed
 * are standing in it, and the spawn point survives only because it is carried.
 */
const AWAY_FROM_SPAWN = 2;

function checkpointWith(owners: string[]): {
  map: FlatMapFile;
  spawn: { x: number; y: number; z: number; stackIndex: number };
} {
  const levels: Record<string, Record<string, unknown[]>> = { "0": {} };
  for (let x = 0; x < 4; x++) {
    levels["0"]![`${x},0`] = [{ tileId: "grass" }];
  }
  // Standing away from the spawn cell, which is what makes "re-seated where
  // they were" distinguishable from "given a fresh body at spawn".
  levels["0"]![`${AWAY_FROM_SPAWN},0`] = [
    { tileId: "grass" },
    ...owners.map((owner) => ({ tileId: "player", direction: "s", owner })),
  ];
  return {
    map: { version: 1, levels } as FlatMapFile,
    spawn: { x: 0, y: 0, z: 0, stackIndex: 1 },
  };
}

/** Which cell each player tile sits in, as `x` values. */
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

function stub() {
  return env.GAME.getByName("world");
}

/** Every player placement in a flat map, as `owner` values. */
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

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no message")), 5000);
    ws.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(JSON.parse(event.data as string) as Record<string, unknown>);
      },
      { once: true },
    );
  });
}

/** Join the world, and read the `hello` that says what is in it. */
async function connect(actorId: string) {
  const res = await stub().fetch(
    new Request(`https://world/online/ws?actor=${actorId}`, {
      headers: { Upgrade: "websocket" },
    }),
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const hello = await nextMessage(ws);
  return { ws, hello };
}

/**
 * Drop the object's in-memory world without touching its storage or sockets,
 * which is what eviction does. White-box on purpose: this *is* the path under
 * test, and there is no public API that forces a Durable Object out of memory.
 */
async function simulateEviction() {
  await runInDurableObject(stub(), (instance: GameServer) => {
    const internals = instance as unknown as Record<string, unknown>;
    internals.session = null;
    internals.broadcastMap = null;
    internals.loading = null;
  });
}

/** Stands in for the dev server that hosts `data/`. */
const DEV_DATA_ORIGIN = "http://data.test";

function dataPath(key: string) {
  return `${DEV_DATA_PREFIX}/${key}`;
}

/**
 * Intercept the dev data server. Net access is off while it is mocked, so a
 * request to a path with no interceptor fails loudly rather than escaping.
 */
function devDataPool() {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  return fetchMock.get(DEV_DATA_ORIGIN);
}

async function putCheckpoint(value: unknown) {
  await runInDurableObject(stub(), async (_instance, state) => {
    await state.storage.put("world", value);
  });
}

beforeEach(async () => {
  await env.DATA.put("tiles.json", JSON.stringify(tilesJson));
  await env.DATA.put("map.json", JSON.stringify(authoredMap()));
});

// Only the dev-origin case mocks fetch; leaving the agent active would make
// every later test's outbound request fail with no interceptor.
afterEach(() => {
  fetchMock.deactivate();
});

describe("joining and leaving", () => {
  it("tells a joiner who they are and who is present", async () => {
    const { hello } = await connect("alice");

    expect(hello.type).toBe("hello");
    expect(hello.selfId).toBe("alice");
    expect(hello.actorIds).toEqual(["alice"]);
    expect(playerOwners(hello.map as FlatMapFile)).toEqual(["alice"]);
  });

  it("puts both actors on one board", async () => {
    await connect("alice");
    const { hello } = await connect("bob");

    expect(hello.actorIds).toEqual(["alice", "bob"]);
    expect(playerOwners(hello.map as FlatMapFile).sort()).toEqual([
      "alice",
      "bob",
    ]);
  });

  it("consumes the authored marker, leaving no unowned avatar", async () => {
    const { hello } = await connect("alice");
    // Exactly one player tile, and it belongs to somebody.
    expect(playerOwners(hello.map as FlatMapFile)).toEqual(["alice"]);
  });

  it("removes an actor's tile when their socket closes", async () => {
    const alice = await connect("alice");
    await connect("bob");

    alice.ws.close();
    // A third join reads the board back out.
    const { hello } = await connect("carol");

    const owners = playerOwners(hello.map as FlatMapFile).sort();
    expect(owners).toEqual(["bob", "carol"]);
    expect(hello.actorIds).not.toContain("alice");
  });
});

/**
 * A generous window, in clock minutes, for "the same instant". The clock runs a
 * minute per real second, so this is ten seconds of slack for a loaded machine.
 */
const CLOCK_TOLERANCE_MINUTES = 10;

/** Circular distance between two readings, so a run across midnight is fine. */
function minutesApart(a: number, b: number): number {
  const d = Math.abs(a - b) % MINUTES_PER_DAY;
  return Math.min(d, MINUTES_PER_DAY - d);
}

describe("time of day", () => {
  /**
   * The hour belongs to the world, not to whoever is looking at it. Each client
   * used to run a clock of its own from a fixed start, so two browsers in the
   * same world were reliably in different hours and drifted further apart the
   * longer they stayed.
   */
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

  /** Nothing to restore: the clock is a function of time, not stored state. */
  it("keeps time across an eviction", async () => {
    await putCheckpoint(checkpointWith([]));
    await simulateEviction();

    const { hello } = await connect("alice");

    expect(
      minutesApart(hello.minutesOfDay as number, minutesOfDayAt(Date.now())),
    ).toBeLessThan(CLOCK_TOLERANCE_MINUTES);
  });
});

describe("surviving eviction", () => {
  /**
   * Regression: the checkpoint stores the *runtime* map, whose authored marker
   * was consumed when the world first started. Deriving the spawn point from it
   * on reload threw `No tile with id "player"`, taking every reconnect with it.
   */
  it("resumes a checkpoint whose marker was already consumed", async () => {
    await putCheckpoint(checkpointWith([]));
    await simulateEviction();

    const { hello } = await connect("alice");

    expect(hello.selfId).toBe("alice");
    expect(playerOwners(hello.map as FlatMapFile)).toEqual(["alice"]);
  });

  /**
   * Regression: restoring called spawn() for every live socket, but the
   * checkpointed map already held their tiles — so each wake minted a second
   * body, and despawn only ever removes one. The orphan was permanent and the
   * checkpoint grew every cycle.
   */
  it("does not give a returning actor a second body", async () => {
    // The world was checkpointed with alice standing in it, then evicted.
    // Reconnecting must re-seat her on the body she already has.
    await putCheckpoint(checkpointWith(["alice"]));
    await simulateEviction();

    const { hello } = await connect("alice");

    expect(playerOwners(hello.map as FlatMapFile)).toEqual(["alice"]);
    // And on the body she had, not a fresh one at spawn.
    expect(playerCells(hello.map as FlatMapFile)).toEqual([AWAY_FROM_SPAWN]);
  });

  /**
   * A connection that dies while the object is evicted never runs a close, so
   * nothing else would ever remove its body.
   */
  it("reaps actors left in the checkpoint with no socket", async () => {
    await putCheckpoint(checkpointWith(["ghost"]));
    await simulateEviction();

    const { hello } = await connect("alice");

    expect(playerOwners(hello.map as FlatMapFile)).toEqual(["alice"]);
  });
});

describe("replacing the world", () => {
  it("persists the authored map and restarts everyone on it", async () => {
    const alice = await connect("alice");

    const replacement = authoredMap();
    await stub().replaceWorld(replacement);
    // The editor's save pushes a fresh hello to everyone still connected.
    const hello = await nextMessage(alice.ws);

    expect(hello.type).toBe("hello");
    expect(playerOwners(hello.map as FlatMapFile)).toEqual(["alice"]);

    // What lands in storage is what the editor sent — never the running map,
    // which carries an owner on every actor's tile.
    const stored = await env.DATA.get("map.json");
    const text = await stored!.text();
    expect(text).not.toContain('"owner"');
  });

  it("drops the previous world's checkpoint", async () => {
    await putCheckpoint(checkpointWith(["ghost"]));
    await stub().replaceWorld(authoredMap());

    await runInDurableObject(stub(), async (_instance, state) => {
      expect(await state.storage.get("world")).toBeUndefined();
    });
  });

  /**
   * Regression: the object chose its storage backend from `env` alone, and
   * under `pnpm dev` there is nothing in `env` to choose with — `data/` is
   * served from the Vite server's own origin. So the editor's save went to R2
   * while every loader kept reading disk: the save reported success, the
   * revalidation read the untouched file, and the edit vanished.
   */
  it("writes through the origin it is given rather than R2", async () => {
    const replacement = authoredMap();
    replacement.levels["0"]![`${AWAY_FROM_SPAWN},0`] = [{ tileId: "water" }];

    const pool = devDataPool();
    // Two reads: the load that brings the world in, and the reload that gives
    // the new session its tiles.
    pool
      .intercept({ path: dataPath("tiles.json") })
      .reply(200, JSON.stringify(tilesJson))
      .times(2);
    pool
      .intercept({ path: dataPath("map.json") })
      .reply(200, JSON.stringify(authoredMap()));
    let written = "";
    pool
      .intercept({ path: dataPath("map.json"), method: "PUT" })
      .reply(200, (options) => {
        written = String(options.body);
        return "";
      });

    await stub().replaceWorld(replacement, DEV_DATA_ORIGIN);

    expect(written).toContain('"water"');
    // And R2 is left holding what it held before, rather than quietly taking
    // the write the author will never read back.
    const stored = await env.DATA.get("map.json");
    expect(await stored!.text()).toBe(JSON.stringify(authoredMap()));
  });
});
