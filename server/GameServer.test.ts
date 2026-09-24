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
import { CLOSE_REPLACED } from "../app/net/protocol";
import { COMBAT_STATUS_ID } from "../app/lib/status";
import { fightingStats, resolveBattler } from "../app/lib/battler";
import { swingWindupMs } from "../app/game/combat";
import { CHAT_LOG_MAX_ROWS, MAX_REMEMBERED_ACTORS, type GameServer } from "./GameServer";

/**
 * The bag `player`'s kit is authored with — see `app/lib/kit.ts`. A literal
 * here like every other tile id in this file: what a body carries is authored
 * content now, so there is no constant in the engine left to import.
 */
const BAG_TILE_ID = "basic-bag";

/** Content type for the authored JSON the tests seed. */
const JSON_TYPE = "application/json";

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
  return { version: MAP_FILE_VERSION, levels } as FlatMapFile;
}

/**
 * A world that has already been run: the marker is consumed, the actors listed
 * are standing in it, and the spawn point survives only because it is carried.
 */
const AWAY_FROM_SPAWN = 2;

/** Where the authored `player` marker stands, which is where a death sends you. */
const SPAWN_CELL = 0;

/**
 * A cell far enough out that it lands in a chunk of its own.
 *
 * Off the end of {@link authoredMap} is not enough — the whole strip fits in
 * one chunk, so a cell just past it shares that chunk's storage key and is
 * overwritten by any full rewrite of the board. A world reaching *here* is one
 * that occupies a key the authored world never writes, which is the only thing
 * a wipe can be caught failing to remove.
 */
const OUTLYING_CELL = CHUNK_SIZE * 2;

/** Where {@link OUTLYING_CELL} is written down. */
const OUTLYING_CHUNK_KEY = `chunk:${levelKey(0)}:${chunkKeyFor(OUTLYING_CELL, 0)}`;

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
    map: { version: MAP_FILE_VERSION, levels } as FlatMapFile,
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

/**
 * The world under test, rebuilt for each case.
 *
 * A module-level handle rather than a parameter, because that is the shape the
 * suite was already written against — `stub()` returned the one world, and
 * every test below reads like it still does.
 */
let harness: Harness;

function stub(): Harness["server"] {
  return harness.server;
}

/**
 * `runInDurableObject`, without a Durable Object.
 *
 * The platform version crossed an RPC boundary to reach inside a live instance
 * for its private fields and its raw storage. There is no boundary now, so the
 * white-box access it existed to provide is simply a function call — and the
 * `state.storage` the callbacks read is the real store, against a real file.
 */
async function runInDurableObject<T>(
  server: Harness["server"],
  fn: (instance: Harness["server"], state: { storage: WorldStore }) => T | Promise<T>,
): Promise<T> {
  return await fn(server, { storage: harness.store });
}

/** `runDurableObjectAlarm`. The alarm is an ordinary method now. */
async function runDurableObjectAlarm(server: Harness["server"]): Promise<boolean> {
  await server.alarm();
  return true;
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

/** workerd's `scheduler.wait`, which this no longer runs on. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How long a test waits for the world to say something before giving up. */
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

/**
 * The next message of a given kind, letting anything else go past first.
 *
 * The world talks on its own schedule — a tick lands, somebody else takes a
 * step, a body decays — so "the next message" and "the message my request
 * produced" are not the same thing. Waiting for the *kind* is what makes an
 * assertion about a reply an assertion about that reply, rather than a bet on
 * nothing else happening in between.
 */
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

/**
 * Join the world, and read the `hello` that says what is in it.
 *
 * No upgrade here: the 101 belongs to `server/index.ts` now, and what the world
 * is handed is an already-open socket and an id. The id still never comes from
 * the client — that check moved out with the upgrade, and is covered by
 * `server/accounts.test.ts`'s "is only ever owned by the account that made
 * it", which is the query `server/index.ts` looks a character up with.
 *
 * Seated as an administrator unless a test says otherwise, because most of this
 * file reaches for `/tile` and `/health` to build the scenario it is really
 * about — a fight, a pile, a respawn — and those are setup rather than the
 * thing under test. The tests that *are* about the gate pass `admin: false`.
 */
async function connect(actorId: string, { admin = true } = {}) {
  const pair = new Pair();
  const ws = pair.client();
  // The client half talks back through here. `server/index.ts` does the same
  // wiring off Elysia's `message` handler.
  pair.onClientMessage = (data) => {
    void stub().webSocketMessage(pair.server, data);
  };
  pair.onClientClose = () => {
    harness.hub.drop(pair.server);
    void stub().webSocketClose(pair.server);
  };
  const joined = stub().join(pair.server, actorId, { admin });
  const hello = await nextMessage(ws);
  await joined;
  return { ws, hello, pair };
}

/** Close a connection the way a browser going away does. */
async function disconnect(pair: Pair) {
  harness.hub.drop(pair.server);
  await stub().webSocketClose(pair.server);
}

/**
 * Drop the object's in-memory world without touching its storage or sockets,
 * which is what eviction does. White-box on purpose: this *is* the path under
 * test, and there is no public API that forces a Durable Object out of memory.
 */
async function simulateEviction() {
  harness.evict();
}

async function putCheckpoint(value: unknown) {
  await runInDurableObject(stub(), async (_instance, state) => {
    await state.storage.put("world", value);
  });
}

/** How often {@link waitForCheckpointedAt} looks again. */
const STORAGE_POLL_MS = 20;

/** The ground level of the board as it is written down, chunks reassembled. */
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

/**
 * Wait until the checkpointed board has somebody standing in a given cell.
 *
 * The board is flushed when the world goes quiet, which is soon but at no
 * particular moment — so a fixed sleep before reading storage is a bet a loaded
 * machine loses, and losing it leaves the test asserting against a world that
 * had not saved yet. Position is what tells one checkpoint from the next, since
 * a save re-seats everybody at the spawn point: waiting for a cell is waiting
 * for *that* flush rather than for whichever one happens to land first.
 */
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

/**
 * What the two actors this suite connects are called.
 *
 * Every player in the world has a name now — it is typed at character creation
 * and the world reads it off the character table when it seats somebody — so a
 * harness with none would be a world in a shape production never reaches. The
 * ids stay the ids: a name is what a label says, and nothing keys on it.
 * @see `server/characters.ts`
 */
const NAMES = { alice: "Alice", bob: "Bob" } as const;

beforeEach(async () => {
  // A fresh world per test, against a real database file in its own temporary
  // directory. Real rather than in-memory, for the reason this suite used to
  // run inside workerd: the load and restore paths are what it exists to cover,
  // and a store that cannot be closed and reopened cannot exercise them.
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
    // And what to call them. Sent once and never corrected — a name cannot
    // change — so a joiner missing it would be labelled `Nobody` until they
    // left this client's reach and came back. @see `../app/net/protocol`'s
    // `NamePatch`
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
      events: expect.arrayContaining([{ kind: "joined", actorId: "bob", playerCount: 2 }]),
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

    // Among the rest of the patch rather than alone in it: the player tile has
    // a disappear transition, so bob's body's way out travels beside his leaving.
    expect(await departure).toMatchObject({
      events: expect.arrayContaining([{ kind: "left", actorId: "bob", playerCount: 1 }]),
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

  it("closes an actor's older socket when they connect again", async () => {
    const first = await connect("alice");
    const second = await connect("alice");

    expect(first.ws.closeCode).toBe(CLOSE_REPLACED);
    expect(second.ws.closeCode).toBeNull();
  });

  /**
   * The replaced socket's close has not landed yet — the transport delivers it
   * later — and in that gap it must already count for nobody. Were it still
   * carrying the id, the new socket closing would find the actor "still
   * connected" through it and leave the body on the board with nobody driving.
   */
  it("takes the actor off the board when the newer socket closes before the replaced one's close lands", async () => {
    await connect("alice");
    const second = await connect("alice");

    second.ws.close();
    const { hello } = await connect("carol");

    expect(playerOwners(hello.map as FlatMapFile)).toEqual(["carol"]);
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
  it("keeps the body when the replaced socket's close lands late", async () => {
    const first = await connect("alice");
    await connect("alice");

    first.ws.close();
    // A third join reads the board back out.
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

  /**
   * Closing the tab is not a way out of a fight. The body stays, idle and
   * hittable, until a minute after its last blow, and only then goes the way
   * any other close would have taken it.
   */
  describe("leaving in the middle of a fight", () => {
    /** Long enough for a tick that was going to do something to have done it. */
    const SETTLE_MS = 300;
    /** More than anything on the mastery scale can survive. */
    const LETHAL_DAMAGE = 10_000;

    /** Hurt somebody through the command anybody can type — a real harm. */
    async function hurt(ws: TestSocket) {
      const flagged = messageWithin(ws, "statuses", MESSAGE_TIMEOUT_MS);
      send(ws, { type: "command", text: "/health -1" });
      expect(await flagged).not.toBeNull();
    }

    /**
     * Wind somebody's combat minute down to its last millisecond. Reaching in
     * rather than waiting a real minute: the countdown is `statuses.test.ts`'s.
     */
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

    /** Whether a patch saying this actor left arrives within the window. */
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
      // One body, and it is still in the fight it was left in.
      expect(playerOwners(back.hello.map as FlatMapFile)).toEqual(["alice"]);
      expect((back.hello.statuses as { defId: string }[]).map((s) => s.defId)).toContain(
        COMBAT_STATUS_ID,
      );

      // Theirs again, so the fight ending leaves them standing.
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
      // The premise: a row saying she is hurt, which the death has to replace.
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

    /**
     * An idle body cannot end a fight — a rat that cannot get through its
     * armour restarts the minute on every swing — so the cap is what
     * guarantees it goes.
     */
    it("lets the body go at the cap, even while the fight is still on", async () => {
      const alice = await connect("alice");
      const bob = await connect("bob");
      await hurt(alice.ws);
      await disconnect(alice.pair);

      const departure = departureWithin(bob.ws, "alice", MESSAGE_TIMEOUT_MS);
      // Past the cap, with the combat minute left exactly where it was.
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

    expect(minutesApart(hello.minutesOfDay as number, minutesOfDayAt(Date.now()))).toBeLessThan(
      CLOCK_TOLERANCE_MINUTES,
    );
  });

  /**
   * A client anchors its clock once and runs it forward, so a `/time` that only
   * moved the server would be seen by nobody until they reconnected. Both halves
   * are asked: somebody already standing there is told, and somebody arriving
   * after an eviction is handed the moved hour rather than the wall clock's.
   */
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
      height: 2,
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
    await harness.blobs.put("tiles.json", JSON.stringify(tilesWithDeer()), JSON_TYPE);
    await harness.blobs.put("map.json", JSON.stringify(mapWithDeer()), JSON_TYPE);
  });

  it("is in the world a joiner is handed, driving itself", async () => {
    const { hello } = await connect("alice");

    expect(deerCells(hello.map as FlatMapFile)).toEqual([DEER_CELL]);
    // An actor like any other, so its motion rides the existing protocol.
    expect(hello.actorIds).toEqual(expect.arrayContaining([expect.stringMatching(/^npc:/)]));
  });

  it("looks the same to everybody in the room", async () => {
    const alice = await connect("alice");
    const { hello } = await connect("bob");

    expect(deerCells(alice.hello.map as FlatMapFile)).toEqual(deerCells(hello.map as FlatMapFile));
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
    const stored = await harness.blobs.getText("map.json");
    const text = stored!;
    expect(text).not.toContain('"owner"');
  });

  /**
   * A save re-creates the world, not the people standing in it — and a name is
   * a person. This is the one seating path that does not go through
   * `seatActor`, so it is the one that can silently drop it: without the name,
   * an editor save leaves every player in the world labelled `Nobody` until
   * they reconnect, and the editor saves constantly.
   */
  it("keeps everybody's name across a save", async () => {
    const alice = await connect("alice");

    const fresh = nextMessage(alice.ws);
    await stub().replaceWorld(authoredMap());
    const hello = await fresh;

    expect(hello.names).toEqual([{ actorId: "alice", name: "Alice" }]);
  });

  /**
   * The deploy pipeline replaces the world on every merge to main, and that
   * must not march everyone back to spawn — `keepPositions` re-seats each
   * connected player where they stood.
   */
  it("keeps a connected player where they stood when asked to", async () => {
    const alice = await connect("alice");
    await walkEast(alice.ws);
    expect(await actorX("alice")).toBe(ONE_STEP_EAST);

    const fresh = nextMessageOfType(alice.ws, "hello");
    await stub().replaceWorld(authoredMap(), { keepPositions: true });
    await fresh;

    expect(await actorX("alice")).toBe(ONE_STEP_EAST);
  });

  /**
   * And the editor's save deliberately does not ask: an author saving a map
   * still restarts everyone on it at its spawn point.
   */
  it("restarts a connected player at spawn when nobody asks", async () => {
    const alice = await connect("alice");
    await walkEast(alice.ws);
    expect(await actorX("alice")).toBe(ONE_STEP_EAST);

    const fresh = nextMessageOfType(alice.ws, "hello");
    await stub().replaceWorld(authoredMap());
    await fresh;

    expect(await actorX("alice")).toBe(SPAWN_CELL);
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
    withSword.levels["0"]!["1,0"] = [{ tileId: "grass" }, { tileId: "rusty-sword" }];
    await harness.blobs.put("map.json", JSON.stringify(withSword), JSON_TYPE);

    const alice = await connect("alice");
    const bagId = kitOf(alice.hello).bag.id;

    send(alice.ws, { type: "pickUp", ref: { x: 1, y: 0, z: 0, stackIndex: 1 } });
    const armed = (await equipmentWithin(alice.ws))!;
    expect(contentsOf(armed).map((i) => i.tileId)).toEqual(["rusty-sword"]);

    // By kind rather than "whatever comes next": the pickup above emptied a
    // cell, so a patch describing it is already on its way and would otherwise
    // be caught here instead of the hello. Still subscribed before the save,
    // because the hello goes out *during* it.
    const fresh = nextMessageOfType(alice.ws, "hello");
    await stub().replaceWorld(withSword);
    const hello = await fresh;

    // The same bag, holding the same sword. Not a new one that happens to look
    // like it: a reset kit mints a fresh bag, so the id is what tells them apart.
    expect(kitOf(hello).bag.id).toBe(bagId);
    expect(contentsOf(hello).map((i) => i.tileId)).toEqual(["rusty-sword"]);
  });

  /**
   * The other message that crosses the line into a kit, and the one that works
   * with no bag at all: a sword goes into the hand rather than into a pocket.
   */
  it("arms a player from the floor when they ask to equip", async () => {
    const withSword = authoredMap();
    withSword.levels["0"]!["1,0"] = [{ tileId: "grass" }, { tileId: "rusty-sword" }];
    await harness.blobs.put("map.json", JSON.stringify(withSword), JSON_TYPE);

    const alice = await connect("alice");
    send(alice.ws, { type: "equip", ref: { x: 1, y: 0, z: 0, stackIndex: 1 } });
    const armed = (await equipmentWithin(alice.ws))!;

    const equipment = armed.equipment as { weapon: { tileId: string } | null };
    expect(equipment.weapon?.tileId).toBe("rusty-sword");
    // Into the hand and nowhere else — the bag is untouched.
    expect(contentsOf(armed)).toEqual([]);
  });

  /**
   * The other half of the same rule, and the reason this is not simply "keep
   * everything": the floor is the map's to decide. An authored sword comes back
   * when the map does, whoever happens to be holding one.
   */
  it("puts the authored floor items back regardless", async () => {
    const withSword = authoredMap();
    withSword.levels["0"]!["1,0"] = [{ tileId: "grass" }, { tileId: "rusty-sword" }];
    await harness.blobs.put("map.json", JSON.stringify(withSword), JSON_TYPE);

    const alice = await connect("alice");
    send(alice.ws, { type: "pickUp", ref: { x: 1, y: 0, z: 0, stackIndex: 1 } });
    await equipmentWithin(alice.ws);

    // By kind, for the reason above: the pickup's patch is in flight.
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

    // The save brings a catalogue in which the sword is scenery. A kit this
    // world no longer agrees with is dropped, exactly as a remembered one is.
    const asProps = (tilesJson as Array<Record<string, unknown>>).map((t) =>
      t.id === "rusty-sword" ? { ...t, kind: "prop" } : t,
    );
    await harness.blobs.put("tiles.json", JSON.stringify(asProps), JSON_TYPE);

    // By kind, for the reason above: the pickup's patch is in flight.
    const fresh = nextMessageOfType(alice.ws, "hello");
    await stub().replaceWorld(withSword);
    const hello = await fresh;

    // Carried over — same bag, so this is not the kit simply being reset...
    expect(kitOf(hello).bag.id).toBe(bagId);
    // ...and the sword is gone from it, because this world says it is scenery.
    expect(contentsOf(hello)).toEqual([]);
  });

  /**
   * The wipe is only observable where a rewrite cannot reach.
   *
   * This used to read `world` out of storage the moment the save returned and
   * expect nothing there — a race, and one a slow runner loses: `replaceWorld`
   * wakes the world, and the first flush writes the checkpoint record straight
   * back out along with every chunk the new board occupies. Asserting an
   * absence against keys the very next moment refills proves nothing about the
   * delete and everything about which of the two got there first.
   *
   * What no rewrite touches is a chunk of the *previous* world that the new one
   * never lands in — a corner of a map nobody authored, reassembled as part of
   * a world it does not belong to and sitting there until somebody edits that
   * exact chunk. So the world being replaced here reaches a chunk past the end
   * of the world replacing it, and what is asserted is the board a joiner is
   * handed once the object has been evicted and has had to resume from storage.
   */
  it("drops the previous world's checkpoint", async () => {
    const who = freshPlayer();
    const previous = checkpointWith([who]);
    const outlying = `${OUTLYING_CELL},0`;
    previous.map.levels["0"]![outlying] = [{ tileId: "water" }];
    await putCheckpoint(previous);

    // Checkpointed by the running world rather than planted key by key: the
    // outlying cell has to reach a storage key of its own by the route a real
    // world would take, or its survival says nothing about what a real one
    // leaves behind. Asserted rather than assumed — a previous world that never
    // reached storage is one this test proves nothing about.
    await connect(who);
    await waitForCheckpointedAt(who, `${AWAY_FROM_SPAWN},0`);
    expect(await storedKeys("chunk:")).toContain(OUTLYING_CHUNK_KEY);

    await stub().replaceWorld(authoredMap());
    // Waited for, not slept through, and it has to be waited for: the leftovers
    // are only reassembled into a world that has a checkpoint record to be
    // resumed from, and the save deletes the previous one. Evicting before the
    // new world is written down would pass because nothing had been saved yet
    // rather than because nothing was left behind.
    await waitForCheckpointedAt(who, `${SPAWN_CELL},0`);
    await simulateEviction();

    const { hello } = await connect(who);
    const ground = (hello.map as FlatMapFile).levels["0"] ?? {};
    expect(ground[outlying]).toBeUndefined();
    // And the authored world is there in its place, rather than the wipe having
    // left nothing to resume — an empty board would satisfy the line above too.
    expect(Object.keys(ground).length).toBe(AUTHORED_CELLS);
  });

  /**
   * Regression: the object chose its storage backend from `env` alone, and
   * under `bun dev` there is nothing in `env` to choose with — `data/` is
   * served from the Vite server's own origin. So the editor's save went to R2
   * while every loader kept reading disk: the save reported success, the
   * revalidation read the untouched file, and the edit vanished.
   */
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
    map: { version: MAP_FILE_VERSION, levels: { "0": ground, "1": upstairs } } as FlatMapFile,
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

/** Long enough for a tick to have happened if one was going to. */
const QUIET_MS = 200;

function say(ws: TestSocket, text: string) {
  ws.send(JSON.stringify({ type: "say", text }));
}

/** A slash line, on the frame the client sends one on rather than as speech. */
function command(ws: TestSocket, text: string) {
  ws.send(JSON.stringify({ type: "command", text }));
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
  return await harness.query("SELECT * FROM chat ORDER BY id");
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
    //
    // A loop rather than the recursive CTE this used to be: Turso does not
    // support `WITH RECURSIVE` yet. Nothing under test cares how the rows got
    // there, so the plainer statement says the same thing.
    for (let i = 0; i < CHAT_LOG_MAX_ROWS + 100; i++) {
      harness.store.sql.exec(
        "INSERT INTO chat (at, actor, x, y, z, text) VALUES (0, 'backfill', 0, 0, 0, 'old')",
      );
    }
    await harness.store.flush();

    const beforePrune = await chatRows();
    expect(beforePrune.length).toBeGreaterThan(CHAT_LOG_MAX_ROWS);

    // One more real message, which is what runs the prune.
    await wait(CHAT_MIN_INTERVAL_MS);
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

  /**
   * The bug this exists for: a client's actor set is its `hello` plus what it
   * is told afterwards, and a body summoned into a world somebody is already
   * looking at used to be told to nobody. Its tile arrived — that rides in the
   * cell patches — and everything keyed on the actor did not, so it had no name
   * over its head and no Talk row until a reload. A creature papered over it by
   * walking, since a `walkStarted` for an unknown id quietly adds one; a
   * shopkeeper that stands still never did.
   */
  it("tells the room about a body summoned into it", async () => {
    const alice = await connect("alice");

    command(alice.ws, "/tile deer +1");

    const spawned = await eventWithin(alice.ws, "spawned", 2000);
    expect(spawned).toMatchObject({ kind: "spawned" });
    // The owner scheme's own name for a body called into that cell, which is
    // the id every patch beside this one is keyed by.
    expect(spawned?.actorId).toBe("npc:1,0,0,1");
  });

  /**
   * The other half, and the reason the set starts as null rather than empty:
   * a world that has just been loaded has already named every actor in the
   * `hello` it sent, so announcing them again would be a message per rat on
   * every wake.
   */
  it("does not announce the actors a hello already named", async () => {
    const alice = await withCat();
    const seen = record(alice.ws);

    // Long enough for several ticks, and the cat is standing in the world for
    // all of them.
    await wait(QUIET_MS * 4);

    const spawns = seen
      .of("patch")
      .flatMap((message) => message.events as Record<string, unknown>[])
      .filter((event) => event.kind === "spawned");
    expect(spawns).toEqual([]);
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

function send(ws: TestSocket, message: unknown) {
  ws.send(JSON.stringify(message));
}

/** Wait for the kit the server sends its owner alone. */
function equipmentWithin(ws: TestSocket) {
  return messageWithin(ws, "equipment", 1000);
}

/** What is in the bag of whichever message carries a kit. */
function contentsOf(message: Record<string, unknown>): Array<{ tileId: string }> {
  const equipment = message.equipment as {
    bag: { contents?: Array<{ tileId: string }> } | null;
  };
  return equipment.bag?.contents ?? [];
}

function step(ws: TestSocket, seq: number, direction: string) {
  ws.send(JSON.stringify({ type: "step", seq, direction, preferDescend: false }));
}

/** Wait for a noise, which carries no speaker. @see ServerMessage `noise` */
function noiseWithin(ws: TestSocket, ms: number) {
  return messageWithin(ws, "noise", ms);
}

/** Wait for the first message of a type, or null if it never comes. */
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

/**
 * Keep every message a socket receives from now on.
 *
 * For the assertions no single-message helper can make: that things arrived in
 * a particular order, and — the harder one — that nothing arrived at all.
 */
function record(ws: TestSocket) {
  // From here, not from the beginning. Anything the world sent before this call
  // belongs to whatever the test was setting up, and the assertions below are
  // about what happens next — several of them are that *nothing* does.
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

/**
 * Wait for a patch carrying an event of this kind, and hand back that event.
 *
 * `matches` narrows it further, for a kind more than one thing raises at once:
 * a body with a transition authored on it announces its own way in, and a test
 * about the flame it conjured has to say which of the two it is waiting for.
 */
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

/** Wait for a patch carrying a `walkStarted`, and hand back that event. */
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

/** Where an actor's tile is in the running world, as an x. */
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
      facing = internals.session?.actorSnapshots().find((a) => a.id === "alice")?.direction;
    });
    expect(facing).toBe("n");
    expect(await actorX("alice")).toBe(0);
  });

  /**
   * A browser turns from a cell its steps have already reached, so the turn
   * lands on the server behind the step, not before it — and must outlast that
   * step landing. It used to be applied on arrival and then undone: the step
   * started after it and landed facing the way it walked, which is what put a
   * flame beside where the player was facing.
   */
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
    await new Promise((resolve) => setTimeout(resolve, WALK_DURATION_MS * 2 + 300));
    expect(await actorX("alice")).toBe(2);
  });

  it("goes back to sleep once the steps are walked", async () => {
    const { ws } = await connect("alice");
    step(ws, 0, "e");

    await new Promise((resolve) => setTimeout(resolve, WALK_DURATION_MS + QUIET_MS));
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
async function savedPosition(actorId: string): Promise<Record<string, unknown> | undefined> {
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

/**
 * What one prefix holds after a load, minus the row the joiner that triggered
 * it goes on to write for itself.
 *
 * The cap is enforced when the world loads and nowhere else, so somebody
 * arriving afterwards legitimately puts the store one row over it until the
 * next load. Their row lands on the first tick — `actorsSavedAt` starts at zero,
 * so the first flush is always due — which is a handful of milliseconds after
 * the `hello` these tests wait for. Counting it makes them a race against that
 * flush rather than a test of what the prune dropped, and a slow enough machine
 * loses: this is the whole of why the masteries case failed on CI and passed on
 * every laptop it was run on.
 */
async function keptAfterJoin(prefix: string, joined: string): Promise<string[]> {
  const keys = await storedKeys(prefix);
  return keys.filter((key) => key !== `${prefix}${joined}`);
}

/** What the object wrote down about one player's kit, if anything. */
async function savedEquipment(actorId: string): Promise<Record<string, unknown> | undefined> {
  let found: Record<string, unknown> | undefined;
  await runInDurableObject(stub(), async (_instance, state) => {
    found = await state.storage.get<Record<string, unknown>>(`equip:${actorId}`);
  });
  return found;
}

/** What the object wrote down about one player's masteries, if anything. */
async function savedMasteries(actorId: string): Promise<Record<string, number> | undefined> {
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
async function walkEast(ws: TestSocket) {
  step(ws, 0, "e");
  await walkWithin(ws, 1000);
  await new Promise((resolve) => setTimeout(resolve, WALK_DURATION_MS + 200));
}

/** Close a socket and let the object finish tidying up after it. */
async function leave(ws: TestSocket) {
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

  /**
   * The same bug from the player's side, which is where it is actually felt.
   *
   * Dropping the last thing you carry writes a floor holding it and used to
   * leave the kit row saying you still had it — so the reconnect handed the bag
   * back while the bag was lying there. One item, two owners, once per drop.
   */
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
    // Through storage rather than through this instance's memory of it, which
    // is the only path a player who left an idle world ever comes back down.
    await simulateEviction();

    const { hello } = await connect(who);

    expect((hello.equipment as { bag: unknown }).bag).toBeNull();
    // And still where they put it, rather than gone with the row that forgot it.
    const stack = (hello.map as FlatMapFile).levels["0"]?.[`${SPAWN_CELL},0`];
    expect(stack?.map((placed) => placed.tileId)).toContain(BAG_TILE_ID);
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
    const joined = freshPlayer();
    await connect(joined);

    const kept = await keptAfterJoin("pos:", joined);
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
    expect(saved).toBeDefined();
    expect((saved!.equipment as { bag: { id: string } }).bag.id).toBe(kitOf(hello).bag.id);
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
    const joined = freshPlayer();
    await connect(joined);

    const kept = await keptAfterJoin("tags:", joined);
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
        masteries: { sharp: "quite good", agility: -1 },
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
    expect(written?.sharp).not.toBeNaN();
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
    const joined = freshPlayer();
    await connect(joined);

    const kept = await keptAfterJoin("mast:", joined);
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
    rebuilt.levels["0"]![`${ONE_STEP_EAST},0`] = [{ tileId: "grass" }, { tileId: "stone-wall" }];
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
    map: { version: MAP_FILE_VERSION, levels } as FlatMapFile,
    spawn: { x: BOX_SPAWN, y: 0, z: 0, stackIndex: 1 },
  };
}

/** Every event of one kind that arrives in a window. */
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

/**
 * The plant a blow costs its thrower has to reach the one client that decides
 * its own footwork, or that client walks through a recovery the server is
 * holding it in and spends the fight being corrected. Nothing else on the wire
 * says a swing happened *to the swinger*: a lean is only owed by melee, and a
 * damage number names the body that took it.
 */
describe("announcing a swing", () => {
  /**
   * Long enough for the first blow of a fight to be thrown, plus the slack
   * every other window here carries.
   *
   * A fight opens with an approach — half the swinger's own interval standing
   * in reach of its target before anything goes out, see `app/game/combat`'s
   * `SWING_WINDUP_SHARE` — so a window sized to a few quiet ticks now expires
   * just before the swing it is listening for. Read off the authored player
   * rather than written down, so re-authoring bare hands moves this with it.
   */
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
    // Two bodies arriving at one spawn stand on each other's shoulders, and a
    // storey is outside melee's lid — so somebody has to step off before there
    // is a fight to announce at all. @see `app/game/distance`
    await walkEast(alice.ws);

    // Both switches on, because two players do not swing at each other until
    // both have asked to. @see `app/game/pvp`
    alice.ws.send(JSON.stringify({ type: "pvp", enabled: true }));
    bob.ws.send(JSON.stringify({ type: "pvp", enabled: true }));

    // Listening before the fight starts, so the first blow is not missed.
    const swings = eventsWithin(alice.ws, "swung", FIRST_BLOW_MS);
    alice.ws.send(JSON.stringify({ type: "target", actorId: "bob" }));
    alice.ws.send(JSON.stringify({ type: "attackMode", enabled: true }));

    // Loudly rather than flakily: a fight out of reach announces nothing, which
    // would be a broken fixture rather than the bug under test.
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
  return { version: MAP_FILE_VERSION, levels } as FlatMapFile;
}

/** The authored map as it currently sits in the bucket. */
async function storedMap(): Promise<FlatMapFile> {
  const stored = await harness.blobs.getText("map.json");
  return JSON.parse(stored!) as FlatMapFile;
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
      await expect(instance.replaceWorld(markerlessMap())).rejects.toThrow(/player/);
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
    // A world of its own, and that is not tidiness. This test has to leave
    // storage holding a map that cannot start, and touching the one the rest of
    // the case is using would load that broken map and take the run down with
    // it. A fresh world has no checkpoint and no session, which is the wedged
    // state exactly: the only copy of it is one that cannot be started.
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

  /**
   * The regression the flush exists for. Without it the crunch is recorded
   * between ticks and wiped by the next `tick` before anything drains it, so
   * this waits for a sound that never comes.
   */
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

  /**
   * The point of the channel, asserted where a client would actually see it: a
   * crunch must not arrive as something somebody *said*, because that is what
   * puts a name in front of it.
   */
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
  /** The identity adoption mints at the gnome's authored spot. */
  const GNOME_OWNER = `npc:${GNOME_X},0,0,1`;
  /** Immediate, so the test waits on the machinery rather than the window. */
  const RESPAWN_WINDOW_MS = 1;

  /** A mindless body that comes back — no brain, so the world can settle. */
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

  /**
   * The half of respawn that has to tell a thing changing from a thing leaving.
   *
   * A berry goes off where it stands: the placement keeps its `itemId` and
   * takes a new tile id (see `app/game/decay.ts`). A point that watched the
   * *tile* would read its cell as empty at that moment and grow a second berry
   * beside the stale one, which is the bug these cases pin shut. The rule they
   * describe between them: a point is owed the moment the thing it grew leaves
   * the cell, and nothing that arrives afterwards can pay that debt.
   */
  describe("an item that decays where it stands", () => {
    const BERRY_X = 1;
    const BERRY_REF = { x: BERRY_X, y: 0, z: 0, stackIndex: 1 };
    /** Long enough to pick a berry up before it turns, short enough to wait on. */
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

    /** The live board's stack at the berry's cell, tile ids in order. */
    async function berryCell() {
      return await runInDurableObject(stub(), (instance: GameServer) => {
        const session = (instance as unknown as { session: { getMap(): MapFile } }).session;
        return getStack(session.getMap(), BERRY_X, 0, 0).map((p) => p.tileId);
      });
    }

    /** Long enough for the decay to fire and any respawn to follow it. */
    async function settle() {
      await new Promise((resolve) => setTimeout(resolve, DECAY_MS * 3));
    }

    /**
     * Long enough for the tick loop to diff the board.
     *
     * Spawn points are swept against the cells a tick *changed*, so two edits
     * to one cell inside a single tick cancel out and the world never sees the
     * moment between them. That is the existing bargain the whole registry runs
     * on, and it costs nothing in play — nobody picks a berry up and puts it
     * back inside 30ms — but a test does exactly that unless it waits.
     */
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

      // A berry, not the one that was taken: what grew is fresh, and has had
      // time to go off again on the same short clock the first one ran on.
      expect(await berryCell()).toEqual(["grass", "test-stale-berry"]);
    });

    /**
     * **Putting it back does not talk the world out of it.** The dropped berry
     * carries the id it left with, so a point that re-adopted what it found in
     * its cell would settle the debt and the bush would stay bare. The point
     * forgot that berry the moment it was taken, and owes one regardless.
     */
    it("still grows one back when the same berry is dropped where it was found", async () => {
      const alice = await connect("alice");

      send(alice.ws, { type: "pickUp", ref: BERRY_REF });
      await equipmentWithin(alice.ws);
      await tickPasses();

      // Out of the bag rather than the bag itself, so what lands is the very
      // berry that was taken — same identity, same cell.
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
    // Seeded from the authored `player` tile again, which is what somebody the
    // world has never met looks like.
    expect(hello.masteryXp).not.toEqual(EARNED);
    // What the row *says*, rather than whether there is one — and the absence
    // was a race rather than a stricter assertion. A reset wakes the tick loop,
    // every tick asks the player for their stats, and the first thing that asks
    // is what seeds a fresh player's experience from their tile
    // (`GameSession`'s `battlerOf`). The flush that follows writes a `mast:` row
    // holding exactly what the tile says — so this passed only while no tick had
    // landed yet, which on a slow enough machine is never true. Undefined passes
    // too: no row is also not what they had learnt.
    expect(await savedMasteries(who)).not.toEqual(EARNED);
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
   * makes a seeded map invisible: `bun run seed` can replace every byte of the
   * authored world and the object goes on serving the one it has.
   */
  it("starts the board again from the authored map", async () => {
    await connect("alice");
    await putCheckpoint(checkpointWith(["alice"]));
    await simulateEviction();

    const resumed = await connect("alice");
    expect(playerCells(resumed.hello.map as FlatMapFile)).toEqual([AWAY_FROM_SPAWN]);

    await stub().resetWorld();

    const { hello } = await connect("alice");
    // Back at the authored spawn, on a board the authored file describes.
    expect(playerCells(hello.map as FlatMapFile)).toEqual([0]);
    // The authored strip, not the four cells the checkpoint happened to share
    // with it: a board resumed from storage would still be missing the marker.
    expect(Object.keys((hello.map as FlatMapFile).levels["0"] ?? {})).toHaveLength(AUTHORED_CELLS);
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
    const tables = await harness.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat'",
    );
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
      height: 2,
      type: "simple",
      kind: "battler",
      attributes: {},
      actor: true,
      walkable: false,
      // Armed, because the row this creature must *not* write is the one an
      // empty kit would never have written anyway.
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
   * The same bill, one row along. A creature rolls its kit as it is adopted out
   * of the board, so a stored one is a copy the next wake overwrites before
   * anybody could read it — and unlike the deer this gate was written for, an
   * armed creature has a kit worth writing if nothing stops it.
   *
   * The resident test is now the whole of what stops it: the emptiness test
   * beside it has gone, so the cheapness this asserts has to hold on its own.
   * See the retraction below for why it had to go.
   */
  it("never writes down what a creature is carrying", async () => {
    const alice = await connect("alice");
    await walkEast(alice.ws);
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    const kits = await storedKeys("equip:");
    expect(kits).toContain("equip:alice");
    expect(kits).not.toContain(`equip:${GNOME_OWNER}`);
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
   * Statuses are the one row that is *meant* to be rewritten, and the one that
   * has to be retractable.
   *
   * A countdown genuinely moves every tick, so a fed player pays a row per flush
   * for as long as it runs — bounded, and the honest price of not losing the
   * remainder to a crash. What must not happen is the row outliving the status:
   * skipping the write when the list goes empty leaves the last remainder on
   * disk, and the next reconnect restores a status that had already run out.
   *
   * That is exactly what a `length > 0` guard does, and it is what this branch
   * shipped with until a rebase put it next to the skipping above.
   */
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

    // Run the status out from under them, then flush again. Reaching in rather
    // than waiting ten real seconds: what is under test is the *write*, and the
    // countdown itself has its own tests in `app/game/statuses.test.ts`.
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
    // Overwritten with nothing, rather than left saying what it used to.
    expect(after?.statuses).toEqual([]);
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
   * The kit is the other row that has to be retractable, and for a sharper
   * reason than a status: the board is written in the same batch.
   *
   * Dropping the last thing you are carrying puts it on the floor, and the
   * checkpointed chunks in that same `put` say so. A kit row skipped because it
   * is now empty is therefore not merely stale — it is a second copy of the very
   * item the board beside it has already handed back to the world. Reconnect and
   * the bag is on your back *and* at your feet.
   *
   * That is exactly what a "only a kit with something in it" guard does, which
   * is what stood here.
   */
  it("retracts a kit row once the last thing in it has been dropped", async () => {
    const who = freshPlayer();
    const { ws } = await connect(who);
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    // The starting bag, written by the settle above: what the drop has to undo.
    const before = await savedEquipment(who);
    expect((before?.equipment as { bag: unknown } | undefined)?.bag).not.toBeNull();

    // Their own cell, which is always in range and always has room for one more.
    send(ws, {
      type: "drop",
      from: { kind: "bag" },
      to: { x: SPAWN_CELL, y: 0, z: 0 },
    });
    // The kit patch is the acknowledgement that the drop was handled; asserting
    // on storage before it would be asserting on a race.
    const patch = await equipmentWithin(ws);
    expect(patch).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    const after = await savedEquipment(who);
    const kit = after?.equipment as {
      weapon: unknown;
      offhand: unknown;
      bag: unknown;
    };
    // Overwritten with nothing, rather than left saying what it used to — the
    // bag is on the floor in the same batch, and both cannot be true.
    expect(kit.weapon).toBeNull();
    expect(kit.offhand).toBeNull();
    expect(kit.bag).toBeNull();
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
    checkpoint.map.levels["0"]![cell] = [...checkpoint.map.levels["0"]![cell]!, { tileId: SWORD }];
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

  it("survives dying with a step still queued", async () => {
    // **This crashed the production server the first evening it was up.**
    // Somebody walked into a fire: the step that killed them was applied, and
    // the one queued behind it was applied on the same tick — after the death
    // had already taken their body out of the session. `applyQueuedSteps` asked
    // for an actor that was no longer there and threw, and a throw inside the
    // tick ends the process, so one death took the whole world down.
    //
    // `noteDeaths` does clear the queue. It runs *after* `applyQueuedSteps` in
    // the tick, which is exactly why clearing it there was never enough.
    const alice = await connect("alice");

    step(alice.ws, 1, "e");
    step(alice.ws, 2, "e");

    // **Wait until the steps are actually queued.** They travel over the socket
    // and are queued on arrival, so killing immediately after sending races the
    // very thing under test — and wins, quietly, leaving a test that passes
    // against the bug it was written for.
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

    // Killed with those steps still waiting to be applied.
    await killAndTick("alice");

    // The world is still ticking, and still talking to everybody else.
    const bob = await connect("bob");
    expect(bob.hello.type).toBe("hello");

    await runInDurableObject(stub(), (instance: GameServer) => {
      const internals = instance as unknown as {
        queuedIntents: Map<string, unknown[]>;
      };
      // Dropped rather than left to rot: a step addresses a body, and there is
      // no body to move.
      expect(internals.queuedIntents.has("alice")).toBe(false);
    });
  });

  it("keeps ticking when a tick throws", async () => {
    // The structural half of the same bug. A Durable Object's platform caught
    // an exception in its timer and cost that tick; `setInterval` here ends the
    // process instead, so *any* fault in the simulation became an outage for
    // everybody rather than a skipped frame for one person.
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

      // Would have taken the process with it before.
      expect(() => internals.tickSafely()).not.toThrow();
      expect(internals.consecutiveTickFailures).toBe(1);

      internals.tick = good;
      internals.tickSafely();
      // And it recovers rather than staying broken.
      expect(internals.consecutiveTickFailures).toBe(0);
    });

    // Still a live world afterwards.
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
      // The loop is driven by hand below, on a clock this test owns: each tick
      // takes as long as `durations` says, and the heartbeat comes once a
      // millisecond whenever no tick is running.
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
      /** Started at `at`, or at most the one heartbeat after it. */
      const startedAt = (tick: number, at: number) => {
        expect(starts[tick]!).toBeGreaterThanOrEqual(at);
        expect(starts[tick]!).toBeLessThanOrEqual(at + 1);
      };
      startedAt(0, T);
      startedAt(1, 2 * T);
      // The second tick ran 50ms, so the third was due before it ended: it
      // starts as soon as it can, and the fourth is back on time rather than a
      // whole tick after the third.
      expect(starts[2]).toBe(starts[1]! + 50);
      startedAt(3, 4 * T);
      startedAt(4, 5 * T);
      startedAt(5, 6 * T);
      // Five hundred milliseconds is more than a backlog worth running back to
      // back: the tick after it starts as soon as it ends, and the timeline
      // starts again from there.
      expect(starts[6]).toBe(starts[5]! + 500);
      startedAt(7, starts[6]! + T);
    });
  });

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
    //
    // By kind rather than by position: a world patch from an unrelated tick can
    // and does arrive between the request and its answer, and taking whatever
    // came next made this fail in CI as "expected 'patch' to be 'equipment'".
    await nextMessageOfType(alice.ws, "equipment");
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
    // A bag, because a respawn hands one back — but a new one, holding none of
    // what fell on the floor.
    const bag = equipment?.equipment.bag as { contents?: unknown[] } | null;
    expect(bag?.contents ?? []).toEqual([]);
  });

  /**
   * The other half of what a death's batch owes: a kit that changed since the
   * last flush and belongs to somebody still alive.
   *
   * The board in that batch is every chunk that moved since the last one, so
   * it can be the board saying a sword is off the floor because somebody else
   * picked it up. Their kit has to go in the same write, or a crash between
   * the two loses the sword to both — which is why the batch wrote every row
   * of every actor, until it learnt to write only the rows that can disagree
   * with the board.
   */
  it("writes a bystander's changed kit in the batch that drops a body", async () => {
    await putCheckpoint(checkpointWithSword());
    const alice = await connect("alice");
    await connect("bob");
    // Everybody written as they stand, so the sword below is the one change to
    // alice that storage has not been told about.
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

    // The batches the tick that kills bob writes, as they are handed to
    // storage. Asked of the batch rather than of storage afterwards, because a
    // world that goes quiet writes everybody down anyway and would answer for
    // a death that left her out.
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
    // She died two cells from the door, so "back at spawn" and "left where the
    // flush found her" are different answers.
    expect(await actorX("alice")).toBe(AWAY_FROM_SPAWN);

    await killAndTick("alice");

    const { position } = await storedRows("alice");
    expect(position?.x).toBe(SPAWN_CELL);
  });

  /**
   * A world in progress with a respawn point under alice's feet — the authored
   * tile that carries `setSpawn` (see `data/tiles.json`), which is pressed from
   * on top of it. She is standing away from the spawn cell, so "the mark moved"
   * and "nothing happened" are different answers.
   *
   * Under the body rather than beside it, because the marker is flat: it is a
   * plate you stand on, and a slot below a body is still reachable — a body is
   * not a lid.
   */
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
  /** The marker's slot: under alice, above the grass she is standing on. */
  const MARKER_REF = { x: AWAY_FROM_SPAWN, y: 0, z: 0, stackIndex: 1 };

  /** Press the marker alice is standing on, and wait for its sentence. */
  async function anchorHere(ws: TestSocket) {
    send(ws, { type: "interact", ref: MARKER_REF });
    // The notice is the acknowledgement that the press was handled; asserting
    // on storage before it would be asserting on a race.
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
    // The authored marker, before anything moves it: a joiner has to know this
    // or it offers a live row on the very cell it is anchored to.
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
    // The cache and the row move together — a write that reached only storage
    // would leave this instance putting her back at SPAWN_CELL for the rest of
    // the world's life. @see GameServer.flushSpawnMarks
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
    expect(equipment.bag?.tileId).toBe(BAG_TILE_ID);
    expect(equipment.bag?.contents).toEqual([]);
  });

  /**
   * Hurt somebody, put something on them, and make both facts durable — the
   * state a death has to undo rather than inherit.
   *
   * White-box on the same terms {@link killAndTick} is, and the forced flush is
   * the load-bearing part: the periodic one is thirty seconds away, and what is
   * under test is what a death does to rows a *previous* flush already wrote.
   */
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
      // Every five seconds, so nothing it does can land inside a test — what is
      // wanted here is a condition that is *running*, not one that is ticking.
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
    // The premise: storage holds a hurt, poisoned body. Without this the test
    // passes on a world that never wrote either row.
    const before = await storedBody("alice");
    expect(before.hp?.hp).toBeGreaterThan(0);
    // The hurt put them in combat as well, which is not what this is about.
    expect(before.statuses?.statuses.map((s) => s.defId)).toContain("poison");

    await killAndTick("alice");

    const after = await storedBody("alice");
    // Null rather than absent, because a delete cannot ride in the batch that
    // drops the body — and it reads as "ask the tile" either way.
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

  it("tells the dying player they died, after the patch that emptied them", async () => {
    const alice = await armedAlice();
    const seen = record(alice.ws);

    await killAndTick("alice");

    const types = seen.types();
    expect(types).toContain("died");
    // The order is the contract, not an accident of the tick: the patch showing
    // the body gone and the kit on the floor is the last frame they are left
    // looking at, so it has to have gone out first.
    expect(types.indexOf("patch")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("patch")).toBeLessThan(types.indexOf("died"));
  });

  it("hands the emptied kit over on the death itself", async () => {
    const alice = await armedAlice();
    const seen = record(alice.ws);

    await killAndTick("alice");

    const died = seen.of("died")[0]!;
    const equipment = died.equipment as Record<string, unknown>;
    // Everything is on the floor, so there is nothing left in hand. This cannot
    // arrive as an `equipment` message: that one is read off a live runtime, and
    // the death is what deletes it.
    expect(equipment.weapon).toBeNull();
    expect(equipment.offhand).toBeNull();
    expect(equipment.bag).toBeNull();
  });

  it("stops talking to a dead socket, while the world goes on for everyone else", async () => {
    const alice = await armedAlice();
    const bob = await connect("bob");
    await killAndTick("alice");
    // Past the death and its patch, so what follows is only the world moving on
    // without her.
    const afterDeath = record(alice.ws);
    const bobSees = record(bob.ws);

    step(bob.ws, 1, "e");
    const bobsWalk = await walkWithin(bob.ws, 1000);

    // Bob's own step reaches Bob, which is what makes the silence a rule about
    // the dead rather than a world that stopped ticking.
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
    // At the door rather than where she fell — the same answer a reload gives.
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

    // A `hello` here would throw away every step this client had predicted, for
    // a player who never lost their body in the first place.
    expect(await messageWithin(alice.ws, "hello", 500)).toBeNull();
    expect(await actorX("alice")).toBe(AWAY_FROM_SPAWN);
  });

  it("keeps a dead socket silent across an eviction", async () => {
    const alice = await armedAlice();
    const bob = await connect("bob");
    await killAndTick("alice");
    await simulateEviction();
    // The wake reloads the world and re-seats everybody whose socket survived;
    // alice is in the checkpointed dead, so she gets neither a body nor a word.
    const afterWake = record(alice.ws);

    step(bob.ws, 1, "e");
    expect(await walkWithin(bob.ws, 1000)).not.toBeNull();

    expect(await actorX("alice")).toBeNull();
    expect(afterWake.types()).toEqual([]);
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
    await harness.blobs.put("map.json", JSON.stringify(mapWithBerry()), JSON_TYPE);
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
    await harness.blobs.put("map.json", JSON.stringify(mapWithBerry()), JSON_TYPE);
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
    await harness.blobs.put("map.json", JSON.stringify(mapWithBerry()), JSON_TYPE);
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

/**
 * Commands, which are the one thing a socket can send that changes somebody
 * *else's* body.
 *
 * The grammar and the rules are tested in `app/game/commands.test.ts`, on the
 * node pool, where they belong. What only this pool can answer is whether the
 * wire carries any of it: a command arrives on its own frame, and its entire
 * output is two addressed messages that the session queues and the server has to
 * remember to flush. A parser that is perfect and wired to nothing is the more
 * likely failure, and here it would be completely silent.
 */
describe("commands", () => {
  it("answers with what changed and what it now reads", async () => {
    const who = freshPlayer();
    const { ws } = await connect(who);

    send(ws, { type: "command", text: "/mastery sharp 10" });

    // Both halves, because either alone is a half-finished feature: the sentence
    // is what the player reads, and the block is what the panel draws.
    const notice = await nextMessageOfType(ws, "notice");
    expect(notice.text).toBe("Your sharp mastery is now 10");
    const masteries = await nextMessageOfType(ws, "masteries");
    expect((masteries.masteryXp as Record<string, number>).sharp).toBe(xpForLevel(10));
  });

  it("says why, rather than nothing, when the line was not a command", async () => {
    const who = freshPlayer();
    const { ws } = await connect(who);

    send(ws, { type: "command", text: "/mastery blad 10" });

    // The refusal has to make the round trip. A command that is dropped in
    // silence is indistinguishable from a socket that never delivered it.
    const notice = await nextMessageOfType(ws, "notice");
    expect(notice.text).toContain("blad");
  });

  it("never becomes a bubble in the room", async () => {
    const who = freshPlayer();
    const { ws } = await connect(who);
    const onlooker = await connect(freshPlayer());

    send(ws, { type: "command", text: "/mastery sharp 10" });
    await nextMessageOfType(ws, "notice");

    // The client sorts commands out of speech before they are sent, so this is
    // belt and braces on the wire's side of that rule — a private line read out
    // to the room is the failure nobody would notice until it happened.
    expect(await chatWithin(onlooker.ws, QUIET_MS)).toBeNull();
  });

  /**
   * The gate, from the only side that can test it.
   *
   * A fabricated `command` frame is the shortest path there has ever been to a
   * mastery nobody fought for, and the account it needs is a fact about the
   * socket — so this is the pool that can answer it and `app/game` is not. What
   * is checked is both halves of a refusal: the body is untouched, *and* the
   * player is told why. Either alone is the bug the other hides.
   */
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

      // Read off the store rather than off the wire, because "no `masteries`
      // message arrived" is also what a dropped frame looks like. The row is
      // what a reconnect would restore, and it is the thing that must not have
      // moved.
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

      // Health is written down only when a body is short of full — see "writes
      // no health down for a body that is not hurt" above — so the absence of
      // the row is the assertion that nothing reached them.
      let stored: unknown;
      await runInDurableObject(stub(), async (_instance, state) => {
        stored = await state.storage.get(`hp:${victim}`);
      });
      expect(stored).toBeUndefined();
    });

    it("still refuses a line that would not have parsed", async () => {
      const { ws } = await connect(freshPlayer(), { admin: false });

      send(ws, { type: "command", text: "/masteyr sharp" });

      // One answer for every line, because the gate runs before the grammar
      // does. Telling somebody there is no `/masteyr` command would be coaching
      // them towards a door that is locked either way.
      const notice = await nextMessageOfType(ws, "notice");
      expect(notice.text).toBe("Only an administrator can run commands");
    });

    it("says nothing out loud either", async () => {
      const { ws } = await connect(freshPlayer(), { admin: false });
      const onlooker = await connect(freshPlayer());

      send(ws, { type: "command", text: "/mastery sharp 100" });
      await nextMessageOfType(ws, "notice");

      // A refusal is still a notice, not a bubble. The room has no business
      // hearing what somebody tried.
      expect(await chatWithin(onlooker.ws, QUIET_MS)).toBeNull();
    });
  });
});

/**
 * Casting, on the wire.
 *
 * The rules are pinned in `app/game/casting.test.ts` and
 * `app/game/sessionCasting.test.ts`, on the node pool, where they belong. What
 * only this pool can answer is the two claims that are about the socket and the
 * store: that a `cast` frame reaches the session at all and comes back as the
 * kit it changed, and that the cooldown it started is still running when
 * somebody reconnects to a world that has been evicted in the meantime.
 *
 * That second one is the whole reason cooldowns are durable. A cooldown rebuilt
 * on load would make reconnecting the cheapest spell in the game, and it is
 * exactly the kind of thing that is correct in the simulation and lost on the
 * way to storage.
 */
describe("casting", () => {
  const STONE_TILE_ID = "test-arcane-stone";
  const STONE_COOLDOWN_MS = 60_000;

  const BOLT_TILE_ID = "test-arcane-bolt";
  const BOLT_DAMAGE = 30;

  /** A charm stone that mends, which is the shipped necklace's shape. */
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

  /**
   * A hand stone that harms whatever it is pointed at, and throws something on
   * the way.
   *
   * Reach far enough that where the two bodies happen to spawn cannot decide
   * the case: what is being tested is the wire, not the geometry.
   */
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

  /** The shipped catalogue, with the player born wearing one. */
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

  /** The cooldown on whatever is worn on the charm, as a kit message says. */
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
    // Nothing cast yet, so nothing cooling — the state the button draws as lit.
    expect(charmCooldown(hello)).toBeUndefined();

    send(ws, { type: "cast", slot: { from: "square", square: "charm" } });
    const kit = await equipmentWithin(ws);
    expect(kit).not.toBeNull();
    expect(charmCooldown(kit!)).toBe(STONE_COOLDOWN_MS);
  });

  /**
   * **A bolt fired and nobody saw it**, which is what this exists to stop
   * happening twice.
   *
   * A cast is a *message*, and `GameSession.tick` empties every page at its top
   * — so the flight and the receipt a cast records between two ticks were both
   * cleared before the tick's own collection ever ran. Everything downstream was
   * correct and nothing arrived: the damage landed, the cooldown started, the
   * kit came back, and the mote was never in the air on anybody's screen.
   *
   * A swing never had this problem, because a swing happens inside the tick.
   * That is exactly why no test caught it — the session suite drains straight
   * after casting, with no tick in between, and sees the flight it just made.
   * This one goes the whole way to a socket.
   */
  it("puts a cast's flight and its receipt on the wire", async () => {
    const victimId = freshPlayer();
    const thrower = await connect(freshPlayer());
    const victim = await connect(victimId);

    // Both switches on: a bolt that takes health is refused at a player who is
    // not in the fighting, and so is one thrown by a caster who is not.
    // @see `app/game/pvp`
    send(thrower.ws, { type: "pvp", enabled: true });
    send(victim.ws, { type: "pvp", enabled: true });

    const shots = eventsWithin(thrower.ws, "projectileFired", 400);
    const hits = eventsWithin(thrower.ws, "damage", 400);

    send(thrower.ws, { type: "target", actorId: victimId });
    send(thrower.ws, { type: "cast", slot: { from: "square", square: "weapon" } });

    expect((await shots).map((shot) => shot.tileId)).toContain("arrow");
    expect(await hits).not.toHaveLength(0);
  });

  /**
   * Story 36. Reconnecting must not be a way to reset a cooldown, which means
   * the number has to survive both the socket closing and the world itself
   * ceasing to exist.
   */
  it("brings the cooldown back after the world has been evicted", async () => {
    const who = freshPlayer();
    const first = await connect(who);
    send(first.ws, { type: "cast", slot: { from: "square", square: "charm" } });
    await equipmentWithin(first.ws);
    await leave(first.ws);

    await simulateEviction();

    const { hello } = await connect(who);
    // Still cooling, and by roughly what was left: a world that rebuilt the kit
    // from the tile would hand back a stone that had never been cast.
    expect(charmCooldown(hello)).toBeGreaterThan(0);
  });
});

/**
 * Authored content reaching the world it describes.
 *
 * A tile save used to write the catalogue and stop there — the world reads it
 * once, at load, so an edit changed what the *next* world would be built from
 * and nothing about the one the author was standing in. It was invisible until
 * a number a player watches changed: an arcane stone's cooldown is the first,
 * and the server went on spending the old one while the reloaded browser drew
 * the bar against the new one.
 *
 * What these pin is the pair of claims the fix rests on: an edit takes effect
 * on the running world, and taking effect costs nobody anything they were
 * carrying. The second is the one worth guarding — the reload is an eviction,
 * and an eviction that emptied everybody's pockets would be a far worse bug
 * than the one being fixed.
 */
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

  /** The shipped catalogue, with the player born wearing a stone of this length. */
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

  /** Save a catalogue the way the tile editor does, and let the world hear it. */
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

  /**
   * The bug, in one assertion. Before the fix the world went on spending the
   * two-minute cooldown it loaded with, whatever the file said afterwards.
   */
  it("casts on the cooldown the editor last saved", async () => {
    const { ws } = await connect(freshPlayer());
    await saveTiles(SHORT_MS);
    // The reload hands every open socket a fresh `hello`; the cast goes after it.
    await messageWithin(ws, "hello", 2000);

    send(ws, { type: "cast", slot: { from: "square", square: "charm" } });
    const kit = await equipmentWithin(ws);
    expect(charm(kit!)?.cooldownMs).toBe(SHORT_MS);
  });

  /**
   * And a cooldown already running is clamped rather than left to outlive the
   * stone it belongs to — the same rule a kit coming back from storage is under,
   * which is what a reload makes this be.
   */
  it("clamps a running cooldown to the shortened stone", async () => {
    const { ws } = await connect(freshPlayer());
    send(ws, { type: "cast", slot: { from: "square", square: "charm" } });
    expect(charm((await equipmentWithin(ws))!)?.cooldownMs).toBe(LONG_MS);

    await saveTiles(SHORT_MS);
    const hello = await messageWithin(ws, "hello", 2000);
    expect(charm(hello!)?.cooldownMs).toBeLessThanOrEqual(SHORT_MS);
  });

  /**
   * The reload is an eviction, so everything an eviction is careful about has to
   * still hold. A save that emptied a player's pockets — and the editor saves
   * constantly — would be a far worse bug than the staleness it fixes.
   */
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

  /** And standing where they stood, on the body they already had. */
  it("leaves one body per player, where it was", async () => {
    const who = freshPlayer();
    const { ws } = await connect(who);

    await saveTiles(SHORT_MS);
    const after = await messageWithin(ws, "hello", 2000);

    expect(playerOwners(after!.map as FlatMapFile)).toEqual([who]);
  });

  /**
   * A world nobody has opened needs no telling: the next load reads the files
   * that were just written, which is the whole of what a reload does.
   */
  it("does nothing at all to a world that is not running", async () => {
    await expect(stub().reloadContent()).resolves.toBeUndefined();
  });
});

/**
 * A tile that forms is announced by the server, on the flush that follows the
 * cast rather than on the next tick's.
 *
 * A conjure lands on input, not on a tick, so the only thing that gets its
 * `tileTransition` out promptly is `flushBlows` running after the message is
 * handled. Driven end to end over the socket, with the shipped
 * `arcane-flame`, which has a way in authored: a stone underfoot is picked up,
 * held, and cast.
 */
describe("tile transitions", () => {
  const STONE = "arcane-stone-of-flame";

  /**
   * The shipped stone with its cast time taken off.
   *
   * What this case is about is the *flush* — a conjure that lands on the input
   * rather than on a tick has to be announced in the same breath — and Flame is
   * authored to take three seconds, which lands it on a tick like everything
   * else. So the stone is made instant here, which is exactly what it becomes in
   * the hands of any caster who has outgrown it.
   */
  function tilesWithInstantStone() {
    return (tilesJson as Array<Record<string, unknown>>).map((def) => {
      if (def.id !== STONE) return def;
      const interactions = def.interactions as Record<string, unknown>;
      const item = interactions.item as Record<string, unknown>;
      const { castTimeMs: _takenOff, ...instant } = item;
      return { ...def, interactions: { ...interactions, item: instant } };
    });
  }

  /** Alice facing south over grass, with a flame stone at her feet. */
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

    // Flame is an elemental stone and no longer something a new player can
    // press — the neutral ladder is what a seeded body starts on, and the
    // elemental rungs ask five more Arcane than that. This test is about the
    // conjure's announcement rather than about the gate, so it buys its way
    // past the gate the way the console does.
    send(alice.ws, { type: "command", text: "/mastery arcane 10" });
    await nextMessageOfType(alice.ws, "masteries");

    send(alice.ws, { type: "cast", slot: { from: "square", square: "offhand" } });
    // The flame's, not the caster's own: the real player tile has a way in too.
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

  /** The real tile set, with the player given the sides named. */
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
    // Listening before the close, which is what raises it.
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
  /** The strip of grass, with a bush east of spawn. */
  function mapWithBush(): FlatMapFile {
    const map = authoredMap();
    map.levels["0"]!["1,0"] = [{ tileId: "grass" }, { tileId: "bush" }];
    return map;
  }

  const BUSH_REF = { x: 1, y: 0, z: 0, stackIndex: 1 };

  /** The next patch entry about this body's pull, or null if none comes. */
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
    // The key is the owner's alone, and only travels on their own channel.
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

  /** Long enough to take a message each end of, short enough to wait out. */
  const CAST_MS = 2_000;

  /**
   * The shipped player, born holding a stone that takes time.
   *
   * The cast time is written on here rather than read off the shipped stone, on
   * the terms every other tile override in this file is: what these two cases
   * are about is the two messages, and a case that would go quiet the day
   * somebody retuned Flame would be asserting the content instead. The player is
   * given exactly the Arcane the stone asks — read off the stone rather than
   * typed, because Flame is an elemental stone and a seeded body no longer meets
   * it — so the cast runs at its full length rather than at some scaled fraction
   * nobody typed, and it runs at all.
   * @see `../app/game/casting`'s `castDurationMs`
   */
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

  /** What the shipped stone asks, so the arcanist is authored to meet it exactly. */
  function stoneAsks(): Record<string, number> {
    const def = (tilesJson as Array<Record<string, unknown>>).find((tile) => tile.id === STONE)!;
    const interactions = def.interactions as Record<string, unknown>;
    const item = interactions.item as Record<string, unknown>;
    return item.requirements as Record<string, number>;
  }

  /** The next patch entry about this body's cast, or null if none comes. */
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
    // Which button rides along, for the caster's own row: the one the cast came
    // out of is the one that stops it.
    expect(progress.slot).toEqual({ from: "square", square: "charm" });

    expect(await castWithin(bob.ws, "alice")).toEqual({
      actorId: "alice",
      progress: null,
    });
  });

  /**
   * The stop is honoured the moment it arrives rather than queued behind steps,
   * and it spends nothing: the same stone casts again straight away, where a
   * cast that had landed instead would be cooling and refuse.
   */
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

/**
 * The switch that says whether somebody is in the fighting.
 *
 * What travels is one boolean per body, and what these cases pin is the three
 * journeys it makes: onto everybody else's screen, into storage, and back out
 * of it on the next `hello`. The rule it feeds — who may hurt whom — is
 * `app/game/pvp`'s and is asserted there, without a socket.
 */
describe("the pvp switch", () => {
  /** Wait for a patch naming this body's switch, or null if none comes. */
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

  /**
   * The point of the row: a reconnect must not put somebody back in the
   * fighting, and must not take them out of it either. Written the moment it
   * moves rather than on the periodic flush, so a crash in between cannot
   * disagree with what the player pressed.
   */
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

/**
 * An administrator's invisibility. @see GameServer.setHidden
 *
 * The claim is that everybody else is sent exactly what they would be if the
 * administrator had logged out. So most of these record another client and
 * assert what does *not* reach it, with a control on the same socket where one
 * is needed to show the socket was listening.
 */
describe("an administrator hiding", () => {
  /** Anything in a message that names this actor, anywhere in it. */
  function mentions(message: Record<string, unknown>, actorId: string): boolean {
    return JSON.stringify(message).includes(`"${actorId}"`);
  }

  /** Wait for the owner to be told the switch reads `on`, or null. */
  function hiddenWithin(ws: TestSocket, on: boolean): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const done = (value: Record<string, unknown> | null) => {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve(value);
      };
      const onMessage = (event: { data: string }) => {
        const message = JSON.parse(event.data) as Record<string, unknown>;
        // Matched on the value as well as the type, so a test pressing it off
        // is not answered by the one sent after a `hello` while it was on.
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

    const left = eventWithin(bob.ws, "left", MESSAGE_TIMEOUT_MS, (e) => e.actorId === "alice");
    const gone = eventWithin(bob.ws, "despawned", MESSAGE_TIMEOUT_MS, (e) => e.actorId === "alice");
    await hide(alice.ws);

    // Counted out of the room, and the body taken back.
    expect(await left).toMatchObject({ kind: "left", actorId: "alice", playerCount: 1 });
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

    // The author still hears themselves…
    expect(own).toMatchObject({ actorId: "alice", text: "can anybody see me" });
    // …and nothing bob was sent says alice is anywhere: not a cell with her
    // body in it, not her step, not her words.
    expect(seen.of("chat")).toEqual([]);
    expect(seen.of("patch").filter((patch) => mentions(patch, "alice"))).toEqual([]);
  });

  /**
   * A damage event is addressed to a cell rather than to a body, so keeping the
   * body out of everybody else's reach does not keep this out: a number floating
   * over a cell says somebody is standing in it.
   */
  it("shows the damage done to the body to its owner alone", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob", { admin: false });
    await hide(alice.ws);
    await Bun.sleep(200);

    const seen = eventsWithin(bob.ws, "damage", 400);
    const felt = eventsWithin(alice.ws, "damage", 400);
    send(alice.ws, { type: "command", text: "/health -1" });

    // The control: the harm landed, and whoever it landed on was shown it.
    expect((await felt).map((hit) => hit.targetId)).toEqual(["alice"]);
    expect(await seen).toEqual([]);
  });

  it("is left out of what somebody arriving afterwards is handed", async () => {
    const alice = await connect("alice");
    await hide(alice.ws);

    const carol = await connect("carol", { admin: false });

    expect(carol.hello.actorIds).toEqual(["carol"]);
    expect(carol.hello.playerCount).toBe(1);
    expect(mentions(carol.hello, "alice")).toBe(false);
  });

  it("is ignored from somebody who is not an administrator", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob", { admin: false });
    const seen = record(alice.ws);
    const bobSeen = record(bob.ws);

    send(bob.ws, { type: "hidden", enabled: true });
    say(bob.ws, "still here");

    // The control: alice hears bob, so she was listening all along.
    expect(await chatWithin(alice.ws, 1000)).toMatchObject({ actorId: "bob" });
    const events = seen.of("patch").flatMap((patch) => patch.events as Record<string, unknown>[]);
    expect(events.filter((event) => event.kind === "left")).toEqual([]);
    expect(bobSeen.of("hidden")).toEqual([]);
  });

  /**
   * The reason the switch is written down: a reload that came back visible
   * would announce a hidden administrator to the whole room.
   */
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
    // Alice's own arrival reached bob on the first tick after he connected, and
    // is still queued; the `joined` this is about is the next one.
    await Bun.sleep(200);
    bob.ws.discardPending();

    const joined = eventWithin(bob.ws, "joined", MESSAGE_TIMEOUT_MS, (e) => e.actorId === "alice");
    const back = eventWithin(bob.ws, "spawned", MESSAGE_TIMEOUT_MS, (e) => e.actorId === "alice");
    send(alice.ws, { type: "hidden", enabled: false });

    expect(await joined).toMatchObject({ kind: "joined", playerCount: 2 });
    expect(await back).not.toBeNull();
  });
});

/**
 * What `GameServer.diffPerActor` promises.
 *
 * Six patch fields are built by one loop now, and these are the three things
 * about that loop nothing else in this file was pinning. Each was checked by
 * breaking the thing it guards and watching it go red — a diff test that passes
 * against a broken diff is worse than none.
 */
describe("what each client is told has changed", () => {
  /** The next patch entry about this body's switch, or null if none comes. */
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

  /** Which bodies the world still remembers having broadcast a switch for. */
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

  /**
   * What the sweep is for, which is **not** what the comments it replaced said.
   *
   * Five of them claimed a returning player would otherwise be diffed against
   * the body they died in and come back carrying its lantern. That cannot
   * happen, and the reason is `scopedPatchFor`: a body nobody has been told
   * about yet is in `entered`, and an arrival is announced with its whole
   * snapshot rather than through a diff. Take the sweep out entirely and all
   * 212 tests in this file still pass — checked.
   *
   * What it actually buys is the thing `noteDeaths` says out loud one line
   * below its own `sentHp.delete`: *or the map grows a row per body the world
   * has ever killed, and a world that respawns creatures kills a great many.*
   * Six maps, one row per body that has ever existed, for the life of the
   * world. That is worth one loop in one place, and it is worth being tested
   * for what it is.
   */
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

  /**
   * The other half of the same question, and what the `same` defaults are for.
   *
   * A body nothing has been sent about yet is compared against `undefined`, and
   * every field decides for itself what that counts as — an unset switch is
   * `false`, an empty light list is `""`, no pull is `null`. Get one wrong and
   * every actor who walks into view is announced as having changed something
   * they have never had, on every tick of every world.
   */
  it("says nothing about a body that arrives with nothing to say", async () => {
    const alice = await connect("alice");

    const seen = record(alice.ws);
    await connect("bob");
    // Long enough for several ticks to have gone out.
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

  /**
   * The reading a health bar is drawn from, in a patch rather than a hello.
   *
   * `maxHp` rides along with the hit points and is deliberately not part of
   * what decides whether to send them — a bar's *size* moving is not news, its
   * fill is. Nothing was checking that it still arrives, so corrupting it
   * passed all 212 tests here.
   */
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

  /**
   * A body that never pulls and never casts is never mentioned in either field.
   *
   * These two are compared by identity and now remember a null for a body doing
   * neither, where they used to remember nothing at all. The two read the same
   * to the compare, and this is what says so: a world full of people standing
   * about puts no `extractions` and no `castings` on the wire at all.
   */
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

/**
 * What one client is told about.
 *
 * A client is sent the chunks its view can reach, and until this it was then
 * told about every cell that changed anywhere — so the join scaled with the
 * player and the tick stream scaled with everybody else. Twenty people in
 * twenty corners of the world each heard the other nineteen neighbourhoods
 * walk about, none of which they could see.
 *
 * The rule is now one rule: a client hears about a chunk exactly while it is
 * subscribed to it, bodies included. The cases below are the seam that makes
 * bodies safe — a body coming into reach arrives with the state a `hello`
 * would have given it, and one going out of reach is taken back, because a
 * client left holding an entry for a body it has no ground for searches its
 * whole board for it on every frame.
 */
describe("patches scoped to a subscription", () => {
  /**
   * The first cell of the first chunk column past what a subscription covers,
   * and the last cell inside it.
   *
   * Derived rather than picked, on the terms `INTEREST_REACH_CELLS` is: the
   * two are one step apart and on opposite sides of the boundary, so a single
   * step carries a body across it and nothing here has to know how wide the
   * reach happens to be today.
   */
  const OUT_OF_REACH = CHUNK_SIZE * (INTEREST_REACH_CHUNKS + 2);
  const IN_REACH = OUT_OF_REACH - 1;

  /**
   * Where alice stands: one chunk in from the end of the strip, so she has
   * ground to step onto in either direction and a step west moves her
   * subscription off the far end of itself.
   */
  const ALICE_CELL = CHUNK_SIZE;

  /**
   * The first cell past what alice could see a *body* in, and the last one
   * inside it — one step apart, on opposite sides of that boundary. The
   * same-storey reach, because that is the storey they are both on.
   *
   * Well inside the ground she holds, which is the point of every case that
   * uses them: a creature walking there is on her board and is still none of
   * her business.
   */
  const BODY_OUT = ALICE_CELL + BODY_REACH_ON_LEVEL + 1;
  const BODY_IN = BODY_OUT - 1;

  /** On the floor in bob's cell, and their slots in that stack. */
  const DROPPED_SWORD = "rusty-sword";
  const DROPPED_STACK_INDEX = 2;
  const BERRY = "berry";
  const BERRY_STACK_INDEX = 3;

  /**
   * A world already run, with alice at the spawn cell and bob out past her
   * reach — the arrangement two players in one town do not have and two players
   * in one world do.
   */
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
      // On the floor over bob's head: something to change that is not somebody
      // walking, and something to eat, which is a thing that makes a noise.
      { tileId: DROPPED_SWORD },
      { tileId: BERRY },
    ];
    return {
      map: { version: MAP_FILE_VERSION, levels: { "0": cells } } as FlatMapFile,
      spawn: { x: ALICE_CELL, y: 0, z: 0, stackIndex: 1 },
    };
  }

  /** Both of them connected, standing where the checkpoint put them. */
  async function bothConnected(bobAt: number = BODY_OUT) {
    await putCheckpoint(farApart(bobAt));
    // Bob first, and that ordering is the test's own bookkeeping rather than
    // anything about scoping: the world loads on the first join and reaps every
    // body in it that nobody is connected to, so the far body has to be the
    // joiner's. Alice is then seated at the spawn point, which is where the
    // checkpoint drew her anyway.
    const bob = await connect("bob");
    const alice = await connect("alice");
    expect(await actorX("alice")).toBe(ALICE_CELL);
    expect(await actorX("bob")).toBe(bobAt);
    // Their own arrivals are still on the way — a `hello` is answered before
    // the tick that puts the body on the board — and every case below is about
    // what happens next.
    await settled(alice.ws);
    await settled(bob.ws);
    return { alice, bob };
  }

  /** Wait until a socket has gone quiet, so what follows is only what is next. */
  async function settled(ws: TestSocket) {
    while ((await messageWithin(ws, "patch", TICK_MS * 3)) !== null);
  }

  /**
   * Run the world on, without waiting for it.
   *
   * The ground that comes back into reach is handed over a couple of chunks a
   * tick, and a world with nobody moving in it stops ticking — so a test that
   * waited in real time would be waiting on a world that had gone to sleep
   * rather than on the handover.
   */
  async function tickTimes(times: number) {
    await runInDurableObject(stub(), (instance: GameServer) => {
      const internals = instance as unknown as { tick(): void };
      for (let i = 0; i < times; i++) internals.tick();
    });
  }

  /** One cell of the map a joiner was sent. */
  function cellOf(hello: Record<string, unknown>, x: number): { tileId: string }[] | undefined {
    const map = hello.map as {
      levels: Record<string, Record<string, { tileId: string }[]>>;
    };
    return map.levels[levelKey(0)]?.[`${x},0`];
  }

  /** Was this ground part of what the joiner was handed at all? */
  function aliceHolds(hello: Record<string, unknown>, x: number): boolean {
    return cellOf(hello, x) !== undefined;
  }

  /** Wait for a step to land, which is where a subscription is read from. */
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
    // Not a world with one person in it: the headcount is the whole world's,
    // because it is about who is playing rather than about what is nearby.
    expect(alice.hello.playerCount).toBe(2);
  });

  /**
   * The case this exists for, and the one scoping by the map's reach alone got
   * wrong: alice holds this ground — her subscription is five chunks and bob is
   * standing three away — and a body walking on it is still not her business.
   */
  it("does not tell a client about a step it could not have seen", async () => {
    const { alice, bob } = await bothConnected();
    // The premise. Without it this passes for the wrong reason, as a test about
    // ground alice was never sent.
    expect(aliceHolds(alice.hello, BODY_OUT)).toBe(true);
    const heard = record(alice.ws);

    step(bob.ws, 1, "e");
    // Bob's own step reaches Bob, which is what makes the silence a rule about
    // what alice can see rather than a world that stopped ticking.
    expect(await walkWithin(bob.ws, 1000)).not.toBeNull();
    await messageWithin(bob.ws, "patch", MESSAGE_TIMEOUT_MS);

    expect(heard.types()).toEqual([]);
  });

  /**
   * And the ground under him is hers, without him on it. A client is never sent
   * a body it has not been told about: left in, that tile would stand in its
   * board for ever, too far to draw and solid to `fitsTile` — an invisible wall
   * where a creature stood an hour ago.
   */
  it("hands over the ground under a body it does not mention, without the body", async () => {
    const { alice } = await bothConnected();

    const stack = cellOf(alice.hello, BODY_OUT);
    expect(stack?.map((placed) => placed.tileId)).toEqual(["grass", DROPPED_SWORD, BERRY]);
  });

  /**
   * A noise and a bubble are both drawn at the cell they were made in, over the
   * body that made them — so a client too far away to see that cell draws
   * nothing whatever it is told. They went out by storey until this, which on
   * one floor of a den is every crunch, gulp and howl in the world.
   */
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
    // It was made: bob hears his own.
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

  /** Speech is a bubble over a cell on the same terms, so it goes the same way. */
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
      // The speaker's name travels with the words rather than being looked up
      // where they are drawn: a bubble outlives its author by five seconds, so
      // naming them off the live board would be asking about somebody who has
      // since walked out of reach. @see `../app/game/GameSession`'s `ChatBubble`
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
      // The cell it is standing in, so the first lookup on the far side
      // confirms a cell rather than searching the whole board for it.
      at: { x: BODY_IN, y: 0, z: 0 },
    });
    // The whole of its state, because this client has nothing to patch against
    // for a body it has just been told about.
    const hps = heard.of("patch").flatMap((message) => message.hps as { actorId: string }[]);
    expect(hps.map((entry) => entry.actorId)).toContain("bob");
    // Its name with it, and for the same reason — alice has never been told
    // what this body is called, and nothing after this would tell her. A
    // patch's names are arrivals only: there is no diff half, because a name
    // cannot move. @see `../app/net/protocol`'s `NamePatch`
    const names = heard
      .of("patch")
      .flatMap((message) => message.names as { actorId: string; name: string }[]);
    expect(names).toContainEqual({ actorId: "bob", name: "Bob" });
    // The step itself was not news to alice while it was being taken: bob was
    // nobody she had been told about until it landed.
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

  /** Every cell a recording heard, with what was burning in it. */
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

  /**
   * A fire rides its cell, so it reaches whoever holds the cell: alice holds the
   * ground bob is standing on, and hears it catch and go out there.
   */
  it("sends a fire on its cell to whoever holds the ground, and puts it out there", async () => {
    const { alice, bob } = await bothConnected();
    const heard = record(alice.ws);

    command(bob.ws, "/tile flame +1");
    await tickTimes(3);
    await settled(alice.ws);
    const lit = cellsHeard(heard).filter((cell) => cell.x === BODY_OUT + 1);
    expect(lit.at(-1)?.afflicted).toEqual([{ tileId: "grass", defIds: ["burned"] }]);

    // Grass goes in about three seconds, and the dirt it becomes does not burn:
    // the cell that says so is the one that puts the fire out.
    await tickTimes(Math.ceil(5_000 / TICK_MS));
    await settled(alice.ws);
    const after = cellsHeard(heard)
      .filter((cell) => cell.x === BODY_OUT + 1)
      .at(-1);
    expect(after?.stack.map((placed) => placed.tileId)).toEqual(["dirt", "flame"]);
    expect(after?.afflicted).toBeUndefined();

    // The grass beside it caught from what was left, and nothing in its stack
    // changed when it did: the fire alone is what made it a changed cell.
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

    // Bob, standing beside it, is told.
    expect(cellsHeard(bobHeard).some((cell) => cell.afflicted?.length)).toBe(true);
    expect(cellsHeard(heard).filter((cell) => cell.afflicted)).toEqual([]);
  });

  /**
   * A fire lit in ground a client walked away from is handed over with that
   * ground when it comes back, because the handover is the cell and the fire is
   * on the cell.
   */
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

  /**
   * The whole round trip, which is the invariant the scoping rests on: what a
   * client holds is exact inside its subscription and frozen outside it, and a
   * chunk coming back into reach is handed over as it stands rather than
   * patched against a board nobody kept current.
   */
  it("hands a chunk back as it stands after walking away from it", async () => {
    // Bob in the last chunk alice's subscription covers, so one step of hers
    // takes that chunk out of it and one step back brings it in. Bodies are not
    // what this is about — he is far outside what she could see one in. He is
    // here to change the ground from three chunks away.
    const { alice, bob } = await bothConnected(IN_REACH);
    expect(cellOf(alice.hello, IN_REACH)?.map((p) => p.tileId)).toEqual([
      "grass",
      DROPPED_SWORD,
      BERRY,
    ]);

    step(alice.ws, 1, "w");
    await arrivedAt("alice", ALICE_CELL - 1);
    // One tick past the landing: a subscription is read off where the body *is*,
    // so the chunk leaves it on the tick after the one that commits the step.
    await tickTimes(2);

    // The ground changes while alice is holding a picture of a chunk she is no
    // longer subscribed to. Nothing about it reaches her.
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
    // The handover is a couple of chunks a tick, and the world would otherwise
    // go to sleep before the one that changed came round.
    await tickTimes(30);

    const cells = heard
      .of("patch")
      .flatMap((message) => message.cells as { x: number; stack: { tileId: string }[] }[]);
    // Handed over as it stands now rather than patched against a board nobody
    // kept current: the sword is gone, and so is bob, who she is not being told
    // about at this distance.
    const handed = cells.filter((cell) => cell.x === IN_REACH).at(-1);
    expect(handed?.stack.map((placed) => placed.tileId)).toEqual(["grass", BERRY]);
  });

  /**
   * Their own body is the one thing a client is never told it has stopped
   * holding: the subscription is centred on it, so the only way out of it is to
   * have no body at all — and a death is told rather than inferred.
   */
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
