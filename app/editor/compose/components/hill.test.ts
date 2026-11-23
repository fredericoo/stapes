import { describe, expect, it } from "vitest";
import { getStack } from "../../../lib/mapData";
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

  it.each([0, 2])(
    "raises a small hole its mask cuts inside it, with a terrace of %i, so the hole is no pit",
    (terrace) => {
      const built = buildTree(
        land(SIZE, [
          node(
            "hill",
            { roughness: 0, levels: 2, terrace },
            {
              frame: frame(8, 4, 24, 20),
              children: [node("mask", { op: "subtract" }, { frame: frame(11, 9, 2, 2) })],
            },
          ),
        ]),
      );
      expect(built.elevation.get(`${TOP.x - 1},${TOP.y - 1}`), sketch(built)).toBe(2);
      expect(walks(built, { x: TOP.x - 1, y: TOP.y - 1 }, FOOT), sketch(built)).toBe(true);
    },
  );

  it("lowers a knob of a few cells that a mask leaves apart from the rest of its top", () => {
    const built = buildTree(
      land(SIZE, [
        node(
          "hill",
          { roughness: 0, levels: 1, terrace: 0 },
          {
            frame: frame(8, 4, 24, 20),
            children: [
              node("mask", { shape: "rect", op: "subtract" }, { frame: frame(9, 0, 3, 20) }),
              node("mask", { shape: "rect", op: "add" }, { frame: frame(10, 3, 1, 2) }),
            ],
          },
        ),
      ]),
    );
    expect(built.elevation.get("18,8") ?? 0, sketch(built)).toBe(0);
    expect(built.elevation.get(`${TOP.x - 6},${TOP.y}`), sketch(built)).toBe(1);
  });

  it("is climbed by the ramp a point of its own puts on the nearest cliff", () => {
    const built = raised({ levels: 1, ramps: [{ x: 0, y: 10 }] });
    expect(walks(built, FOOT, TOP), sketch(built)).toBe(true);
  });

  const onSand = (layers: ReturnType<typeof node>[], props: Record<string, unknown> = {}) =>
    buildTree(
      land(
        SIZE,
        [
          ...layers,
          node(
            "hill",
            { roughness: 0, levels: 2, terrace: 2, ...props },
            { frame: frame(8, 4, 24, 20) },
          ),
        ],
        "sand",
      ),
    );
  type Built = ReturnType<typeof onSand>;
  const levelOf = (built: Built, x: number, y: number) => built.elevation.get(`${x},${y}`) ?? 0;
  /** The stacks on the top of every raised cell beside a drop, and of every raised cell that is not. */
  const tops = (built: Built) => {
    const edges: string[][] = [];
    const inner: string[][] = [];
    for (const [key, level] of built.elevation) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      const drop = [-1, 0, 1].some((dy) =>
        [-1, 0, 1].some((dx) => levelOf(built, x + dx, y + dy) < level),
      );
      (drop ? edges : inner).push(getStack(built.map, x, y, level).map((p) => p.tileId));
    }
    return { edges, inner };
  };

  it("keeps its brinks uncovered when grass was laid on the ground it raised", () => {
    const { edges } = tops(onSand([node("grass")]));
    expect(edges.length).toBeGreaterThan(20);
    for (const stack of edges) expect(stack).toEqual(["grass-brink"]);
  });

  it.each([
    ["sand", "sand-brink"],
    ["snow", "snow-brink"],
    ["basalt", "basalt-brink"],
  ])("cuts a top of %s to that ground's own brink", (ground, brink) => {
    const { edges, inner } = tops(onSand([], { ground }));
    for (const stack of edges) expect(stack).toEqual([brink]);
    for (const stack of inner) expect(stack).toEqual([ground]);
  });

  it("stands its walls on the grass round its foot", () => {
    const built = onSand([node("grass")], { levels: 1 });
    const feet: string[][] = [];
    for (const [key] of built.elevation) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      const beside = [-1, 0, 1].some((dy) =>
        [-1, 0, 1].some((dx) => levelOf(built, x + dx, y + dy) === 0),
      );
      if (beside) feet.push(getStack(built.map, x, y, 0).map((p) => p.tileId));
    }
    expect(feet.length).toBeGreaterThan(20);
    for (const stack of feet) expect(stack).toEqual(["sand", "grass", "hill-wall"]);
  });

  it("stands the walls of every tier on grass laid after it", () => {
    const built = buildTree(
      land(
        SIZE,
        [
          node(
            "hill",
            { roughness: 0, levels: 2, terrace: 2, ground: "sand" },
            { frame: frame(8, 4, 24, 20) },
          ),
          node("grass"),
        ],
        "sand",
      ),
    );
    const feet: string[][] = [];
    for (const [key, top] of built.elevation) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      for (let z = 0; z < top; z++) {
        const column = getStack(built.map, x, y, z).map((p) => p.tileId);
        if (column.length > 1) feet.push(column);
      }
    }
    expect(feet.filter((c) => c[0] === "sand").length).toBeGreaterThan(40);
    for (const column of feet) expect(column).toEqual(["sand", "grass", "hill-wall"]);
  });

  it("takes the brink of grass laid on its top after it", () => {
    const { edges, inner } = tops(onSand([], { ground: "sand" }));
    expect(edges.length).toBeGreaterThan(20);
    const grassed = tops(
      buildTree(
        land(
          SIZE,
          [
            node(
              "hill",
              { roughness: 0, levels: 2, terrace: 2, ground: "sand" },
              { frame: frame(8, 4, 24, 20) },
            ),
            node("grass"),
          ],
          "sand",
        ),
      ),
    );
    expect(grassed.edges).toEqual(edges.map(() => ["grass-brink"]));
    expect(grassed.inner).toEqual(inner.map(() => ["sand", "grass"]));
  });
});

describe("the foot of a rough hill", () => {
  const F = { x: 6, y: 4, w: 30, h: 22 };
  const MARGIN = 3;

  it.each([1, 2, 3, 4, 5])(
    "keeps off the frame's margin instead of running straight along it, seed %i",
    (seed) => {
      const built = buildTree(
        land({ w: 42, h: 30 }, [
          node(
            "hill",
            { levels: 1, terrace: 0, roughness: 100 },
            { frame: frame(F.x, F.y, F.w, F.h) },
          ),
        ]),
        { seed },
      );
      const raisedAt = (x: number, y: number) => (built.elevation.get(`${x},${y}`) ?? 0) > 0;
      const sides = [
        Array.from({ length: F.w }, (_, i) => raisedAt(F.x + i, F.y + MARGIN)),
        Array.from({ length: F.w }, (_, i) => raisedAt(F.x + i, F.y + F.h - 1 - MARGIN)),
        Array.from({ length: F.h }, (_, i) => raisedAt(F.x + MARGIN, F.y + i)),
        Array.from({ length: F.h }, (_, i) => raisedAt(F.x + F.w - 1 - MARGIN, F.y + i)),
      ];
      const longest = Math.max(
        ...sides.map((cells) => {
          let best = 0;
          let run = 0;
          for (const c of cells) {
            run = c ? run + 1 : 0;
            best = Math.max(best, run);
          }
          return best;
        }),
      );
      expect(longest, sketch(built)).toBeLessThanOrEqual(4);
    },
  );
});

describe("the terraces of a hill", () => {
  const AREA = { w: 120, h: 90 };
  const TERRACE = 6;
  /** Without the jag, seeds 1 and 3 leave a straight edge longer than this. */
  const MAX_STRAIGHT = 10;

  it.each([1, 2, 3])("do not run straight along the line below them, seed %i", (seed) => {
    const built = buildTree(
      land(AREA, [
        node(
          "hill",
          { levels: 3, terrace: TERRACE, roughness: 40 },
          { frame: frame(10, 10, 100, 70) },
        ),
      ]),
      { seed },
    );
    const level = (x: number, y: number) => built.elevation.get(`${x},${y}`) ?? 0;
    const upper = (x: number, y: number) => level(x, y) >= 2;
    let longest = 0;
    for (const [along, across, edgeAt] of [
      [AREA.w, AREA.h, (a: number, b: number) => upper(a, b) !== upper(a, b + 1)],
      [AREA.h, AREA.w, (a: number, b: number) => upper(b, a) !== upper(b + 1, a)],
    ] as const) {
      for (let b = 0; b < across - 1; b++) {
        let run = 0;
        for (let a = 0; a < along; a++) {
          run = edgeAt(a, b) ? run + 1 : 0;
          longest = Math.max(longest, run);
        }
      }
    }
    expect(longest, sketch(built)).toBeLessThanOrEqual(MAX_STRAIGHT);
  });
});
