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

  /** Opacity is blocking height over a level, so half a level does not seal. */
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

  /** One floor of slack, matching the distance conditions; two is a ceiling. */
  it("reaches one level away but not two", () => {
    const map = field();
    expect(hasLineOfSight(map, tilesById, from, { x: 3, y: 0, z: 1 })).toBe(
      true,
    );
    expect(hasLineOfSight(map, tilesById, from, { x: 3, y: 0, z: 2 })).toBe(
      false,
    );
  });
});
