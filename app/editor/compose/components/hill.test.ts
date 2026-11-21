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

  it("keeps its brinks uncovered when grass was laid on the ground it raised", () => {
    const { map, elevation } = buildTree(
      land(
        SIZE,
        [
          node("grass"),
          node("hill", { roughness: 0, levels: 2, terrace: 2 }, { frame: frame(8, 4, 24, 20) }),
        ],
        "sand",
      ),
    );
    const levelAt = (x: number, y: number) => elevation.get(`${x},${y}`) ?? 0;
    const brinks = [...elevation].flatMap(([key, level]) => {
      const [x, y] = key.split(",").map(Number) as [number, number];
      const drop = [-1, 0, 1].some((dy) =>
        [-1, 0, 1].some((dx) => levelAt(x + dx, y + dy) < level),
      );
      return drop ? [getStack(map, x, y, level).map((p) => p.tileId)] : [];
    });
    expect(brinks.length).toBeGreaterThan(20);
    for (const stack of brinks) expect(stack).toEqual(["grass-brink"]);
  });

  it("stands its walls on the grass round its foot", () => {
    const built = buildTree(
      land(
        SIZE,
        [
          node("grass"),
          node("hill", { roughness: 0, levels: 1, terrace: 2 }, { frame: frame(8, 4, 24, 20) }),
        ],
        "sand",
      ),
    );
    const levelOf = (x: number, y: number) => built.elevation.get(`${x},${y}`) ?? 0;
    const feet: string[][] = [];
    for (const [key] of built.elevation) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      const beside = [-1, 0, 1].some((dy) =>
        [-1, 0, 1].some((dx) => levelOf(x + dx, y + dy) === 0),
      );
      if (beside) feet.push(getStack(built.map, x, y, 0).map((p) => p.tileId));
    }
    expect(feet.length).toBeGreaterThan(20);
    for (const stack of feet) expect(stack).toEqual(["sand", "grass", "hill-wall"]);
  });
});
