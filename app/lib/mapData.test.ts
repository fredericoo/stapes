import { describe, expect, it } from "vitest";
import {
  changedCellsInChunk,
  changedCellsOnLevel,
  chunkifyMap,
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
  walkableElevInStack,
  chunkKeyFor,
  emptyMap,
  listChannels,
  parseMap,
  updatePlacedChannel,
  updatePlacedContents,
  updatePlacedDescription,
  updatePlacedInscription,
  setStacks,
  stackOnLevel,
  tileIdsInChunk,
  type StackEdit,
} from "./mapData";
import { fixtureTown } from "./fixtureTown";
import type { MapFile, PlacedTile } from "./types";
import {
  CHUNK_SIZE,
  MAP_FILE_VERSION,
  MAX_LEVEL,
  MIN_LEVEL,
  coordKey,
  levelKey,
  physicalHeight,
} from "./types";
import { fitsAtElevation, fitsTile, tilesByIdFromList } from "./validation";
import { tile } from "./testTile";

const fixtureMap: MapFile = fixtureTown();

describe("mapData copy-on-write", () => {
  it("keeps untouched levels, chunks and cells by reference", () => {
    const z = 0;
    const levelBefore = fixtureMap.levels[levelKey(z)]!;
    const otherKeys = Object.keys(fixtureMap.levels).filter((k) => k !== levelKey(z));
    const otherLevelRefs = otherKeys.map((k) => fixtureMap.levels[k]);

    const coords = listCoords(fixtureMap, z);
    const target = coords[0]!;
    const chk = chunkKeyFor(target.x, target.y);

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

    expect(next.levels[levelKey(z)]![chunkKeyFor(elsewhere.x, elsewhere.y)]).toBe(otherChunkBefore);

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
    const map = replaceStack(emptyMap(), 1, 2, 0, [{ tileId: "grass" }, { tileId: "door" }]);

    const wired = updatePlacedChannel(map, 1, 2, 0, 1, "  gate-a  ");
    expect(getStack(wired, 1, 2, 0)).toEqual([
      { tileId: "grass" },
      { tileId: "door", channel: "gate-a" },
    ]);

    const cleared = updatePlacedChannel(wired, 1, 2, 0, 1, "");
    expect(getStack(cleared, 1, 2, 0)).toEqual([{ tileId: "grass" }, { tileId: "door" }]);
  });

  it("returns the same map when the channel is unchanged", () => {
    const map = replaceStack(emptyMap(), 1, 2, 0, [{ tileId: "door", channel: "gate-a" }]);

    expect(updatePlacedChannel(map, 1, 2, 0, 0, "gate-a")).toBe(map);
    expect(updatePlacedChannel(map, 1, 2, 0, 0, "  gate-a  ")).toBe(map);

    const bare = replaceStack(emptyMap(), 1, 2, 0, [{ tileId: "door" }]);
    expect(updatePlacedChannel(bare, 1, 2, 0, 0, "")).toBe(bare);
  });

  it("lists every channel in the map once, sorted", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "torch", channel: "gate-b" }]);
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "plate", channel: "gate-a" },
      { tileId: "door", channel: "gate-b" },
    ]);
    map = replaceStack(map, 2, 0, 4, [{ tileId: "door", channel: "hatch" }]);
    map = replaceStack(map, 3, 0, 0, [{ tileId: "grass" }]);

    expect(listChannels(map)).toEqual(["gate-a", "gate-b", "hatch"]);
  });
});

describe("placement inscriptions", () => {
  it("sets, trims and clears an inscription on one placement", () => {
    const map = replaceStack(emptyMap(), 1, 2, 0, [{ tileId: "grass" }, { tileId: "sign" }]);

    const written = updatePlacedInscription(map, 1, 2, 0, 1, "  To the mill  ");
    expect(getStack(written, 1, 2, 0)).toEqual([
      { tileId: "grass" },
      { tileId: "sign", inscription: "To the mill" },
    ]);

    const cleared = updatePlacedInscription(written, 1, 2, 0, 1, "");
    expect(getStack(cleared, 1, 2, 0)).toEqual([{ tileId: "grass" }, { tileId: "sign" }]);
  });

  it("writes the two halves independently", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "sign" }]);
    map = updatePlacedInscription(map, 0, 0, 0, 0, "Here lies nobody");
    map = updatePlacedDescription(map, 0, 0, 0, 0, "Scratched, and very old");

    expect(getStack(map, 0, 0, 0)).toEqual([
      {
        tileId: "sign",
        inscription: "Here lies nobody",
        description: "Scratched, and very old",
      },
    ]);

    const quiet = updatePlacedInscription(map, 0, 0, 0, 0, "");
    expect(getStack(quiet, 0, 0, 0)).toEqual([
      { tileId: "sign", description: "Scratched, and very old" },
    ]);
  });
});

describe("reading a map written before the split", () => {
  it("lifts a version-1 description into an inscription", () => {
    const file = JSON.stringify({
      version: 1,
      levels: {
        "0": {
          "1,2": [
            { tileId: "sign", description: "The Orchard" },
            {
              tileId: "chest",
              contents: [{ id: "itm_1", tileId: "sign", description: "Inside" }],
            },
          ],
        },
      },
    });

    expect(getStack(parseMap(file), 1, 2, 0)).toEqual([
      { tileId: "sign", inscription: "The Orchard" },
      {
        tileId: "chest",
        contents: [{ id: "itm_1", tileId: "sign", inscription: "Inside" }],
      },
    ]);
  });

  it("leaves a version-2 description where it is", () => {
    const file = JSON.stringify({
      version: MAP_FILE_VERSION,
      levels: { "0": { "0,0": [{ tileId: "skull", description: "Bite by Snake" }] } },
    });

    expect(getStack(parseMap(file), 0, 0, 0)).toEqual([
      { tileId: "skull", description: "Bite by Snake" },
    ]);
  });

  it("refuses a version it has never heard of", () => {
    expect(() => parseMap(JSON.stringify({ version: 99, levels: {} }))).toThrow();
  });
});

describe("placement descriptions", () => {
  it("sets, trims and clears a description on one placement", () => {
    const map = replaceStack(emptyMap(), 1, 2, 0, [{ tileId: "grass" }, { tileId: "sign" }]);

    const written = updatePlacedDescription(map, 1, 2, 0, 1, "  To the mill  ");
    expect(getStack(written, 1, 2, 0)).toEqual([
      { tileId: "grass" },
      { tileId: "sign", description: "To the mill" },
    ]);

    const cleared = updatePlacedDescription(written, 1, 2, 0, 1, "");
    expect(getStack(cleared, 1, 2, 0)).toEqual([{ tileId: "grass" }, { tileId: "sign" }]);
  });

  it("returns the same map when the description is unchanged", () => {
    const map = replaceStack(emptyMap(), 1, 2, 0, [{ tileId: "sign", description: "To the mill" }]);

    expect(updatePlacedDescription(map, 1, 2, 0, 0, "To the mill")).toBe(map);
    expect(updatePlacedDescription(map, 1, 2, 0, 0, " To the mill ")).toBe(map);
  });

  it("keeps the description when the tile in the slot is swapped", () => {
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

describe("container contents", () => {
  const chestAt = (contents?: PlacedTile["contents"]) =>
    replaceStack(emptyMap(), 1, 2, 0, [
      { tileId: "grass" },
      { tileId: "chest", ...(contents ? { contents } : {}) },
    ]);

  it("writes what one placement is holding", () => {
    const written = updatePlacedContents(chestAt(), 1, 2, 0, 1, [
      { id: "itm_a", tileId: "bread", count: 3 },
    ]);

    expect(getStack(written, 1, 2, 0)[1]).toEqual({
      tileId: "chest",
      contents: [{ id: "itm_a", tileId: "bread", count: 3 }],
    });
  });

  it("clears the field rather than writing an empty list", () => {
    const emptied = updatePlacedContents(
      chestAt([{ id: "itm_a", tileId: "bread" }]),
      1,
      2,
      0,
      1,
      [],
    );

    expect(getStack(emptied, 1, 2, 0)[1]).toEqual({ tileId: "chest" });
  });

  it("returns the same map when the contents are unchanged", () => {
    const map = chestAt([{ id: "itm_a", tileId: "bread", count: 2 }]);
    const held = getStack(map, 1, 2, 0)[1]!.contents!;

    expect(updatePlacedContents(map, 1, 2, 0, 1, held)).toBe(map);
    expect(
      updatePlacedContents(map, 1, 2, 0, 1, [{ id: "itm_a", tileId: "bread", count: 2 }]),
    ).toBe(map);
  });

  it("notices a swap that kept the tile and the count", () => {
    const map = chestAt([{ id: "itm_a", tileId: "lever", channel: "gate-a" }]);
    const written = updatePlacedContents(map, 1, 2, 0, 1, [{ id: "itm_b", tileId: "lever" }]);

    expect(written).not.toBe(map);
    expect(getStack(written, 1, 2, 0)[1]!.contents).toEqual([{ id: "itm_b", tileId: "lever" }]);
  });

  it("notices a field that changed on an entry that stayed", () => {
    const map = chestAt([{ id: "itm_a", tileId: "sign", description: "old" }]);
    const written = updatePlacedContents(map, 1, 2, 0, 1, [
      { id: "itm_a", tileId: "sign", description: "new" },
    ]);

    expect(written).not.toBe(map);
  });

  it("notices a count that changed", () => {
    const map = chestAt([{ id: "itm_a", tileId: "bread", count: 2 }]);
    const written = updatePlacedContents(map, 1, 2, 0, 1, [
      { id: "itm_a", tileId: "bread", count: 3 },
    ]);

    expect(written).not.toBe(map);
    expect(getStack(written, 1, 2, 0)[1]!.contents![0]!.count).toBe(3);
  });

  it("leaves the rest of the stack alone", () => {
    const written = updatePlacedContents(chestAt(), 1, 2, 0, 1, [{ id: "itm_a", tileId: "bread" }]);

    expect(getStack(written, 1, 2, 0)[0]).toEqual({ tileId: "grass" });
  });
});

describe("fixture town scale", () => {
  it("has enough quads that a one-mesh-per-quad path would blow budgets", () => {
    let quads = 0;
    for (const z of Object.keys(fixtureMap.levels)) {
      for (const c of listCoords(fixtureMap, Number(z))) {
        quads += c.stack.length;
      }
    }
    expect(quads).toBeGreaterThan(20_000);
  });
});

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
    expect(stackHeight([{ tileId: "grass" }, { tileId: "door-open" }], tilesById)).toBe(0);
    expect(stackHeight([{ tileId: "wall" }, { tileId: "torch" }], tilesById)).toBe(4);
  });

  it("looks through intangible tops for the solid surface", () => {
    expect(solidTopOfStack([{ tileId: "grass" }, { tileId: "door-open" }], tilesById)).toEqual({
      tileId: "grass",
    });

    const map = replaceStack({ version: MAP_FILE_VERSION, levels: {} }, 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "door-open" },
    ]);
    expect(surfaceTileAt(map, 0, 0, 0, tilesById)).toEqual({
      tileId: "grass",
    });
  });

  it("lets a full-height body stand through an intangible door", () => {
    const map = replaceStack({ version: MAP_FILE_VERSION, levels: {} }, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "door-open" },
    ]);
    const player = tile({ id: "player", height: 4 });
    expect(fitsAtElevation(map, 1, 0, 0, player, tilesById).ok).toBe(true);
    const blocked = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "wall" }]);
    expect(fitsAtElevation(blocked, 1, 0, 0, player, tilesById).ok).toBe(false);
  });

  it("places an intangible full-height tile like a height-0 plate", () => {
    const map = replaceStack({ version: MAP_FILE_VERSION, levels: {} }, 0, 0, 0, [
      { tileId: "wall" },
    ]);
    expect(fitsTile(map, 0, 0, 0, tilesById["door-open"]!, tilesById).ok).toBe(true);
  });
});

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

describe("the topmost tile decides what a stack is", () => {
  const tilesById = tilesByIdFromList([
    tile({ id: "grass", height: 0 }),
    tile({ id: "berry", height: 0 }),
    tile({ id: "water", height: 0, walkable: false }),
    tile({ id: "wooden-floor", height: 0 }),
    tile({ id: "arrow", height: 0, intangible: true }),
    tile({ id: "bush", height: 2, walkable: false }),
    tile({ id: "fence", height: 2, walkable: false }),
    tile({ id: "box", height: 2 }),
    tile({ id: "wolf", height: 2, walkable: false, actor: true }),
  ]);

  function elevOf(...tileIds: string[]): number | null {
    const map = replaceStack(
      emptyMap(),
      0,
      0,
      0,
      tileIds.map((tileId) => ({ tileId })),
    );
    return walkableElevInStack(getStack(map, 0, 0, 0), tilesById);
  }

  it("closes a stack whose top is not walkable", () => {
    expect(elevOf("grass", "bush")).toBe(null);
  });

  it("closes water laid over walkable ground, with neither tile any taller", () => {
    expect(elevOf("grass", "water")).toBe(null);
  });

  it("opens a stack whose top is walkable, whatever is under it", () => {
    expect(elevOf("grass", "berry")).toBe(0);
    expect(elevOf("grass", "box")).toBe(2);
  });

  it("opens a bridge deck laid over something non-walkable", () => {
    expect(elevOf("water", "fence", "wooden-floor")).toBe(2);
  });

  it("closes that same deck once a railing is stacked on it", () => {
    expect(elevOf("water", "fence", "wooden-floor", "fence")).toBe(null);
  });

  it("looks through an intangible top to the tile beneath", () => {
    expect(elevOf("grass", "arrow")).toBe(0);
    expect(elevOf("grass", "bush", "arrow")).toBe(null);
  });

  it("leaves the ground a creature stands on as the surface", () => {
    expect(elevOf("grass", "wolf")).toBe(0);
  });

  it("names the topmost tile as the surface, with no tie-break", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "bush" },
      { tileId: "berry" },
    ]);
    expect(surfaceTileAt(map, 0, 0, 2, tilesById)).toEqual({ tileId: "berry" });
    expect(isWalkableSurfaceAt(map, 0, 0, 2, tilesById)).toBe(true);
    expect(walkableElevInStack(getStack(map, 0, 0, 0), tilesById)).toBe(2);
  });
});

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

  it("keeps them in the flat shape everything else uses", () => {
    const flat = flattenMap(withItems);
    const kept = flat.levels["0"]!["1,2"]![1]!;
    expect(kept.itemId).toBe("itm_minted");
    expect(kept.contents?.[0]?.id).toBe("itm_inside");
  });
});

describe("tileIdsInChunk", () => {
  const chunkOf = (map: MapFile, x: number, y: number, z: number) =>
    map.levels[levelKey(z)]![chunkKeyFor(x, y)]!;

  it("lists every tile placed anywhere in the chunk", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId: "bush" }]);
    map = replaceStack(map, 3, 4, 0, [{ tileId: "stone" }]);
    expect([...tileIdsInChunk(chunkOf(map, 0, 0, 0))].sort()).toEqual(["bush", "grass", "stone"]);
  });

  it("follows an edit, because the edit is a new chunk", () => {
    const before = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    expect(tileIdsInChunk(chunkOf(before, 0, 0, 0)).has("bush")).toBe(false);
    const after = replaceStack(before, 1, 1, 0, [{ tileId: "bush" }]);
    expect(tileIdsInChunk(chunkOf(after, 0, 0, 0)).has("bush")).toBe(true);
    expect(tileIdsInChunk(chunkOf(before, 0, 0, 0)).has("bush")).toBe(false);
  });

  it("never leaves out a tile the chunk holds, across a run of edits", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId: "bush" }]);
    tileIdsInChunk(chunkOf(map, 0, 0, 0));
    map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 2, 0, 0, [{ tileId: "grass" }, { tileId: "deer" }]);
    map = replaceStack(map, 2, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 5, 5, 0, [{ tileId: "wolf" }]);
    const listed = tileIdsInChunk(chunkOf(map, 0, 0, 0));
    for (const stack of Object.values(chunkOf(map, 0, 0, 0))) {
      for (const placed of stack) expect(listed.has(placed.tileId)).toBe(true);
    }
  });
});

describe("the cells that differ between two versions", () => {
  function everyKeyCompared(prev: MapFile, next: MapFile, z: number): Set<string> {
    const out = new Set<string>();
    const before = prev.levels[levelKey(z)] ?? {};
    const after = next.levels[levelKey(z)] ?? {};
    for (const chunk of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const a = before[chunk] ?? {};
      const b = after[chunk] ?? {};
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (a[key] !== b[key]) out.add(key);
      }
    }
    return out;
  }

  const grass: PlacedTile = { tileId: "grass" };
  const stone: PlacedTile = { tileId: "stone" };

  function versions(count: number): MapFile[] {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const cell = () => Math.floor(random() * CHUNK_SIZE * 3) - CHUNK_SIZE;
    let map = emptyMap();
    const out: MapFile[] = [map];
    for (let i = 0; i < count; i++) {
      const edits: StackEdit[] = [];
      const writes = 1 + Math.floor(random() * 4);
      for (let w = 0; w < writes; w++) {
        const roll = random();
        const z = random() < 0.8 ? 0 : -1;
        const x = cell();
        const y = cell();
        const stack =
          roll < 0.25
            ? []
            : roll < 0.35
              ? getStack(map, x, y, z)
              : roll < 0.7
                ? [grass]
                : [grass, stone];
        edits.push({ x, y, z, stack });
      }
      map = setStacks(map, edits);
      out.push(map);
    }
    return out;
  }

  it("is what comparing every key finds, between any version and any later one", () => {
    const all = versions(300);
    for (let i = 0; i < all.length; i += 7) {
      for (let j = i; j < all.length; j += 11) {
        for (const z of [0, -1, 1]) {
          expect(changedCellsOnLevel(all[i]!, all[j]!, z)).toEqual(
            everyKeyCompared(all[i]!, all[j]!, z),
          );
        }
      }
    }
  });

  it("is what comparing every key finds, the other way round and between strangers", () => {
    const all = versions(120);
    const stranger = chunkifyMap(flattenMap(all[60]!));
    for (const [prev, next] of [
      [all[90]!, all[30]!],
      [all[45]!, stranger],
      [stranger, all[119]!],
    ] as const) {
      for (const z of [0, -1]) {
        expect(changedCellsOnLevel(prev, next, z)).toEqual(everyKeyCompared(prev, next, z));
      }
    }
  });

  it("is what comparing every key finds within one chunk", () => {
    const all = versions(200);
    for (let i = 0; i < all.length; i += 13) {
      const j = Math.min(all.length - 1, i + 17);
      for (const chunk of ["-1,-1", "0,0", "1,0", "0,1"]) {
        const prev = all[i]!;
        const next = all[j]!;
        const expected = new Set(
          [...everyKeyCompared(prev, next, 0)].filter((key) => {
            const [x, y] = key.split(",").map(Number) as [number, number];
            return chunkKeyFor(x, y) === chunk;
          }),
        );
        expect(changedCellsInChunk(prev, next, 0, chunk)).toEqual(expected);
      }
    }
  });
});

describe("board keys", () => {
  it("names a chunk as it always did, from the cache and past it", () => {
    const cells = [
      [0, 0],
      [15, 15],
      [16, -1],
      [-1, -17],
      [-16, 16],
      [3.5, -0.5],
      [-0, 0],
      [-0x8000 * CHUNK_SIZE, 0x7fff * CHUNK_SIZE],
      [0x7fff * CHUNK_SIZE, -0x8000 * CHUNK_SIZE],
      [0x8000 * CHUNK_SIZE, 0],
      [0, -0x8001 * CHUNK_SIZE],
    ] as const;
    for (const [x, y] of cells) {
      const built = `${Math.floor(x / CHUNK_SIZE)},${Math.floor(y / CHUNK_SIZE)}`;
      expect(chunkKeyFor(x, y)).toBe(built);
      expect(chunkKeyFor(x, y)).toBe(built);
    }
  });

  it("names chunks correctly on either side of the cache starting again", () => {
    const wrong: string[] = [];
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < 70_000; i++) {
        const x = (i % 300) * CHUNK_SIZE;
        const y = -Math.floor(i / 300) * CHUNK_SIZE;
        const key = chunkKeyFor(x, y);
        if (key !== `${i % 300},${-Math.floor(i / 300)}`) wrong.push(key);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("names a level as String does, inside the levels a map can have and out of them", () => {
    for (let z = MIN_LEVEL - 2; z <= MAX_LEVEL + 2; z++) expect(levelKey(z)).toBe(String(z));
    expect(levelKey(-0)).toBe("0");
    expect(levelKey(1.5)).toBe("1.5");
  });

  it("reads a column's cell on each level as getStack does", () => {
    const map = replaceStack(
      replaceStack(emptyMap(), -3, 20, 0, [{ tileId: "grass-2" }]),
      -3,
      20,
      2,
      [{ tileId: "stone" }],
    );
    const chunkKey = chunkKeyFor(-3, 20);
    const cellKey = coordKey(-3, 20);
    for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
      const stack = getStack(map, -3, 20, z);
      expect(stackOnLevel(map, z, chunkKey, cellKey)).toBe(stack.length > 0 ? stack : undefined);
    }
  });
});
