import { describe, expect, it } from "vitest";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { Coord, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { TICK_MS } from "./constants";
import { GameSession } from "./GameSession";
import { findLooseGravityCells, settleGravity } from "./gravity";

/**
 * Passive gravity for the bodies no runtime drives. An actor animates its own
 * fall; a crate has no runtime to do that, so the board drops it on settle —
 * instantly, which is the point: a thing whose floor was pulled hanging in the
 * air reads as a broken mechanism, not as physics waiting to happen.
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
  tile({ id: "box", height: 2, affectedByGravity: true }),
  // Same size, no gravity: scenery that hangs where it is put.
  tile({ id: "rock", height: 2 }),
  // A full level: the only thing that counts as a floor underfoot.
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
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
  }),
  // A full-height crate that can be shoved: the support to pull out.
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

describe("settling loose gravity", () => {
  it("drops an unsupported body onto what is below it", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "box" }]);

    const { map: next } = settleGravity(
      map,
      findLooseGravityCells(map, byId),
      byId,
    );

    expect(getStack(next, 0, 0, 1)).toHaveLength(0);
    expect(ids(getStack(next, 0, 0, 0))).toEqual(["grass", "box"]);
  });

  it("leaves a body a full floor holds up", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "pillar" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "box" }]);

    const { changed } = settleGravity(
      map,
      findLooseGravityCells(map, byId),
      byId,
    );

    expect(changed).toEqual([]);
  });

  it("does not index or drop a body a runtime is driving", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "box", owner: "alice" }]);

    // An owned body animates its own fall; the board must not also snap it.
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

    const { changed } = settleGravity(
      map,
      findLooseGravityCells(map, byId),
      byId,
    );

    expect(changed).toEqual([]);
    expect(ids(getStack(map, 0, 0, 1))).toEqual(["box"]);
  });
});

describe("a crate in a running world", () => {
  /** An empty world with a fixed spawn, so no player tile is needed. */
  const spawn = { x: 0, y: 0, z: 0, stackIndex: 0 };

  it("lands where its load implies the moment the world opens", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "box" }]);

    // The constructor settles the board once, so an authored-floating crate is
    // already on the ground before anyone sees it — no first-frame hang.
    const session = new GameSession(map, tiles, {
      actorIds: [],
      spawnAt: spawn,
    });

    expect(ids(getStack(session.getMap(), 0, 0, 0))).toEqual(["grass", "box"]);
  });

  /**
   * The whole reason this exists: a crate dropping onto a plate has to press it
   * on the frame it lands, or the door it drives looks broken. Gravity settles
   * before plates in the same pass, so the press and the open happen at once.
   */
  it("drops onto a plate, presses it, and opens the door it drives", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "plate", channel: "gate" }]);
    map = replaceStack(map, 3, 0, 0, [{ tileId: "door", channel: "gate" }]);
    // The crate, hanging one level above the plate.
    map = replaceStack(map, 1, 0, 1, [{ tileId: "box" }]);

    const session = new GameSession(map, tiles, {
      actorIds: [],
      spawnAt: spawn,
    });
    const at = (c: Coord) => ids(getStack(session.getMap(), c.x, c.y, c.z));

    expect(at({ x: 1, y: 0, z: 0 })).toEqual(["plate-down", "box"]);
    expect(at({ x: 3, y: 0, z: 0 })).toContain("door-open");
  });

  /**
   * The motivating case, at runtime: a support shoved away mid-play leaves what
   * sat on it hanging, and the very next settle drops it. No brains, no actor on
   * the crate — just a body and the floor it lost.
   */
  it("drops a body when its support is pushed out from under it", () => {
    let map = emptyMap();
    for (let x = 0; x <= 3; x++) {
      map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
    }
    map = replaceStack(map, 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "e" },
    ]);
    // A full-height crate holds a box up one level.
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "crate" },
    ]);
    map = replaceStack(map, 1, 0, 1, [{ tileId: "box" }]);

    const session = new GameSession(map, tiles);
    expect(ids(getStack(session.getMap(), 1, 0, 1))).toEqual(["box"]);

    // Shove the crate east, out from under the box.
    expect(session.push({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(true);
    for (let i = 0; i < 4; i++) session.tick(TICK_MS);

    expect(getStack(session.getMap(), 1, 0, 1)).toHaveLength(0);
    expect(ids(getStack(session.getMap(), 1, 0, 0))).toEqual(["grass", "box"]);
  });

  it("stays put once landed, rather than re-dropping every tick", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "box" }]);
    const session = new GameSession(map, tiles, {
      actorIds: [],
      spawnAt: spawn,
    });

    for (let i = 0; i < 10; i++) session.tick(TICK_MS);

    expect(ids(getStack(session.getMap(), 0, 0, 0))).toEqual(["grass", "box"]);
    expect(session.isAtRest()).toBe(true);
  });
});
