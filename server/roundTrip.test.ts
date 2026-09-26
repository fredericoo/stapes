import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Harness, Pair } from "./testHarness";
import tilesJson from "../data/tiles.json";
import statusesJson from "../data/statuses.json";
import { RemoteSession } from "../app/net/RemoteSession";
import { MAP_FILE_VERSION, normalizeTileDef } from "../app/lib/types";
import { getStack, listCoords } from "../app/lib/mapData";
import { covers, visibleStack, withinBodyReach, BODY_REACH_ON_LEVEL } from "../app/net/interest";
import { MIN_LEVEL, MAX_LEVEL } from "../app/lib/types";
import type { MapFile } from "../app/lib/types";
import type { ActorPosition } from "../app/game/GameSession";
import type { FlatMapFile, TileDef } from "../app/lib/types";
import { PLAYER_TILE_ID, TICK_MS, WALK_DURATION_MS } from "../app/game/constants";
import { CHUNK_SIZE } from "../app/lib/types";
import { statusesById } from "../app/lib/status";

const JSON_TYPE = "application/json";
const tiles: TileDef[] = (tilesJson as TileDef[]).map(normalizeTileDef);
const statuses = statusesById(statusesJson as unknown[]);

const SPAWN_X = CHUNK_SIZE;
const DEER_X = SPAWN_X + 2;
const DEER_ID = `npc:${DEER_X},0,0,1`;

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
  const remote = new RemoteSession(socket as unknown as WebSocket, tiles, statuses, () => clock);
  await harness.server.join(pair.server, actorId, { admin: true });
  expect(remote.isReady()).toBe(true);

  const advance = async (ms: number, frameMs = 16) => {
    for (let spent = 0; spent < ms; spent += frameMs) {
      clock += frameMs;
      remote.update(frameMs);
      await flush();
      tickWorld(frameMs);
      await flush();
    }
  };
  return { remote, pair, advance };
}

/**
 * `webSocketMessage` is async and the socket pair calls it without waiting, so
 * a step sent this frame is still a pending promise when the frame ends. A
 * microtask is not enough — the handler awaits storage on its way in.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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
  worldDebt += ms;
  while (worldDebt >= TICK_MS) {
    worldDebt -= TICK_MS;
    internals.tick();
  }
}

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

function kill(actorId: string) {
  const internals = harness.server as unknown as {
    session: { actors: Map<string, unknown>; applyDamage(a: unknown, n: number): void };
  };
  const body = internals.session.actors.get(actorId);
  expect(body).toBeDefined();
  internals.session.applyDamage(body, 10_000);
}

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
        out.push(`${x},${y},${z}: client ${JSON.stringify(mine)} world ${JSON.stringify(theirs)}`);
      }
    }
  }
  return out;
}

const WALKING_TEST_MS = 15_000;

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

  it("takes a dead body off the board it draws", async () => {
    const { remote, advance } = await play("alice");
    await advance(200);

    kill(DEER_ID);
    await advance(500);

    const snap = remote.getSnapshot();
    expect(snap.actors.map((a) => a.id)).not.toContain(DEER_ID);
    const stack = getStack(snap.map, DEER_X, 0, 0);
    expect(stack.filter((placed) => placed.owner)).toEqual([]);
  });
});

describe("walking about with a creature in the world", () => {
  it(
    "never lets the client's board drift from the world's",
    async () => {
      const session = await play("alice");
      await session.advance(300);
      expect(divergence(session.remote, "alice")).toEqual([]);

      await walk(session, "e", CHUNK_SIZE * 2);
      await session.advance(1000);
      await walk(session, "w", CHUNK_SIZE * 2);
      await session.advance(1000);

      expect(divergence(session.remote, "alice")).toEqual([]);
    },
    WALKING_TEST_MS,
  );

  it(
    "does not keep a body where it no longer is",
    async () => {
      const session = await play("alice");
      await session.advance(300);

      await walk(session, "e", BODY_REACH_ON_LEVEL + CHUNK_SIZE);
      await session.advance(500);
      const away = session.remote.getSnapshot().self.x;
      expect(away - DEER_X).toBeGreaterThan(BODY_REACH_ON_LEVEL);

      const world = harness.server as unknown as {
        session: { actorPosition(id: string): { x: number } | null };
      };
      const before = world.session.actorPosition(DEER_ID)!.x;
      await stepCreature(DEER_ID, "e", session.advance);
      await session.advance(1000);
      expect(world.session.actorPosition(DEER_ID)!.x).not.toBe(before);

      await walk(session, "w", BODY_REACH_ON_LEVEL + CHUNK_SIZE);
      await session.advance(1000);

      expect(divergence(session.remote, "alice")).toEqual([]);
    },
    WALKING_TEST_MS,
  );

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
    expect(walked).toBeGreaterThan(CHUNK_SIZE);
  });
});

describe("somebody joining out of reach", () => {
  it(
    "costs this client nothing to track, and is there once it walks back",
    async () => {
      const session = await play("alice");
      await session.advance(300);
      await walk(session, "e", BODY_REACH_ON_LEVEL + CHUNK_SIZE);
      await session.advance(500);

      const bob = new Pair();
      bob.client().addEventListener("message", () => {});
      await harness.server.join(bob.server, "bob", { admin: false });
      await session.advance(500);

      const internals = session.remote as unknown as { motions: Map<string, unknown> };
      expect(session.remote.playerCount()).toBe(2);
      expect(internals.motions.has("bob")).toBe(false);

      await walk(session, "w", BODY_REACH_ON_LEVEL + CHUNK_SIZE);
      await session.advance(1000);
      expect(session.remote.getSnapshot().actors.map((a) => a.id)).toContain("bob");
    },
    WALKING_TEST_MS,
  );
});
