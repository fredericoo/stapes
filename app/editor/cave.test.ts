import { describe, expect, it } from "vitest";
import tilesRaw from "../../data/tiles.json";
import { emptyMap, getStack, setStacks } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL, normalizeTiles, physicalHeight } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import {
  MIN_CAVE_FOOTPRINT,
  carveCave,
  erodeWithWater,
  planCave,
  type CaveConfig,
  type CaveShape,
} from "./cave";
import {
  MAX_FOOTPRINT,
  countOpen,
  isOpen,
  regionsOf,
  type CellGrid,
  type Rect,
} from "./generator";

const tiles: TileDef[] = normalizeTiles(tilesRaw as unknown[]);
const tilesById = tilesByIdFromList(tiles);

const BASE: CaveConfig = {
  generator: "cave",
  seed: 4242,
  shape: "caverns",
  density: 50,
  wallTileId: "half-stone",
  ledgeTileId: null,
  ledgeChance: 0,
  floorTileId: "dirt",
  accentFloorTileId: null,
  accentCoverage: 0,
  waterTileId: null,
  waterCoverage: 0,
  scatter: [],
};

const SHAPES: CaveShape[] = ["caverns", "veins", "tunnels"];

/** A rectangle big enough to carve something with a shape to it. */
const RECT: Rect = { x0: -4, y0: 6, x1: 25, y1: 33 };

function build(rect: Rect, config: Partial<CaveConfig> = {}, z = 0): MapFile {
  const plan = planCave(emptyMap(), tilesById, rect, z, { ...BASE, ...config });
  if (!plan.ok) throw new Error(plan.reason);
  return setStacks(emptyMap(), plan.edits);
}

function ids(map: MapFile, x: number, y: number, z = 0): string[] {
  return getStack(map, x, y, z).map((p) => p.tileId);
}

function eachCell(rect: Rect, visit: (x: number, y: number) => void): void {
  for (let y = Math.min(rect.y0, rect.y1); y <= Math.max(rect.y0, rect.y1); y++) {
    for (let x = Math.min(rect.x0, rect.x1); x <= Math.max(rect.x0, rect.x1); x++) {
      visit(x, y);
    }
  }
}

/** Whether every open cell of `g` is part of some fully open 2x2 square. */
function everyPassageTwoWide(g: CellGrid): boolean {
  for (let y = g.minY; y < g.minY + g.height; y++) {
    for (let x = g.minX; x < g.minX + g.width; x++) {
      if (!isOpen(g, x, y)) continue;
      const inSquare = [
        [0, 0],
        [-1, 0],
        [0, -1],
        [-1, -1],
      ].some(
        ([ox, oy]) =>
          isOpen(g, x + ox!, y + oy!) &&
          isOpen(g, x + ox! + 1, y + oy!) &&
          isOpen(g, x + ox!, y + oy! + 1) &&
          isOpen(g, x + ox! + 1, y + oy! + 1),
      );
      if (!inSquare) return false;
    }
  }
  return true;
}

describe("carveCave", () => {
  it("never leaves a passage one cell wide, whatever it is asked for", () => {
    // A one-cell passage is one the camera hides behind the wall in front of
    // it. Every shape, every density, every seed.
    for (const shape of SHAPES) {
      for (const density of [0, 35, 70, 100]) {
        for (let seed = 0; seed < 6; seed++) {
          const grid = carveCave(
            { minX: 0, maxX: 23, minY: 0, maxY: 19 },
            { ...BASE, shape, density, seed },
          );
          expect(everyPassageTwoWide(grid)).toBe(true);
        }
      }
    }
  });

  it("leaves one cave rather than several", () => {
    for (const shape of SHAPES) {
      for (let seed = 0; seed < 8; seed++) {
        const grid = carveCave(
          { minX: 0, maxX: 27, minY: 0, maxY: 27 },
          { ...BASE, shape, seed },
        );
        expect(regionsOf(grid)).toHaveLength(1);
      }
    }
  });

  it("carves more of the rock the lower the density", () => {
    const box = { minX: 0, maxX: 31, minY: 0, maxY: 31 };
    for (const shape of SHAPES) {
      const open = countOpen(carveCave(box, { ...BASE, shape, density: 10 }));
      const solid = countOpen(carveCave(box, { ...BASE, shape, density: 90 }));
      expect(open).toBeGreaterThan(solid);
    }
  });

  it("keeps the outermost ring solid, so the block-out is closed", () => {
    for (const shape of SHAPES) {
      const grid = carveCave({ minX: 0, maxX: 19, minY: 0, maxY: 19 }, { ...BASE, shape });
      for (let i = 0; i < 20; i++) {
        expect(isOpen(grid, i, 0)).toBe(false);
        expect(isOpen(grid, i, 19)).toBe(false);
        expect(isOpen(grid, 0, i)).toBe(false);
        expect(isOpen(grid, 19, i)).toBe(false);
      }
    }
  });
});

describe("planCave", () => {
  it("refuses a rectangle too small to hold a cave", () => {
    const small = MIN_CAVE_FOOTPRINT - 1;
    const plan = planCave(
      emptyMap(),
      tilesById,
      { x0: 0, y0: 0, x1: small - 1, y1: 20 },
      0,
      BASE,
    );
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.reason).toContain(`${MIN_CAVE_FOOTPRINT}`);
  });

  it("refuses an accidental drag across the world", () => {
    const plan = planCave(
      emptyMap(),
      tilesById,
      { x0: 0, y0: 0, x1: MAX_FOOTPRINT, y1: 10 },
      0,
      BASE,
    );
    expect(!plan.ok && plan.reason).toContain("at most");
  });

  it("writes every cell of the rectangle and nothing outside it", () => {
    const plan = planCave(emptyMap(), tilesById, RECT, 0, BASE);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const width = Math.abs(RECT.x1 - RECT.x0) + 1;
    const depth = Math.abs(RECT.y1 - RECT.y0) + 1;
    expect(plan.edits).toHaveLength(width * depth);
    for (const edit of plan.edits) {
      expect(edit.x).toBeGreaterThanOrEqual(RECT.x0);
      expect(edit.x).toBeLessThanOrEqual(RECT.x1);
      expect(edit.z).toBe(0);
    }
  });

  it("fills a level exactly with rock, on a floor, however the rock is made", () => {
    // The floor goes under the rock as well as under the cave, so carving a
    // wall away by hand later leaves ground rather than a hole.
    const halves = build(RECT, { wallTileId: "half-stone" });
    expect(ids(halves, RECT.x0, RECT.y0)).toEqual([
      "dirt",
      "half-stone",
      "half-stone",
    ]);
    const whole = build(RECT, { wallTileId: "stone-wall" });
    expect(ids(whole, RECT.x0, RECT.y0)).toEqual(["dirt", "stone-wall"]);
  });

  it("refuses a rock tile that cannot fill a level", () => {
    const plan = planCave(emptyMap(), tilesById, RECT, 0, {
      ...BASE,
      wallTileId: "barrel",
    });
    expect(!plan.ok && plan.reason).toContain("does not divide");
  });

  it("lays the floor under everything you can stand on", () => {
    const map = build(RECT, { floorTileId: "cobblestone" });
    const grid = carveCave(
      { minX: RECT.x0, maxX: RECT.x1, minY: RECT.y0, maxY: RECT.y1 },
      BASE,
    );
    let floors = 0;
    eachCell(RECT, (x, y) => {
      if (!isOpen(grid, x, y)) return;
      expect(ids(map, x, y)[0]).toBe("cobblestone");
      floors++;
    });
    expect(floors).toBeGreaterThan(0);
  });

  it("takes the low wall only where rock meets floor, and never on the ring", () => {
    const map = build(RECT, { ledgeTileId: "half-stone", ledgeChance: 100 });
    const grid = carveCave(
      { minX: RECT.x0, maxX: RECT.x1, minY: RECT.y0, maxY: RECT.y1 },
      BASE,
    );
    let ledges = 0;
    eachCell(RECT, (x, y) => {
      if (isOpen(grid, x, y)) return;
      const stack = ids(map, x, y);
      const touchesFloor = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].some(([dx, dy]) => isOpen(grid, x + dx!, y + dy!));
      const onRing =
        x === RECT.x0 || x === RECT.x1 || y === RECT.y0 || y === RECT.y1;
      expect(stack[0]).toBe("dirt");
      if (touchesFloor && !onRing) {
        expect(stack).toEqual(["dirt", "half-stone"]);
        ledges++;
      } else {
        expect(stack).toEqual(["dirt", "half-stone", "half-stone"]);
      }
    });
    expect(ledges).toBeGreaterThan(0);
  });

  it("puts a ledge at half the height of the rock beside it", () => {
    const map = build(RECT, { ledgeTileId: "half-stone", ledgeChance: 100 });
    const ledge = physicalHeight(tilesById["half-stone"]!);
    expect(ledge * 2).toBe(HEIGHT_PER_LEVEL);
    // The ring is never a ledge, so this corner is full-height rock on a floor.
    expect(ids(map, RECT.x0, RECT.y0)).toHaveLength(3);
  });

  it("refuses a floor too tall to leave room for rock over it", () => {
    const plan = planCave(emptyMap(), tilesById, RECT, 0, {
      ...BASE,
      floorTileId: "stone-wall",
    });
    expect(!plan.ok && plan.reason).toContain("no room for rock");
  });

  it("leaves the floor walkable once the water is in it", () => {
    for (const coverage of [10, 30, 70]) {
      const config = { ...BASE, waterTileId: "water", waterCoverage: coverage };
      const map = build(RECT, config);
      const bounds = {
        minX: RECT.x0,
        maxX: RECT.x1,
        minY: RECT.y0,
        maxY: RECT.y1,
      };
      const grid = carveCave(bounds, config);
      erodeWithWater(grid, bounds, config);
      const dry = new Uint8Array(grid.cells);
      eachCell(RECT, (x, y) => {
        if (!isOpen(grid, x, y)) return;
        if (ids(map, x, y).includes("water")) {
          dry[(y - grid.minY) * grid.width + (x - grid.minX)] = 0;
        }
      });
      expect(regionsOf(grid, dry)).toHaveLength(1);
      expect(everyPassageTwoWide(grid)).toBe(true);
    }
  });

  it("cuts the water's channel through the rock", () => {
    const config = { ...BASE, waterTileId: "water", waterCoverage: 30 };
    const bounds = { minX: RECT.x0, maxX: RECT.x1, minY: RECT.y0, maxY: RECT.y1 };
    const dryCave = carveCave(bounds, config);
    const wetCave = carveCave(bounds, config);
    erodeWithWater(wetCave, bounds, config);
    // The rectangle the map ends up with has floor where the dry carve left
    // rock: the streams took it out on their way through.
    const map = build(RECT, config);
    let eroded = 0;
    eachCell(RECT, (x, y) => {
      if (isOpen(dryCave, x, y) || !isOpen(wetCave, x, y)) return;
      expect(ids(map, x, y)).toContain("water");
      eroded++;
    });
    expect(eroded).toBeGreaterThan(0);
  });

  it("puts water on top of the floor rather than instead of it", () => {
    const map = build(RECT, { waterTileId: "water", waterCoverage: 40 });
    let wet = 0;
    eachCell(RECT, (x, y) => {
      const stack = ids(map, x, y);
      if (!stack.includes("water")) return;
      expect(stack).toEqual(["dirt", "water"]);
      wet++;
    });
    expect(wet).toBeGreaterThan(0);
  });

  it("scatters props on dry floor only, one to a cell", () => {
    const map = build(RECT, {
      waterTileId: "water",
      waterCoverage: 25,
      scatter: [
        { tileId: "small-bush", chancePercent: 30 },
        { tileId: "berry", chancePercent: 30 },
      ],
    });
    let props = 0;
    eachCell(RECT, (x, y) => {
      const stack = ids(map, x, y);
      const prop = stack.filter((id) => id === "small-bush" || id === "berry");
      if (prop.length === 0) return;
      expect(prop).toHaveLength(1);
      expect(stack).not.toContain("water");
      props++;
    });
    expect(props).toBeGreaterThan(0);
  });

  it("lays the alternative floor on top of the base one, in patches", () => {
    const map = build(RECT, {
      accentFloorTileId: "cobblestone",
      accentCoverage: 40,
    });
    const grid = carveCave(
      { minX: RECT.x0, maxX: RECT.x1, minY: RECT.y0, maxY: RECT.y1 },
      BASE,
    );
    let bare = 0;
    let covered = 0;
    eachCell(RECT, (x, y) => {
      if (!isOpen(grid, x, y)) return;
      const stack = ids(map, x, y);
      // The base floor is under every one of them: the alternative is a
      // covering laid over the ground, not a hole in it.
      expect(stack[0]).toBe("dirt");
      if (stack.includes("cobblestone")) covered++;
      else bare++;
    });
    expect(covered).toBeGreaterThan(0);
    expect(bare).toBeGreaterThan(0);
  });

  it("carves the same cave from the same seed and a different one from another", () => {
    const one = planCave(emptyMap(), tilesById, RECT, 0, BASE);
    const same = planCave(emptyMap(), tilesById, RECT, 0, BASE);
    const other = planCave(emptyMap(), tilesById, RECT, 0, { ...BASE, seed: 99 });
    expect(one.ok && same.ok && one.edits).toEqual(same.ok && same.edits);
    expect(one.ok && other.ok && one.edits).not.toEqual(other.ok && other.edits);
  });

  it("replaces what is on the level rather than building on top of it", () => {
    const before = setStacks(emptyMap(), [
      { x: 0, y: 10, z: 0, stack: [{ tileId: "grass-2" }, { tileId: "tree" }] },
    ]);
    const plan = planCave(before, tilesById, RECT, 0, BASE);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const after = setStacks(before, plan.edits);
    expect(ids(after, 0, 10)).not.toContain("tree");
  });

  it("refuses to carve through somebody standing in it", () => {
    const occupied = setStacks(emptyMap(), [
      { x: 0, y: 10, z: 0, stack: [{ tileId: "grass-2" }, { tileId: "wolf" }] },
    ]);
    const plan = planCave(occupied, tilesById, RECT, 0, BASE);
    expect(!plan.ok && plan.reason).toContain("standing at 0,10");
  });
});
