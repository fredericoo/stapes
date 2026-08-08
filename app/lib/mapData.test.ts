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
  chunkKeyFor,
  chunkifyMap,
  emptyMap,
  listChannels,
  updatePlacedChannel,
} from "./mapData";
import type { FlatMapFile, MapFile, PlacedTile, TileDef } from "./types";
import { coordKey, levelKey, normalizeTileDef, physicalHeight } from "./types";
import { fitsAtElevation, fitsTile, tilesByIdFromList } from "./validation";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
// The file on disk is flat; the runtime shape is chunked.
const fixtureMap: MapFile = chunkifyMap(
  JSON.parse(readFileSync(join(root, "data/map.json"), "utf8")) as FlatMapFile,
);

describe("mapData copy-on-write", () => {
  it("keeps untouched levels, chunks and cells by reference", () => {
    const z = 0;
    const levelBefore = fixtureMap.levels[levelKey(z)]!;
    const otherKeys = Object.keys(fixtureMap.levels).filter(
      (k) => k !== levelKey(z),
    );
    const otherLevelRefs = otherKeys.map((k) => fixtureMap.levels[k]);

    const coords = listCoords(fixtureMap, z);
    const target = coords[0]!;
    const chk = chunkKeyFor(target.x, target.y);

    // A cell in some *other* chunk of the same level — the reference that must
    // survive, and the whole reason levels are chunked.
    const elsewhere = coords.find((c) => chunkKeyFor(c.x, c.y) !== chk)!;
    expect(elsewhere).toBeTruthy();
    const otherChunkBefore = levelBefore[chunkKeyFor(elsewhere.x, elsewhere.y)]!;

    const nextStack: PlacedTile[] = [{ tileId: "grass" }];
    const next = replaceStack(fixtureMap, target.x, target.y, z, nextStack);

    expect(next).not.toBe(fixtureMap);
    expect(next.levels).not.toBe(fixtureMap.levels);
    expect(next.levels[levelKey(z)]).not.toBe(levelBefore);
    expect(next.levels[levelKey(z)]![chk]).not.toBe(levelBefore[chk]);
    expect(getStack(next, target.x, target.y, z)).toBe(nextStack);

    // Untouched chunk keeps its identity, so an edit copies one chunk rather
    // than the whole floor.
    expect(
      next.levels[levelKey(z)]![chunkKeyFor(elsewhere.x, elsewhere.y)],
    ).toBe(otherChunkBefore);

    for (let i = 0; i < otherKeys.length; i++) {
      expect(next.levels[otherKeys[i]!]).toBe(otherLevelRefs[i]);
    }
  });

  it("clearing a cell does not clone sibling stacks", () => {
    const coords = listCoords(fixtureMap, 0);
    expect(coords.length).toBeGreaterThan(10);
    const a = coords[0]!;
    const b = coords.find((c) => c.x !== a.x || c.y !== a.y)!;
    const stackB = getStack(fixtureMap, b.x, b.y, 0);

    const next = clearStack(fixtureMap, a.x, a.y, 0);
    expect(getStack(next, a.x, a.y, 0)).toEqual([]);
    expect(getStack(next, b.x, b.y, 0)).toBe(stackB);
  });
});

describe("signal channels", () => {
  it("sets, trims and clears a channel on one placement", () => {
    const map = replaceStack(emptyMap(), 1, 2, 0, [
      { tileId: "grass" },
      { tileId: "door" },
    ]);

    const wired = updatePlacedChannel(map, 1, 2, 0, 1, "  gate-a  ");
    expect(getStack(wired, 1, 2, 0)).toEqual([
      { tileId: "grass" },
      { tileId: "door", channel: "gate-a" },
    ]);

    // Cleared, not left as an empty string — an unwired placement must read
    // the same whether it was never wired or wired and undone.
    const cleared = updatePlacedChannel(wired, 1, 2, 0, 1, "");
    expect(getStack(cleared, 1, 2, 0)).toEqual([
      { tileId: "grass" },
      { tileId: "door" },
    ]);
  });

  it("lists every channel in the map once, sorted", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "torch", channel: "gate-b" },
    ]);
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "plate", channel: "gate-a" },
      { tileId: "door", channel: "gate-b" },
    ]);
    map = replaceStack(map, 2, 0, 4, [{ tileId: "door", channel: "hatch" }]);
    map = replaceStack(map, 3, 0, 0, [{ tileId: "grass" }]);

    expect(listChannels(map)).toEqual(["gate-a", "gate-b", "hatch"]);
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
