import { describe, expect, it } from "vitest";
import { buildTree, frame, land, node, sketch, walks } from "../testTree";

const SIZE = { w: 30, h: 12 };
const WEST = { x: 3, y: 6 };
const EAST = { x: 26, y: 6 };
const hedge = (masks: ReturnType<typeof node>[]) =>
  node(
    "fill",
    { tiles: ["tree"], edge: [], mode: "on top" },
    { frame: frame(12, 0, 5, 12), children: masks },
  );
const gap = (op: string) => node("mask", { shape: "rect", op }, { frame: frame(0, 5, 5, 2) });

describe("mask", () => {
  it("leaves a way through its layer where it subtracts", () => {
    const whole = buildTree(land(SIZE, [hedge([])]));
    expect(walks(whole, WEST, EAST), sketch(whole)).toBe(false);
    const cut = buildTree(land(SIZE, [hedge([gap("subtract")])]));
    expect(walks(cut, WEST, EAST), sketch(cut)).toBe(true);
  });

  it("keeps its layer to what it covers where it intersects, so the way round is open", () => {
    const kept = buildTree(land(SIZE, [hedge([gap("intersect")])]));
    expect(walks(kept, WEST, EAST), sketch(kept)).toBe(true);
    expect(walks(kept, WEST, { x: 11, y: 5 }), sketch(kept)).toBe(true);
    expect(() => walks(kept, WEST, { x: 14, y: 5 })).toThrow("Nobody can stand at 14,5");
  });
});
