import { describe, expect, it } from "vitest";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { Direction, MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { TICK_MS, WALK_DURATION_MS } from "./constants";
import { GameSession, LOCAL_ACTOR_ID } from "./GameSession";
import { standingAbs } from "./movement";
import { findPlayers } from "./player";

function tile(
  partial: Record<string, unknown> & Pick<TileDef, "id" | "height">,
): TileDef {
  const frame = {
    sprite: {
      tilesetId: "basic",
      rect: { x: 0, y: 0, w: 1, h: 1 },
      base: { x: 0, y: 0 },
    },
    durationMs: 200,
  };
  return normalizeTileDef({
    name: partial.id,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    ...partial,
  });
}

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
  tile({ id: "wall", height: 2, walkable: false }),
  tile({
    id: "player",
    height: 2,
    directional: true,
    affectedByGravity: true,
    walkable: false,
    variants: directionalFrames(),
  }),
  tile({
    id: "crate",
    height: 1,
    affectedByGravity: true,
    interactions: { push: { climb: "half", moveOnTileIds: [] } },
  }),
];

/** A strip of grass along y=0, with the authored spawn marker at x=0. */
function strip(width: number): MapFile {
  let map = emptyMap();
  for (let x = 0; x < width; x++) {
    map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, x, 1, 0, [{ tileId: "grass" }]);
  }
  map = replaceStack(map, 0, 0, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "e" },
  ]);
  return map;
}

/**
 * Long enough for a walk to start *and* commit.
 *
 * A walk begins on one tick and finishes only once WALK_DURATION_MS has
 * accumulated after that, so advancing exactly one walk's worth leaves it a
 * tick short — the same margin the single-actor suites use.
 */
const ONE_WALK_MS = WALK_DURATION_MS + 80;

const tilesById = tilesByIdFromList(tiles);

/** Run whole ticks worth of `ms`, as the render loop would. */
function advance(session: GameSession, ms: number) {
  session.update(ms);
}

/** Walk exactly one cell, releasing input so the commit does not chain. */
function step(session: GameSession, direction: Direction, id: string) {
  session.setInput({ directions: [direction] }, id);
  session.update(TICK_MS);
  session.setInput({ directions: [] }, id);
  advance(session, ONE_WALK_MS);
}

function idsAt(session: GameSession, x: number, y: number, z = 0): string[] {
  return getStack(session.getMap(), x, y, z).map((p) => p.tileId);
}

function ownersAt(
  session: GameSession,
  x: number,
  y: number,
  z = 0,
): (string | undefined)[] {
  return getStack(session.getMap(), x, y, z).map((p) => p.owner);
}

describe("actor lifecycle", () => {
  it("adopts the authored player tile for the first actor, keeping its slot", () => {
    const session = new GameSession(strip(3), tiles);
    // Adoption, not remove-and-respawn: the tile stays at stack index 1, which
    // is what it was standing on.
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
    // Part-way through the walk, so `b` has a committed cell and a live lerp.
    advance(session, WALK_DURATION_MS / 2);
    expect(session.getSnapshot("b").self.walk).not.toBeNull();

    session.despawn("b");
    advance(session, ONE_WALK_MS);

    expect(findPlayers(session.getMap()).map((p) => p.placed.owner)).toEqual([
      "a",
    ]);
    expect(session.actorIds()).toEqual(["a"]);
  });

  it("throws for an actor that is not in the session", () => {
    const session = new GameSession(strip(3), tiles);
    expect(() => session.getSnapshot("nobody")).toThrow(/No actor/);
  });

  /**
   * Starting a session consumes the authored marker, so a map that has already
   * been run cannot be handed back without its spawn point — there is no tile
   * left to read it from. The server checkpoints the two together for exactly
   * this reason.
   */
  /**
   * The server resumes worlds from a checkpoint whose map already holds every
   * actor's tile. Spawning them again would mint a second body, and `despawn`
   * only ever removes one — so the first would linger forever.
   */
  it("re-seats an actor who already has a tile instead of minting a second", () => {
    const first = new GameSession(strip(4), tiles, { actorIds: ["a"] });
    first.setInput({ directions: ["e"] }, "a");
    first.update(ONE_WALK_MS);
    const ranMap = first.getMap();
    const spawn = first.getSpawnPoint();
    expect(first.getSnapshot("a").self.x).toBe(1);

    const resumed = new GameSession(ranMap, tiles, { actorIds: ["a"], spawnAt: spawn });

    expect(findPlayers(resumed.getMap())).toHaveLength(1);
    // And re-seated where they were, not sent back to spawn.
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
    expect(ownersAt(resumed, spawn.x, spawn.y, spawn.z)).toEqual([
      undefined,
      "a",
    ]);
  });
});

describe("two actors on one board", () => {
  it("each walks under its own input", () => {
    const session = new GameSession(strip(5), tiles, { actorIds: ["a", "b"] });
    session.setInput({ directions: ["e"] }, "a");
    advance(session, ONE_WALK_MS);

    expect(session.getSnapshot("a").self.x).toBe(1);
    // `b` never pressed anything and stayed home.
    expect(session.getSnapshot("b").self.x).toBe(0);
  });

  it("sees each other in the snapshot, in stable id order", () => {
    const session = new GameSession(strip(5), tiles, { actorIds: ["a", "b"] });
    const snap = session.getSnapshot("a");

    expect(snap.actors.map((actor) => actor.id)).toEqual(["a", "b"]);
    expect(snap.self.id).toBe("a");
  });

  it("lets both into a contested cell, on the same tick", () => {
    // Both stand on x=0 and both press east. Neither reserves the cell against
    // the other, so the tick that ends is the tick they both arrive.
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
    // Put `a` directly east of the spawn cell, then `b` on the spawn cell.
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

    // Same cell, same level, and neither has been lifted a level by the other's
    // volume — the second body would otherwise read the first's head as ground.
    const a = session.getSnapshot("a").self;
    const b = session.getSnapshot("b").self;
    expect(a.z).toBe(0);
    expect(b.z).toBe(0);
    expect(
      standingAbs(session.getMap(), 1, 0, 0, a.stackIndex, tilesById),
    ).toBe(0);
    expect(
      standingAbs(session.getMap(), 1, 0, 0, b.stackIndex, tilesById),
    ).toBe(0);
  });

  it("puts a joining actor down on top of one already standing there", () => {
    const session = new GameSession(strip(3), tiles, { actorIds: [] });
    session.spawn("a");
    session.spawn("b");

    // Both at the spawn cell, rather than `b` bubbling out to a free neighbour.
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
  /** Grass strip with a crate at `crateX` and both actors at the origin. */
  function withCrate(crateX: number, width = 6): MapFile {
    let map = strip(width);
    map = replaceStack(map, crateX, 0, 0, [
      { tileId: "grass" },
      { tileId: "crate" },
    ]);
    return map;
  }

  it("lets one actor push a crate the other can then see moved", () => {
    const session = new GameSession(withCrate(1), tiles, { actorIds: ["a", "b"] });
    expect(session.push({ x: 1, y: 0, z: 0, stackIndex: 1 }, "a")).toBe(true);

    expect(idsAt(session, 1, 0)).toEqual(["grass"]);
    expect(idsAt(session, 2, 0)).toEqual(["grass", "crate"]);
    // The board is shared, so the other actor reads the same map.
    expect(session.getSnapshot("b").map).toBe(session.getMap());
  });

  it("charges the slide to the pusher alone", () => {
    const session = new GameSession(withCrate(1), tiles, { actorIds: ["a", "b"] });
    session.push({ x: 1, y: 0, z: 0, stackIndex: 1 }, "a");

    expect(session.getSnapshot("a").self.slide).not.toBeNull();
    // `b` did not shove anything, so nothing of theirs is catching up.
    expect(session.getSnapshot("b").self.slide).toBeNull();
  });

  it("refuses a push from an actor who is not adjacent", () => {
    const session = new GameSession(withCrate(3), tiles, { actorIds: ["a", "b"] });
    // Both are at x=0; the crate is three cells away.
    expect(session.canPush({ x: 3, y: 0, z: 0, stackIndex: 1 }, "b")).toBe(
      false,
    );
    expect(session.push({ x: 3, y: 0, z: 0, stackIndex: 1 }, "b")).toBe(false);
  });
});
