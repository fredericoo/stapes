import { describe, expect, it } from "vitest";
import { getStack } from "../../../lib/mapData";
import { buildTree, frame, land, node, reach, sketch, tilesById, walks } from "../testTree";

const SIZE = { w: 56, h: 44 };
const OUTSIDE = { x: 28, y: 41 };
const MOUTH = { x: 0, y: 0, pinX: "center", pinY: "bottom" };

function hillWith(cave: Record<string, unknown> | null, hill: Record<string, unknown> = {}) {
  return land(SIZE, [
    node("hill", { levels: 3, terrace: 2, roughness: 0, ...hill }, { frame: frame(4, 2, 48, 36) }),
    ...(cave ? [node("cave", cave, { frame: frame(6, 4, 44, 32) })] : []),
  ]);
}

function floorCells(built: ReturnType<typeof buildTree>) {
  const cells: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < SIZE.h; y++) {
    for (let x = 0; x < SIZE.w; x++) {
      if (getStack(built.map, x, y, 0).at(-1)?.tileId === "dirt") cells.push({ x, y });
    }
  }
  return cells;
}

describe("cave", () => {
  it("opens the inside of a hill to somebody standing at its foot", () => {
    const solid = buildTree(hillWith(null));
    expect(floorCells(solid)).toEqual([]);

    const built = buildTree(hillWith({ mouths: [MOUTH] }));
    const floor = floorCells(built);
    expect(floor.length).toBeGreaterThan(40);
    const walked = reach(built, OUTSIDE);
    const missed = floor.filter((c) => !walked.has(`0:${c.x},${c.y}`));
    expect(missed, sketch(built)).toEqual([]);
    expect(walks(built, { ...floor[0]!, z: 0 }, OUTSIDE), sketch(built)).toBe(true);
  });

  it("leaves rock between every cave cell and the outside of the hill", () => {
    const built = buildTree(hillWith({ mouths: [MOUTH] }));
    for (const { x, y } of floorCells(built)) {
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [-1, -1],
        [1, -1],
        [-1, 1],
      ] as const) {
        const beside = getStack(built.map, x + dx, y + dy, 0).at(-1)!;
        const open = beside.tileId === "dirt" || beside.tileId === "stalagmite";
        const mouth = beside.tileId === "hill-cave-mouth";
        expect(open || mouth || tilesById[beside.tileId]!.walkable === false, `${x},${y}`).toBe(
          true,
        );
      }
      expect(built.elevation.get(`${x},${y}`), `${x},${y} has hill over it`).toBeGreaterThan(0);
    }
  });

  it("is dug at the level its frame names, higher up the same hill", () => {
    const tree = land(SIZE, [
      node("hill", { levels: 4, terrace: 3, roughness: 0 }, { frame: frame(4, 2, 48, 36) }),
      node("cave", { mouths: [MOUTH] }, { frame: { ...frame(6, 4, 44, 32), z: 1 } }),
    ]);
    const built = buildTree(tree);
    let mouth: { x: number; y: number } | null = null;
    for (let y = 0; y < SIZE.h && !mouth; y++) {
      for (let x = 0; x < SIZE.w; x++) {
        if (getStack(built.map, x, y, 1).some((p) => p.tileId === "hill-cave-mouth"))
          mouth = { x, y };
      }
    }
    expect(mouth, sketch(built)).not.toBeNull();
    expect(
      walks(built, { x: mouth!.x, y: mouth!.y + 1, z: 1 }, { x: mouth!.x, y: mouth!.y - 3, z: 1 }),
    ).toBe(true);
  });

  it("is refused under a hill one level high, whose top would be its roof", () => {
    const built = buildTree(hillWith({ mouths: [MOUTH] }, { levels: 1 }), { problems: "returned" });
    expect(built.problems.map((p) => p.key)).toEqual(["cave-1"]);
  });

  it("is refused where there is no hill to dig into", () => {
    const built = buildTree(
      land(SIZE, [node("cave", { mouths: [MOUTH] }, { frame: frame(6, 4, 44, 32) })]),
      { problems: "returned" },
    );
    expect(built.problems.map((p) => p.key)).toEqual(["cave-1"]);
  });
});
