import { describe, expect, it } from "vitest";
import { emptyMap, replaceStack } from "../lib/mapData";
import { tile } from "../lib/testTile";
import type { MapFile, TileDef } from "../lib/types";
import { type ShotEnd, shotShadow } from "./shotShadow";

const tilesById: Record<string, TileDef> = {
  ground: tile({ id: "ground", walkable: true }),
  rock: tile({ id: "rock", height: 4, walkable: true }),
  block: tile({ id: "block", height: 2, walkable: true }),
  wall: tile({ id: "wall", height: 2, walkable: false }),
  body: tile({ id: "body", height: 4, actor: true }),
  floor: tile({ id: "floor", walkable: true }),
};

const BODY_MIDDLE = 2;

function row(rockUpTo: number): MapFile {
  let map = emptyMap();
  for (let x = 0; x <= 6; x++) {
    const stack =
      x <= rockUpTo ? [{ tileId: "ground" }, { tileId: "rock" }] : [{ tileId: "ground" }];
    map = replaceStack(map, x, 0, 0, stack);
  }
  return map;
}

/** The screen point of the middle of cell (x, 0) at `abs`, as the renderer draws it. */
function standingAt(x: number, footAbs: number): ShotEnd {
  return {
    ground: { x: (x + 0.5) * 8 - 2 * footAbs, y: 4 - 2 * footAbs },
    footAbs,
    shotAbs: footAbs + BODY_MIDDLE,
  };
}

describe("shotShadow", () => {
  it("lays the shadow on the line between the feet over flat ground", () => {
    const at = shotShadow(row(-1), tilesById, standingAt(0, 0), standingAt(6, 0));
    expect(at(0.5)).toEqual({ x: 28, y: 4 });
  });

  it("puts the shadow at the shooter's feet, not on top of the shooter", () => {
    const map = replaceStack(row(-1), 0, 0, 0, [{ tileId: "ground" }, { tileId: "body" }]);
    const at = shotShadow(map, tilesById, standingAt(0, 0), standingAt(6, 0));
    expect(at(0)).toEqual(standingAt(0, 0).ground);
  });

  it("keeps the shadow on a cliff top, then drops it to the ground past the edge", () => {
    const at = shotShadow(row(2), tilesById, standingAt(0, 4), standingAt(6, 0));
    expect(at(1 / 6)).toEqual(standingAt(1, 4).ground);
    expect(at(0.5)).toEqual(standingAt(3, 0).ground);
  });

  it("never lifts the shadow above a shot passing through a block", () => {
    const map = replaceStack(row(-1), 3, 0, 0, [{ tileId: "ground" }, { tileId: "block" }]);
    const low = { ...standingAt(0, 0), shotAbs: 1 };
    const at = shotShadow(map, tilesById, low, { ...standingAt(6, 0), shotAbs: 1 });
    expect(at(0.5)).toEqual({ x: 28 - 2, y: 4 - 2 });
  });

  it("keeps the shadow on the ground under a floor on the level above", () => {
    const map = replaceStack(row(-1), 3, 0, 1, [{ tileId: "floor" }]);
    const at = shotShadow(map, tilesById, standingAt(0, 0), standingAt(6, 0));
    expect(at(0.5)).toEqual({ x: 28, y: 4 });
  });

  it("never lifts the shadow above a shot passing through a wall", () => {
    const map = replaceStack(row(-1), 3, 0, 0, [{ tileId: "ground" }, { tileId: "wall" }]);
    const low = { ...standingAt(0, 0), shotAbs: 1 };
    const at = shotShadow(map, tilesById, low, { ...standingAt(6, 0), shotAbs: 1 });
    expect(at(0.5)).toEqual({ x: 28 - 2, y: 4 - 2 });
  });
});
