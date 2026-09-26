import { describe, expect, it } from "vitest";
import type { SlideSnapshot } from "../game/GameSession";
import { emptyMap, replaceStack } from "../lib/mapData";
import { HEIGHT_PER_LEVEL, type MapFile } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { slideTileMotions } from "./slideMotion";
import { tile } from "../lib/testTile";

const tilesById = tilesByIdFromList([
  tile({ id: "grass" }),
  tile({ id: "slab", height: 2 }),
  tile({ id: "crate", height: 2 }),
]);

function shoved(landingStack: string[] = ["grass"]): {
  map: MapFile;
  slide: SlideSnapshot;
} {
  let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
  map = replaceStack(
    map,
    1,
    0,
    0,
    [...landingStack, "crate", "crate"].map((tileId) => ({ tileId })),
  );
  return {
    map,
    slide: {
      object: { x: 1, y: 0, z: 0, stackIndex: landingStack.length },
      from: { x: 0, y: 0, z: 0 },
      count: 2,
    },
  };
}

describe("slideTileMotions", () => {
  it("names one tile per travelling slot", () => {
    const { map, slide } = shoved();
    const motions = slideTileMotions(map, tilesById, slide, 0.5);

    expect(motions.map((m) => m.stackIndex)).toEqual([1, 2]);
    for (const motion of motions) {
      expect({ x: motion.x, y: motion.y, z: motion.z }).toEqual({
        x: 1,
        y: 0,
        z: 0,
      });
    }
  });

  it("keeps the rider exactly one crate above the crate under it", () => {
    const { map, slide } = shoved();
    for (const t of [0, 0.25, 0.5, 1]) {
      const [base, rider] = slideTileMotions(map, tilesById, slide, t);
      expect(rider!.box.foot - base!.box.foot).toBe(2);
      expect(rider!.ox).toBe(base!.ox);
      expect(rider!.oy).toBe(base!.oy);
    }
  });

  it("leaves the feet where they land when the shove is flat", () => {
    const { map, slide } = shoved();
    const [base] = slideTileMotions(map, tilesById, slide, 0);

    expect(base!.box.foot).toBe(0);
  });

  it("starts a step up from the surface it left", () => {
    const { map, slide } = shoved(["grass", "slab"]);

    const atStart = slideTileMotions(map, tilesById, slide, 0);
    expect(atStart.map((m) => m.box.foot)).toEqual([0, 2]);

    const atEnd = slideTileMotions(map, tilesById, slide, 1);
    expect(atEnd.map((m) => m.box.foot)).toEqual([2, 4]);
  });

  it("has caught up by the time it is over", () => {
    const { map, slide } = shoved();
    const motions = slideTileMotions(map, tilesById, slide, 1);

    for (const motion of motions) {
      expect(motion.ox).toBe(0);
      expect(motion.oy).toBe(0);
      expect(motion.box.x).toBe(1);
      expect(motion.box.y).toBe(0);
    }
  });

  it("draws a single shoved tile the same way it always did", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "crate" }]);
    const motions = slideTileMotions(
      map,
      tilesById,
      {
        object: { x: 1, y: 0, z: 0, stackIndex: 1 },
        from: { x: 0, y: 0, z: 0 },
        count: 1,
      },
      0.5,
    );

    expect(motions).toHaveLength(1);
    expect(motions[0]!.box.foot).toBe(0);
    expect(motions[0]!.box.top).toBe(2);
  });

  it("goes on drawing at the level it left when the shove climbs", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "slab" },
      { tileId: "slab" },
    ]);
    map = replaceStack(map, 1, 0, 1, [{ tileId: "grass" }, { tileId: "crate" }]);
    const motions = slideTileMotions(
      map,
      tilesById,
      {
        object: { x: 1, y: 0, z: 1, stackIndex: 1 },
        from: { x: 0, y: 0, z: 0 },
        count: 1,
      },
      0,
    );

    expect(motions[0]!.alsoDrawAtZ).toBe(0);
    expect(motions[0]!.box.foot).toBe(HEIGHT_PER_LEVEL);
  });
});
