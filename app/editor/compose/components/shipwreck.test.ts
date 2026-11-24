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

  describe("with a castaway", () => {
    const awake = (seed: number) =>
      wrecked(seed, { pieces: 20, castaway: "player", fire: "flame" });
    const wetAt = (built: ReturnType<typeof wrecked>, x: number, y: number) =>
      getStack(built.map, x, y, 0).some((p) => p.tileId === "water");

    it.each([1, 2, 3, 4])("wakes them on the sand at the water's edge, seed %i", (seed) => {
      const built = awake(seed);
      const [castaway] = stands(built, "player");
      expect(castaway, sketch(built)).toBeDefined();
      const { x, y } = castaway!;
      expect(getStack(built.map, x, y, 0)[0]?.tileId, sketch(built)).toBe("sand");
      expect(wetAt(built, x, y), sketch(built)).toBe(false);
      const sea = [
        wetAt(built, x, y - 1),
        wetAt(built, x + 1, y),
        wetAt(built, x, y + 1),
        wetAt(built, x - 1, y),
      ];
      expect(sea, sketch(built)).toContain(true);
      expect(x >= BEACH.x && x < BEACH.x + BEACH.w && y >= BEACH.y && y < BEACH.y + BEACH.h).toBe(
        true,
      );
    });

    it.each([1, 2, 3, 4])(
      "lights the fire on dry sand two cells off and leaves a way inland, seed %i",
      (seed) => {
        const built = awake(seed);
        const castaway = stands(built, "player")[0]!;
        const fires = stands(built, "flame");
        expect(fires, sketch(built)).toHaveLength(1);
        const fire = fires[0]!;
        expect(Math.max(Math.abs(fire.x - castaway.x), Math.abs(fire.y - castaway.y))).toBe(2);
        expect(wetAt(built, fire.x, fire.y), sketch(built)).toBe(false);
        const stepOff = [
          { x: castaway.x, y: castaway.y - 1 },
          { x: castaway.x + 1, y: castaway.y },
          { x: castaway.x - 1, y: castaway.y },
          { x: castaway.x, y: castaway.y + 1 },
        ].filter(
          (c) =>
            getStack(built.map, c.x, c.y, 0)
              .map((p) => p.tileId)
              .join() === "sand",
        );
        expect(stepOff.length, sketch(built)).toBeGreaterThan(0);
        expect(walks(built, stepOff[0]!, INLAND), sketch(built)).toBe(true);
      },
    );

    it("is refused when the frame reaches no sea", () => {
      const built = buildTree(
        land(
          { w: 20, h: 14 },
          [node("shipwreck", { castaway: "player" }, { frame: frame(2, 2, 16, 10) })],
          "sand",
        ),
        { problems: "returned" },
      );
      expect(built.problems.map((p) => p.reason)).toEqual([
        "There is no sand beside the sea in this frame for a castaway to wake on. Move the frame onto the shore.",
      ]);
      expect(stands(built, "player")).toEqual([]);
    });
  });
});
