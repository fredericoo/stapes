import { describe, expect, it } from "vitest";
import { emptyMap, replaceStack } from "../lib/mapData";
import { DEFAULT_STATUS_SOURCE } from "../lib/status";
import type { StatusDef, StatusTone } from "../lib/status";
import type { Coord, Direction, MapFile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL, normalizeTileDef } from "../lib/types";
import {
  findPath,
  findRefuge,
  PATH_MAX_NODES,
  REFUGE_MAX_NODES,
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
  /**
   * A flame: something you walk straight through and are burned by for landing
   * in. Intangible on purpose, exactly as the shipped one is — what takes it
   * out of a route is what it *does*, and a tile that blocked the cell would
   * prove nothing about this rule.
   */
  tile({
    id: "flame",
    height: 2,
    intangible: true,
    interactions: { addStatus: { trigger: "step", statusId: "burned" } },
  }),
  /** The same block with the other tone: a shrine is not a hazard. */
  tile({
    id: "shrine",
    height: 2,
    intangible: true,
    interactions: { addStatus: { trigger: "step", statusId: "blessed" } },
  }),
  /** A status the catalogue has never heard of, which is an effect that does not happen. */
  tile({
    id: "dud",
    height: 2,
    intangible: true,
    interactions: { addStatus: { trigger: "step", statusId: "unwritten" } },
  }),
  /** A portal, which is avoided on what it does rather than on any tone. */
  tile({
    id: "portal",
    height: 4,
    intangible: true,
    interactions: {
      teleport: { trigger: "step", destination: { kind: "absolute" } },
    },
  }),
  /** A flame you have to press rather than land on. @see ActivationTrigger */
  tile({
    id: "brazier",
    height: 2,
    intangible: true,
    interactions: {
      addStatus: { trigger: "interact", statusId: "burned" },
    },
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

/**
 * The statuses these searches know about.
 *
 * Only the tone is read — see `unsafeToStepOn` — so the rest is whatever a
 * status needs to be a status. Two of them, because the whole of what the rule
 * turns on is that one is bad and the other is not.
 */
const statusDefs: Record<string, StatusDef> = {
  burned: status("burned", "bad"),
  blessed: status("blessed", "good"),
};

function status(id: string, tone: StatusTone): StatusDef {
  return { ...DEFAULT_STATUS_SOURCE, id, name: id, tone };
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
  opts?: Parameters<typeof findPath>[6],
): PathOutcome {
  return findPath(map, { at: from, self: from }, to, rat, tilesById, statusDefs, opts);
}

/** The legs of a route, or null when there was none. @see refusal */
function route(
  map: MapFile,
  from: Coord & { stackIndex: number },
  to: Coord,
  opts?: Parameters<typeof findPath>[6],
): PathStep[] | null {
  const found = search(map, from, to, opts);
  return found.ok ? found.route : null;
}

/** Why a search had nothing to offer, or null when it did. */
function refusal(
  map: MapFile,
  from: Coord & { stackIndex: number },
  to: Coord,
  opts?: Parameters<typeof findPath>[6],
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
/**
 * A cell that does something to you on arrival is not a way through.
 *
 * The case that prompted it: a player following a rabbit walked into a flame
 * because the flame was on the short line, and the rabbit walked into it too
 * and died. Neither of them chose that — the route did, and a route is a plan
 * about getting somewhere rather than about what happens on the way.
 *
 * What each case here separates is *why* a cell is refused, because the two
 * halves of the rule are different: a teleport is refused for what it does to
 * the plan, and a status for what it does to the body — which means a shrine is
 * a floor and a fire is not.
 */
describe("a cell that fires when you land on it", () => {
  /** The flame straight ahead, with open ground either side of it to go round. */
  function inTheWay(tileId: string): MapFile {
    return put(field(6), 1, 0, tileId);
  }

  it("goes round a flame rather than through it", () => {
    const legs = walked(route(inTheWay("flame"), standing(0, 0), { x: 3, y: 0, z: 0 }));

    // Round one side or the other — the board is symmetric and either is right.
    // What matters is that the first leg is not the one into the fire.
    expect(legs?.[0]).toMatch(/^[ns]$/);
  });

  it("walks over a shrine, which is the same block with the other tone", () => {
    const legs = walked(route(inTheWay("shrine"), standing(0, 0), { x: 3, y: 0, z: 0 }));

    expect(legs?.[0]).toBe("e");
  });

  it("walks over a status the catalogue has never heard of", () => {
    // An effect that does not happen is not a hazard — the same reading
    // `resolveAddStatus` is written under. @see unsafeToStepOn
    const legs = walked(route(inTheWay("dud"), standing(0, 0), { x: 3, y: 0, z: 0 }));

    expect(legs?.[0]).toBe("e");
  });

  it("goes round a portal, which no tone makes safe", () => {
    const legs = walked(route(inTheWay("portal"), standing(0, 0), { x: 3, y: 0, z: 0 }));

    expect(legs?.[0]).toMatch(/^[ns]$/);
  });

  it("walks over a flame nobody is landing on to set off", () => {
    // The same status from the same block, waiting to be pressed rather than
    // stepped on. Nothing happens to a body that walks across it, so nothing
    // about it is a route's business. @see ActivationTrigger
    const legs = walked(route(inTheWay("brazier"), standing(0, 0), { x: 3, y: 0, z: 0 }));

    expect(legs?.[0]).toBe("e");
  });

  /**
   * Sealing a room with fire seals it. Walking in by hand still works — nothing
   * here touches `canWalk` — but nothing will *route* you through it, which is
   * the trade the rule is worth making.
   */
  it("refuses a goal whose only way in is through a flame", () => {
    let map = field(6);
    for (let y = -6; y <= 6; y++) map = put(map, 1, y, "wall");
    map = put(map, 1, 0, "flame");

    expect(route(map, standing(0, 0), { x: 3, y: 0, z: 0 })).toBeNull();
    // And the same board with the flame taken out is a way through, so the
    // refusal above is this rule rather than the wall.
    expect(route(put(map, 1, 0, "grass"), standing(0, 0), { x: 3, y: 0, z: 0 }))
      .not.toBeNull();
  });

  /**
   * The exemption, and it is the whole reason a portal is usable at all: a
   * click on one is a click on one, and a route that would not enter what it
   * was pointed at would make click-to-walk refuse every door in the world.
   */
  it("steps onto the cell that was asked for", () => {
    const map = inTheWay("portal");

    const legs = walked(
      route(map, standing(0, 0), { x: 1, y: 0, z: 0 }, { arrive: "on" }),
    );

    expect(legs).toEqual(["e"]);
  });

  it("steps into a flame that was asked for", () => {
    const map = inTheWay("flame");

    const legs = walked(
      route(map, standing(0, 0), { x: 1, y: 0, z: 0 }, { arrive: "on" }),
    );

    expect(legs).toEqual(["e"]);
  });

  /**
   * Only the cell itself, and only when a caller pointed at a cell to stand
   * *in*. Arriving beside something never lands on it, so there is nothing for
   * `beside` to exempt — and a creature closing on somebody standing next to a
   * fire must not take the fire as its last leg.
   */
  it("will not stand in a flame merely because it is beside the goal", () => {
    // The flame at (1, 0) and the goal at (2, 0): stopping in the flame is
    // "beside the goal", and stopping at (2, 1) or (2, -1) is as well.
    const map = inTheWay("flame");

    const legs = walked(route(map, standing(0, 0), { x: 2, y: 0, z: 0 }));

    expect(legs?.[0]).toMatch(/^[ns]$/);
  });

  /**
   * A fall lands somewhere, and where it lands is what the rule reads. Without
   * that a route may not step *into* a fire and may still be dropped into one,
   * which is the same body in the same flame by a different door.
   */
  describe("a drop that would land in one", () => {
    /**
     * Ground everywhere, a floor of blocks over it, and a trench cut in that
     * floor from (2, 0) to (4, 0). The only way into the trench is off its lip,
     * and there are two lips to choose from.
     */
    function trench(bottom: string): MapFile {
      let map = field(6);
      for (let x = -6; x <= 6; x++) {
        for (let y = -6; y <= 6; y++) map = put(map, x, y, "block");
      }
      for (const x of [2, 3, 4]) map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
      map = replaceStack(map, 2, 0, 0, [{ tileId: "grass" }, { tileId: bottom }]);
      return replaceStack(map, 0, 0, 1, [{ tileId: "rat" }]);
    }

    it("drops in somewhere else along the trench instead", () => {
      const legs = route(trench("flame"), standing(0, 0, 1, 0), { x: 4, y: 0, z: 0 }, {
        arrive: "on",
        drops: "anywhere",
      });

      expect(legs).not.toBeNull();
      // Every way in but the near one, which is the one with the fire at the
      // bottom of it. Without the check on the landing this is the first leg.
      expect(legs!.map((leg) => leg.to)).not.toContainEqual({ x: 2, y: 0, z: 0 });
    });

    it("takes the same drop when the flame is what was asked for", () => {
      const legs = route(trench("flame"), standing(0, 0, 1, 0), { x: 2, y: 0, z: 0 }, {
        arrive: "on",
        drops: "toGoal",
      });

      // A flame at the bottom of a hole somebody pointed into is a flame they
      // pointed at. @see avoidRule
      expect(walked(legs)).toEqual(["e", "e"]);
    });

    it("drops straight in when the bottom is bare ground", () => {
      const legs = route(trench("grass"), standing(0, 0, 1, 0), { x: 4, y: 0, z: 0 }, {
        arrive: "on",
        drops: "anywhere",
      });

      expect(legs!.map((leg) => leg.to)).toContainEqual({ x: 2, y: 0, z: 0 });
    });
  });
});

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

/**
 * Running away, which is the same module inside out.
 *
 * A chase knows where it wants to be; a flee knows only what it wants to be
 * away from. So there is no goal to aim at, no heuristic to order a frontier
 * by, and what the search does instead is flood outward and score what it
 * reaches. These cases pin the scoring and the two limits on it.
 *
 * The behaviour they are here for is the one that made this necessary: a rabbit
 * backed into a pocket had no neighbouring cell that opened the distance, so
 * the greedy version this replaced gave up and stood there while somebody
 * walked up to it.
 */
describe("finding somewhere to run", () => {
  /** Where a flood ends up, or null for an animal that stayed put. */
  function refuge(
    map: MapFile,
    from: Coord & { stackIndex: number },
    threat: Coord,
    opts?: Parameters<typeof findRefuge>[6],
  ): Coord | null {
    const found = findRefuge(
      map,
      { at: from, self: from },
      threat,
      rat,
      tilesById,
      statusDefs,
      opts,
    );
    if (!found.ok || found.route.length === 0) return null;
    return found.route[found.route.length - 1]!.to;
  }

  function stepsApart(a: Coord, b: Coord): number {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }

  it("runs away, and hands back the way there", () => {
    const map = field(12);
    const found = findRefuge(
      map,
      { at: standing(0, 0), self: standing(0, 0) },
      { x: -4, y: 0, z: 0 },
      rat,
      tilesById,
      statusDefs,
    );

    expect(found.ok).toBe(true);
    const route = found.ok ? found.route : [];
    // Every leg is a real leg, and the last of them lands on the refuge — the
    // route comes out of the same came-from tree the flood built, so picking
    // somewhere and working out how to get there are not two searches.
    expect(route.length).toBeGreaterThan(0);
    const arrived = route[route.length - 1]!.to;
    expect(stepsApart(arrived, { x: -4, y: 0, z: 0 })).toBeGreaterThan(4);
  });

  /**
   * The case the greedy version could not answer, and the reason this exists.
   *
   * Walls on three sides and the threat in the mouth of the pocket. No
   * neighbouring cell opens the distance — the only way out runs *past* the
   * threat before it leads anywhere — so a search that scored the four
   * neighbours found nothing and reported cornered. A flood sees the cells
   * beyond.
   */
  it("leaves a pocket whose only way out passes the threat", () => {
    let map = field(12);
    map = put(map, 1, 0, "wall");
    map = put(map, 0, -1, "wall");
    map = put(map, 0, 1, "wall");

    const found = refuge(map, standing(0, 0), { x: -3, y: 0, z: 0 });

    expect(found).not.toBeNull();
    expect(stepsApart(found!, { x: -3, y: 0, z: 0 })).toBeGreaterThan(3);
  });

  /**
   * Genuinely nowhere to go, which is a different answer from not having
   * looked. An empty route on the terms an empty route always means arrived:
   * the animal itself is the best cell the flood found.
   */
  /**
   * The flood inherits the rule with no exemption at all: there is no goal
   * here, so there is no cell anybody pointed at. An animal that ran into a
   * fire to get away from you would have taken the worse of the two.
   */
  it("will not run into a flame to open the distance", () => {
    // A corridor with the threat at one end of it, so west is the only
    // direction that opens the distance at all — and one cell of the corridor
    // is on fire.
    function corridor(atMinusOne: string): MapFile {
      let map = field(12);
      for (let x = -12; x <= 12; x++) {
        map = put(map, x, -1, "wall");
        map = put(map, x, 1, "wall");
      }
      // Capped east of the threat, so running *past* it is not the better
      // answer the flood would otherwise take.
      map = put(map, 6, 0, "wall");
      return put(map, -1, 0, atMinusOne);
    }

    // Nowhere better than where it stands, which is an empty route and the
    // honest answer: an animal cornered against a fire is cornered.
    expect(refuge(corridor("flame"), standing(0, 0), { x: 4, y: 0, z: 0 })).toBeNull();

    // The control: the same corridor with the fire out runs down it, so the
    // answer above is this rule rather than the walls.
    const away = refuge(corridor("grass"), standing(0, 0), { x: 4, y: 0, z: 0 });
    expect(away!.x).toBeLessThan(-1);
  });

  it("stays put when it is walled in, and says so with an empty route", () => {
    let map = field(12);
    for (const [x, y] of [[1, 0], [-1, 0], [0, -1], [0, 1]]) {
      map = put(map, x!, y!, "wall");
    }

    const found = findRefuge(
      map,
      { at: standing(0, 0), self: standing(0, 0) },
      { x: -3, y: 0, z: 0 },
      rat,
      tilesById,
      statusDefs,
    );

    expect(found).toEqual({ ok: true, route: [] });
  });

  /**
   * Sight breaks a tie and never more than that.
   *
   * Told that everywhere north is out of sight, an animal with two equally
   * distant ways to run takes the northern one. Told nothing, it is free to
   * take either — which is why the case is written as "north when hidden" and
   * not "south when not": the flood's own tie-break is which cell it reached
   * first, and that is an ordering this test has no business pinning.
   */
  it("prefers a refuge the threat cannot see, where two are equally far", () => {
    const map = field(12);
    const found = refuge(map, standing(0, 0), { x: 0, y: 0, z: 0 }, {
      seenFrom: (cell) => cell.y >= 0,
    });

    expect(found).not.toBeNull();
    expect(found!.y).toBeLessThan(0);
  });

  /**
   * And never at the price of distance. Everywhere *near* is hidden and
   * everywhere far is not; the animal still runs.
   */
  it("does not double back towards a threat for the sake of a wall", () => {
    const map = field(12);
    const threat = { x: -6, y: 0, z: 0 };
    const found = refuge(map, standing(0, 0), threat, {
      seenFrom: (cell) => stepsApart(cell, threat) > 8,
    });

    expect(found).not.toBeNull();
    expect(stepsApart(found!, threat)).toBeGreaterThan(8);
  });

  /**
   * The budget is spent every time, unlike the chase's.
   *
   * A route search has an admissible heuristic and stops the moment it arrives;
   * a flood has nothing to prune with and nowhere to stop, so `maxNodes` is
   * what a flee costs rather than a ceiling it rarely reaches. Which is why the
   * number is small, and why how far an animal can see to run is set by it.
   */
  it("looks no further than its budget lets it", () => {
    const map = field(30);
    const near = refuge(map, standing(0, 0), { x: 0, y: 0, z: 0 }, { maxNodes: 8 });
    const far = refuge(map, standing(0, 0), { x: 0, y: 0, z: 0 }, { maxNodes: REFUGE_MAX_NODES });

    expect(stepsApart(near!, { x: 0, y: 0, z: 0 })).toBeLessThan(
      stepsApart(far!, { x: 0, y: 0, z: 0 }),
    );
  });

  /**
   * A ledge is not a way out unless the animal is allowed to take it, on the
   * same `drops` every other search here is under. The deer and the rabbit are
   * both authored to jump, which is what makes the far side of a drop a refuge
   * for them and a wall for anything else.
   */
  it("takes a drop only when the animal is allowed to", () => {
    // A one-cell-wide ledge a level above open ground, with the threat at the
    // far end of it. The ledge is the only footing at that level, so running
    // along it is all there is unless the animal may go over the side.
    let map = field(6);
    for (let y = 0; y <= 6; y++) {
      map = replaceStack(map, 0, y, 0, [{ tileId: "grass" }, { tileId: "block" }]);
    }
    const on = { x: 0, y: 3, z: 1, stackIndex: 0 };
    const threat = { x: 0, y: 6, z: 1 };

    // Stuck on the ledge: it runs to the far end of it and no further.
    const along = refuge(map, on, threat, { drops: "never" })!;
    expect(along.z).toBe(1);
    // Over the side and away across the ground, which gets it further from the
    // threat than the ledge ever could have.
    const leapt = refuge(map, on, threat, { drops: "anywhere" })!;
    expect(leapt.z).toBe(0);
    expect(stepsApart(leapt, threat)).toBeGreaterThan(stepsApart(along, threat));
  });
});
