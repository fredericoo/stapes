import { describe, expect, it } from "vitest";
import {
  absoluteWalkableElevation,
  appendTile,
  chunkifyMap,
  elevationAt,
  footElevation,
  getStack,
  landedPlacement,
  replaceStack,
  serializeMap,
  solidTopOfStack,
  stackHeight,
  surfaceTileAt,
  updatePlacedFoot,
} from "./mapData";
import { stackBlockHeight, stackOcclusion } from "./lighting";
import { fitsFoot, footRange, tilesByIdFromList } from "./validation";
import { canWalk } from "../game/movement";
import { moveColumn } from "../game/mapMutations";
import type { FlatMapFile, MapFile, PlacedTile, TileDef } from "./types";
import {
  HEIGHT_PER_LEVEL,
  coordKey,
  levelKey,
  normalizeTileDef,
} from "./types";

function tile(partial: Partial<TileDef> & Pick<TileDef, "id">): TileDef {
  return normalizeTileDef({
    name: partial.id,
    height: 0,
    attributes: {},
    sprite: {
      frames: [
        {
          sprite: {
            tilesetId: "t",
            rect: { x: 0, y: 0, w: 1, h: 1 },
            base: { x: 0, y: 0 },
          },
          durationMs: 200,
        },
      ],
    },
    ...partial,
  });
}

const floor = tile({ id: "floor", height: 0 });
const half = tile({ id: "half", height: 2 });
const wall = tile({ id: "wall", height: 4 });
const bush = tile({ id: "bush", height: 2, walkable: false });
const window = tile({ id: "window", height: 4, lightPassing: true });
const walker = tile({ id: "walker", height: 3, actor: true });

const tilesById = tilesByIdFromList([
  floor,
  half,
  wall,
  bush,
  window,
  walker,
]);

/** Cells built by hand, never read off `data/map.json` — see CLAUDE.md. */
function mapAt(
  cells: Array<{ x: number; y: number; z?: number; stack: PlacedTile[] }>,
): MapFile {
  const levels: FlatMapFile["levels"] = {};
  for (const cell of cells) {
    const lk = levelKey(cell.z ?? 0);
    (levels[lk] ??= {})[coordKey(cell.x, cell.y)] = cell.stack;
  }
  return chunkifyMap({ version: 1, levels });
}

describe("footElevation", () => {
  it("leaves a placement on whatever the stack raises below it", () => {
    expect(footElevation(2, { tileId: "floor" })).toBe(2);
  });

  it("lifts a placement to its authored foot", () => {
    expect(footElevation(0, { tileId: "floor", foot: 2 })).toBe(2);
  });

  it("never lowers one, however the stack under it grew", () => {
    // The authored foot is stale — something taller was slid in underneath —
    // and the placement rides up rather than sinking into what now holds it.
    expect(footElevation(3, { tileId: "floor", foot: 2 })).toBe(3);
  });
});

describe("a raised foot carries the stack up with it", () => {
  it("counts the gap it leaves as height", () => {
    const stack: PlacedTile[] = [{ tileId: "floor", foot: 2 }];
    expect(stackHeight(stack, tilesById)).toBe(2);
  });

  it("stands whatever is above it on the raised top", () => {
    const stack: PlacedTile[] = [
      { tileId: "floor", foot: 2 },
      { tileId: "half" },
    ];
    expect(elevationAt(stack, 0, tilesById)).toBe(2);
    expect(elevationAt(stack, 1, tilesById)).toBe(2);
    expect(stackHeight(stack, tilesById)).toBe(4);
  });

  it("is the surface a body stands on", () => {
    const map = mapAt([{ x: 0, y: 0, stack: [{ tileId: "floor", foot: 2 }] }]);
    const stack = getStack(map, 0, 0, 0);
    expect(absoluteWalkableElevation(0, stack, tilesById)).toBe(2);
    expect(surfaceTileAt(map, 0, 0, 2, tilesById)?.tileId).toBe("floor");
  });

  it("lets a body climb onto it, and no higher", () => {
    // Half a level up is one ordinary step; the same floor at 3 is not.
    const map = mapAt([
      { x: 0, y: 0, stack: [{ tileId: "floor" }, { tileId: "walker" }] },
      { x: 1, y: 0, stack: [{ tileId: "floor", foot: 2 }] },
    ]);
    expect(
      canWalk(map, { x: 0, y: 0, z: 0, stackIndex: 1 }, "e", walker, tilesById)
        .ok,
    ).toBe(true);

    const tooHigh = replaceStack(map, 1, 0, 0, [{ tileId: "floor", foot: 3 }]);
    expect(
      canWalk(
        tooHigh,
        { x: 0, y: 0, z: 0, stackIndex: 1 },
        "e",
        walker,
        tilesById,
      ).ok,
    ).toBe(false);
  });

  it("owns the plane it makes rather than handing it to what it cleared", () => {
    // The zero-height rule — a flat tile shares the plane of the thing under it
    // — stops at a raised foot: the floor is what you are standing on, not the
    // bush it was lifted over.
    const stack: PlacedTile[] = [
      { tileId: "bush" },
      { tileId: "floor", foot: 3 },
    ];
    expect(solidTopOfStack(stack, tilesById)?.tileId).toBe("floor");
    expect(
      solidTopOfStack([{ tileId: "bush" }, { tileId: "floor" }], tilesById)
        ?.tileId,
    ).toBe("bush");
  });

  it("is solid to light and to a look", () => {
    const raised: PlacedTile[] = [{ tileId: "window", foot: 2 }];
    // The window still passes light; the two units of gap under it do not.
    expect(stackBlockHeight(raised, tilesById)).toBe(2);
    expect(stackOcclusion(raised, tilesById).sealsLevel).toBe(true);
    expect(stackOcclusion([{ tileId: "window" }], tilesById).sealsLevel).toBe(
      false,
    );
  });
});

describe("footRange", () => {
  it("runs from where the placement rests to the top of the level", () => {
    const stack: PlacedTile[] = [{ tileId: "half" }, { tileId: "floor" }];
    expect(footRange(stack, 1, tilesById)).toEqual({
      min: 2,
      max: HEIGHT_PER_LEVEL,
    });
  });

  it("measures the floor with the placement's own foot taken off", () => {
    // Otherwise a placement already lifted would answer with itself, and its
    // foot could only ever be raised further.
    const stack: PlacedTile[] = [{ tileId: "floor", foot: 3 }];
    expect(footRange(stack, 0, tilesById).min).toBe(0);
  });

  it("leaves a full-height tile nowhere to go", () => {
    const stack: PlacedTile[] = [{ tileId: "wall" }];
    const { min, max } = footRange(stack, 0, tilesById);
    expect(max).toBe(min);
  });
});

describe("fitsFoot", () => {
  const stack: PlacedTile[] = [{ tileId: "half" }, { tileId: "half" }];

  it("refuses a foot below what holds the placement up", () => {
    expect(fitsFoot(stack, 1, 1, tilesById).ok).toBe(false);
  });

  it("refuses a foot that would push it out of the level", () => {
    expect(fitsFoot(stack, 1, 3, tilesById).ok).toBe(false);
  });

  it("takes the one elevation left between the two", () => {
    expect(fitsFoot(stack, 1, 2, tilesById).ok).toBe(true);
  });
});

describe("updatePlacedFoot", () => {
  const map = mapAt([{ x: 0, y: 0, stack: [{ tileId: "floor" }] }]);

  it("writes the lift", () => {
    const next = updatePlacedFoot(map, 0, 0, 0, 0, 2, tilesById);
    expect(getStack(next, 0, 0, 0)[0]!.foot).toBe(2);
  });

  it("leaves no field behind for a placement resting on what holds it", () => {
    const lifted = updatePlacedFoot(map, 0, 0, 0, 0, 2, tilesById);
    const dropped = updatePlacedFoot(lifted, 0, 0, 0, 0, null, tilesById);
    expect(getStack(dropped, 0, 0, 0)[0]).not.toHaveProperty("foot");
    expect(serializeMap(dropped)).toBe(serializeMap(map));
  });

  it("stores nothing for a foot that changes nothing", () => {
    expect(updatePlacedFoot(map, 0, 0, 0, 0, 0, tilesById)).toBe(map);
    expect(updatePlacedFoot(map, 0, 0, 0, 0, null, tilesById)).toBe(map);
  });
});

describe("a foot does not travel", () => {
  it("is let go when a placement joins a stack it was not authored into", () => {
    expect(landedPlacement({ tileId: "half", foot: 2 })).toEqual({
      tileId: "half",
    });
    const map = appendTile(mapAt([]), 0, 0, 0, { tileId: "half", foot: 2 });
    expect(getStack(map, 0, 0, 0)[0]).not.toHaveProperty("foot");
  });

  it("is let go by a shove, so nothing arrives hovering", () => {
    const map = mapAt([
      { x: 0, y: 0, stack: [{ tileId: "half", foot: 2 }] },
      { x: 1, y: 0, stack: [{ tileId: "floor" }] },
    ]);
    const next = moveColumn(
      map,
      { x: 0, y: 0, z: 0, stackIndex: 0 },
      1,
      { x: 1, y: 0, z: 0 },
      undefined,
    );
    expect(getStack(next, 1, 0, 0)[1]).not.toHaveProperty("foot");
    expect(stackHeight(getStack(next, 1, 0, 0), tilesById)).toBe(2);
  });

  it("survives a whole cell being stamped somewhere else, which is authoring", () => {
    const map = mapAt([{ x: 0, y: 0, stack: [{ tileId: "floor", foot: 2 }] }]);
    const source = getStack(map, 0, 0, 0).map((p) => ({ ...p }));
    const next = replaceStack(map, 5, 5, 0, source);
    expect(getStack(next, 5, 5, 0)[0]!.foot).toBe(2);
  });
});
