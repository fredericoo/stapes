import { describe, expect, it } from "vitest";
import { buildTree, cutFootprints, land, node, sketch, stands, walks } from "../testTree";

const LANE = { w: 12, h: 2 };
const WEST = { x: 1, y: 0 };
const EAST = { x: 10, y: 0 };
const at = (x: number, y: number) => ({ x, y });

describe("tile", () => {
  it("stands a tile wider than a cell in every cell it covers", () => {
    const narrow = buildTree(land(LANE, [node("tile", { tile: "tree", at: at(6, 1) })]));
    expect(walks(narrow, WEST, EAST), sketch(narrow)).toBe(true);
    const wide = buildTree(land(LANE, [node("tile", { tile: "old-tree", at: at(6, 1) })]));
    expect(walks(wide, WEST, EAST), sketch(wide)).toBe(false);
    expect(cutFootprints(wide)).toEqual([]);
  });

  it("refuses a wide tile with a cell off the ground rather than placing part of it", () => {
    const built = buildTree(land(LANE, [node("tile", { tile: "old-tree", at: at(0, 1) })]), {
      problems: "returned",
    });
    expect(built.problems.map((p) => p.reason)).toEqual(["There is no ground at -1,1"]);
    expect(stands(built, "old-tree")).toEqual([]);
  });

  it("refuses a wide tile where something already stands under part of it", () => {
    const built = buildTree(
      land(LANE, [
        node("tile", { tile: "tree", at: at(5, 0) }),
        node("tile", { tile: "old-tree", at: at(6, 1) }),
      ]),
      { problems: "returned" },
    );
    expect(built.problems.map((p) => p.reason)).toEqual(["Nothing can stand on the Tree at 5,0"]);
    expect(stands(built, "old-tree")).toEqual([]);
  });

  it("stands a tile taller than a level where the level above it is clear, and not under a floor", () => {
    const open = buildTree(land(LANE, [node("tile", { tile: "yeti", at: at(6, 1) })]));
    expect(stands(open, "yeti")).toHaveLength(1);
    const SITE = { x: 2, y: 0, w: 8, h: 2 };
    const indoors = buildTree(
      land({ w: 12, h: 8 }, [
        node(
          "house",
          {},
          {
            frame: { ...SITE, h: 7 },
            children: [node("floor", { use: "empty" }), node("floor", { use: "empty" })],
          },
        ),
        node("tile", { tile: "yeti", at: at(6, 3) }),
      ]),
      { problems: "returned" },
    );
    expect(indoors.problems.map((p) => p.reason)).toEqual(["There is no room for a Yeti at 6,3"]);
  });
});
