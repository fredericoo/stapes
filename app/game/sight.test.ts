import { describe, expect, it } from "vitest";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
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
   * it is one tile doing both jobs, belonging to the upper level. Note this is
   * the *endpoint's* own cell and is still tested: the sideways exemption for
   * endpoints does not extend to the surface between two floors, or a body could
   * see through the ground it is standing on.
   */
  it("is stopped going up by a ceiling overhead", () => {
    const map = replaceStack(field(), 0, 0, 1, [{ tileId: "wall" }]);

    expect(hasLineOfSight(map, tilesById, from, { x: 0, y: 0, z: 1 })).toBe(
      false,
    );
  });
});
