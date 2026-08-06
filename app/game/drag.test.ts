import { describe, expect, it } from "vitest";
import type { DragInteraction } from "../lib/interactions";
import { DEFAULT_DRAG } from "../lib/interactions";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { coordKey, normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { canDragStep, reachableDragTargets } from "./drag";

function tile(
  partial: Record<string, unknown> & Pick<TileDef, "id" | "height">,
): TileDef {
  return normalizeTileDef({
    name: partial.id,
    directional: false,
    variants: {
      default: [
        {
          sprite: {
            tilesetId: "basic",
            rect: { x: 0, y: 0, w: 1, h: 1 },
            base: { x: 0, y: 0 },
          },
          durationMs: 200,
        },
      ],
    },
    attributes: {},
    ...partial,
  });
}

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "sand", height: 0 }),
  tile({ id: "slab", height: 1 }),
  tile({ id: "wall", height: 2 }),
  tile({ id: "tree", height: 2, walkable: false }),
  tile({ id: "crate", height: 1, affectedByGravity: true }),
  tile({ id: "boulder", height: 2, affectedByGravity: true }),
  tile({ id: "statue", height: 1 }),
];

const tilesById = tilesByIdFromList(tiles);

function drag(over: Partial<DragInteraction> = {}): DragInteraction {
  return { ...DEFAULT_DRAG, ...over };
}

/** Object sitting on top of the stack at (x,y,z); returns map + its slot. */
function place(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  tileIds: string[],
): MapFile {
  return replaceStack(
    map,
    x,
    y,
    z,
    tileIds.map((tileId) => ({ tileId })),
  );
}

function at(map: MapFile, x: number, y: number, z: number) {
  return { x, y, z, stackIndex: getStack(map, x, y, z).length - 1 };
}

/** Flat grass strip along y=0 from x=0..width-1, with the object on x=0. */
function grassStrip(width: number, objectId = "crate"): MapFile {
  let map = emptyMap();
  for (let x = 0; x < width; x++) {
    map = place(map, x, 0, 0, ["grass"]);
  }
  map = place(map, 0, 0, 0, ["grass", objectId]);
  return map;
}

describe("canDragStep climb", () => {
  it("climb none refuses a step up onto a slab", () => {
    let map = grassStrip(2);
    map = place(map, 1, 0, 0, ["grass", "slab"]);
    const check = canDragStep(
      map,
      at(map, 0, 0, 0),
      "e",
      tilesById.crate!,
      drag({ climb: "none" }),
      tilesById,
    );
    expect(check.ok).toBe(false);
  });

  it("climb half allows a step up onto a slab", () => {
    let map = grassStrip(2);
    map = place(map, 1, 0, 0, ["grass", "slab"]);
    const check = canDragStep(
      map,
      at(map, 0, 0, 0),
      "e",
      tilesById.crate!,
      drag({ climb: "half" }),
      tilesById,
    );
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.to).toEqual({ x: 1, y: 0, z: 0 });
  });

  it("climb half refuses a full-level step up, climb full allows it", () => {
    let map = grassStrip(2);
    map = place(map, 1, 0, 0, ["wall"]);
    const from = at(map, 0, 0, 0);

    expect(
      canDragStep(map, from, "e", tilesById.crate!, drag({ climb: "half" }), tilesById)
        .ok,
    ).toBe(false);

    const full = canDragStep(
      map,
      from,
      "e",
      tilesById.crate!,
      drag({ climb: "full" }),
      tilesById,
    );
    expect(full.ok).toBe(true);
    if (full.ok) expect(full.to).toEqual({ x: 1, y: 0, z: 1 });
  });

  it("climb none still permits a step down", () => {
    let map = emptyMap();
    map = place(map, 0, 0, 0, ["grass", "slab", "crate"]);
    map = place(map, 1, 0, 0, ["grass"]);
    const check = canDragStep(
      map,
      at(map, 0, 0, 0),
      "e",
      tilesById.crate!,
      drag({ climb: "none" }),
      tilesById,
    );
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.to).toEqual({ x: 1, y: 0, z: 0 });
  });
});

describe("canDragStep physics", () => {
  it("a gravity object dragged off a ledge settles on the surface below", () => {
    let map = emptyMap();
    // Plateau at z=1, open ground two levels down at z=-1.
    map = place(map, 0, 0, 0, ["wall"]);
    map = place(map, 0, 0, 1, ["crate"]);
    map = place(map, 1, 0, -1, ["grass"]);

    const check = canDragStep(
      map,
      at(map, 0, 0, 1),
      "e",
      tilesById.crate!,
      drag({ climb: "none" }),
      tilesById,
    );
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.to).toEqual({ x: 1, y: 0, z: -1 });
  });

  it("an object without gravity cannot be pushed into open air", () => {
    let map = emptyMap();
    map = place(map, 0, 0, 0, ["wall"]);
    map = place(map, 0, 0, 1, ["statue"]);
    map = place(map, 1, 0, -1, ["grass"]);

    const check = canDragStep(
      map,
      at(map, 0, 0, 1),
      "e",
      tilesById.statue!,
      drag({ climb: "none" }),
      tilesById,
    );
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/gravity/);
  });

  it("refuses a drag onto a non-walkable surface", () => {
    let map = grassStrip(2);
    map = place(map, 1, 0, 0, ["tree"]);
    const check = canDragStep(
      map,
      at(map, 0, 0, 0),
      "e",
      tilesById.crate!,
      drag({ climb: "full" }),
      tilesById,
    );
    expect(check.ok).toBe(false);
  });

  it("refuses a drag with no headroom", () => {
    let map = grassStrip(2, "boulder");
    // Surface one half-level up, with the level above walled in: a full-height
    // object standing there would poke into the wall.
    map = place(map, 1, 0, 0, ["grass", "slab"]);
    map = place(map, 1, 0, 1, ["wall"]);
    const check = canDragStep(
      map,
      at(map, 0, 0, 0),
      "e",
      tilesById.boulder!,
      drag({ climb: "full" }),
      tilesById,
    );
    expect(check.ok).toBe(false);
  });
});

describe("canDragStep move-on-tiles", () => {
  it("refuses a surface whose tile is not listed", () => {
    let map = grassStrip(2);
    map = place(map, 1, 0, 0, ["sand"]);
    const check = canDragStep(
      map,
      at(map, 0, 0, 0),
      "e",
      tilesById.crate!,
      drag({ moveOnTileIds: ["grass"] }),
      tilesById,
    );
    expect(check.ok).toBe(false);
  });

  it("allows a surface whose tile is listed", () => {
    const map = grassStrip(2);
    const check = canDragStep(
      map,
      at(map, 0, 0, 0),
      "e",
      tilesById.crate!,
      drag({ moveOnTileIds: ["grass"] }),
      tilesById,
    );
    expect(check.ok).toBe(true);
  });

  it("judges a fall against the tile it lands on, not the one it left", () => {
    let map = emptyMap();
    map = place(map, 0, 0, 0, ["wall"]);
    map = place(map, 0, 0, 1, ["crate"]);
    map = place(map, 1, 0, -1, ["sand"]);

    const check = canDragStep(
      map,
      at(map, 0, 0, 1),
      "e",
      tilesById.crate!,
      drag({ climb: "none", moveOnTileIds: ["grass"] }),
      tilesById,
    );
    expect(check.ok).toBe(false);
  });
});

describe("reachableDragTargets", () => {
  it("caps the reachable set at distanceTiles", () => {
    const map = grassStrip(5);
    const targets = reachableDragTargets(
      map,
      at(map, 0, 0, 0),
      tilesById.crate!,
      drag({ distanceTiles: 2 }),
      tilesById,
    );
    expect([...targets.keys()].sort()).toEqual([coordKey(1, 0), coordKey(2, 0)]);
  });

  it("a budget of 1.5 reaches orthogonal and diagonal neighbours, not two steps", () => {
    let map = emptyMap();
    for (let x = 0; x < 3; x++) {
      for (let y = 0; y < 3; y++) {
        map = place(map, x, y, 0, ["grass"]);
      }
    }
    map = place(map, 1, 1, 0, ["grass", "crate"]);

    const targets = reachableDragTargets(
      map,
      at(map, 1, 1, 0),
      tilesById.crate!,
      drag({ distanceTiles: 1.5 }),
      tilesById,
    );
    // Orthogonal (cost 1) and diagonal (cost √2 ≈ 1.41); two orthos (2.0) out.
    expect([...targets.keys()].sort()).toEqual(
      [
        coordKey(0, 0),
        coordKey(0, 1),
        coordKey(0, 2),
        coordKey(1, 0),
        coordKey(1, 2),
        coordKey(2, 0),
        coordKey(2, 1),
        coordKey(2, 2),
      ].sort(),
    );
  });

  it("never includes the object's own cell", () => {
    const map = grassStrip(3);
    const targets = reachableDragTargets(
      map,
      at(map, 0, 0, 0),
      tilesById.crate!,
      drag({ distanceTiles: 3 }),
      tilesById,
    );
    expect(targets.has(coordKey(0, 0))).toBe(false);
  });

  it("is path-constrained: a wall hides the legal cell behind it", () => {
    let map = grassStrip(4);
    map = place(map, 2, 0, 0, ["grass", "wall"]);

    const targets = reachableDragTargets(
      map,
      at(map, 0, 0, 0),
      tilesById.crate!,
      drag({ distanceTiles: 3, climb: "half" }),
      tilesById,
    );
    // (3,0) is plain grass and within 3 steps, but only reachable through the wall.
    expect(targets.has(coordKey(1, 0))).toBe(true);
    expect(targets.has(coordKey(2, 0))).toBe(false);
    expect(targets.has(coordKey(3, 0))).toBe(false);
  });

  it("routes around an obstacle when the grid allows it", () => {
    let map = emptyMap();
    for (let x = 0; x < 3; x++) {
      for (let y = 0; y < 2; y++) {
        map = place(map, x, y, 0, ["grass"]);
      }
    }
    map = place(map, 0, 0, 0, ["grass", "crate"]);
    map = place(map, 1, 0, 0, ["grass", "wall"]);

    // Four steps: south, east, east, north — the wall itself stays unreachable.
    const targets = reachableDragTargets(
      map,
      at(map, 0, 0, 0),
      tilesById.crate!,
      drag({ distanceTiles: 4, climb: "half" }),
      tilesById,
    );
    expect(targets.has(coordKey(1, 0))).toBe(false);
    expect(targets.has(coordKey(2, 0))).toBe(true);
  });

  it("move-on-tiles confines the reachable set to the listed path", () => {
    let map = emptyMap();
    for (let x = 0; x < 4; x++) map = place(map, x, 0, 0, ["grass"]);
    map = place(map, 2, 0, 0, ["sand"]);
    map = place(map, 0, 0, 0, ["grass", "crate"]);

    const targets = reachableDragTargets(
      map,
      at(map, 0, 0, 0),
      tilesById.crate!,
      drag({ distanceTiles: 3, moveOnTileIds: ["grass"] }),
      tilesById,
    );
    expect([...targets.keys()]).toEqual([coordKey(1, 0)]);
  });
});
