import { describe, expect, it } from "vitest";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { MapFile, PlacedTile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { FALL_MS_PER_HEIGHT, TICK_MS } from "./constants";
import { GameSession } from "./GameSession";

/**
 * Bodies that live in the map rather than arriving on a socket.
 *
 * The whole of putting an NPC in the world is placing its tile, so this is
 * mostly about what happens at *load*: who gets adopted, who keeps the identity
 * they were given last time, and who survives a cleanup pass aimed at
 * connections that died. The motion itself is deliberately untested here —
 * a resident walks and falls through the same code a player does, and that code
 * has its own suites.
 */

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
  tile({
    id: "player",
    height: 4,
    directional: true,
    affectedByGravity: true,
    walkable: false,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
  }),
  // A deer falls, like the player does.
  tile({
    id: "deer",
    height: 2,
    actor: true,
    affectedByGravity: true,
    walkable: false,
  }),
  // A ghost is a body that gravity has no opinion about, which is the case the
  // player tile would never have exercised.
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

/** Put a body on the grass at `x`, and hand back the map. */
function withBody(map: MapFile, x: number, tileId: string): MapFile {
  return replaceStack(map, x, 0, 0, [{ tileId: "grass" }, { tileId }]);
}

function placedAt(map: MapFile, x: number, y: number, z: number): PlacedTile[] {
  return getStack(map, x, y, z);
}

/** Owners of every placement in a cell, in stack order. */
function ownersAt(map: MapFile, x: number, y: number, z: number) {
  return placedAt(map, x, y, z).map((placed) => placed.owner);
}

/**
 * Advance in whole ticks.
 *
 * Not `update`, which deliberately caps how far a single call will catch up —
 * handing it a whole fall's worth of milliseconds silently runs ten ticks and
 * stops, so a drop that needs longer never lands and the assertion passes or
 * fails for the wrong reason.
 */
function advance(session: GameSession, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
    session.tick(TICK_MS);
  }
}

describe("adopting residents", () => {
  it("makes an actor of every body placed in the map", () => {
    const session = new GameSession(withBody(strip(4), 2, "deer"), tiles, {
      actorIds: [],
    });

    // The deer is driving itself; nobody has connected.
    expect(session.actorIds()).toHaveLength(1);
    expect(session.actorIds()[0]).toMatch(/^npc:/);
  });

  it("mints an identity from where the body was authored", () => {
    const session = new GameSession(withBody(strip(4), 2, "deer"), tiles, {
      actorIds: [],
    });

    expect(session.actorIds()).toEqual(["npc:2,0,0,1"]);
    expect(ownersAt(session.getMap(), 2, 0, 0)).toEqual([
      undefined,
      "npc:2,0,0,1",
    ]);
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

  /**
   * The authored `player` tile wears the same flag — it is a body — but it is a
   * spawn marker the session consumes, and adopting it as wildlife would leave
   * an unowned avatar standing on the spawn point of every world.
   */
  it("leaves the authored spawn marker alone", () => {
    const session = new GameSession(strip(4), tiles, { actorIds: [] });

    expect(session.actorIds()).toEqual([]);
  });

  it("does not adopt a connected player as a resident", () => {
    const session = new GameSession(strip(4), tiles, { actorIds: ["alice"] });

    expect(session.actorIds()).toEqual(["alice"]);
  });

  /**
   * Regression shape: a resumed world already carries the owners minted the
   * first time it loaded. Re-minting would hand the same creature a second
   * identity, and the runtime that drives the first would never find its body.
   */
  it("keeps the identity a resumed body already carries", () => {
    const first = new GameSession(withBody(strip(4), 2, "deer"), tiles, {
      actorIds: [],
    });
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
    // And exactly one body, rather than the original plus a fresh one.
    expect(placedAt(resumed.getMap(), 2, 0, 0)).toHaveLength(2);
  });
});

describe("residents and the reaper", () => {
  /**
   * The cleanup pass exists for connections that died while the object was
   * evicted. A resident is nobody's connection, so it is absent from every list
   * of who is present — and reaping on that alone emptied the world.
   */
  it("keeps residents while removing players nobody is driving", () => {
    const session = new GameSession(withBody(strip(4), 2, "deer"), tiles, {
      actorIds: ["alice", "bob"],
    });

    session.reapAbsentActors(["alice"]);

    const owners = session.actorIds();
    expect(owners).toContain("alice");
    expect(owners.some((id) => id.startsWith("npc:"))).toBe(true);
    expect(placedAt(session.getMap(), 2, 0, 0)).toHaveLength(2);
    // Bob's body is gone from the board, which is the point of the pass.
    expect(ownersAt(session.getMap(), 0, 0, 0)).not.toContain("bob");
  });
});

describe("a resident is its own tile", () => {
  /**
   * Every actor used to move as the player def, which was true while every
   * actor was a person. A body that gravity has no opinion about is the cheapest
   * proof that it no longer is.
   */
  it("does not fall a body its tile says gravity ignores", () => {
    let map = strip(4);
    // One level up, over open air.
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

    // Landed on the grass a level down, and left nothing behind.
    expect(placedAt(session.getMap(), 2, 0, 1)).toHaveLength(0);
    expect(placedAt(session.getMap(), 2, 0, 0).map((p) => p.tileId)).toContain(
      "deer",
    );
  });

  it("presses a pressure plate by standing on it", () => {
    let map = strip(4);
    map = replaceStack(map, 2, 0, 0, [{ tileId: "plate" }, { tileId: "deer" }]);

    const session = new GameSession(map, tiles, { actorIds: [] });

    expect(placedAt(session.getMap(), 2, 0, 0)[0]!.tileId).toBe(
      "plate-pressed",
    );
  });
});

describe("a world nobody is watching", () => {
  /**
   * The Durable Object stops ticking when the session says it has settled, and
   * an idle world is what makes an empty one free. A motionless resident must
   * not be a reason to stay awake.
   */
  it("comes to rest with residents on the board and nobody connected", () => {
    const session = new GameSession(withBody(strip(4), 2, "deer"), tiles, {
      actorIds: [],
    });
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
