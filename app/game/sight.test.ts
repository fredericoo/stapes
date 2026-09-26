import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL, normalizeTiles, resolveActor, resolveLightPassing } from "../lib/types";
import { hasLineOfSight } from "./sight";
import { tile } from "../lib/testTile";

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "wall", height: 4, walkable: false }),
  tile({ id: "crate", height: 2, walkable: false }),
  tile({ id: "window", height: 4, walkable: false, lightPassing: true }),
  tile({ id: "step", height: 2 }),
  tile({ id: "body", height: 2, walkable: false, lightPassing: true }),
];

const tilesById = Object.fromEntries(tiles.map((t) => [t.id, t]));

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

describe("seeing over things, by how tall you are", () => {
  const PERSON = 4;
  const RAT = 2;
  const beyond = { x: 5, y: 0, z: 0 };

  it("lets a person see over a crate that stops a rat", () => {
    const map = put(field(), 2, 0, "crate");
    expect(hasLineOfSight(map, tilesById, from, beyond, PERSON)).toBe(true);
    expect(hasLineOfSight(map, tilesById, from, beyond, RAT)).toBe(false);
  });

  it("blocks a looker exactly as tall as the thing in the way", () => {
    const map = put(field(), 2, 0, "crate");
    expect(hasLineOfSight(map, tilesById, from, beyond, 2)).toBe(false);
    expect(hasLineOfSight(map, tilesById, from, beyond, 3)).toBe(true);
  });

  it("stops everybody at a full-height wall", () => {
    const map = put(field(), 2, 0, "wall");
    expect(hasLineOfSight(map, tilesById, from, beyond, PERSON)).toBe(false);
    expect(hasLineOfSight(map, tilesById, from, beyond, RAT)).toBe(false);
  });

  it("counts a stack past a full level, rather than saturating at one", () => {
    let map = field();
    map = replaceStack(map, 2, 0, 0, [
      { tileId: "grass" },
      { tileId: "crate" },
      { tileId: "crate" },
    ]);
    expect(hasLineOfSight(map, tilesById, from, beyond, PERSON)).toBe(false);
    expect(hasLineOfSight(map, tilesById, from, beyond, 6)).toBe(true);
  });

  it("lets even the shortest looker see through a window", () => {
    const map = put(field(), 2, 0, "window");
    expect(hasLineOfSight(map, tilesById, from, beyond, RAT)).toBe(true);
  });

  it("is not stopped sideways by the ground itself", () => {
    expect(hasLineOfSight(field(), tilesById, from, beyond, RAT)).toBe(true);
  });
});

describe("looking from higher up", () => {
  const RAT = 1;
  const beyond = { x: 4, y: 0, z: 0 };

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
          extra ? [{ tileId: floor }, { tileId: extra }] : [{ tileId: floor }],
        );
      }
    }
    return map;
  }

  it("is not blinded by the floor it is standing on", () => {
    expect(hasLineOfSight(ground("step"), tilesById, from, beyond, RAT)).toBe(true);
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

  it("is unchanged when both ends are raised together", () => {
    const bothUp = ground("grass", { "0,0": "crate", "4,0": "crate" });
    expect(hasLineOfSight(bothUp, tilesById, from, beyond, RAT)).toBe(
      hasLineOfSight(ground("grass"), tilesById, from, beyond, RAT),
    );
  });

  it("lets a rat on a crate see over a crate that would stop it on the floor", () => {
    const inTheWay = { "2,0": "crate" };
    expect(hasLineOfSight(ground("grass", inTheWay), tilesById, from, beyond, RAT)).toBe(false);
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

  it("does not count a body as ground or as an obstruction", () => {
    const crowded = ground("grass", { "0,0": "body", "2,0": "body" });
    expect(hasLineOfSight(crowded, tilesById, from, beyond, RAT)).toBe(true);
  });

  it("still looks up through open air", () => {
    expect(hasLineOfSight(ground("grass"), tilesById, from, { x: 3, y: 0, z: 1 }, RAT)).toBe(true);
  });
});

describe("line of sight", () => {
  it("crosses open ground", () => {
    expect(hasLineOfSight(field(), tilesById, from, { x: 5, y: 0, z: 0 })).toBe(true);
  });

  it("stops at a full-height wall", () => {
    const map = put(field(), 2, 0, "wall");
    expect(hasLineOfSight(map, tilesById, from, { x: 5, y: 0, z: 0 })).toBe(false);
  });

  it("passes over a crate", () => {
    const map = put(field(), 2, 0, "crate");
    expect(hasLineOfSight(map, tilesById, from, { x: 5, y: 0, z: 0 })).toBe(true);
  });

  it("passes through a window, which a body could not walk through", () => {
    const map = put(field(), 2, 0, "window");
    expect(hasLineOfSight(map, tilesById, from, { x: 5, y: 0, z: 0 })).toBe(true);
  });

  it("looks past a wall that is not between the two", () => {
    const map = put(field(), 2, 3, "wall");
    expect(hasLineOfSight(map, tilesById, from, { x: 5, y: 0, z: 0 })).toBe(true);
  });

  it("sees on the diagonal, and loses it to a wall on the diagonal", () => {
    expect(hasLineOfSight(field(), tilesById, from, { x: 4, y: 4, z: 0 })).toBe(true);
    const map = put(field(), 2, 2, "wall");
    expect(hasLineOfSight(map, tilesById, from, { x: 4, y: 4, z: 0 })).toBe(false);
  });

  it("ignores what is standing at either end", () => {
    const own = put(field(), 0, 0, "wall");
    expect(hasLineOfSight(own, tilesById, from, { x: 3, y: 0, z: 0 })).toBe(true);
    const theirs = put(field(), 3, 0, "wall");
    expect(hasLineOfSight(theirs, tilesById, from, { x: 3, y: 0, z: 0 })).toBe(true);
  });

  it("has nothing in the way of a neighbour", () => {
    const map = put(field(), 1, 0, "wall");
    expect(hasLineOfSight(map, tilesById, from, { x: 1, y: 0, z: 0 })).toBe(true);
  });

  it("looks up through open air", () => {
    const map = field();

    expect(hasLineOfSight(map, tilesById, from, { x: 3, y: 0, z: 1 })).toBe(true);
  });

  it("does not look down through a floor", () => {
    const map = field();

    expect(hasLineOfSight(map, tilesById, from, { x: 3, y: 0, z: -1 })).toBe(false);
  });

  it("looks down through a gap in the floor", () => {
    const map = replaceStack(field(), 0, 0, 0, []);

    expect(hasLineOfSight(map, tilesById, from, { x: 0, y: 0, z: -1 })).toBe(true);
  });

  it("is stopped going up by a ceiling overhead", () => {
    const map = replaceStack(field(), 0, 0, 1, [{ tileId: "wall" }]);

    expect(hasLineOfSight(map, tilesById, from, { x: 0, y: 0, z: 1 })).toBe(false);
  });

  it("sees onto a ledge a cell over, over the lip of it", () => {
    const ledge = replaceStack(field(), 1, 0, 1, [{ tileId: "grass" }]);

    expect(hasLineOfSight(ledge, tilesById, from, { x: 1, y: 0, z: 1 })).toBe(true);
  });

  it("loses that ledge from under a ceiling of its own", () => {
    let map = replaceStack(field(), 1, 0, 1, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "grass" }]);

    expect(hasLineOfSight(map, tilesById, from, { x: 1, y: 0, z: 1 })).toBe(false);
  });

  it("crosses a floor the same way whichever end is looking", () => {
    const ledge = replaceStack(field(), 1, 0, 1, [{ tileId: "grass" }]);
    const up = { x: 1, y: 0, z: 1 };
    const roofed = replaceStack(ledge, 0, 0, 1, [{ tileId: "grass" }]);

    expect(hasLineOfSight(ledge, tilesById, up, from)).toBe(true);
    expect(hasLineOfSight(roofed, tilesById, up, from)).toBe(false);
  });
});

describe("the library we ship", () => {
  const authored = normalizeTiles(tilesJson as unknown[]);

  it("has no item that blocks a look", () => {
    const blocking = authored
      .filter((tile) => tile.kind === "item" && !resolveLightPassing(tile))
      .map((tile) => tile.id);
    expect(blocking).toEqual([]);
  });

  it("has no body that blocks a look, including the one it is standing in", () => {
    const blocking = authored
      .filter((tile) => resolveActor(tile) && !resolveLightPassing(tile))
      .map((tile) => tile.id);
    expect(blocking).toEqual([]);
  });

  it("puts a box within a full-height body's sight and a wall past it", () => {
    const authoredById = Object.fromEntries(authored.map((tile) => [tile.id, tile]));
    const counter = { x: 2, y: 0, z: 0 };
    const customer = { x: 4, y: 0, z: 0 };
    let ground = emptyMap();
    for (let x = 0; x <= 4; x++) {
      ground = replaceStack(ground, x, 0, 0, [{ tileId: "grass" }]);
    }
    const put = (...stacked: string[]) =>
      replaceStack(ground, counter.x, counter.y, 0, [
        { tileId: "grass" },
        ...stacked.map((tileId) => ({ tileId })),
      ]);

    const EYE = HEIGHT_PER_LEVEL;
    expect(hasLineOfSight(put("wooden-box"), authoredById, from, customer, EYE)).toBe(true);
    expect(hasLineOfSight(put("wooden-box", "wooden-box"), authoredById, from, customer, EYE)).toBe(
      false,
    );
    expect(hasLineOfSight(put("stone-wall"), authoredById, from, customer, EYE)).toBe(false);
  });
});
