import { describe, expect, it } from "vitest";
import { emptyMap, replaceStack } from "../lib/mapData";
import { constantFormula } from "../lib/formula";
import { DEFAULT_STATUS_SOURCE } from "../lib/status";
import type { StatusDef, StatusTone } from "../lib/status";
import type { Coord, Direction, MapFile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL } from "../lib/types";
import {
  findPath,
  findRefuge,
  legCost,
  PATH_MAX_NODES,
  REFUGE_MAX_NODES,
  type PathOutcome,
  type PathRefusal,
  type PathStep,
} from "./pathfinding";
import { tile } from "../lib/testTile";

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "wall", height: HEIGHT_PER_LEVEL, walkable: false }),
  tile({ id: "crate", height: 2, walkable: false }),
  tile({ id: "step", height: 2 }),
  tile({ id: "block", height: HEIGHT_PER_LEVEL }),
  tile({
    id: "rat",
    height: 2,
    actor: true,
    affectedByGravity: true,
    walkable: false,
  }),
  tile({
    id: "flame",
    height: 2,
    intangible: true,
    interactions: { addStatus: { trigger: "step", statusId: "burned" } },
  }),
  tile({
    id: "shrine",
    height: 2,
    intangible: true,
    interactions: { addStatus: { trigger: "step", statusId: "blessed" } },
  }),
  tile({
    id: "dud",
    height: 2,
    intangible: true,
    interactions: { addStatus: { trigger: "step", statusId: "unwritten" } },
  }),
  tile({
    id: "portal",
    height: 4,
    intangible: true,
    interactions: {
      teleport: { trigger: "step", destination: { kind: "absolute" } },
    },
  }),
  tile({ id: "mud", height: 0, walkSpeedPercent: -75 }),
  tile({ id: "road", height: 0, walkSpeedPercent: 100 }),
  tile({ id: "water", height: 0, walkSpeedPercent: -50, wade: true }),
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

function ground(map: MapFile, x: number, y: number, tileId: string): MapFile {
  return replaceStack(map, x, y, 0, [{ tileId }]);
}

function river(
  map: MapFile,
  half: number,
  x0: number,
  x1: number,
  tileId: string,
  crossings: number[],
): MapFile {
  for (let x = x0; x <= x1; x++) {
    for (let y = -half; y <= half; y++) {
      if (!crossings.includes(y)) map = ground(map, x, y, tileId);
    }
  }
  return map;
}

const statusDefs: Record<string, StatusDef> = {
  burned: status("burned", "bad"),
  blessed: status("blessed", "good"),
};

function status(id: string, tone: StatusTone): StatusDef {
  return { ...DEFAULT_STATUS_SOURCE, everyMs: constantFormula(0), id, name: id, tone };
}

function standing(x: number, y: number, z = 0, stackIndex = 1) {
  return { x, y, z, stackIndex };
}

function search(
  map: MapFile,
  from: Coord & { stackIndex: number },
  to: Coord,
  opts?: Parameters<typeof findPath>[6],
): PathOutcome {
  return findPath(map, { at: from, self: from }, to, rat, tilesById, statusDefs, opts);
}

function route(
  map: MapFile,
  from: Coord & { stackIndex: number },
  to: Coord,
  opts?: Parameters<typeof findPath>[6],
): PathStep[] | null {
  const found = search(map, from, to, opts);
  return found.ok ? found.route : null;
}

function refusal(
  map: MapFile,
  from: Coord & { stackIndex: number },
  to: Coord,
  opts?: Parameters<typeof findPath>[6],
): PathRefusal | null {
  const found = search(map, from, to, opts);
  return found.ok ? null : found.why;
}

function walked(path: PathStep[] | null): Direction[] | null {
  return path?.map((step) => step.direction) ?? null;
}

describe("crossing open ground", () => {
  it("walks straight at somebody, stopping beside them", () => {
    const map = field(6);

    expect(walked(route(map, standing(0, 0), { x: 4, y: 0, z: 0 }))).toEqual(["e", "e", "e"]);
  });

  it("has nothing left to walk once it is beside them", () => {
    const map = field(4);

    expect(route(map, standing(0, 0), { x: 1, y: 0, z: 0 })).toEqual([]);
  });

  it("gives up on somebody who has left the board's walkable part", () => {
    let map = field(4);
    for (const [x, y] of [
      [3, 0],
      [5, 0],
      [4, 1],
      [4, -1],
    ]) {
      map = put(map, x!, y!, "wall");
    }

    expect(route(map, standing(0, 0), { x: 4, y: 0, z: 0 })).toBeNull();
  });
});

describe("arriving beside, or on", () => {
  it("stops one short by default, and walks in when asked", () => {
    const map = field(6);
    const goal = { x: 4, y: 0, z: 0 };

    expect(walked(route(map, standing(0, 0), goal))).toEqual(["e", "e", "e"]);
    expect(walked(route(map, standing(0, 0), goal, { arrive: "on" }))).toEqual([
      "e",
      "e",
      "e",
      "e",
    ]);
  });

  it("still has a step to walk when it is merely beside the cell", () => {
    const map = field(4);
    const goal = { x: 1, y: 0, z: 0 };

    expect(route(map, standing(0, 0), goal)).toEqual([]);
    expect(walked(route(map, standing(0, 0), goal, { arrive: "on" }))).toEqual(["e"]);
  });

  it("has nothing to walk when it is already standing there", () => {
    const map = field(4);

    expect(route(map, standing(0, 0), { x: 0, y: 0, z: 0 }, { arrive: "on" })).toEqual([]);
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
    const budget = { maxNodes: 400 };

    const beside = route(map, standing(0, 0), goal, budget);
    const onto = route(map, standing(0, 0), goal, { ...budget, arrive: "on" });

    expect(beside).toHaveLength(7);
    expect(onto).toHaveLength(8);
    expect(onto?.at(-1)?.to).toEqual(goal);
  });
});

describe("the box a rat could not get past", () => {
  it("goes round a single crate rather than pressing against it", () => {
    const map = put(field(4), 1, 0, "crate");

    const path = route(map, standing(0, 0), { x: 2, y: 0, z: 0 });

    expect(walked(path)).toHaveLength(3);
    expect(walked(path)?.[0]).toMatch(/^[ns]$/);
    expect(path?.at(-1)?.to.x).toBe(2);
  });

  it("goes the long way round a wall it cannot see past", () => {
    let map = field(6);
    for (let y = -2; y <= 2; y++) map = put(map, 1, y, "wall");

    const path = route(map, standing(0, 0), { x: 2, y: 0, z: 0 });

    expect(path).toHaveLength(7);
    expect(path?.at(-1)?.to.x).toBe(2);
    expect(Math.abs(path?.at(-1)?.to.y ?? 0)).toBe(1);
  });
});

describe("heights", () => {
  it("steps up half a level without going round", () => {
    const map = put(field(4), 1, 0, "step");

    expect(walked(route(map, standing(0, 0), { x: 2, y: 0, z: 0 }))).toEqual(["e"]);
  });

  it("walks round a full level rather than scaling it", () => {
    const map = put(field(4), 1, 0, "block");

    const path = walked(route(map, standing(0, 0), { x: 2, y: 0, z: 0 }));

    expect(path).toHaveLength(3);
    expect(path?.[0]).toMatch(/^[ns]$/);
  });

  it("climbs to the floor above by the one route up", () => {
    let map = field(6);
    map = put(map, 1, 0, "step");
    for (let x = 2; x <= 5; x++) map = put(map, x, 0, "block");

    const path = route(map, standing(0, 0), { x: 5, y: 0, z: 1 });

    expect(walked(path)).toEqual(["e", "e", "e", "e"]);
    expect(path?.map((step) => step.to.z)).toEqual([0, 1, 1, 1]);
  });

  it("will not walk under somebody it cannot reach", () => {
    let map = field(4);
    map = replaceStack(map, 2, 0, 1, [{ tileId: "grass" }]);

    expect(route(map, standing(0, 0), { x: 2, y: 0, z: 1 })).toBeNull();
  });
});

function plateau(): MapFile {
  let map = field(6);
  for (let x = 0; x <= 2; x++) map = put(map, x, 0, "block");
  return map;
}

describe("ledges", () => {
  it("refuses a ledge by default, and stays up there", () => {
    expect(route(plateau(), standing(0, 0, 1, 0), { x: 5, y: 0, z: 0 })).toBeNull();
  });

  it("takes the ledge when the action allows it, landing where it falls", () => {
    const path = route(
      plateau(),
      standing(0, 0, 1, 0),
      { x: 5, y: 0, z: 0 },
      {
        drops: "anywhere",
      },
    );

    expect(walked(path)).toEqual(["e", "e", "e", "e"]);
    expect(path?.map((step) => step.to.z)).toEqual([1, 1, 0, 0]);
  });
});

describe("a drop that has to be the destination", () => {
  function stairs(): MapFile {
    let map = field(3);
    for (let x = 0; x <= 2; x++) map = put(map, x, 0, "block");
    return put(map, 3, 0, "step");
  }

  it("steps off the ledge when the landing is the cell asked for", () => {
    const path = route(
      plateau(),
      standing(0, 0, 1, 0),
      { x: 3, y: 0, z: 0 },
      {
        drops: "toGoal",
        arrive: "on",
      },
    );

    expect(walked(path)).toEqual(["e", "e", "e"]);
    expect(path?.map((step) => step.to.z)).toEqual([1, 1, 0]);
  });

  it("refuses the same fall when it lands somewhere else", () => {
    expect(
      route(
        plateau(),
        standing(0, 0, 1, 0),
        { x: 5, y: 0, z: 0 },
        {
          drops: "toGoal",
          arrive: "on",
        },
      ),
    ).toBeNull();
  });

  it("walks the long way down rather than stepping off on the way past", () => {
    const shortcut = route(
      stairs(),
      standing(0, 0, 1, 0),
      { x: 0, y: -2, z: 0 },
      {
        drops: "anywhere",
        arrive: "on",
      },
    );
    expect(walked(shortcut)).toEqual(["n", "n"]);

    const path = route(
      stairs(),
      standing(0, 0, 1, 0),
      { x: 0, y: -2, z: 0 },
      {
        drops: "toGoal",
        arrive: "on",
      },
    );

    expect(walked(path)?.[0]).toBe("e");
    expect(path).toHaveLength(8);
  });
});

describe("a cell that fires when you land on it", () => {
  function inTheWay(tileId: string): MapFile {
    return put(field(6), 1, 0, tileId);
  }

  it("goes round a flame rather than through it", () => {
    const legs = walked(route(inTheWay("flame"), standing(0, 0), { x: 3, y: 0, z: 0 }));

    expect(legs?.[0]).toMatch(/^[ns]$/);
  });

  it("walks over a shrine, which is the same block with the other tone", () => {
    const legs = walked(route(inTheWay("shrine"), standing(0, 0), { x: 3, y: 0, z: 0 }));

    expect(legs?.[0]).toBe("e");
  });

  it("walks over a status the catalogue has never heard of", () => {
    const legs = walked(route(inTheWay("dud"), standing(0, 0), { x: 3, y: 0, z: 0 }));

    expect(legs?.[0]).toBe("e");
  });

  it("goes round a portal, which no tone makes safe", () => {
    const legs = walked(route(inTheWay("portal"), standing(0, 0), { x: 3, y: 0, z: 0 }));

    expect(legs?.[0]).toMatch(/^[ns]$/);
  });

  it("walks over a flame nobody is landing on to set off", () => {
    const legs = walked(route(inTheWay("brazier"), standing(0, 0), { x: 3, y: 0, z: 0 }));

    expect(legs?.[0]).toBe("e");
  });

  describe("a flame the walker conjured", () => {
    function litBy(castBy: string): MapFile {
      return replaceStack(field(6), 1, 0, 0, [{ tileId: "grass" }, { tileId: "flame", castBy }]);
    }

    function legs(map: MapFile, who?: string): Direction[] | null {
      const from = standing(0, 0);
      const found = findPath(
        map,
        { at: from, self: from, who },
        { x: 3, y: 0, z: 0 },
        rat,
        tilesById,
        statusDefs,
      );
      return found.ok ? walked(found.route) : null;
    }

    it("is walked straight through by the one who lit it", () => {
      expect(legs(litBy("rat"), "rat")?.[0]).toBe("e");
    });

    it("is still gone round by everybody else", () => {
      expect(legs(litBy("somebody-else"), "rat")?.[0]).toMatch(/^[ns]$/);
    });

    it("is gone round by a search told nobody, as it always was", () => {
      expect(legs(litBy("rat"))?.[0]).toMatch(/^[ns]$/);
    });
  });

  it("refuses a goal whose only way in is through a flame", () => {
    let map = field(6);
    for (let y = -6; y <= 6; y++) map = put(map, 1, y, "wall");
    map = put(map, 1, 0, "flame");

    expect(route(map, standing(0, 0), { x: 3, y: 0, z: 0 })).toBeNull();
    expect(route(put(map, 1, 0, "grass"), standing(0, 0), { x: 3, y: 0, z: 0 })).not.toBeNull();
  });

  it("steps onto the cell that was asked for", () => {
    const map = inTheWay("portal");

    const legs = walked(route(map, standing(0, 0), { x: 1, y: 0, z: 0 }, { arrive: "on" }));

    expect(legs).toEqual(["e"]);
  });

  it("steps into a flame that was asked for", () => {
    const map = inTheWay("flame");

    const legs = walked(route(map, standing(0, 0), { x: 1, y: 0, z: 0 }, { arrive: "on" }));

    expect(legs).toEqual(["e"]);
  });

  it("will not stand in a flame merely because it is beside the goal", () => {
    const map = inTheWay("flame");

    const legs = walked(route(map, standing(0, 0), { x: 2, y: 0, z: 0 }));

    expect(legs?.[0]).toMatch(/^[ns]$/);
  });

  describe("a drop that would land in one", () => {
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
      const legs = route(
        trench("flame"),
        standing(0, 0, 1, 0),
        { x: 4, y: 0, z: 0 },
        {
          arrive: "on",
          drops: "anywhere",
        },
      );

      expect(legs).not.toBeNull();
      expect(legs!.map((leg) => leg.to)).not.toContainEqual({ x: 2, y: 0, z: 0 });
    });

    it("takes the same drop when the flame is what was asked for", () => {
      const legs = route(
        trench("flame"),
        standing(0, 0, 1, 0),
        { x: 2, y: 0, z: 0 },
        {
          arrive: "on",
          drops: "toGoal",
        },
      );

      expect(walked(legs)).toEqual(["e", "e"]);
    });

    it("drops straight in when the bottom is bare ground", () => {
      const legs = route(
        trench("grass"),
        standing(0, 0, 1, 0),
        { x: 4, y: 0, z: 0 },
        {
          arrive: "on",
          drops: "anywhere",
        },
      );

      expect(legs!.map((leg) => leg.to)).toContainEqual({ x: 2, y: 0, z: 0 });
    });
  });
});

describe("how far out of its way", () => {
  function screen(reach: number): MapFile {
    let map = field(reach + 2);
    for (let y = -reach; y <= reach; y++) map = put(map, 1, y, "wall");
    return map;
  }

  it("rounds a screen it can get past in a few extra steps", () => {
    const path = route(
      screen(2),
      standing(0, 0),
      { x: 2, y: 0, z: 0 },
      {
        maxNodes: 400,
      },
    );

    expect(path).toHaveLength(7);
  });

  it("refuses one it would have to walk the long way round", () => {
    expect(route(screen(10), standing(0, 0), { x: 2, y: 0, z: 0 }, { maxNodes: 400 })).toBeNull();
  });
});

describe("what it costs", () => {
  it("gives up rather than sweeping the board", () => {
    const map = field(40);

    expect(
      route(
        map,
        standing(-40, -40),
        { x: 40, y: 40, z: 0 },
        {
          maxNodes: 8,
        },
      ),
    ).toBeNull();
  });

  it("proves a sealed target impossible inside the budget", () => {
    let map = field(30);
    for (let y = -30; y <= 30; y++) map = put(map, 1, y, "wall");

    expect(route(map, standing(0, 0), { x: 2, y: 0, z: 0 })).toBeNull();
  });

  it("finds an open-field route without exploring the whole budget", () => {
    const map = field(30);
    let expanded = 0;
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

describe("saying which limit was hit", () => {
  it("calls a sealed target unreachable, having looked everywhere", () => {
    let map = field(4);
    for (const [x, y] of [
      [3, 0],
      [5, 0],
      [4, 1],
      [4, -1],
    ]) {
      map = put(map, x!, y!, "wall");
    }

    expect(refusal(map, standing(0, 0), { x: 4, y: 0, z: 0 })).toBe("unreachable");
  });

  it("will not claim it looked everywhere when it turned cells away", () => {
    let map = field(12);
    for (const [x, y] of [
      [3, 0],
      [5, 0],
      [4, 1],
      [4, -1],
    ]) {
      map = put(map, x!, y!, "wall");
    }

    expect(refusal(map, standing(0, 0), { x: 4, y: 0, z: 0 }, { maxNodes: 2000 })).toBe("detour");
  });

  it("calls a long way round a detour rather than no way at all", () => {
    let map = field(12);
    for (let y = -10; y <= 10; y++) map = put(map, 1, y, "wall");

    expect(refusal(map, standing(0, 0), { x: 2, y: 0, z: 0 }, { maxNodes: 2000 })).toBe("detour");
  });

  it("calls a search it stopped early a budget, not a board", () => {
    const map = field(40);

    expect(refusal(map, standing(-40, -40), { x: 40, y: 40, z: 0 }, { maxNodes: 8 })).toBe(
      "budget",
    );
  });

  it("has no reason to give when it found a route", () => {
    expect(refusal(field(4), standing(0, 0), { x: 2, y: 0, z: 0 })).toBeNull();
    expect(refusal(field(4), standing(0, 0), { x: 1, y: 0, z: 0 })).toBeNull();
  });
});

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

describe("finding somewhere to run", () => {
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
    expect(route.length).toBeGreaterThan(0);
    const arrived = route[route.length - 1]!.to;
    expect(stepsApart(arrived, { x: -4, y: 0, z: 0 })).toBeGreaterThan(4);
  });

  it("leaves a pocket whose only way out passes the threat", () => {
    let map = field(12);
    map = put(map, 1, 0, "wall");
    map = put(map, 0, -1, "wall");
    map = put(map, 0, 1, "wall");

    const found = refuge(map, standing(0, 0), { x: -3, y: 0, z: 0 });

    expect(found).not.toBeNull();
    expect(stepsApart(found!, { x: -3, y: 0, z: 0 })).toBeGreaterThan(3);
  });

  it("will not run into a flame to open the distance", () => {
    function corridor(atMinusOne: string): MapFile {
      let map = field(12);
      for (let x = -12; x <= 12; x++) {
        map = put(map, x, -1, "wall");
        map = put(map, x, 1, "wall");
      }
      map = put(map, 6, 0, "wall");
      return put(map, -1, 0, atMinusOne);
    }

    expect(refuge(corridor("flame"), standing(0, 0), { x: 4, y: 0, z: 0 })).toBeNull();

    const away = refuge(corridor("grass"), standing(0, 0), { x: 4, y: 0, z: 0 });
    expect(away!.x).toBeLessThan(-1);
  });

  it("stays put when it is walled in, and says so with an empty route", () => {
    let map = field(12);
    for (const [x, y] of [
      [1, 0],
      [-1, 0],
      [0, -1],
      [0, 1],
    ]) {
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

  it("prefers a refuge the threat cannot see, where two are equally far", () => {
    const map = field(12);
    const found = refuge(
      map,
      standing(0, 0),
      { x: 0, y: 0, z: 0 },
      {
        seenFrom: (cell) => cell.y >= 0,
      },
    );

    expect(found).not.toBeNull();
    expect(found!.y).toBeLessThan(0);
  });

  it("does not double back towards a threat for the sake of a wall", () => {
    const map = field(12);
    const threat = { x: -6, y: 0, z: 0 };
    const found = refuge(map, standing(0, 0), threat, {
      seenFrom: (cell) => stepsApart(cell, threat) > 8,
    });

    expect(found).not.toBeNull();
    expect(stepsApart(found!, threat)).toBeGreaterThan(8);
  });

  it("looks no further than its budget lets it", () => {
    const map = field(30);
    const near = refuge(map, standing(0, 0), { x: 0, y: 0, z: 0 }, { maxNodes: 8 });
    const far = refuge(map, standing(0, 0), { x: 0, y: 0, z: 0 }, { maxNodes: REFUGE_MAX_NODES });

    expect(stepsApart(near!, { x: 0, y: 0, z: 0 })).toBeLessThan(
      stepsApart(far!, { x: 0, y: 0, z: 0 }),
    );
  });

  it("takes a drop only when the animal is allowed to", () => {
    let map = field(6);
    for (let y = 0; y <= 6; y++) {
      map = replaceStack(map, 0, y, 0, [{ tileId: "grass" }, { tileId: "block" }]);
    }
    const on = { x: 0, y: 3, z: 1, stackIndex: 0 };
    const threat = { x: 0, y: 6, z: 1 };

    const along = refuge(map, on, threat, { drops: "never" })!;
    expect(along.z).toBe(1);
    const leapt = refuge(map, on, threat, { drops: "anywhere" })!;
    expect(leapt.z).toBe(0);
    expect(stepsApart(leapt, threat)).toBeGreaterThan(stepsApart(along, threat));
  });
});

describe("slow ground", () => {
  const half = 6;
  const from = standing(-3, 0);
  const goal = { x: 4, y: 0, z: 0 };
  const northmost = (path: PathStep[] | null) => Math.min(...path!.map((step) => step.to.y));

  it("costs a leg by the ground it is taken from, never under one step", () => {
    const map = ground(ground(field(2), 1, 0, "mud"), 2, 0, "road");

    expect(legCost(map, { x: 0, y: 0, z: 0 }, tilesById)).toBe(1);
    expect(legCost(map, { x: 1, y: 0, z: 0 }, tilesById)).toBe(4);
    expect(legCost(map, { x: 2, y: 0, z: 0 }, tilesById)).toBe(1);
  });

  it("walks round to a crossing when that is quicker than wading", () => {
    const map = river(field(half), half, -1, 1, "mud", [-2]);

    expect(northmost(route(map, from, goal))).toBe(-2);
  });

  it("wades straight across when the crossing is further off than that", () => {
    const map = river(field(half), half, -1, 1, "mud", [-5]);

    expect(walked(route(map, from, goal))).toEqual(["e", "e", "e", "e", "e", "e"]);
  });

  it("does not go out of its way for fast ground", () => {
    let map = field(half);
    for (let x = -3; x <= 4; x++) map = ground(map, x, -1, "road");

    expect(walked(route(map, from, goal))).toEqual(["e", "e", "e", "e", "e", "e"]);
  });

  it("runs from a threat by the quickest ground, not the fewest steps", () => {
    let map = emptyMap();
    for (let x = -12; x <= 12; x++) {
      map = replaceStack(map, x, 0, 0, [{ tileId: x < 0 ? "mud" : "grass" }]);
    }
    const flooded = findRefuge(
      map,
      { at: standing(0, 0), self: standing(0, 0) },
      { x: 1, y: -2, z: 0 },
      rat,
      tilesById,
      statusDefs,
      { maxNodes: 12 },
    );

    expect(flooded.ok && flooded.route.at(-1)!.to.x).toBeGreaterThan(0);
  });
});

describe("water, for a body that cannot swim", () => {
  const half = 6;
  const from = standing(-3, 0);
  const goal = { x: 4, y: 0, z: 0 };
  const northmost = (path: PathStep[] | null) => Math.min(...path!.map((step) => step.to.y));

  it("wades a narrow river when it may", () => {
    const map = river(field(half), half, 0, 0, "water", [-4]);

    expect(walked(route(map, from, goal))).toEqual(["e", "e", "e", "e", "e", "e"]);
  });

  it("walks to the crossing when it may not, however far round that is", () => {
    const map = river(field(half), half, 0, 0, "water", [-4]);

    expect(northmost(route(map, from, goal, { avoidWade: true }))).toBe(-4);
  });

  it("finds no way across a river with no crossing", () => {
    const map = river(field(half), half, 0, 0, "water", []);

    expect(route(map, from, goal, { avoidWade: true })).toBeNull();
  });

  it("wades on through water it is already standing in", () => {
    const map = river(field(half), half, -1, 1, "water", []);

    expect(walked(route(map, standing(0, 0), { x: 3, y: 0, z: 0 }, { avoidWade: true }))).toEqual([
      "e",
      "e",
    ]);
  });

  it("steps into water that is the cell asked for", () => {
    const map = ground(field(half), 2, 0, "water");

    expect(
      walked(route(map, standing(0, 0), { x: 2, y: 0, z: 0 }, { arrive: "on", avoidWade: true })),
    ).toEqual(["e", "e"]);
  });

  it("does not run into water to open the distance", () => {
    let map = field(half);
    for (let x = 1; x <= half; x++) {
      for (let y = -half; y <= half; y++) map = ground(map, x, y, "water");
    }
    const flooded = findRefuge(
      map,
      { at: standing(0, 0), self: standing(0, 0) },
      { x: 0, y: -1, z: 0 },
      rat,
      tilesById,
      statusDefs,
      { avoidWade: true },
    );

    expect(flooded.ok).toBe(true);
    for (const step of flooded.ok ? flooded.route : []) expect(step.to.x).toBeLessThanOrEqual(0);
  });
});
