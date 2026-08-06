import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  clearStack,
  getStack,
  listCoords,
  replaceStack,
  solidTopOfStack,
  stackHeight,
  surfaceTileAt,
} from "./mapData";
import type { MapFile, PlacedTile, TileDef } from "./types";
import { coordKey, levelKey, normalizeTileDef, physicalHeight } from "./types";
import { fitsAtElevation, fitsTile, tilesByIdFromList } from "./validation";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureMap = JSON.parse(
  readFileSync(join(root, "data/map.json"), "utf8"),
) as MapFile;

describe("mapData copy-on-write", () => {
  it("keeps untouched levels and cells by reference", () => {
    const z = 0;
    const levelBefore = fixtureMap.levels[levelKey(z)]!;
    const otherKeys = Object.keys(fixtureMap.levels).filter(
      (k) => k !== levelKey(z),
    );
    const otherLevelRefs = otherKeys.map((k) => fixtureMap.levels[k]);

    // Pick a cell that exists and one neighbour key that may or may not.
    const [ck] = Object.keys(levelBefore);
    expect(ck).toBeTruthy();
    const { x, y } = (() => {
      const [xs, ys] = ck!.split(",");
      return { x: Number(xs), y: Number(ys) };
    })();

    const untouchedCk = Object.keys(levelBefore).find((k) => k !== ck)!;
    const untouchedStack = levelBefore[untouchedCk]!;

    const nextStack: PlacedTile[] = [{ tileId: "grass" }];
    const next = replaceStack(fixtureMap, x, y, z, nextStack);

    expect(next).not.toBe(fixtureMap);
    expect(next.levels).not.toBe(fixtureMap.levels);
    expect(next.levels[levelKey(z)]).not.toBe(levelBefore);
    expect(next.levels[levelKey(z)]![ck!]).toBe(nextStack);
    expect(next.levels[levelKey(z)]![untouchedCk]).toBe(untouchedStack);

    for (let i = 0; i < otherKeys.length; i++) {
      expect(next.levels[otherKeys[i]!]).toBe(otherLevelRefs[i]);
    }
  });

  it("clearing a cell does not clone sibling stacks", () => {
    const coords = listCoords(fixtureMap, 0);
    expect(coords.length).toBeGreaterThan(10);
    const a = coords[0]!;
    const b = coords[1]!;
    const stackB = getStack(fixtureMap, b.x, b.y, 0);

    const next = clearStack(fixtureMap, a.x, a.y, 0);
    expect(getStack(next, a.x, a.y, 0)).toEqual([]);
    expect(getStack(next, b.x, b.y, 0)).toBe(stackB);
    expect(next.levels[levelKey(0)]![coordKey(b.x, b.y)]).toBe(stackB);
  });
});

describe("fixture map scale", () => {
  it("has enough quads that a one-mesh-per-quad path would blow budgets", () => {
    let quads = 0;
    for (const z of Object.keys(fixtureMap.levels)) {
      for (const c of listCoords(fixtureMap, Number(z))) {
        quads += c.stack.length;
      }
    }
    // Guard against someone swapping in a tiny demo map and silencing perf tests.
    expect(quads).toBeGreaterThan(500);
  });
});

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

describe("intangible physical height", () => {
  const tilesById = tilesByIdFromList([
    tile({ id: "grass", height: 0 }),
    tile({ id: "wall", height: 2 }),
    tile({ id: "door-open", height: 2, intangible: true, walkable: false }),
    tile({ id: "torch", height: 1, intangible: true }),
  ]);

  it("reads authored height as zero when intangible", () => {
    expect(physicalHeight(tilesById["wall"]!)).toBe(2);
    expect(physicalHeight(tilesById["door-open"]!)).toBe(0);
  });

  it("ignores intangible volume in stackHeight", () => {
    expect(
      stackHeight(
        [{ tileId: "grass" }, { tileId: "door-open" }],
        tilesById,
      ),
    ).toBe(0);
    expect(
      stackHeight([{ tileId: "wall" }, { tileId: "torch" }], tilesById),
    ).toBe(2);
  });

  it("looks through intangible tops for the solid surface", () => {
    expect(
      solidTopOfStack(
        [{ tileId: "grass" }, { tileId: "door-open" }],
        tilesById,
      ),
    ).toEqual({ tileId: "grass" });

    const map = replaceStack(
      { version: 1, levels: {} },
      0,
      0,
      0,
      [{ tileId: "grass" }, { tileId: "door-open" }],
    );
    expect(surfaceTileAt(map, 0, 0, 0, tilesById)).toEqual({
      tileId: "grass",
    });
  });

  it("lets a full-height body stand through an intangible door", () => {
    const map = replaceStack(
      { version: 1, levels: {} },
      1,
      0,
      0,
      [{ tileId: "grass" }, { tileId: "door-open" }],
    );
    const player = tile({ id: "player", height: 2 });
    expect(fitsAtElevation(map, 1, 0, 0, player, tilesById).ok).toBe(true);
    // Same cell with a solid wall still blocks.
    const blocked = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "wall" },
    ]);
    expect(fitsAtElevation(blocked, 1, 0, 0, player, tilesById).ok).toBe(false);
  });

  it("places an intangible full-height tile like a height-0 plate", () => {
    const map = replaceStack(
      { version: 1, levels: {} },
      0,
      0,
      0,
      [{ tileId: "wall" }],
    );
    expect(
      fitsTile(map, 0, 0, 0, tilesById["door-open"]!, tilesById).ok,
    ).toBe(true);
  });
});
