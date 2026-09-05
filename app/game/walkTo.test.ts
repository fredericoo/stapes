import { describe, expect, it } from "vitest";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { Coord, Direction, MapFile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL, normalizeTileDef } from "../lib/types";
import type { GameInput } from "./GameSession";
import { PLAYER_TILE_ID } from "./constants";
import { HeldDirections } from "./heldDirections";
import { noRouteNotice } from "./notices";
import { WalkTo, standingCellOn, type WalkView } from "./walkTo";

/**
 * Walking to a cell that was pointed at.
 *
 * The controller on its own, with no canvas in front of it and no session
 * behind it: it is handed a board and a body, and every direction it decides on
 * comes back through the callback. That is the whole of what the renderer wires
 * up, so it is the whole of what these cases need.
 *
 * What they pin is the three things a click has to get right — that the leg it
 * hands over is the *next* one and not the one already being walked, that the
 * route is asked afresh so a board that has moved is routed round, and that a
 * cell with no way to it produces a sentence rather than silence.
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
  /** Half a level, solid: a crate. Feet neither pass it nor climb it. */
  tile({ id: "crate", height: 2, walkable: false }),
  /** A full level you can stand on, so the level above it has a floor. */
  tile({ id: "block", height: HEIGHT_PER_LEVEL }),
  /** Half a level you can stand on: the whole of what a way down on foot is. */
  tile({ id: "step", height: 2 }),
  tile({
    id: PLAYER_TILE_ID,
    height: 2,
    actor: true,
    affectedByGravity: true,
    walkable: false,
  }),
];

const tilesById = Object.fromEntries(tiles.map((def) => [def.id, def]));
const playerDef = tilesById[PLAYER_TILE_ID]!;

/** Flat grass from -half to +half, and nothing standing on any of it. */
function bare(half: number): MapFile {
  let map = emptyMap();
  for (let x = -half; x <= half; x++) {
    for (let y = -half; y <= half; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  return map;
}

/** The same, with the walker standing at the origin. */
function field(half: number): MapFile {
  return replaceStack(bare(half), 0, 0, 0, [
    { tileId: "grass" },
    { tileId: PLAYER_TILE_ID },
  ]);
}

function put(map: MapFile, x: number, y: number, tileId: string): MapFile {
  return replaceStack(map, x, y, 0, [{ tileId: "grass" }, { tileId }]);
}

/**
 * Three cells east from the origin, then three south: one way through, with a
 * corner in it and nothing to choose at any cell.
 */
function elbow(): MapFile {
  let map = emptyMap();
  for (let x = 0; x <= 2; x++) {
    map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
  }
  for (let y = 1; y <= 3; y++) {
    map = replaceStack(map, 2, y, 0, [{ tileId: "grass" }]);
  }
  return replaceStack(map, 0, 0, 0, [
    { tileId: "grass" },
    { tileId: PLAYER_TILE_ID },
  ]);
}

/** One cell wide, walled north and south, running east and west through 0,0. */
function corridor(half: number): MapFile {
  let map = field(half);
  for (let x = -half; x <= half; x++) {
    map = put(map, x, -1, "wall");
    map = put(map, x, 1, "wall");
  }
  return map;
}

/**
 * A floor of blocks a level up, with one cell of it missing at (2, 0) and the
 * ground of the world showing at the bottom of the gap. The walker stands on
 * the floor at the origin.
 */
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

/**
 * A shelf of blocks running east from the walker, with a step off the far end
 * of it — the one way down that is a walk rather than a fall — over open ground
 * the shelf's own edges are a drop onto.
 */
function shelf(): MapFile {
  let map = bare(3);
  for (let x = 0; x <= 2; x++) map = put(map, x, 0, "block");
  map = put(map, 3, 0, "step");
  return replaceStack(map, 0, 0, 1, [{ tileId: PLAYER_TILE_ID }]);
}

/** The walker's own cell, with the slot its body sits in. */
const HOME = { x: 0, y: 0, z: 0, stackIndex: 1 };

/** The same, for a walker standing a level up on a floor of blocks. */
const UPSTAIRS = { x: 0, y: 0, z: 1, stackIndex: 0 };

function view(
  map: MapFile,
  opts: { at?: Coord & { stackIndex: number }; stepping?: Coord } = {},
): WalkView {
  return {
    map,
    at: opts.at ?? HOME,
    stepping: opts.stepping ?? null,
    def: playerDef,
    tilesById,
  };
}

/** The slot a pick would name for the top of a plain grass cell. */
function ground(x: number, y: number) {
  return { x, y, z: 0, stackIndex: 0 };
}

/**
 * A controller, with everything it has asked for kept in order.
 *
 * The real `HeldDirections` rather than a stub of one, because half of what
 * these cases are about is the arbitration inside it: a click outranks a key
 * that was already down, a key pressed afterwards outranks the click, and the
 * modifiers ride along with whichever won. A stub would agree with whatever
 * this file assumed.
 */
function walker() {
  const asked: GameInput[] = [];
  const input = new HeldDirections((i) => asked.push(i));
  const walk = new WalkTo(input);
  return {
    walk,
    input,
    asked,
    /** The directions of the last thing it asked for. */
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

    // Round one side or the other — the board is symmetric and either is right.
    expect(last()?.[0]).toMatch(/^[ns]$/);
  });

  it("stands still when the cell clicked is the one it is standing in", () => {
    const { walk, asked } = walker();

    walk.start(ground(0, 0), view(field(6)));

    expect(walk.walking).toBe(false);
    expect(asked).toEqual([]);
  });
});

/**
 * The leg handed over while a step is in flight is the one *after* it.
 *
 * The step pipeline chains one step straight into the next from inside its own
 * frame, so the direction for the second leg has to be waiting before the first
 * one lands. Naming the leg already being walked would take the same step twice
 * and turn every corner into a step in the wrong direction.
 */
describe("while a step is being walked", () => {
  it("names the leg after the one in flight", () => {
    const { walk, last } = walker();
    const map = field(6);

    walk.start(ground(0, 3), view(map));
    expect(last()).toEqual(["s"]);

    // Mid-step: the board still holds the body at the origin, and the cell it
    // is landing in is the only thing that says otherwise.
    walk.tick(view(map, { stepping: { x: 0, y: 1, z: 0 } }));

    expect(last()).toEqual(["s"]);
  });

  it("turns a corner one leg early rather than one leg late", () => {
    const { walk, last } = walker();
    // A crate due east: one step aside, then along, then back.
    const map = put(field(6), 1, 0, "crate");

    walk.start(ground(2, 0), view(map));
    const aside = last()?.[0] === "n" ? { x: 0, y: -1 } : { x: 0, y: 1 };

    walk.tick(view(map, { stepping: { ...aside, z: 0 } }));

    // The turn is named while the step aside is still being drawn.
    expect(last()).toEqual(["e"]);
  });

  /**
   * The cell the search starts from and the cell the body is in are two facts,
   * and mid-step they are two different cells: the walk commits to the map on
   * landing, so the board still holds the body where it set off from. Handed
   * only one of them, the search has the walker's own body as a wall behind it
   * — in a corridor there is then no way back the way it came, and turning
   * round is refused with a sentence about a route that plainly exists.
   * @see ./pathfinding's PathStart
   */
  it("turns back past the cell its own body is still in", () => {
    const { walk, last } = walker();
    const map = corridor(6);

    walk.start(ground(-5, 0), view(map, { stepping: { x: 1, y: 0, z: 0 } }));

    expect(last()).toEqual(["w"]);
    expect(walk.drainNotices()).toEqual([]);
  });
});

/**
 * Which of the two is walking is `HeldDirections`' to settle, and these are the
 * three answers it gives. The click is the later decision than a key already
 * down; a key pressed afterwards is later still; and a walk that ends hands the
 * input back rather than emptying it, because the hand holding that key never
 * let go.
 */
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
    // Arrived. The key nobody let go of is what is being asked for again — an
    // emptied input here is a key that has gone dead in the player's hand.
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
    // And does not take it back on the next frame, which is what a walk that
    // kept pressing its own direction would do.
    expect(last()).toEqual(["n"]);
  });

  it("walks under whatever modifiers are being held", () => {
    const { walk, input, asked } = walker();
    input.setModifiers({ faceOnly: true, preferDescend: false });

    walk.start(ground(3, 0), view(field(6)));

    // Shift means "turn on the spot" whoever chose the direction. A click that
    // wrote the input itself dropped both of these.
    expect(asked.at(-1)).toEqual({
      directions: ["e"],
      faceOnly: true,
      preferDescend: false,
    });
  });
});

/**
 * The route is asked for again every step and never kept, because a walk across
 * town is twenty steps of world to go stale in — and other bodies are walls to
 * `canWalk`, so the things between here and there are exactly the things that
 * move. @see ./walkTo
 */
describe("a board that moves under a walk", () => {
  it("routes round something dropped in the way after the click", () => {
    const { walk, last } = walker();

    walk.start(ground(3, 0), view(field(6)));
    expect(last()).toEqual(["e"]);

    // Somebody shoves a crate into the next cell. A kept route would walk into
    // it and be refused; the next leg simply goes round.
    walk.tick(view(put(field(6), 1, 0, "crate")));

    expect(last()?.[0]).toMatch(/^[ns]$/);
  });

  it("stops on its own once it is standing on the cell", () => {
    const { walk, last } = walker();
    let map = field(6);
    map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: PLAYER_TILE_ID },
    ]);

    walk.start(ground(1, 0), view(field(6)));
    walk.tick(view(map, { at: { x: 1, y: 0, z: 0, stackIndex: 1 } }));

    // Emptied rather than merely dropped: the pipeline chains a held direction
    // into the next step by itself, and a direction left pressed is a body that
    // keeps walking east for ever.
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
    // "Detour" rather than "unreachable" for a wall that plainly seals it off,
    // because the open board behind the walker has corners the search never
    // offered itself — see `./pathfinding`'s `PathRefusal`, which would rather
    // understate this than tell somebody a room with a door is shut.
    expect(walk.drainNotices()).toEqual([noRouteNotice("detour")]);
    // Drained, so the frame after it is silent.
    expect(walk.drainNotices()).toEqual([]);
  });

  it("says so for a wall, which is a thing rather than a place", () => {
    const { walk } = walker();
    const map = put(field(6), 2, 0, "wall");

    walk.start({ x: 2, y: 0, z: 0, stackIndex: 1 }, view(map));

    expect(walk.walking).toBe(false);
    expect(walk.drainNotices()).toEqual([noRouteNotice("unreachable")]);
  });
});

/**
 * A fall is allowed to be the last leg of a route and nothing before it.
 *
 * Clicking down a hole walks down it; clicking across a floor never steps off
 * the edge of one on the way, however much shorter that would be. The argument
 * for the limit is in `./walkTo`; what is pinned here is that both halves of it
 * hold, because the expensive half — not falling — looks like a longer route
 * rather than like a bug.
 */
describe("a cell below the one it is standing on", () => {
  it("walks to the bottom of a hole that was clicked", () => {
    const { walk, last } = walker();
    const map = holed(4);

    walk.start(ground(2, 0), view(map, { at: UPSTAIRS }));

    expect(walk.drainNotices()).toEqual([]);
    expect(last()).toEqual(["e"]);

    // On the lip of the hole, with the drop as the only leg still owed. A
    // refused fall would show here as the walk giving up and the direction
    // being let go of, one cell short of what was clicked.
    walk.tick(view(map, { at: { x: 1, y: 0, z: 1, stackIndex: 0 } }));
    expect(walk.walking).toBe(true);
    expect(last()).toEqual(["e"]);

    // Landed at the bottom, which is where it was going.
    walk.tick(view(map, { at: { x: 2, y: 0, z: 0, stackIndex: 1 } }));
    expect(walk.walking).toBe(false);
  });

  it("goes the long way down rather than stepping off on the way past", () => {
    const { walk, last } = walker();

    // Two cells north and a level down. Off the north edge is one fall and one
    // step; the step at the east end of the shelf is eight legs, and it is the
    // one a player who pointed at that cell asked for.
    walk.start(ground(0, -2), view(shelf(), { at: UPSTAIRS }));

    expect(last()).toEqual(["e"]);
    expect(walk.drainNotices()).toEqual([]);
  });
});

/**
 * A walk that stops halfway stops silently, unlike one that never set off.
 *
 * The two refusals are the same search and a different moment. At the click the
 * player has asked for something and nothing has happened, which is
 * indistinguishable from a tap that missed. Halfway, they are watching
 * themselves walk and can see the thing that stopped them — and what stops a
 * route mid-way is ordinary traffic, so a sentence for each is a line of text
 * every time anybody shuts a door near anybody walking.
 */
describe("a board that closes in front of a walk", () => {
  it("stops without a word, and lets go of the direction", () => {
    const { walk, last } = walker();

    walk.start(ground(3, 0), view(field(6)));
    expect(walk.drainNotices()).toEqual([]);

    // The whole column walled off between here and there, after setting off.
    let map = field(6);
    for (let y = -6; y <= 6; y++) map = put(map, 1, y, "wall");
    walk.tick(view(map));

    expect(walk.walking).toBe(false);
    expect(walk.drainNotices()).toEqual([]);
    // Dropped on the frame it happened rather than left pressed: the pipeline
    // chains a held direction into the next step by itself, so a body whose
    // route has gone would otherwise carry on east into the wall.
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

    // A keypress calls this every time. Clearing an input the player is holding
    // would be this object stopping a walk it has nothing to do with.
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

/**
 * A pick names a tile; a body wants the cell it would stand in having climbed
 * onto it. The two differ for anything that fills its level — which is what the
 * floor of a building is made of, so getting this wrong is a room nobody can
 * click their way into.
 */
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

    expect(standingCellOn(view(map), { x: 2, y: 0, z: 0, stackIndex: 0 })).toEqual(
      { x: 2, y: 0, z: 1 },
    );
  });

  it("offers nothing for a wall, rather than its foot", () => {
    const map = put(field(6), 2, 0, "wall");

    expect(
      standingCellOn(view(map), { x: 2, y: 0, z: 0, stackIndex: 1 }),
    ).toBeNull();
  });
});

/**
 * The route is asked for once per cell, not once per frame.
 *
 * `tick` is driven from the renderer's frame loop and a step takes a fifth of a
 * second, so a controller that searched every time it was called would run a
 * dozen identical A* searches per leg — from the same cell, to the same cell,
 * for the same answer. The cost is real: every expanded node is a `canWalk` per
 * direction, and each of those is a column scan.
 *
 * Pinned through the callback rather than by counting searches, because what
 * the renderer can see is what the controller asks for: one press per leg.
 */
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
    // An elbow, so the answer from the corner cell is a different direction:
    // a leg that came back the same is indistinguishable from no search at all
    // through the one thing this controller does out loud.
    const board = elbow();

    walk.start(ground(2, 3), view(board));
    expect(last()).toEqual(["e"]);
    // The leg in flight lands in the corner, which is the cell the next answer
    // is owed from. @see WalkView.stepping
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
