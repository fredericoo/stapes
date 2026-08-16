import { describe, expect, it } from "vitest";
import { DEFAULT_WEAPON, isItem } from "../lib/item";
import { resolveRespawn } from "../lib/interactions";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { GameSession } from "./GameSession";
import {
  findSpawnPoints,
  isSpawnFilled,
  rollRespawnDelayMs,
  type SpawnPoint,
} from "./respawn";

/**
 * Where the world grows things back.
 *
 * Spawn points are derived once from a map every point is filled in, so most
 * of what matters here is the derivation being faithful — the right key, the
 * right identity, runtime ids stripped — and the filled test telling a
 * wanderer from a corpse. The refill itself is `GameSession.respawnAt`,
 * covered at the bottom against the session it runs in.
 */

const RESPAWN_FROM_MS = 30_000;
const RESPAWN_TO_MS = 60_000;
const RESPAWN = { fromMs: RESPAWN_FROM_MS, toMs: RESPAWN_TO_MS };

const frame = {
  sprite: {
    tilesetId: "basic",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  durationMs: 200,
};

function tile(
  partial: Record<string, unknown> & Pick<TileDef, "id" | "height">,
): TileDef {
  return normalizeTileDef({
    name: partial.id,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    ...partial,
  });
}

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "wall", height: 2 }),
  tile({
    id: "player",
    height: 2,
    directional: true,
    affectedByGravity: true,
    walkable: false,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
  }),
  // The motivating creature: a body that comes back.
  tile({
    id: "gnome",
    height: 1,
    actor: true,
    walkable: false,
    interactions: { respawn: RESPAWN },
  }),
  // A body that does not — its death is permanent.
  tile({ id: "deer", height: 1, actor: true, walkable: false }),
  // An object that grows back where it was authored.
  tile({
    id: "coin",
    height: 0,
    kind: "item",
    interactions: { item: DEFAULT_WEAPON, respawn: RESPAWN },
  }),
  // Malformed ranges read as "does not respawn", like decay's do.
  tile({
    id: "backwards",
    height: 0,
    interactions: { respawn: { fromMs: 5000, toMs: 1000 } },
  }),
  tile({
    id: "zero",
    height: 0,
    interactions: { respawn: { fromMs: 0, toMs: 0 } },
  }),
];

const tilesById = tilesByIdFromList(tiles);

/** A strip of grass along y=0, with the authored spawn marker at x=0. */
function strip(width: number): MapFile {
  let map = emptyMap();
  for (let x = 0; x < width; x++) {
    map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
  }
  map = replaceStack(map, 0, 0, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "e" },
  ]);
  return map;
}

const GNOME_X = 3;
const GNOME_OWNER = `npc:${GNOME_X},0,0,1`;

function withGnome(map: MapFile, owner?: string): MapFile {
  return replaceStack(map, GNOME_X, 0, 0, [
    { tileId: "grass" },
    { tileId: "gnome", ...(owner ? { owner } : {}) },
  ]);
}

function pointFor(map: MapFile, key: string): SpawnPoint {
  const point = findSpawnPoints(map, tilesById).find((p) => p.key === key);
  expect(point).toBeDefined();
  return point!;
}

/** The object point authored at (x,y) on the ground level, keyed however. */
function objectPointAt(map: MapFile, x: number, tileId: string): SpawnPoint {
  const point = findSpawnPoints(map, tilesById).find(
    (p) => !p.ownerId && p.cell.x === x && p.placed.tileId === tileId,
  );
  expect(point).toBeDefined();
  return point!;
}

describe("resolveRespawn", () => {
  it("parses an authored range and refuses a malformed one", () => {
    expect(resolveRespawn(tilesById.gnome!)).toEqual(RESPAWN);
    expect(resolveRespawn(tilesById.backwards!)).toBeNull();
    expect(resolveRespawn(tilesById.zero!)).toBeNull();
    expect(resolveRespawn(tilesById.grass!)).toBeNull();
  });
});

describe("rollRespawnDelayMs", () => {
  it("draws from the authored range, both ends included", () => {
    expect(rollRespawnDelayMs(RESPAWN, () => 0)).toBe(RESPAWN_FROM_MS);
    expect(rollRespawnDelayMs(RESPAWN, () => 0.999999)).toBe(RESPAWN_TO_MS);
  });
});

describe("findSpawnPoints", () => {
  it("keys a creature by the identity it was adopted under", () => {
    const adopted = withGnome(strip(6), "npc:custom");
    expect(findSpawnPoints(adopted, tilesById)).toEqual([
      expect.objectContaining({
        key: "npc:custom",
        ownerId: "npc:custom",
        cell: { x: GNOME_X, y: 0, z: 0 },
        respawn: RESPAWN,
      }),
    ]);
  });

  it("derives the identity an unadopted creature would be given", () => {
    const point = pointFor(withGnome(strip(6)), GNOME_OWNER);
    expect(point.ownerId).toBe(GNOME_OWNER);
  });

  it("strips runtime identities off the template it keeps", () => {
    const map = replaceStack(withGnome(strip(6), "npc:x"), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "coin", itemId: "item-7" },
    ]);
    const gnome = pointFor(map, "npc:x");
    const coin = objectPointAt(map, 1, "coin");
    expect(gnome.placed).toEqual({ tileId: "gnome" });
    expect(coin.placed).toEqual({ tileId: "coin" });
  });

  it("folds identical objects in one cell into a count", () => {
    const map = replaceStack(strip(6), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "coin" },
      { tileId: "coin" },
    ]);
    const point = objectPointAt(map, 1, "coin");
    expect(point.count).toBe(2);
    expect(point.ownerId).toBeUndefined();
  });

  it("skips tiles that do not respawn, malformed ranges included", () => {
    let map = withGnome(strip(6));
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "deer" }]);
    map = replaceStack(map, 2, 0, 0, [{ tileId: "backwards" }]);
    map = replaceStack(map, 4, 0, 0, [{ tileId: "zero" }]);
    expect(findSpawnPoints(map, tilesById).map((p) => p.key)).toEqual([
      GNOME_OWNER,
    ]);
  });
});

describe("isSpawnFilled", () => {
  it("counts a creature as alive wherever it has wandered to", () => {
    const authored = withGnome(strip(6));
    const point = pointFor(authored, GNOME_OWNER);

    // The gnome walked two cells east: authored cell empty, gnome alive.
    let wandered = replaceStack(authored, GNOME_X, 0, 0, [{ tileId: "grass" }]);
    wandered = replaceStack(wandered, GNOME_X + 2, 0, 0, [
      { tileId: "grass" },
      { tileId: "gnome", owner: GNOME_OWNER },
    ]);
    expect(isSpawnFilled(wandered, point)).toBe(true);

    const dead = replaceStack(authored, GNOME_X, 0, 0, [{ tileId: "grass" }]);
    expect(isSpawnFilled(dead, point)).toBe(false);
  });

  it("counts an object only in its authored cell, up to the authored number", () => {
    const authored = replaceStack(strip(6), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "coin" },
      { tileId: "coin" },
    ]);
    const point = objectPointAt(authored, 1, "coin");
    expect(isSpawnFilled(authored, point)).toBe(true);

    // One of the two taken: the count is short, wherever the coin went.
    const oneTaken = replaceStack(authored, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "coin" },
    ]);
    expect(isSpawnFilled(oneTaken, point)).toBe(false);
  });
});

describe("GameSession.respawnAt", () => {
  const authored = withGnome(strip(6));
  const gnomePoint = pointFor(authored, GNOME_OWNER);

  it("grows a creature back at its authored cell, adopted and driven", () => {
    // The world after the gnome died: its placement is simply not there.
    const session = new GameSession(strip(6), tiles);

    expect(session.respawnAt(gnomePoint)).toBe(true);
    const stack = getStack(session.getMap(), GNOME_X, 0, 0);
    expect(stack.map((p) => p.tileId)).toEqual(["grass", "gnome"]);
    expect(stack[1]?.owner).toBe(GNOME_OWNER);
    expect(session.actorIds()).toContain(GNOME_OWNER);
  });

  it("reports a filled point settled without growing a second body", () => {
    const session = new GameSession(authored, tiles);

    expect(session.respawnAt(gnomePoint)).toBe(true);
    const gnomes = getStack(session.getMap(), GNOME_X, 0, 0).filter(
      (p) => p.tileId === "gnome",
    );
    expect(gnomes).toHaveLength(1);
  });

  it("refuses, retryably, when the placement no longer fits", () => {
    // Somebody built to the ceiling where the gnome used to stand.
    const blocked = replaceStack(strip(6), GNOME_X, 0, 0, [
      { tileId: "wall" },
      { tileId: "wall" },
    ]);
    const session = new GameSession(blocked, tiles);

    expect(session.respawnAt(gnomePoint)).toBe(false);
    expect(session.actorIds()).not.toContain(GNOME_OWNER);
  });

  it("mints a fresh identity for a respawned item", () => {
    expect(isItem(tilesById.coin!)).toBe(true);
    const map = replaceStack(strip(6), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "coin" },
    ]);
    const point = objectPointAt(map, 1, "coin");

    const session = new GameSession(strip(6), tiles);
    expect(session.respawnAt(point)).toBe(true);
    const coin = getStack(session.getMap(), 1, 0, 0)[1];
    expect(coin?.tileId).toBe("coin");
    expect(coin?.itemId).toBeTruthy();
  });

  it("treats a tile that has left the catalogue as settled, not retryable", () => {
    const session = new GameSession(strip(6), tiles);
    const orphan: SpawnPoint = {
      ...gnomePoint,
      placed: { tileId: "nope" },
    };
    expect(session.respawnAt(orphan)).toBe(true);
  });
});
