import { describe, expect, it } from "vitest";
import { getStack } from "../../../lib/mapData";
import type { BuildResult } from "../build";
import type { MapNode } from "../doc";
import { buildTree, frame, land, node, sketch, walks } from "../testTree";

const SIZE = { w: 40, h: 30 };
const SITE = frame(10, 8, 9, 10);
const STREET = { x: 14, y: 22 };
const INDOORS = { x: 14, y: 12 };
const SIDES = ["n", "e", "s", "w"] as const;
const OUTWARDS = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] } as const;
const isDeck = (p: { tileId: string }) => p.tileId === "wooden-floor";

const house = (children: MapNode[], site = SITE) => node("house", {}, { frame: site, children });

const withPorch = (porch: Record<string, unknown>, floor: Record<string, unknown> = {}) =>
  house([node("floor", { use: "empty", ...floor }), node("roof"), node("porch", porch)]);

function cellsHolding(built: BuildResult, tileId: string): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < SIZE.h; y++) {
    for (let x = 0; x < SIZE.w; x++) {
      if (getStack(built.map, x, y, 0).some((p) => p.tileId === tileId)) out.push({ x, y });
    }
  }
  return out;
}

describe("a porch on a house", () => {
  it("leaves a house with no door shut, which is what the walks below are checking", () => {
    const built = buildTree(land(SIZE, [house([node("floor", { use: "empty" }), node("roof")])]));
    expect(walks(built, STREET, INDOORS), sketch(built)).toBe(false);
  });

  it.each(SIDES)("opens a door onto itself on the %s side, walked from the street", (side) => {
    const built = buildTree(land(SIZE, [withPorch({ side })]));
    expect(walks(built, STREET, INDOORS), sketch(built)).toBe(true);
  });

  it.each(SIDES)("is railed along its outer edge on the %s side but for one gap", (side) => {
    const built = buildTree(land(SIZE, [withPorch({ side, use: "smithy" })]));
    const [dx, dy] = OUTWARDS[side];
    const top = (x: number, y: number) => getStack(built.map, x, y, 0).at(-1)?.tileId;
    const edge = cellsHolding(built, "wooden-floor").filter(
      (cell) => !getStack(built.map, cell.x + dx, cell.y + dy, 0).some(isDeck),
    );
    const open = edge.filter((cell) => top(cell.x, cell.y) === "wooden-floor");
    expect([edge.length, open.length], sketch(built)).toEqual([
      side === "n" || side === "s" ? 9 : 10,
      1,
    ]);
  });

  it.each(SIDES)(
    "stands a forge and an anvil on a smithy porch on the %s side and keeps the door reachable",
    (side) => {
      const built = buildTree(land(SIZE, [withPorch({ side, use: "smithy" })]));
      const forge = cellsHolding(built, "stone-forge");
      const anvil = cellsHolding(built, "anvil");
      expect([forge.length, anvil.length], sketch(built)).toEqual([1, 1]);
      expect(walks(built, STREET, INDOORS), sketch(built)).toBe(true);
    },
  );

  it("stands training dummies on a drill porch without closing the way in", () => {
    const built = buildTree(land(SIZE, [withPorch({ side: "s", use: "drill", depth: 4 })]));
    expect(cellsHolding(built, "training-dummy").length, sketch(built)).toBeGreaterThan(0);
    expect(walks(built, STREET, INDOORS), sketch(built)).toBe(true);
  });

  it("uses the door a floor already has on its side instead of cutting another", () => {
    const door = { x: 1, y: 0, pinX: "left", pinY: "bottom" };
    const built = buildTree(land(SIZE, [withPorch({ side: "s" }, { doors: [door] })]));
    expect(cellsHolding(built, "door-closed"), sketch(built)).toEqual([{ x: 11, y: 14 }]);
    expect(walks(built, STREET, INDOORS), sketch(built)).toBe(true);
  });

  it("takes a porch on every side at once", () => {
    const built = buildTree(
      land(SIZE, [
        house(
          [
            node("floor", { use: "smithy" }),
            node("floor", { use: "barracks" }),
            node("roof"),
            ...SIDES.map((side) => node("porch", { side, depth: 2, use: "seating" })),
          ],
          frame(8, 6, 13, 13),
        ),
      ]),
    );
    expect(cellsHolding(built, "door-closed"), sketch(built)).toHaveLength(4);
    expect(walks(built, STREET, { x: 14, y: 12 }), sketch(built)).toBe(true);
  });

  it("refuses two porches on one side", () => {
    const built = buildTree(
      land(SIZE, [
        house([node("floor"), node("porch", { side: "e" }), node("porch", { side: "e" })]),
      ]),
      { problems: "returned" },
    );
    expect(built.problems.map((p) => p.reason)).toEqual([
      "porch-2 is on a side that already has a porch. Move it to another side or remove it.",
    ]);
  });

  it("refuses porches that leave no room for the house", () => {
    const built = buildTree(
      land(SIZE, [house([node("floor"), node("porch", { side: "s", depth: 8 })])]),
      { problems: "returned" },
    );
    expect(built.problems.map((p) => p.reason)).toEqual([
      "The porches leave the house less than 3×3 cells. Make the house larger or the porches shallower.",
    ]);
  });
});
