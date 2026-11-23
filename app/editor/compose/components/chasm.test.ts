import { describe, expect, it } from "vitest";
import { getStack } from "../../../lib/mapData";
import { buildTree, frame, land, node, reach, sketch, walks } from "../testTree";

const SIZE = { w: 64, h: 56 };
const OUTSIDE = { x: 4, y: 52 };
const GORGE = frame(18, 12, 28, 24);
const LEVELS = [-1, -2, -3];

function dungeon(chasm: Record<string, unknown> | null, levels = LEVELS.length) {
  return land(
    SIZE,
    [
      node(
        "dungeon",
        {},
        {
          frame: { ...frame(6, 4, 52, 44), z: -1 },
          children: [
            ...(chasm ? [node("chasm", chasm, { frame: GORGE })] : []),
            ...Array.from({ length: levels }, () => node("level", { shape: "caverns" })),
          ],
        },
      ),
    ],
    "grass-2",
  );
}

type Built = ReturnType<typeof buildTree>;

function cellsWhere(built: Built, z: number, test: (ids: string[]) => boolean) {
  const cells: Array<{ x: number; y: number; z: number }> = [];
  for (let y = 0; y < SIZE.h; y++) {
    for (let x = 0; x < SIZE.w; x++) {
      const ids = getStack(built.map, x, y, z).map((p) => p.tileId);
      if (ids.length > 0 && test(ids)) cells.push({ x, y, z });
    }
  }
  return cells;
}

const ledges = (built: Built, z: number) =>
  cellsWhere(
    built,
    z,
    (ids) => ids.length === 1 && (ids[0] === "basalt" || ids[0] === "basalt-brink"),
  );

describe("chasm", () => {
  it("lets somebody at the rim drop ledge by ledge to the bottom level", () => {
    const solid = buildTree(dungeon(null));
    for (const z of LEVELS) expect(ledges(solid, z)).toEqual([]);

    const built = buildTree(dungeon({}));
    const walked = reach(built, OUTSIDE);
    for (const z of LEVELS) {
      const ledge = ledges(built, z);
      expect(ledge.length, `level ${z}`).toBeGreaterThan(20);
      expect(
        ledge.filter((c) => !walked.has(`${z}:${c.x},${c.y}`)),
        sketch(built),
      ).toEqual([]);
    }
  });

  it("brings somebody on the bottom ledge back to the surface through the dungeon", () => {
    const sealed = buildTree(dungeon({ openings: 0 }));
    const stuck = ledges(sealed, -3)[0]!;
    expect(walks(sealed, stuck, OUTSIDE)).toBe(false);

    const built = buildTree(dungeon({}));
    for (const z of LEVELS) {
      expect(walks(built, ledges(built, z)[0]!, OUTSIDE), `level ${z}`).toBe(true);
    }
  });

  it("keeps the lava at the bottom out of reach of anybody keeping their feet dry", () => {
    const built = buildTree(dungeon({ cascades: [{ x: 10, y: 0 }] }));
    expect(cellsWhere(built, -3, (ids) => ids.includes("lava")).length).toBeGreaterThan(10);
    const onLava = [...reach(built, OUTSIDE).values()].filter((c) =>
      getStack(built.map, c.x, c.y, c.z).some((p) => p.tileId === "lava"),
    );
    expect(onLava).toEqual([]);
  });

  it("cuts the ground at the rim to its brink", () => {
    const built = buildTree(dungeon({}));
    const rim = cellsWhere(built, 0, (ids) => ids[0] === "grass-brink");
    expect(rim.length).toBeGreaterThan(30);
    for (const { x, y } of rim) {
      const open = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [-1, -1],
        [1, -1],
        [-1, 1],
      ].some(([dx, dy]) => getStack(built.map, x + dx!, y + dy!, 0).length === 0);
      expect(open, `${x},${y}`).toBe(true);
    }
  });

  it("pours a cascade down a fall onto every level and into the pool", () => {
    const built = buildTree(dungeon({ cascades: [{ x: 10, y: 0 }] }));
    for (const z of LEVELS) {
      const falls = cellsWhere(built, z, (ids) => ids.some((id) => id.startsWith("lavafall")));
      expect(falls.length, `level ${z}`).toBeGreaterThan(0);
      for (const fall of falls) {
        const ids = getStack(built.map, fall.x, fall.y, z).map((p) => p.tileId);
        if (ids[0]?.startsWith("lavafall")) continue;
        expect(ids.slice(0, 2), `${fall.x},${fall.y},${z}`).toEqual(["basalt", "lava"]);
      }
    }
  });

  it("refuses a chasm that closes up before the bottom level", () => {
    const built = buildTree(
      land(SIZE, [
        node(
          "dungeon",
          {},
          {
            frame: { ...frame(6, 4, 52, 44), z: -1 },
            children: [
              node("chasm", { ledge: 4 }, { frame: frame(20, 14, 10, 8) }),
              ...LEVELS.map(() => node("level", {})),
            ],
          },
        ),
      ]),
      { problems: "returned" },
    );
    expect(built.problems.map((p) => p.reason).join()).toMatch(/closes up/);
  });
});
