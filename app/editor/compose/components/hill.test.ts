import { describe, expect, it } from "vitest";
import { getStack } from "../../../lib/mapData";
import { buildTree, frame, land, node, sketch, walks } from "../testTree";

const SIZE = { w: 40, h: 28 };
const FOOT = { x: 3, y: 14 };
const TOP = { x: 20, y: 14 };

describe("hill", () => {
  const raised = (props: Record<string, unknown> = {}) =>
    buildTree(
      land(SIZE, [node("hill", { roughness: 0, ...props }, { frame: frame(8, 4, 24, 20) })]),
    );

  it.each([1, 3])("is dropped off and never climbed with %i levels and no ramp", (levels) => {
    const built = raised({ levels, terrace: 2 });
    expect(built.elevation.get(`${TOP.x},${TOP.y}`)).toBe(levels);
    expect(walks(built, FOOT, TOP), sketch(built)).toBe(false);
    expect(walks(built, TOP, FOOT), sketch(built)).toBe(true);
  });

  it("is climbed by the ramp a point of its own puts on the nearest cliff", () => {
    const built = raised({ levels: 1, ramps: [{ x: 0, y: 10 }] });
    expect(walks(built, FOOT, TOP), sketch(built)).toBe(true);
  });

  const onSand = (layers: ReturnType<typeof node>[], props: Record<string, unknown> = {}) =>
    buildTree(
      land(
        SIZE,
        [
          ...layers,
          node(
            "hill",
            { roughness: 0, levels: 2, terrace: 2, ...props },
            { frame: frame(8, 4, 24, 20) },
          ),
        ],
        "sand",
      ),
    );
  type Built = ReturnType<typeof onSand>;
  const levelOf = (built: Built, x: number, y: number) => built.elevation.get(`${x},${y}`) ?? 0;
  /** The stacks on the top of every raised cell beside a drop, and of every raised cell that is not. */
  const tops = (built: Built) => {
    const edges: string[][] = [];
    const inner: string[][] = [];
    for (const [key, level] of built.elevation) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      const drop = [-1, 0, 1].some((dy) =>
        [-1, 0, 1].some((dx) => levelOf(built, x + dx, y + dy) < level),
      );
      (drop ? edges : inner).push(getStack(built.map, x, y, level).map((p) => p.tileId));
    }
    return { edges, inner };
  };

  it("keeps its brinks uncovered when grass was laid on the ground it raised", () => {
    const { edges } = tops(onSand([node("grass")]));
    expect(edges.length).toBeGreaterThan(20);
    for (const stack of edges) expect(stack).toEqual(["grass-brink"]);
  });

  it.each([
    ["sand", "sand-brink"],
    ["snow", "snow-brink"],
    ["basalt", "basalt-brink"],
  ])("cuts a top of %s to that ground's own brink", (ground, brink) => {
    const { edges, inner } = tops(onSand([], { ground }));
    for (const stack of edges) expect(stack).toEqual([brink]);
    for (const stack of inner) expect(stack).toEqual([ground]);
  });

  it("stands its walls on the grass round its foot", () => {
    const built = onSand([node("grass")], { levels: 1 });
    const feet: string[][] = [];
    for (const [key] of built.elevation) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      const beside = [-1, 0, 1].some((dy) =>
        [-1, 0, 1].some((dx) => levelOf(built, x + dx, y + dy) === 0),
      );
      if (beside) feet.push(getStack(built.map, x, y, 0).map((p) => p.tileId));
    }
    expect(feet.length).toBeGreaterThan(20);
    for (const stack of feet) expect(stack).toEqual(["sand", "grass", "hill-wall"]);
  });

  it("takes the brink of grass laid on its top after it", () => {
    const { edges, inner } = tops(onSand([], { ground: "sand" }));
    expect(edges.length).toBeGreaterThan(20);
    const grassed = tops(
      buildTree(
        land(
          SIZE,
          [
            node(
              "hill",
              { roughness: 0, levels: 2, terrace: 2, ground: "sand" },
              { frame: frame(8, 4, 24, 20) },
            ),
            node("grass"),
          ],
          "sand",
        ),
      ),
    );
    expect(grassed.edges).toEqual(edges.map(() => ["grass-brink"]));
    expect(grassed.inner).toEqual(inner.map(() => ["sand", "grass"]));
  });
});
