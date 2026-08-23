import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import {
  normalizeTileDef,
  normalizeTiles,
  resolveActor,
  resolveLightPassing,
} from "../lib/types";
import { hasLineOfSight } from "./sight";

/**
 * What a creature can see, on a board with things in the way.
 *
 * The rule under test is "sight is light" — a cell stops a look exactly when it
 * would stop a lamp — so the cases worth writing are the ones where that rule
 * says something an author might not expect: over a crate, through a window,
 * across water.
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
  tile({ id: "wall", height: 2, walkable: false }),
  // Half a level of solid: something to see over.
  tile({ id: "crate", height: 1, walkable: false }),
  // Solid to a body, transparent to light — so, transparent to a look.
  tile({ id: "window", height: 2, walkable: false, lightPassing: true }),
  // Half a level of *floor*: ground you stand on top of, not something in the
  // way. The distinction is the whole of the elevation cases below.
  tile({ id: "step", height: 1 }),
  // Light-passing, like every body in the game, so it never walls itself in.
  tile({ id: "body", height: 1, walkable: false, lightPassing: true }),
];

const tilesById = Object.fromEntries(tiles.map((t) => [t.id, t]));

/** Flat grass from -6 to 6, with nothing on it. */
function field(): MapFile {
  let map = emptyMap();
  for (let x = -6; x <= 6; x++) {
    for (let y = -6; y <= 6; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  return map;
}

function put(map: MapFile, x: number, y: number, tileId: string): MapFile {
  return replaceStack(map, x, y, 0, [{ tileId: "grass" }, { tileId }]);
}

const from = { x: 0, y: 0, z: 0 };

/**
 * How tall the looker is.
 *
 * The rule is one line — you see over anything shorter than you are — and every
 * case here is that line meeting a different pair of heights. Worth writing out
 * because the pair is the whole behaviour: neither number means anything on its
 * own, and the bug this replaced was a threshold that only ever read one of them.
 */
describe("seeing over things, by how tall you are", () => {
  const PERSON = 2;
  const RAT = 1;
  const beyond = { x: 5, y: 0, z: 0 };

  it("lets a person see over a crate that stops a rat", () => {
    const map = put(field(), 2, 0, "crate");
    expect(hasLineOfSight(map, tilesById, from, beyond, PERSON)).toBe(true);
    expect(hasLineOfSight(map, tilesById, from, beyond, RAT)).toBe(false);
  });

  /**
   * Equal heights block. A rat is exactly as tall as the crate and is looking at
   * the side of it, not over it.
   */
  it("blocks a looker exactly as tall as the thing in the way", () => {
    const map = put(field(), 2, 0, "crate");
    expect(hasLineOfSight(map, tilesById, from, beyond, 1)).toBe(false);
    expect(hasLineOfSight(map, tilesById, from, beyond, 1.5)).toBe(true);
  });

  it("stops everybody at a full-height wall", () => {
    const map = put(field(), 2, 0, "wall");
    expect(hasLineOfSight(map, tilesById, from, beyond, PERSON)).toBe(false);
    expect(hasLineOfSight(map, tilesById, from, beyond, RAT)).toBe(false);
  });

  /**
   * The cap that made this impossible before. Opacity saturates at a full level,
   * so a crate on a crate and a plain wall were one number — and a looker taller
   * than a level could never have been told apart from one exactly as tall.
   */
  it("counts a stack past a full level, rather than saturating at one", () => {
    let map = field();
    map = replaceStack(map, 2, 0, 0, [
      { tileId: "grass" },
      { tileId: "crate" },
      { tileId: "crate" },
    ]);
    expect(hasLineOfSight(map, tilesById, from, beyond, PERSON)).toBe(false);
    // Taller than the two crates together, and over it.
    expect(hasLineOfSight(map, tilesById, from, beyond, 3)).toBe(true);
  });

  /** Height decides nothing about glass: a window is see-through to anybody. */
  it("lets even the shortest looker see through a window", () => {
    const map = put(field(), 2, 0, "window");
    expect(hasLineOfSight(map, tilesById, from, beyond, RAT)).toBe(true);
  });

  /**
   * A crate is half a level, so it never sealed and never will — what changed is
   * only who clears it. A floor is height zero and blocks nobody sideways, which
   * is what keeps a rat from being blinded by the ground it walks on.
   */
  it("is not stopped sideways by the ground itself", () => {
    expect(hasLineOfSight(field(), tilesById, from, beyond, RAT)).toBe(true);
  });
});

/**
 * Standing on something.
 *
 * Height alone decides nothing; what decides a look is the *difference* between
 * where the eyes are and where the top of the obstruction is. Every case here is
 * one pair of elevations, and together they say the one thing worth promising:
 * raise both ends by the same amount and nothing changes.
 */
describe("looking from higher up", () => {
  const RAT = 1;
  const beyond = { x: 4, y: 0, z: 0 };

  /** Ground of `floor` everywhere, with `on` stacked on the named cells. */
  function ground(floor: string, on: Record<string, string> = {}): MapFile {
    let map = emptyMap();
    for (let x = -6; x <= 6; x++) {
      for (let y = -6; y <= 6; y++) {
        const extra = on[`${x},${y}`];
        map = replaceStack(
          map,
          x,
          y,
          0,
          extra
            ? [{ tileId: floor }, { tileId: extra }]
            : [{ tileId: floor }],
        );
      }
    }
    return map;
  }

  /**
   * The bug that made this necessary. A half-level floor scored its full height
   * as something in the way while the rat's eye was measured from zero, so a rat
   * standing on a raised floor could not see across it — the ground it walked on
   * was taller than it was.
   */
  it("is not blinded by the floor it is standing on", () => {
    expect(hasLineOfSight(ground("step"), tilesById, from, beyond, RAT)).toBe(
      true,
    );
  });

  it("reads the same raised as it does on the flat", () => {
    const flat = ground("grass");
    const raised = ground("step");
    for (const eye of [RAT, 2]) {
      expect(hasLineOfSight(raised, tilesById, from, beyond, eye)).toBe(
        hasLineOfSight(flat, tilesById, from, beyond, eye),
      );
    }
  });

  /** Both ends up by the same crate, and the look between them is unchanged. */
  it("is unchanged when both ends are raised together", () => {
    const bothUp = ground("grass", { "0,0": "crate", "4,0": "crate" });
    expect(hasLineOfSight(bothUp, tilesById, from, beyond, RAT)).toBe(
      hasLineOfSight(ground("grass"), tilesById, from, beyond, RAT),
    );
  });

  /** And standing on one really does let a rat see over the next one along. */
  it("lets a rat on a crate see over a crate that would stop it on the floor", () => {
    const inTheWay = { "2,0": "crate" };
    expect(
      hasLineOfSight(ground("grass", inTheWay), tilesById, from, beyond, RAT),
    ).toBe(false);
    expect(
      hasLineOfSight(
        ground("grass", { ...inTheWay, "0,0": "crate" }),
        tilesById,
        from,
        beyond,
        RAT,
      ),
    ).toBe(true);
  });

  /**
   * A body does not wall itself in, and nor does one standing beside the look.
   * Every body in the game is light-passing, which is what keeps it out of its
   * own column — and is why none of this has to know where in a stack it sits.
   */
  it("does not count a body as ground or as an obstruction", () => {
    const crowded = ground("grass", { "0,0": "body", "2,0": "body" });
    expect(hasLineOfSight(crowded, tilesById, from, beyond, RAT)).toBe(true);
  });

  /**
   * Open air is not a floor. Without a guard for a cell holding nothing solid,
   * an empty cell reports the bottom of its own level as a top, and a look
   * travelling upward is stopped by the sky.
   */
  it("still looks up through open air", () => {
    expect(
      hasLineOfSight(ground("grass"), tilesById, from, { x: 3, y: 0, z: 1 }, RAT),
    ).toBe(true);
  });
});

describe("line of sight", () => {
  it("crosses open ground", () => {
    expect(hasLineOfSight(field(), tilesById, from, { x: 5, y: 0, z: 0 })).toBe(
      true,
    );
  });

  it("stops at a full-height wall", () => {
    const map = put(field(), 2, 0, "wall");
    expect(hasLineOfSight(map, tilesById, from, { x: 5, y: 0, z: 0 })).toBe(
      false,
    );
  });

  /** A full level tall by default, which is what every caller but a brain is. */
  it("passes over a crate", () => {
    const map = put(field(), 2, 0, "crate");
    expect(hasLineOfSight(map, tilesById, from, { x: 5, y: 0, z: 0 })).toBe(
      true,
    );
  });

  /** The whole point of deriving sight from light rather than from solidity. */
  it("passes through a window, which a body could not walk through", () => {
    const map = put(field(), 2, 0, "window");
    expect(hasLineOfSight(map, tilesById, from, { x: 5, y: 0, z: 0 })).toBe(
      true,
    );
  });

  it("looks past a wall that is not between the two", () => {
    const map = put(field(), 2, 3, "wall");
    expect(hasLineOfSight(map, tilesById, from, { x: 5, y: 0, z: 0 })).toBe(
      true,
    );
  });

  it("sees on the diagonal, and loses it to a wall on the diagonal", () => {
    expect(hasLineOfSight(field(), tilesById, from, { x: 4, y: 4, z: 0 })).toBe(
      true,
    );
    const map = put(field(), 2, 2, "wall");
    expect(hasLineOfSight(map, tilesById, from, { x: 4, y: 4, z: 0 })).toBe(
      false,
    );
  });

  /**
   * Neither endpoint is tested, and both cases matter: a creature standing in a
   * doorway is not blind, and a target standing in one is not invisible.
   */
  it("ignores what is standing at either end", () => {
    const own = put(field(), 0, 0, "wall");
    expect(hasLineOfSight(own, tilesById, from, { x: 3, y: 0, z: 0 })).toBe(
      true,
    );
    const theirs = put(field(), 3, 0, "wall");
    expect(hasLineOfSight(theirs, tilesById, from, { x: 3, y: 0, z: 0 })).toBe(
      true,
    );
  });

  it("has nothing in the way of a neighbour", () => {
    const map = put(field(), 1, 0, "wall");
    expect(hasLineOfSight(map, tilesById, from, { x: 1, y: 0, z: 0 })).toBe(
      true,
    );
  });

  /**
   * Levels are crossed on the geometry and nothing else. There is no slack any
   * more: open air above is looked through, and a floor is not. Whether a
   * particular creature would *bother* looking up is its own business — see
   * `BattlerDef.sight`.
   */
  it("looks up through open air", () => {
    const map = field();

    expect(hasLineOfSight(map, tilesById, from, { x: 3, y: 0, z: 1 })).toBe(
      true,
    );
  });

  /**
   * And not down through the ground it is standing on. The floor between two
   * levels belongs to the upper one, so this is the grass under the viewer's own
   * feet doing the blocking.
   */
  it("does not look down through a floor", () => {
    const map = field();

    expect(hasLineOfSight(map, tilesById, from, { x: 3, y: 0, z: -1 })).toBe(
      false,
    );
  });

  it("looks down through a gap in the floor", () => {
    // Straight down, so the cell the look crosses is not a matter of which way
    // a diagonal rounded. `field` only lays ground on level 0, so clearing the
    // viewer's own cell there is a hole in the floor under their feet.
    const map = replaceStack(field(), 0, 0, 0, []);

    expect(hasLineOfSight(map, tilesById, from, { x: 0, y: 0, z: -1 })).toBe(
      true,
    );
  });

  /**
   * A ceiling stops a look going up exactly as a floor stops one going down —
   * it is one tile doing both jobs, belonging to the upper level. Straight up,
   * so the ceiling over the viewer and the endpoint's own cell are the same
   * tile: the sideways exemption for endpoints does not extend to the surface
   * between two floors, or a body could see through the ground it stands on.
   */
  it("is stopped going up by a ceiling overhead", () => {
    const map = replaceStack(field(), 0, 0, 1, [{ tileId: "wall" }]);

    expect(hasLineOfSight(map, tilesById, from, { x: 0, y: 0, z: 1 })).toBe(
      false,
    );
  });

  /**
   * One cell across, those two stop being the same tile, and only one of them
   * is in the way: **the ground over whichever end is lower**. A body standing
   * on the ledge beside you is on top of its slab, not behind it, and a rule
   * that read the column being entered had that slab blinding you to the very
   * thing it was holding up.
   */
  it("sees onto a ledge a cell over, over the lip of it", () => {
    const ledge = replaceStack(field(), 1, 0, 1, [{ tileId: "grass" }]);

    expect(hasLineOfSight(ledge, tilesById, from, { x: 1, y: 0, z: 1 })).toBe(
      true,
    );
  });

  /** Roof the *viewer* instead and the same look is refused. */
  it("loses that ledge from under a ceiling of its own", () => {
    let map = replaceStack(field(), 1, 0, 1, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "grass" }]);

    expect(hasLineOfSight(map, tilesById, from, { x: 1, y: 0, z: 1 })).toBe(
      false,
    );
  });

  /**
   * And it reads the same from either end, which is the point of naming one
   * slab rather than one direction: what you can see from the ledge can see you
   * back, and a reach and the reach back cannot disagree.
   */
  it("crosses a floor the same way whichever end is looking", () => {
    const ledge = replaceStack(field(), 1, 0, 1, [{ tileId: "grass" }]);
    const up = { x: 1, y: 0, z: 1 };
    const roofed = replaceStack(ledge, 0, 0, 1, [{ tileId: "grass" }]);

    expect(hasLineOfSight(ledge, tilesById, up, from)).toBe(true);
    expect(hasLineOfSight(roofed, tilesById, up, from)).toBe(false);
  });
});

/**
 * What the shipped library has to be true of, for any of the above to mean
 * anything on the real map.
 *
 * A rule about heights is only as good as the heights authored under it, and the
 * failure mode is invisible: nothing errors, a creature simply stops noticing
 * you and there is no way to tell from the board why.
 */
describe("the library we ship", () => {
  const authored = normalizeTiles(tilesJson as unknown[]);

  /**
   * A thing you can pick up is not a wall.
   *
   * A potion standing on a shop counter was half a level of solid, which put the
   * counter at a full level and left the shopkeeper unable to see the customer
   * in front of it. Every other item in the file was already light-passing —
   * including the *other* potion — so this was one tile disagreeing with its own
   * twin, which is exactly the kind of slip a rule cannot catch and a list can.
   */
  it("has no item that blocks a look", () => {
    const blocking = authored
      .filter((tile) => tile.kind === "item" && !resolveLightPassing(tile))
      .map((tile) => tile.id);
    expect(blocking).toEqual([]);
  });

  /**
   * A body is not part of the scenery it is standing in.
   *
   * Load-bearing twice over. A body that blocked light would cast a shadow on
   * itself, and — because a looker's ground is read as the solid part of its own
   * cell — it would also stand on its own shoulders and see over the wall in
   * front of it. That second one is silent: nothing errors, a creature simply
   * gets x-ray vision, which is why it is a list rather than a comment.
   */
  it("has no body that blocks a look, including the one it is standing in", () => {
    const blocking = authored
      .filter((tile) => resolveActor(tile) && !resolveLightPassing(tile))
      .map((tile) => tile.id);
    expect(blocking).toEqual([]);
  });
});
