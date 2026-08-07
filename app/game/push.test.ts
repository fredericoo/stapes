import { describe, expect, it } from "vitest";
import type { PushInteraction } from "../lib/interactions";
import { DEFAULT_PUSH } from "../lib/interactions";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { pushDestination } from "./push";

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

function push(over: Partial<PushInteraction> = {}): PushInteraction {
  return { ...DEFAULT_PUSH, ...over };
}

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

describe("pushDestination climb", () => {
  it("climb none refuses a step up onto a slab", () => {
    let map = grassStrip(2);
    map = place(map, 1, 0, 0, ["grass", "slab"]);
    const check = pushDestination(
      map,
      at(map, 0, 0, 0),
      "e",
      tilesById.crate!,
      push({ climb: "none" }),
      tilesById,
    );
    expect(check.ok).toBe(false);
  });

  it("climb half allows a step up onto a slab", () => {
    let map = grassStrip(2);
    map = place(map, 1, 0, 0, ["grass", "slab"]);
    const check = pushDestination(
      map,
      at(map, 0, 0, 0),
      "e",
      tilesById.crate!,
      push({ climb: "half" }),
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
      pushDestination(
        map,
        from,
        "e",
        tilesById.crate!,
        push({ climb: "half" }),
        tilesById,
      ).ok,
    ).toBe(false);

    const full = pushDestination(
      map,
      from,
      "e",
      tilesById.crate!,
      push({ climb: "full" }),
      tilesById,
    );
    expect(full.ok).toBe(true);
    if (full.ok) expect(full.to).toEqual({ x: 1, y: 0, z: 1 });
  });

  it("climb none still permits a step down", () => {
    let map = emptyMap();
    map = place(map, 0, 0, 0, ["grass", "slab", "crate"]);
    map = place(map, 1, 0, 0, ["grass"]);
    const check = pushDestination(
      map,
      at(map, 0, 0, 0),
      "e",
      tilesById.crate!,
      push({ climb: "none" }),
      tilesById,
    );
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.to).toEqual({ x: 1, y: 0, z: 0 });
  });

  /**
   * Object stands on a wall top (abs 2). East of it, a column offering two
   * rests inside a climb-full band: grass below at abs 0 and a raised slab at
   * abs 3. A statue is used deliberately — with no gravity it can only ever be
   * placed by the surface search, so landing low proves the preference rather
   * than a fall.
   */
  function forkedColumn(objectId: string): MapFile {
    let map = emptyMap();
    map = place(map, 0, 0, 0, ["wall"]);
    map = place(map, 0, 0, 1, [objectId]);
    map = place(map, 1, 0, 0, ["grass"]);
    map = place(map, 1, 0, 1, ["slab"]);
    return map;
  }

  it("takes the way down when the cell ahead offers both up and down", () => {
    const map = forkedColumn("statue");
    const check = pushDestination(
      map,
      at(map, 0, 0, 1),
      "e",
      tilesById.statue!,
      push({ climb: "full" }),
      tilesById,
    );
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.to).toEqual({ x: 1, y: 0, z: 0 });
  });

  it("takes the way up when that is the only rest in the band", () => {
    // Same fork with the low surface removed: the raised slab was reachable
    // all along, it just lost to the descent.
    let map = forkedColumn("statue");
    map = replaceStack(map, 1, 0, 0, []);

    const check = pushDestination(
      map,
      at(map, 0, 0, 1),
      "e",
      tilesById.statue!,
      push({ climb: "full" }),
      tilesById,
    );
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.to).toEqual({ x: 1, y: 0, z: 1 });
  });
});

describe("pushDestination physics", () => {
  it("a gravity object shoved off a ledge settles on the surface below", () => {
    let map = emptyMap();
    // Plateau at z=1, open ground two levels down at z=-1.
    map = place(map, 0, 0, 0, ["wall"]);
    map = place(map, 0, 0, 1, ["crate"]);
    map = place(map, 1, 0, -1, ["grass"]);

    const check = pushDestination(
      map,
      at(map, 0, 0, 1),
      "e",
      tilesById.crate!,
      push({ climb: "none" }),
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

    const check = pushDestination(
      map,
      at(map, 0, 0, 1),
      "e",
      tilesById.statue!,
      push({ climb: "none" }),
      tilesById,
    );
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/gravity/);
  });

  it("refuses a push onto a non-walkable surface", () => {
    let map = grassStrip(2);
    map = place(map, 1, 0, 0, ["tree"]);
    const check = pushDestination(
      map,
      at(map, 0, 0, 0),
      "e",
      tilesById.crate!,
      push({ climb: "full" }),
      tilesById,
    );
    expect(check.ok).toBe(false);
  });

  it("refuses a push with no headroom", () => {
    let map = grassStrip(2, "boulder");
    // Surface one half-level up, with the level above walled in: a full-height
    // object standing there would poke into the wall.
    map = place(map, 1, 0, 0, ["grass", "slab"]);
    map = place(map, 1, 0, 1, ["wall"]);
    const check = pushDestination(
      map,
      at(map, 0, 0, 0),
      "e",
      tilesById.boulder!,
      push({ climb: "full" }),
      tilesById,
    );
    expect(check.ok).toBe(false);
  });

  it("refuses a push off the edge of the world", () => {
    const map = grassStrip(2);
    const check = pushDestination(
      map,
      at(map, 0, 0, 0),
      "w",
      tilesById.crate!,
      push(),
      tilesById,
    );
    expect(check.ok).toBe(false);
  });
});

describe("pushDestination move-on-tiles", () => {
  it("refuses a surface whose tile is not listed", () => {
    let map = grassStrip(2);
    map = place(map, 1, 0, 0, ["sand"]);
    const check = pushDestination(
      map,
      at(map, 0, 0, 0),
      "e",
      tilesById.crate!,
      push({ moveOnTileIds: ["grass"] }),
      tilesById,
    );
    expect(check.ok).toBe(false);
  });

  it("allows a surface whose tile is listed", () => {
    const map = grassStrip(2);
    const check = pushDestination(
      map,
      at(map, 0, 0, 0),
      "e",
      tilesById.crate!,
      push({ moveOnTileIds: ["grass"] }),
      tilesById,
    );
    expect(check.ok).toBe(true);
  });

  it("judges a fall against the tile it lands on, not the one it left", () => {
    let map = emptyMap();
    map = place(map, 0, 0, 0, ["wall"]);
    map = place(map, 0, 0, 1, ["crate"]);
    map = place(map, 1, 0, -1, ["sand"]);

    const check = pushDestination(
      map,
      at(map, 0, 0, 1),
      "e",
      tilesById.crate!,
      push({ climb: "none", moveOnTileIds: ["grass"] }),
      tilesById,
    );
    expect(check.ok).toBe(false);
  });
});
