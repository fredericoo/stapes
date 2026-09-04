import { describe, expect, it } from "vitest";
import {
  clearStack,
  flattenMap,
  serializeMap,
  getStack,
  listCoords,
  replaceStack,
  climbFromSourceAt,
  isWalkableSurfaceAt,
  solidTopOfStack,
  stackHeight,
  surfaceTileAt,
  chunkKeyFor,
  emptyMap,
  listChannels,
  updatePlacedChannel,
  updatePlacedDescription,
} from "./mapData";
import { fixtureTown } from "./fixtureTown";
import type { MapFile, PlacedTile, TileDef } from "./types";
import { coordKey, levelKey, normalizeTileDef, physicalHeight } from "./types";
import { fitsAtElevation, fitsTile, tilesByIdFromList } from "./validation";

const fixtureMap: MapFile = fixtureTown();

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

  it("returns the same map when the channel is unchanged", () => {
    const map = replaceStack(emptyMap(), 1, 2, 0, [
      { tileId: "door", channel: "gate-a" },
    ]);

    // Committed on blur, which fires whether or not anything was typed. A new
    // map object here is an undo entry and a geometry diff for nothing.
    expect(updatePlacedChannel(map, 1, 2, 0, 0, "gate-a")).toBe(map);
    expect(updatePlacedChannel(map, 1, 2, 0, 0, "  gate-a  ")).toBe(map);

    const bare = replaceStack(emptyMap(), 1, 2, 0, [{ tileId: "door" }]);
    expect(updatePlacedChannel(bare, 1, 2, 0, 0, "")).toBe(bare);
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

describe("placement descriptions", () => {
  it("sets, trims and clears a description on one placement", () => {
    const map = replaceStack(emptyMap(), 1, 2, 0, [
      { tileId: "grass" },
      { tileId: "sign" },
    ]);

    const written = updatePlacedDescription(map, 1, 2, 0, 1, "  To the mill  ");
    expect(getStack(written, 1, 2, 0)).toEqual([
      { tileId: "grass" },
      { tileId: "sign", description: "To the mill" },
    ]);

    // Absent, not empty: the map is hand-edited and version-controlled, so an
    // abandoned description must leave no line behind.
    const cleared = updatePlacedDescription(written, 1, 2, 0, 1, "");
    expect(getStack(cleared, 1, 2, 0)).toEqual([
      { tileId: "grass" },
      { tileId: "sign" },
    ]);
  });

  it("returns the same map when the description is unchanged", () => {
    const map = replaceStack(emptyMap(), 1, 2, 0, [
      { tileId: "sign", description: "To the mill" },
    ]);

    expect(updatePlacedDescription(map, 1, 2, 0, 0, "To the mill")).toBe(map);
    expect(updatePlacedDescription(map, 1, 2, 0, 0, " To the mill ")).toBe(map);
  });

  it("keeps the description when the tile in the slot is swapped", () => {
    // The whole reason this is a placement field: a described door that opens
    // is still the same door, and the text belongs to the spot.
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "door-closed", description: "Beware of the dog", channel: "a" },
    ]);
    const swapped = getStack(map, 0, 0, 0).map((p) => ({
      ...p,
      tileId: "door-open",
    }));

    expect(swapped[0]).toEqual({
      tileId: "door-open",
      description: "Beware of the dog",
      channel: "a",
    });
  });
});

/**
 * The fixture is sized to stand in for a real world, not to be the smallest
 * map that exercises the code — the lighting bake budget in `app/editor/perf.ts`
 * is a wall-clock number measured against a map of roughly this size, and it
 * passes for the wrong reason on a map that is merely small.
 */
describe("fixture town scale", () => {
  it("has enough quads that a one-mesh-per-quad path would blow budgets", () => {
    let quads = 0;
    for (const z of Object.keys(fixtureMap.levels)) {
      for (const c of listCoords(fixtureMap, Number(z))) {
        quads += c.stack.length;
      }
    }
    // Guard against someone trimming the generator and silencing the perf test.
    expect(quads).toBeGreaterThan(20_000);
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
    tile({ id: "wall", height: 4 }),
    tile({ id: "door-open", height: 4, intangible: true, walkable: false }),
    tile({ id: "torch", height: 2, intangible: true }),
  ]);

  it("reads authored height as zero when intangible", () => {
    expect(physicalHeight(tilesById["wall"]!)).toBe(4);
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
    ).toBe(4);
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
    const player = tile({ id: "player", height: 4 });
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

/**
 * A stack exactly one level tall tops out on the floor plane of the level
 * above, so two stacks claim one elevation. Which of them answers is the
 * difference between a cave roof you can walk on and a hole in the meadow.
 */
describe("the floor plane a full-height stack shares with the level above", () => {
  const tilesById = tilesByIdFromList([
    tile({ id: "dirt", height: 0 }),
    tile({ id: "grass", height: 0 }),
    tile({ id: "half-stone", height: 2 }),
    tile({ id: "crystal", height: 4, walkable: false }),
    tile({
      id: "ramp",
      height: 2,
      climbFrom: { default: { n: false, e: false, s: true, w: false } },
    }),
  ]);

  /** `below` sealed under `above`, with the seam at abs 0. */
  function column(below: string[], above: string[]): MapFile {
    let map = replaceStack(
      emptyMap(),
      0,
      0,
      -1,
      below.map((tileId) => ({ tileId })),
    );
    if (above.length) {
      map = replaceStack(
        map,
        0,
        0,
        0,
        above.map((tileId) => ({ tileId })),
      );
    }
    return map;
  }

  it("answers with the floor above, not the full-height tile under it", () => {
    const map = column(["dirt", "crystal"], ["grass"]);
    expect(surfaceTileAt(map, 0, 0, 0, tilesById)).toEqual({ tileId: "grass" });
    expect(isWalkableSurfaceAt(map, 0, 0, 0, tilesById)).toBe(true);
  });

  it("still lets a full level below be the floor when nothing is above it", () => {
    const map = column(["half-stone", "half-stone"], []);
    expect(surfaceTileAt(map, 0, 0, 0, tilesById)).toEqual({
      tileId: "half-stone",
    });
    expect(isWalkableSurfaceAt(map, 0, 0, 0, tilesById)).toBe(true);
  });

  it("keeps an uncovered full-height non-walkable tile unwalkable", () => {
    const map = column(["dirt", "crystal"], []);
    expect(surfaceTileAt(map, 0, 0, 0, tilesById)).toEqual({
      tileId: "crystal",
    });
    expect(isWalkableSurfaceAt(map, 0, 0, 0, tilesById)).toBe(false);
  });

  it("reads climb-from off the floor above rather than what is sealed under it", () => {
    const covered = column(["dirt", "half-stone", "ramp"], ["grass"]);
    expect(climbFromSourceAt(covered, 0, 0, 0, tilesById)?.def.id).toBe("grass");

    const bare = column(["dirt", "half-stone", "ramp"], []);
    expect(climbFromSourceAt(bare, 0, 0, 0, tilesById)?.def.id).toBe("ramp");
  });
});

/**
 * The file is authored content; ids are not.
 *
 * `itemId` is minted at load and rewritten by play — picking a sword up,
 * looting a chest, dropping a bag — so without stripping, a save after a few
 * minutes in the world would arrive full of identities nobody typed. Everything
 * that keeps them uses `flattenMap` directly.
 */
describe("serializeMap and the ids that do not belong on disk", () => {
  const withItems = replaceStack(emptyMap(), 1, 2, 0, [
    { tileId: "grass" },
    {
      tileId: "chest",
      itemId: "itm_minted",
      description: "the one by the door",
      contents: [
        { id: "itm_inside", tileId: "sword" },
        { id: "itm_other", tileId: "bag", channel: "gate" },
      ],
    },
  ]);

  const saved = JSON.parse(serializeMap(withItems)) as {
    levels: Record<string, Record<string, Array<Record<string, unknown>>>>;
  };
  const placed = saved.levels["0"]!["1,2"]![1]!;

  it("writes no itemId", () => {
    expect(placed.itemId).toBeUndefined();
  });

  it("writes no ids inside a container either", () => {
    const contents = placed.contents as Array<Record<string, unknown>>;
    expect(contents.map((c) => c.id)).toEqual([undefined, undefined]);
  });

  it("keeps everything an author actually wrote", () => {
    expect(placed.tileId).toBe("chest");
    expect(placed.description).toBe("the one by the door");
    const contents = placed.contents as Array<Record<string, unknown>>;
    expect(contents.map((c) => c.tileId)).toEqual(["sword", "bag"]);
    expect(contents[1]!.channel).toBe("gate");
  });

  it("leaves the played map alone, ids and all", () => {
    serializeMap(withItems);
    expect(getStack(withItems, 1, 2, 0)[1]!.itemId).toBe("itm_minted");
  });

  /** The wire and the checkpoint go this way, and a running world needs them. */
  it("keeps them in the flat shape everything else uses", () => {
    const flat = flattenMap(withItems);
    const kept = flat.levels["0"]!["1,2"]![1]!;
    expect(kept.itemId).toBe("itm_minted");
    expect(kept.contents?.[0]?.id).toBe("itm_inside");
  });
});
