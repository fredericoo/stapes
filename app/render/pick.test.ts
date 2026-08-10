import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { ObjectRef } from "../game/GameSession";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import type { SpriteQuadAssets } from "./spriteQuad";
import { quadContains, spriteQuadFor } from "./spriteQuad";
import {
  indexInteractive,
  pickInteractiveAt,
  pickTileAt,
  probeSpanFor,
} from "./pick";

/** Wide enough that neighbouring cells' quads overlap on screen. */
const OVERLAPPING_SPRITE_CELLS = 4;

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
            rect: {
              x: 0,
              y: 0,
              w: OVERLAPPING_SPRITE_CELLS,
              h: OVERLAPPING_SPRITE_CELLS,
            },
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

const tilesById = tilesByIdFromList([
  tile({ id: "grass", height: 0 }),
  tile({ id: "slab", height: 1 }),
  tile({
    id: "crate",
    height: 1,
    interactions: {
      push: { climb: "half", moveOnTileIds: [] },
    },
  }),
  tile({
    id: "door-closed",
    height: 1,
    interactions: { switch: { targetTileId: "door-open" } },
  }),
]);

describe("indexInteractive", () => {
  it("includes a top-of-stack interactive object", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "crate" },
    ]);
    expect(indexInteractive(map, 0, tilesById)).toEqual([
      { ref: { x: 0, y: 0, z: 0, stackIndex: 1 }, elevation: 0 },
    ]);
  });

  it("omits an interactive object buried under another tile", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "crate" },
      { tileId: "slab" },
    ]);
    expect(indexInteractive(map, 0, tilesById)).toEqual([]);
  });

  it("includes adjacent floors when levelSlack is 1", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "crate" },
    ]);
    map = replaceStack(map, 1, 0, 1, [{ tileId: "grass" }, { tileId: "crate" }]);
    map = replaceStack(map, 2, 0, -1, [
      { tileId: "grass" },
      { tileId: "crate" },
    ]);
    map = replaceStack(map, 3, 0, 2, [{ tileId: "grass" }, { tileId: "crate" }]);

    expect(indexInteractive(map, 0, tilesById, 1)).toEqual([
      { ref: { x: 2, y: 0, z: -1, stackIndex: 1 }, elevation: 0 },
      { ref: { x: 0, y: 0, z: 0, stackIndex: 1 }, elevation: 0 },
      { ref: { x: 1, y: 0, z: 1, stackIndex: 1 }, elevation: 0 },
    ]);
  });

  it("includes switch-only tiles", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "door-closed" },
    ]);
    expect(indexInteractive(map, 0, tilesById)).toEqual([
      { ref: { x: 0, y: 0, z: 0, stackIndex: 1 }, elevation: 0 },
    ]);
  });
});

describe("pickInteractiveAt", () => {
  /** No tilesets registered — quads fall back, which picking does not care about. */
  const assets: SpriteQuadAssets = {
    tilesetById: new Map(),
    textures: new Map(),
    fallbackTexture: new THREE.Texture(),
    frameIndices: new Map(),
  };

  /** Camera at the origin and zoom 1, so screen coords are world coords. */
  function ctx(map: MapFile) {
    return {
      map,
      tilesById,
      assets,
      camera: { x: 0, y: 0 },
      zoom: 1,
    };
  }

  /** Two crates in neighbouring cells; (1,0) is drawn in front of (0,0). */
  function twoCrates(): MapFile {
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "crate" },
    ]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "crate" }]);
    return map;
  }

  const behind: ObjectRef = { x: 0, y: 0, z: 0, stackIndex: 1 };
  const inFront: ObjectRef = { x: 1, y: 0, z: 0, stackIndex: 1 };
  const sameRef = (a: ObjectRef) => (b: ObjectRef) =>
    a.x === b.x && a.y === b.y && a.z === b.z && a.stackIndex === b.stackIndex;

  function quadFor(map: MapFile, ref: ObjectRef) {
    const placed = getStack(map, ref.x, ref.y, ref.z)[ref.stackIndex]!;
    const quad = spriteQuadFor(
      assets,
      map,
      { x: ref.x, y: ref.y, z: ref.z, elevation: 0 },
      placed,
      tilesById[placed.tileId]!,
    );
    if (!quad) throw new Error("no quad");
    return quad;
  }

  /**
   * A world point covered by both crates' quads. They are the same size, so
   * the front one's top-left corner lies inside the back one — assert the
   * overlap rather than trusting it, since it depends on the projection.
   */
  function overlapPoint(map: MapFile) {
    const front = quadFor(map, inFront);
    const back = quadFor(map, behind);
    const p = { x: front.x, y: front.y };
    expect(quadContains(back, p.x, p.y)).toBe(true);
    return p;
  }

  it("takes the frontmost object when nothing is actionable", () => {
    const map = twoCrates();
    const p = overlapPoint(map);
    expect(
      pickInteractiveAt(ctx(map), indexInteractive(map, 0, tilesById), p.x, p.y),
    ).toEqual(inFront);
  });

  it("reaches past an inert object in front to the one that can be acted on", () => {
    const map = twoCrates();
    const p = overlapPoint(map);
    expect(
      pickInteractiveAt(
        ctx(map),
        indexInteractive(map, 0, tilesById),
        p.x,
        p.y,
        sameRef(behind),
      ),
    ).toEqual(behind);
  });

  it("still prefers the frontmost when both can be acted on", () => {
    const map = twoCrates();
    const p = overlapPoint(map);
    expect(
      pickInteractiveAt(
        ctx(map),
        indexInteractive(map, 0, tilesById),
        p.x,
        p.y,
        () => true,
      ),
    ).toEqual(inFront);
  });
});

describe("probeSpanFor", () => {
  it("takes the largest sprite dimension in the tile set", () => {
    // Every fixture tile is drawn at OVERLAPPING_SPRITE_CELLS square, so the
    // probe has to reach that far to find art hanging off a distant base cell.
    expect(probeSpanFor(tilesById)).toBe(OVERLAPPING_SPRITE_CELLS);
  });
});

describe("pickTileAt", () => {
  const assets: SpriteQuadAssets = {
    tilesetById: new Map(),
    textures: new Map(),
    fallbackTexture: new THREE.Texture(),
    frameIndices: new Map(),
  };

  /** Camera at the origin and zoom 1, so screen coords are world coords. */
  function ctx(map: MapFile) {
    return { map, tilesById, assets, camera: { x: 0, y: 0 }, zoom: 1 };
  }

  const span = probeSpanFor(tilesById);

  function quadFor(map: MapFile, ref: ObjectRef, elevation = 0) {
    const placed = getStack(map, ref.x, ref.y, ref.z)[ref.stackIndex]!;
    const quad = spriteQuadFor(
      assets,
      map,
      { x: ref.x, y: ref.y, z: ref.z, elevation },
      placed,
      tilesById[placed.tileId]!,
    );
    if (!quad) throw new Error("no quad");
    return quad;
  }

  /** Middle of a tile's drawn sprite, which is where a pointer would be. */
  function centerOf(map: MapFile, ref: ObjectRef, elevation = 0) {
    const q = quadFor(map, ref, elevation);
    return { x: q.x + q.w / 2, y: q.y + q.h / 2 };
  }

  it("finds a plain, inert tile — the whole point of looking", () => {
    const map = replaceStack(emptyMap(), 3, 4, 0, [{ tileId: "grass" }]);
    const ref: ObjectRef = { x: 3, y: 4, z: 0, stackIndex: 0 };
    const p = centerOf(map, ref);

    expect(pickTileAt(ctx(map), span, p.x, p.y, 0, 1)).toEqual(ref);
  });

  it("names the top of the stack, never what is buried under it", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "crate" },
    ]);
    const top: ObjectRef = { x: 0, y: 0, z: 0, stackIndex: 1 };
    const p = centerOf(map, top, 0);

    expect(pickTileAt(ctx(map), span, p.x, p.y, 0, 1)).toEqual(top);
  });

  it("takes the frontmost of two overlapping tiles", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);

    const behind: ObjectRef = { x: 0, y: 0, z: 0, stackIndex: 0 };
    const inFront: ObjectRef = { x: 1, y: 0, z: 0, stackIndex: 0 };
    const front = quadFor(map, inFront);
    const p = { x: front.x, y: front.y };
    expect(quadContains(quadFor(map, behind), p.x, p.y)).toBe(true);

    expect(pickTileAt(ctx(map), span, p.x, p.y, 0, 1)).toEqual(inFront);
  });

  /**
   * The case the probe span exists for.
   *
   * The sprite is four cells square with its base at the top-left corner, so it
   * covers ground a long way down-right of the cell it belongs to. A probe that
   * only looked at the cell under the pointer would find nothing at all here.
   * **Starve the span and this test must go red** — that is what makes it a
   * test of the bound rather than of the projection.
   */
  it("reaches a sprite hanging well off its own base cell", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    const ref: ObjectRef = { x: 0, y: 0, z: 0, stackIndex: 0 };
    const quad = quadFor(map, ref);
    // Deep into the far corner of the art, cells away from the base.
    const p = { x: quad.x + quad.w - 1, y: quad.y + quad.h - 1 };

    expect(pickTileAt(ctx(map), span, p.x, p.y, 0, 1)).toEqual(ref);
    expect(pickTileAt(ctx(map), 0, p.x, p.y, 0, 1)).toBeNull();
  });

  it("reaches the floor above and below when the slack allows", () => {
    let map = replaceStack(emptyMap(), 0, 0, 1, [{ tileId: "grass" }]);
    map = replaceStack(map, 5, 5, -1, [{ tileId: "grass" }]);

    const above: ObjectRef = { x: 0, y: 0, z: 1, stackIndex: 0 };
    const below: ObjectRef = { x: 5, y: 5, z: -1, stackIndex: 0 };
    const pAbove = centerOf(map, above);
    const pBelow = centerOf(map, below);

    expect(pickTileAt(ctx(map), span, pAbove.x, pAbove.y, 0, 1)).toEqual(above);
    expect(pickTileAt(ctx(map), span, pBelow.x, pBelow.y, 0, 1)).toEqual(below);
    // With no slack neither floor is in reach, and there is nothing on the
    // viewer's own level to find instead.
    expect(pickTileAt(ctx(map), span, pAbove.x, pAbove.y, 0, 0)).toBeNull();
  });

  it("cannot name a level the roof-cut has taken away", () => {
    const map = replaceStack(emptyMap(), 0, 0, 1, [{ tileId: "grass" }]);
    const roof: ObjectRef = { x: 0, y: 0, z: 1, stackIndex: 0 };
    const p = centerOf(map, roof);

    // Drawn: looking up at a roof over your head reports "Roof", which is the
    // right answer. Cut away: it is not on screen, so it is not there to name.
    expect(pickTileAt(ctx(map), span, p.x, p.y, 0, 1)).toEqual(roof);
    expect(pickTileAt(ctx(map), span, p.x, p.y, 0, 1, 0)).toBeNull();
  });
});
