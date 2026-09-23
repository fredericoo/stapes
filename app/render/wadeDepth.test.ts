/**
 * A body standing in a `wade` tile is drawn wading, and one stepping into or
 * out of it sinks or rises over the step. Every board is built here.
 */
import { describe, expect, it } from "vitest";
import type { WalkState } from "../game/GameSession";
import { wadesAt } from "../game/movement";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { TileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { tile } from "../lib/testTile";
import { wadeDepth, wadingFor } from "./wadeDepth";

const tiles: TileDef[] = [
  tile({ id: "water", height: 0, lightPassing: true, wade: true }),
  tile({ id: "grass", height: 0 }),
  tile({ id: "body", height: 3, actor: true, walkable: false, lightPassing: true }),
];
const by = tilesByIdFromList(tiles);

/** Grass at (0,0), water at (1,0), and a body on the grass. */
function bank() {
  let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId: "body" }]);
  map = replaceStack(map, 1, 0, 0, [{ tileId: "water" }]);
  return map;
}

function walking(progress: number, from: [number, number], to: [number, number]) {
  const walk: WalkState = {
    from: { x: from[0], y: from[1], z: 0 },
    to: { x: to[0], y: to[1], z: 0 },
    direction: to[0] > from[0] ? "e" : "w",
    elapsedMs: 0,
    durationMs: 200,
  };
  return { x: from[0], y: from[1], z: 0, stackIndex: 1, walk, walkProgress: progress, fall: null };
}

describe("wadesAt", () => {
  it("is true for a body standing in one, and false for one on grass", () => {
    const wet = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "water" }, { tileId: "body" }]);
    expect(wadesAt(wet, { x: 0, y: 0, z: 0, stackIndex: 1 }, by)).toBe(true);
    expect(wadesAt(bank(), { x: 0, y: 0, z: 0, stackIndex: 1 }, by)).toBe(false);
  });
});

describe("wadeDepth", () => {
  it("is 1 standing in the water and 0 standing beside it", () => {
    const wet = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "water" }, { tileId: "body" }]);
    const still = { x: 0, y: 0, z: 0, stackIndex: 1, walk: null, walkProgress: 0, fall: null };
    expect(wadeDepth(wet, still, by)).toBe(1);
    expect(wadeDepth(bank(), still, by)).toBe(0);
  });

  it("sinks over a step into the water", () => {
    const map = bank();
    expect(wadeDepth(map, walking(0, [0, 0], [1, 0]), by)).toBe(0);
    expect(wadeDepth(map, walking(0.5, [0, 0], [1, 0]), by)).toBe(0.5);
    expect(wadeDepth(map, walking(1, [0, 0], [1, 0]), by)).toBe(1);
  });

  it("rises over a step out of it", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "water" }, { tileId: "body" }]);
    expect(wadeDepth(map, walking(0.25, [1, 0], [0, 0]), by)).toBe(0.75);
  });

  /** A body falling into a pond is in the air until it lands in it. */
  it("is dry while falling", () => {
    const wet = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "water" }, { tileId: "body" }]);
    const falling = {
      x: 0,
      y: 0,
      z: 0,
      stackIndex: 1,
      walk: null,
      walkProgress: 0,
      fall: { feetAbs: 2, landingAbs: 0, elapsedMs: 0 },
    };
    expect(wadeDepth(wet, falling, by)).toBe(0);
  });
});

describe("wadingFor", () => {
  it("names only the bodies in the water, and nothing on a dry board", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId: "body" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "water" }, { tileId: "body" }]);
    const dry = { x: 0, y: 0, z: 0, stackIndex: 1, walk: null, walkProgress: 0, fall: null };
    const wet = { ...dry, x: 1 };
    expect(wadingFor(map, [dry, wet], by)).toEqual(new Map([["0:1,0:1", 1]]));
    expect(wadingFor(map, [dry], by)).toBeUndefined();
  });
});
