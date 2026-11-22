import { describe, expect, it } from "vitest";
import { getStack } from "../../../lib/mapData";
import type { BuildResult } from "../build";
import { buildTree, frame, isle, land, node, sketch, walks } from "../testTree";

const SIZE = { w: 30, h: 12 };
const WEST = { x: 3, y: 6 };
const EAST = { x: 26, y: 6 };
const river = (props: Record<string, unknown> = {}) =>
  node("river", { from: { x: 15, y: 0 }, to: { x: 15, y: 11 }, width: 3, ...props });
const road = () => node("road", { from: WEST, to: EAST });

describe("river", () => {
  it("parts the land for dry feet and is waded across", () => {
    const built = buildTree(land(SIZE, [river()]));
    expect(walks(built, WEST, EAST), sketch(built)).toBe(false);
    expect(walks(built, WEST, EAST, { wading: true }), sketch(built)).toBe(true);
  });

  it("still parts the land when it bends", () => {
    const built = buildTree(land(SIZE, [river({ wander: 100, bendLength: 4, width: 1 })]));
    expect(walks(built, WEST, EAST), sketch(built)).toBe(false);
  });

  it("washes out a road it is drawn after", () => {
    const bridged = buildTree(land(SIZE, [river(), road()]));
    expect(walks(bridged, WEST, EAST), sketch(bridged)).toBe(true);
    const cut = buildTree(land(SIZE, [road(), river()]));
    expect(walks(cut, WEST, EAST), sketch(cut)).toBe(false);
  });
});

describe("a river off raised ground", () => {
  const AREA = { w: 30, h: 22 };
  const NORTH_SOUTH = { from: { x: 15, y: 0 }, to: { x: 15, y: 21 } };
  const WEST_EAST = { from: { x: 0, y: 11 }, to: { x: 29, y: 11 } };
  const hill = (props: Record<string, unknown>) =>
    node("hill", { roughness: 0, ...props }, { frame: frame(4, 0, 22, 22) });
  const over = (
    hillProps: Record<string, unknown>,
    course: Record<string, unknown>,
    order: "hill first" | "river first" = "hill first",
  ) => {
    const layers = [hill(hillProps), node("river", { width: 3, ...course })];
    return buildTree(land(AREA, order === "hill first" ? layers : layers.reverse()));
  };

  /** Every cell holding fall segments, with how many it holds over all its levels. */
  const falls = (built: BuildResult) => {
    const out: Array<{ x: number; y: number; facing: "south" | "east"; segments: number }> = [];
    for (let y = 0; y < AREA.h; y++) {
      for (let x = 0; x < AREA.w; x++) {
        const ids = Array.from({ length: 8 }, (_, z) =>
          getStack(built.map, x, y, z).map((p) => p.tileId),
        ).flat();
        const segments = ids.filter((id) => id.startsWith("waterfall"));
        if (segments.length === 0) continue;
        const facing = segments.every((id) => id.startsWith("waterfall-east")) ? "east" : "south";
        out.push({ x, y, facing, segments: segments.length });
      }
    }
    return out;
  };
  const levelAt = (built: BuildResult, x: number, y: number) =>
    built.elevation.get(`${x},${y}`) ?? 0;

  /** The cell a fall comes down from: north of it for one facing south, west for one facing east. */
  const source = (f: { x: number; y: number; facing: "south" | "east" }) =>
    f.facing === "south" ? { x: f.x, y: f.y - 1 } : { x: f.x - 1, y: f.y };

  it.each([
    ["south", NORTH_SOUTH, (f: { x: number; y: number }) => f.y > 11],
    ["east", WEST_EAST, (f: { x: number; y: number }) => f.x > 15],
  ] as const)(
    "faces %s across its whole width where it leaves a cliff that way, and not where it climbs one",
    (facing, course, downstream) => {
      const built = over({ levels: 1, terrace: 0 }, course);
      const found = falls(built);
      expect(found, sketch(built)).toHaveLength(3);
      expect(
        found.every((f) => f.facing === facing && downstream(f)),
        sketch(built),
      ).toBe(true);
      for (const f of found) {
        const from = source(f);
        expect(levelAt(built, from.x, from.y) - levelAt(built, f.x, f.y)).toBe(1);
      }
    },
  );

  it("is as tall as the cliff it comes down", () => {
    const found = falls(over({ levels: 3, terrace: 0 }, NORTH_SOUTH));
    expect(found).toHaveLength(3);
    for (const f of found) expect(f.segments).toBe(3 * 2);
  });

  it("falls once for every terrace it comes down", () => {
    const built = over({ levels: 2, terrace: 2 }, NORTH_SOUTH);
    const from = new Set(falls(built).map((f) => levelAt(built, source(f).x, source(f).y)));
    expect([...from].sort(), sketch(built)).toEqual([1, 2]);
  });

  it("has nothing to fall from when the hill is raised round it", () => {
    const built = over({ levels: 2, terrace: 0 }, NORTH_SOUTH, "river first");
    expect(falls(built), sketch(built)).toEqual([]);
  });

  it("falls into water that was there before it", () => {
    const lake = node(
      "fill",
      { tiles: ["water"], edge: [], mode: "whole stack" },
      {
        frame: frame(0, 19, 30, 3),
      },
    );
    const built = buildTree(
      land(AREA, [
        lake,
        hill({ levels: 1, terrace: 0 }),
        node("river", { width: 3, ...NORTH_SOUTH }),
      ]),
    );
    expect(
      falls(built)
        .map((f) => f.x)
        .sort(),
      sketch(built),
    ).toEqual([14, 15, 16]);
  });
});

describe("a river's banks", () => {
  const AREA = { w: 40, h: 30 };
  const across = { from: { x: 20, y: 0 }, to: { x: 20, y: 29 }, width: 2, wander: 0 };
  const ids = (built: BuildResult, x: number, y: number, z = 0) =>
    getStack(built.map, x, y, z).map((p) => p.tileId);
  const wetAt = (built: BuildResult, y: number, z = 0) =>
    Array.from({ length: AREA.w }, (_, x) => x).filter(
      (x) => Math.abs(x - 20) < 5 && ids(built, x, y, z).includes("water"),
    );

  it("lose the grass laid over the ground, so the grass stops a cell short of the water", () => {
    const built = buildTree(isle(AREA, [], 0, { under: [node("grass"), node("river", across)] }));
    const wet = wetAt(built, 15);
    expect(wet.length, sketch(built)).toBeGreaterThan(0);
    const west = Math.min(...wet) - 1;
    const east = Math.max(...wet) + 1;
    expect(ids(built, west, 15)).toEqual(["sand"]);
    expect(ids(built, east, 15)).toEqual(["sand"]);
    expect(ids(built, west - 1, 15)).toContain("grass");
  });
});
