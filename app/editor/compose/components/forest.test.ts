import { describe, expect, it } from "vitest";
import { getStack } from "../../../lib/mapData";
import { buildTree, land, node, reach, sketch } from "../testTree";

const SIZE = { w: 30, h: 20 };

describe("forest", () => {
  it.each([1, 2, 3, 4, 5, 6])(
    "keeps a path walkable from one edge of a solid wood to the opposite edge, seed %i",
    (seed) => {
      const built = buildTree(land(SIZE, [node("forest", { density: 100, path: "dirt" })]), {
        seed,
      });
      const path: Array<{ x: number; y: number }> = [];
      for (let y = 0; y < SIZE.h; y++) {
        for (let x = 0; x < SIZE.w; x++) {
          if (getStack(built.map, x, y, 0).at(-1)?.tileId === "dirt") path.push({ x, y });
        }
      }
      expect(path.length, sketch(built)).toBeGreaterThan(0);
      const walked = [...reach(built, path[0]!).values()];
      const sides = [
        walked.some((c) => c.x === 0) && walked.some((c) => c.x === SIZE.w - 1),
        walked.some((c) => c.y === 0) && walked.some((c) => c.y === SIZE.h - 1),
      ];
      expect(sides, sketch(built)).toContain(true);
    },
  );
});
