import { describe, expect, it } from "vitest";
import { wadesIn } from "../../../game/pathfinding";
import { getStack } from "../../../lib/mapData";
import { buildTree, frame, node, reach, sketch, tilesById, walks } from "../testTree";

const SIZE = { w: 48, h: 24 };
const sea = (children: ReturnType<typeof node>[]) =>
  node("sea", {}, { frame: frame(0, 0, SIZE.w, SIZE.h), children });

describe("island", () => {
  it.each([1, 2, 3, 4, 5])("is one piece of dry land at any roughness, seed %i", (seed) => {
    const built = buildTree(
      sea([node("island", { roughness: 100 }, { frame: frame(4, 3, 40, 18) })]),
      { seed },
    );
    const walked = reach(built, { x: 24, y: 12 });
    const stranded: string[] = [];
    for (let y = 0; y < SIZE.h; y++) {
      for (let x = 0; x < SIZE.w; x++) {
        const dry =
          getStack(built.map, x, y, 0).length > 0 &&
          getStack(built.map, x, y, 0).at(-1)?.tileId !== "deep-water" &&
          !wadesIn(built.map, { x, y, z: 0 }, tilesById);
        if (dry && !walked.has(`0:${x},${y}`)) stranded.push(`${x},${y}`);
      }
    }
    expect(stranded, sketch(built)).toEqual([]);
  });

  it("is left only through deep water, which nobody wades", () => {
    const apart = buildTree(
      sea([
        node("island", { roughness: 0 }, { frame: frame(2, 4, 18, 16) }),
        node("island", { roughness: 0 }, { frame: frame(28, 4, 18, 16) }),
      ]),
    );
    expect(walks(apart, { x: 11, y: 12 }, { x: 37, y: 12 }, { wading: true }), sketch(apart)).toBe(
      false,
    );
  });

  it("joins an island it overlaps into one coast walked with dry feet", () => {
    const joined = buildTree(
      sea([
        node("island", { roughness: 0 }, { frame: frame(2, 4, 30, 16) }),
        node("island", { roughness: 0 }, { frame: frame(16, 4, 30, 16) }),
      ]),
    );
    expect(walks(joined, { x: 8, y: 12 }, { x: 40, y: 12 }), sketch(joined)).toBe(true);
  });
});
