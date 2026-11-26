import { describe, expect, it } from "vitest";
import { findStranded } from "../../verify/stranded";
import { buildTree, frame, land, node, sketch, stands, tilesById, type Spot } from "./testTree";
import type { MapNode } from "./doc";

const SIZE = { w: 44, h: 22 };
const TOP: Spot = { x: 10, y: 11 };

/** A hill in the west half, climbed by a ramp on its west side, with `planting` over the low ground east of the middle of it. */
const hillBeside = (planting: MapNode) =>
  land(SIZE, [
    node(
      "hill",
      { levels: 1, terrace: 0, roughness: 0, ramps: [{ x: 0, y: 11 }] },
      { frame: frame(0, 0, 22, 22) },
    ),
    planting,
    node("tile", { tile: "player", at: TOP }),
  ]);

const stranded = (root: MapNode) => {
  const built = buildTree(root);
  return { cells: findStranded(built.map, tilesById, {}).stranded, sketch: sketch(built) };
};

describe("the foot of a cliff", () => {
  it("is left open by a forest, so a player who drops into the wood can walk out", () => {
    const wood = node(
      "forest",
      {
        onlyOn: ["grass"],
        density: 100,
        path: null,
        edge: 0,
        outliers: 0,
        foliage: [],
        bushes: [],
      },
      { frame: frame(11, 0, 33, 22) },
    );
    const { cells, sketch } = stranded(hillBeside(wood));
    expect(cells, sketch).toBe(0);
  });

  it("is left open by a scatter of things in the way, and not by one of things walked over", () => {
    const bushes = node(
      "scatter",
      { tiles: [{ tile: "bush", weight: 1 }], density: 70, clumping: 0, onlyOn: ["grass"] },
      { frame: frame(11, 0, 33, 22) },
    );
    expect(stranded(hillBeside(bushes)).cells).toBe(0);
    const built = buildTree(
      hillBeside(
        node(
          "scatter",
          { tiles: [{ tile: "tuft", weight: 1 }], density: 100, clumping: 0, onlyOn: ["grass"] },
          { frame: frame(11, 0, 33, 22) },
        ),
      ),
    );
    const raised = (x: number, y: number) => (built.elevation.get(`${x},${y}`) ?? 0) > 0;
    const footTufts = stands(built, "tuft").filter(
      ({ x, y, z }) =>
        z === 0 && [-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => raised(x + dx, y + dy))),
    ).length;
    expect(footTufts).toBeGreaterThan(0);
  });
});
