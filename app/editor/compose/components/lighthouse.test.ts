import { describe, expect, it } from "vitest";
import type { MapNode } from "../doc";
import {
  buildTree,
  cutFootprints,
  frame,
  isle,
  land,
  levelsWalked,
  node,
  sketch,
  stands,
  walks,
} from "../testTree";

const SIZE = { w: 40, h: 40 };
const SITE = frame(10, 10, 17, 17);
const OUTSIDE = { x: 18, y: 30 };

const upTo = (top: number, from = 0) => Array.from({ length: top - from + 1 }, (_, i) => from + i);

const tower = (
  tiers: Array<Record<string, unknown>>,
  props: Record<string, unknown> = {},
  site = SITE,
): MapNode =>
  node("lighthouse", props, { frame: site, children: tiers.map((tier) => node("tier", tier)) });

const THREE_TIERS = [{ storeys: 4 }, { storeys: 6, finish: "limewashed" }, { storeys: 4 }];

describe("a lighthouse of tiers", () => {
  it("lets a player outside walk up every storey to the platform and back out", () => {
    const built = buildTree(land(SIZE, [tower(THREE_TIERS)]));
    expect(levelsWalked(built, OUTSIDE), sketch(built)).toEqual(upTo(14));
  });

  it("crowns the platform with one whole roof over the arcade", () => {
    const built = buildTree(land(SIZE, [tower(THREE_TIERS)]));
    expect(stands(built, "lighthouse-roof")).toEqual([
      { x: 19, y: 19, z: 15, tileId: "lighthouse-roof" },
    ]);
    expect(cutFootprints(built)).toEqual([]);
  });

  it("keeps a player on its ground storey once its first flight is taken out, which is what the walk is checking", () => {
    const built = buildTree(
      land(SIZE, [tower(THREE_TIERS), node("clear", { remove: ["stone-stairs", "brick-slab"] })]),
    );
    expect(levelsWalked(built, OUTSIDE), sketch(built)).toEqual([0]);
  });

  it.each(["n", "e", "s", "w"])("is entered and climbed with its door on the %s side", (door) => {
    const built = buildTree(land(SIZE, [tower([{ storeys: 2 }, { storeys: 3 }], { door })]));
    expect(levelsWalked(built, OUTSIDE), sketch(built)).toEqual(upTo(5));
  });

  it("is climbed by ramps when it picks them, and at the narrowest it can be", () => {
    const built = buildTree(
      land(SIZE, [tower([{ storeys: 5 }], { stairs: "ramp" }, frame(14, 14, 9, 9))]),
    );
    expect(levelsWalked(built, OUTSIDE), sketch(built)).toEqual(upTo(5));
  });

  it("stands on a hill and is climbed from the hilltop to its platform and back", () => {
    const built = buildTree(
      land(SIZE, [
        node("hill", { levels: 1, roughness: 0 }, { frame: frame(0, 0, 40, 40) }),
        tower([{ storeys: 2 }, { storeys: 2 }]),
      ]),
    );
    const platform = { x: 18, y: 20, z: 5 };
    expect(walks(built, OUTSIDE, platform), sketch(built)).toBe(true);
    expect(walks(built, platform, OUTSIDE), sketch(built)).toBe(true);
  });

  it("is refused when its tiers would narrow the top past what a flight needs", () => {
    const built = buildTree(land(SIZE, [tower(THREE_TIERS, { setback: 3 })]), {
      problems: "returned",
    });
    expect(built.problems.map((p) => p.reason)).toEqual([
      expect.stringContaining("at least 21×21"),
    ]);
  });

  it("is refused over the shore of an island rather than built in the sea", () => {
    const built = buildTree(isle(SIZE, [tower(THREE_TIERS, {}, frame(0, 10, 17, 17))]), {
      problems: "returned",
    });
    expect(built.problems.map((p) => p.reason)).toEqual([expect.stringContaining("dry ground")]);
  });
});
