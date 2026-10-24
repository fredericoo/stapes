import { describe, expect, it } from "vitest";
import { chunkifyMap } from "./mapData";
import { computeLightingFlood } from "./lightingFlood";
import { SUN_SPAN_STRIDE, sunVisibility } from "./sunSpan";
import type { FlatMapFile, MapFile, TileDef } from "./types";
import { MAP_FILE_VERSION, coordKey, levelKey, normalizeTileDef } from "./types";

function tile(id: string, height: number): TileDef {
  return normalizeTileDef({
    id,
    name: id,
    height,
    directional: false,
    variants: {
      default: [
        {
          sprite: { tilesetId: "t", rect: { x: 0, y: 0, w: 1, h: 1 }, base: { x: 0, y: 0 } },
          durationMs: 200,
        },
      ],
    },
    attributes: {},
  });
}

const tilesById: Record<string, TileDef> = {
  floor: tile("floor", 0),
  wall: tile("wall", 4),
};

type Cell = { x: number; z?: number; tiles: string[] };

function rowMap(cells: Cell[]): MapFile {
  const levels: FlatMapFile["levels"] = {};
  for (const c of cells) {
    const lk = levelKey(c.z ?? 0);
    levels[lk] ??= {};
    levels[lk]![coordKey(c.x, 0)] = c.tiles.map((tileId) => ({ tileId }));
  }
  return chunkifyMap({ version: MAP_FILE_VERSION, levels });
}

function floorsFrom(x0: number, x1: number, z = 0): Cell[] {
  const out: Cell[] = [];
  for (let x = x0; x <= x1; x++) out.push({ x, z, tiles: ["floor"] });
  return out;
}

function spanAt(map: MapFile, x: number, z = 0): [number, number] {
  const level = computeLightingFlood(map, tilesById).levels.get(z)!;
  const i = (0 - level.y0) * level.w + (x - level.x0);
  return [level.sun[i * SUN_SPAN_STRIDE]!, level.sun[i * SUN_SPAN_STRIDE + 1]!];
}

function litAt(span: [number, number], arc: number): boolean {
  return sunVisibility(span[0], span[1], arc) > 0.5;
}

const EARLY = 0.05;
const NOON = 0.5;
const LATE = 0.95;

describe("bakeSunSpans", () => {
  it("lets open ground see the sun from sunrise to sunset", () => {
    const span = spanAt(rowMap(floorsFrom(-20, 20)), 0);
    expect(litAt(span, EARLY)).toBe(true);
    expect(litAt(span, NOON)).toBe(true);
    expect(litAt(span, LATE)).toBe(true);
  });

  it("puts ground west of a wall in its shadow in the morning only", () => {
    const map = rowMap([...floorsFrom(-20, 20), { x: 1, tiles: ["floor", "wall"] }]);
    const span = spanAt(map, 0);
    expect(litAt(span, EARLY)).toBe(false);
    expect(litAt(span, NOON)).toBe(true);
    expect(litAt(span, LATE)).toBe(true);
  });

  it("shortens a shadow as the sun climbs, so it moves across the ground", () => {
    const map = rowMap([...floorsFrom(-20, 20), { x: 4, tiles: ["floor", "wall"] }]);
    const sunlitFrom = [0, 1, 2, 3].map((x) => spanAt(map, x)[0]);
    for (let i = 1; i < sunlitFrom.length; i++) {
      expect(sunlitFrom[i]).toBeGreaterThan(sunlitFrom[i - 1]!);
    }
  });

  describe("under a roof with a hole in it", () => {
    const HOLE_X = 2;
    const roofed = rowMap([
      ...floorsFrom(-40, 40, -1),
      ...floorsFrom(-40, 40).filter((c) => c.x !== HOLE_X),
    ]);

    it("lights the floor straight under the hole around noon", () => {
      const span = spanAt(roofed, HOLE_X, -1);
      expect(litAt(span, NOON)).toBe(true);
      expect(litAt(span, EARLY)).toBe(false);
      expect(litAt(span, LATE)).toBe(false);
    });

    it("lights a spot west of the hole only while the sun is low in the east", () => {
      const span = spanAt(roofed, HOLE_X - 2, -1);
      expect(litAt(span, NOON)).toBe(false);
      const morning = (span[0] + span[1]) / 2 / 255;
      expect(morning).toBeLessThan(NOON);
      expect(litAt(span, morning)).toBe(true);
    });

    it("never lights the floor out of the hole's reach", () => {
      const span = spanAt(roofed, HOLE_X - 14, -1);
      for (const arc of [EARLY, 0.25, NOON, 0.75, LATE]) expect(litAt(span, arc)).toBe(false);
    });
  });

  it("keeps a low sun from running under a sealed roof into the room", () => {
    const sealed = rowMap([...floorsFrom(-40, 40, -1), ...floorsFrom(-40, 40)]);
    const span = spanAt(sealed, 0, -1);
    for (const arc of [0, EARLY, NOON, LATE, 1]) expect(litAt(span, arc)).toBe(false);
  });
});
