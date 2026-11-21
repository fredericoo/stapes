import { describe, expect, it } from "vitest";
import { buildTree, frame, land, node, reach, sketch, walks } from "../testTree";

const SIZE = { w: 30, h: 12 };
const WEST = { x: 3, y: 6 };
const EAST = { x: 26, y: 6 };

describe("fill", () => {
  const lake = (props: Record<string, unknown>) =>
    buildTree(land(SIZE, [node("fill", props, { frame: frame(10, 0, 10, 12) })]));

  it("lays a lake with shallows waded at its edge and a middle nobody stands in", () => {
    const built = lake({});
    expect(walks(built, WEST, { x: 11, y: 6 }), sketch(built)).toBe(false);
    expect(walks(built, WEST, { x: 11, y: 6 }, { wading: true }), sketch(built)).toBe(true);
    const waded = [...reach(built, WEST, { wading: true }).values()];
    expect(
      waded.filter((c) => c.x >= 13 && c.x <= 16 && c.y >= 3 && c.y <= 8),
      sketch(built),
    ).toEqual([]);
  });

  it("is waded from side to side when it is shallows throughout", () => {
    const built = lake({ tiles: ["water"], edge: [] });
    expect(walks(built, WEST, EAST), sketch(built)).toBe(false);
    expect(walks(built, WEST, EAST, { wading: true }), sketch(built)).toBe(true);
  });
});
