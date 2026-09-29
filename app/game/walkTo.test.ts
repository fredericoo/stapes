import { describe, expect, it } from "vitest";
import { emptyMap, replaceStack } from "../lib/mapData";
import { constantFormula } from "../lib/formula";
import { DEFAULT_STATUS_SOURCE } from "../lib/status";
import type { StatusDef } from "../lib/status";
import type { Coord, Direction, MapFile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL } from "../lib/types";
import type { GameInput } from "./GameSession";
import { PLAYER_TILE_ID } from "./constants";
import { HeldDirections } from "./heldDirections";
import { noRouteNotice } from "./notices";
import { WalkTo, standingCellOn, type WalkView } from "./walkTo";
import { tile } from "../lib/testTile";

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "wall", height: HEIGHT_PER_LEVEL, walkable: false }),
  tile({ id: "crate", height: 2, walkable: false }),
  tile({ id: "block", height: HEIGHT_PER_LEVEL }),
  tile({ id: "step", height: 2 }),
  tile({
    id: PLAYER_TILE_ID,
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
];

const tilesById = Object.fromEntries(tiles.map((def) => [def.id, def]));
const playerDef = tilesById[PLAYER_TILE_ID]!;

const statusDefs: Record<string, StatusDef> = {
  burned: {
    ...DEFAULT_STATUS_SOURCE,
    everyMs: constantFormula(0),
    id: "burned",
    name: "Burned",
    tone: "bad",
  },
};

function bare(half: number): MapFile {
  let map = emptyMap();
  for (let x = -half; x <= half; x++) {
    for (let y = -half; y <= half; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  return map;
}

function field(half: number): MapFile {
  return replaceStack(bare(half), 0, 0, 0, [{ tileId: "grass" }, { tileId: PLAYER_TILE_ID }]);
}

function put(map: MapFile, x: number, y: number, tileId: string): MapFile {
  return replaceStack(map, x, y, 0, [{ tileId: "grass" }, { tileId }]);
}

function elbow(): MapFile {
  let map = emptyMap();
  for (let x = 0; x <= 2; x++) {
    map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
  }
  for (let y = 1; y <= 3; y++) {
    map = replaceStack(map, 2, y, 0, [{ tileId: "grass" }]);
  }
  return replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: PLAYER_TILE_ID }]);
}

function corridor(half: number): MapFile {
  let map = field(half);
  for (let x = -half; x <= half; x++) {
    map = put(map, x, -1, "wall");
    map = put(map, x, 1, "wall");
  }
  return map;
}

function holed(half: number): MapFile {
  let map = bare(half);
  for (let x = -half; x <= half; x++) {
    for (let y = -half; y <= half; y++) {
      map = put(map, x, y, "block");
    }
  }
  map = replaceStack(map, 2, 0, 0, [{ tileId: "grass" }]);
  return replaceStack(map, 0, 0, 1, [{ tileId: PLAYER_TILE_ID }]);
}

function shelf(): MapFile {
  let map = bare(3);
  for (let x = 0; x <= 2; x++) map = put(map, x, 0, "block");
  map = put(map, 3, 0, "step");
  return replaceStack(map, 0, 0, 1, [{ tileId: PLAYER_TILE_ID }]);
}

const HOME = { x: 0, y: 0, z: 0, stackIndex: 1 };

const UPSTAIRS = { x: 0, y: 0, z: 1, stackIndex: 0 };

const WALKER = "walker";

function view(
  map: MapFile,
  opts: {
    at?: Coord & { stackIndex: number };
    stepping?: Coord;
    bodies?: Record<string, Coord>;
  } = {},
): WalkView {
  return {
    map,
    who: WALKER,
    at: opts.at ?? HOME,
    stepping: opts.stepping ?? null,
    def: playerDef,
    tilesById,
    statusDefs,
    bodyAt: (actorId) => opts.bodies?.[actorId] ?? null,
  };
}

function ground(x: number, y: number) {
  return { x, y, z: 0, stackIndex: 0 };
}

function walker() {
  const asked: GameInput[] = [];
  const input = new HeldDirections((i) => asked.push(i));
  const walk = new WalkTo(input);
  return {
    walk,
    input,
    asked,
    last(): Direction[] | null {
      return asked.at(-1)?.directions ?? null;
    },
  };
}

describe("setting off", () => {
  it("hands over the first leg the moment it is clicked", () => {
    const { walk, last } = walker();

    walk.start(ground(3, 0), view(field(6)));

    expect(last()).toEqual(["e"]);
    expect(walk.walking).toBe(true);
  });

  it("walks round what is in the way rather than pressing against it", () => {
    const { walk, last } = walker();

    walk.start(ground(2, 0), view(put(field(6), 1, 0, "crate")));

    expect(last()?.[0]).toMatch(/^[ns]$/);
  });

  it("stands still when the cell clicked is the one it is standing in", () => {
    const { walk, asked } = walker();

    walk.start(ground(0, 0), view(field(6)));

    expect(walk.walking).toBe(false);
    expect(asked).toEqual([]);
  });
});

describe("while a step is being walked", () => {
  it("names the leg after the one in flight", () => {
    const { walk, last } = walker();
    const map = field(6);

    walk.start(ground(0, 3), view(map));
    expect(last()).toEqual(["s"]);

    walk.tick(view(map, { stepping: { x: 0, y: 1, z: 0 } }));

    expect(last()).toEqual(["s"]);
  });

  it("turns a corner one leg early rather than one leg late", () => {
    const { walk, last } = walker();
    const map = put(field(6), 1, 0, "crate");

    walk.start(ground(2, 0), view(map));
    const aside = last()?.[0] === "n" ? { x: 0, y: -1 } : { x: 0, y: 1 };

    walk.tick(view(map, { stepping: { ...aside, z: 0 } }));

    expect(last()).toEqual(["e"]);
  });

  it("turns back past the cell its own body is still in", () => {
    const { walk, last } = walker();
    const map = corridor(6);

    walk.start(ground(-5, 0), view(map, { stepping: { x: 1, y: 0, z: 0 } }));

    expect(last()).toEqual(["w"]);
    expect(walk.drainNotices()).toEqual([]);
  });
});

describe("a key held across a click", () => {
  it("walks where it was clicked, over a key already down", () => {
    const { walk, input, last } = walker();
    input.press("e");

    walk.start(ground(0, 3), view(field(6)));

    expect(last()).toEqual(["s"]);
  });

  it("gives the key back rather than emptying the input", () => {
    const { walk, input, last } = walker();
    const map = field(6);
    input.press("e");

    walk.start(ground(0, 3), view(map));
    walk.tick(view(map, { at: { x: 0, y: 3, z: 0, stackIndex: 1 } }));

    expect(walk.walking).toBe(false);
    expect(last()).toEqual(["e"]);
  });

  it("gives up when a key is pressed during the walk", () => {
    const { walk, input, last } = walker();
    const map = field(6);

    walk.start(ground(0, 3), view(map));
    input.press("n");
    walk.tick(view(map, { stepping: { x: 0, y: 1, z: 0 } }));

    expect(walk.walking).toBe(false);
    expect(last()).toEqual(["n"]);
  });

  it("walks under whatever modifiers are being held", () => {
    const { walk, input, asked } = walker();
    input.setModifiers({ faceOnly: true, preferDescend: false });

    walk.start(ground(3, 0), view(field(6)));

    expect(asked.at(-1)).toEqual({
      directions: ["e"],
      faceOnly: true,
      preferDescend: false,
    });
  });
});

describe("a board that moves under a walk", () => {
  it("routes round something dropped in the way after the click", () => {
    const { walk, last } = walker();

    walk.start(ground(3, 0), view(field(6)));
    expect(last()).toEqual(["e"]);

    walk.tick(view(put(field(6), 1, 0, "crate")));

    expect(last()?.[0]).toMatch(/^[ns]$/);
  });

  it("stops on its own once it is standing on the cell", () => {
    const { walk, last } = walker();
    let map = field(6);
    map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: PLAYER_TILE_ID }]);

    walk.start(ground(1, 0), view(field(6)));
    walk.tick(view(map, { at: { x: 1, y: 0, z: 0, stackIndex: 1 } }));

    expect(last()).toEqual([]);
    expect(walk.walking).toBe(false);
  });
});

describe("a cell with no way to it", () => {
  it("says so, once, and does not set off", () => {
    const { walk, asked } = walker();
    let map = field(6);
    for (let y = -6; y <= 6; y++) map = put(map, 1, y, "wall");

    walk.start(ground(3, 0), view(map));

    expect(asked).toEqual([]);
    expect(walk.walking).toBe(false);
    expect(walk.drainNotices()).toEqual([noRouteNotice("detour")]);
    expect(walk.drainNotices()).toEqual([]);
  });

  it("says so for a wall with no cell beside it either", () => {
    const { walk } = walker();
    let map = replaceStack(emptyMap(), 2, 0, 0, [{ tileId: "grass" }, { tileId: "wall" }]);
    map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: PLAYER_TILE_ID }]);

    walk.start({ x: 2, y: 0, z: 0, stackIndex: 1 }, view(map));

    expect(walk.walking).toBe(false);
    expect(walk.drainNotices()).toEqual([noRouteNotice("unreachable")]);
  });
});

describe("clicking something you cannot stand on", () => {
  it("walks to the foot of a wall rather than refusing it", () => {
    const { walk, last } = walker();
    const map = put(field(6), 3, 0, "wall");

    walk.start({ x: 3, y: 0, z: 0, stackIndex: 1 }, view(map));

    expect(walk.walking).toBe(true);
    expect(last()).toEqual(["e"]);
    expect(walk.drainNotices()).toEqual([]);
  });

  it("stops in the cell beside it rather than pressing on into it", () => {
    const { walk, last } = walker();
    const map = put(field(6), 2, 0, "wall");

    walk.start({ x: 2, y: 0, z: 0, stackIndex: 1 }, view(map));
    walk.tick(view(map, { at: { x: 1, y: 0, z: 0, stackIndex: 1 } }));

    expect(walk.walking).toBe(false);
    expect(last()).toEqual([]);
  });

  it("does not set off at all from a cell already beside it", () => {
    const { walk, asked } = walker();
    const map = put(field(6), 1, 0, "wall");

    walk.start({ x: 1, y: 0, z: 0, stackIndex: 1 }, view(map));

    expect(walk.walking).toBe(false);
    expect(asked).toEqual([]);
    expect(walk.drainNotices()).toEqual([]);
  });

  it("goes round to the reachable side rather than the nearest one", () => {
    const { walk, last } = walker();
    let map = field(6);
    map = put(map, 2, 0, "wall");
    for (const y of [-1, 0, 1]) map = put(map, 1, y, "wall");

    walk.start({ x: 2, y: 0, z: 0, stackIndex: 1 }, view(map));

    expect(walk.walking).toBe(true);
    expect(last()?.[0]).toMatch(/^[ns]$/);
  });
});

describe("a cell below the one it is standing on", () => {
  it("walks to the bottom of a hole that was clicked", () => {
    const { walk, last } = walker();
    const map = holed(4);

    walk.start(ground(2, 0), view(map, { at: UPSTAIRS }));

    expect(walk.drainNotices()).toEqual([]);
    expect(last()).toEqual(["e"]);

    walk.tick(view(map, { at: { x: 1, y: 0, z: 1, stackIndex: 0 } }));
    expect(walk.walking).toBe(true);
    expect(last()).toEqual(["e"]);

    walk.tick(view(map, { at: { x: 2, y: 0, z: 0, stackIndex: 1 } }));
    expect(walk.walking).toBe(false);
  });

  it("goes the long way down rather than stepping off on the way past", () => {
    const { walk, last } = walker();

    walk.start(ground(0, -2), view(shelf(), { at: UPSTAIRS }));

    expect(last()).toEqual(["e"]);
    expect(walk.drainNotices()).toEqual([]);
  });
});

describe("a board that closes in front of a walk", () => {
  it("stops without a word, and lets go of the direction", () => {
    const { walk, last } = walker();

    walk.start(ground(3, 0), view(field(6)));
    expect(walk.drainNotices()).toEqual([]);

    let map = field(6);
    for (let y = -6; y <= 6; y++) map = put(map, 1, y, "wall");
    walk.tick(view(map));

    expect(walk.walking).toBe(false);
    expect(walk.drainNotices()).toEqual([]);
    expect(last()).toEqual([]);
  });
});

describe("calling it off", () => {
  it("empties the input, so nothing chains another step", () => {
    const { walk, last } = walker();

    walk.start(ground(3, 0), view(field(6)));
    walk.cancel();

    expect(last()).toEqual([]);
    expect(walk.walking).toBe(false);
  });

  it("touches nothing when there was no walk to call off", () => {
    const { walk, asked } = walker();

    walk.cancel();

    expect(asked).toEqual([]);
  });

  it("has nothing more to say once it has stopped", () => {
    const { walk, asked } = walker();

    walk.start(ground(3, 0), view(field(6)));
    walk.cancel();
    walk.tick(view(field(6)));

    expect(asked).toHaveLength(2);
  });
});

describe("following a body", () => {
  const THEM = "npc:them";

  function chasing(at: Coord, map: MapFile = field(6)) {
    return view(map, { bodies: { [THEM]: at } });
  }

  it("sets off towards whoever it was told to follow", () => {
    const { walk, last } = walker();

    walk.follow(THEM, chasing({ x: 3, y: 0, z: 0 }));

    expect(last()).toEqual(["e"]);
    expect(walk.followingId).toBe(THEM);
    expect(walk.walking).toBe(true);
  });

  it("stops beside them and keeps following", () => {
    const { walk, last } = walker();
    const map = field(6);

    walk.follow(THEM, chasing({ x: 2, y: 0, z: 0 }, map));
    walk.tick(
      view(map, {
        at: { x: 1, y: 0, z: 0, stackIndex: 1 },
        bodies: { [THEM]: { x: 2, y: 0, z: 0 } },
      }),
    );

    expect(last()).toEqual([]);
    expect(walk.walking).toBe(true);
    expect(walk.followingId).toBe(THEM);
  });

  it("sets off again by itself when they walk on", () => {
    const { walk, last } = walker();
    const map = field(6);
    const beside = { at: { x: 1, y: 0, z: 0, stackIndex: 1 } };

    walk.follow(THEM, chasing({ x: 2, y: 0, z: 0 }, map));
    walk.tick(view(map, { ...beside, bodies: { [THEM]: { x: 2, y: 0, z: 0 } } }));
    expect(last()).toEqual([]);

    walk.tick(view(map, { ...beside, bodies: { [THEM]: { x: 4, y: 0, z: 0 } } }));

    expect(last()).toEqual(["e"]);
  });

  it("yields to a key and takes the input back when it is let go", () => {
    const { walk, input, last } = walker();
    const map = field(6);
    const board = chasing({ x: 3, y: 0, z: 0 }, map);

    walk.follow(THEM, board);
    input.press("n");
    walk.tick(board);

    expect(last()).toEqual(["n"]);
    expect(walk.walking).toBe(true);

    input.release("n");
    walk.tick(board);

    expect(last()).toEqual(["e"]);
  });

  it("ends when the body is no longer in sight", () => {
    const { walk, last } = walker();
    const map = field(6);

    walk.follow(THEM, chasing({ x: 3, y: 0, z: 0 }, map));
    walk.tick(view(map));

    expect(walk.walking).toBe(false);
    expect(walk.followingId).toBeNull();
    expect(last()).toEqual([]);
    expect(walk.drainNotices()).toEqual([]);
  });

  it("waits rather than giving up when there is no way to them", () => {
    const { walk, asked } = walker();
    let map = field(6);
    for (let y = -6; y <= 6; y++) map = put(map, 1, y, "wall");

    walk.follow(THEM, chasing({ x: 3, y: 0, z: 0 }, map));

    expect(asked).toEqual([]);
    expect(walk.walking).toBe(true);
    expect(walk.drainNotices()).toEqual([noRouteNotice("detour")]);
  });

  it("is called off by a click somewhere else", () => {
    const { walk } = walker();
    const map = field(6);

    walk.follow(THEM, chasing({ x: 3, y: 0, z: 0 }, map));
    walk.start(ground(0, 3), chasing({ x: 3, y: 0, z: 0 }, map));

    expect(walk.followingId).toBeNull();
    expect(walk.walking).toBe(true);
  });

  it("is called off by following nobody", () => {
    const { walk, last } = walker();
    const board = chasing({ x: 3, y: 0, z: 0 });

    walk.follow(THEM, board);
    walk.follow(null, board);

    expect(walk.walking).toBe(false);
    expect(last()).toEqual([]);
  });
});

describe("a clicked walk past a flame", () => {
  it("sets off round it rather than into it", () => {
    const { walk, last } = walker();

    walk.start(ground(3, 0), view(put(field(6), 1, 0, "flame")));

    expect(last()?.[0]).toMatch(/^[ns]$/);
  });

  it("walks into one that was clicked, because that is what was asked for", () => {
    const { walk, last } = walker();

    walk.start({ x: 1, y: 0, z: 0, stackIndex: 1 }, view(put(field(6), 1, 0, "flame")));

    expect(last()).toEqual(["e"]);
  });
});

describe("which cell a tile means", () => {
  it("takes the ground itself for something with no height", () => {
    expect(standingCellOn(view(field(6)), ground(2, 0))).toEqual({
      x: 2,
      y: 0,
      z: 0,
    });
  });

  it("takes the level above for a tile that fills its own", () => {
    const map = replaceStack(field(6), 2, 0, 0, [{ tileId: "block" }]);

    expect(standingCellOn(view(map), { x: 2, y: 0, z: 0, stackIndex: 0 })).toEqual({
      x: 2,
      y: 0,
      z: 1,
    });
  });

  it("offers nothing for a wall, rather than its foot", () => {
    const map = put(field(6), 2, 0, "wall");

    expect(standingCellOn(view(map), { x: 2, y: 0, z: 0, stackIndex: 1 })).toBeNull();
  });
});

describe("asking the board only when the answer could have changed", () => {
  it("does not re-press the same direction on a frame that moved nobody", () => {
    const { walk, asked } = walker();
    const board = view(field(6));

    walk.start(ground(3, 0), board);
    walk.tick(board);
    walk.tick(board);

    expect(asked).toHaveLength(1);
    expect(asked[0]?.directions).toEqual(["e"]);
  });

  it("asks again once the body has somewhere new to think from", () => {
    const { walk, asked, last } = walker();
    const board = elbow();

    walk.start(ground(2, 3), view(board));
    expect(last()).toEqual(["e"]);
    walk.tick(view(board, { stepping: { x: 2, y: 0, z: 0 } }));

    expect(asked).toHaveLength(2);
    expect(last()).toEqual(["s"]);
  });

  it("re-routes on a click that replaces a walk already under way", () => {
    const { walk, asked, last } = walker();
    const board = view(field(6));

    walk.start(ground(3, 0), board);
    walk.start(ground(0, 3), board);

    expect(asked).toHaveLength(2);
    expect(last()).toEqual([last()?.[0]]);
    expect(last()?.[0]).not.toBe("e");
  });
});

describe("clicking into a hole", () => {
  function pit(bottom: string[]): MapFile {
    let map = emptyMap();
    for (let x = -3; x <= 3; x++) {
      for (let y = -3; y <= 3; y++) {
        map = replaceStack(map, x, y, -2, [{ tileId: "grass" }]);
        map = replaceStack(map, x, y, -1, [{ tileId: "block" }]);
        map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
      }
    }
    map = replaceStack(map, 0, -1, 0, []);
    map = replaceStack(
      map,
      0,
      -1,
      -1,
      bottom.map((tileId) => ({ tileId })),
    );
    return replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: PLAYER_TILE_ID }]);
  }

  it("steps in when the fall ends on ground", () => {
    const { walk, last } = walker();
    const map = pit(["grass"]);
    const ground = { x: 0, y: -1, z: -1, stackIndex: 0 };

    walk.start(ground, view(map));

    expect(standingCellOn(view(map), ground)).toEqual({ x: 0, y: -1, z: -1 });
    expect(last()).toEqual(["n"]);
    expect(walk.walking).toBe(true);
    expect(walk.drainNotices()).toEqual([]);
  });

  it("does not step in when the fall ends on a crate nobody can stand on", () => {
    const { walk, asked } = walker();
    const map = pit(["grass", "crate"]);
    const crate = { x: 0, y: -1, z: -1, stackIndex: 1 };

    walk.start(crate, view(map));

    expect(standingCellOn(view(map), crate)).toBeNull();
    expect(asked.flatMap((input) => input.directions)).not.toContain("n");
  });

  it("still reads a wall on ordinary ground as a thing, not a hole", () => {
    const { walk, asked } = walker();
    const map = put(field(3), 0, -1, "wall");

    walk.start({ x: 0, y: -1, z: 0, stackIndex: 1 }, view(map));

    expect(standingCellOn(view(map), { x: 0, y: -1, z: 0, stackIndex: 1 })).toBeNull();
    expect(asked).toEqual([]);
    expect(walk.walking).toBe(false);
    expect(walk.drainNotices()).toEqual([]);
  });
});
