import { describe, expect, it } from "vitest";
import { listCoords } from "../lib/mapData";
import { buildTree, frame, land, node, tilesById } from "../editor/compose/testTree";
import { checkCaves } from "./caves";

describe("checkCaves", () => {
  it("passes a ramp two cells long between cave levels, judging it from its foot", () => {
    const built = buildTree(
      land(
        { w: 56, h: 44 },
        [
          node(
            "dungeon",
            {},
            {
              frame: { ...frame(6, 4, 44, 32), z: -1 },
              children: [
                node("level", { shape: "caverns" }),
                node("level", { shape: "caverns", upBy: "ramp" }),
              ],
            },
          ),
          node("tile", { tile: "player", at: { x: 28, y: 41 } }),
        ],
        "grass-2",
      ),
    );
    const upperSteps = [-1, -2].flatMap((z) =>
      [...listCoords(built.map, z)].filter(({ stack }) => {
        const ramp = stack.findIndex((p) => p.tileId === "ramp");
        return ramp > 0 && stack[ramp - 1]!.tileId === "half-stone";
      }),
    );
    expect(upperSteps.length).toBeGreaterThan(0);
    const report = checkCaves({ map: built.map, tilesById });
    expect(report.cells).toBeGreaterThan(0);
    expect(report.problems.filter((p) => p.kind.startsWith("ramp"))).toEqual([]);
  });
});
