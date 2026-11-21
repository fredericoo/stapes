import { describe, expect, it } from "vitest";
import { getStack } from "../../../lib/mapData";
import type { MapNode } from "../doc";
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

function floorCells(built: ReturnType<typeof buildTree>, z = 0) {
  const cells: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < SIZE.h; y++) {
    for (let x = 0; x < SIZE.w; x++) {
      const top = getStack(built.map, x, y, z).at(-1)?.tileId;
      if (top === "dirt" || top === "flagstone-floor") cells.push({ x, y });
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

  describe("underground", () => {
    const MIDDLE = { x: 0, y: 0, pinX: "center", pinY: "center" };
    /** `grass` lets light through and `grass-2` does not, and only ground that keeps the daylight out can roof a cave. */
    const ground = (children: MapNode[]) => land(SIZE, children, "grass-2");
    const below = (z: number, props: Record<string, unknown>) =>
      node("cave", props, { frame: { ...frame(6, 4, 44, 32), z } });

    /** Every floor cell of the levels given, walked to from the surface and walked back out of. */
    const unreached = (built: ReturnType<typeof buildTree>, levels: number[]) => {
      const walked = reach(built, OUTSIDE);
      const floor = levels.flatMap((z) => floorCells(built, z).map((c) => ({ ...c, z })));
      expect(floor.length, sketch(built)).toBeGreaterThan(40 * levels.length);
      expect(walks(built, floor[0]!, OUTSIDE)).toBe(true);
      return floor.filter((c) => !walked.has(`${c.z}:${c.x},${c.y}`));
    };

    it("is refused with no way down to it", () => {
      const built = buildTree(ground([below(-1, { mouths: [MIDDLE] })]), {
        problems: "returned",
      });
      expect(built.problems.map((p) => p.key)).toEqual(["cave-1"]);
    });

    it.each([["stairs"], ["ladders"]])("is reached from the surface by its %s", (way) => {
      const built = buildTree(ground([below(-1, { [way]: [MIDDLE] })]));
      expect(unreached(built, [-1])).toEqual([]);
    });

    it("is dug as rooms and corridors with the crypt shape, every room reached", () => {
      const built = buildTree(ground([below(-1, { shape: "crypt", stairs: [MIDDLE] })]));
      expect(unreached(built, [-1])).toEqual([]);
      const floors = floorCells(built, -1).map(
        ({ x, y }) => getStack(built.map, x, y, -1).at(-1)!.tileId,
      );
      expect(new Set(floors)).toEqual(new Set(["flagstone-floor"]));
    });

    it("is walled with its own wall tile, rock to every side of the floor", () => {
      const built = buildTree(ground([below(-1, { stairs: [MIDDLE] })]));
      for (const { x, y } of floorCells(built, -1)) {
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const ids = getStack(built.map, x + dx, y + dy, -1).map((p) => p.tileId);
          expect(ids.length, `${x + dx},${y + dy}`).toBeGreaterThan(0);
        }
      }
      const walls = Object.values(built.map.levels["-1"] ?? {})
        .flatMap((chunk) => Object.values(chunk))
        .filter((stack) => stack.at(-1)?.tileId === "cave-wall-sloped");
      expect(walls.length).toBeGreaterThan(0);
    });

    it("stacks under another cave, reached through the stairs of the one above", () => {
      const built = buildTree(
        ground([below(-1, { stairs: [MIDDLE] }), below(-2, { stairs: [MIDDLE] })]),
      );
      expect(unreached(built, [-1, -2])).toEqual([]);
    });
  });

  describe("in a dungeon", () => {
    const dungeon = (z: number, levels: Array<Record<string, unknown>>) =>
      node(
        "dungeon",
        {},
        {
          frame: { ...frame(6, 4, 44, 32), z },
          children: levels.map((props) => node("level", props)),
        },
      );

    it("digs each level one below the last, every one reached from the surface and left again", () => {
      const built = buildTree(
        land(
          SIZE,
          [
            dungeon(-1, [
              { shape: "crypt" },
              { shape: "caverns" },
              { shape: "tunnels", upBy: "ladder" },
            ]),
          ],
          "grass-2",
        ),
      );
      const walked = reach(built, OUTSIDE);
      for (const z of [-1, -2, -3]) {
        const floor = floorCells(built, z);
        expect(floor.length, `level ${z}`).toBeGreaterThan(40);
        expect(floor.filter((c) => !walked.has(`${z}:${c.x},${c.y}`))).toEqual([]);
      }
      expect(walks(built, { ...floorCells(built, -3)[0]!, z: -3 }, OUTSIDE)).toBe(true);
    });

    it("opens its first level from a hill's cliff and goes on down under the hill", () => {
      const built = buildTree(
        land(SIZE, [
          node("hill", { levels: 3, terrace: 2, roughness: 0 }, { frame: frame(4, 2, 48, 36) }),
          node(
            "dungeon",
            {},
            {
              frame: { ...frame(6, 4, 44, 32), z: 0 },
              children: [node("level", { up: MOUTH }), node("level", { shape: "crypt" })],
            },
          ),
        ]),
      );
      const walked = reach(built, OUTSIDE);
      for (const z of [0, -1]) {
        const floor = floorCells(built, z);
        expect(floor.length, `level ${z}`).toBeGreaterThan(40);
        expect(floor.filter((c) => !walked.has(`${z}:${c.x},${c.y}`))).toEqual([]);
      }
    });
  });
});
