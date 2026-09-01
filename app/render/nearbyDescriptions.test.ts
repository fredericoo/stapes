import { describe, expect, it } from "vitest";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile, PlacedTile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { describedNearby } from "./nearbyDescriptions";

/**
 * Who speaks when you walk past, and who stays quiet.
 *
 * The radius cases are the point of the file: a sign one cell away reads, a
 * diagonal one reads, and two cells out is silence. They fail if the reach ever
 * stops being round or stops being 1.5 — which is exactly what they are for,
 * since the number lives in `game/affordances` and nothing else here would
 * notice it moving.
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

const tilesById = Object.fromEntries(
  [
    tile({ id: "grass", height: 0 }),
    tile({ id: "sign", height: 2, walkable: false }),
    tile({ id: "crate", height: 2, walkable: false }),
    tile({ id: "player", height: 4 }),
  ].map((t) => [t.id, t]),
);

const READER = { x: 0, y: 0, z: 0 };

/** Ground under everything, so a stack is never the only thing in a cell. */
function ground(z = 0): MapFile {
  let map = emptyMap();
  for (let x = -3; x <= 3; x++) {
    for (let y = -3; y <= 3; y++) {
      map = replaceStack(map, x, y, z, [{ tileId: "grass" }]);
    }
  }
  return map;
}

function withStack(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  ...on: PlacedTile[]
): MapFile {
  return replaceStack(map, x, y, z, [{ tileId: "grass" }, ...on]);
}

const DANGER: PlacedTile = { tileId: "sign", description: "DANGER" };

function textsNear(map: MapFile, at = READER): string[] {
  return describedNearby(map, tilesById, at).map((found) => found.text);
}

describe("describedNearby", () => {
  it("reads an orthogonally adjacent sign", () => {
    const map = withStack(ground(), 1, 0, 0, DANGER);
    expect(textsNear(map)).toEqual(["DANGER"]);
  });

  it("reads a diagonally adjacent sign", () => {
    const map = withStack(ground(), 1, 1, 0, DANGER);
    expect(textsNear(map)).toEqual(["DANGER"]);
  });

  it("reads a sign in the cell you are standing in", () => {
    const map = withStack(ground(), 0, 0, 0, DANGER);
    expect(textsNear(map)).toEqual(["DANGER"]);
  });

  it("stays quiet two cells away", () => {
    const map = withStack(ground(), 2, 0, 0, DANGER);
    expect(textsNear(map)).toEqual([]);
  });

  it("stays quiet a knight's move away", () => {
    const map = withStack(ground(), 2, 1, 0, DANGER);
    expect(textsNear(map)).toEqual([]);
  });

  it("stays quiet on the floor above", () => {
    let map = ground();
    map = withStack(map, 1, 0, 1, DANGER);
    expect(textsNear(map)).toEqual([]);
  });

  it("says nothing for a placement nobody wrote on", () => {
    const map = withStack(ground(), 1, 0, 0, { tileId: "sign" });
    expect(textsNear(map)).toEqual([]);
  });

  it("stays quiet under a crate", () => {
    const map = withStack(ground(), 1, 0, 0, DANGER, { tileId: "crate" });
    expect(textsNear(map)).toEqual([]);
  });

  it("still reads with somebody standing on it", () => {
    const map = withStack(ground(), 1, 0, 0, DANGER, {
      tileId: "player",
      owner: "someone",
    });
    expect(textsNear(map)).toEqual(["DANGER"]);
  });

  it("reads every sign in reach at once", () => {
    let map = withStack(ground(), 1, 0, 0, { ...DANGER, description: "left" });
    map = withStack(map, 0, 1, 0, { ...DANGER, description: "right" });
    expect(textsNear(map).sort()).toEqual(["left", "right"]);
  });

  it("hands back the slot and the tile height, for hanging the words", () => {
    const map = withStack(ground(), 1, 0, 0, DANGER);
    expect(describedNearby(map, tilesById, READER)).toEqual([
      {
        ref: { x: 1, y: 0, z: 0, stackIndex: 1 },
        text: "DANGER",
        height: 2,
      },
    ]);
  });
});
