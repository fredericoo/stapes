import { describe, expect, it } from "vitest";
import { buildTree, frame, land, node, sketch, walks } from "../testTree";

const SIZE = { w: 30, h: 12 };
const WEST = { x: 3, y: 6 };
const EAST = { x: 26, y: 6 };
const hedge = () =>
  node("fill", { tiles: ["tree"], edge: [], mode: "on top" }, { frame: frame(12, 0, 5, 12) });

describe("clear", () => {
  it("opens a way through trees", () => {
    const wooded = buildTree(land(SIZE, [hedge()]));
    expect(walks(wooded, WEST, EAST), sketch(wooded)).toBe(false);
    const gap = buildTree(land(SIZE, [hedge(), node("clear", {}, { frame: frame(10, 5, 9, 2) })]));
    expect(walks(gap, WEST, EAST), sketch(gap)).toBe(true);
  });

  it("leaves standing what it is not told to remove", () => {
    const kept = buildTree(
      land(SIZE, [
        hedge(),
        node("clear", { remove: ["small-bush"] }, { frame: frame(10, 5, 9, 2) }),
      ]),
    );
    expect(walks(kept, WEST, EAST), sketch(kept)).toBe(false);
  });
});
