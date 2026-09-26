import { describe, expect, it } from "vitest";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile, PlacedTile } from "../lib/types";
import { inscribedNearby } from "./nearbyInscriptions";
import { tile } from "../lib/testTile";

const tilesById = Object.fromEntries(
  [
    tile({ id: "grass", height: 0 }),
    tile({ id: "sign", height: 2, walkable: false }),
    tile({ id: "crate", height: 2, walkable: false }),
    tile({ id: "player", height: 4 }),
  ].map((t) => [t.id, t]),
);

const READER = { x: 0, y: 0, z: 0 };

function ground(z = 0): MapFile {
  let map = emptyMap();
  for (let x = -3; x <= 3; x++) {
    for (let y = -3; y <= 3; y++) {
      map = replaceStack(map, x, y, z, [{ tileId: "grass" }]);
    }
  }
  return map;
}

function withStack(map: MapFile, x: number, y: number, z: number, ...on: PlacedTile[]): MapFile {
  return replaceStack(map, x, y, z, [{ tileId: "grass" }, ...on]);
}

const DANGER: PlacedTile = { tileId: "sign", inscription: "DANGER" };

function textsNear(map: MapFile, at = READER): string[] {
  return inscribedNearby(map, tilesById, at).map((found) => found.text);
}

describe("inscribedNearby", () => {
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

  it("stays quiet about a description, however close", () => {
    const map = withStack(ground(), 0, 0, 0, {
      tileId: "sign",
      description: "Bite by Snake",
    });
    expect(textsNear(map)).toEqual([]);
  });

  it("reads the inscription and not the description beside it", () => {
    const map = withStack(ground(), 1, 0, 0, {
      ...DANGER,
      description: "Bite by Snake",
    });
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
    let map = withStack(ground(), 1, 0, 0, { ...DANGER, inscription: "left" });
    map = withStack(map, 0, 1, 0, { ...DANGER, inscription: "right" });
    expect(textsNear(map).sort()).toEqual(["left", "right"]);
  });

  it("hands back the slot and the tile height, for hanging the words", () => {
    const map = withStack(ground(), 1, 0, 0, DANGER);
    expect(inscribedNearby(map, tilesById, READER)).toEqual([
      {
        ref: { x: 1, y: 0, z: 0, stackIndex: 1 },
        text: "DANGER",
        height: 2,
      },
    ]);
  });
});
