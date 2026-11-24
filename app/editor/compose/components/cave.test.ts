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

  it("cuts its mouth in the stone of the hill wall it opens in", () => {
    const mouthsIn = (wall: string) => {
      const built = buildTree(hillWith({ mouths: [MOUTH] }, { wall }));
      const ids = new Set<string>();
      for (let y = 0; y < SIZE.h; y++) {
        for (let x = 0; x < SIZE.w; x++) {
          for (const p of getStack(built.map, x, y, 0)) {
            if (p.tileId.startsWith("hill-cave-mouth")) ids.add(p.tileId);
          }
        }
      }
      return [...ids];
    };
    expect(mouthsIn("hill-wall")).toEqual(["hill-cave-mouth"]);
    expect(mouthsIn("hill-wall-frost")).toEqual(["hill-cave-mouth-frost"]);
  });

  it("opens a hill raised from sand under a cover of grass", () => {
    const built = buildTree(
      land(
        SIZE,
        [
          node("grass", {}),
          node("hill", { levels: 3, terrace: 2, roughness: 0 }, { frame: frame(4, 2, 48, 36) }),
          node("cave", { mouths: [MOUTH] }, { frame: frame(6, 4, 44, 32) }),
        ],
        "sand",
      ),
    );
    const floor = floorCells(built);
    expect(floor.length, sketch(built)).toBeGreaterThan(40);
    expect(walks(built, { ...floor[0]!, z: 0 }, OUTSIDE), sketch(built)).toBe(true);
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

    it.each([["caverns"], ["crypt"]])(
      "leaves no hole down through the level inside a %s, only open rock outside it",
      (shape) => {
        const built = buildTree(ground([below(-1, { shape, stairs: [MIDDLE] })]));
        const empty = (x: number, y: number) => getStack(built.map, x, y, -1).length === 0;
        const outside = new Set<string>();
        const queue: Array<[number, number]> = [];
        for (let x = 0; x < SIZE.w; x++) queue.push([x, 0], [x, SIZE.h - 1]);
        for (let y = 0; y < SIZE.h; y++) queue.push([0, y], [SIZE.w - 1, y]);
        for (let head = 0; head < queue.length; head++) {
          const [x, y] = queue[head]!;
          if (x < 0 || y < 0 || x >= SIZE.w || y >= SIZE.h || outside.has(`${x},${y}`)) continue;
          if (!empty(x, y)) continue;
          outside.add(`${x},${y}`);
          queue.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
        }
        const holes: string[] = [];
        for (let y = 0; y < SIZE.h; y++) {
          for (let x = 0; x < SIZE.w; x++) {
            if (empty(x, y) && !outside.has(`${x},${y}`)) holes.push(`${x},${y}`);
          }
        }
        expect(holes).toEqual([]);
      },
    );

    it("puts a door in each narrow corridor where it leaves a room, with rock either side", () => {
      const built = buildTree(
        ground([
          below(-1, {
            shape: "crypt",
            corridor: 1,
            spacing: 5,
            door: "door-closed",
            stairs: [MIDDLE],
          }),
        ]),
      );
      expect(unreached(built, [-1])).toEqual([]);
      const doors: Array<{ x: number; y: number; facing: string }> = [];
      for (let y = 0; y < SIZE.h; y++) {
        for (let x = 0; x < SIZE.w; x++) {
          const top = getStack(built.map, x, y, -1).at(-1);
          if (top?.tileId === "door-closed") doors.push({ x, y, facing: top.direction! });
        }
      }
      expect(doors.length).toBeGreaterThan(1);
      const solid = (x: number, y: number) =>
        tilesById[getStack(built.map, x, y, -1).at(-1)?.tileId ?? ""]?.walkable === false;
      for (const { x, y, facing } of doors) {
        const [dx, dy] = facing === "e" ? [0, 1] : [1, 0];
        expect(solid(x + dx, y + dy) && solid(x - dx, y - dy), `${x},${y}`).toBe(true);
      }
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
              { shape: "crypt", upBy: "ramp", corridor: 1, door: "door-closed" },
            ]),
          ],
          "grass-2",
        ),
      );
      const walked = reach(built, OUTSIDE);
      for (const z of [-1, -2, -3, -4]) {
        const floor = floorCells(built, z);
        expect(floor.length, `level ${z}`).toBeGreaterThan(40);
        expect(floor.filter((c) => !walked.has(`${z}:${c.x},${c.y}`))).toEqual([]);
      }
      expect(walks(built, { ...floorCells(built, -4)[0]!, z: -4 }, OUTSIDE)).toBe(true);
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

describe("a cave under a hill of another ground on top", () => {
  it("lays one ground under its whole floor, not the snow of the hill on top", () => {
    const built = buildTree(
      land(SIZE, [
        node("hill", { levels: 3, terrace: 0, roughness: 0 }, { frame: frame(4, 2, 48, 36) }),
        node(
          "hill",
          {
            levels: 1,
            terrace: 0,
            roughness: 0,
            ground: "snow",
            brink: "snow-brink",
            wall: "hill-wall-frost",
          },
          { frame: frame(14, 8, 28, 24) },
        ),
        node("cave", { mouths: [MOUTH], floor: "ice" }, { frame: frame(6, 4, 44, 32) }),
      ]),
    );
    const grounds = new Set<string>();
    for (let y = 0; y < SIZE.h; y++) {
      for (let x = 0; x < SIZE.w; x++) {
        const stack = getStack(built.map, x, y, 0);
        if (stack.at(-1)?.tileId === "ice") grounds.add(stack[0]!.tileId);
      }
    }
    expect([...grounds], sketch(built)).toHaveLength(1);
    expect(grounds.has("snow")).toBe(false);
  });
});
