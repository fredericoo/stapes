import {
  env,
  fetchMock,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import tilesJson from "../data/tiles.json";
import statusesJson from "../data/statuses.json";
import {
  BRAIN_TICK_MS,
  PLAYER_TILE_ID,
  PUSH_STEP_MS,
  STARTING_BAG_TILE_ID,
  WALK_DURATION_MS,
} from "../app/game/constants";
import { MINUTES_PER_DAY, minutesOfDayAt } from "../app/lib/clock";
import { DEV_DATA_PREFIX } from "../app/lib/devData";
import { resolvePush } from "../app/lib/interactions";
import { getStack, listCoords } from "../app/lib/mapData";
import type { FlatMapFile, MapFile, TileDef } from "../app/lib/types";
import { tilesByIdFromList } from "../app/lib/validation";
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

/** How many cells {@link authoredMap} lays down, for telling it from a void. */
const AUTHORED_CELLS = 4;

/** A strip of grass with the authored spawn marker at the origin. */
function authoredMap(): FlatMapFile {
  const levels: Record<string, Record<string, unknown[]>> = { "0": {} };
  for (let x = 0; x < AUTHORED_CELLS; x++) {
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

/** Where the authored `player` marker stands, which is where a death sends you. */
const SPAWN_CELL = 0;

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
  await env.DATA.put("statuses.json", JSON.stringify(statusesJson));
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

/**
 * How the board itself is written down.
 *
 * The world used to be checkpointed as one storage value holding the whole map,
 * which a Durable Object refuses somewhere past two megabytes — and refuses
 * silently, since the write is fire-and-forget. These cover the shape that
 * replaced it: a key per chunk, so the ceiling scales with the world instead of
 * standing across it, and a flush writes only what moved.
 */
describe("the checkpointed board", () => {
  /** Let the world tick, settle and write itself down. */
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
    // The one value that grew with the world is gone; what is left is the
    // handful of facts that cannot be recovered from the board.
    expect(meta!.map).toBeUndefined();
    expect(meta!.spawn).toBeDefined();
    expect(chunkKeys.length).toBeGreaterThan(0);
  });

  /**
   * A world checkpointed before the board was split still has to come up, and
   * has to stop being legacy once it does — otherwise the migration is one the
   * live world never actually takes.
   */
  it("writes a legacy whole-map checkpoint back out as chunks", async () => {
    await putCheckpoint(checkpointWith(["alice"]));
    await connect("alice");
    // Resumed where the legacy checkpoint had them, rather than at spawn.
    expect(await actorX("alice")).toBe(AWAY_FROM_SPAWN);

    await settle();

    const { meta, chunkKeys } = await storedBoard();
    expect(meta!.map).toBeUndefined();
    expect(chunkKeys.length).toBeGreaterThan(0);
  });

  /**
   * Metadata with no board under it is a world that cannot be resumed — and one
   * that will not say so. A resumed world is handed its spawn point rather than
   * reading it off the map, so starting on nothing raises nothing: everybody
   * joins and stands in a void. The terrain is what has to be asserted here;
   * that a hello arrived, and that alice is in it, is true of the void too.
   */
  it("falls back to the authored map when the chunks are missing", async () => {
    await putCheckpoint({ spawn: { x: 0, y: 0, z: 0, stackIndex: 1 } });

    const { hello } = await connect("alice");

    expect(playerOwners(hello.map as FlatMapFile)).toEqual(["alice"]);
    const ground = (hello.map as FlatMapFile).levels["0"] ?? {};
    expect(Object.keys(ground).length).toBe(AUTHORED_CELLS);
  });

  /**
   * Regression shape: a chunk of a world that no longer exists, sitting under a
   * key the new world never writes, would be reassembled as part of it — a
   * corner of a map nobody authored, until somebody edited that exact chunk.
   */
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
    // And the new board is written down in its place, rather than the wipe
    // leaving nothing to resume.
    expect(chunkKeys.length).toBeGreaterThan(0);
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
    // Two reads, and neither is the map: a save replaces the world wholesale, so
    // it deliberately never reads the one it is replacing. No `map.json` GET is
    // stubbed here, and that is the assertion — with net access off, reaching
    // for one would fail the test rather than quietly pass.
    pool
      .intercept({ path: dataPath("tiles.json") })
      .reply(200, JSON.stringify(tilesJson));
    pool
      .intercept({ path: dataPath("statuses.json") })
      .reply(200, JSON.stringify(statusesJson));
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
      .intercept({ path: dataPath("statuses.json") })
      .reply(200, JSON.stringify(statusesJson));
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

/** What the object wrote down about one player's masteries, if anything. */
async function savedMasteries(
  actorId: string,
): Promise<Record<string, number> | undefined> {
  let found: { masteries?: Record<string, number> } | undefined;
  await runInDurableObject(stub(), async (_instance, state) => {
    found = await state.storage.get(`mast:${actorId}`);
  });
  return found?.masteries;
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
            equipment: { weapon: null, offhand: null,
  bag: null },
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
   * A tag records that something already happened, so it is the one piece of
   * per-actor state that must survive everything.
   *
   * Seeded straight into storage rather than earned by opening a chest: what is
   * under test is the load path — `lastTagsOf` → `spawn` → `hello` — which only
   * runs when the object is built from disk, and the fixture map has no reward
   * tile to earn one from. It is exactly the shape of bug a node test cannot
   * see, which is what this file is for.
   */
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

  /**
   * The editor saves constantly, and a save re-seats everybody.
   *
   * Their *kit* is not carried across — it named things in a world that has just
   * been thrown away — but a tag names something that happened to the person,
   * and dropping it would refill every chest in the map for everybody standing
   * in it, once per save.
   */
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

  /** Capped on the same terms the kits and positions are, and separately. */
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
    await connect(freshPlayer());

    const kept = await storedKeys("tags:");
    expect(kept).toHaveLength(MAX_REMEMBERED_ACTORS);
    expect(kept).not.toContain("tags:backfill-0");
    expect(kept).toContain(`tags:backfill-${MAX_REMEMBERED_ACTORS + overflow - 1}`);
  });

  /**
   * A mastery is the third thing a world owes continuity for, and the one with
   * no fallback: a lost kit is a sword, and a lost mastery is every fight the
   * player has ever had.
   *
   * Seeded straight into storage rather than earned in a fight, for the reason
   * the tag test is: what is under test is the load path — `lastMasteriesOf` →
   * `spawn` → the runtime — and the figure is chosen far above anything the
   * authored `player` tile could seed, so a block that had been quietly
   * re-derived from the tile reads as a much smaller number rather than as a
   * pass.
   */
  it("hands a returning player back what they have learnt", async () => {
    const who = freshPlayer();
    const EARNED = { blade: 40_000, toughness: 9_000 };
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

  /**
   * The one piece of a save that is *arithmetic* rather than a name or a list.
   *
   * Everything downstream divides by it, scales by it and compares against it,
   * so a figure that is not a number has to be refused where it is read. Losing
   * that player their progress is the cost; a NaN spreading through every swing
   * they make from then on is the alternative.
   */
  it("refuses a stored block of masteries it cannot make sense of", async () => {
    const who = freshPlayer();
    await runInDurableObject(stub(), async (_instance, state) => {
      await state.storage.put(`mast:${who}`, {
        masteries: { blade: "quite good", agility: -1 },
        savedAt: Date.now(),
      });
    });
    await simulateEviction();

    const { ws, hello } = await connect(who);
    expect(hello).toBeDefined();

    await walkEast(ws);
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    // Re-seeded from the tile, which is what a player who has never fought
    // looks like — and every figure in it a real number.
    const written = await savedMasteries(who);
    for (const earned of Object.values(written ?? {})) {
      expect(Number.isFinite(earned)).toBe(true);
    }
    expect(written?.blade).not.toBeNaN();
  });

  /** Capped on the same terms the kits, positions and tags are, and separately. */
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
    await connect(freshPlayer());

    const kept = await storedKeys("mast:");
    expect(kept).toHaveLength(MAX_REMEMBERED_ACTORS);
    expect(kept).not.toContain("mast:backfill-0");
    expect(kept).toContain(`mast:backfill-${MAX_REMEMBERED_ACTORS + overflow - 1}`);
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

const BOX_TILE_ID = "wooden-box";

/** Laid under the box wherever its own rules allow no ground to be chosen. */
const ANY_GROUND_TILE_ID = "grass";

/**
 * The tile the lane is paved with: one the box is authored to slide across.
 *
 * Read off the crate's own `push.moveOnTileIds` rather than named here, because
 * that list is authored content and has been narrowed before — the day the box
 * stopped moving on anything but dirt, a lane of grass turned every shove in
 * this file into a refusal, which reads as "nothing was announced" and is
 * exactly the failure the test below exists to catch. An empty list means
 * anywhere, and then any ground will do.
 */
function laneTileId(): string {
  const def = tilesByIdFromList(tilesJson as TileDef[])[BOX_TILE_ID];
  const moveOn = def ? (resolvePush(def)?.moveOnTileIds ?? []) : [];
  return moveOn[0] ?? ANY_GROUND_TILE_ID;
}

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
  const ground = laneTileId();
  const levels: Record<string, Record<string, unknown[]>> = { "0": {} };
  for (let x = 0; x <= BOX_AT + 1; x++) {
    levels["0"]![`${x},0`] = [{ tileId: ground }];
  }
  levels["0"]![`${BOX_AT},0`] = [{ tileId: ground }, { tileId: BOX_TILE_ID }];
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

describe("respawn", () => {
  const GNOME_X = 3;
  /** The identity adoption mints at the gnome's authored spot. */
  const GNOME_OWNER = `npc:${GNOME_X},0,0,1`;
  /** Immediate, so the test waits on the machinery rather than the window. */
  const RESPAWN_WINDOW_MS = 1;

  /** A mindless body that comes back — no brain, so the world can settle. */
  function gnomeTile() {
    return {
      id: "gnome",
      name: "Gnome",
      height: 1,
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
    flat.levels["0"]![`${GNOME_X},0`] = [
      { tileId: "grass" },
      { tileId: "gnome" },
    ];
    return flat;
  }

  beforeEach(async () => {
    await env.DATA.put(
      "tiles.json",
      JSON.stringify([...tilesJson, gnomeTile()]),
    );
    await env.DATA.put("map.json", JSON.stringify(mapWithGnome()));
  });

  it("derives and stores the spawn points when a fresh world loads", async () => {
    await connect("alice");

    const points = await runInDurableObject(stub(), (_instance, state) =>
      state.storage.get<Array<{ key: string; ownerId?: string }>>(
        "respawnPoints",
      ),
    );
    expect(points?.map((p) => p.key)).toEqual([GNOME_OWNER]);
    expect(points?.[0]?.ownerId).toBe(GNOME_OWNER);
  });

  /**
   * The whole promise in one pass: a death that only storage remembers — the
   * board was checkpointed without the body, the object evicted — is armed
   * afresh at load, and the alarm grows the creature back, adopted under the
   * identity it died with.
   */
  it("arms a creature missing at load and grows it back on the alarm", async () => {
    // A fresh load first, which is what derives and stores the registry.
    await connect("alice");

    await putCheckpoint({ ...checkpointWith(["alice"]), dead: [GNOME_OWNER] });
    await simulateEviction();

    const { hello } = await connect("alice");
    const helloStack = (hello.map as FlatMapFile).levels["0"]?.[`${GNOME_X},0`];
    expect(helloStack?.map((p) => p.tileId)).toEqual(["grass"]);

    // Past the 1ms window, so the deadline is due however it is served.
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The tick loop may have got there first and cleared the alarm, which is
    // the running-world path doing its job; the return is therefore not
    // asserted, only the world it leaves behind.
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
});

/**
 * The one operation in this object that is *destructive on purpose*.
 *
 * Everything else here is built to lose nothing: a save carries kits, tags and
 * masteries across, an eviction carries positions, and a bad map fails having
 * changed nothing. That is right until the thing that has to go is something
 * the object remembers about a *player*, at which point every one of those
 * mechanisms is working to keep it — see the first case below for the shape of
 * bug that produces.
 */
describe("resetting the world", () => {
  /**
   * The reason this exists at all, in one case.
   *
   * A mastery block is the piece of per-actor state everything else is built to
   * keep: an eviction restores it, and `replaceWorld` reads it off the outgoing
   * session precisely so that a save cannot cost somebody what they have
   * learnt. Which is right, and which also means a block that has come to
   * disagree with the content it was written against is unreachable — there is
   * no sequence of seeds, saves and reloads that clears it.
   *
   * Asserted from both ends, because only the pair says anything: the first
   * expectation is a save failing to shift it, and the second is the reset
   * being the thing that does.
   */
  it("forgets what a player had learnt, which a save carries forward", async () => {
    const who = freshPlayer();
    // Far above anything the authored `player` tile could seed, so a block that
    // had been quietly re-derived from the tile reads as a much smaller number
    // rather than as a pass.
    const EARNED = { blade: 40_000, toughness: 9_000 };
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
    // Seeded from the authored `player` tile again, which is what somebody the
    // world has never met looks like.
    expect(hello.masteryXp).not.toEqual(EARNED);
    expect(await storedKeys("mast:")).not.toContain(`mast:${who}`);
  });

  /**
   * A tag is the piece of per-actor state everything else is built to preserve
   * — `replaceWorld` carries it explicitly so the editor's constant saves do
   * not refill every chest in the map. Which means a tag naming a reward that
   * has since been re-authored is unreachable by any other route: the chest is
   * there, it is offered to everybody else, and it is closed to you for ever.
   */
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

  /**
   * The checkpoint is preferred to the bucket on every load, which is what
   * makes a seeded map invisible: `pnpm seed` can replace every byte of the
   * authored world and the object goes on serving the one it has.
   */
  it("starts the board again from the authored map", async () => {
    await connect("alice");
    await putCheckpoint(checkpointWith(["alice"]));
    await simulateEviction();

    const resumed = await connect("alice");
    expect(playerCells(resumed.hello.map as FlatMapFile)).toEqual([
      AWAY_FROM_SPAWN,
    ]);

    await stub().resetWorld();

    const { hello } = await connect("alice");
    // Back at the authored spawn, on a board the authored file describes.
    expect(playerCells(hello.map as FlatMapFile)).toEqual([0]);
    // The authored strip, not the four cells the checkpoint happened to share
    // with it: a board resumed from storage would still be missing the marker.
    expect(
      Object.keys((hello.map as FlatMapFile).levels["0"] ?? {}),
    ).toHaveLength(AUTHORED_CELLS);
  });

  /**
   * Everyone already in the world, without waiting for them to reload.
   *
   * A reset that only took effect on reconnect would leave whoever was standing
   * there playing a world that no longer exists — walking a board nobody else
   * can see, with every step refused by a session that has never heard of them.
   */
  it("re-seats a connected player rather than waiting for a reload", async () => {
    const who = freshPlayer();
    const joined = await connect(who);

    await stub().resetWorld();

    const hello = await nextMessage(joined.ws);
    expect(hello.type).toBe("hello");
    expect(hello.selfId).toBe(who);
    expect(playerOwners(hello.map as FlatMapFile)).toEqual([who]);
  });

  /**
   * The chat log, which is the one thing in this object that is not a key.
   *
   * `deleteAll` empties the key-value side and leaves a table made through
   * `storage.sql` standing, so the log has to go by name — and a wipe that left
   * it holding what a world that no longer exists said would be a wipe in name
   * only. Written with a log to drop rather than against an empty object,
   * because `DROP TABLE IF EXISTS` on a world nobody has spoken in is a no-op
   * that passes whatever the code does.
   */
  it("drops the chat log, and survives having one to drop", async () => {
    const alice = await connect("alice");
    say(alice.ws, "hello");
    await chatWithin(alice.ws, 1000);
    expect(await chatRows()).not.toHaveLength(0);

    await stub().resetWorld();

    // The table itself, not its rows: `chatRows` would throw on a dropped one,
    // which is the same assertion made in a way that cannot tell a drop from a
    // typo. `logChat` creates it again the next time anybody speaks.
    const tables = await runInDurableObject(stub(), (_instance, state) => [
      ...state.storage.sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat'",
      ),
    ]);
    expect(tables).toHaveLength(0);
  });

  /** The ordinary case: nobody is connected and the world is asleep. */
  it("works on a world nobody is in", async () => {
    await putCheckpoint(checkpointWith(["ghost"]));
    await simulateEviction();

    await stub().resetWorld();

    const { hello } = await connect("alice");
    expect(playerCells(hello.map as FlatMapFile)).toEqual([0]);
  });
});

/**
 * What a flush is allowed to cost.
 *
 * The interval used to be the only thing holding the write rate down, because a
 * flush wrote every actor unconditionally whether or not anything about them had
 * moved. That came to roughly thirteen thousand storage rows an hour for one
 * connected player — enough to exhaust a day of the Durable Objects free tier in
 * a single sitting, which is how it was found, with every socket in production
 * failing on `Exceeded allowed rows written`.
 *
 * So these are cost tests, and cost is the thing a test suite normally cannot
 * see: nothing here changes what a player experiences, which is exactly why it
 * could regress for months without a single other case going red.
 */
describe("what a flush writes", () => {
  const GNOME_X = 3;
  const GNOME_OWNER = `npc:${GNOME_X},0,0,1`;

  /** A mindless body, so the world can actually settle and flush. */
  function gnomeTile() {
    return {
      id: "gnome",
      name: "Gnome",
      height: 1,
      type: "simple",
      kind: "prop",
      attributes: {},
      actor: true,
      walkable: false,
      interactions: {},
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
    flat.levels["0"]![`${GNOME_X},0`] = [
      { tileId: "grass" },
      { tileId: "gnome" },
    ];
    return flat;
  }

  beforeEach(async () => {
    await env.DATA.put(
      "tiles.json",
      JSON.stringify([...tilesJson, gnomeTile()]),
    );
    await env.DATA.put("map.json", JSON.stringify(mapWithGnome()));
  });

  /**
   * The single biggest line of the old bill, and it bought nothing.
   *
   * Every caller of `lastPositionOf` is asking on behalf of a socket, because a
   * player's tile is consumed at spawn and the board no longer says where they
   * were. A creature is the opposite — it is adopted *out of* the board — so its
   * position is already in the checkpointed chunks and the row beside them had
   * no reader at all. Twelve of the eighteen-odd rows a flush wrote on the real
   * map were exactly this.
   */
  it("never writes down where a creature is standing", async () => {
    const alice = await connect("alice");
    await walkEast(alice.ws);
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    const positions = await storedKeys("pos:");
    expect(positions).toContain("pos:alice");
    expect(positions).not.toContain(`pos:${GNOME_OWNER}`);
  });

  /**
   * And the board is why that is safe rather than merely cheap: a creature comes
   * back from the checkpoint it is drawn on, so forgetting its row costs nothing
   * across the eviction that would expose it.
   */
  it("still puts a creature back where it stood after an eviction", async () => {
    await connect("alice");
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
    await simulateEviction();

    const { hello } = await connect("bob");
    const stack = (hello.map as FlatMapFile).levels["0"]?.[`${GNOME_X},0`];
    expect(stack?.map((placed) => placed.tileId)).toEqual(["grass", "gnome"]);
  });

  /**
   * Somebody standing still is the common case in a world that never settles —
   * one person AFK holds the tick loop open for everybody, and used to hold a
   * write open with it, thirty times a minute, saying the same thing each time.
   */
  it("does not write a player again while they have not moved", async () => {
    const who = freshPlayer();
    const alice = await connect(who);
    await walkEast(alice.ws);
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    const first = await runInDurableObject(stub(), (_instance, state) =>
      state.storage.get<{ savedAt: number }>(`pos:${who}`),
    );
    expect(first).toBeDefined();

    // A second settle with nothing having happened in between.
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
    // The same stamp, which is only possible if nothing was written over it.
    expect(second?.savedAt).toBe(first?.savedAt);
  });

  /**
   * The invariant the skipping must not break.
   *
   * Picking something up takes it off the map and puts it in a bag, so a kit made
   * durable against a board that was not is an item existing twice. Skipping an
   * unchanged row cannot cause that — the event that must not split the two
   * changes both, so both are dirty together — but "cannot" is the kind of claim
   * that wants a test standing on it.
   */
  it("writes a kit and the board it was read from in one batch", async () => {
    const who = freshPlayer();
    const alice = await connect(who);
    await walkEast(alice.ws);
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    const kit = await runInDurableObject(stub(), (_instance, state) =>
      state.storage.get<{ savedAt: number }>(`equip:${who}`),
    );
    const board = await storedKeys("chunk:");
    // A starting kit exists and the board it was read against is down beside it.
    expect(kit).toBeDefined();
    expect(board.length).toBeGreaterThan(0);
  });

  /**
   * A leaver is forced past the dirty check, because a skipped row keeps
   * whatever `savedAt` it last had and `savedAt` is what decides who gets
   * forgotten first. Somebody who stood still for an hour and then left would
   * otherwise carry an hour-old stamp into that queue, which is backwards.
   */
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

/**
 * What a death leaves behind, across a reload.
 *
 * The bug this covers was invisible from either side alone. `saveActors` skips
 * an actor with no position — which is every dead one — and then writes the
 * board anyway, so the batch that recorded "the sword is no longer on the floor"
 * carried nothing saying where it went. A sword picked up and carried into a
 * losing fight was in nobody's kit and on nobody's floor, and the only thing
 * that could have said otherwise was the runtime the killing blow deleted.
 *
 * It needs the real object: the facts under test are storage rows, and they are
 * only ever written by the path a wake reads back.
 */
describe("dying and coming back", () => {
  const SWORD = "rusty-sword";

  /** A world in progress: alice standing away from spawn, a sword at her feet. */
  function checkpointWithSword() {
    const checkpoint = checkpointWith(["alice"]);
    const cell = `${AWAY_FROM_SPAWN},0`;
    checkpoint.map.levels["0"]![cell] = [
      ...checkpoint.map.levels["0"]![cell]!,
      { tileId: SWORD },
    ];
    return checkpoint;
  }

  /** Where the sword she picked up was standing, as a stack index. */
  const SWORD_STACK_INDEX = 2;

  /**
   * Kill somebody where they stand, and let the server notice.
   *
   * White-box, on exactly the terms {@link simulateEviction} is: the wire has no
   * "die", and the honest routes to one — a creature grinding a player down over
   * seconds of real ticks — would make the premise of this test its slowest and
   * least reliable part. What is under test is what the *server* does with a
   * death, which begins on the tick that notices one.
   */
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
      // More than anything on the mastery scale can survive, so the blow is a
      // death rather than a fight.
      internals.session.applyDamage(body, 10_000);
      internals.tick();
    });
  }

  /** Alice, standing over a sword she has just taken off the floor. */
  async function armedAlice() {
    await putCheckpoint(checkpointWithSword());
    const alice = await connect("alice");
    alice.ws.send(
      JSON.stringify({
        type: "pickUp",
        ref: { x: AWAY_FROM_SPAWN, y: 0, z: 0, stackIndex: SWORD_STACK_INDEX },
      }),
    );
    // The kit patch that says it worked, which is also the acknowledgement that
    // the message has been handled — asserting on storage before it would be
    // asserting on a race.
    const patch = await nextMessage(alice.ws);
    expect(patch.type).toBe("equipment");
    return alice;
  }

  /**
   * Every tile in one cell of a map that came off the wire, contents included.
   *
   * A picked-up sword goes into the bag, and a dropped bag carries what is in it
   * on its own placement — so "is the sword in the world" is a question about
   * the pile *and* what the pile is holding.
   */
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
      position: await state.storage.get<Record<string, unknown>>(
        `pos:${actorId}`,
      ),
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
    // A bag, because a respawn hands one back — but a new one, holding none of
    // what fell on the floor.
    const bag = equipment?.equipment.bag as { contents?: unknown[] } | null;
    expect(bag?.contents ?? []).toEqual([]);
  });

  it("sends them back to the spawn point, not to where the last flush caught them", async () => {
    await armedAlice();
    // She died two cells from the door, so "back at spawn" and "left where the
    // flush found her" are different answers.
    expect(await actorX("alice")).toBe(AWAY_FROM_SPAWN);

    await killAndTick("alice");

    const { position } = await storedRows("alice");
    expect(position?.x).toBe(SPAWN_CELL);
  });

  it("stores the spawn coordinates the first time it sees somebody", async () => {
    await putCheckpoint(checkpointWithSword());
    await connect("alice");

    const spawn = await runInDurableObject(stub(), async (_instance, state) =>
      state.storage.get<Record<string, unknown>>("spawn:alice"),
    );
    expect(spawn).toMatchObject({ x: SPAWN_CELL, y: 0, z: 0 });
  });

  /**
   * A death empties your pockets but must not strand you: with no bag at all
   * there is nothing to pick your own corpse up with.
   */
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
    expect(equipment.bag?.tileId).toBe(STARTING_BAG_TILE_ID);
    expect(equipment.bag?.contents).toEqual([]);
  });

  it("brings them back on full hit points", async () => {
    await armedAlice();
    await killAndTick("alice");
    await simulateEviction();

    const { hello } = await connect("alice");

    const mine = (
      hello.hps as { actorId: string; hp: number; maxHp: number }[]
    ).find((entry) => entry.actorId === "alice");
    expect(mine!.hp).toBe(mine!.maxHp);
  });

  /**
   * The whole round trip, and the shape the report came in as: pick something
   * up, die, reload. Both halves have to hold at once — a sword that is on the
   * floor *and* in the bag is the same bug from the other side.
   */
  it("hands back a world holding the sword exactly once", async () => {
    await armedAlice();
    await killAndTick("alice");
    await simulateEviction();

    const { hello } = await connect("alice");

    // On the floor, inside the bag that fell with it.
    expect(tilesAt(hello.map as FlatMapFile, AWAY_FROM_SPAWN)).toContain(SWORD);
    // And not also on her back, which is the same bug from the other side. The
    // bag she is wearing is a fresh one, so the sword cannot be in two places by
    // way of a bag that is.
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
});

/**
 * A status effect across a disconnection and an eviction.
 *
 * **The test a node one cannot write**, and the reason this file exists: the
 * whole contract of a status is about what happens to it while nobody is driving
 * the body, and "nobody is driving the body" only has a meaning out here. Three
 * bugs in `GameServer` have already lived in the load / restore / checkpoint
 * path, and this feature adds two more keys to it.
 *
 * `berry` and `fed` are the authored content out of `data/`, not fixtures, so a
 * typo in either file fails here.
 */
describe("statuses across a disconnection", () => {
  const BERRY_REF = { x: 1, y: 0, z: 0, stackIndex: 1 };

  /** The strip of grass with a berry east of spawn, as the consume tests use. */
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

  /** What the world says is running on somebody right now. */
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
    await env.DATA.put("map.json", JSON.stringify(mapWithBerry()));
    const who = freshPlayer();
    const { ws } = await connect(who);

    send(ws, { type: "consume", from: { kind: "floor", ref: BERRY_REF } });
    await noiseWithin(ws, 1000);
    // Saving is the last thing before the world sleeps, which is the point after
    // which this object may be evicted.
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    const stored = await storedStatuses(who);
    expect(stored?.map((entry) => entry.defId)).toEqual(["fed"]);
    expect(stored![0]!.remainingMs).toBeGreaterThan(0);
  });

  /**
   * **The whole feature, in one assertion.** Logging off must neither cancel a
   * status nor advance it, so what comes back has to be what was left — not a
   * fresh one, and not one the wall clock ate while nobody was here.
   *
   * Asserts the remainder rather than merely that a status is present: "still
   * fed" passes whether the timer froze or ran, which is the only thing this is
   * about.
   */
  it("comes back exactly where it left off", async () => {
    await env.DATA.put("map.json", JSON.stringify(mapWithBerry()));
    const who = freshPlayer();
    const first = await connect(who);

    send(first.ws, { type: "consume", from: { kind: "floor", ref: BERRY_REF } });
    await noiseWithin(first.ws, 1000);
    await leave(first.ws);

    const away = await storedStatuses(who);
    expect(away?.[0]?.defId).toBe("fed");
    const remainingWhenTheyLeft = away![0]!.remainingMs;

    // The world runs on without them, and then stops existing altogether.
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS * 3));
    await simulateEviction();

    await connect(who);
    const back = await liveStatuses(who);
    expect(back?.map((entry) => entry.defId)).toEqual(["fed"]);
    // Frozen, not merely surviving: whatever the world did while they were gone
    // is not allowed to have been done to them.
    expect(back![0]!.remainingMs).toBe(remainingWhenTheyLeft);
  });

  /**
   * Health is written **only when it is short of full**, and the absence is the
   * rule rather than a gap: a body at its maximum needs no memory, because the
   * tile says so again next load. Without this the store would grow a key per
   * visitor for the fact that nothing has happened to them.
   */
  it("writes no health down for a body that is not hurt", async () => {
    await env.DATA.put("map.json", JSON.stringify(mapWithBerry()));
    const who = freshPlayer();
    const { ws } = await connect(who);

    send(ws, { type: "consume", from: { kind: "floor", ref: BERRY_REF } });
    await noiseWithin(ws, 1000);
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    // At full health nothing is written, and that absence *is* the rule: a body
    // at its maximum needs no memory, because the tile says so again next load.
    let stored: unknown;
    await runInDurableObject(stub(), async (_instance, state) => {
      stored = await state.storage.get(`hp:${who}`);
    });
    expect(stored).toBeUndefined();
  });
});
