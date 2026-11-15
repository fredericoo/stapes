import { describe, expect, it } from "vitest";
import statusesJson from "../../data/statuses.json";
import { inAreaShape } from "../lib/area";
import { emptyMap, replaceStack } from "../lib/mapData";
import { statusesById } from "../lib/status";
import type { PlacedTile, TileDef } from "../lib/types";
import { TICK_MS } from "./constants";
import { GameSession } from "./GameSession";
import { shippedTiles } from "./testShippedTiles";

const NOON_MINUTES = 12 * 60;
const FIELD_RADIUS = 14;
const RING_RADIUS = 6;
const CAGE_WATCH_MS = 12_000;
const MELT_WATCH_MS = 14_000;
const SHARD_WATCH_MS = 4_000;
const FLAME_WATCH_MS = 8_000;
const SWING_WATCH_MS = 3_000;

const STURDY_BASE_HP = 10_000;

/**
 * A fresh player does not outlast the yeti's fists and shards for long, and a
 * brain with no player left stops thinking, so the player is given health to
 * spare: these tests watch what the yeti does, not what it costs.
 */
function sturdyPlayer(tiles: TileDef[]): TileDef[] {
  return tiles.map((tile) => {
    if (tile.id !== "player") return tile;
    const battler = tile.interactions!.battler!;
    return {
      ...tile,
      interactions: { ...tile.interactions, battler: { ...battler, baseHp: STURDY_BASE_HP } },
    };
  });
}

const authored = sturdyPlayer(shippedTiles());
const statuses = statusesById(statusesJson as unknown[]);

function field(placed: { x: number; tiles: PlacedTile[] }[], aliceX: number): GameSession {
  let map = emptyMap();
  for (let x = -FIELD_RADIUS; x <= FIELD_RADIUS; x++) {
    for (let y = -FIELD_RADIUS; y <= FIELD_RADIUS; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "dirt" }]);
    }
  }
  for (const { x, tiles } of placed)
    map = replaceStack(map, x, 0, 0, [{ tileId: "dirt" }, ...tiles]);
  map = replaceStack(map, aliceX, 0, 0, [
    { tileId: "dirt" },
    { tileId: "player", direction: "w", owner: "alice" },
  ]);
  return new GameSession(map, authored, {
    actorIds: ["alice"],
    spawnAt: { x: FIELD_RADIUS, y: FIELD_RADIUS, z: 0, stackIndex: 1 },
    seed: 20261115,
    clock: () => NOON_MINUTES,
    statuses,
  });
}

const yetiField = (aliceX: number) => field([{ x: 0, tiles: [{ tileId: "yeti" }] }], aliceX);

const icicles = (session: GameSession) =>
  session.actorSnapshots().filter((actor) => actor.tileId === "icicle");

const yetiOf = (session: GameSession) =>
  session.actorSnapshots().find((actor) => actor.tileId === "yeti")!;

function tickUntil(session: GameSession, ms: number, done: () => boolean): boolean {
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
    session.tick(TICK_MS);
    if (done()) return true;
  }
  return done();
}

describe("the yeti we ship", () => {
  it("throws frost shards at somebody it can see from across the field", () => {
    const session = yetiField(5);
    const thrown = tickUntil(session, SHARD_WATCH_MS, () =>
      session.getSnapshot("alice").projectiles.some((flight) => flight.tileId === "frost-shard"),
    );
    expect(thrown).toBe(true);
  });

  it("rings itself and somebody close by in icicles, with them inside", () => {
    const session = yetiField(3);
    expect(tickUntil(session, CAGE_WATCH_MS, () => icicles(session).length > 0)).toBe(true);

    const yeti = yetiOf(session);
    const alice = session.actorSnapshots().find((actor) => actor.id === "alice")!;
    const ring = icicles(session);
    expect(ring.length).toBeGreaterThan(30);
    for (const icicle of ring) {
      expect(inAreaShape("ring", RING_RADIUS, icicle.x - yeti.x, icicle.y - yeti.y)).toBe(true);
    }
    expect(inAreaShape("circle", RING_RADIUS - 1, alice.x - yeti.x, alice.y - yeti.y)).toBe(true);
  });

  it("lets its icicles melt away on their own", () => {
    const session = yetiField(3);
    tickUntil(session, CAGE_WATCH_MS, () => icicles(session).length > 0);
    expect(tickUntil(session, MELT_WATCH_MS, () => icicles(session).length === 0)).toBe(true);
  });
});

describe("an icicle", () => {
  it("melts away standing in a flame", () => {
    const session = field([{ x: 0, tiles: [{ tileId: "flame" }, { tileId: "icicle" }] }], 2);
    expect(icicles(session)).toHaveLength(1);
    expect(tickUntil(session, FLAME_WATCH_MS, () => icicles(session).length === 0)).toBe(true);
  });

  it("breaks to a single blow", () => {
    const session = field([{ x: 0, tiles: [{ tileId: "icicle" }] }], 1);
    session.setTarget(icicles(session)[0]!.id, "alice");
    session.setAttackMode(true, "alice");
    expect(tickUntil(session, SWING_WATCH_MS, () => icicles(session).length === 0)).toBe(true);
  });
});
