import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Harness, Pair } from "./testHarness";
import tilesJson from "../data/tiles.json";
import statusesJson from "../data/statuses.json";
import { RemoteSession } from "../app/net/RemoteSession";
import { MAP_FILE_VERSION, normalizeTileDef } from "../app/lib/types";
import { getStack, listCoords } from "../app/lib/mapData";
import {
  covers,
  visibleStack,
  withinBodyReach,
  BODY_REACH_ON_LEVEL,
} from "../app/net/interest";
import { MIN_LEVEL, MAX_LEVEL } from "../app/lib/types";
import type { MapFile } from "../app/lib/types";
import type { ActorPosition } from "../app/game/GameSession";
import type { FlatMapFile, TileDef } from "../app/lib/types";
import { PLAYER_TILE_ID, TICK_MS, WALK_DURATION_MS } from "../app/game/constants";
import { CHUNK_SIZE } from "../app/lib/types";
import { statusesById } from "../app/lib/status";
import type { GameServer } from "./GameServer";

/**
 * A real client and a real world, talking to each other.
 *
 * Everything else in this suite reads the wire: it asserts on the frames the
 * server sends, which is the right test for what the server decided and says
 * nothing about what a browser does with it. Three regressions shipped in #224
 * that every one of those tests was happy with — a corpse that stayed on the
 * board, a step thrown back across a chunk boundary, and frames getting slower
 * — because all three are what the *client* is left holding after a run of
 * frames, and nothing here had ever run one.
 *
 * So this drives a `RemoteSession` over the same socket pair the rest of the
 * suite uses, with both clocks in the test's hand, and asserts on
 * `getSnapshot()` — the thing the renderer actually draws.
 */

const JSON_TYPE = "application/json";
const tiles: TileDef[] = (tilesJson as TileDef[]).map(normalizeTileDef);
/**
 * The same catalogue the world is loaded with, so the client times a step the
 * way the simulation does — a pace is derived on both sides and never sent.
 */
const statuses = statusesById(statusesJson as unknown[]);

/** Where the player starts, one chunk in so it can walk either way. */
const SPAWN_X = CHUNK_SIZE;
/**
 * A deer two cells east of the player: in reach, in view, and killable.
 *
 * A deer rather than a rat, and not a detail — a rat hunts, so a test that
 * walks a player past one is a test about a fight, and the player being sent
 * back to the spawn point by a rat reads exactly like the step being thrown
 * back that this file is here to look for.
 */
const DEER_X = SPAWN_X + 2;
const DEER_ID = `npc:${DEER_X},0,0,1`;

/** A strip long enough to walk across a chunk boundary and back. */
function strip(): FlatMapFile {
  const cells: Record<string, unknown[]> = {};
  for (let x = 0; x <= CHUNK_SIZE * 8; x++) cells[`${x},0`] = [{ tileId: "grass" }];
  cells[`${SPAWN_X},0`] = [{ tileId: "grass" }, { tileId: PLAYER_TILE_ID, direction: "s" }];
  cells[`${DEER_X},0`] = [{ tileId: "grass" }, { tileId: "deer", direction: "w" }];
  return { version: MAP_FILE_VERSION, levels: { "0": cells } } as FlatMapFile;
}

let harness: Harness;

beforeEach(async () => {
  worldDebt = 0;
  harness = await Harness.create();
  await harness.blobs.put("tiles.json", JSON.stringify(tilesJson), JSON_TYPE);
  await harness.blobs.put("statuses.json", JSON.stringify(statusesJson), JSON_TYPE);
  await harness.blobs.put("map.json", JSON.stringify(strip()), JSON_TYPE);
});

afterEach(async () => {
  await harness.dispose();
});

/** One browser, wired to the world the way `server/index.ts` wires a real one. */
async function play(actorId: string) {
  const pair = new Pair();
  const socket = pair.client();
  pair.onClientMessage = (data) => {
    void harness.server.webSocketMessage(pair.server, data);
  };
  pair.onClientClose = () => {
    harness.hub.drop(pair.server);
    void harness.server.webSocketClose(pair.server);
  };
  let clock = 0;
  const remote = new RemoteSession(
    socket as unknown as WebSocket,
    tiles,
    statuses,
    () => clock,
  );
  await harness.server.join(pair.server, actorId, { admin: true });
  // The `hello` is sent inside `join`, so by here the client has a world.
  expect(remote.isReady()).toBe(true);

  /** Run both clocks, the way a tab and a world run beside each other. */
  const advance = async (ms: number, frameMs = 16) => {
    for (let spent = 0; spent < ms; spent += frameMs) {
      clock += frameMs;
      // The client first: a browser draws its frame and sends what it decided,
      // and the world hears about it on the tick after. The other order gives a
      // step a round trip of zero, which is the one latency no player has.
      remote.update(frameMs);
      await flush();
      tickWorld(frameMs);
      await flush();
    }
  };
  return { remote, pair, advance };
}

/**
 * Let every message in flight be handled.
 *
 * `webSocketMessage` is async and the socket pair calls it without waiting, so
 * a step sent this frame is still a pending promise when the frame ends. A
 * microtask is not enough — the handler awaits storage on its way in.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Run the world forward by hand.
 *
 * The world's own interval is stopped first, every time, because `wake()` puts
 * it back on every message it handles. Two clocks driving one world is a world
 * running at a speed the client's frames know nothing about, and every
 * assertion below would be about that instead.
 */
let worldDebt = 0;
function tickWorld(ms: number) {
  const internals = harness.server as unknown as {
    timer: ReturnType<typeof setInterval> | null;
    tick(): void;
  };
  if (internals.timer !== null) {
    clearInterval(internals.timer);
    internals.timer = null;
  }
  // An accumulator, because a frame is 16ms and a tick is 33: ticking once per
  // frame runs the world at twice the speed of the tab watching it, and every
  // step the client predicts then lands in a world that has already moved on.
  worldDebt += ms;
  while (worldDebt >= TICK_MS) {
    worldDebt -= TICK_MS;
    internals.tick();
  }
}

/**
 * Walk a creature one cell, the way its own brain would have.
 *
 * Retried, because a dozing creature is often half way through a step of its
 * own and answers "later" — which is not a refusal, just a body that is busy.
 */
async function stepCreature(
  actorId: string,
  direction: "n" | "e" | "s" | "w",
  advance: (ms: number) => Promise<void>,
) {
  const internals = harness.server as unknown as {
    session: { requestStep(id: string, d: string): string };
  };
  for (let tries = 0; tries < 20; tries++) {
    if (internals.session.requestStep(actorId, direction) === "started") return;
    await advance(WALK_DURATION_MS);
  }
  throw new Error(`${actorId} would not step ${direction}`);
}

/** Kill something where it stands, the way `GameServer.test.ts` does. */
function kill(actorId: string) {
  const internals = harness.server as unknown as {
    session: { actors: Map<string, unknown>; applyDamage(a: unknown, n: number): void };
  };
  const body = internals.session.actors.get(actorId);
  expect(body).toBeDefined();
  internals.session.applyDamage(body, 10_000);
}

/**
 * Every cell where the client's board and the world's disagree, inside what the
 * client is subscribed to.
 *
 * The invariant the whole scoping rests on, and the one nothing was checking:
 * what a client holds is the world's board, with the bodies it is too far away
 * to be told about taken out of it. A cell the server decided not to send is a
 * cell the client goes on drawing — too far to see today, in the way of its own
 * feet tomorrow.
 *
 * Stripped rather than raw, because a body beyond the body reach is *meant* to
 * be missing: comparing against the world as it stands would call the saving
 * itself a bug. What this catches is the other direction — a body the client
 * still holds that the world has moved or taken away.
 */
function divergence(remote: RemoteSession, actorId: string): string[] {
  const world = harness.server as unknown as {
    session: {
      getMap(): MapFile;
      actorPosition(id: string): ActorPosition | null;
      actorSnapshots(): { id: string; x: number; y: number; z: number }[];
    };
    subscribed: Map<string, Set<string>>;
  };
  const serverMap = world.session.getMap();
  const clientMap = remote.getSnapshot().map;
  const chunks = world.subscribed.get(actorId) ?? new Set<string>();
  const me = world.session.actorPosition(actorId);
  const held = new Set(
    world.session
      .actorSnapshots()
      .filter((a) => a.id === actorId || (me && withinBodyReach(me, a.x, a.y, a.z)))
      .map((a) => a.id),
  );
  const out: string[] = [];
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    const seen = new Set<string>();
    for (const map of [serverMap, clientMap]) {
      for (const { x, y } of listCoords(map, z)) {
        const key = `${x},${y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!covers(chunks, x, y)) continue;
        const mine = getStack(clientMap, x, y, z);
        const theirs = visibleStack(getStack(serverMap, x, y, z), held);
        if (JSON.stringify(mine) === JSON.stringify(theirs)) continue;
        out.push(
          `${x},${y},${z}: client ${JSON.stringify(mine)} world ${JSON.stringify(theirs)}`,
        );
      }
    }
  }
  return out;
}

/**
 * How long a test that walks the player across a chunk boundary is allowed.
 *
 * **This is a budget for simulated work, not for waiting on anything.** `play`'s
 * `advance` steps a clock in 16ms frames, and every frame updates the client,
 * ticks the world and flushes the socket twice — so a test's wall clock is
 * however many frames it simulates, divided by how fast the machine is. The two
 * walks it is applied to cover a chunk and more in each direction, which is a
 * few hundred frames apiece.
 *
 * They run in about 3s and 4s on a developer's machine, and came in at 4.07s and
 * 5.01s on CI, where the second crossed the 5000ms default and failed. It failed
 * *as a timeout*, and the assertion that landed after the deadline then reported
 * a half-finished walk as a divergence between client and world — which reads
 * exactly like the scoping bug this file exists to catch. A test that cries wolf
 * on a loaded runner is worse than no test.
 *
 * Fifteen seconds is three times the slowest run seen: room for a runner under
 * load, and still short enough that something genuinely hung fails rather than
 * hanging the suite.
 */
const WALKING_TEST_MS = 15_000;

/** Walk one way, a step at a time, letting both clocks run. */
async function walk(
  play: { remote: RemoteSession; advance: (ms: number) => Promise<void> },
  direction: "e" | "w",
  steps: number,
) {
  play.remote.setInput({ directions: [direction] });
  await play.advance(WALK_DURATION_MS * steps + 200);
  play.remote.setInput({ directions: [] });
  await play.advance(WALK_DURATION_MS);
}

describe("a client playing against a real world", () => {
  it("has the creature on its board to begin with", async () => {
    const { remote, advance } = await play("alice");
    await advance(200);

    const snap = remote.getSnapshot();
    expect(snap.actors.map((a) => a.id)).toContain(DEER_ID);
  });

  /**
   * The first thing #224 broke. A death is a cell change with no terrain in it,
   * and the body it is about is gone from the tick's snapshot before the patch
   * is cut — so the one patch that takes the corpse off the board was the one
   * the scoping dropped, and nothing ever rewrote that cell again.
   */
  it("takes a dead body off the board it draws", async () => {
    const { remote, advance } = await play("alice");
    await advance(200);

    kill(DEER_ID);
    await advance(500);

    const snap = remote.getSnapshot();
    expect(snap.actors.map((a) => a.id)).not.toContain(DEER_ID);
    // And the tile with it: an actor nothing answers for is merely undrawn, but
    // a body tile left in a cell is solid to `fitsTile` for ever.
    // What it leaves behind is not the question — a body leaves remains, and
    // those are terrain. What must be gone is the body.
    const stack = getStack(snap.map, DEER_X, 0, 0);
    expect(stack.filter((placed) => placed.owner)).toEqual([]);
  });
});

/**
 * The three reports from play, as the closest thing to playing this suite can
 * do: walk about with a creature nearby and see what the client is left with.
 */
describe("walking about with a creature in the world", () => {
  it("never lets the client's board drift from the world's", async () => {
    const session = await play("alice");
    await session.advance(300);
    expect(divergence(session.remote, "alice")).toEqual([]);

    // Out past what a body is scoped by, then back. The creature is dozing
    // somewhere behind, and whatever it does while nobody is being told is what
    // this is about.
    await walk(session, "e", CHUNK_SIZE * 2);
    await session.advance(1000);
    await walk(session, "w", CHUNK_SIZE * 2);
    await session.advance(1000);

    expect(divergence(session.remote, "alice")).toEqual([]);
  }, WALKING_TEST_MS);

  /**
   * The case the scoping is *for*, which is also the case nothing exercises by
   * accident: a body that moves while the client is not being told about it.
   *
   * Walk out past the body reach, move the creature while nobody is watching,
   * walk back. What the client holds for that cell in between is the whole
   * question — it is ground the client never stopped being subscribed to, so
   * nothing re-hands it, and a tile left in it is left for good.
   */
  it("does not keep a body where it no longer is", async () => {
    const session = await play("alice");
    await session.advance(300);

    await walk(session, "e", BODY_REACH_ON_LEVEL + CHUNK_SIZE);
    await session.advance(500);
    // Out of what a body is scoped by, and well inside the ground she holds.
    const away = session.remote.getSnapshot().self.x;
    expect(away - DEER_X).toBeGreaterThan(BODY_REACH_ON_LEVEL);

    const world = harness.server as unknown as {
      session: { actorPosition(id: string): { x: number } | null };
    };
    const before = world.session.actorPosition(DEER_ID)!.x;
    await stepCreature(DEER_ID, "e", session.advance);
    await session.advance(1000);
    // It really moved while nobody was being told, which is the premise.
    expect(world.session.actorPosition(DEER_ID)!.x).not.toBe(before);

    await walk(session, "w", BODY_REACH_ON_LEVEL + CHUNK_SIZE);
    await session.advance(1000);

    expect(divergence(session.remote, "alice")).toEqual([]);
  }, WALKING_TEST_MS);

  /**
   * The other way across the boundary: the creature walks and the player does
   * not. The cell it steps out of changes, with nothing in that change but a
   * body — and by the time the patch is cut, that body is no longer one this
   * client holds. Drop it and the tile stays where it stood, in ground the
   * client never stops being subscribed to, so nothing ever re-hands it.
   */
  it("does not leave a body behind when it walks out of reach itself", async () => {
    const session = await play("alice");
    await session.advance(300);
    expect(session.remote.getSnapshot().actors.map((a) => a.id)).toContain(DEER_ID);

    for (let i = 0; i < BODY_REACH_ON_LEVEL + 4; i++) {
      await stepCreature(DEER_ID, "e", session.advance);
      await session.advance(WALK_DURATION_MS);
    }
    await session.advance(500);

    expect(divergence(session.remote, "alice")).toEqual([]);
  });

  it("never walks the player backwards", async () => {
    const session = await play("alice");
    await session.advance(300);
    const seen: number[] = [];
    session.remote.setInput({ directions: ["e"] });
    for (let i = 0; i < CHUNK_SIZE * 2; i++) {
      await session.advance(WALK_DURATION_MS);
      seen.push(session.remote.getSnapshot().self.x);
    }
    session.remote.setInput({ directions: [] });

    const wentBack = seen.filter((x, i) => i > 0 && x < seen[i - 1]!);
    const walked = seen.at(-1)! - seen[0]!;
    expect(wentBack).toEqual([]);
    // And it went somewhere: a player who never moved has an empty list too,
    // and this has to cross at least one chunk boundary to mean anything.
    expect(walked).toBeGreaterThan(CHUNK_SIZE);
  });
});
