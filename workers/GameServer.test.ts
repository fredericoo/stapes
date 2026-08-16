import { env, fetchMock, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import tilesJson from "../data/tiles.json";
import {
  BRAIN_TICK_MS,
  PLAYER_TILE_ID,
  PUSH_STEP_MS,
  WALK_DURATION_MS,
} from "../app/game/constants";
import { MINUTES_PER_DAY, minutesOfDayAt } from "../app/lib/clock";
import { DEV_DATA_PREFIX } from "../app/lib/devData";
import { getStack, listCoords } from "../app/lib/mapData";
import type { FlatMapFile, MapFile } from "../app/lib/types";
import { CHAT_MIN_INTERVAL_MS } from "../app/net/chat";
import {
  CHAT_LOG_MAX_ROWS,
  MAX_REMEMBERED_ACTORS,
  type GameServer,
} from "./GameServer";

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

  /**
   * The headcount the bar shows. Counted from sockets rather than from
   * `actorIds`, because creatures are actors too and a world with a deer in it
   * would otherwise report a player who is not there.
   */
  it("tells every joiner how many people are here", async () => {
    const alice = await connect("alice");
    expect(alice.hello.playerCount).toBe(1);

    const bob = await connect("bob");
    expect(bob.hello.playerCount).toBe(2);
  });

  it("tells the room when somebody arrives", async () => {
    const alice = await connect("alice");
    const arrival = nextMessage(alice.ws);
    await connect("bob");

    // Alice's own arrival may still be sitting in the same patch — she joined an
    // idle world, so the tick that flushes her `joined` starts with bob's.
    expect(await arrival).toMatchObject({
      events: expect.arrayContaining([
        { kind: "joined", actorId: "bob", playerCount: 2 },
      ]),
    });
  });

  /**
   * A closing socket is still listed by `getWebSockets`, so a naive count would
   * have the leaver counting themselves on the way out and the bar would sit one
   * high until the next person arrived.
   */
  it("tells the room when somebody goes, without counting them", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    // The `joined` that bob's arrival broadcast, out of the way.
    await nextMessage(alice.ws);

    const departure = nextMessage(alice.ws);
    bob.ws.close();

    expect(await departure).toMatchObject({
      events: [{ kind: "left", actorId: "bob", playerCount: 1 }],
    });
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

  /**
   * A reload, in the order the runtime actually delivers it: the new socket
   * arrives while the old one's close is still in flight.
   *
   * The body has to survive that, and the socket the close belongs to is no
   * guide — despawning on it took the board out from under the connection that
   * had just replaced it, leaving a client that had been told it had a body
   * watching a world it was not in, with every message it sent dropped.
   */
  it("keeps the body when one of an actor's two sockets closes", async () => {
    const first = await connect("alice");
    await connect("alice");

    first.ws.close();
    // A third join reads the board back out.
    const { hello } = await connect("carol");

    expect(playerOwners(hello.map as FlatMapFile).sort()).toEqual([
      "alice",
      "carol",
    ]);
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

/**
 * A body that lives in the map, rather than arriving on a socket.
 *
 * The point of interest is the cleanup path: a resident is nobody's connection,
 * so every list of who is present omits it, and the pass that clears out bodies
 * whose sockets died is aimed squarely at it by accident.
 */
const DEER_CELL = 3;

/** The real tile set, plus a creature to place. */
function tilesWithDeer() {
  return [
    ...(tilesJson as unknown[]),
    {
      id: "deer",
      name: "Deer",
      type: "simple",
      height: 1,
      attributes: {},
      actor: true,
      affectedByGravity: true,
      walkable: false,
    },
  ];
}

/** The authored strip, with a deer standing on it away from spawn. */
function mapWithDeer(): FlatMapFile {
  const map = authoredMap();
  map.levels["0"]![`${DEER_CELL},0`] = [{ tileId: "grass" }, { tileId: "deer" }];
  return map;
}

/** Every deer placement in a flat map, as `x` values. */
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
    await env.DATA.put("tiles.json", JSON.stringify(tilesWithDeer()));
    await env.DATA.put("map.json", JSON.stringify(mapWithDeer()));
  });

  it("is in the world a joiner is handed, driving itself", async () => {
    const { hello } = await connect("alice");

    expect(deerCells(hello.map as FlatMapFile)).toEqual([DEER_CELL]);
    // An actor like any other, so its motion rides the existing protocol.
    expect(hello.actorIds).toEqual(
      expect.arrayContaining([expect.stringMatching(/^npc:/)]),
    );
  });

  it("looks the same to everybody in the room", async () => {
    const alice = await connect("alice");
    const { hello } = await connect("bob");

    expect(deerCells(alice.hello.map as FlatMapFile)).toEqual(
      deerCells(hello.map as FlatMapFile),
    );
  });

  /**
   * Regression: the reaper removes bodies whose socket is gone, and a resident
   * has never had one. Every wake after an eviction emptied the world of its
   * wildlife, permanently — the checkpoint written afterwards had no deer in it.
   */
  it("survives an eviction, in place and unduplicated", async () => {
    await connect("alice");
    await simulateEviction();

    const { hello } = await connect("bob");

    expect(deerCells(hello.map as FlatMapFile)).toEqual([DEER_CELL]);
  });
});

describe("replacing the world", () => {
  it("persists the authored map and restarts everyone on it", async () => {
    const alice = await connect("alice");

    // Listening before the save rather than after it. The hello goes out
    // *during* `replaceWorld`, so a listener attached once the call resolves is
    // racing its own delivery — it catches whatever comes next instead, which
    // is the patch the following tick sends.
    const fresh = nextMessage(alice.ws);
    const replacement = authoredMap();
    await stub().replaceWorld(replacement);
    // The editor's save pushes a fresh hello to everyone still connected.
    const hello = await fresh;

    expect(hello.type).toBe("hello");
    expect(playerOwners(hello.map as FlatMapFile)).toEqual(["alice"]);

    // What lands in storage is what the editor sent — never the running map,
    // which carries an owner on every actor's tile.
    const stored = await env.DATA.get("map.json");
    const text = await stored!.text();
    expect(text).not.toContain('"owner"');
  });

  /**
   * A save re-creates the world. It does not re-create the people in it.
   *
   * Items on the floor coming back is the point of authoring them there — the
   * map is the map, and saving it is how an author puts a sword back. What is in
   * somebody's bag is not the map: nobody authored it, and nothing in the file
   * that was just written says anything about it.
   *
   * Everyone connected used to be re-seated with the starting kit, so every save
   * emptied every open pocket — and the flush five seconds later wrote that
   * emptiness over the only record of what they had, which put it beyond a
   * reconnect to recover.
   */
  it("leaves a connected player carrying what they were carrying", async () => {
    const withSword = authoredMap();
    withSword.levels["0"]!["1,0"] = [
      { tileId: "grass" },
      { tileId: "rusty-sword" },
    ];
    await env.DATA.put("map.json", JSON.stringify(withSword));

    const alice = await connect("alice");
    const bagId = kitOf(alice.hello).bag.id;

    send(alice.ws, { type: "pickUp", ref: { x: 1, y: 0, z: 0, stackIndex: 1 } });
    const armed = (await equipmentWithin(alice.ws))!;
    expect(contentsOf(armed).map((i) => i.tileId)).toEqual(["rusty-sword"]);

    const fresh = nextMessage(alice.ws);
    await stub().replaceWorld(withSword);
    const hello = await fresh;

    expect(hello.type).toBe("hello");
    // The same bag, holding the same sword. Not a new one that happens to look
    // like it: a reset kit mints a fresh bag, so the id is what tells them apart.
    expect(kitOf(hello).bag.id).toBe(bagId);
    expect(contentsOf(hello).map((i) => i.tileId)).toEqual(["rusty-sword"]);
  });

  /**
   * The other half of the same rule, and the reason this is not simply "keep
   * everything": the floor is the map's to decide. An authored sword comes back
   * when the map does, whoever happens to be holding one.
   */
  it("puts the authored floor items back regardless", async () => {
    const withSword = authoredMap();
    withSword.levels["0"]!["1,0"] = [
      { tileId: "grass" },
      { tileId: "rusty-sword" },
    ];
    await env.DATA.put("map.json", JSON.stringify(withSword));

    const alice = await connect("alice");
    send(alice.ws, { type: "pickUp", ref: { x: 1, y: 0, z: 0, stackIndex: 1 } });
    await equipmentWithin(alice.ws);

    const fresh = nextMessage(alice.ws);
    await stub().replaceWorld(withSword);
    const hello = await fresh;

    const stack = (hello.map as FlatMapFile).levels["0"]!["1,0"]!;
    expect(stack.map((p) => p.tileId)).toContain("rusty-sword");
  });

  it("checks the kit it carries over against the catalogue the save brought", async () => {
    const withSword = authoredMap();
    withSword.levels["0"]!["1,0"] = [
      { tileId: "grass" },
      { tileId: "rusty-sword" },
    ];
    await env.DATA.put("map.json", JSON.stringify(withSword));

    const alice = await connect("alice");
    const bagId = kitOf(alice.hello).bag.id;
    send(alice.ws, { type: "pickUp", ref: { x: 1, y: 0, z: 0, stackIndex: 1 } });
    await equipmentWithin(alice.ws);

    // The save brings a catalogue in which the sword is scenery. A kit this
    // world no longer agrees with is dropped, exactly as a remembered one is.
    const asProps = (tilesJson as Array<Record<string, unknown>>).map((t) =>
      t.id === "rusty-sword" ? { ...t, kind: "prop" } : t,
    );
    await env.DATA.put("tiles.json", JSON.stringify(asProps));

    const fresh = nextMessage(alice.ws);
    await stub().replaceWorld(withSword);
    const hello = await fresh;

    // Carried over — same bag, so this is not the kit simply being reset...
    expect(kitOf(hello).bag.id).toBe(bagId);
    // ...and the sword is gone from it, because this world says it is scenery.
    expect(contentsOf(hello)).toEqual([]);
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
    // One read, and it is the tiles: a save replaces the world wholesale, so it
    // deliberately never reads the map it is replacing. No `map.json` GET is
    // stubbed here, and that is the assertion — with net access off, reaching
    // for one would fail the test rather than quietly pass.
    pool
      .intercept({ path: dataPath("tiles.json") })
      .reply(200, JSON.stringify(tilesJson));
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

describe("finding authored content", () => {
  /**
   * Regression: the origin arrived only with an editor save, and it is held in
   * memory — so the first load after an eviction went back to R2 while every
   * loader kept reading disk. Nothing announces that divergence, because the
   * map is not part of it: it comes from the checkpoint and is current, and
   * only the tile defs are a seed old. An object authored since then is on the
   * board, drawn, offered as pushable by a client reading fresh defs, and inert
   * — this side has never heard of its tile.
   */
  it("reads through the origin a joiner arrives with, rather than R2", async () => {
    const onDisk = authoredMap();
    onDisk.levels["0"]![`${AWAY_FROM_SPAWN},0`] = [{ tileId: "water" }];

    const pool = devDataPool();
    pool
      .intercept({ path: dataPath("tiles.json") })
      .reply(200, JSON.stringify(tilesJson));
    pool
      .intercept({ path: dataPath("map.json") })
      .reply(200, JSON.stringify(onDisk));

    const res = await stub().fetch(
      new Request(
        `https://world/online/ws?actor=alice&dataOrigin=${DEV_DATA_ORIGIN}`,
        { headers: { Upgrade: "websocket" } },
      ),
    );
    const ws = res.webSocket!;
    ws.accept();
    const hello = await nextMessage(ws);

    // R2 is holding the plain strip, so the water can only have come off disk.
    expect(JSON.stringify(hello.map)).toContain("water");
  });
});

/**
 * A world where two people are standing on different floors.
 *
 * Built as a checkpoint rather than by walking anybody upstairs, because a
 * checkpoint is exactly "a world that has already been run" and restoring from
 * one is a path every hibernation wake takes anyway. The sockets have to be
 * open before the restore: `restoreActors` reaps anyone in the checkpoint who
 * has no connection, so a checkpoint loaded before the joins would throw both
 * of these bodies away.
 */
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
    map: { version: 1, levels: { "0": ground, "1": upstairs } } as FlatMapFile,
    spawn: { x: 0, y: 0, z: 0, stackIndex: 0 },
  };
}

/**
 * The next chat message on this socket, or null if none arrives in time.
 *
 * Filtered by type rather than taking whatever lands first, because the socket
 * is also carrying the world: a join broadcasts a patch, and reading that patch
 * as "the reply" makes a positive test pass on the wrong message and a negative
 * one fail on an unrelated one. Both happened before this filtered.
 */
function chatWithin(
  ws: WebSocket,
  ms: number,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const done = (value: Record<string, unknown> | null) => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(value);
    };
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(event.data as string) as Record<string, unknown>;
      if (message.type === "chat") done(message);
    };
    const timer = setTimeout(() => done(null), ms);
    ws.addEventListener("message", onMessage);
  });
}

/** Long enough for a tick to have happened if one was going to. */
const QUIET_MS = 200;

function say(ws: WebSocket, text: string) {
  ws.send(JSON.stringify({ type: "say", text }));
}

/** Whether the tick loop is running, which is what blocks hibernation. */
async function isTicking(): Promise<boolean> {
  let ticking = false;
  await runInDurableObject(stub(), (instance: GameServer) => {
    ticking = (instance as unknown as Record<string, unknown>).timer !== null;
  });
  return ticking;
}

async function chatRows(): Promise<Record<string, unknown>[]> {
  let rows: Record<string, unknown>[] = [];
  await runInDurableObject(stub(), (_instance, state) => {
    rows = [...state.storage.sql.exec("SELECT * FROM chat ORDER BY id")];
  });
  return rows;
}

/**
 * Chat is the one thing on this wire that is not for everybody, and the level
 * filter is the reason it has its own message rather than riding in a patch.
 * A bug here does not corrupt the world — it quietly shows somebody a
 * conversation they were not standing in, which no other test would catch.
 */
describe("chat", () => {
  /** Two actors, one on each floor, with their sockets already open. */
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
      // The body alice said it in, so the client can tell a person's words from
      // a creature's without asking the board about a speaker who may be gone.
      tileId: PLAYER_TILE_ID,
    });
  });

  it("comes back to its own author", async () => {
    const alice = await connect("alice");
    say(alice.ws, "hey there!");

    // No local echo on the client, so the author's own bubble is this message.
    expect(await chatWithin(alice.ws, 1000)).toMatchObject({
      type: "chat",
      text: "hey there!",
    });
  });

  it("does not reach another floor", async () => {
    const { alice, bob } = await twoLevels();

    say(alice.ws, "hey there!");

    // The negative is the assertion that matters: proving alice was heard
    // somewhere is not proof that bob was excluded.
    expect(await chatWithin(bob.ws, QUIET_MS)).toBeNull();
  });

  it("still reaches the author on their own floor after the restore", async () => {
    const { alice } = await twoLevels();

    say(alice.ws, "hey there!");

    // Guards the test above: if the restore had silently dropped everybody,
    // "bob heard nothing" would pass for the wrong reason.
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
    // The speaker's slot in that cell's stack travels too, so the client can
    // hang the bubble over the ground under them rather than over their head.
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

  /**
   * Talking does not move the board, but it can start something that does: a
   * brain gets exactly one turn to notice what was said, so the loop has to run
   * at least that far or a call is never heard rather than heard late.
   *
   * This test used to assert the loop stayed stopped outright. What that rule
   * was really protecting is the part kept here — an idle world must not be held
   * out of hibernation for as long as people keep chatting — and one brain tick
   * is the whole of what the change costs.
   */
  it("goes back to sleep once the word has been heard", async () => {
    const alice = await connect("alice");
    // Let the join's own wake settle first, or this measures that instead.
    await scheduler.wait(QUIET_MS);
    expect(await isTicking()).toBe(false);

    say(alice.ws, "hey there!");
    await chatWithin(alice.ws, 1000);
    await scheduler.wait(BRAIN_TICK_MS + QUIET_MS);

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

  /**
   * Nothing reads this table yet, which is exactly why the cap has to hold: an
   * append-only store with no reader is the only thing in the object that grows
   * without bound.
   */
  it("keeps the log at its cap", async () => {
    const alice = await connect("alice");
    say(alice.ws, "hey there!");
    await chatWithin(alice.ws, 1000);

    // Backfill past the cap directly — the rate limit makes it impossible to
    // reach from the wire, and the prune is what is under test, not the sending.
    await runInDurableObject(stub(), (_instance, state) => {
      state.storage.sql.exec(
        `WITH RECURSIVE seq(n) AS (
           SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?
         )
         INSERT INTO chat (at, actor, x, y, z, text)
         SELECT 0, 'backfill', 0, 0, 0, 'old' FROM seq`,
        CHAT_LOG_MAX_ROWS + 100,
      );
    });

    const beforePrune = await chatRows();
    expect(beforePrune.length).toBeGreaterThan(CHAT_LOG_MAX_ROWS);

    // One more real message, which is what runs the prune.
    await scheduler.wait(CHAT_MIN_INTERVAL_MS);
    say(alice.ws, "and another");
    await chatWithin(alice.ws, 1000);

    expect(await chatRows()).toHaveLength(CHAT_LOG_MAX_ROWS);
  });
});

/**
 * Being called, over a real socket.
 *
 * The brain's own rules are tested against a board in `app/game/brain.test.ts`.
 * What only exists here is the path between a person typing and a creature
 * deciding: the object hands the simulation the same sanitised line it
 * broadcasts, and keeps ticking long enough for a brain to have its turn. Both
 * halves are invisible from either side alone.
 */
describe("calling a creature", () => {
  /** Alice on a strip of grass, with the authored cat three cells along it. */
  function checkpointWithCat(): {
    map: FlatMapFile;
    spawn: { x: number; y: number; z: number; stackIndex: number };
  } {
    const ground: Record<string, unknown[]> = {};
    for (let x = 0; x < 6; x++) ground[`${x},0`] = [{ tileId: "grass" }];
    ground["0,0"] = [
      { tileId: "grass" },
      { tileId: "player", direction: "s", owner: "alice" },
    ];
    ground["3,0"] = [{ tileId: "grass" }, { tileId: "cat" }];
    return {
      map: { version: 1, levels: { "0": ground } } as FlatMapFile,
      spawn: { x: 0, y: 0, z: 0, stackIndex: 0 },
    };
  }

  async function withCat() {
    const alice = await connect("alice");
    await putCheckpoint(checkpointWithCat());
    await simulateEviction();
    return alice;
  }

  /**
   * A meow is a noise, not an answer in words, so it comes back on the other
   * channel — which is also what lets this simply wait for one. It used to have
   * to read the chat stream and skip past the echo of the caller's own line;
   * with the two apart there is nothing of the caller's on this channel at all.
   */
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
});

/**
 * Steps, as the wire now carries them.
 *
 * Clients decide when their own steps happen and draw them before this object
 * has heard about it, so what arrives here is a claim to check rather than a
 * request to fulfil. Two things have to hold for that to be playable: a claim
 * that arrives while the last one is still being walked has to wait rather than
 * be thrown away, and one the board refuses has to come back with its number so
 * the client can put itself back.
 */

function send(ws: WebSocket, message: unknown) {
  ws.send(JSON.stringify(message));
}

/** Wait for the kit the server sends its owner alone. */
function equipmentWithin(ws: WebSocket) {
  return messageWithin(ws, "equipment", 1000);
}

/** What is in the bag of whichever message carries a kit. */
function contentsOf(message: Record<string, unknown>): Array<{ tileId: string }> {
  const equipment = message.equipment as {
    bag: { contents?: Array<{ tileId: string }> } | null;
  };
  return equipment.bag?.contents ?? [];
}

function step(ws: WebSocket, seq: number, direction: string) {
  ws.send(JSON.stringify({ type: "step", seq, direction, preferDescend: false }));
}

/** Wait for a noise, which carries no speaker. @see ServerMessage `noise` */
function noiseWithin(ws: WebSocket, ms: number) {
  return messageWithin(ws, "noise", ms);
}

/** Wait for the first message of a type, or null if it never comes. */
function messageWithin(
  ws: WebSocket,
  type: string,
  ms: number,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const done = (value: Record<string, unknown> | null) => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(value);
    };
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(event.data as string) as Record<string, unknown>;
      if (message.type === type) done(message);
    };
    const timer = setTimeout(() => done(null), ms);
    ws.addEventListener("message", onMessage);
  });
}

/** Wait for a patch carrying a `walkStarted`, and hand back that event. */
function walkWithin(
  ws: WebSocket,
  ms: number,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const done = (value: Record<string, unknown> | null) => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(value);
    };
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(event.data as string) as Record<string, unknown>;
      if (message.type !== "patch") return;
      const events = message.events as Record<string, unknown>[];
      const walk = events.find((e) => e.kind === "walkStarted");
      if (walk) done(walk);
    };
    const timer = setTimeout(() => done(null), ms);
    ws.addEventListener("message", onMessage);
  });
}

/** Where an actor's tile is in the running world, as an x. */
async function actorX(actorId: string): Promise<number | null> {
  let found: number | null = null;
  await runInDurableObject(stub(), (instance: GameServer) => {
    const internals = instance as unknown as {
      session: { actorSnapshots(): { id: string; x: number }[] } | null;
    };
    const actor = internals.session
      ?.actorSnapshots()
      .find((a) => a.id === actorId);
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

    // The walk lands 200ms after it starts, and the cell patch that carries it
    // is the only acknowledgement an accepted step ever gets.
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
      facing = internals.session
        ?.actorSnapshots()
        .find((a) => a.id === "alice")?.direction;
    });
    expect(facing).toBe("n");
    expect(await actorX("alice")).toBe(0);
  });

  it("refuses a step further ahead than it will hold", async () => {
    const { ws } = await connect("alice");
    // Three in a burst, before any tick can take one: two fit in the queue and
    // the third is more than any honest client is ahead by.
    step(ws, 0, "e");
    step(ws, 1, "e");
    step(ws, 2, "e");

    expect(await messageWithin(ws, "stepRejected", 1000)).toEqual({
      type: "stepRejected",
      seq: 2,
    });
  });

  it("tells only the client whose step it was", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");

    step(alice.ws, 0, "e");
    step(alice.ws, 1, "e");
    step(alice.ws, 2, "e");

    expect(await messageWithin(alice.ws, "stepRejected", 1000)).not.toBeNull();
    // A refusal is about one client's guess, not about the board, so it has no
    // business on anybody else's socket.
    expect(await messageWithin(bob.ws, "stepRejected", QUIET_MS)).toBeNull();
  });

  it("walks the second of two steps that arrived together", async () => {
    const { ws } = await connect("alice");
    step(ws, 0, "e");
    step(ws, 1, "e");

    // Held rather than refused: the queued one is taken on the tick that
    // finishes the first, so two cells are walked and neither is lost.
    await new Promise((resolve) =>
      setTimeout(resolve, WALK_DURATION_MS * 2 + 300),
    );
    expect(await actorX("alice")).toBe(2);
  });

  it("goes back to sleep once the steps are walked", async () => {
    const { ws } = await connect("alice");
    step(ws, 0, "e");

    await new Promise((resolve) =>
      setTimeout(resolve, WALK_DURATION_MS + QUIET_MS),
    );
    // Nothing is held on this side any more — the client is the only thing that
    // knows a key is down — so one step leaves the world at rest.
    expect(await isTicking()).toBe(false);
  });
});

/**
 * Coming back to where you were.
 *
 * The world is not an account system — identity is a cookie — but the one thing
 * that makes it feel like a place rather than a demo is that leaving and
 * returning does not undo an afternoon of walking somewhere. The map already
 * carries everyone who is *connected*, through the checkpoint; what has to be
 * kept separately is where somebody was when their tile came off the board,
 * because that is the moment the map stops being the record.
 */

/** The saved position the object is holding for an actor, if any. */
async function savedPosition(
  actorId: string,
): Promise<Record<string, unknown> | undefined> {
  let found: Record<string, unknown> | undefined;
  await runInDurableObject(stub(), async (_instance, state) => {
    found = await state.storage.get<Record<string, unknown>>(`pos:${actorId}`);
  });
  return found;
}

/**
 * An identity no earlier test has used.
 *
 * Every test in this file drives one world with one disk, and permanence is
 * exactly the property of outliving a connection — so a reused name carries the
 * previous test's saved position into the next one, and an assertion about
 * where somebody entered starts passing for the wrong reason.
 */
let playersSoFar = 0;

function freshPlayer(): string {
  return `player-${playersSoFar++}`;
}

/** Keys a single storage.put will take. */
const BACKFILL_BATCH = 128;

/** Every key the object is holding under one prefix. */
async function storedKeys(prefix: string): Promise<string[]> {
  let keys: string[] = [];
  await runInDurableObject(stub(), async (_instance, state) => {
    keys = [...(await state.storage.list({ prefix })).keys()];
  });
  return keys;
}

/** What the object wrote down about one player's kit, if anything. */
async function savedEquipment(
  actorId: string,
): Promise<Record<string, unknown> | undefined> {
  let found: Record<string, unknown> | undefined;
  await runInDurableObject(stub(), async (_instance, state) => {
    found = await state.storage.get<Record<string, unknown>>(`equip:${actorId}`);
  });
  return found;
}

/** The kit a `hello` handed over, in the shape the assertions want it. */
function kitOf(hello: Record<string, unknown>): { bag: { id: string } } {
  return hello.equipment as { bag: { id: string } };
}

/** Where one step east from the fixture's spawn cell lands. */
const ONE_STEP_EAST = 1;

/** Walk one cell east and wait for it to land on the board. */
async function walkEast(ws: WebSocket) {
  step(ws, 0, "e");
  await walkWithin(ws, 1000);
  await new Promise((resolve) => setTimeout(resolve, WALK_DURATION_MS + 200));
}

/** Close a socket and let the object finish tidying up after it. */
async function leave(ws: WebSocket) {
  ws.close();
  await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
}

/**
 * A wider strip whose spawn marker is at the far end.
 *
 * The fixture map spawns at the origin, which makes "bubbled to the neighbour
 * on the west" and "gave up and went to spawn" the same cell — a test that
 * passes either way. Moving the marker is what separates them.
 */
const FAR_SPAWN = 5;

function stripSpawningAtTheFarEnd(): FlatMapFile {
  const levels: Record<string, Record<string, unknown[]>> = { "0": {} };
  for (let x = 0; x <= FAR_SPAWN; x++) levels["0"]![`${x},0`] = [{ tileId: "grass" }];
  levels["0"]![`${FAR_SPAWN},0`] = [
    { tileId: "grass" },
    { tileId: "player", direction: "s" },
  ];
  return { version: 1, levels } as FlatMapFile;
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

  it("starts somebody the world has never met at the spawn point", async () => {
    await connect(freshPlayer());

    const newcomer = freshPlayer();
    await connect(newcomer);

    expect(await actorX(newcomer)).toBe(0);
  });

  /**
   * The position has to be in storage, not only in this instance's memory: an
   * idle world's object is evicted routinely, and a player who left before it
   * happened has nothing else keeping their place.
   */
  it("remembers across an eviction", async () => {
    const who = freshPlayer();
    const first = await connect(who);
    await walkEast(first.ws);
    await leave(first.ws);
    await simulateEviction();

    await connect(who);

    expect(await actorX(who)).toBe(ONE_STEP_EAST);
  });

  /**
   * A crash is not a close. The write on disconnect covers somebody who leaves;
   * this covers the object dying under somebody who has not, which is what the
   * periodic flush and the write at idle are for.
   */
  it("writes a connected player's position down as the world settles", async () => {
    const who = freshPlayer();
    const { ws } = await connect(who);
    await walkEast(ws);

    // Saving is the last thing that happens before the world goes to sleep, and
    // sleep is the point after which this object may be evicted.
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
    expect(await savedPosition(who)).toMatchObject({
      x: ONE_STEP_EAST,
      y: 0,
      z: 0,
    });
  });

  /**
   * One entry per visitor, on a disk that is not infinite and an identity
   * anybody can mint. The oldest go, and the test has to show *which* ones —
   * a prune that dropped the newcomers instead would leave the count right and
   * the feature useless.
   */
  it("drops the least recently saved once the store is full", async () => {
    const overflow = 5;
    // Backfilled directly: reaching the cap over the wire means a thousand
    // connections, and the prune is what is under test rather than the saving.
    await runInDurableObject(stub(), async (_instance, state) => {
      for (let i = 0; i < MAX_REMEMBERED_ACTORS + overflow; i += BACKFILL_BATCH) {
        const batch: Record<string, unknown> = {};
        const end = Math.min(i + BACKFILL_BATCH, MAX_REMEMBERED_ACTORS + overflow);
        for (let n = i; n < end; n++) {
          // savedAt ascending with n, so the lowest-numbered are the oldest.
          batch[`pos:backfill-${n}`] = { x: 0, y: 0, z: 0, direction: "s", savedAt: n };
        }
        await state.storage.put(batch);
      }
    });

    // Pruning happens on load, so the world has to be brought in fresh.
    await simulateEviction();
    await connect(freshPlayer());

    const kept = await storedKeys("pos:");
    expect(kept).toHaveLength(MAX_REMEMBERED_ACTORS);
    expect(kept).not.toContain("pos:backfill-0");
    expect(kept).toContain(`pos:backfill-${MAX_REMEMBERED_ACTORS + overflow - 1}`);
  });

  /**
   * A kit is the one thing a fresh runtime cannot rebuild from the tile it is
   * standing in — it came from somewhere, and the world owes continuity for it.
   *
   * Asserted on the bag's *identity* rather than on its shape, because a fresh
   * starting kit has the same shape: same tile, same four empty slots. Only the
   * id tells "we remembered yours" from "we minted you another one".
   */
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

  /** Same reason positions are written down: an idle object is evicted. */
  it("remembers a kit across an eviction", async () => {
    const who = freshPlayer();
    const first = await connect(who);
    const bagId = kitOf(first.hello).bag.id;
    await leave(first.ws);
    await simulateEviction();

    const again = await connect(who);

    expect(kitOf(again.hello).bag.id).toBe(bagId);
  });

  /** A crash is not a close — the same case the position flush covers. */
  it("writes a connected player's kit down as the world settles", async () => {
    const who = freshPlayer();
    const { ws, hello } = await connect(who);
    await walkEast(ws);
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    const saved = await savedEquipment(who);
    expect((saved?.equipment as { bag: { id: string } }).bag.id).toBe(
      kitOf(hello).bag.id,
    );
  });

  /**
   * The kit keys are capped on the same terms the positions are, and for the
   * same reason: identity is a cookie anybody can mint, so one entry per visitor
   * is a slow leak with a hostile version of itself.
   */
  it("drops the least recently saved kits once the store is full", async () => {
    const overflow = 5;
    await runInDurableObject(stub(), async (_instance, state) => {
      for (let i = 0; i < MAX_REMEMBERED_ACTORS + overflow; i += BACKFILL_BATCH) {
        const batch: Record<string, unknown> = {};
        const end = Math.min(i + BACKFILL_BATCH, MAX_REMEMBERED_ACTORS + overflow);
        for (let n = i; n < end; n++) {
          batch[`equip:backfill-${n}`] = {
            equipment: { weapon: null, bag: null },
            savedAt: n,
          };
        }
        await state.storage.put(batch);
      }
    });

    await simulateEviction();
    await connect(freshPlayer());

    const kept = await storedKeys("equip:");
    expect(kept).toHaveLength(MAX_REMEMBERED_ACTORS);
    expect(kept).not.toContain("equip:backfill-0");
    expect(kept).toContain(`equip:backfill-${MAX_REMEMBERED_ACTORS + overflow - 1}`);
  });

  /**
   * The one rule that stops an item existing twice.
   *
   * Picking something up takes it off the map and puts it in a bag, so the two
   * are halves of one fact from then on. A kit made durable against a board that
   * was not would come back to a floor still holding the very thing it claims —
   * so the checkpoint rides in the same write, and what this asserts is that a
   * kit is never on disk ahead of the board it was read from.
   */
  it("never writes a kit down without the board it was read from", async () => {
    const who = freshPlayer();
    const { ws } = await connect(who);
    await walkEast(ws);
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    const saved = await savedEquipment(who);
    expect(saved).toBeDefined();
    // Same batch, so the checkpoint cannot be older than the kit — and the
    // strongest observable form of that is simply that it is there at all by
    // the time a kit is.
    await runInDurableObject(stub(), async (_instance, state) => {
      expect(await state.storage.get("world")).toBeDefined();
    });
  });

  /**
   * The world keeps moving while somebody is away, so a remembered position is
   * a wish rather than a promise: the map they come back to may have no room
   * for them where they were standing.
   */
  it("bubbles to a neighbour when their cell has been built on", async () => {
    const who = freshPlayer();
    const first = await connect(who);
    await walkEast(first.ws);
    await leave(first.ws);

    // A wall goes up on the cell they logged out of. The marker sits five cells
    // away, so giving up and going to spawn would read differently from
    // stepping aside.
    const rebuilt = stripSpawningAtTheFarEnd();
    rebuilt.levels["0"]![`${ONE_STEP_EAST},0`] = [
      { tileId: "grass" },
      { tileId: "stone-wall" },
    ];
    await stub().replaceWorld(rebuilt);

    await connect(who);

    // Stepped aside to the west, rather than sent to the far-end marker.
    expect(await actorX(who)).toBe(ONE_STEP_EAST - 1);
  });
});

/**
 * Shoving something, and being told about it exactly once.
 *
 * A push commits to the map the instant it happens; what travels afterwards is
 * the animation hint, and the client restarts its lerp on every one it hears.
 * So a shove announced six times is a shove drawn six times from the beginning,
 * which is a crate juddering in place for its whole 200ms rather than sliding —
 * and an actor this side has long since freed still reading as busy on the
 * client, so the next step and the next push are both refused.
 *
 * The bug was upstream of this file: {@link ActorSnapshot}'s slide used to be
 * rebuilt on every read to carry its own progress, and `collectMotionEvents`
 * decides what is new by *identity*. Walking and falling hand over their live
 * state and were fine; only the slide allocated.
 */

/** The push lane, east of everything the tests above walk on. */
const BOX_SPAWN = 9;
const BOX_AT = BOX_SPAWN + 1;

/**
 * A run-on world with a box beside its spawn point.
 *
 * Handed over as a checkpoint rather than as `map.json`, because every test in
 * this file drives the one world and it loads its board once — a checkpoint
 * plus an eviction is the only way to put a different one in front of it.
 */
function stripWithABox(): {
  map: FlatMapFile;
  spawn: { x: number; y: number; z: number; stackIndex: number };
} {
  const levels: Record<string, Record<string, unknown[]>> = { "0": {} };
  for (let x = 0; x <= BOX_AT + 1; x++) {
    levels["0"]![`${x},0`] = [{ tileId: "grass" }];
  }
  levels["0"]![`${BOX_AT},0`] = [{ tileId: "grass" }, { tileId: "wooden-box" }];
  return {
    map: { version: 1, levels } as FlatMapFile,
    spawn: { x: BOX_SPAWN, y: 0, z: 0, stackIndex: 1 },
  };
}

/** Every event of one kind that arrives in a window. */
function eventsWithin(
  ws: WebSocket,
  kind: string,
  ms: number,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const found: Record<string, unknown>[] = [];
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(event.data as string) as Record<string, unknown>;
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

/** Where the box is in the running world, as an x. */
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

describe("pushing", () => {
  it("announces one shove once", async () => {
    await putCheckpoint(stripWithABox());
    await simulateEviction();
    const { ws } = await connect(freshPlayer());

    // Listening before the tap, so nothing the first tick sends is missed.
    const slides = eventsWithin(ws, "slideStarted", PUSH_STEP_MS + QUIET_MS * 2);
    ws.send(
      JSON.stringify({
        type: "interact",
        ref: { x: BOX_AT, y: 0, z: 0, stackIndex: 1 },
      }),
    );

    // Loudly rather than flakily: a push the board refused would report zero
    // events too, and that is a broken fixture rather than the bug under test.
    expect(await slides).toHaveLength(1);
    expect(await boxX()).toBe(BOX_AT + 1);
  });
});

/**
 * The editor's save is the only way to change the world, which makes it the
 * only way to repair one — and it used to be the thing that broke it.
 *
 * A map whose `player` marker has been erased cannot start a session. That was
 * discovered *after* the map had been written and the checkpoint deleted, so
 * one such save persisted the unstartable map and destroyed the last startable
 * copy of the world. Every load threw from then on; and because the save began
 * by loading, the repair could not be saved either — putting the marker back
 * needed a world that could not come up. A live world was lost this way, and
 * both halves are needed to make sure another is not: validate before writing,
 * and never read the world you are replacing.
 */

/** The strip, with nothing to say where anybody enters. */
function markerlessMap(): FlatMapFile {
  const levels: Record<string, Record<string, unknown[]>> = { "0": {} };
  for (let x = 0; x < 4; x++) {
    levels["0"]![`${x},0`] = [{ tileId: "grass" }];
  }
  return { version: 1, levels } as FlatMapFile;
}

/** The authored map as it currently sits in the bucket. */
async function storedMap(): Promise<FlatMapFile> {
  const stored = await env.DATA.get("map.json");
  return JSON.parse(await stored!.text()) as FlatMapFile;
}

describe("saving a map that cannot start", () => {
  it("refuses it without writing anything", async () => {
    // A world worth losing, so "changed nothing" has something to say.
    await stub().replaceWorld(authoredMap());
    await putCheckpoint(checkpointWith(["ghost"]));
    const before = await storedMap();

    // Called on the instance rather than through the stub: an RPC that rejects
    // is also reported as a remote unhandled error, which fails the run even
    // when the rejection is the thing being asserted.
    await runInDurableObject(stub(), async (instance: GameServer) => {
      await expect(instance.replaceWorld(markerlessMap())).rejects.toThrow(
        /player/,
      );
    });

    // The map that was there is still there, marker and all.
    expect(await storedMap()).toEqual(before);
    // And so is the checkpoint, which is the copy that would have been lost.
    await runInDurableObject(stub(), async (_instance, state) => {
      expect(await state.storage.get("world")).toBeDefined();
    });
  });

  /**
   * The wedge itself, rebuilt from the outside: storage holding a map that
   * cannot start, and no checkpoint to fall back on. Saving a good map has to
   * work from here, because this is exactly the state a save has to dig a world
   * out of — and it cannot do that by loading the world first.
   */
  it("saves onto a world too broken to load", async () => {
    // An object of its own, and that is not tidiness. This test has to leave
    // storage holding a map that cannot start, and the world every other test
    // shares has live sockets on it — any one of them touching it in that
    // window would load the broken map and take the run down with it. A fresh
    // name has no checkpoint and no session, which is the wedged state exactly:
    // the only copy of the world is one that cannot be started.
    const wedged = env.GAME.getByName("wedged-world");
    await env.DATA.put("map.json", JSON.stringify(markerlessMap()));

    await wedged.replaceWorld(authoredMap());

    expect(playerCells(await storedMap())).toEqual([0]);
  });
});

/**
 * Eating something, all the way through the socket.
 *
 * Worth a Durable Object test rather than only a session one because the two
 * halves that can go wrong live out here: the message has to reach
 * `session.consume` at all, and the noise it makes has to be drained *before*
 * the next tick clears the speech page. A consume arrives between ticks, so
 * nothing on the clock would have flushed it — see `GameServer.flushSpeech`.
 *
 * `berry` is a real tile out of `data/tiles.json`, which is the catalogue this
 * suite loads, so this is the authored consumable and not a fixture.
 */
describe("consuming", () => {
  const BERRY = "berry";

  /** The strip of grass, with a berry lying in the cell east of spawn. */
  function mapWithBerry(): FlatMapFile {
    const map = authoredMap();
    map.levels["0"]!["1,0"] = [{ tileId: "grass" }, { tileId: BERRY }];
    return map;
  }

  const BERRY_REF = { x: 1, y: 0, z: 0, stackIndex: 1 };

  /**
   * The live board rather than `storedMap`: play never writes back to
   * `data/map.json` — only an editor save does — so the authored file still
   * has the berry in it however thoroughly it has been eaten.
   */
  async function liveTilesAt(x: number, y: number, z: number) {
    let found: string[] = [];
    await runInDurableObject(stub(), (instance: GameServer) => {
      const session = (instance as unknown as { session: { getMap(): MapFile } })
        .session;
      found = getStack(session.getMap(), x, y, z).map((p) => p.tileId);
    });
    return found;
  }

  it("takes the berry off the board", async () => {
    await env.DATA.put("map.json", JSON.stringify(mapWithBerry()));
    const alice = await connect("alice");
    expect(await liveTilesAt(1, 0, 0)).toEqual(["grass", BERRY]);

    send(alice.ws, { type: "consume", from: { kind: "floor", ref: BERRY_REF } });
    await noiseWithin(alice.ws, 1000);

    expect(await liveTilesAt(1, 0, 0)).toEqual(["grass"]);
  });

  /**
   * The regression the flush exists for. Without it the crunch is recorded
   * between ticks and wiped by the next `tick` before anything drains it, so
   * this waits for a sound that never comes.
   */
  it("makes the noise it makes, to the floor it was eaten on", async () => {
    await env.DATA.put("map.json", JSON.stringify(mapWithBerry()));
    const alice = await connect("alice");

    send(alice.ws, { type: "consume", from: { kind: "floor", ref: BERRY_REF } });

    expect(await noiseWithin(alice.ws, 1000)).toMatchObject({
      type: "noise",
      text: "crunch",
      z: 0,
    });
  });

  /**
   * The point of the channel, asserted where a client would actually see it: a
   * crunch must not arrive as something somebody *said*, because that is what
   * puts a name in front of it.
   */
  it("never sends it as chat, which would name a speaker", async () => {
    await env.DATA.put("map.json", JSON.stringify(mapWithBerry()));
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
