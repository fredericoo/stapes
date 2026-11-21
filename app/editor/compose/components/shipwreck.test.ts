import { describe, expect, it } from "vitest";
import { getStack } from "../../../lib/mapData";
import {
  buildTree,
  cutFootprints,
  frame,
  isle,
  land,
  node,
  sketch,
  stands,
  walks,
} from "../testTree";

const SIZE = { w: 40, h: 28 };
const BEACH = frame(10, 12, 18, 12);
const WAKES = { x: 18, y: 17 };
const INLAND = { x: 20, y: 9 };
const wrecked = (seed: number, props: Record<string, unknown> = {}) =>
  buildTree(isle(SIZE, [node("shipwreck", props, { frame: BEACH })]), { seed });

describe("shipwreck", () => {
  it.each([1, 2, 3, 4, 5, 6])(
    "leaves whoever wakes in the middle of it a dry way inland, seed %i",
    (seed) => {
      const built = wrecked(seed, { pieces: 20 });
      expect(stands(built, "wreck-hull"), sketch(built)).toHaveLength(1);
      expect(walks(built, WAKES, INLAND), sketch(built)).toBe(true);
    },
  );

  it.each([1, 2, 3])("puts the hull on the beach and the ribs in the shallows, seed %i", (seed) => {
    const built = wrecked(seed);
    const wet = (tileId: string) =>
      stands(built, tileId).map((at) =>
        getStack(built.map, at.x, at.y, at.z).some((p) => p.tileId === "water"),
      );
    expect(wet("wreck-hull"), sketch(built)).toEqual([false]);
    expect(wet("wreck-mast"), sketch(built)).toEqual([false]);
    expect(wet("wreck-ribs"), sketch(built)).toEqual([true]);
    expect(cutFootprints(built), sketch(built)).toEqual([]);
  });

  it("is a wall of timber where it lies: the hull cannot be walked through", () => {
    const built = wrecked(1, { ribs: null, mast: null, pieces: 0 });
    const hull = stands(built, "wreck-hull")[0]!;
    const covered = [0, 1, 2].flatMap((dx) =>
      [0, 1].map((dy) => ({ x: hull.x - dx, y: hull.y - dy })),
    );
    for (const cell of covered) {
      expect(getStack(built.map, cell.x, cell.y, 0).at(-1)?.tileId, sketch(built)).toBe(
        "wreck-hull",
      );
    }
  });

  it("is refused on ground that is not a beach", () => {
    const built = buildTree(
      land({ w: 20, h: 14 }, [node("shipwreck", {}, { frame: frame(2, 2, 16, 10) })]),
      { problems: "returned" },
    );
    expect(built.problems.map((p) => p.reason)).toEqual([
      "There is no room for the broken hull on sand in this frame. Move the frame onto a beach or make it larger.",
    ]);
    expect(stands(built, "wreck-planks")).toEqual([]);
  });
});
