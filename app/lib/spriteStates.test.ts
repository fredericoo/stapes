import { describe, expect, it } from "vitest";
import { availableStates, hasSpriteStates } from "./interactions";
import { getFrames, resolveTileSprite, tileLightSignature } from "./tileResolve";
import {
  allTileSprites,
  maxLightRadius,
  tileCanEmitLight,
  type Frame,
  type TileDef,
  type TileSprite,
} from "./types";

function frameAt(x: number, w = 1, h = 1): Frame {
  return {
    sprite: {
      tilesetId: "t",
      rect: { x, y: 0, w, h },
      base: { x: w - 1, y: h - 1 },
    },
    durationMs: 100,
  };
}

function spriteAt(...xs: number[]): TileSprite {
  return { frames: xs.map((x) => frameAt(x)) };
}

function deer(states?: TileDef["states"]): TileDef {
  return {
    id: "deer",
    name: "Deer",
    height: 4,
    type: "directional",
    kind: "battler",
    attributes: {},
    actor: true,
    sprites: {
      n: spriteAt(0),
      e: spriteAt(1),
      s: spriteAt(2),
      w: spriteAt(3),
    },
    states,
  };
}

describe("availableStates", () => {
  it("offers only idle to plain scenery", () => {
    const wall: TileDef = {
      id: "wall",
      name: "Wall",
      height: 4,
      type: "simple",
      kind: "prop",
      attributes: {},
      sprite: spriteAt(0),
    };
    expect(availableStates(wall)).toEqual(["idle"]);
  });

  it("offers moving to anything that can change cell", () => {
    expect(availableStates(deer())).toContain("moving");
  });

  it("offers nothing a renderer does not draw", () => {
    // The union is the gate: a state reaches the editor only once something
    // draws it. Pinned so adding a member without a driver fails here.
    expect(availableStates(deer())).toEqual(["idle", "moving"]);
  });
});

describe("hasSpriteStates", () => {
  it("is false for a tile with no overrides, and for an empty map of them", () => {
    expect(hasSpriteStates(deer())).toBe(false);
    expect(hasSpriteStates(deer({}))).toBe(false);
  });

  it("is true once a state is authored", () => {
    expect(hasSpriteStates(deer({ moving: { sprites: { n: spriteAt(9) } } }))).toBe(
      true,
    );
  });
});

describe("resolveTileSprite with a state", () => {
  const walking = deer({
    moving: { sprites: { n: spriteAt(10, 11), s: spriteAt(20, 21) } },
  });

  it("draws the state's sprite where it is authored", () => {
    const frames = getFrames(walking, { state: "moving", direction: "n" });
    expect(frames?.map((f) => f.sprite.rect.x)).toEqual([10, 11]);
  });

  it("falls back to idle's SAME direction, not the state's other directions", () => {
    // The deer authored `moving` for n and s only. Facing east it must stand
    // still facing east, never walk facing south.
    const frames = getFrames(walking, { state: "moving", direction: "e" });
    expect(frames?.map((f) => f.sprite.rect.x)).toEqual([1]);
  });

  it("falls back to idle for a tile that authors no states at all", () => {
    const frames = getFrames(deer(), { state: "moving", direction: "n" });
    expect(frames?.map((f) => f.sprite.rect.x)).toEqual([0]);
  });

  it("reads idle when no state is asked for", () => {
    expect(resolveTileSprite(walking, { direction: "n" })).toBe(
      walking.sprites?.n,
    );
    expect(resolveTileSprite(walking, { state: "idle", direction: "n" })).toBe(
      walking.sprites?.n,
    );
  });

  it("resolves states on a simple tile", () => {
    const boulder: TileDef = {
      id: "boulder",
      name: "Boulder",
      height: 2,
      type: "simple",
      kind: "prop",
      attributes: {},
      affectedByGravity: true,
      sprite: spriteAt(0),
      states: { moving: { sprite: spriteAt(5) } },
    };
    expect(getFrames(boulder, { state: "moving" })?.[0]?.sprite.rect.x).toBe(5);
    expect(getFrames(boulder)?.[0]?.sprite.rect.x).toBe(0);
  });

  it("resolves states on an autotile, slice by slice", () => {
    const water: TileDef = {
      id: "water",
      name: "Water",
      height: 0,
      type: "autotile",
      kind: "prop",
      attributes: {},
      slices: { 0: spriteAt(0), 5: spriteAt(1) },
      states: { moving: { slices: { 5: spriteAt(7) } } },
    };
    expect(
      getFrames(water, { state: "moving", autotileSlice: 5 })?.[0]?.sprite.rect.x,
    ).toBe(7);
    // Slice 0 is unauthored on the state, so it falls back to idle's slice 0
    // rather than to the state's slice 5.
    expect(
      getFrames(water, { state: "moving", autotileSlice: 0 })?.[0]?.sprite.rect.x,
    ).toBe(0);
  });
});

describe("state sprites are visible to the light scan", () => {
  const lit = (radius: number): TileSprite => ({
    frames: [
      { ...frameAt(0), light: { radius, intensity: 1, color: "#ffcc88" } },
    ],
  });

  it("counts a light authored only on a non-idle state", () => {
    const lantern = deer({ moving: { sprites: { n: lit(6) } } });
    expect(tileCanEmitLight(lantern)).toBe(true);
    expect(maxLightRadius(lantern)).toBe(6);
  });

  it("includes every state in allTileSprites", () => {
    const walking = deer({ moving: { sprites: { n: spriteAt(10) } } });
    expect(allTileSprites(walking)).toHaveLength(5);
  });

  it("gives a state's light its own place in the signature", () => {
    const idleOnly = deer();
    const withState = deer({ moving: { sprites: { n: lit(6) } } });
    expect(tileLightSignature(withState)).not.toBe(
      tileLightSignature(idleOnly),
    );
  });
});
