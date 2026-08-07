import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { ObjectRef } from "../game/GameSession";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import type { SpriteQuadAssets } from "./spriteQuad";
import { quadContains, spriteQuadFor } from "./spriteQuad";
import { indexInteractive, pickInteractiveAt } from "./pick";

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
