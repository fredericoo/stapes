import { describe, expect, it } from "vitest";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { WALK_DURATION_MS } from "./constants";
import { GameSession, LOCAL_ACTOR_ID } from "./GameSession";
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

/** Run whole ticks worth of `ms`, as the render loop would. */
function advance(session: GameSession, ms: number) {
  session.update(ms);
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
    const session = new GameSession(strip(3), tiles, []);
    expect(idsAt(session, 0, 0)).toEqual(["grass"]);
    expect(findPlayers(session.getMap())).toHaveLength(0);
    expect(session.actorIds()).toEqual([]);
  });

  it("spawns every actor at the authored marker's cell", () => {
    const session = new GameSession(strip(3), tiles, []);
    session.spawn("a");
    session.spawn("b");

    expect(idsAt(session, 0, 0)).toEqual(["grass", "player", "player"]);
    expect(ownersAt(session, 0, 0)).toEqual([undefined, "a", "b"]);
  });

  it("removes an actor's tile when they leave", () => {
    const session = new GameSession(strip(3), tiles, ["a", "b"]);
    expect(findPlayers(session.getMap())).toHaveLength(2);

    session.despawn("a");

    expect(findPlayers(session.getMap())).toHaveLength(1);
    expect(ownersAt(session, 0, 0)).toEqual([undefined, "b"]);
    expect(session.actorIds()).toEqual(["b"]);
  });

  it("leaves mid-walk without stranding the tile", () => {
    const session = new GameSession(strip(4), tiles, ["a", "b"]);
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
});

describe("two actors on one board", () => {
  it("each walks under its own input", () => {
    const session = new GameSession(strip(5), tiles, ["a", "b"]);
    session.setInput({ directions: ["e"] }, "a");
    advance(session, ONE_WALK_MS);

    expect(session.getSnapshot("a").self.x).toBe(1);
    // `b` never pressed anything and stayed home.
    expect(session.getSnapshot("b").self.x).toBe(0);
  });

  it("sees each other in the snapshot, in stable id order", () => {
    const session = new GameSession(strip(5), tiles, ["a", "b"]);
    const snap = session.getSnapshot("a");

    expect(snap.actors.map((actor) => actor.id)).toEqual(["a", "b"]);
    expect(snap.self.id).toBe("a");
  });

  it("resolves a contested cell by actor order, not by both entering it", () => {
    // Both stand on x=0 and both press east; only one may occupy x=1, since
    // the player tile is not walkable.
    const session = new GameSession(strip(3), tiles, ["a", "b"]);
    session.setInput({ directions: ["e"] }, "a");
    session.setInput({ directions: ["e"] }, "b");
    advance(session, ONE_WALK_MS);

    const a = session.getSnapshot("a").self;
    const b = session.getSnapshot("b").self;
    expect(a.x).toBe(1);
    expect(b.x).toBe(0);
    expect(idsAt(session, 1, 0)).toEqual(["grass", "player"]);
  });

  it("blocks a walk into the cell another actor is standing in", () => {
    const session = new GameSession(strip(3), tiles, []);
    session.spawn("a");
    // Put `b` directly east of the spawn cell.
    session.setInput({ directions: ["e"] }, "a");
    advance(session, ONE_WALK_MS);
    session.spawn("b");
    expect(session.getSnapshot("a").self.x).toBe(1);
    expect(session.getSnapshot("b").self.x).toBe(0);

    // `b` walks east into `a`, and gets nowhere.
    session.setInput({ directions: ["e"] }, "b");
    advance(session, ONE_WALK_MS * 2);

    expect(session.getSnapshot("b").self.x).toBe(0);
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
    const session = new GameSession(withCrate(1), tiles, ["a", "b"]);
    expect(session.push({ x: 1, y: 0, z: 0, stackIndex: 1 }, "a")).toBe(true);

    expect(idsAt(session, 1, 0)).toEqual(["grass"]);
    expect(idsAt(session, 2, 0)).toEqual(["grass", "crate"]);
    // The board is shared, so the other actor reads the same map.
    expect(session.getSnapshot("b").map).toBe(session.getMap());
  });

  it("charges the slide to the pusher alone", () => {
    const session = new GameSession(withCrate(1), tiles, ["a", "b"]);
    session.push({ x: 1, y: 0, z: 0, stackIndex: 1 }, "a");

    expect(session.getSnapshot("a").self.slide).not.toBeNull();
    // `b` did not shove anything, so nothing of theirs is catching up.
    expect(session.getSnapshot("b").self.slide).toBeNull();
  });

  it("refuses a push from an actor who is not adjacent", () => {
    const session = new GameSession(withCrate(3), tiles, ["a", "b"]);
    // Both are at x=0; the crate is three cells away.
    expect(session.canPush({ x: 3, y: 0, z: 0, stackIndex: 1 }, "b")).toBe(
      false,
    );
    expect(session.push({ x: 3, y: 0, z: 0, stackIndex: 1 }, "b")).toBe(false);
  });

  it("keeps hover per actor", () => {
    const session = new GameSession(withCrate(1), tiles, ["a", "b"]);
    const crate = { x: 1, y: 0, z: 0, stackIndex: 1 };
    session.setHoveredObject(crate, "a");

    expect(session.getSnapshot("a").hover).toEqual(crate);
    expect(session.getSnapshot("b").hover).toBeNull();
  });
});
