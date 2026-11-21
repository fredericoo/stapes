import { describe, expect, it } from "vitest";
import { getStack } from "../../lib/mapData";
import type { MapFile } from "../../lib/types";
import type { MapNode } from "./doc";
import { buildTree, isle } from "./testTree";

const W = 40;
const H = 30;

const SIZE = { w: W, h: H };

function build(under: MapNode[], props: Record<string, unknown> = {}) {
  return buildTree(isle(SIZE, [], 0, { under, props })).map;
}

const ids = (map: MapFile, x: number, y: number) => getStack(map, x, y, 0).map((p) => p.tileId);
const wet = (map: MapFile, x: number, y: number) => ids(map, x, y).includes("water");

function cells(map: MapFile, test: (tiles: string[], x: number, y: number) => boolean) {
  const out: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) if (test(ids(map, x, y), x, y)) out.push({ x, y });
  }
  return out;
}

/** How many four-neighbour steps the nearest water is from x,y, looking no further than `reach`. */
function stepsToWater(map: MapFile, x: number, y: number, reach: number): number {
  let nearest = Infinity;
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const steps = Math.abs(dx) + Math.abs(dy);
      if (steps <= reach && wet(map, x + dx, y + dy)) nearest = Math.min(nearest, steps);
    }
  }
  return nearest;
}

const grass: MapNode = { type: "grass", key: "grass" };
const ROW = 15;
const road = (props: Record<string, unknown>): MapNode => ({
  type: "road",
  key: "path",
  props: { from: { x: 10, y: ROW }, to: { x: 30, y: ROW }, ...props },
});

describe("grass", () => {
  it("covers the open ground it is allowed on and nothing that stands", () => {
    const map = build(
      [
        { type: "tile", key: "rock", props: { tile: "tree", at: { x: 20, y: 15 } } },
        {
          type: "fill",
          key: "mud",
          frame: { x: 22, y: 12, w: 4, h: 4 },
          props: { tiles: ["mud"], mode: "whole stack", edge: [] },
        },
        grass,
      ],
      { beach: 0 },
    );
    expect(ids(map, 20, 15)).toEqual(["sand", "tree"]);
    expect(ids(map, 23, 13)).toEqual(["mud"]);
    const sand = cells(map, (t) => t.length === 1 && t[0] === "sand");
    expect(sand).toEqual([]);
    expect(ids(map, 15, 15)).toEqual(["sand", "grass"]);
  });
});

describe("an island's beach", () => {
  it("keeps the ground its children lay off the land nearest the coast", () => {
    const map = build([grass], { beach: 2 });
    const grown = cells(map, (t) => t.includes("grass"));
    expect(grown.length).toBeGreaterThan(100);
    for (const { x, y } of grown) expect(stepsToWater(map, x, y, 2), `${x},${y}`).toBe(Infinity);
    const bare = cells(map, (t) => t.length === 1 && t[0] === "sand");
    for (const { x, y } of bare)
      expect(stepsToWater(map, x, y, 2), `${x},${y}`).toBeLessThanOrEqual(2);
  });

  it("lets grass reach the coast when it is no cells wide", () => {
    const map = build([grass], { beach: 0 });
    expect(cells(map, (t) => t.length === 1 && t[0] === "sand")).toEqual([]);
  });

  it("stops a child road's surface short of the coast and lets its river through", () => {
    const map = build(
      [
        road({ tile: "cobblestone", from: { x: 0, y: ROW }, to: { x: W - 1, y: ROW } }),
        {
          type: "river",
          key: "brook",
          props: { from: { x: 12, y: 0 }, to: { x: 12, y: H - 1 }, bridged: false },
        },
      ],
      { beach: 2 },
    );
    const paved = cells(map, (t) => t.includes("cobblestone"));
    expect(paved.length).toBeGreaterThan(10);
    for (let y = 0; y < H; y++) expect(wet(map, 12, y), `12,${y}`).toBe(true);
    const sea = build([], { beach: 2 });
    for (const { x, y } of paved) expect(stepsToWater(sea, x, y, 2), `${x},${y}`).toBe(Infinity);
  });

  it("keeps grass off the brinks of a hill on the beach, leaving them the hill's own", () => {
    const { map, elevation } = buildTree(
      isle(SIZE, [], 0, {
        under: [
          {
            type: "hill",
            key: "dune",
            frame: { x: 26, y: 6, w: 14, h: 18 },
            props: { levels: 1, terrace: 2, roughness: 0, ground: "sand" },
          },
          grass,
        ],
        props: { beach: 2 },
      }),
    );
    const sea = build([], { beach: 2 });
    const near = [...elevation.keys()].filter((key) => {
      const [x, y] = key.split(",").map(Number) as [number, number];
      return stepsToWater(sea, x, y, 2) <= 2;
    });
    expect(near.length).toBeGreaterThan(0);
    for (const key of near) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      const top = getStack(map, x, y, 1).map((p) => p.tileId);
      expect(top, key).toEqual([expect.stringMatching(/^sand(-brink)?$/)]);
    }
  });

  it("leaves a layer that is not its child alone", () => {
    const map = buildTree(isle(SIZE, [grass], 0, { props: { beach: 2 } })).map;
    expect(cells(map, (t) => t.length === 1 && t[0] === "sand")).toEqual([]);
  });
});

describe("a road through grass", () => {
  const onRoute = (x: number) => x >= 10 && x <= 30;

  it("takes the grass off its route and lays nothing when it has no tile", () => {
    const map = build([grass, road({ tile: null })], { beach: 0 });
    for (let x = 8; x <= 32; x++) {
      expect(ids(map, x, ROW), `${x}`).toEqual(onRoute(x) ? ["sand"] : ["sand", "grass"]);
      expect(ids(map, x, ROW + 1), `${x} beside`).toEqual(["sand", "grass"]);
    }
  });

  it("lays its tile on the ground under the grass, not on the grass", () => {
    const map = build([grass, road({ tile: "dirt" })]);
    for (let x = 10; x <= 30; x++) expect(ids(map, x, ROW), `${x}`).toEqual(["sand", "dirt"]);
  });

  it("cuts its verge that many cells each side without paving it", () => {
    const map = build([grass, road({ tile: "dirt", verge: 2 })]);
    for (let x = 10; x <= 30; x++) {
      for (const dy of [-2, -1, 1, 2])
        expect(ids(map, x, ROW + dy), `${x},${dy}`).toEqual(["sand"]);
      expect(ids(map, x, ROW + 3), `${x},3`).toEqual(["sand", "grass"]);
    }
  });

  it("paves every cell of a diagonal route when it has a verge", () => {
    const steps = { from: { x: 10, y: 10 }, to: { x: 22, y: 20 } };
    const paved = (verge: number) =>
      cells(build([grass, road({ tile: "dirt", verge, ...steps })]), (t) => t.includes("dirt"));
    expect(paved(1)).toEqual(paved(0));
  });

  it("leaves the grass when it cuts nothing", () => {
    const map = build([grass, road({ tile: null, cuts: [] })]);
    for (let x = 10; x <= 30; x++) expect(ids(map, x, ROW), `${x}`).toEqual(["sand", "grass"]);
  });
});
