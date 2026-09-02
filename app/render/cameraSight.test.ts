import { describe, expect, it } from "vitest";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { isHiddenFromCamera } from "./cameraSight";

/**
 * What the camera can see, as opposed to what a body can.
 *
 * Most cases here are written against the one fact the projection gives us: a
 * cell is *painted over* by `(x + 1, y + 1, z + 1)` and by nothing else. So the
 * tests worth having are the ones that pin the diagonal — a ceiling one cell off
 * the ray hides nothing, and the same tile on the ray hides everything. Those
 * pass the viewer's level as the subject's own, which switches the second rule
 * off and leaves the diagonal alone under test.
 *
 * The second rule — a floor between the viewer's level and the subject — has its
 * own case at the bottom, and the scenarios in `game/perception.test.ts` are
 * where the two are exercised together.
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
  // Height zero and utterly solid to a look from above: the cave ceiling, and
  // the one tile that separates `sealsLevel` from `opacity`.
  tile({ id: "floor", height: 0, walkable: true }),
  tile({ id: "wall", height: 4, walkable: false }),
  tile({ id: "glass", height: 4, walkable: false, lightPassing: true }),
];

const tilesById = Object.fromEntries(tiles.map((t) => [t.id, t]));

/** Open ground on one level, with nothing above it. */
function field(z = 0): MapFile {
  let map = emptyMap();
  for (let x = -6; x <= 6; x++) {
    for (let y = -6; y <= 6; y++) {
      map = replaceStack(map, x, y, z, [{ tileId: "grass" }]);
    }
  }
  return map;
}

function put(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  tileId: string,
): MapFile {
  return replaceStack(map, x, y, z, [{ tileId }]);
}

const origin = { x: 0, y: 0, z: 0 };

describe("camera sight", () => {
  it("sees a body under open sky", () => {
    expect(isHiddenFromCamera(field(), tilesById, origin, origin.z, undefined)).toBe(
      false,
    );
  });

  /**
   * The cave. A floor is height zero, so it scores no opacity at all and a rule
   * written on opacity would read straight through the rock.
   */
  it("hides a body under a floor on the diagonal", () => {
    const map = put(field(-1), 1, 1, 0, "floor");
    const inCave = { x: 0, y: 0, z: -1 };

    expect(isHiddenFromCamera(map, tilesById, inCave, inCave.z, undefined)).toBe(true);
  });

  /**
   * The hole in the roof, far away. It lets light and a view *somewhere* into
   * the cave, but not along this ray — and the ray is the only thing that
   * decides.
   */
  it("keeps a body hidden when the gap is off the ray", () => {
    let map = field(-1);
    for (let x = -2; x <= 2; x++) {
      for (let y = -2; y <= 2; y++) {
        if (x === 2 && y === 2) continue; // the hole
        map = put(map, x, y, 0, "floor");
      }
    }

    expect(isHiddenFromCamera(map, tilesById, { x: 0, y: 0, z: -1 }, -1, undefined))
      .toBe(true);
    // And the one cell that *is* under the hole is seen, which is what makes
    // the assertion above about the ray rather than about the roof.
    expect(isHiddenFromCamera(map, tilesById, { x: 1, y: 1, z: -1 }, -1, undefined))
      .toBe(false);
  });

  it("is not fooled by a ceiling one cell off the ray", () => {
    for (const [dx, dy] of [
      [0, 1],
      [1, 0],
      [2, 2],
      [-1, -1],
    ]) {
      const map = put(field(), dx, dy, 1, "wall");
      expect(isHiddenFromCamera(map, tilesById, origin, origin.z, undefined)).toBe(false);
    }
  });

  it("follows the diagonal up through every level", () => {
    for (const k of [1, 2, 3]) {
      const map = put(field(), k, k, k, "wall");
      expect(isHiddenFromCamera(map, tilesById, origin, origin.z, undefined)).toBe(true);
    }
  });

  /** Glass and water are see-through to a lamp, to a look, and to a camera. */
  it("reads a body through something light passes", () => {
    const map = put(field(), 1, 1, 1, "glass");

    expect(isHiddenFromCamera(map, tilesById, origin, origin.z, undefined)).toBe(false);
  });

  /**
   * Indoors. The roof lifting is what lets you see the room at all, and chrome
   * that went on counting it would make every body in that room anonymous.
   */
  it("ignores anything the roof-cut has taken away", () => {
    const map = put(field(), 1, 1, 1, "wall");

    expect(isHiddenFromCamera(map, tilesById, origin, origin.z, 0)).toBe(false);
    // Still cut at the viewer's own level; one level higher and the roof is
    // back on screen and back in the answer.
    expect(isHiddenFromCamera(map, tilesById, origin, origin.z, 1)).toBe(true);
  });

  it("is never hidden by its own cell", () => {
    const map = put(field(), 0, 0, 0, "wall");

    expect(isHiddenFromCamera(map, tilesById, origin, origin.z, undefined)).toBe(false);
  });

  /**
   * The narrowest roof there is: one floor tile, nothing on the diagonal. The
   * painting rule says this body is visible and is right about the pixels; the
   * column rule hides it anyway, because a viewer standing on those boards is
   * not looking through them.
   */
  it("hides a body under a floor between it and the viewer", () => {
    const map = put(field(-1), 0, 0, 0, "floor");
    const below = { x: 0, y: 0, z: -1 };

    expect(isHiddenFromCamera(map, tilesById, below, 0, undefined)).toBe(true);
    // Same board, viewer down there with it: no floor in between any more.
    expect(isHiddenFromCamera(map, tilesById, below, -1, undefined)).toBe(false);
  });

  it("counts every floor up to the viewer, not just the first", () => {
    let map = put(field(-2), 0, 0, -1, "floor");
    map = put(map, 0, 0, 0, "floor");
    const deep = { x: 0, y: 0, z: -2 };

    expect(isHiddenFromCamera(map, tilesById, deep, 0, undefined)).toBe(true);
  });
});
