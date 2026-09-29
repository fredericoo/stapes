import { describe, expect, it } from "vitest";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { Coord, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { TICK_MS } from "./constants";
import { GameSession } from "./GameSession";
import { findLooseGravityCells, gravityPullOn, settleGravity } from "./gravity";
import shippedTiles from "../../data/tiles.json";
import { FRAME, tile } from "../lib/testTile";

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "box", height: 2, affectedByGravity: true }),
  tile({ id: "rock", height: 2 }),
  tile({ id: "pillar", height: 4 }),
  tile({
    id: "plate",
    height: 0,
    interactions: {
      pressurePlate: { tileId: "plate-down", type: "gte", height: 1 },
      emit: { value: "off" },
    },
  }),
  tile({
    id: "plate-down",
    height: 0,
    interactions: {
      pressurePlate: { tileId: "plate", type: "lte", height: 0 },
      emit: { value: "on" },
    },
  }),
  tile({
    id: "door",
    height: 4,
    walkable: false,
    interactions: { receive: { tileId: "door-open", when: "on", mode: "any" } },
  }),
  tile({
    id: "door-open",
    height: 0,
    interactions: { receive: { tileId: "door", when: "off", mode: "any" } },
  }),
  tile({
    id: "player",
    height: 4,
    directional: true,
    affectedByGravity: true,
    walkable: false,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
  }),
  tile({ id: "hole-floor", height: 0, intangible: true }),
  tile({ id: "shaft", height: 4, intangible: true }),
  tile({
    id: "crate",
    height: 4,
    affectedByGravity: true,
    walkable: false,
    interactions: { push: { climb: "half", moveOnTileIds: [] } },
  }),
];

const byId = tilesByIdFromList(tiles);

const ids = (stack: { tileId: string }[]) => stack.map((p) => p.tileId);

describe("what gravity is about to do", () => {
  const playerDef = byId.player!;

  it("leaves a body standing on something alone", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId: "player" }]);

    expect(gravityPullOn(map, { x: 0, y: 0, z: 0, stackIndex: 1 }, playerDef, byId)).toEqual({
      kind: "stand",
    });
  });

  it("calls a drop within climbing range a settle, not a fall", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "rock" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "player" }]);

    expect(gravityPullOn(map, { x: 0, y: 0, z: 1, stackIndex: 0 }, playerDef, byId)).toEqual({
      kind: "settle",
      landingAbs: 2,
    });
  });

  it("calls a drop too steep to climb down a fall", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "player" }]);

    expect(gravityPullOn(map, { x: 0, y: 0, z: 1, stackIndex: 0 }, playerDef, byId)).toEqual({
      kind: "fall",
      feetAbs: 4,
      landingAbs: 0,
    });
  });

  it("leaves a body over a column with nothing in it where it is", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "player" }]);

    expect(gravityPullOn(map, { x: 0, y: 0, z: 0, stackIndex: 0 }, playerDef, byId)).toEqual({
      kind: "stand",
    });
  });

  it("says nothing about a tile gravity does not act on", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "rock" }]);

    expect(gravityPullOn(map, { x: 0, y: 0, z: 1, stackIndex: 0 }, byId.rock!, byId)).toEqual({
      kind: "stand",
    });
  });
});

describe("settling loose gravity", () => {
  it("drops an unsupported body onto what is below it", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "box" }]);

    const { map: next } = settleGravity(map, findLooseGravityCells(map, byId), byId);

    expect(getStack(next, 0, 0, 1)).toHaveLength(0);
    expect(ids(getStack(next, 0, 0, 0))).toEqual(["grass", "box"]);
  });

  it("leaves a body a full floor holds up", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "pillar" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "box" }]);

    const { changed } = settleGravity(map, findLooseGravityCells(map, byId), byId);

    expect(changed).toEqual([]);
  });

  it("does not index or drop a body a runtime is driving", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "box", owner: "alice" }]);

    expect(findLooseGravityCells(map, byId)).toEqual([]);
    const cell: Coord = { x: 0, y: 0, z: 1 };
    expect(settleGravity(map, [cell], byId).changed).toEqual([]);
  });

  it("leaves a body with no gravity flag hanging", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "rock" }]);

    expect(findLooseGravityCells(map, byId)).toEqual([]);
  });

  it("leaves a body over the void where it is — nothing to land on", () => {
    const map = replaceStack(emptyMap(), 0, 0, 1, [{ tileId: "box" }]);

    const { changed } = settleGravity(map, findLooseGravityCells(map, byId), byId);

    expect(changed).toEqual([]);
    expect(ids(getStack(map, 0, 0, 1))).toEqual(["box"]);
  });
});

describe("a body that does not fall", () => {
  const shipped = (id: string): TileDef =>
    normalizeTileDef((shippedTiles as unknown as TileDef[]).find((t) => t.id === id)!);
  const flying = tilesByIdFromList([...tiles, shipped("bat"), shipped("rat")]);
  const overTheVoid = (tileId: string) => replaceStack(emptyMap(), 0, 0, 1, [{ tileId }]);

  it("is not even indexed as something the board could drop", () => {
    expect(findLooseGravityCells(overTheVoid("bat"), flying)).toEqual([]);
    expect(findLooseGravityCells(overTheVoid("rat"), flying)).toHaveLength(1);
  });

  it("stays a level up with a floor right underneath it", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "bat" }]);

    const { map: next, changed } = settleGravity(map, findLooseGravityCells(map, flying), flying);

    expect(changed).toEqual([]);
    expect(ids(getStack(next, 0, 0, 1))).toEqual(["bat"]);
  });

  it("is the only difference between it and the rat", () => {
    expect(shipped("bat").affectedByGravity).toBe(false);
    expect(shipped("rat").affectedByGravity).toBe(true);
  });
});

describe("intangible tiles are not a floor", () => {
  it("drops a body lying on an intangible floor tile", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "hole-floor" }, { tileId: "box" }]);

    const { map: next } = settleGravity(map, findLooseGravityCells(map, byId), byId);

    expect(ids(getStack(next, 0, 0, 1))).toEqual(["hole-floor"]);
    expect(ids(getStack(next, 0, 0, 0))).toEqual(["grass", "box"]);
  });

  it("falls past a level filled by nothing but intangibles", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "shaft" }]);
    map = replaceStack(map, 0, 0, 2, [{ tileId: "box" }]);

    const { map: next } = settleGravity(map, findLooseGravityCells(map, byId), byId);

    expect(getStack(next, 0, 0, 2)).toHaveLength(0);
    expect(ids(getStack(next, 0, 0, 0))).toEqual(["grass", "box"]);
  });

  it("still rests on the solid tile under the intangible one", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 1, [
      { tileId: "pillar" },
      { tileId: "shaft" },
      { tileId: "box" },
    ]);

    const { changed } = settleGravity(map, findLooseGravityCells(map, byId), byId);

    expect(changed).toEqual([]);
  });

  it("walks a player into a hole and drops them through it", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "pillar" }, { tileId: "player", direction: "e" }]);
    map = replaceStack(map, 1, 0, 1, [{ tileId: "hole-floor" }]);

    const session = new GameSession(map, tiles);
    const player = session.actorIds()[0]!;
    expect(session.requestStep(player, "e")).toBe("started");
    for (let i = 0; i < 60; i++) session.tick(TICK_MS);

    expect(ids(getStack(session.getMap(), 1, 0, 1))).toEqual(["hole-floor"]);
    expect(ids(getStack(session.getMap(), 1, 0, 0))).toEqual(["grass", "player"]);
  });
});

describe("a crate in a running world", () => {
  const spawn = { x: 0, y: 0, z: 0, stackIndex: 0 };

  it("lands where its load implies the moment the world opens", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "box" }]);

    const session = new GameSession(map, tiles, { actorIds: [], spawnAt: spawn });

    expect(ids(getStack(session.getMap(), 0, 0, 0))).toEqual(["grass", "box"]);
  });

  it("drops onto a plate, presses it, and opens the door it drives", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "plate", channel: "gate" }]);
    map = replaceStack(map, 3, 0, 0, [{ tileId: "door", channel: "gate" }]);
    map = replaceStack(map, 1, 0, 1, [{ tileId: "box" }]);

    const session = new GameSession(map, tiles, { actorIds: [], spawnAt: spawn });
    const at = (c: Coord) => ids(getStack(session.getMap(), c.x, c.y, c.z));

    expect(at({ x: 1, y: 0, z: 0 })).toEqual(["plate-down", "box"]);
    expect(at({ x: 3, y: 0, z: 0 })).toContain("door-open");
  });

  it("drops a body when its support is pushed out from under it", () => {
    let map = emptyMap();
    for (let x = 0; x <= 3; x++) {
      map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
    }
    map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "e" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "crate" }]);
    map = replaceStack(map, 1, 0, 1, [{ tileId: "box" }]);

    const session = new GameSession(map, tiles);
    expect(ids(getStack(session.getMap(), 1, 0, 1))).toEqual(["box"]);

    expect(session.push({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(true);
    for (let i = 0; i < 4; i++) session.tick(TICK_MS);

    expect(getStack(session.getMap(), 1, 0, 1)).toHaveLength(0);
    expect(ids(getStack(session.getMap(), 1, 0, 0))).toEqual(["grass", "box"]);
  });

  it("stays put once landed, rather than re-dropping every tick", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "box" }]);
    const session = new GameSession(map, tiles, { actorIds: [], spawnAt: spawn });

    for (let i = 0; i < 10; i++) session.tick(TICK_MS);

    expect(ids(getStack(session.getMap(), 0, 0, 0))).toEqual(["grass", "box"]);
    expect(session.isAtRest()).toBe(true);
  });
});
