import { describe, expect, it } from "vitest";
import { buildTree, frame, isle, land, node, sketch, walks } from "../testTree";

const SIZE = { w: 48, h: 28 };
const WEST = { x: 11, y: 14 };
const EAST_BANK = { x: 20, y: 14 };
const SUMMIT = { x: 32, y: 14 };

describe("a road over a river and up a hill", () => {
  const crossing = (road: Record<string, unknown> | null, river: Record<string, unknown> = {}) =>
    buildTree(
      isle(SIZE, [
        node("river", { from: { x: 16, y: 0 }, to: { x: 16, y: 27 }, width: 3, ...river }),
        node("hill", { levels: 1, roughness: 0 }, { frame: frame(22, 5, 20, 18) }),
        ...(road ? [node("road", { from: WEST, to: SUMMIT, ...road })] : []),
      ]),
    );

  it("starts from an island nobody can cross with dry feet or climb", () => {
    const built = crossing(null);
    expect(walks(built, WEST, EAST_BANK), sketch(built)).toBe(false);
    expect(walks(built, EAST_BANK, SUMMIT), sketch(built)).toBe(false);
  });

  it.each([
    ["paved", { tile: "cobblestone" }],
    ["with no tile", { tile: null }],
  ])("is walked both ways over its bridge and ramp, %s", (_, road) => {
    const built = crossing(road);
    expect(walks(built, WEST, SUMMIT), sketch(built)).toBe(true);
    expect(walks(built, SUMMIT, WEST), sketch(built)).toBe(true);
  });

  it("stops at the bank of a river that is not bridged", () => {
    const built = crossing({ tile: "cobblestone" }, { bridged: false });
    expect(walks(built, WEST, EAST_BANK), sketch(built)).toBe(false);
    expect(walks(built, EAST_BANK, SUMMIT), sketch(built)).toBe(true);
  });
});

describe("a road over what no layer declared a crossing for", () => {
  const FIELD = { w: 30, h: 12 };
  const LEFT = { x: 3, y: 6 };
  const RIGHT = { x: 26, y: 6 };
  const across = (barrier: ReturnType<typeof node>, road: boolean) =>
    buildTree(land(FIELD, [barrier, ...(road ? [node("road", { from: LEFT, to: RIGHT })] : [])]));

  it.each([
    [
      "bridges a lake laid with a fill",
      () => node("fill", { tiles: ["water"], edge: [] }, { frame: frame(12, 0, 5, 12) }),
    ],
    [
      "fells the trees in its way",
      () =>
        node("fill", { tiles: ["tree"], edge: [], mode: "on top" }, { frame: frame(12, 0, 5, 12) }),
    ],
  ])("%s", (_, barrier) => {
    const blocked = across(barrier(), false);
    expect(walks(blocked, LEFT, RIGHT), sketch(blocked)).toBe(false);
    const built = across(barrier(), true);
    expect(walks(built, LEFT, RIGHT), sketch(built)).toBe(true);
  });
});

describe("a road up stacked hills", () => {
  const FIELD = { w: 60, h: 40 };
  const FOOT = { x: 3, y: 20 };
  const TOP = { x: 30, y: 20 };
  const stacked = (road: boolean) =>
    buildTree(
      land(FIELD, [
        node("hill", { levels: 1, roughness: 0 }, { frame: frame(8, 4, 44, 32) }),
        node("hill", { levels: 1, roughness: 0 }, { frame: frame(18, 10, 24, 20) }),
        ...(road ? [node("road", { from: FOOT, to: TOP })] : []),
      ]),
    );

  it("climbs a ramp for each tier, where neither tier is reached without it", () => {
    const bare = stacked(false);
    expect(bare.elevation.get(`${TOP.x},${TOP.y}`)).toBe(2);
    expect(walks(bare, FOOT, TOP), sketch(bare)).toBe(false);
    const built = stacked(true);
    expect(walks(built, FOOT, TOP), sketch(built)).toBe(true);
  });
});
