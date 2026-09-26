import { describe, expect, it } from "vitest";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { Direction, MapFile, TileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { TICK_MS, WALK_DURATION_MS } from "./constants";
import { GameSession, LOCAL_ACTOR_ID } from "./GameSession";
import { standingAbs } from "./movement";
import { findPlayers } from "./player";
import { tile } from "../lib/testTile";

const directionalFrames = () => {
  const frame = {
    sprite: {
      tilesetId: "basic",
      rect: { x: 0, y: 0, w: 1, h: 1 },
      base: { x: 0, y: 0 },
    },
    durationMs: 200,
  };
  return { n: [frame], e: [frame], s: [frame], w: [frame] };
};

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "wall", height: 4, walkable: false }),
  tile({
    id: "player",
    height: 4,
    directional: true,
    affectedByGravity: true,
    walkable: false,
    variants: directionalFrames(),
  }),
  tile({
    id: "crate",
    height: 2,
    affectedByGravity: true,
    interactions: { push: { climb: "half", moveOnTileIds: [] } },
  }),
];

function strip(width: number): MapFile {
  let map = emptyMap();
  for (let x = 0; x < width; x++) {
    map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, x, 1, 0, [{ tileId: "grass" }]);
  }
  map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "e" }]);
  return map;
}

const ONE_WALK_MS = WALK_DURATION_MS + 80;

const tilesById = tilesByIdFromList(tiles);

function advance(session: GameSession, ms: number) {
  session.update(ms);
}

function step(session: GameSession, direction: Direction, id: string) {
  session.setInput({ directions: [direction] }, id);
  session.update(TICK_MS);
  session.setInput({ directions: [] }, id);
  advance(session, ONE_WALK_MS);
}

function idsAt(session: GameSession, x: number, y: number, z = 0): string[] {
  return getStack(session.getMap(), x, y, z).map((p) => p.tileId);
}

function ownersAt(session: GameSession, x: number, y: number, z = 0): (string | undefined)[] {
  return getStack(session.getMap(), x, y, z).map((p) => p.owner);
}

describe("actor lifecycle", () => {
  it("adopts the authored player tile for the first actor, keeping its slot", () => {
    const session = new GameSession(strip(3), tiles);
    expect(idsAt(session, 0, 0)).toEqual(["grass", "player"]);
    expect(ownersAt(session, 0, 0)).toEqual([undefined, LOCAL_ACTOR_ID]);
    expect(session.actorIds()).toEqual([LOCAL_ACTOR_ID]);
  });

  it("opens an empty world with no avatar on the board", () => {
    const session = new GameSession(strip(3), tiles, { actorIds: [] });
    expect(idsAt(session, 0, 0)).toEqual(["grass"]);
    expect(findPlayers(session.getMap())).toHaveLength(0);
    expect(session.actorIds()).toEqual([]);
  });

  it("spawns every actor at the authored marker's cell", () => {
    const session = new GameSession(strip(3), tiles, { actorIds: [] });
    session.spawn("a");
    session.spawn("b");

    expect(idsAt(session, 0, 0)).toEqual(["grass", "player", "player"]);
    expect(ownersAt(session, 0, 0)).toEqual([undefined, "a", "b"]);
  });

  it("removes an actor's tile when they leave", () => {
    const session = new GameSession(strip(3), tiles, { actorIds: ["a", "b"] });
    expect(findPlayers(session.getMap())).toHaveLength(2);

    session.despawn("a");

    expect(findPlayers(session.getMap())).toHaveLength(1);
    expect(ownersAt(session, 0, 0)).toEqual([undefined, "b"]);
    expect(session.actorIds()).toEqual(["b"]);
  });

  it("leaves mid-walk without stranding the tile", () => {
    const session = new GameSession(strip(4), tiles, { actorIds: ["a", "b"] });
    session.setInput({ directions: ["e"] }, "b");
    advance(session, WALK_DURATION_MS / 2);
    expect(session.getSnapshot("b").self.walk).not.toBeNull();

    session.despawn("b");
    advance(session, ONE_WALK_MS);

    expect(findPlayers(session.getMap()).map((p) => p.placed.owner)).toEqual(["a"]);
    expect(session.actorIds()).toEqual(["a"]);
  });

  it("throws for an actor that is not in the session", () => {
    const session = new GameSession(strip(3), tiles);
    expect(() => session.getSnapshot("nobody")).toThrow(/No actor/);
  });

  it("re-seats an actor who already has a tile instead of minting a second", () => {
    const first = new GameSession(strip(4), tiles, { actorIds: ["a"] });
    first.setInput({ directions: ["e"] }, "a");
    first.update(ONE_WALK_MS);
    const ranMap = first.getMap();
    const spawn = first.getSpawnPoint();
    expect(first.getSnapshot("a").self.x).toBe(1);

    const resumed = new GameSession(ranMap, tiles, { actorIds: ["a"], spawnAt: spawn });

    expect(findPlayers(resumed.getMap())).toHaveLength(1);
    expect(resumed.getSnapshot("a").self.x).toBe(1);
  });

  it("reaps actors whose connections are gone", () => {
    const session = new GameSession(strip(3), tiles, { actorIds: ["a", "b", "c"] });
    expect(findPlayers(session.getMap())).toHaveLength(3);

    session.reapAbsentActors(["b"]);

    const owners = findPlayers(session.getMap()).map((p) => p.placed.owner);
    expect(owners).toEqual(["b"]);
  });

  it("resumes a map whose marker was already consumed", () => {
    const first = new GameSession(strip(3), tiles, { actorIds: [] });
    const ranMap = first.getMap();
    const spawn = first.getSpawnPoint();
    expect(findPlayers(ranMap)).toHaveLength(0);

    expect(() => new GameSession(ranMap, tiles, { actorIds: [] })).toThrow(/No tile/);

    const resumed = new GameSession(ranMap, tiles, { actorIds: [], spawnAt: spawn });
    resumed.spawn("a");
    expect(ownersAt(resumed, spawn.x, spawn.y, spawn.z)).toEqual([undefined, "a"]);
  });
});

describe("two actors on one board", () => {
  it("each walks under its own input", () => {
    const session = new GameSession(strip(5), tiles, { actorIds: ["a", "b"] });
    session.setInput({ directions: ["e"] }, "a");
    advance(session, ONE_WALK_MS);

    expect(session.getSnapshot("a").self.x).toBe(1);
    expect(session.getSnapshot("b").self.x).toBe(0);
  });

  it("sees each other in the snapshot, in stable id order", () => {
    const session = new GameSession(strip(5), tiles, { actorIds: ["a", "b"] });
    const snap = session.getSnapshot("a");

    expect(snap.actors.map((actor) => actor.id)).toEqual(["a", "b"]);
    expect(snap.self.id).toBe("a");
  });

  it("lets both into a contested cell, on the same tick", () => {
    const session = new GameSession(strip(3), tiles, { actorIds: ["a", "b"] });
    session.setInput({ directions: ["e"] }, "a");
    session.setInput({ directions: ["e"] }, "b");
    advance(session, ONE_WALK_MS);

    expect(session.getSnapshot("a").self.x).toBe(1);
    expect(session.getSnapshot("b").self.x).toBe(1);
    expect(idsAt(session, 1, 0)).toEqual(["grass", "player", "player"]);
  });

  it("walks into the cell another actor is standing in", () => {
    const session = new GameSession(strip(3), tiles, { actorIds: [] });
    session.spawn("a");
    step(session, "e", "a");
    session.spawn("b");
    expect(session.getSnapshot("a").self.x).toBe(1);
    expect(session.getSnapshot("b").self.x).toBe(0);

    step(session, "e", "b");

    expect(session.getSnapshot("b").self.x).toBe(1);
    expect(ownersAt(session, 1, 0)).toEqual([undefined, "a", "b"]);
  });

  it("stands both bodies on the floor rather than one on the other", () => {
    const session = new GameSession(strip(3), tiles, { actorIds: ["a", "b"] });
    session.setInput({ directions: ["e"] }, "a");
    session.setInput({ directions: ["e"] }, "b");
    advance(session, ONE_WALK_MS);

    const a = session.getSnapshot("a").self;
    const b = session.getSnapshot("b").self;
    expect(a.z).toBe(0);
    expect(b.z).toBe(0);
    expect(standingAbs(session.getMap(), 1, 0, 0, a.stackIndex, tilesById)).toBe(0);
    expect(standingAbs(session.getMap(), 1, 0, 0, b.stackIndex, tilesById)).toBe(0);
  });

  it("puts a joining actor down on top of one already standing there", () => {
    const session = new GameSession(strip(3), tiles, { actorIds: [] });
    session.spawn("a");
    session.spawn("b");

    expect(session.getSnapshot("b").self).toMatchObject({ x: 0, y: 0 });
    expect(ownersAt(session, 0, 0)).toEqual([undefined, "a", "b"]);
  });

  it("leaves nothing behind when the first of two walks away", () => {
    const session = new GameSession(strip(3), tiles, { actorIds: [] });
    session.spawn("a");
    session.spawn("b");
    step(session, "e", "a");

    expect(ownersAt(session, 0, 0)).toEqual([undefined, "b"]);
    expect(ownersAt(session, 1, 0)).toEqual([undefined, "a"]);
  });
});

describe("actors and shared objects", () => {
  function withCrate(crateX: number, width = 6): MapFile {
    let map = strip(width);
    map = replaceStack(map, crateX, 0, 0, [{ tileId: "grass" }, { tileId: "crate" }]);
    return map;
  }

  it("lets one actor push a crate the other can then see moved", () => {
    const session = new GameSession(withCrate(1), tiles, { actorIds: ["a", "b"] });
    expect(session.push({ x: 1, y: 0, z: 0, stackIndex: 1 }, "a")).toBe(true);

    expect(idsAt(session, 1, 0)).toEqual(["grass"]);
    expect(idsAt(session, 2, 0)).toEqual(["grass", "crate"]);
    expect(session.getSnapshot("b").map).toBe(session.getMap());
  });

  it("charges the slide to the pusher alone", () => {
    const session = new GameSession(withCrate(1), tiles, { actorIds: ["a", "b"] });
    session.push({ x: 1, y: 0, z: 0, stackIndex: 1 }, "a");

    expect(session.getSnapshot("a").self.slide).not.toBeNull();
    expect(session.getSnapshot("b").self.slide).toBeNull();
  });

  it("refuses a push from an actor who is not adjacent", () => {
    const session = new GameSession(withCrate(3), tiles, { actorIds: ["a", "b"] });
    expect(session.canPush({ x: 3, y: 0, z: 0, stackIndex: 1 }, "b")).toBe(false);
    expect(session.push({ x: 3, y: 0, z: 0, stackIndex: 1 }, "b")).toBe(false);
  });
});
