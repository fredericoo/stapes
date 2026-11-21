import { describe, expect, it } from "vitest";
import { buildTree, land, node, sketch, walks } from "../testTree";

const SIZE = { w: 30, h: 12 };
const WEST = { x: 3, y: 6 };
const EAST = { x: 26, y: 6 };
const river = (props: Record<string, unknown> = {}) =>
  node("river", { from: { x: 15, y: 0 }, to: { x: 15, y: 11 }, width: 3, ...props });
const road = () => node("road", { from: WEST, to: EAST });

describe("river", () => {
  it("parts the land for dry feet and is waded across", () => {
    const built = buildTree(land(SIZE, [river()]));
    expect(walks(built, WEST, EAST), sketch(built)).toBe(false);
    expect(walks(built, WEST, EAST, { wading: true }), sketch(built)).toBe(true);
  });

  it("still parts the land when it bends", () => {
    const built = buildTree(land(SIZE, [river({ wander: 100, bendLength: 4, width: 1 })]));
    expect(walks(built, WEST, EAST), sketch(built)).toBe(false);
  });

  it("washes out a road it is drawn after", () => {
    const bridged = buildTree(land(SIZE, [river(), road()]));
    expect(walks(bridged, WEST, EAST), sketch(bridged)).toBe(true);
    const cut = buildTree(land(SIZE, [road(), river()]));
    expect(walks(cut, WEST, EAST), sketch(cut)).toBe(false);
  });
});
