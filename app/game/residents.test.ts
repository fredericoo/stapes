import { describe, expect, it } from "vitest";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { MapFile, PlacedTile, TileDef } from "../lib/types";
import { FALL_MS_PER_HEIGHT, TICK_MS } from "./constants";
import { GameSession } from "./GameSession";
import { FRAME, tile } from "../lib/testTile";

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({
    id: "player",
    height: 4,
    directional: true,
    affectedByGravity: true,
    walkable: false,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
  }),
  tile({ id: "deer", height: 2, actor: true, affectedByGravity: true, walkable: false }),
  tile({ id: "ghost", height: 2, actor: true, walkable: false }),
  tile({
    id: "plate",
    height: 0,
    interactions: {
      pressurePlate: { tileId: "plate-pressed", type: "gte", height: 1 },
    },
  }),
  tile({ id: "plate-pressed", height: 0 }),
];

function strip(width: number): MapFile {
  let map = emptyMap();
  for (let x = 0; x < width; x++) {
    map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
  }
  map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "e" }]);
  return map;
}

function withBody(map: MapFile, x: number, tileId: string): MapFile {
  return replaceStack(map, x, 0, 0, [{ tileId: "grass" }, { tileId }]);
}

function placedAt(map: MapFile, x: number, y: number, z: number): PlacedTile[] {
  return getStack(map, x, y, z);
}

function ownersAt(map: MapFile, x: number, y: number, z: number) {
  return placedAt(map, x, y, z).map((placed) => placed.owner);
}

function advance(session: GameSession, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
    session.tick(TICK_MS);
  }
}

describe("adopting residents", () => {
  it("makes an actor of every body placed in the map", () => {
    const session = new GameSession(withBody(strip(4), 2, "deer"), tiles, { actorIds: [] });

    expect(session.actorIds()).toHaveLength(1);
    expect(session.actorIds()[0]).toMatch(/^npc:/);
  });

  it("mints an identity from where the body was authored", () => {
    const session = new GameSession(withBody(strip(4), 2, "deer"), tiles, { actorIds: [] });

    expect(session.actorIds()).toEqual(["npc:2,0,0,1"]);
    expect(ownersAt(session.getMap(), 2, 0, 0)).toEqual([undefined, "npc:2,0,0,1"]);
  });

  it("tells two bodies in one cell apart", () => {
    let map = strip(4);
    map = replaceStack(map, 2, 0, 0, [
      { tileId: "grass" },
      { tileId: "deer" },
      { tileId: "ghost" },
    ]);

    const session = new GameSession(map, tiles, { actorIds: [] });

    expect(new Set(session.actorIds()).size).toBe(2);
  });

  it("leaves the authored spawn marker alone", () => {
    const session = new GameSession(strip(4), tiles, { actorIds: [] });

    expect(session.actorIds()).toEqual([]);
  });

  it("does not adopt a connected player as a resident", () => {
    const session = new GameSession(strip(4), tiles, { actorIds: ["alice"] });

    expect(session.actorIds()).toEqual(["alice"]);
  });

  it("keeps the identity a resumed body already carries", () => {
    const first = new GameSession(withBody(strip(4), 2, "deer"), tiles, { actorIds: [] });
    const id = first.actorIds()[0]!;

    const resumed = new GameSession(first.getMap(), tiles, {
      actorIds: [],
      spawnAt: {
        x: 0,
        y: 0,
        z: 0,
        stackIndex: 1,
      },
    });

    expect(resumed.actorIds()).toEqual([id]);
    expect(placedAt(resumed.getMap(), 2, 0, 0)).toHaveLength(2);
  });
});

describe("residents and the reaper", () => {
  it("keeps residents while removing players nobody is driving", () => {
    const session = new GameSession(withBody(strip(4), 2, "deer"), tiles, {
      actorIds: ["alice", "bob"],
    });

    session.reapAbsentActors(["alice"]);

    const owners = session.actorIds();
    expect(owners).toContain("alice");
    expect(owners.some((id) => id.startsWith("npc:"))).toBe(true);
    expect(placedAt(session.getMap(), 2, 0, 0)).toHaveLength(2);
    expect(ownersAt(session.getMap(), 0, 0, 0)).not.toContain("bob");
  });
});

describe("a resident is its own tile", () => {
  it("does not fall a body its tile says gravity ignores", () => {
    let map = strip(4);
    map = replaceStack(map, 2, 0, 1, [{ tileId: "ghost" }]);

    const session = new GameSession(map, tiles, { actorIds: [] });
    advance(session, FALL_MS_PER_HEIGHT * 4);

    expect(placedAt(session.getMap(), 2, 0, 1)).toHaveLength(1);
  });

  it("falls a body its tile says gravity does not", () => {
    let map = strip(4);
    map = replaceStack(map, 2, 0, 1, [{ tileId: "deer" }]);

    const session = new GameSession(map, tiles, { actorIds: [] });
    advance(session, FALL_MS_PER_HEIGHT * 4);

    expect(placedAt(session.getMap(), 2, 0, 1)).toHaveLength(0);
    expect(placedAt(session.getMap(), 2, 0, 0).map((p) => p.tileId)).toContain("deer");
  });

  it("presses a pressure plate by standing on it", () => {
    let map = strip(4);
    map = replaceStack(map, 2, 0, 0, [{ tileId: "plate" }, { tileId: "deer" }]);

    const session = new GameSession(map, tiles, { actorIds: [] });

    expect(placedAt(session.getMap(), 2, 0, 0)[0]!.tileId).toBe("plate-pressed");
  });
});

describe("a world nobody is watching", () => {
  it("comes to rest with residents on the board and nobody connected", () => {
    const session = new GameSession(withBody(strip(4), 2, "deer"), tiles, { actorIds: [] });
    advance(session, FALL_MS_PER_HEIGHT * 4);

    expect(session.isAtRest()).toBe(true);
  });

  it("stays awake while a resident is still falling", () => {
    let map = strip(4);
    map = replaceStack(map, 2, 0, 2, [{ tileId: "deer" }]);

    const session = new GameSession(map, tiles, { actorIds: [] });
    advance(session, FALL_MS_PER_HEIGHT / 2);

    expect(session.isAtRest()).toBe(false);
  });
});
