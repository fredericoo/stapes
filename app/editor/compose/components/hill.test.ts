import { describe, expect, it } from "vitest";
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
});
