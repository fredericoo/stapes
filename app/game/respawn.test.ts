import { describe, expect, it } from "vitest";
import { DEFAULT_WEAPON, isItem } from "../lib/item";
import { resolveRespawn } from "../lib/interactions";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { parseTileTransitions } from "../lib/tileTransition";
import { tilesByIdFromList } from "../lib/validation";
import { GameSession } from "./GameSession";
import {
  findSpawnPoints,
  isSpawnFilled,
  presentItemIds,
  rollRespawnDelayMs,
  type SpawnPoint,
  withMigratedItemIds,
} from "./respawn";
import { FRAME, tile } from "../lib/testTile";

const RESPAWN_FROM_MS = 30_000;
const RESPAWN_TO_MS = 60_000;
const RESPAWN = { fromMs: RESPAWN_FROM_MS, toMs: RESPAWN_TO_MS };

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "wall", height: 4 }),
  tile({
    id: "player",
    height: 4,
    directional: true,
    affectedByGravity: true,
    walkable: false,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
  }),
  tile({
    id: "gnome",
    height: 2,
    actor: true,
    walkable: false,
    interactions: { respawn: RESPAWN },
  }),
  tile({
    id: "packrat",
    height: 2,
    actor: true,
    walkable: false,
    kind: "battler",
    interactions: {
      respawn: RESPAWN,
      battler: {
        baseHp: 8,
        masteries: { toughness: 1 },
        naturalWeapon: DEFAULT_WEAPON,
        kit: [{ slot: "weapon", tileId: "coin", chance: 100 }],
      },
    },
  }),
  tile({ id: "deer", height: 2, actor: true, walkable: false }),
  tile({
    id: "coin",
    height: 0,
    kind: "item",
    interactions: { item: DEFAULT_WEAPON, respawn: RESPAWN },
  }),
  tile({
    id: "berry",
    height: 0,
    kind: "item",
    interactions: {
      item: DEFAULT_WEAPON,
      respawn: RESPAWN,
      decay: { tileId: "stale-berry", fromMs: 1000, toMs: 1000 },
    },
  }),
  tile({
    id: "stale-berry",
    height: 0,
    kind: "item",
    interactions: { item: DEFAULT_WEAPON },
  }),
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

function strip(width: number): MapFile {
  let map = emptyMap();
  for (let x = 0; x < width; x++) {
    map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
  }
  map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "e" }]);
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

  it("records the identities of the authored items it is answerable for", () => {
    const map = replaceStack(strip(6), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "coin", itemId: "item-a" },
      { tileId: "coin", itemId: "item-b" },
    ]);
    const point = objectPointAt(map, 1, "coin");
    expect(point.itemIds).toEqual(["item-a", "item-b"]);
  });

  it("records no identities for a tile that is not an item", () => {
    const map = replaceStack(strip(6), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "backwards" },
      { tileId: "zero" },
    ]);
    expect(findSpawnPoints(map, tilesById)).toEqual([]);
    const unminted = replaceStack(strip(6), 1, 0, 0, [{ tileId: "grass" }, { tileId: "coin" }]);
    expect(objectPointAt(unminted, 1, "coin").itemIds).toBeUndefined();
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
    expect(findSpawnPoints(map, tilesById).map((p) => p.key)).toEqual([GNOME_OWNER]);
  });
});

describe("isSpawnFilled", () => {
  it("counts a creature as alive wherever it has wandered to", () => {
    const authored = withGnome(strip(6));
    const point = pointFor(authored, GNOME_OWNER);

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

    const oneTaken = replaceStack(authored, 1, 0, 0, [{ tileId: "grass" }, { tileId: "coin" }]);
    expect(isSpawnFilled(oneTaken, point)).toBe(false);
  });
});

describe("isSpawnFilled, by identity", () => {
  function berryAt(itemId: string) {
    const map = replaceStack(strip(6), 1, 0, 0, [{ tileId: "grass" }, { tileId: "berry", itemId }]);
    return { map, point: objectPointAt(map, 1, "berry") };
  }

  it("counts a thing that decayed where it stands", () => {
    const { map, point } = berryAt("item-a");
    const stale = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "stale-berry", itemId: "item-a" },
    ]);
    expect(isSpawnFilled(stale, point)).toBe(true);
  });

  it("counts nothing once the thing has left the cell", () => {
    const { map, point } = berryAt("item-a");
    const taken = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
    expect(isSpawnFilled(taken, point)).toBe(false);
  });

  it("does not count a lookalike, or the thing it has already forgotten", () => {
    const { map, point } = berryAt("item-a");
    const emptied = { ...point, itemIds: [] };
    const dropped = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "berry", itemId: "item-a" },
      { tileId: "berry", itemId: "item-b" },
    ]);
    expect(isSpawnFilled(dropped, emptied)).toBe(false);
  });

  it("falls back to counting tiles for a point that watches nothing", () => {
    const { map } = berryAt("item-a");
    const point = objectPointAt(map, 1, "berry");
    const { itemIds: _itemIds, ...untracked } = point;
    expect(isSpawnFilled(map, untracked)).toBe(true);
  });
});

describe("presentItemIds", () => {
  it("is empty for a point that watches nothing, and for one holding none", () => {
    const map = replaceStack(strip(6), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "coin", itemId: "item-a" },
    ]);
    const point = objectPointAt(map, 1, "coin");
    expect(presentItemIds(map, point)).toEqual(["item-a"]);
    expect(presentItemIds(map, { ...point, itemIds: [] })).toEqual([]);
    expect(presentItemIds(map, { ...point, itemIds: undefined })).toEqual([]);
  });
});

describe("withMigratedItemIds", () => {
  it("backfills a stored point off the cell, by tile", () => {
    const map = replaceStack(strip(6), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "berry", itemId: "item-a" },
    ]);
    const point = objectPointAt(map, 1, "berry");
    const { itemIds: _itemIds, ...stored } = point;
    expect(withMigratedItemIds(map, stored).itemIds).toEqual(["item-a"]);

    const stale = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "stale-berry", itemId: "item-a" },
    ]);
    expect(withMigratedItemIds(stale, stored).itemIds).toBeUndefined();
  });

  it("leaves a point that already knows, and a creature, alone", () => {
    const map = replaceStack(strip(6), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "berry", itemId: "item-a" },
    ]);
    const point = objectPointAt(map, 1, "berry");
    expect(withMigratedItemIds(map, point)).toBe(point);
    const gnome = pointFor(withGnome(strip(6)), GNOME_OWNER);
    expect(withMigratedItemIds(map, gnome)).toBe(gnome);
  });
});

describe("GameSession.respawnAt", () => {
  const authored = withGnome(strip(6));
  const gnomePoint = pointFor(authored, GNOME_OWNER);

  it("grows a creature back at its authored cell, adopted and driven", () => {
    const session = new GameSession(strip(6), tiles);

    expect(session.respawnAt(gnomePoint).kind).toBe("done");
    const stack = getStack(session.getMap(), GNOME_X, 0, 0);
    expect(stack.map((p) => p.tileId)).toEqual(["grass", "gnome"]);
    expect(stack[1]?.owner).toBe(GNOME_OWNER);
    expect(session.actorIds()).toContain(GNOME_OWNER);
  });

  it("reports a filled point settled without growing a second body", () => {
    const session = new GameSession(authored, tiles);

    expect(session.respawnAt(gnomePoint).kind).toBe("done");
    const gnomes = getStack(session.getMap(), GNOME_X, 0, 0).filter((p) => p.tileId === "gnome");
    expect(gnomes).toHaveLength(1);
  });

  it("refuses, retryably, when the placement no longer fits", () => {
    const blocked = replaceStack(strip(6), GNOME_X, 0, 0, [{ tileId: "wall" }, { tileId: "wall" }]);
    const session = new GameSession(blocked, tiles);

    expect(session.respawnAt(gnomePoint).kind).toBe("blocked");
    expect(session.actorIds()).not.toContain(GNOME_OWNER);
  });

  it("mints a fresh identity for a respawned item", () => {
    expect(isItem(tilesById.coin!)).toBe(true);
    const map = replaceStack(strip(6), 1, 0, 0, [{ tileId: "grass" }, { tileId: "coin" }]);
    const point = objectPointAt(map, 1, "coin");

    const session = new GameSession(strip(6), tiles);
    expect(session.respawnAt(point).kind).toBe("done");
    const coin = getStack(session.getMap(), 1, 0, 0)[1];
    expect(coin?.tileId).toBe("coin");
    expect(coin?.itemId).toBeTruthy();
  });

  it("rolls a respawned creature's kit, and rolls it fresh each time", () => {
    const PACKRAT_X = 2;
    const owner = `npc:${PACKRAT_X},0,0,1`;
    const authoredRat = replaceStack(strip(6), PACKRAT_X, 0, 0, [
      { tileId: "grass" },
      { tileId: "packrat" },
    ]);
    const point = pointFor(authoredRat, owner);
    const session = new GameSession(strip(6), tiles);

    expect(session.respawnAt(point).kind).toBe("done");
    const first = session.equipmentOf(owner)!.weapon;
    expect(first?.tileId).toBe("coin");

    session.despawn(owner);
    expect(session.respawnAt(point).kind).toBe("done");
    const second = session.equipmentOf(owner)!.weapon;

    expect(second?.tileId).toBe("coin");
    expect(second?.id).not.toBe(first?.id);
  });

  it("hands back the identity it minted, so the point can watch it", () => {
    const map = replaceStack(strip(6), 1, 0, 0, [{ tileId: "grass" }, { tileId: "coin" }]);
    const point = objectPointAt(map, 1, "coin");
    const session = new GameSession(strip(6), tiles);

    const outcome = session.respawnAt(point);
    expect(outcome).toEqual({ kind: "done", itemId: expect.any(String) });
    const grown = getStack(session.getMap(), 1, 0, 0)[1];
    expect(outcome.kind === "done" && outcome.itemId).toBe(grown?.itemId);
  });

  it("hands back no identity when nothing grew, or what grew is not an item", () => {
    const filled = new GameSession(authored, tiles);
    expect(filled.respawnAt(gnomePoint)).toEqual({ kind: "done" });
    const empty = new GameSession(strip(6), tiles);
    expect(empty.respawnAt(gnomePoint)).toEqual({ kind: "done" });
  });

  it("treats a tile that has left the catalogue as settled, not retryable", () => {
    const session = new GameSession(strip(6), tiles);
    const orphan: SpawnPoint = {
      ...gnomePoint,
      placed: { tileId: "nope" },
    };
    expect(session.respawnAt(orphan).kind).toBe("done");
  });
});

describe("ways in and out, for bodies and what grows back", () => {
  const WAYS = {
    appear: {
      durationMs: 300,
      dissolve: { pattern: "noise", edgeColor: "#8ce6ff", edgeWidth: 0.1 },
    },
    disappear: {
      durationMs: 300,
      dissolve: { pattern: "noise", edgeColor: "#ff9e40", edgeWidth: 0.1 },
    },
  };
  const mortalPlayer = tile({
    id: "player",
    height: 4,
    directional: true,
    walkable: false,
    kind: "battler",
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
    interactions: {
      battler: { baseHp: 8, masteries: { toughness: 1 }, naturalWeapon: DEFAULT_WEAPON },
    },
    transitions: WAYS,
  });
  const forming = tiles.map((def) => {
    if (def.id === "player") return mortalPlayer;
    if (def.id === "gnome") return { ...def, transitions: parseTileTransitions(WAYS) };
    return def;
  });
  const authored = withGnome(strip(6));
  const gnomePoint = pointFor(authored, GNOME_OWNER);

  it("plays a respawned creature's way in, at the slot it grew into", () => {
    const session = new GameSession(strip(6), forming);
    session.drainTransitions();

    session.respawnAt(gnomePoint);
    expect(session.drainTransitions()).toEqual([
      {
        id: expect.any(String),
        side: "appear",
        tileId: "gnome",
        x: GNOME_X,
        y: 0,
        z: 0,
        stackIndex: 1,
      },
    ]);
  });

  it("says nothing for a point that was already filled", () => {
    const session = new GameSession(authored, forming);
    session.drainTransitions();

    session.respawnAt(gnomePoint);
    expect(session.drainTransitions()).toEqual([]);
  });

  it("plays a player's way in when their body is placed", () => {
    const session = new GameSession(strip(6), forming, { actorIds: [] });
    session.drainTransitions();

    session.spawn("bob");
    const [arrived, ...rest] = session.drainTransitions();
    expect(rest).toEqual([]);
    expect(arrived).toMatchObject({ side: "appear", tileId: "player" });
    const stack = getStack(session.getMap(), arrived!.x, arrived!.y, arrived!.z);
    expect(stack[arrived!.stackIndex]?.owner).toBe("bob");
  });

  it("says nothing for a re-seat onto a board the editor replaced", () => {
    const session = new GameSession(strip(6), forming, { actorIds: [] });
    session.drainTransitions();

    session.spawn("bob", {}, { announce: false });
    expect(session.drainTransitions()).toEqual([]);
  });

  it("plays a player's way out where they stood when they leave", () => {
    const session = new GameSession(strip(6), forming, { actorIds: [] });
    session.spawn("bob");
    const [arrived] = session.drainTransitions();

    session.despawn("bob");
    expect(session.drainTransitions()).toEqual([
      { ...arrived, id: expect.any(String), side: "disappear" },
    ]);
  });

  it("plays a body's way out where it fell", () => {
    const session = new GameSession(strip(6), forming, { actorIds: [] });
    session.spawn("bob");
    const [arrived] = session.drainTransitions();

    session.runCommand("/health 0", "bob");
    expect(session.drainDeaths().map((death) => death.id)).toEqual(["bob"]);
    expect(session.drainTransitions()).toEqual([
      { ...arrived, id: expect.any(String), side: "disappear" },
    ]);
  });
});
