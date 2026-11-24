import { describe, expect, it } from "vitest";
import { getStack } from "../../../lib/mapData";
import type { MapNode } from "../doc";
import { buildTree, frame, node, reach, sketch, stands, walks } from "../testTree";

const PIER = frame(12, 8, 15, 3);
const SHORE = { x: 6, y: 9 };
const PIER_END = { x: 25, y: 9, z: 1 };
const DECK_LEVEL = 1;

const harbour = (props: Record<string, unknown> = {}, after: MapNode[] = []): MapNode =>
  node(
    "sea",
    {},
    {
      frame: frame(0, 0, 40, 20),
      children: [
        node("island", { roughness: 0 }, { frame: frame(0, 2, 18, 16) }),
        node("deck", props, { frame: PIER }),
        ...after,
      ],
    },
  );

const cellsOf = (f: typeof PIER) =>
  Array.from({ length: f.w * f.h }, (_, i) => ({
    x: f.x + (i % f.w),
    y: f.y + Math.floor(i / f.w),
  }));

const deckStack = (built: ReturnType<typeof buildTree>, x: number, y: number) =>
  getStack(built.map, x, y, DECK_LEVEL).map((p) => p.tileId);

describe("deck", () => {
  it("is climbed onto from the shore by its ladder, and not without it", () => {
    const built = buildTree(harbour());
    expect(walks(built, SHORE, PIER_END), sketch(built)).toBe(true);

    const unladdered = buildTree(harbour({}, [node("clear", { remove: ["ladder-up"] })]));
    expect(walks(unladdered, SHORE, PIER_END, { wading: true })).toBe(false);
  });

  it("stands each pole two pieces high under the deck and one on it, with no two side by side", () => {
    const built = buildTree(harbour());
    const below = stands(built, "fence").filter((s) => s.z === 0);
    const above = stands(built, "fence").filter((s) => s.z === DECK_LEVEL);
    const piecesAt = (key: string) => below.filter(({ x, y }) => `${x},${y}` === key).length;
    const keys = above.map(({ x, y }) => `${x},${y}`).sort();
    expect([...new Set(below.map(({ x, y }) => `${x},${y}`))].sort()).toEqual(keys);
    for (const key of keys) expect(piecesAt(key), key).toBe(2);
    expect(above.length).toBeGreaterThanOrEqual(4);
    for (const a of above) {
      const touching = above.filter(
        (b) => b !== a && Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1,
      );
      expect(touching, `${a.x},${a.y}`).toEqual([]);
    }
  });

  it("covers every cell of its frame in whole boards", () => {
    const built = buildTree(harbour());
    for (const { x, y } of cellsOf(PIER)) {
      const stack = deckStack(built, x, y);
      expect(stack[0], `${x},${y}`).toBe("wooden-floor");
      const edge =
        x === PIER.x || x === PIER.x + PIER.w - 1 || y === PIER.y || y === PIER.y + PIER.h - 1;
      expect(stack.includes("wooden-floor-inner"), `${x},${y}`).toBe(edge);
    }
  });

  it.each([1, 2, 3, 4, 5, 6])(
    "keeps every board walkable from the ladder at full decay, seed %i",
    (seed) => {
      const built = buildTree(harbour({ decay: 100 }), { seed });
      const walked = reach(built, SHORE, { wading: true });
      for (const { x, y } of cellsOf(PIER)) {
        const stack = deckStack(built, x, y);
        if (!stack.includes("wooden-floor") || stack.includes("fence")) continue;
        expect(walked.has(`${DECK_LEVEL}:${x},${y}`), `${x},${y}\n${sketch(built)}`).toBe(true);
      }
    },
  );

  it("breaks holes, takes out poles, cuts boards short and grows moss as it decays", () => {
    const count = (decay: number) => {
      let holes = 0;
      let short = 0;
      let moss = 0;
      for (const seed of [1, 2, 3, 4]) {
        const built = buildTree(harbour({ decay }), { seed });
        for (const { x, y } of cellsOf(PIER)) {
          const stack = deckStack(built, x, y);
          if (stack.length === 0) holes++;
          if (stack.includes("moss-top")) moss++;
        }
        const edge = cellsOf(PIER).filter(({ x, y }) => x === PIER.x + PIER.w - 1 || y === PIER.y);
        short += edge.filter(
          ({ x, y }) => !deckStack(built, x, y).includes("wooden-floor-inner"),
        ).length;
      }
      const poles = [1, 2, 3, 4]
        .map((seed) => stands(buildTree(harbour({ decay }), { seed }), "fence").length)
        .reduce((a, b) => a + b, 0);
      return { holes, short, moss, poles };
    };
    const sound = count(0);
    const rotten = count(80);
    expect(sound).toMatchObject({ holes: 0, short: 0, moss: 0 });
    expect(rotten.holes).toBeGreaterThan(0);
    expect(rotten.short).toBeGreaterThan(0);
    expect(rotten.moss).toBeGreaterThan(0);
    expect(rotten.poles).toBeLessThan(sound.poles);
  });

  it("is refused with a ladder outside its frame", () => {
    const built = buildTree(harbour({ ladder: { x: -3, y: 0 } }), { problems: "returned" });
    expect(built.problems.map((p) => p.reason)).toEqual([
      "The ladder is not on the deck. Move it inside the frame.",
    ]);
  });
});
