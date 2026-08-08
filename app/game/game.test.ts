import { describe, expect, it } from "vitest";
import { appendTile, emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import {
  canReplaceStack,
  fitsTile,
  tilesByIdFromList,
} from "../lib/validation";
import {
  FALL_MS_PER_HEIGHT,
  PUSH_STEP_MS,
  WALK_DURATION_MS,
} from "./constants";
import { GameSession } from "./GameSession";
import { findLandingAbs, isSupported } from "./gravity";
import { canWalk, standingAbs } from "./movement";
import { findPlayers, requireSinglePlayer } from "./player";

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
  tile({ id: "dirt", height: 0 }),
  tile({ id: "slab", height: 1 }),
  tile({ id: "plaster", height: 1 }),
  tile({ id: "wall", height: 2 }),
  tile({ id: "roof", height: 0 }),
  tile({
    id: "player",
    height: 2,
    directional: true,
    affectedByGravity: true,
    walkable: false,
    variants: {
      n: [
        {
          sprite: {
            tilesetId: "basic",
            rect: { x: 0, y: 0, w: 1, h: 1 },
            base: { x: 0, y: 0 },
          },
          durationMs: 200,
        },
      ],
      e: [
        {
          sprite: {
            tilesetId: "basic",
            rect: { x: 0, y: 0, w: 1, h: 1 },
            base: { x: 0, y: 0 },
          },
          durationMs: 200,
        },
      ],
      s: [
        {
          sprite: {
            tilesetId: "basic",
            rect: { x: 0, y: 0, w: 1, h: 1 },
            base: { x: 0, y: 0 },
          },
          durationMs: 200,
        },
      ],
      w: [
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
  }),
  tile({ id: "dwarf", height: 1, affectedByGravity: true }),
  tile({ id: "tree", height: 2, walkable: false }),
  tile({
    id: "crate",
    height: 1,
    affectedByGravity: true,
    interactions: { push: { climb: "half", moveOnTileIds: [] } },
  }),
  tile({
    id: "door-closed",
    height: 1,
    walkable: false,
    interactions: { switch: { targetTileId: "door-open" } },
  }),
  tile({
    id: "door-open",
    height: 1,
    walkable: false,
    interactions: { switch: { targetTileId: "door-closed" } },
  }),
  tile({
    id: "door-tall",
    height: 2,
    walkable: false,
  }),
  tile({
    id: "switch-to-tall",
    height: 1,
    walkable: false,
    interactions: { switch: { targetTileId: "door-tall" } },
  }),
  tile({
    id: "door-ajar",
    height: 2,
    intangible: true,
    walkable: false,
  }),
  tile({
    id: "ramp",
    height: 1,
    directional: true,
    // Tall end is opposite facing (south-facing → climb north).
    climbFrom: {
      n: { n: false, e: false, s: true, w: false },
      e: { n: false, e: false, s: false, w: true },
      s: { n: true, e: false, s: false, w: false },
      w: { n: false, e: true, s: false, w: false },
    },
    variants: {
      n: [
        {
          sprite: {
            tilesetId: "basic",
            rect: { x: 0, y: 0, w: 1, h: 1 },
            base: { x: 0, y: 0 },
          },
          durationMs: 200,
        },
      ],
      e: [
        {
          sprite: {
            tilesetId: "basic",
            rect: { x: 0, y: 0, w: 1, h: 1 },
            base: { x: 0, y: 0 },
          },
          durationMs: 200,
        },
      ],
      s: [
        {
          sprite: {
            tilesetId: "basic",
            rect: { x: 0, y: 0, w: 1, h: 1 },
            base: { x: 0, y: 0 },
          },
          durationMs: 200,
        },
      ],
      w: [
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
  }),
];

const tilesById = tilesByIdFromList(tiles);

function mapWithPlayer(at: { x: number; y: number; z?: number }): MapFile {
  let map = emptyMap();
  const z = at.z ?? 0;
  map = replaceStack(map, at.x, at.y, z, [
    { tileId: "grass" },
    { tileId: "player", direction: "s" },
  ]);
  return map;
}

describe("requireSinglePlayer", () => {
  it("throws when no player", () => {
    expect(() => requireSinglePlayer(emptyMap())).toThrow(/No tile/);
  });

  it("throws when more than one player", () => {
    let map = mapWithPlayer({ x: 0, y: 0 });
    map = appendTile(map, 1, 0, 0, { tileId: "player", direction: "s" });
    expect(() => requireSinglePlayer(map)).toThrow(/exactly one/);
  });

  it("returns the sole player", () => {
    const map = mapWithPlayer({ x: 2, y: 3 });
    const loc = requireSinglePlayer(map);
    expect(loc).toMatchObject({ x: 2, y: 3, z: 0 });
    expect(findPlayers(map)).toHaveLength(1);
  });
});

describe("fitsTile", () => {
  it("allows flat placement", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    expect(fitsTile(map, 0, 0, 0, tilesById.player!, tilesById).ok).toBe(true);
  });

  it("allows full-height on a half-height base (overflow)", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "slab" }]);
    expect(fitsTile(map, 0, 0, 0, tilesById.wall!, tilesById).ok).toBe(true);
  });

  it("rejects height-adding tiles on a stack that already reaches the next level", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "wall" }]);
    expect(fitsTile(map, 0, 0, 0, tilesById.slab!, tilesById).ok).toBe(false);
    expect(fitsTile(map, 0, 0, 0, tilesById.wall!, tilesById).ok).toBe(false);
  });

  it("allows height-0 tiles on a full or overflowing stack", () => {
    const full = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "wall" }]);
    expect(fitsTile(full, 0, 0, 0, tilesById.grass!, tilesById).ok).toBe(true);
    expect(fitsTile(full, 0, 0, 0, tilesById.roof!, tilesById).ok).toBe(true);

    const overflow = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "slab" },
      { tileId: "wall" },
    ]);
    expect(fitsTile(overflow, 0, 0, 0, tilesById.grass!, tilesById).ok).toBe(
      true,
    );
  });

  it("rejects overflow under an occupied level above", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "slab" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "roof" }]);
    const dwarf = tilesById.dwarf!;
    // slab(1)+dwarf(1)=2 → ok under roof
    expect(fitsTile(map, 0, 0, 0, dwarf, tilesById).ok).toBe(true);
    // player(2)+slab(1)=3 → needs empty above, roof blocks
    expect(fitsTile(map, 0, 0, 0, tilesById.player!, tilesById).ok).toBe(false);
  });
});

describe("canReplaceStack", () => {
  it("allows trailing height-0 tiles on a full stack", () => {
    const map = emptyMap();
    expect(
      canReplaceStack(
        map,
        0,
        0,
        0,
        [{ tileId: "wall" }, { tileId: "grass" }, { tileId: "roof" }],
        tilesById,
      ).ok,
    ).toBe(true);
  });

  it("rejects a height-adding tile after the stack is already full", () => {
    const map = emptyMap();
    expect(
      canReplaceStack(
        map,
        0,
        0,
        0,
        [{ tileId: "wall" }, { tileId: "slab" }],
        tilesById,
      ).ok,
    ).toBe(false);
  });
});

describe("canWalk climb", () => {
  it("allows climb of 1", () => {
    let map = mapWithPlayer({ x: 0, y: 0 });
    map = replaceStack(map, 1, 0, 0, [{ tileId: "slab" }]);
    const loc = requireSinglePlayer(map);
    const check = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "e",
      tilesById.player!,
      tilesById,
    );
    expect(check.ok).toBe(true);
  });

  it("rejects climb above 1", () => {
    let map = mapWithPlayer({ x: 0, y: 0 });
    map = replaceStack(map, 1, 0, 0, [{ tileId: "wall" }]);
    const loc = requireSinglePlayer(map);
    const check = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "e",
      tilesById.player!,
      tilesById,
    );
    expect(check.ok).toBe(false);
  });

  it("walks through a full-height intangible door", () => {
    let map = mapWithPlayer({ x: 0, y: 0 });
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "door-ajar" },
    ]);
    const loc = requireSinglePlayer(map);
    const check = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "e",
      tilesById.player!,
      tilesById,
    );
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.to).toMatchObject({ x: 1, y: 0, z: 0 });
  });

  it("rejects walking under a roof that does not fit", () => {
    let map = mapWithPlayer({ x: 0, y: 0 });
    map = replaceStack(map, 1, 0, 0, [{ tileId: "slab" }]);
    map = replaceStack(map, 1, 0, 1, [{ tileId: "roof" }]);
    const loc = requireSinglePlayer(map);
    const check = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "e",
      tilesById.player!,
      tilesById,
    );
    expect(check.ok).toBe(false);
  });

  it("steps down a level within climb height without targeting void", () => {
    // Player on z=1 floor (abs 2); dest column has slab top at abs 1 on z=0.
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "wall" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "player", direction: "s" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "slab" }]);
    const loc = requireSinglePlayer(map);
    expect(loc.z).toBe(1);

    const check = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "e",
      tilesById.player!,
      tilesById,
    );
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.to).toEqual({ x: 1, y: 0, z: 0 });
    }
  });

  it("walks onto grass above a full lower level without dropping to that level", () => {
    // Mimics map (2,1): dirt + 2× half-height fillers on z=-1, grass on z=0.
    // Both surfaces share abs 0; the upper level must own the plane.
    let map = mapWithPlayer({ x: 0, y: 0 });
    map = replaceStack(map, 1, 0, -1, [
      { tileId: "dirt" },
      { tileId: "slab" },
      { tileId: "slab" },
    ]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
    const loc = requireSinglePlayer(map);

    const check = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "e",
      tilesById.player!,
      tilesById,
    );
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.to).toEqual({ x: 1, y: 0, z: 0 });
    }
  });

  it("climbs ground → ramp → half+ramp (elev 0 → 1 → 2)", () => {
    // Default south-facing ramp: tall end is north. Staircase climbs north.
    let map = replaceStack(emptyMap(), 0, 1, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "n" },
    ]);
    map = replaceStack(map, 0, 0, 0, [{ tileId: "ramp", direction: "s" }]);
    map = replaceStack(map, 0, -1, 0, [
      { tileId: "slab" },
      { tileId: "ramp", direction: "s" },
    ]);

    const loc = requireSinglePlayer(map);
    expect(standingAbs(map, loc.x, loc.y, loc.z, loc.stackIndex, tilesById)).toBe(
      0,
    );

    const ontoRamp = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "n",
      tilesById.player!,
      tilesById,
    );
    expect(ontoRamp.ok).toBe(true);
    if (!ontoRamp.ok) return;
    expect(ontoRamp.to).toEqual({ x: 0, y: 0, z: 0 });

    // On the first ramp, climb onto half + ramp (abs 1 → 2).
    map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 0, [
      { tileId: "ramp", direction: "s" },
      { tileId: "player", direction: "n" },
    ]);
    const onRamp = requireSinglePlayer(map);
    expect(
      standingAbs(map, onRamp.x, onRamp.y, onRamp.z, onRamp.stackIndex, tilesById),
    ).toBe(1);

    const ontoHalfRamp = canWalk(
      map,
      { x: onRamp.x, y: onRamp.y, z: onRamp.z, stackIndex: onRamp.stackIndex },
      "n",
      tilesById.player!,
      tilesById,
    );
    expect(ontoHalfRamp.ok).toBe(true);
    if (!ontoHalfRamp.ok) return;
    // Full-height stack seals z=0; standing surface is owned by z=1 floor.
    expect(ontoHalfRamp.to).toEqual({ x: 0, y: -1, z: 1 });
  });

  it("climbs a plaster ladder onto overflowing stacks (height 2 → 3)", () => {
    // Tops at abs 1, 2, 3 with half-height plaster.
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "plaster" },
      { tileId: "plaster" },
    ]);
    map = appendTile(map, 0, 0, 0, { tileId: "player", direction: "e" });
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "dirt" },
      { tileId: "plaster" },
      { tileId: "plaster" },
      { tileId: "plaster" },
    ]);
    const loc = requireSinglePlayer(map);
    expect(standingAbs(map, loc.x, loc.y, loc.z, loc.stackIndex, tilesById)).toBe(
      2,
    );

    const check = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "e",
      tilesById.player!,
      tilesById,
    );
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.to).toEqual({ x: 1, y: 0, z: 0 });
    }

    const session = new GameSession(map, tiles);
    session.setInput({ directions: ["e"] });
    let elapsed = 0;
    while (elapsed < WALK_DURATION_MS + 80) {
      session.tick(1000 / 30);
      elapsed += 1000 / 30;
    }
    const snap = session.getSnapshot();
    expect(snap.self.x).toBe(1);
    expect(
      standingAbs(
        snap.map,
        snap.self.x,
        snap.self.y,
        snap.self.z,
        snap.self.stackIndex,
        tilesById,
      ),
    ).toBe(3);
  });
});

describe("GameSession step-down", () => {
  it("does not fall when walking down ≤ climb height across a level", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "wall" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "player", direction: "s" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "slab" }]);
    const session = new GameSession(map, tiles);
    session.setInput({ directions: ["e"] });

    let elapsed = 0;
    while (elapsed < WALK_DURATION_MS + 80) {
      session.tick(1000 / 30);
      elapsed += 1000 / 30;
      const snap = session.getSnapshot();
      expect(snap.self.fall).toBeNull();
    }

    const snap = session.getSnapshot();
    expect(snap.self).toMatchObject({ x: 1, y: 0, z: 0 });
    expect(snap.self.fall).toBeNull();
  });
});

describe("gravity support", () => {
  it("is supported with a tile underfoot", () => {
    const map = mapWithPlayer({ x: 0, y: 0 });
    const loc = requireSinglePlayer(map);
    expect(
      isSupported(map, loc.x, loc.y, loc.z, loc.stackIndex, tilesById),
    ).toBe(true);
  });

  it("is unsupported when alone over void", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "player", direction: "s" },
    ]);
    const loc = requireSinglePlayer(map);
    expect(
      isSupported(map, loc.x, loc.y, loc.z, loc.stackIndex, tilesById),
    ).toBe(false);
  });

  it("finds a landing surface below", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "player", direction: "s" }]);
    const loc = requireSinglePlayer(map);
    const landing = findLandingAbs(map, 0, 0, 2, tilesById, {
      z: loc.z,
      stackIndex: loc.stackIndex,
    });
    expect(landing).toBe(0);
  });
});

describe("GameSession walk", () => {
  it("commits the player one tile after WALK_DURATION_MS", () => {
    let map = mapWithPlayer({ x: 0, y: 0 });
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
    const session = new GameSession(map, tiles);
    session.setInput({ directions: ["e"] });

    // Start walk
    session.tick(1000 / 30);
    let snap = session.getSnapshot();
    expect(snap.self.walk).not.toBeNull();
    expect(snap.self.x).toBe(0);

    // Finish walk
    let elapsed = 1000 / 30;
    while (elapsed < WALK_DURATION_MS + 50) {
      session.tick(1000 / 30);
      elapsed += 1000 / 30;
    }
    snap = session.getSnapshot();
    expect(snap.self.x).toBe(1);
    expect(snap.self.y).toBe(0);
    expect(getStack(snap.map, 0, 0, 0).some((p) => p.tileId === "player")).toBe(
      false,
    );
  });
});

describe("GameSession fall", () => {
  it("falls one height unit per FALL_MS_PER_HEIGHT onto grass below", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "player", direction: "s" }]);
    const session = new GameSession(map, tiles);

    // Kick gravity
    session.tick(1000 / 30);
    let snap = session.getSnapshot();
    expect(snap.self.fall).not.toBeNull();

    let elapsed = 1000 / 30;
    const budget = FALL_MS_PER_HEIGHT * 4;
    while (elapsed < budget) {
      session.tick(1000 / 30);
      elapsed += 1000 / 30;
      snap = session.getSnapshot();
      if (!snap.self.fall) break;
    }

    expect(snap.self.fall).toBeNull();
    expect(snap.self.z).toBe(0);
    expect(
      isSupported(
        snap.map,
        snap.self.x,
        snap.self.y,
        snap.self.z,
        snap.self.stackIndex,
        tilesById,
      ),
    ).toBe(true);
  });
});

describe("walkable surfaces", () => {
  it("does not treat a non-walkable top as a standing surface", () => {
    let map = mapWithPlayer({ x: 0, y: 0 });
    map = replaceStack(map, 1, 0, 0, [{ tileId: "tree" }]);
    const loc = requireSinglePlayer(map);
    const check = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "e",
      tilesById.player!,
      tilesById,
    );
    expect(check.ok).toBe(false);
  });

  it("does not treat a full-height non-walkable as a floor above", () => {
    // Player on slab (abs 1) next to a tree (h=2) — must not walk onto the
    // fake floor at abs 2 formed by “full level below”.
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "slab" },
      { tileId: "player", direction: "e" },
    ]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "tree" }]);
    const loc = requireSinglePlayer(map);
    expect(
      canWalk(
        map,
        { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
        "e",
        tilesById.player!,
        tilesById,
      ).ok,
    ).toBe(false);
  });

  it("rejects stepping down onto a lone tree from above", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "wall" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "player", direction: "s" }]);
    map = replaceStack(map, 0, 1, 0, [{ tileId: "tree" }]);
    const loc = requireSinglePlayer(map);
    expect(
      canWalk(
        map,
        { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
        "s",
        tilesById.player!,
        tilesById,
      ).ok,
    ).toBe(false);
  });
});

describe("climb-from", () => {
  it("allows climb up only toward the tall end for that facing", () => {
    // Ramp facing south: tall end is north. Upper floor north of ramp.
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "ramp", direction: "s" },
      { tileId: "player", direction: "n" },
    ]);
    map = replaceStack(map, 0, -1, 0, [{ tileId: "wall" }]);

    const loc = requireSinglePlayer(map);
    const up = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "n",
      tilesById.player!,
      tilesById,
    );
    expect(up.ok).toBe(true);

    map = replaceStack(map, 1, 0, 0, [{ tileId: "wall" }]);
    const blocked = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "e",
      tilesById.player!,
      tilesById,
    );
    expect(blocked.ok).toBe(false);
  });

  it("uses the climb-from set for the placed facing (no rotation)", () => {
    // Facing east: tall end is west — not the same as facing direction.
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "ramp", direction: "e" },
      { tileId: "player", direction: "w" },
    ]);
    map = replaceStack(map, -1, 0, 0, [{ tileId: "wall" }]);

    const loc = requireSinglePlayer(map);
    const up = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "w",
      tilesById.player!,
      tilesById,
    );
    expect(up.ok).toBe(true);

    map = replaceStack(map, 0, -1, 0, [{ tileId: "wall" }]);
    const blocked = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "n",
      tilesById.player!,
      tilesById,
    );
    expect(blocked.ok).toBe(false);
  });

  it("allows step-down from the ramp regardless of climb-from", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "wall" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "player", direction: "s" }]);
    // Ramp south of the upper floor; south-facing tall end is north (back toward floor).
    map = replaceStack(map, 0, 1, 0, [{ tileId: "ramp", direction: "s" }]);

    const loc = requireSinglePlayer(map);
    const down = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "s",
      tilesById.player!,
      tilesById,
    );
    expect(down.ok).toBe(true);
  });
});

describe("preferDescend", () => {
  it("picks the lowest surface in the climb band when set", () => {
    // Player on slab (abs 1). Dest has grass at abs 0 (z=0) and grass at abs 2 (z=1).
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "slab" },
      { tileId: "player", direction: "e" },
    ]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 1, 0, 1, [{ tileId: "grass" }]);

    const loc = requireSinglePlayer(map);
    const high = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "e",
      tilesById.player!,
      tilesById,
    );
    expect(high.ok).toBe(true);
    if (high.ok) expect(high.to).toEqual({ x: 1, y: 0, z: 1 });

    const low = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "e",
      tilesById.player!,
      tilesById,
      { preferDescend: true },
    );
    expect(low.ok).toBe(true);
    if (low.ok) expect(low.to).toEqual({ x: 1, y: 0, z: 0 });
  });
});

describe("GameSession faceOnly and slide", () => {
  it("Shift/faceOnly updates facing without walking", () => {
    let map = mapWithPlayer({ x: 0, y: 0 });
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
    const session = new GameSession(map, tiles);
    session.setInput({ directions: ["e"], faceOnly: true });
    session.tick(1000 / 30);
    const snap = session.getSnapshot();
    expect(snap.self.walk).toBeNull();
    expect(snap.self.x).toBe(0);
    expect(snap.self.direction).toBe("e");
  });

  it("slides in facing direction when landing on a non-walkable top", () => {
    // Tree at (0,0) abs 2; grass east. Player falls from z=2 facing east.
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "tree" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 2, [{ tileId: "player", direction: "e" }]);
    const session = new GameSession(map, tiles);

    let elapsed = 0;
    const budget = FALL_MS_PER_HEIGHT * 8 + WALK_DURATION_MS + 100;
    while (elapsed < budget) {
      session.tick(1000 / 30);
      elapsed += 1000 / 30;
    }

    const snap = session.getSnapshot();
    expect(snap.self.fall).toBeNull();
    // Slid onto grass east of the tree.
    expect(snap.self).toMatchObject({ x: 1, y: 0, z: 0 });
  });
});

/** Grass rows y=0 and y=1, player at (0,0) facing east, crate at (crateX,0). */
function mapWithCrate(crateX: number, width = 5): MapFile {
  let map = emptyMap();
  for (let x = 0; x < width; x++) {
    map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, x, 1, 0, [{ tileId: "grass" }]);
  }
  map = replaceStack(map, 0, 0, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "e" },
  ]);
  map = replaceStack(map, crateX, 0, 0, [
    { tileId: "grass" },
    { tileId: "crate" },
  ]);
  return map;
}

describe("GameSession hover", () => {
  const crateRef = (x: number) => ({ x, y: 0, z: 0, stackIndex: 1 });

  it("hovers an object the player can push", () => {
    const session = new GameSession(mapWithCrate(1), tiles);
    session.setHoveredObject(crateRef(1));
    expect(session.getSnapshot().hover).toEqual(crateRef(1));
  });

  it("ignores a hover on a non-interactive tile", () => {
    const session = new GameSession(mapWithCrate(1), tiles);
    session.setHoveredObject({ x: 2, y: 0, z: 0, stackIndex: 0 });
    expect(session.getSnapshot().hover).toBeNull();
  });

  it("ignores a hover on a buried interactive object", () => {
    let map = mapWithCrate(1);
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "crate" },
      { tileId: "slab" },
    ]);
    const session = new GameSession(map, tiles);
    session.setHoveredObject({ x: 1, y: 0, z: 0, stackIndex: 1 });
    expect(session.getSnapshot().hover).toBeNull();
  });

  it("hovers an interactive object one floor above", () => {
    let map = mapWithCrate(3);
    map = replaceStack(map, 1, 0, 1, [{ tileId: "grass" }, { tileId: "crate" }]);
    const session = new GameSession(map, tiles);
    session.setHoveredObject({ x: 1, y: 0, z: 1, stackIndex: 1 });
    expect(session.getSnapshot().hover).toEqual({
      x: 1,
      y: 0,
      z: 1,
      stackIndex: 1,
    });
  });

  it("ignores a hover two floors away", () => {
    let map = mapWithCrate(3);
    map = replaceStack(map, 1, 0, 2, [{ tileId: "grass" }, { tileId: "crate" }]);
    const session = new GameSession(map, tiles);
    session.setHoveredObject({ x: 1, y: 0, z: 2, stackIndex: 1 });
    expect(session.getSnapshot().hover).toBeNull();
  });

  it("ignores an object that is out of push range", () => {
    const session = new GameSession(mapWithCrate(2), tiles);
    session.setHoveredObject(crateRef(2));
    expect(session.getSnapshot().hover).toBeNull();
  });

  it("ignores an object on the diagonal", () => {
    let map = mapWithCrate(3);
    map = replaceStack(map, 1, 1, 0, [{ tileId: "grass" }, { tileId: "crate" }]);
    const session = new GameSession(map, tiles);
    session.setHoveredObject({ x: 1, y: 1, z: 0, stackIndex: 1 });
    expect(session.getSnapshot().hover).toBeNull();
  });

  it("ignores an adjacent object that has nowhere to go", () => {
    let map = mapWithCrate(1);
    map = replaceStack(map, 2, 0, 0, [{ tileId: "grass" }, { tileId: "tree" }]);
    const session = new GameSession(map, tiles);
    session.setHoveredObject(crateRef(1));
    expect(session.getSnapshot().hover).toBeNull();
  });

  it("hovers an adjacent switch", () => {
    let map = mapWithCrate(3);
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "door-closed" },
    ]);
    const session = new GameSession(map, tiles);
    session.setHoveredObject(crateRef(1));
    expect(session.getSnapshot().hover).toEqual(crateRef(1));
  });

  /**
   * The pointer does not move when the player walks, so a hover that is only
   * validated on the way in would keep outlining an object left behind.
   */
  it("drops a hover the player has walked away from", () => {
    const session = new GameSession(mapWithCrate(1), tiles);
    session.setHoveredObject(crateRef(1));
    expect(session.getSnapshot().hover).not.toBeNull();

    session.setInput({ directions: ["s"] });
    let elapsed = 0;
    while (elapsed < WALK_DURATION_MS + 80) {
      session.tick(1000 / 30);
      elapsed += 1000 / 30;
    }
    expect(session.getSnapshot().self).toMatchObject({ x: 0, y: 1 });
    expect(session.getSnapshot().hover).toBeNull();
  });

  it("drops the hover while the object is still travelling", () => {
    const session = new GameSession(mapWithCrate(1), tiles);
    session.setHoveredObject(crateRef(1));
    session.push(crateRef(1));
    expect(session.getSnapshot().hover).toBeNull();
  });
});

describe("GameSession push", () => {
  const crateRef = (x: number) => ({ x, y: 0, z: 0, stackIndex: 1 });

  /** Drive fixed ticks until a pushed object has finished travelling. */
  function runSlide(session: GameSession) {
    let elapsed = 0;
    const budget = PUSH_STEP_MS + 80;
    while (elapsed < budget) {
      session.tick(1000 / 30);
      elapsed += 1000 / 30;
    }
  }

  it("shoves the object one cell straight away from the player", () => {
    const session = new GameSession(mapWithCrate(1), tiles);
    expect(session.push(crateRef(1))).toBe(true);
    runSlide(session);

    const map = session.getSnapshot().map;
    expect(getStack(map, 1, 0, 0).map((p) => p.tileId)).toEqual(["grass"]);
    expect(getStack(map, 2, 0, 0).map((p) => p.tileId)).toEqual([
      "grass",
      "crate",
    ]);
  });

  it("pushes away from the player, whichever side they stand on", () => {
    // Player east of the crate this time — it should travel west, not east.
    let map = mapWithCrate(1);
    map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 2, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "w" },
    ]);
    const session = new GameSession(map, tiles);
    expect(session.push(crateRef(1))).toBe(true);
    runSlide(session);

    expect(
      getStack(session.getSnapshot().map, 0, 0, 0).map((p) => p.tileId),
    ).toEqual(["grass", "crate"]);
  });

  it("turns the player toward the object they shove", () => {
    let map = mapWithCrate(3);
    // Crate south of the player, who starts facing east.
    map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }, { tileId: "crate" }]);
    map = replaceStack(map, 0, 2, 0, [{ tileId: "grass" }]);
    const session = new GameSession(map, tiles);
    expect(session.push({ x: 0, y: 1, z: 0, stackIndex: 1 })).toBe(true);
    expect(session.getSnapshot().self.direction).toBe("s");
  });

  it("refuses an object two cells away", () => {
    const session = new GameSession(mapWithCrate(2), tiles);
    expect(session.push(crateRef(2))).toBe(false);
    expect(session.getSnapshot().self.slide).toBeNull();
  });

  it("refuses an object on the diagonal", () => {
    let map = mapWithCrate(3);
    map = replaceStack(map, 1, 1, 0, [{ tileId: "grass" }, { tileId: "crate" }]);
    const session = new GameSession(map, tiles);
    expect(session.push({ x: 1, y: 1, z: 0, stackIndex: 1 })).toBe(false);
  });

  it("pushes an object standing one floor below", () => {
    let map = mapWithCrate(3);
    map = replaceStack(map, 1, 0, 0, []);
    map = replaceStack(map, 1, 0, -1, [{ tileId: "grass" }, { tileId: "crate" }]);
    map = replaceStack(map, 2, 0, -1, [{ tileId: "grass" }]);
    map = replaceStack(map, 2, 0, 0, []);
    const session = new GameSession(map, tiles);
    expect(session.push({ x: 1, y: 0, z: -1, stackIndex: 1 })).toBe(true);
    runSlide(session);
    expect(
      getStack(session.getSnapshot().map, 2, 0, -1).map((p) => p.tileId),
    ).toEqual(["grass", "crate"]);
  });

  it("refuses an object two floors away", () => {
    let map = mapWithCrate(3);
    map = replaceStack(map, 1, 0, 2, [{ tileId: "grass" }, { tileId: "crate" }]);
    const session = new GameSession(map, tiles);
    expect(session.push({ x: 1, y: 0, z: 2, stackIndex: 1 })).toBe(false);
  });

  it("refuses a buried interactive object", () => {
    let map = mapWithCrate(1);
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "crate" },
      { tileId: "slab" },
    ]);
    const session = new GameSession(map, tiles);
    expect(session.push({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(false);
  });

  it("does nothing when the cell behind the object is blocked", () => {
    let map = mapWithCrate(1);
    map = replaceStack(map, 2, 0, 0, [{ tileId: "grass" }, { tileId: "tree" }]);
    const session = new GameSession(map, tiles);
    expect(session.push(crateRef(1))).toBe(false);
    expect(
      getStack(session.getSnapshot().map, 1, 0, 0).map((p) => p.tileId),
    ).toEqual(["grass", "crate"]);
  });

  it("pushes an object over a ledge down to the floor below", () => {
    let map = mapWithCrate(1);
    // Remove the ground east of the crate; leave a floor two levels down.
    map = replaceStack(map, 2, 0, 0, []);
    map = replaceStack(map, 2, 0, -1, [{ tileId: "grass" }]);
    const session = new GameSession(map, tiles);
    expect(session.push(crateRef(1))).toBe(true);
    runSlide(session);
    expect(
      getStack(session.getSnapshot().map, 2, 0, -1).map((p) => p.tileId),
    ).toEqual(["grass", "crate"]);
  });

  it("commits the move up front and slides only the sprite", () => {
    const session = new GameSession(mapWithCrate(1), tiles);
    session.push(crateRef(1));

    // The board is already settled on the frame the push starts; only the
    // animation is outstanding.
    const snap = session.getSnapshot();
    expect(getStack(snap.map, 1, 0, 0).map((p) => p.tileId)).toEqual(["grass"]);
    expect(getStack(snap.map, 2, 0, 0).map((p) => p.tileId)).toEqual([
      "grass",
      "crate",
    ]);
    expect(snap.self.slide).not.toBeNull();
    expect(snap.self.slide?.from).toEqual({ x: 1, y: 0, z: 0 });
    expect(snap.self.slide?.object).toEqual({ x: 2, y: 0, z: 0, stackIndex: 1 });
    expect(snap.self.slide?.progress).toBe(0);

    runSlide(session);
    expect(session.getSnapshot().self.slide).toBeNull();
  });

  it("lets the player follow straight into the cell the object left", () => {
    // Two stacked crates put the top of (1,0) out of climbing range; shoving
    // the upper one off drops it back within reach. A deferred commit swallows
    // the follow-up step for the whole slide even though the crate has visibly
    // gone, which is the stickiness this guards against.
    let map = mapWithCrate(1);
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "crate" },
      { tileId: "crate" },
    ]);
    const session = new GameSession(map, tiles);
    expect(session.push({ x: 1, y: 0, z: 0, stackIndex: 2 })).toBe(true);

    session.setInput({ directions: ["e"] });
    session.tick(1000 / 30);

    const snap = session.getSnapshot();
    expect(snap.self.slide).not.toBeNull();
    expect(snap.self.walk?.to).toEqual({ x: 1, y: 0, z: 0 });
  });

  it("cannot be pushed again while still travelling", () => {
    const session = new GameSession(mapWithCrate(1), tiles);
    session.push(crateRef(1));
    expect(session.push(crateRef(1))).toBe(false);
  });

  it("leaves the object unhovered once it lands out of range", () => {
    const session = new GameSession(mapWithCrate(1), tiles);
    session.setHoveredObject(crateRef(1));
    session.push(crateRef(1));
    runSlide(session);

    // Two cells away now — nothing a tap could do to it from here.
    expect(session.getSnapshot().hover).toBeNull();
  });

  it("lets the player walk while the object is still travelling", () => {
    const session = new GameSession(mapWithCrate(1), tiles);
    session.push(crateRef(1));
    session.setInput({ directions: ["s"] });
    session.tick(1000 / 30);

    const snap = session.getSnapshot();
    expect(snap.self.slide).not.toBeNull();
    expect(snap.self.walk).not.toBeNull();
  });
});

describe("GameSession switch", () => {
  /** Grass row, player at (0,0), switchable tile at (1,0). */
  function mapWithSwitchable(tileId: string): MapFile {
    let map = emptyMap();
    for (let x = 0; x < 3; x++) {
      map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
    }
    map = replaceStack(map, 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "e" },
    ]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId }]);
    return map;
  }

  const doorRef = { x: 1, y: 0, z: 0, stackIndex: 1 };

  it("replaces the tile with its switch target", () => {
    const session = new GameSession(mapWithSwitchable("door-closed"), tiles);
    expect(session.activateSwitch(doorRef)).toBe(true);
    expect(
      getStack(session.getSnapshot().map, 1, 0, 0).map((p) => p.tileId),
    ).toEqual(["grass", "door-open"]);
  });

  it("toggles back when the target also has switch", () => {
    const session = new GameSession(mapWithSwitchable("door-closed"), tiles);
    expect(session.activateSwitch(doorRef)).toBe(true);
    expect(session.activateSwitch(doorRef)).toBe(true);
    expect(
      getStack(session.getSnapshot().map, 1, 0, 0).map((p) => p.tileId),
    ).toEqual(["grass", "door-closed"]);
  });

  it("preserves placement direction", () => {
    let map = mapWithSwitchable("door-closed");
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "door-closed", direction: "s" },
    ]);
    const session = new GameSession(map, tiles);
    expect(session.activateSwitch(doorRef)).toBe(true);
    expect(getStack(session.getSnapshot().map, 1, 0, 0)[1]).toEqual({
      tileId: "door-open",
      direction: "s",
    });
  });

  it("refuses when the taller target would not fit", () => {
    // slab(1)+switch(1)=2 → swapping in door-tall(2) overflows (3); roof above blocks.
    let map = mapWithSwitchable("switch-to-tall");
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "slab" },
      { tileId: "switch-to-tall" },
    ]);
    map = replaceStack(map, 1, 0, 1, [{ tileId: "roof" }]);
    const session = new GameSession(map, tiles);
    expect(session.activateSwitch(doorRef)).toBe(false);
    expect(
      getStack(session.getSnapshot().map, 1, 0, 0).map((p) => p.tileId),
    ).toEqual(["slab", "switch-to-tall"]);
  });

  it("allows a taller target when overflow headroom is free", () => {
    let map = mapWithSwitchable("switch-to-tall");
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "slab" },
      { tileId: "switch-to-tall" },
    ]);
    const session = new GameSession(map, tiles);
    expect(session.activateSwitch(doorRef)).toBe(true);
    expect(
      getStack(session.getSnapshot().map, 1, 0, 0).map((p) => p.tileId),
    ).toEqual(["slab", "door-tall"]);
  });

  it("refuses out of reach", () => {
    let map = mapWithSwitchable("door-closed");
    map = replaceStack(map, 2, 0, 0, [
      { tileId: "grass" },
      { tileId: "door-closed" },
    ]);
    // Move the adjacent door away — only the far one remains switchable.
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
    const session = new GameSession(map, tiles);
    expect(
      session.activateSwitch({ x: 2, y: 0, z: 0, stackIndex: 1 }),
    ).toBe(false);
  });

  it("refuses while a pushed object is still travelling", () => {
    let map = mapWithSwitchable("door-closed");
    map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }, { tileId: "crate" }]);
    map = replaceStack(map, 0, 2, 0, [{ tileId: "grass" }]);
    const session = new GameSession(map, tiles);
    expect(session.push({ x: 0, y: 1, z: 0, stackIndex: 1 })).toBe(true);
    expect(session.activateSwitch(doorRef)).toBe(false);
  });

  it("refuses a buried switchable object", () => {
    let map = mapWithSwitchable("door-closed");
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "door-closed" },
      { tileId: "slab" },
    ]);
    const session = new GameSession(map, tiles);
    expect(
      session.activateSwitch({ x: 1, y: 0, z: 0, stackIndex: 1 }),
    ).toBe(false);
  });
});
