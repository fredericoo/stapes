import { describe, expect, it } from "vitest";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { Coord, Direction, MapFile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL, normalizeTileDef } from "../lib/types";
import { findPath, PATH_MAX_NODES, type PathStep } from "./pathfinding";

/**
 * Finding a way round.
 *
 * The bug this module exists for fits in one board: a rat, a box, and somebody
 * on the far side of it. Every direction that got the rat any closer was the
 * one the box was in, so it stood there — a creature defeated by a single crate
 * it could plainly see past.
 *
 * These cases are the route search on its own, with no brain around it. What
 * they pin is that the answer is a *route*: it goes round things, it climbs
 * what the board says a body may climb, it walks up to another floor, and it
 * says plainly when there is no way at all rather than setting off hopefully.
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
  /** A full level of solid nobody walks on: a wall. */
  tile({ id: "wall", height: HEIGHT_PER_LEVEL, walkable: false }),
  /** Half a level, solid: a crate. Feet do not pass it, and nor do they climb it. */
  tile({ id: "crate", height: 2, walkable: false }),
  /** Half a level you can stand on — the whole of what "climbable" means here. */
  tile({ id: "step", height: 2 }),
  /** A full level you can stand on, so the level above it has a floor. */
  tile({ id: "block", height: HEIGHT_PER_LEVEL }),
  tile({
    id: "rat",
    height: 2,
    actor: true,
    affectedByGravity: true,
    walkable: false,
  }),
];

const tilesById = Object.fromEntries(tiles.map((def) => [def.id, def]));
const rat = tilesById.rat!;

/** Flat grass from -half to +half, and nothing else. */
function field(half: number): MapFile {
  let map = emptyMap();
  for (let x = -half; x <= half; x++) {
    for (let y = -half; y <= half; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  return map;
}

function put(map: MapFile, x: number, y: number, tileId: string): MapFile {
  return replaceStack(map, x, y, 0, [{ tileId: "grass" }, { tileId }]);
}

/** The creature's own cell, with the slot its body sits in. */
function standing(x: number, y: number, z = 0, stackIndex = 1) {
  return { x, y, z, stackIndex };
}

function route(
  map: MapFile,
  from: Coord & { stackIndex: number },
  to: Coord,
  opts?: Parameters<typeof findPath>[5],
): PathStep[] | null {
  return findPath(map, from, to, rat, tilesById, opts);
}

/** A route as the directions it is walked, for a readable assertion. */
function walked(path: PathStep[] | null): Direction[] | null {
  return path?.map((step) => step.direction) ?? null;
}

describe("crossing open ground", () => {
  it("walks straight at somebody, stopping beside them", () => {
    const map = field(6);

    expect(walked(route(map, standing(0, 0), { x: 4, y: 0, z: 0 }))).toEqual([
      "e",
      "e",
      "e",
    ]);
  });

  /**
   * Arriving is standing *next to* them, because a body is not something you
   * can walk into. An empty route is therefore a creature that has got where it
   * was going, and it is a different fact from there being no way there — which
   * is why the two are not both null.
   */
  it("has nothing left to walk once it is beside them", () => {
    const map = field(4);

    expect(route(map, standing(0, 0), { x: 1, y: 0, z: 0 })).toEqual([]);
  });

  it("gives up on somebody who has left the board's walkable part", () => {
    let map = field(4);
    // Ringed in, with the target sealed inside.
    for (const [x, y] of [[3, 0], [5, 0], [4, 1], [4, -1]]) {
      map = put(map, x!, y!, "wall");
    }

    expect(route(map, standing(0, 0), { x: 4, y: 0, z: 0 })).toBeNull();
  });
});

/**
 * The report, as a board.
 *
 * One crate, due east, with somebody standing behind it. Every step that closed
 * the distance was the one the crate was in, so the old greedy chase had
 * nothing to try and simply stood there.
 */
describe("the box a rat could not get past", () => {
  it("goes round a single crate rather than pressing against it", () => {
    const map = put(field(4), 1, 0, "crate");

    const path = route(map, standing(0, 0), { x: 2, y: 0, z: 0 });

    // Aside, past it, and back level with them.
    expect(walked(path)).toHaveLength(3);
    // Round one side or the other — the board is symmetric and either is right.
    expect(walked(path)?.[0]).toMatch(/^[ns]$/);
    expect(path?.at(-1)?.to.x).toBe(2);
  });

  it("goes the long way round a wall it cannot see past", () => {
    let map = field(6);
    for (let y = -2; y <= 2; y++) map = put(map, 1, y, "wall");

    const path = route(map, standing(0, 0), { x: 2, y: 0, z: 0 });

    // Round the end of the wall, then back down to stand beside them. Which
    // end is either — the board is symmetric and both are the same length.
    expect(path).toHaveLength(7);
    expect(path?.at(-1)?.to.x).toBe(2);
    expect(Math.abs(path?.at(-1)?.to.y ?? 0)).toBe(1);
  });
});

/**
 * What a body may climb is the board's answer, not this module's — every leg of
 * a route is one `canWalk`, the same call the player's own step goes through.
 * These cases pin that the answer comes out the far side intact.
 */
describe("heights", () => {
  it("steps up half a level without going round", () => {
    const map = put(field(4), 1, 0, "step");

    expect(walked(route(map, standing(0, 0), { x: 2, y: 0, z: 0 }))).toEqual([
      "e",
    ]);
  });

  it("walks round a full level rather than scaling it", () => {
    const map = put(field(4), 1, 0, "block");

    const path = walked(route(map, standing(0, 0), { x: 2, y: 0, z: 0 }));

    expect(path).toHaveLength(3);
    expect(path?.[0]).toMatch(/^[ns]$/);
  });

  /**
   * Somebody on the floor above is worth walking a staircase for, and standing
   * underneath them is not standing beside them. That is the whole reason the
   * goal is adjacency *on their own level* rather than plan distance alone.
   */
  it("climbs to the floor above by the one route up", () => {
    let map = field(6);
    map = put(map, 1, 0, "step");
    for (let x = 2; x <= 5; x++) map = put(map, x, 0, "block");

    const path = route(map, standing(0, 0), { x: 5, y: 0, z: 1 });

    expect(walked(path)).toEqual(["e", "e", "e", "e"]);
    // Half a level, then a whole one, and the last two legs are on the roof.
    expect(path?.map((step) => step.to.z)).toEqual([0, 1, 1, 1]);
  });

  it("will not walk under somebody it cannot reach", () => {
    let map = field(4);
    map = replaceStack(map, 2, 0, 1, [{ tileId: "grass" }]);

    // A floating floor with no way onto it: the plan distance says one step,
    // and the honest answer is that there is no route at all.
    expect(route(map, standing(0, 0), { x: 2, y: 0, z: 1 })).toBeNull();
  });
});

/**
 * A drop is a way down and never a way back, so it is opt-in and it resolves
 * where gravity would actually put the body — a route planned from mid-air is
 * a route about a cell nobody is ever standing in.
 */
describe("ledges", () => {
  /** A three-cell plateau at (0..2, 0), one level up, over open grass. */
  function plateau(): MapFile {
    let map = field(6);
    for (let x = 0; x <= 2; x++) map = put(map, x, 0, "block");
    return map;
  }

  it("refuses a ledge by default, and stays up there", () => {
    expect(
      route(plateau(), standing(0, 0, 1, 0), { x: 5, y: 0, z: 0 }),
    ).toBeNull();
  });

  it("takes the ledge when the action allows it, landing where it falls", () => {
    const path = route(plateau(), standing(0, 0, 1, 0), { x: 5, y: 0, z: 0 }, {
      allowDrops: true,
    });

    expect(walked(path)).toEqual(["e", "e", "e", "e"]);
    // Two legs along the roof, then off it — and the search carries on from the
    // ground rather than from the cell it stepped into.
    expect(path?.map((step) => step.to.z)).toEqual([1, 1, 0, 0]);
  });
});

/**
 * A route long out of proportion to the gap is not a chase. Walking twenty
 * cells round a wall to reach somebody standing two away is a creature that has
 * worked out where the door is, and nothing here has any business knowing that.
 */
describe("how far out of its way", () => {
  /** A wall down x = 1, `reach` cells either side of the row they share. */
  function screen(reach: number): MapFile {
    let map = field(reach + 2);
    for (let y = -reach; y <= reach; y++) map = put(map, 1, y, "wall");
    return map;
  }

  it("rounds a screen it can get past in a few extra steps", () => {
    const path = route(screen(2), standing(0, 0), { x: 2, y: 0, z: 0 }, {
      maxNodes: 400,
    });

    expect(path).toHaveLength(7);
  });

  it("refuses one it would have to walk the long way round", () => {
    // The same board with a longer wall: still a route, and still not a chase.
    // A generous budget, so what refuses it is the detour rather than the cost.
    expect(
      route(screen(10), standing(0, 0), { x: 2, y: 0, z: 0 }, { maxNodes: 400 }),
    ).toBeNull();
  });
});

describe("what it costs", () => {
  /**
   * The budget is a ceiling on work, not a tuning knob, and running out reads
   * as no route at all. A half-explored search has a best-so-far cell it could
   * head for, and walking towards that is how a creature ends up pressed
   * against the nearest wall having "made progress".
   */
  it("gives up rather than sweeping the board", () => {
    const map = field(40);

    expect(route(map, standing(-40, -40), { x: 40, y: 40, z: 0 }, {
      maxNodes: 8,
    })).toBeNull();
  });

  it("proves a sealed target impossible inside the budget", () => {
    let map = field(30);
    for (let y = -30; y <= 30; y++) map = put(map, 1, y, "wall");

    // Walled off across the whole board: the search has to exhaust its budget
    // to know, and the point is that it stops rather than that it succeeds.
    expect(route(map, standing(0, 0), { x: 2, y: 0, z: 0 })).toBeNull();
  });

  it("finds an open-field route without exploring the whole budget", () => {
    const map = field(30);
    let expanded = 0;
    // A budget just over the route length is enough in the open, which is the
    // whole reason an exact plan-distance heuristic is worth having.
    for (let budget = 1; budget <= PATH_MAX_NODES; budget++) {
      if (route(map, standing(0, 0), { x: 20, y: 0, z: 0 }, { maxNodes: budget })) {
        expanded = budget;
        break;
      }
    }

    expect(expanded).toBeGreaterThan(0);
    expect(expanded).toBeLessThanOrEqual(20);
  });
});
