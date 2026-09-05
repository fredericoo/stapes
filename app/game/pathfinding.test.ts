import { describe, expect, it } from "vitest";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { Coord, Direction, MapFile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL, normalizeTileDef } from "../lib/types";
import {
  findPath,
  PATH_MAX_NODES,
  type PathOutcome,
  type PathRefusal,
  type PathStep,
} from "./pathfinding";

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

/**
 * A creature searching from where it stands, which is the case where the two
 * halves of `PathStart` name one cell. The pair coming apart is a body mid-step,
 * and that belongs to `./walkTo`.
 */
function search(
  map: MapFile,
  from: Coord & { stackIndex: number },
  to: Coord,
  opts?: Parameters<typeof findPath>[5],
): PathOutcome {
  return findPath(map, { at: from, self: from }, to, rat, tilesById, opts);
}

/** The legs of a route, or null when there was none. @see refusal */
function route(
  map: MapFile,
  from: Coord & { stackIndex: number },
  to: Coord,
  opts?: Parameters<typeof findPath>[5],
): PathStep[] | null {
  const found = search(map, from, to, opts);
  return found.ok ? found.route : null;
}

/** Why a search had nothing to offer, or null when it did. */
function refusal(
  map: MapFile,
  from: Coord & { stackIndex: number },
  to: Coord,
  opts?: Parameters<typeof findPath>[5],
): PathRefusal | null {
  const found = search(map, from, to, opts);
  return found.ok ? null : found.why;
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
 * Where a route ends is the caller's to choose.
 *
 * A creature closing on somebody stops beside them, because a body is not
 * something you can walk into. A person who pointed at a patch of floor means
 * *that cell* — stopping one short of it would be walking somewhere they did
 * not point. The default is the older of the two, so every brain reads exactly
 * as it did.
 *
 * The goal test and the heuristic are checked together here on purpose: they
 * are two statements of the same fact, and a search whose queue is ordered on
 * one arrival while its finish line is the other returns routes that are not
 * the shortest.
 */
describe("arriving beside, or on", () => {
  it("stops one short by default, and walks in when asked", () => {
    const map = field(6);
    const goal = { x: 4, y: 0, z: 0 };

    expect(walked(route(map, standing(0, 0), goal))).toEqual(["e", "e", "e"]);
    expect(
      walked(route(map, standing(0, 0), goal, { arrive: "on" })),
    ).toEqual(["e", "e", "e", "e"]);
  });

  it("still has a step to walk when it is merely beside the cell", () => {
    const map = field(4);
    const goal = { x: 1, y: 0, z: 0 };

    // The case the two modes disagree about most sharply: arrived, and not.
    expect(route(map, standing(0, 0), goal)).toEqual([]);
    expect(walked(route(map, standing(0, 0), goal, { arrive: "on" }))).toEqual([
      "e",
    ]);
  });

  it("has nothing to walk when it is already standing there", () => {
    const map = field(4);

    expect(
      route(map, standing(0, 0), { x: 0, y: 0, z: 0 }, { arrive: "on" }),
    ).toEqual([]);
  });

  it("refuses a cell nothing can stand in, next to one anybody can", () => {
    const map = put(field(4), 2, 0, "wall");
    const goal = { x: 2, y: 0, z: 0 };

    expect(route(map, standing(0, 0), goal, { arrive: "on" })).toBeNull();
    expect(walked(route(map, standing(0, 0), goal))).toEqual(["e"]);
  });

  it("takes the shortest way round in either mode", () => {
    let map = field(6);
    for (let y = -2; y <= 2; y++) map = put(map, 1, y, "wall");
    const goal = { x: 2, y: 0, z: 0 };
    // A generous budget, so what any refusal means is the board rather than
    // the cost — the same reason the detour cases below carry one.
    const budget = { maxNodes: 400 };

    const beside = route(map, standing(0, 0), goal, budget);
    const onto = route(map, standing(0, 0), goal, { ...budget, arrive: "on" });

    // Round the end of the wall and back, and then one more step to finish
    // standing in the cell rather than next to it.
    expect(beside).toHaveLength(7);
    expect(onto).toHaveLength(8);
    expect(onto?.at(-1)?.to).toEqual(goal);
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

/** A three-cell plateau at (0..2, 0), one level up, over open grass. */
function plateau(): MapFile {
  let map = field(6);
  for (let x = 0; x <= 2; x++) map = put(map, x, 0, "block");
  return map;
}

/**
 * A drop is a way down and never a way back, so which legs may take one is the
 * caller's to say — and it resolves where gravity would actually put the body,
 * because a route planned from mid-air is a route about a cell nobody is ever
 * standing in.
 */
describe("ledges", () => {
  it("refuses a ledge by default, and stays up there", () => {
    expect(
      route(plateau(), standing(0, 0, 1, 0), { x: 5, y: 0, z: 0 }),
    ).toBeNull();
  });

  it("takes the ledge when the action allows it, landing where it falls", () => {
    const path = route(plateau(), standing(0, 0, 1, 0), { x: 5, y: 0, z: 0 }, {
      drops: "anywhere",
    });

    expect(walked(path)).toEqual(["e", "e", "e", "e"]);
    // Two legs along the roof, then off it — and the search carries on from the
    // ground rather than from the cell it stepped into.
    expect(path?.map((step) => step.to.z)).toEqual([1, 1, 0, 0]);
  });
});

/**
 * The middle setting, which is what a click asks for: a fall may be the arrival
 * and nothing else.
 *
 * A leg costs one step whether it walks or falls, and there is nothing else to
 * pay, so a search free to fall anywhere steps off the nearest ledge the moment
 * that is the shorter line. That is right for a creature an author has told to
 * take drops and wrong for a person who pointed at a cell across the room, so
 * `"toGoal"` allows the fall exactly when the cell it lands in is the cell that
 * was asked for. @see ../game/walkTo
 */
describe("a drop that has to be the destination", () => {
  /**
   * The same plateau with a way down that is a walk rather than a fall: a step
   * off the far end, half a level at a time.
   */
  function stairs(): MapFile {
    let map = field(3);
    for (let x = 0; x <= 2; x++) map = put(map, x, 0, "block");
    return put(map, 3, 0, "step");
  }

  it("steps off the ledge when the landing is the cell asked for", () => {
    // Where a body stepping off the east end of the plateau comes down.
    const path = route(plateau(), standing(0, 0, 1, 0), { x: 3, y: 0, z: 0 }, {
      drops: "toGoal",
      arrive: "on",
    });

    expect(walked(path)).toEqual(["e", "e", "e"]);
    expect(path?.map((step) => step.to.z)).toEqual([1, 1, 0]);
  });

  it("refuses the same fall when it lands somewhere else", () => {
    // Two cells further on, and the fall is now a way *through* to somewhere
    // rather than the way down to what was asked for. There is no other way off
    // the plateau, so there is no route at all.
    expect(
      route(plateau(), standing(0, 0, 1, 0), { x: 5, y: 0, z: 0 }, {
        drops: "toGoal",
        arrive: "on",
      }),
    ).toBeNull();
  });

  /**
   * The case that would regress without anybody noticing, because both answers
   * are routes and only one of them is the one somebody asked for.
   */
  it("walks the long way down rather than stepping off on the way past", () => {
    const shortcut = route(stairs(), standing(0, 0, 1, 0), { x: 0, y: -2, z: 0 }, {
      drops: "anywhere",
      arrive: "on",
    });
    // Off the north edge and one step on: strictly shorter, and not what a
    // player clicking a cell two along from themselves meant.
    expect(walked(shortcut)).toEqual(["n", "n"]);

    const path = route(stairs(), standing(0, 0, 1, 0), { x: 0, y: -2, z: 0 }, {
      drops: "toGoal",
      arrive: "on",
    });

    // East along the shelf to the step, down it, and back round underneath.
    expect(walked(path)?.[0]).toBe("e");
    expect(path).toHaveLength(8);
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

/**
 * Three refusals, and only one of them is about the board.
 *
 * They were one null until a player clicked into a room across the square and
 * was told there was no way there — which the search had never established, and
 * on the shipped map is usually false. What separates them is inside the loop
 * either way: an emptied frontier having offered everything is the board's own
 * answer, an emptied one that turned candidates away at the detour cap is not,
 * and a queue with cells still in it is the budget having stopped a search that
 * still had somewhere to look. @see PathRefusal
 */
describe("saying which limit was hit", () => {
  it("calls a sealed target unreachable, having looked everywhere", () => {
    let map = field(4);
    for (const [x, y] of [[3, 0], [5, 0], [4, 1], [4, -1]]) {
      map = put(map, x!, y!, "wall");
    }

    // A board small enough that the detour cap turns nothing away, which is
    // what it takes to say this: the whole of it was offered and searched.
    expect(refusal(map, standing(0, 0), { x: 4, y: 0, z: 0 })).toBe(
      "unreachable",
    );
  });

  it("will not claim it looked everywhere when it turned cells away", () => {
    // The same sealed target with room around it. The far corners are over the
    // detour cap and never offered, so the honest answer is the weaker one —
    // and the sentence it writes is true of a sealed cell as well.
    let map = field(12);
    for (const [x, y] of [[3, 0], [5, 0], [4, 1], [4, -1]]) {
      map = put(map, x!, y!, "wall");
    }

    expect(
      refusal(map, standing(0, 0), { x: 4, y: 0, z: 0 }, { maxNodes: 2000 }),
    ).toBe("detour");
  });

  it("calls a long way round a detour rather than no way at all", () => {
    // The wall from "how far out of its way": there is a route, and it is one
    // this module will not walk. Saying "unreachable" here is the lie.
    let map = field(12);
    for (let y = -10; y <= 10; y++) map = put(map, 1, y, "wall");

    expect(
      refusal(map, standing(0, 0), { x: 2, y: 0, z: 0 }, { maxNodes: 2000 }),
    ).toBe("detour");
  });

  it("calls a search it stopped early a budget, not a board", () => {
    const map = field(40);

    expect(
      refusal(map, standing(-40, -40), { x: 40, y: 40, z: 0 }, { maxNodes: 8 }),
    ).toBe("budget");
  });

  it("has no reason to give when it found a route", () => {
    expect(refusal(field(4), standing(0, 0), { x: 2, y: 0, z: 0 })).toBeNull();
    // Including the empty one: arriving is a success, and always was.
    expect(refusal(field(4), standing(0, 0), { x: 1, y: 0, z: 0 })).toBeNull();
  });
});

/**
 * A route is made of steps the board allows, so it inherits the rule that a
 * step never crosses a sealed floor plane. Pinned here as well because the
 * search's own ground check reads the same band, and the two answering
 * differently would plan a route the walk loop then refuses.
 */
describe("a route stays under a floor", () => {
  const underFloor = (): MapFile => {
    let map = emptyMap();
    map = replaceStack(map, 0, 0, -1, [{ tileId: "step" }, { tileId: "rat" }]);
    map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }]);
    for (const x of [1, 2]) {
      map = replaceStack(map, x, 0, -1, [{ tileId: "grass" }]);
      map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
    }
    return map;
  };

  it("finds no way up through the floor over a step", () => {
    expect(route(underFloor(), standing(0, 0, -1), { x: 2, y: 0, z: 0 })).toBeNull();
  });

  it("climbs out where the column over the step is open", () => {
    const map = replaceStack(underFloor(), 0, 0, 0, []);
    expect(walked(route(map, standing(0, 0, -1), { x: 2, y: 0, z: 0 }))).toEqual(["e"]);
  });
});
